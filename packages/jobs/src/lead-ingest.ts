// lead-ingest (sourcing spec §7): audiences → Apify discovery → filter →
// dedupe → verify by profile read → score → pending leads for review.
// planProfile is the testable core; runLeadIngest wraps it with the DB.

import { and, eq, gte, sql } from "drizzle-orm";
import { NICHE_PRIORITY, brandFitForNiche, handleKey, normalizeEmail, normalizeNiche, type Niche } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { alert, telegramFromEnv } from "@biolinx/notify";
import {
  ACTOR_UNIT_PRICE,
  VERIFY_ITEMS,
  VERIFY_PRICE,
  apifyConfigFromEnv,
  applyFilters,
  discovererFor as defaultDiscovererFor,
  emptyKnown,
  handlesInText,
  fetcherFor as defaultFetcherFor,
  isKnown,
  nameKey,
  scoreHit,
  urlKey,
  urlsInText,
  qualityGate,
  deadWithoutRead,
  type QualityReason,
  type CompetitorRule,
  type Discoverer,
  type DiscoveryHit,
  type DiscoveryOpts,
  type DiscoveryPlatform,
  type Fetcher,
  type KnownPeople,
  type RejectReason,
  type ScoreRules,
  type SourceItem,
  type SourcePlatform,
  type VerifiedProfile,
} from "@biolinx/scraping";

export interface IngestDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  discovererFor: (p: DiscoveryPlatform) => Discoverer;
  fetcherFor: (p: SourcePlatform) => Fetcher;
  now: () => Date;
}

/** `actorOverrides` is the config `sourcing_actors` map ({ tiktok: "..." }) for search
 *  actors. They're stored under "discover:<platform>" so they can never be confused
 *  with the profile readers, which share the bare platform keys. */
export function ingestDepsFromEnv(env = process.env, actorOverrides: Record<string, string> = {}): IngestDeps {
  const discoveryOverrides = Object.fromEntries(
    Object.entries(actorOverrides).map(([k, v]) => [k.startsWith("discover:") ? k : `discover:${k}`, v]),
  );
  const apify = apifyConfigFromEnv(env, discoveryOverrides);
  return { fetchImpl: fetch, apify, discovererFor: defaultDiscovererFor, fetcherFor: defaultFetcherFor, now: () => new Date() };
}

/** The sourcing_profiles row as the job reads it (json columns typed). */
export interface ProfileRow {
  id: number;
  name: string;
  active: boolean;
  niche: string;
  brandFit: string;
  platforms: DiscoveryPlatform[];
  terms: Partial<Record<DiscoveryPlatform, string[]>>;
  seedAccounts: unknown;
  followerMin: Partial<Record<DiscoveryPlatform, number>> | null;
  followerMax: Partial<Record<DiscoveryPlatform, number>> | null;
  activityDays: number;
  countries: string[] | null;
  language: string;
  matchTerms: string[] | null;
  excludeTerms: string[] | null;
  excludeHandles: string[] | null;
  dailyCap: number;
  spendCapUsd: string | number;
  lastRunAt?: Date | string | null;
}

/** Run order: Jakob's niche priority (tier 1 first), then oldest audience first. */
export function byNichePriority(a: Pick<ProfileRow, "niche" | "id">, b: Pick<ProfileRow, "niche" | "id">): number {
  const rank = (n: string) => {
    const i = NICHE_PRIORITY.indexOf((normalizeNiche(n) ?? n) as Niche);
    return i < 0 ? NICHE_PRIORITY.length : i;
  };
  return rank(a.niche) - rank(b.niche) || a.id - b.id;
}

/** The daily schedule runs an audience at most once per business day. A manual
 *  "Run now" (explicit profileId) always runs; the schedule then skips it until tomorrow. */
export function ranToday(profile: Pick<ProfileRow, "lastRunAt">, now: Date): boolean {
  if (!profile.lastRunAt) return false;
  const last = new Date(profile.lastRunAt);
  return !Number.isNaN(last.getTime()) && last.getTime() >= startOfBusinessDay(now).getTime();
}

export interface ProfileRunSummary {
  profileId: number;
  name: string;
  hits: number;
  rejected: Record<RejectReason, number>;
  alreadyKnown: number;
  verified: number;
  verifyFailed: number;
  inserted: number;
  estimatedCostUsd: number;
  /** "daily_limit": the shared all-audience daily limit, not this audience's own cap, stopped it. */
  /** "review_full": the review queue already holds SOURCING_MAX_PENDING leads. */
  stoppedBy: "cap" | "spend" | "daily_limit" | "review_full" | "exhausted";
  termErrors: string[];
  /** Searches not run because they would have pushed the run past its spend cap. */
  termsSkipped: string[];
  /** Searches not run because they recently stopped finding new people (see restUntilAfterRun). */
  termsResting?: string[];
  /** Per search: results paid for, and how many were people we didn't already have. */
  termYield?: Array<{ search: string; hits: number; fresh: number }>;
  /** Candidates dropped by the quality gates, by reason. */
  quality?: Record<QualityReason, number>;
  /** Handles dropped after a paid profile read (remembered so they aren't read again). */
  gated?: Array<{ key: string; reason: QualityReason }>;
  /** Per search: candidates that reached a quality decision, and how many became leads. */
  termOutcome?: Record<string, { checked: number; kept: number }>;
}

/** What one search term has been worth, kept per audience in config `sourcing_term_stats:<id>`. */
export interface TermStat {
  runs: number;
  lastRunAt: string;
  lastHits: number;
  lastFresh: number;
  totalHits: number;
  totalFresh: number;
  /** ISO time before which this search is not run again, or null. */
  restUntil: string | null;
}
export type TermStats = Record<string, TermStat>;

export function termStatKey(platform: DiscoveryPlatform, term: string): string {
  return `${platform}:${term.trim().replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")}`;
}

/** Hashtag searches return mostly the same top posts day after day, and every
 *  result is billed. A search that stops surfacing new people rests:
 *  nothing came back → 14 days; nobody new → 7 days; under 10% new → 3 days. */
export function restUntilAfterRun(hits: number, fresh: number, now: Date): Date | null {
  const days = hits === 0 ? 14 : fresh === 0 ? 7 : fresh / hits < 0.1 ? 3 : 0;
  return days ? new Date(now.getTime() + days * 86_400_000) : null;
}

export function isResting(stats: TermStats, platform: DiscoveryPlatform, term: string, now: Date): boolean {
  const until = stats[termStatKey(platform, term)]?.restUntil;
  return !!until && new Date(until).getTime() > now.getTime();
}

export function recordTermRun(stats: TermStats, platform: DiscoveryPlatform, term: string, hits: number, fresh: number, now: Date): TermStats {
  const key = termStatKey(platform, term);
  const prev = stats[key];
  const until = restUntilAfterRun(hits, fresh, now);
  return {
    ...stats,
    [key]: {
      runs: (prev?.runs ?? 0) + 1,
      lastRunAt: now.toISOString(),
      lastHits: hits,
      lastFresh: fresh,
      totalHits: (prev?.totalHits ?? 0) + hits,
      totalFresh: (prev?.totalFresh ?? 0) + fresh,
      restUntil: until ? until.toISOString() : null,
    },
  };
}

export interface IngestSummary {
  profiles: ProfileRunSummary[];
  inserted: number;
  estimatedCostUsd: number;
  /** Shared limit for every audience in one business day (America/Los_Angeles). */
  dailyLimitUsd?: number;
  /** Estimated spend from earlier lead-ingest runs today, before this run. */
  spentEarlierTodayUsd?: number;
  /** SOURCING_MAX_PENDING at run time (null = no limit) and leads waiting for review before the run. */
  maxPendingReview?: number | null;
  pendingReviewBefore?: number;
}

export type VerifiedRead = VerifiedProfile & { items: SourceItem[]; profileUrl: string };
export type VerifyFn = (hit: DiscoveryHit) => Promise<VerifiedRead | null>;

export interface Candidate {
  hit: DiscoveryHit;
  lead: typeof schema.leads.$inferInsert;
  enrichment: { platform: string; sourceUrl: string; bundle: unknown; status: "sourced" } | null;
  handles: Array<{ key: string; url: string; verified: boolean }>;
}

const PLATFORM_LABEL: Record<DiscoveryPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  reddit: "Reddit",
  skool: "Skool",
};
const SOCIAL_PREFIX: Record<DiscoveryPlatform, string> = {
  tiktok: "TikTok @",
  instagram: "IG @",
  youtube: "YT @",
  reddit: "Reddit u/",
  skool: "Skool @",
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function rulesFor(profile: ProfileRow, h: DiscoveryHit): ScoreRules {
  const rules: ScoreRules = {
    activityDays: profile.activityDays,
    matchTerms: profile.matchTerms ?? [],
    excludeTerms: profile.excludeTerms ?? [],
  };
  const min = profile.followerMin?.[h.platform];
  const max = profile.followerMax?.[h.platform];
  if (min != null) rules.followerMin = min;
  if (max != null) rules.followerMax = max;
  return rules;
}

function audienceRules(profile: ProfileRow) {
  return {
    followerMin: profile.followerMin ?? {},
    followerMax: profile.followerMax ?? {},
    countries: profile.countries ?? [],
    language: profile.language,
    excludeTerms: profile.excludeTerms ?? [],
    excludeHandles: profile.excludeHandles ?? [],
  };
}

/** People in one search's results who pass the audience filters and aren't
 *  already known. Measured against the known set as it was before this run. */
export function countFresh(profile: ProfileRow, hits: DiscoveryHit[], known: KnownPeople): number {
  return applyFilters(hits, audienceRules(profile)).kept.filter((h) => !isKnown(h, null, known)).length;
}

export function emptyRunSummary(profile: Pick<ProfileRow, "id" | "name">): ProfileRunSummary {
  return {
    profileId: profile.id,
    name: profile.name,
    hits: 0,
    rejected: { excluded_handle: 0, excluded_term: 0, followers_low: 0, followers_high: 0, country: 0 },
    alreadyKnown: 0,
    verified: 0,
    verifyFailed: 0,
    inserted: 0,
    estimatedCostUsd: 0,
    stoppedBy: "exhausted",
    termErrors: [],
    termsSkipped: [],
    termsResting: [],
    termYield: [],
  };
}

/** Search hits → scored candidates for one profile. No DB, no network:
 *  discovery results and the verify function are injected. */
export async function planProfile(
  profile: ProfileRow,
  competitors: CompetitorRule[],
  hitsByTerm: Map<string, DiscoveryHit[]>,
  known: KnownPeople,
  verify: VerifyFn,
  now: Date,
): Promise<{ candidates: Candidate[]; summary: ProfileRunSummary }> {
  const summary: ProfileRunSummary = emptyRunSummary(profile);
  const spendCap = Number(profile.spendCapUsd);

  // Merge by platform:handle; discovery cost is what we already paid for.
  const merged = new Map<string, DiscoveryHit>();
  for (const hits of hitsByTerm.values()) {
    for (const h of hits) {
      summary.hits++;
      summary.estimatedCostUsd = round4(summary.estimatedCostUsd + ACTOR_UNIT_PRICE[h.platform]);
      const key = handleKey(h.platform, h.handle);
      if (!merged.has(key)) merged.set(key, h);
    }
  }

  const { kept, rejected } = applyFilters([...merged.values()], audienceRules(profile));
  summary.rejected = rejected;

  const quality: Record<QualityReason, number> = { non_english: 0, dead: 0, off_niche: 0, followers: 0 };
  const gated: Array<{ key: string; reason: QualityReason }> = [];
  const outcome: Record<string, { checked: number; kept: number }> = {};
  const track = (h: DiscoveryHit, keptIt: boolean) => {
    const k = `${h.platform} ${h.term}`;
    outcome[k] ??= { checked: 0, kept: 0 };
    outcome[k].checked++;
    if (keptIt) outcome[k].kept++;
  };
  const gateInput = (h: DiscoveryHit, v: VerifiedRead | null, competitorFound: boolean) => ({
    hit: h,
    verified: v,
    matchTerms: profile.matchTerms ?? [],
    language: profile.language,
    competitorFound,
    now,
  });

  const fresh = kept.filter((h) => {
    const pre = scoreHit({ hit: h, verified: null, rules: rulesFor(profile, h), competitors, now });
    if (isKnown(h, pre.affiliateCode, known)) {
      summary.alreadyKnown++;
      return false;
    }
    // Free check on the search row before paying for a profile read.
    const reason = qualityGate(gateInput(h, null, pre.competitor != null));
    if (reason) {
      quality[reason]++;
      track(h, false);
      return false;
    }
    return true;
  });
  const ordered = interleaveByPlatform(fresh, profile.platforms);

  const niche = (normalizeNiche(profile.niche) ?? profile.niche) as Niche;
  const brandFit = profile.brandFit || brandFitForNiche(niche);
  const candidates: Candidate[] = [];

  for (const h of ordered) {
    if (candidates.length >= profile.dailyCap) {
      summary.stoppedBy = "cap";
      break;
    }
    const readPrice = VERIFY_PRICE[h.platform];
    if (summary.estimatedCostUsd + readPrice > spendCap) {
      // A cheaper platform's read may still fit, so keep looking instead of stopping.
      summary.stoppedBy = "spend";
      continue;
    }
    summary.estimatedCostUsd = round4(summary.estimatedCostUsd + readPrice);

    let v: VerifiedRead | null = null;
    try {
      v = await verify(h);
      if (v) summary.verified++;
    } catch {
      summary.verifyFailed++;
    }

    const s = scoreHit({ hit: h, verified: v, rules: rulesFor(profile, h), competitors, now });
    const fMin = profile.followerMin?.[h.platform];
    const fMax = profile.followerMax?.[h.platform];
    const outOfRange = v?.followers != null && ((fMin != null && v.followers < fMin) || (fMax != null && v.followers > fMax));
    const reason: QualityReason | null = outOfRange
      ? "followers"
      : v
        ? qualityGate(gateInput(h, v, s.competitor != null))
        : deadWithoutRead(h, now)
          ? "dead"
          : null;
    if (reason) {
      quality[reason]++;
      gated.push({ key: handleKey(h.platform, h.handle), reason });
      track(h, false);
      continue;
    }
    track(h, true);
    // The surfaced post first, with its engagement from the search row, or from the profile read when it's there too.
    const surfacedRead: SourceItem | undefined = (v?.items as SourceItem[] | undefined)?.find((i) => i.url === h.postUrl);
    const surfacedStats = {
      ...(h.views != null ? { views: h.views } : surfacedRead?.views != null ? { views: surfacedRead.views } : {}),
      ...(h.likes != null ? { likes: h.likes } : surfacedRead?.likes != null ? { likes: surfacedRead.likes } : {}),
      ...(h.comments != null ? { comments: h.comments } : surfacedRead?.comments != null ? { comments: surfacedRead.comments } : {}),
    };
    const sample = [
      ...(h.postUrl ? [{ url: h.postUrl, text: h.postText ?? "", postedAt: h.postedAt, ...surfacedStats }] : []),
      ...(v?.items ?? []).filter((i) => i.url !== h.postUrl).slice(0, 12),
    ];
    const lastPost = v?.lastPostAt ?? h.postedAt ?? null;
    const displayName = h.displayName ?? h.handle;
    const lead: typeof schema.leads.$inferInsert = {
      firstName: displayName.split(" ")[0] ?? h.handle,
      lastName: displayName.split(" ").slice(1).join(" ") || null,
      primaryPlatform: PLATFORM_LABEL[h.platform],
      socialProfiles: `${SOCIAL_PREFIX[h.platform]}${h.handle}`,
      whereFound: h.postUrl,
      totalReach: v?.followers ?? null,
      reachSourceUrl: v ? v.profileUrl : null,
      niche,
      brandFit,
      geoCountry: h.country,
      status: "Not contacted",
      motion: "A",
      source: "sourcing",
      affiliationStatus: s.competitor ? "Signed elsewhere" : "Unsigned",
      otherCreatorCompany: s.competitor?.name ?? null,
      currentOffer: s.competitor?.commissionPct != null ? `${s.competitor.commissionPct}%` : null,
      whatTheyPromoted: s.competitor ? s.competitor.name : null,
      affiliateCode: s.affiliateCode,
      lastPostAt: lastPost ? new Date(lastPost) : null,
      promoTrackRecord: s.promoTrackRecord,
      contentOriginal: s.contentOriginal,
      doesLive: null,
      sourcingReview: "pending",
      sourcingProfileId: profile.id,
      sourcingReason: `found by ${profile.name} via ${h.term}`,
      sourcingSample: sample,
      sourcingScore: s.score,
      notes: s.reasons.join("\n"),
      dateAdded: now,
    };
    candidates.push({
      hit: h,
      lead,
      enrichment: v
        ? {
            platform: h.platform,
            sourceUrl: v.profileUrl,
            bundle: { platform: h.platform, profileUrl: v.profileUrl, bio: v.bio ?? h.bio, followers: v.followers, items: v.items },
            status: "sourced",
          }
        : null,
      handles: [{ key: handleKey(h.platform, h.handle), url: h.profileUrl, verified: !!v }],
    });
    // Anything we just decided to insert is now "known" for the rest of this run.
    known.handles.add(handleKey(h.platform, h.handle));
    known.urls.add(urlKey(h.profileUrl));
    if (s.affiliateCode) known.codes.add(s.affiliateCode.toLowerCase());
    const nk = nameKey(h.displayName, h.platform);
    if (nk) known.names.add(nk);
  }
  summary.inserted = candidates.length;
  summary.quality = quality;
  summary.gated = gated;
  summary.termOutcome = outcome;
  return { candidates, summary };
}

/** Profile-read order: each platform sorted by follower count, then taken in turns,
 *  so a platform whose search rows carry no follower count (Instagram) still gets reads. */
export function interleaveByPlatform(hits: DiscoveryHit[], platforms: DiscoveryPlatform[]): DiscoveryHit[] {
  const order = [...platforms, ...new Set(hits.map((h) => h.platform).filter((p) => !platforms.includes(p)))];
  const queues = order.map((p) => hits.filter((h) => h.platform === p).sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1)));
  const out: DiscoveryHit[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}

/** Terms whose people keep failing the quality gates rest like terms that find nobody new. */
export function applyTermOutcome(stats: TermStats, outcome: Record<string, { checked: number; kept: number }>, now: Date): TermStats {
  const next = { ...stats };
  for (const [search, o] of Object.entries(outcome)) {
    const sp = search.indexOf(" ");
    const key = termStatKey(search.slice(0, sp) as DiscoveryPlatform, search.slice(sp + 1));
    const s = next[key];
    if (!s || o.checked < 5 || o.kept > 0) continue;
    const until = new Date(now.getTime() + 7 * 86_400_000);
    if (!s.restUntil || new Date(s.restUntil) < until) next[key] = { ...s, restUntil: until.toISOString() };
  }
  return next;
}

/** People rejected after a paid profile read are not read again for this long. */
export const GATED_MEMORY_DAYS = 90;
const GATED_CONFIG_KEY = "sourcing_gated_handles";
type GatedMemory = Record<string, { reason: QualityReason; at: string }>;

export function activeGated(memory: GatedMemory, now: Date): string[] {
  const cutoff = now.getTime() - GATED_MEMORY_DAYS * 86_400_000;
  return Object.entries(memory)
    .filter(([, v]) => new Date(v.at).getTime() >= cutoff)
    .map(([k]) => k);
}

/** Profile read through the existing fetchers. Skool has no profile
 *  fetcher: the discovery row is already the "read" (member count). */
export function makeVerify(deps: IngestDeps): VerifyFn {
  return async (h) => {
    if (h.platform === "skool") {
      return { followers: h.followers, bio: h.bio, lastPostAt: null, isRepostRatio: null, items: [], profileUrl: h.profileUrl };
    }
    const platform: SourcePlatform = h.platform;
    const bundle = await deps.fetcherFor(platform)(
      { platform, handle: h.handle, url: h.profileUrl },
      { fetchImpl: deps.fetchImpl, apify: deps.apify, maxItems: VERIFY_ITEMS },
    );
    if (bundle.items.length === 0 && bundle.followers == null) return null; // private or gone
    const dated = bundle.items
      .map((i) => i.postedAt)
      .filter((d): d is string => !!d)
      .sort();
    const flagged = bundle.items.filter((i) => typeof i.isRepost === "boolean");
    return {
      followers: bundle.followers,
      bio: bundle.bio,
      lastPostAt: dated.length > 0 ? dated[dated.length - 1]! : null,
      isRepostRatio: flagged.length > 0 ? flagged.filter((i) => i.isRepost).length / flagged.length : null,
      items: bundle.items,
      profileUrl: bundle.profileUrl,
    };
  };
}

/** The five dedupe keys, loaded once per run from every table that holds a person. */
export async function loadKnownPeople(db: Db): Promise<KnownPeople> {
  const known = emptyKnown();
  const leads = await db
    .select({
      first: schema.leads.firstName,
      last: schema.leads.lastName,
      platform: schema.leads.primaryPlatform,
      email: schema.leads.emailNormalized,
      code: schema.leads.affiliateCode,
      site: schema.leads.websiteUrl,
      social: schema.leads.socialProfiles,
    })
    .from(schema.leads);
  for (const l of leads) {
    if (l.code) known.codes.add(l.code.toLowerCase());
    if (l.email) known.emails.add(l.email);
    if (l.site) known.urls.add(urlKey(l.site));
    const nk = nameKey([l.first, l.last].filter(Boolean).join(" "), l.platform ?? "");
    if (nk) known.names.add(nk);
    for (const k of handlesInText(l.social, l.platform)) known.handles.add(k);
    for (const u of urlsInText(l.social)) known.urls.add(u);
  }
  for (const h of await db.select({ key: schema.leadHandles.handleKey, url: schema.leadHandles.profileUrl }).from(schema.leadHandles)) {
    known.handles.add(h.key);
    if (h.url) known.urls.add(urlKey(h.url));
  }
  for (const o of await db.select({ name: schema.outreachLog.prospectName }).from(schema.outreachLog)) {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "skool"]) {
      const nk = nameKey(o.name, p);
      if (nk) known.names.add(nk);
    }
  }
  for (const s of await db.select({ email: schema.signups.emailNormalized }).from(schema.signups)) known.emails.add(s.email);
  for (const a of await db.select({ email: schema.affiliates.email }).from(schema.affiliates)) if (a.email) known.emails.add(normalizeEmail(a.email));
  return known;
}

function competitorRules(rows: Array<typeof schema.competitors.$inferSelect>): CompetitorRule[] {
  return rows
    .filter((c) => c.active)
    .map((c) => ({
      id: c.id,
      name: c.name,
      domains: (c.domains as string[] | null) ?? [],
      codePattern: c.codePattern,
      codePrefix: c.codePrefix,
      commissionPct: c.commissionPct,
    }));
}

function discoveryOptsFor(profile: ProfileRow, platform: DiscoveryPlatform): DiscoveryOpts {
  const opts: DiscoveryOpts = { language: profile.language };
  const min = profile.followerMin?.[platform];
  const max = profile.followerMax?.[platform];
  if (min != null) opts.followerMin = min;
  if (max != null) opts.followerMax = max;
  const country = profile.countries?.[0];
  if (country) opts.country = country;
  return opts;
}

/** Platforms whose discoverer can search a competitor's name. Reddit reads a
 *  subreddit by name, so "Peptide Sciences" would be a subreddit that doesn't exist. */
const COMPETITOR_NAME_PLATFORMS = new Set<DiscoveryPlatform>(["tiktok", "instagram", "youtube", "skool"]);

export interface PlannedSearch {
  platform: DiscoveryPlatform;
  term: string;
  /** Worst case: every requested item comes back and is billed. */
  estimatedCostUsd: number;
}

/** Most of a run's spend budget can go to searching, but a slice is held back
 *  so the best hits can still be verified: enough for a full day's cap of
 *  profile reads, never more than half the budget. */
export function verifyReserveUsd(profile: Pick<ProfileRow, "dailyCap" | "spendCapUsd"> & Partial<Pick<ProfileRow, "platforms">>): number {
  const cap = Number(profile.spendCapUsd);
  // Reserve at the priciest read among the audience's platforms (TikTok if none given).
  const prices = (profile.platforms ?? []).map((p) => VERIFY_PRICE[p]);
  const priciest = prices.length > 0 ? Math.max(...prices) : VERIFY_PRICE.tiktok;
  return round4(Math.min(profile.dailyCap * priciest, cap / 2));
}

/** Every search a profile wants, split into what fits the search budget and what doesn't.
 *  Order: every platform's audience terms first (round-robin across platforms), then
 *  competitor names round-robin across platforms. `rotation` (the run's day number)
 *  shifts which competitor goes first, so a budget that only covers some of them
 *  reaches all of them over successive days. Deduped per platform.
 *  Nothing runs before this: the spend cap gates searching, not only verification. */
export function planSearches(
  profile: Pick<ProfileRow, "platforms" | "terms" | "dailyCap" | "spendCapUsd">,
  competitors: Pick<CompetitorRule, "name">[],
  perTerm: number,
  rotation = 0,
  resting: (platform: DiscoveryPlatform, term: string) => boolean = () => false,
  /** termStatKey()s another audience already searched in this run: skipped, not paid for twice. */
  alreadySearched: ReadonlySet<string> = new Set(),
): { run: PlannedSearch[]; skipped: PlannedSearch[]; resting: PlannedSearch[]; budgetUsd: number } {
  const restingOut: PlannedSearch[] = [];
  const budgetUsd = round4(Math.max(0, Number(profile.spendCapUsd) - verifyReserveUsd(profile)));
  const n = competitors.length;
  // Advance by as many competitors as one day's budget covers, so tomorrow starts
  // where today stopped instead of repeating most of today's searches.
  const priceOf = (p: DiscoveryPlatform) => round4(ACTOR_UNIT_PRICE[p] * perTerm);
  const audienceCost = Math.min(
    profile.platforms.reduce((a, p) => a + (profile.terms[p]?.length ?? 0) * priceOf(p), 0),
    n > 0 ? budgetUsd * AUDIENCE_SHARE : Infinity,
  );
  const perCompetitor = profile.platforms.filter((p) => COMPETITOR_NAME_PLATFORMS.has(p)).reduce((a, p) => a + priceOf(p), 0);
  const perDay = perCompetitor > 0 ? Math.max(1, Math.floor(Math.max(0, budgetUsd - audienceCost) / perCompetitor)) : 1;
  const shift = n > 0 ? (((rotation * perDay) % n) + n) % n : 0;
  const rotated = [...competitors.slice(shift), ...competitors.slice(0, shift)].map((c) => c.name);
  const seen = new Map<DiscoveryPlatform, Set<string>>();
  const make = (platform: DiscoveryPlatform, raw: string): PlannedSearch | null => {
    const term = raw.trim();
    const key = term.replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const s = seen.get(platform) ?? new Set<string>();
    seen.set(platform, s);
    if (!key || s.has(key)) return null;
    s.add(key);
    const planned = { platform, term, estimatedCostUsd: round4(ACTOR_UNIT_PRICE[platform] * perTerm) };
    if (alreadySearched.has(termStatKey(platform, term))) return null;
    if (resting(platform, term)) {
      restingOut.push(planned);
      return null;
    }
    return planned;
  };
  const roundRobin = (listFor: (p: DiscoveryPlatform) => string[]): PlannedSearch[] => {
    const lists = profile.platforms.map((p) => ({ p, terms: listFor(p) }));
    const out: PlannedSearch[] = [];
    const longest = Math.max(0, ...lists.map((l) => l.terms.length));
    for (let i = 0; i < longest; i++) {
      for (const { p, terms } of lists) {
        const s = i < terms.length ? make(p, terms[i]!) : null;
        if (s) out.push(s);
      }
    }
    return out;
  };
  const audience = roundRobin((p) => profile.terms[p] ?? []);
  const named = roundRobin((p) => (COMPETITOR_NAME_PLATFORMS.has(p) ? rotated : []));
  // Competitor-name searches are how tier-one affiliates are found, so audience terms may use
  // at most AUDIENCE_SHARE of the search budget when there are competitors to search. On
  // 2026-09-14 hashtags used every dollar and not one of 47 leads was a competitor affiliate.
  // Whatever the competitor searches don't use goes back to the remaining audience terms.
  const audienceBudget = named.length > 0 ? round4(budgetUsd * AUDIENCE_SHARE) : budgetUsd;
  let audienceSpend = 0;
  const firstAudience: PlannedSearch[] = [];
  const laterAudience: PlannedSearch[] = [];
  for (const a of audience) {
    if (audienceSpend + a.estimatedCostUsd <= audienceBudget) {
      firstAudience.push(a);
      audienceSpend = round4(audienceSpend + a.estimatedCostUsd);
    } else laterAudience.push(a);
  }
  const all = [...firstAudience, ...named, ...laterAudience];
  const run: PlannedSearch[] = [];
  const skipped: PlannedSearch[] = [];
  let spent = 0;
  for (const s of all) {
    if (spent + s.estimatedCostUsd <= budgetUsd) {
      run.push(s);
      spent = round4(spent + s.estimatedCostUsd);
    } else skipped.push(s);
  }
  return { run, skipped, resting: restingOut, budgetUsd };
}

const termStatsConfigKey = (profileId: number) => `sourcing_term_stats:${profileId}`;

/** Share of an audience's search budget its own terms may use before competitor names get a turn. */
export const AUDIENCE_SHARE = 0.6;

const PER_TERM = 30;

export const DEFAULT_DAILY_LIMIT_USD = 10;

/** The instant the business day containing `now` began, in UTC. */
export function startOfBusinessDay(now: Date, tz = process.env.BUSINESS_TZ ?? "America/Los_Angeles"): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone.replace("GMT", "") || "Z";
  return new Date(`${ymd}T00:00:00${offset}`);
}

/** Admin setting SOURCING_DAILY_SPEND_USD, read fresh each run so a change on
 *  the Settings page applies without a restart. Blank or invalid → $10. */
export async function dailyLimitUsd(db: Db, env = process.env): Promise<number> {
  const row = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, "SOURCING_DAILY_SPEND_USD") });
  return parseDailyLimit(row?.value ?? env.SOURCING_DAILY_SPEND_USD);
}

export function parseDailyLimit(raw: string | null | undefined): number {
  if (raw == null || String(raw).trim() === "") return DEFAULT_DAILY_LIMIT_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_LIMIT_USD;
}

/** Estimated spend of every lead-ingest run that started today, finished or not.
 *  Runs write their running total after each audience, so a crash still counts. */
export async function spentTodayUsd(db: Db, now: Date, excludeRunId?: number): Promise<number> {
  const rows = await db
    .select({ id: schema.syncRuns.id, detail: schema.syncRuns.detail })
    .from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.job, "lead-ingest"), gte(schema.syncRuns.startedAt, startOfBusinessDay(now))));
  let total = 0;
  for (const r of rows) {
    if (r.id === excludeRunId) continue;
    const cost = Number((r.detail as { estimatedCostUsd?: unknown } | null)?.estimatedCostUsd ?? 0);
    if (Number.isFinite(cost)) total += cost;
  }
  return round4(total);
}

/** Admin setting SOURCING_MAX_PENDING: the most sourced leads allowed to wait for review
 *  at once. Blank or invalid = no limit. Used to hand marketing a fixed batch to check. */
export function parseMaxPending(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function maxPendingReview(db: Db, env = process.env): Promise<number | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, "SOURCING_MAX_PENDING") });
  return parseMaxPending(row?.value ?? env.SOURCING_MAX_PENDING);
}

/** An audience's lead cap this run: its own daily cap, or the room left in the review queue if smaller. */
export function reviewRoom(maxPending: number | null, pending: number, dailyCap: number): { cap: number; limited: boolean } {
  if (maxPending == null) return { cap: dailyCap, limited: false };
  const room = Math.max(0, maxPending - pending);
  return room < dailyCap ? { cap: room, limited: true } : { cap: dailyCap, limited: false };
}

/** An audience's cap for this run: its own cap, or whatever is left of the daily limit if that is less. */
export function effectiveSpendCap(profileCapUsd: number, dailyLimit: number, spentToday: number): { capUsd: number; limitedByDaily: boolean } {
  const left = round4(Math.max(0, dailyLimit - spentToday));
  return left < profileCapUsd ? { capUsd: left, limitedByDaily: true } : { capUsd: profileCapUsd, limitedByDaily: false };
}

export function isDuplicateKey(err: unknown): boolean {
  for (let e = err as { code?: string; errno?: number; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
  }
  return false;
}

export async function runLeadIngest(
  db: Db = createDb(),
  deps?: IngestDeps,
  /** profileId: run just that audience. allActive: run every active audience even if it already ran today (manual test runs). */
  opts: { profileId?: number; allActive?: boolean } = {},
): Promise<IngestSummary> {
  const telegram = telegramFromEnv();
  const startedAt = new Date();
  const [run] = await db.insert(schema.syncRuns).values({ job: "lead-ingest", status: "running", startedAt }).$returningId();
  const summary: IngestSummary = { profiles: [], inserted: 0, estimatedCostUsd: 0 };
  try {
    if (!deps) {
      const row = await db.query.config.findFirst({ where: eq(schema.config.key, "sourcing_actors") });
      deps = ingestDepsFromEnv(process.env, (row?.value as Record<string, string> | undefined) ?? {});
    }
    const all = (await db.select().from(schema.sourcingProfiles)) as unknown as ProfileRow[];
    const now0 = deps.now();
    const profiles = all.filter((p) => (opts.profileId ? p.id === opts.profileId : p.active && (opts.allActive || !ranToday(p, now0))));
    const competitors = competitorRules(await db.select().from(schema.competitors));
    const known = await loadKnownPeople(db);
    // People dropped after a paid read in the last 90 days count as known: don't pay to read them again.
    const gatedRow = await db.query.config.findFirst({ where: eq(schema.config.key, GATED_CONFIG_KEY) });
    const storedGated = (gatedRow?.value as GatedMemory | undefined) ?? {};
    const stillActive = new Set(activeGated(storedGated, now0));
    const gatedMemory: GatedMemory = Object.fromEntries(Object.entries(storedGated).filter(([k]) => stillActive.has(k)));
    for (const k of Object.keys(gatedMemory)) known.handles.add(k);
    const verify = makeVerify(deps);
    const now = deps.now();
    const limit = await dailyLimitUsd(db);
    const spentEarlier = await spentTodayUsd(db, now, run!.id);
    summary.dailyLimitUsd = limit;
    summary.spentEarlierTodayUsd = spentEarlier;
    const maxPending = await maxPendingReview(db);
    const [pendingRow] = await db
      .select({ pending: sql<number>`COUNT(*)` })
      .from(schema.leads)
      .where(eq(schema.leads.sourcingReview, "pending"));
    let pendingNow = Number(pendingRow?.pending ?? 0);
    summary.maxPendingReview = maxPending;
    summary.pendingReviewBefore = pendingNow;

    // Competitor names are searched by every audience; each search is paid for once per run.
    const searchedThisRun = new Set<string>();
    // Highest-tier niches spend first, so a tight daily limit cuts the lowest tiers.
    profiles.sort(byNichePriority);
    for (const configured of profiles) {
      const room = reviewRoom(maxPending, pendingNow, configured.dailyCap);
      if (room.cap === 0) {
        // Review queue is full: search nothing, spend nothing, leave lastRunAt so tomorrow tries again.
        summary.profiles.push({ ...emptyRunSummary(configured), stoppedBy: "review_full" });
        continue;
      }
      const { capUsd, limitedByDaily } = effectiveSpendCap(Number(configured.spendCapUsd), limit, round4(spentEarlier + summary.estimatedCostUsd));
      const profile: ProfileRow = { ...configured, spendCapUsd: capUsd, dailyCap: room.cap };
      const hitsByTerm = new Map<string, DiscoveryHit[]>();
      const termErrors: string[] = [];
      const dayNumber = Math.floor(startOfBusinessDay(now).getTime() / 86_400_000);
      const statsRow = await db.query.config.findFirst({ where: eq(schema.config.key, termStatsConfigKey(profile.id)) });
      let stats = (statsRow?.value as TermStats | undefined) ?? {};
      const searches = planSearches(profile, competitors, PER_TERM, dayNumber + profile.id, (p, t) => isResting(stats, p, t, now), searchedThisRun);
      for (const s of searches.run) searchedThisRun.add(termStatKey(s.platform, s.term));
      const termYield: Array<{ search: string; hits: number; fresh: number }> = [];
      for (const { platform, term } of searches.run) {
        try {
          const hits = await deps.discovererFor(platform)(term, { fetchImpl: deps.fetchImpl, apify: deps.apify, perTerm: PER_TERM }, discoveryOptsFor(profile, platform));
          hitsByTerm.set(`${platform}:${term}`, hits);
          // Measured before planProfile adds this run's people to `known`.
          const fresh = countFresh(profile, hits, known);
          termYield.push({ search: `${platform} ${term}`, hits: hits.length, fresh });
          stats = recordTermRun(stats, platform, term, hits.length, fresh, now);
        } catch (err) {
          termErrors.push(`${platform} ${term}: ${(err as Error).message}`);
        }
      }
      const { candidates, summary: ps } = await planProfile(profile, competitors, hitsByTerm, known, verify, now);
      stats = applyTermOutcome(stats, ps.termOutcome ?? {}, now);
      await db
        .insert(schema.config)
        .values({ key: termStatsConfigKey(profile.id), value: stats })
        .onDuplicateKeyUpdate({ set: { value: stats } });
      if (ps.gated && ps.gated.length > 0) {
        for (const g of ps.gated) {
          gatedMemory[g.key] = { reason: g.reason, at: now.toISOString() };
          known.handles.add(g.key);
        }
        await db
          .insert(schema.config)
          .values({ key: GATED_CONFIG_KEY, value: gatedMemory })
          .onDuplicateKeyUpdate({ set: { value: gatedMemory } });
      }
      ps.termErrors = termErrors;
      ps.termYield = termYield;
      ps.termsResting = searches.resting.map((s) => `${s.platform} ${s.term}`);
      ps.termsSkipped = searches.skipped.map((s) => `${s.platform} ${s.term}`);
      if (ps.termsSkipped.length > 0 && ps.stoppedBy === "exhausted") ps.stoppedBy = "spend";
      if (limitedByDaily && ps.stoppedBy === "spend") ps.stoppedBy = "daily_limit";
      for (const c of candidates) {
        // One transaction per person. The unique index on lead_handles is the last
        // line against duplicates: if the handle already belongs to a lead (another
        // process, a race, a key the in-memory set missed), nothing is written.
        try {
          await db.transaction(async (tx) => {
            const [ins] = await tx.insert(schema.leads).values(c.lead).$returningId();
            const leadId = ins!.id;
            for (const h of c.handles) {
              await tx.insert(schema.leadHandles).values({ leadId, handleKey: h.key, profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) });
            }
            if (c.enrichment) {
              await tx.insert(schema.leadEnrichments).values({
                leadId,
                platform: c.enrichment.platform,
                sourceUrl: c.enrichment.sourceUrl,
                bundle: c.enrichment.bundle,
                notes: null,
                status: c.enrichment.status,
                error: null,
              });
            }
          });
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
          ps.inserted--;
          ps.alreadyKnown++;
        }
      }
      pendingNow += ps.inserted;
      if (room.limited && ps.stoppedBy === "cap") ps.stoppedBy = "review_full";
      await db.update(schema.sourcingProfiles).set({ lastRunAt: now, lastRunSummary: ps }).where(eq(schema.sourcingProfiles.id, profile.id));
      summary.profiles.push(ps);
      summary.inserted += ps.inserted;
      summary.estimatedCostUsd = round4(summary.estimatedCostUsd + ps.estimatedCostUsd);
      // Running total on the run row, so today's spend survives a crash mid-run.
      await db.update(schema.syncRuns).set({ detail: summary }).where(eq(schema.syncRuns.id, run!.id));
    }

    await db.update(schema.syncRuns).set({ status: "ok", finishedAt: new Date(), detail: summary }).where(eq(schema.syncRuns.id, run!.id));
    console.log(`[lead-ingest] ok — inserted=${summary.inserted} cost≈$${summary.estimatedCostUsd}`);
    return summary;
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: message, ...summary } })
      .where(eq(schema.syncRuns.id, run!.id));
    await alert(telegram, `lead-ingest FAILED: ${message}`);
    throw err;
  }
}
