// swipe-search: finds top-performing TikTok posts on our topics so the swipe file never
// runs out of inspiration. The lead engine only reads creators it might recruit; this reads
// hashtag feeds, which TikTok orders by performance, and keeps posts that clearly beat the
// creator's size. Instagram's hashtag feed returns only the newest posts (0-4 likes when
// smoke-tested 2026-09-15), so it is not searched. Spends Apify credit and counts toward the
// daily sourcing limit.

import { desc, eq, inArray } from "drizzle-orm";
import { NICHE_PRIORITY } from "@biolinx/core";
import { schema, type Db } from "@biolinx/db";
import { ACTOR_UNIT_PRICE, DISCOVERY_ACTORS, countryCode, looksNonEnglish, runActorSync, tagOf } from "@biolinx/scraping";
import { dailyLimitUsd, spentTodayUsd } from "../lead-ingest.js";

/** Hashtags per niche. TikTok blocks some (#peptides, #bpc157 return "does not exist"); those
 *  come back as an error row and cost nothing. Override with config `swipe_search_tags`. */
export const SWIPE_TAGS: Record<string, string[]> = {
  "Weight-loss seeker": ["peptidesforweightloss", "metabolichealth", "menopausehealth"],
  Biohacker: ["peptidetok", "biohacking", "biohacker", "peptide"],
  "Gym / PED-curious": ["fitnesspeptides", "gymsupplements", "peptidesforfitness"],
  "Anti-aging": ["longevity", "healthspan", "healthyaging"],
};

export const SWIPE_SEARCH_PER_TAG = 40;
export const DEFAULT_SWIPE_SEARCH_USD = 1;
const STATE_KEY = "swipe_search_state";

export interface SwipeTag {
  tag: string;
  niche: string;
}

/** Every tag in niche-priority order, then competitor names as tags (their fans' top posts). */
export function allSwipeTags(tags: Record<string, string[]>, competitorNames: string[]): SwipeTag[] {
  const out: SwipeTag[] = [];
  const seen = new Set<string>();
  const push = (tag: string, niche: string) => {
    const t = tagOf(tag);
    if (t.length >= 3 && !seen.has(t)) {
      seen.add(t);
      out.push({ tag: t, niche });
    }
  };
  for (const niche of NICHE_PRIORITY) for (const t of tags[niche] ?? []) push(t, niche);
  for (const name of competitorNames) push(name, "Biohacker");
  return out;
}

/** The next `n` tags starting at `offset`, wrapping, so each run searches different tags. */
export function planSwipeTags(tags: SwipeTag[], offset: number, n: number): { batch: SwipeTag[]; nextOffset: number } {
  if (tags.length === 0 || n <= 0) return { batch: [], nextOffset: 0 };
  const start = ((offset % tags.length) + tags.length) % tags.length;
  const batch: SwipeTag[] = [];
  for (let i = 0; i < Math.min(n, tags.length); i++) batch.push(tags[(start + i) % tags.length]!);
  return { batch, nextOffset: (start + batch.length) % tags.length };
}

interface TikTokRow {
  error?: string;
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  authorMeta?: { name?: string; fans?: number };
  locationMeta?: { countryCode?: string | number };
}

export type SwipeSourceRow = typeof schema.swipeSources.$inferInsert;

export interface SourceRules {
  minViews: number;
  /** Views ÷ followers; a post with this many views beat the creator's usual reach. */
  minFollowerRatio: number;
  /** Views that count as a top post whatever the creator's size. */
  bigViews: number;
  maxAgeDays: number;
}

export const DEFAULT_SOURCE_RULES: SourceRules = { minViews: 50_000, minFollowerRatio: 1, bigViews: 300_000, maxAgeDays: 365 };

/** Keeps posts worth learning from: real words, English, recent enough, not known to be
 *  from outside the US, and big for the creator (views ≥ followers) or big outright. */
export function sourcesFromTikTokRows(rows: TikTokRow[], tag: SwipeTag, now: Date, rules: SourceRules = DEFAULT_SOURCE_RULES): { kept: SwipeSourceRow[]; seen: number } {
  const kept: SwipeSourceRow[] = [];
  let seen = 0;
  for (const r of rows) {
    if (r.error || !r.webVideoUrl || !/^https:\/\//.test(r.webVideoUrl)) continue;
    seen++;
    const views = typeof r.playCount === "number" ? r.playCount : 0;
    if (views < rules.minViews) continue;
    const followers = typeof r.authorMeta?.fans === "number" && r.authorMeta.fans > 0 ? r.authorMeta.fans : null;
    const beatReach = followers != null && views / followers >= rules.minFollowerRatio;
    if (!beatReach && views < rules.bigViews) continue;
    const text = (r.text ?? "").trim();
    const words = text.replace(/[#@][\p{L}\p{N}_.]+/gu, " ").replace(/\s+/g, " ").trim();
    if (words.length < 40 || looksNonEnglish(text)) continue;
    const postedAt = r.createTimeISO ? new Date(r.createTimeISO) : null;
    if (postedAt && !Number.isNaN(postedAt.getTime()) && (now.getTime() - postedAt.getTime()) / 86_400_000 > rules.maxAgeDays) continue;
    const country = countryCode(r.locationMeta?.countryCode);
    if (country && country !== "US") continue;
    kept.push({
      url: r.webVideoUrl.slice(0, 500),
      platform: "tiktok",
      niche: tag.niche,
      term: `#${tag.tag}`,
      authorHandle: r.authorMeta?.name?.slice(0, 120) ?? null,
      followers,
      views: Math.min(views, 2_147_483_647),
      likes: typeof r.diggCount === "number" ? Math.min(r.diggCount, 2_147_483_647) : null,
      comments: typeof r.commentCount === "number" ? Math.min(r.commentCount, 2_147_483_647) : null,
      text: text.slice(0, 2000),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      country,
    });
  }
  return { kept, seen };
}

export interface SwipeSearchSummary {
  skipped?: string;
  tags: Array<{ tag: string; rows: number; kept: number; error?: string }>;
  added: number;
  estimatedCostUsd: number;
}

/** Unused sources waiting (found by search, not yet written from). */
export async function unusedSwipeSources(db: Db): Promise<{ unused: number; total: number }> {
  const sources = await db.select({ url: schema.swipeSources.url }).from(schema.swipeSources);
  const used = new Set((await db.select({ u: schema.swipePosts.sourcePostUrl }).from(schema.swipePosts)).map((r) => r.u));
  return { unused: sources.filter((s) => !used.has(s.url)).length, total: sources.length };
}

export async function runSwipeSearch(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; now?: Date; fetchImpl?: typeof fetch; onlyWhenBelow?: number } = {},
): Promise<SwipeSearchSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const summary: SwipeSearchSummary = { tags: [], added: 0, estimatedCostUsd: 0 };
  const token = env.APIFY_TOKEN;
  if (!token) return { ...summary, skipped: "no Apify token" };
  if (opts.onlyWhenBelow != null) {
    const { unused } = await unusedSwipeSources(db);
    if (unused >= opts.onlyWhenBelow) return { ...summary, skipped: `${unused} unused source posts still waiting` };
  }

  const maxUsd = Number(env.SWIPE_SEARCH_MAX_USD);
  const runBudget = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : DEFAULT_SWIPE_SEARCH_USD;
  const leftToday = Math.max(0, (await dailyLimitUsd(db, env)) - (await spentTodayUsd(db, now)));
  const budget = Math.min(runBudget, leftToday);
  const perTagUsd = SWIPE_SEARCH_PER_TAG * ACTOR_UNIT_PRICE.tiktok;
  const tagCount = Math.floor(budget / perTagUsd);
  if (tagCount < 1) return { ...summary, skipped: `daily sourcing limit reached ($${leftToday.toFixed(2)} left today)` };

  const [run] = await db.insert(schema.syncRuns).values({ job: "swipe-search", status: "running", startedAt: now }).$returningId();
  try {
    const tagsRow = await db.query.config.findFirst({ where: eq(schema.config.key, "swipe_search_tags") });
    const stateRow = await db.query.config.findFirst({ where: eq(schema.config.key, STATE_KEY) });
    const actorsRow = await db.query.config.findFirst({ where: eq(schema.config.key, "sourcing_actors") });
    const competitors = await db.select({ name: schema.competitors.name }).from(schema.competitors).where(eq(schema.competitors.active, true));
    const tags = allSwipeTags((tagsRow?.value as Record<string, string[]> | undefined) ?? SWIPE_TAGS, competitors.map((c) => c.name));
    const offset = Number((stateRow?.value as { offset?: number } | undefined)?.offset ?? 0);
    const { batch, nextOffset } = planSwipeTags(tags, offset, tagCount);
    const actor = (actorsRow?.value as Record<string, string> | undefined)?.["discover:tiktok"] ?? DISCOVERY_ACTORS.tiktok;

    for (const t of batch) {
      let rows: TikTokRow[] = [];
      try {
        rows = await runActorSync<TikTokRow>({ token, fetchImpl: opts.fetchImpl ?? fetch }, actor, { hashtags: [t.tag], resultsPerPage: SWIPE_SEARCH_PER_TAG }, { timeoutSec: 180 });
      } catch (e) {
        summary.tags.push({ tag: t.tag, rows: 0, kept: 0, error: (e as Error).message.slice(0, 200) });
        continue;
      }
      const { kept, seen } = sourcesFromTikTokRows(rows, t, now);
      summary.estimatedCostUsd += seen * ACTOR_UNIT_PRICE.tiktok;
      let added = 0;
      if (kept.length) {
        const existing = new Set((await db.select({ url: schema.swipeSources.url }).from(schema.swipeSources).where(inArray(schema.swipeSources.url, kept.map((k) => k.url)))).map((r) => r.url));
        const fresh = kept.filter((k) => !existing.has(k.url));
        for (const row of fresh) {
          try {
            await db.insert(schema.swipeSources).values(row);
            existing.add(row.url);
            added++;
          } catch {
            /* same url found twice in one run */
          }
        }
      }
      summary.added += added;
      summary.tags.push({ tag: t.tag, rows: seen, kept: added, ...(rows[0]?.error && seen === 0 ? { error: rows[0].error.slice(0, 120) } : {}) });
    }
    summary.estimatedCostUsd = Math.round(summary.estimatedCostUsd * 10000) / 10000;
    await db
      .insert(schema.config)
      .values({ key: STATE_KEY, value: { offset: nextOffset, lastRunAt: now.toISOString() } })
      .onDuplicateKeyUpdate({ set: { value: { offset: nextOffset, lastRunAt: now.toISOString() } } });
    await db.update(schema.syncRuns).set({ status: "ok", detail: summary, finishedAt: new Date() }).where(eq(schema.syncRuns.id, run!.id));
    return summary;
  } catch (e) {
    await db.update(schema.syncRuns).set({ status: "failed", detail: { ...summary, error: (e as Error).message }, finishedAt: new Date() }).where(eq(schema.syncRuns.id, run!.id));
    throw e;
  }
}

/** The latest search runs, newest first, for the admin page. */
export async function recentSwipeSearches(db: Db, limit = 3) {
  return db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "swipe-search")).orderBy(desc(schema.syncRuns.id)).limit(limit);
}
