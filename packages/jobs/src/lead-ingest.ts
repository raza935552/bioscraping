// lead-ingest (sourcing spec §7): audiences → Apify discovery → filter →
// dedupe → verify by profile read → score → pending leads for review.
// planProfile is the testable core; runLeadIngest wraps it with the DB.

import { and, eq, gte } from "drizzle-orm";
import { brandFitForNiche, handleKey, normalizeEmail, normalizeNiche, type Niche } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { alert, telegramFromEnv } from "@biolinx/notify";
import {
  ACTOR_UNIT_PRICE,
  VERIFY_UNIT_PRICE,
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

export function ingestDepsFromEnv(env = process.env, actorOverrides: Record<string, string> = {}): IngestDeps {
  const apify = apifyConfigFromEnv(env, actorOverrides);
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
  stoppedBy: "cap" | "spend" | "daily_limit" | "exhausted";
  termErrors: string[];
  /** Searches not run because they would have pushed the run past its spend cap. */
  termsSkipped: string[];
}

export interface IngestSummary {
  profiles: ProfileRunSummary[];
  inserted: number;
  estimatedCostUsd: number;
  /** Shared limit for every audience in one business day (America/Los_Angeles). */
  dailyLimitUsd?: number;
  /** Estimated spend from earlier lead-ingest runs today, before this run. */
  spentEarlierTodayUsd?: number;
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
  const summary: ProfileRunSummary = {
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
  };
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

  const { kept, rejected } = applyFilters([...merged.values()], {
    followerMin: profile.followerMin ?? {},
    followerMax: profile.followerMax ?? {},
    countries: profile.countries ?? [],
    language: profile.language,
    excludeTerms: profile.excludeTerms ?? [],
    excludeHandles: profile.excludeHandles ?? [],
  });
  summary.rejected = rejected;

  const fresh = kept.filter((h) => {
    const pre = scoreHit({ hit: h, verified: null, rules: rulesFor(profile, h), competitors, now });
    if (isKnown(h, pre.affiliateCode, known)) {
      summary.alreadyKnown++;
      return false;
    }
    return true;
  });
  fresh.sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1));

  const niche = (normalizeNiche(profile.niche) ?? profile.niche) as Niche;
  const brandFit = profile.brandFit || brandFitForNiche(niche);
  const candidates: Candidate[] = [];

  for (const h of fresh) {
    if (candidates.length >= profile.dailyCap) {
      summary.stoppedBy = "cap";
      break;
    }
    if (summary.estimatedCostUsd + VERIFY_UNIT_PRICE > spendCap) {
      summary.stoppedBy = "spend";
      break;
    }
    summary.estimatedCostUsd = round4(summary.estimatedCostUsd + VERIFY_UNIT_PRICE);

    let v: VerifiedRead | null = null;
    try {
      v = await verify(h);
      if (v) summary.verified++;
    } catch {
      summary.verifyFailed++;
    }

    const s = scoreHit({ hit: h, verified: v, rules: rulesFor(profile, h), competitors, now });
    const sample = [
      ...(h.postUrl ? [{ url: h.postUrl, text: h.postText ?? "", postedAt: h.postedAt }] : []),
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
            bundle: { platform: h.platform, profileUrl: v.profileUrl, bio: v.bio, followers: v.followers, items: v.items },
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
  return { candidates, summary };
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
      { fetchImpl: deps.fetchImpl, apify: deps.apify, maxItems: 12 },
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
export function verifyReserveUsd(profile: Pick<ProfileRow, "dailyCap" | "spendCapUsd">): number {
  const cap = Number(profile.spendCapUsd);
  return round4(Math.min(profile.dailyCap * VERIFY_UNIT_PRICE, cap / 2));
}

/** Every search a profile wants, audience terms first, then competitor names,
 *  deduped per platform, split into what fits the search budget and what doesn't.
 *  Nothing runs before this: the spend cap gates searching, not only verification. */
export function planSearches(
  profile: Pick<ProfileRow, "platforms" | "terms" | "dailyCap" | "spendCapUsd">,
  competitors: Pick<CompetitorRule, "name">[],
  perTerm: number,
): { run: PlannedSearch[]; skipped: PlannedSearch[]; budgetUsd: number } {
  const budgetUsd = round4(Math.max(0, Number(profile.spendCapUsd) - verifyReserveUsd(profile)));
  const all: PlannedSearch[] = [];
  for (const platform of profile.platforms) {
    const names = COMPETITOR_NAME_PLATFORMS.has(platform) ? competitors.map((c) => c.name) : [];
    const seen = new Set<string>();
    for (const raw of [...(profile.terms[platform] ?? []), ...names]) {
      const term = raw.trim();
      const key = term.replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push({ platform, term, estimatedCostUsd: round4(ACTOR_UNIT_PRICE[platform] * perTerm) });
    }
  }
  const run: PlannedSearch[] = [];
  const skipped: PlannedSearch[] = [];
  let spent = 0;
  for (const s of all) {
    if (spent + s.estimatedCostUsd <= budgetUsd) {
      run.push(s);
      spent = round4(spent + s.estimatedCostUsd);
    } else skipped.push(s);
  }
  return { run, skipped, budgetUsd };
}

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

export async function runLeadIngest(db: Db = createDb(), deps?: IngestDeps, opts: { profileId?: number } = {}): Promise<IngestSummary> {
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
    const profiles = all.filter((p) => (opts.profileId ? p.id === opts.profileId : p.active));
    const competitors = competitorRules(await db.select().from(schema.competitors));
    const known = await loadKnownPeople(db);
    const verify = makeVerify(deps);
    const now = deps.now();
    const limit = await dailyLimitUsd(db);
    const spentEarlier = await spentTodayUsd(db, now, run!.id);
    summary.dailyLimitUsd = limit;
    summary.spentEarlierTodayUsd = spentEarlier;

    for (const configured of profiles) {
      const { capUsd, limitedByDaily } = effectiveSpendCap(Number(configured.spendCapUsd), limit, round4(spentEarlier + summary.estimatedCostUsd));
      const profile: ProfileRow = { ...configured, spendCapUsd: capUsd };
      const hitsByTerm = new Map<string, DiscoveryHit[]>();
      const termErrors: string[] = [];
      const searches = planSearches(profile, competitors, PER_TERM);
      for (const { platform, term } of searches.run) {
        try {
          const hits = await deps.discovererFor(platform)(term, { fetchImpl: deps.fetchImpl, apify: deps.apify, perTerm: PER_TERM }, discoveryOptsFor(profile, platform));
          hitsByTerm.set(`${platform}:${term}`, hits);
        } catch (err) {
          termErrors.push(`${platform} ${term}: ${(err as Error).message}`);
        }
      }
      const { candidates, summary: ps } = await planProfile(profile, competitors, hitsByTerm, known, verify, now);
      ps.termErrors = termErrors;
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
