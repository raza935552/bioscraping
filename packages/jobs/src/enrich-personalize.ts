// enrich-personalize (spec §6) — researches leads so the drafting engine has
// real talking points. Pure per-lead path (enrichOne) + a thin DB orchestrator.

import { eq, inArray, lt, sql } from "drizzle-orm";
import { FAILURE_NOTE_PATTERN, handleKey, hasUsableNotes, isConverted, isSp5 } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { anthropicFromEnv, type LlmClient } from "@biolinx/drafting";
import { alert, telegramFromEnv } from "@biolinx/notify";
import {
  apifyConfigFromEnv,
  fetcherFor as defaultFetcherFor,
  resolveCandidates,
  summarizeBundle,
  type FetchDeps,
  type Fetcher,
  type ResolveInput,
  type SourceBundle,
  type SourceCandidate,
  type SourcePlatform,
} from "@biolinx/scraping";

export interface EnrichDeps {
  llm: LlmClient;
  fetchDeps: FetchDeps;
  fetcherFor: (platform: SourcePlatform) => Fetcher;
  model: string;
}

export type EnrichStatus = "enriched" | "no_match" | "no_source" | "unresolvable" | "failed";

export interface EnrichOutcome {
  status: EnrichStatus;
  platform: SourcePlatform | null;
  sourceUrl: string | null;
  notes: string | null;
  bundle: SourceBundle | null;
  error: string | null;
  handles: Array<{ key: string; url: string; verified: boolean }>;
}

const MAX_ATTEMPTS = 3;
const TERMINAL_STATUSES = ["Passed", "Signed", "No", "Signed up"];

export function enrichDepsFromEnv(env = process.env, actorOverrides: Record<string, string> = {}): EnrichDeps {
  const apify = apifyConfigFromEnv(env, actorOverrides);
  return {
    llm: anthropicFromEnv(env),
    fetchDeps: { fetchImpl: fetch, apify, maxItems: 12 },
    fetcherFor: defaultFetcherFor,
    model: env.DRAFT_MODEL ?? "claude-sonnet-5",
  };
}

/** Keep the history row small: item urls + first 300 chars of each text. */
function compactBundle(b: SourceBundle): SourceBundle {
  return { ...b, items: b.items.map((i) => ({ ...i, text: i.text.slice(0, 300) })) };
}

export async function enrichOne(lead: ResolveInput & { id: number }, deps: EnrichDeps): Promise<EnrichOutcome> {
  const queue: SourceCandidate[] = resolveCandidates(lead);
  const handles: EnrichOutcome["handles"] = [];
  const seenUrls = new Set(queue.map((c) => c.url));
  const noteHandle = (c: SourceCandidate, verified: boolean) => {
    if (!c.handle) return;
    const key = handleKey(c.platform, c.handle);
    const existing = handles.find((h) => h.key === key);
    if (existing) existing.verified = existing.verified || verified;
    else handles.push({ key, url: c.url, verified });
  };
  for (const c of queue) noteHandle(c, false);

  if (queue.length === 0) {
    return { status: "no_source", platform: null, sourceUrl: null, notes: null, bundle: null, error: null, handles };
  }

  let lastError: string | null = null;
  let anyReachable = false;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    let bundle: SourceBundle;
    try {
      bundle = await deps.fetcherFor(c.platform)(c, deps.fetchDeps);
    } catch (err) {
      lastError = `${c.platform} ${c.url}: ${(err as Error).message}`;
      continue;
    }
    anyReachable = true;
    for (const d of bundle.discovered ?? []) {
      if (!seenUrls.has(d.url)) {
        seenUrls.add(d.url);
        queue.push(d);
        noteHandle(d, false);
      }
    }
    if (bundle.items.length === 0) continue;
    noteHandle(c, true);

    try {
      const summary = await summarizeBundle(deps.llm, bundle, deps.model);
      const compact = compactBundle(bundle);
      if (summary.verdict === "match") {
        return { status: "enriched", platform: c.platform, sourceUrl: bundle.profileUrl, notes: summary.note, bundle: compact, error: null, handles };
      }
      return { status: "no_match", platform: c.platform, sourceUrl: bundle.profileUrl, notes: null, bundle: compact, error: null, handles };
    } catch (err) {
      return {
        status: "failed",
        platform: c.platform,
        sourceUrl: bundle.profileUrl,
        notes: null,
        bundle: compactBundle(bundle),
        error: (err as Error).message,
        handles,
      };
    }
  }
  if (!anyReachable) return { status: "failed", platform: null, sourceUrl: null, notes: null, bundle: null, error: lastError, handles };
  return { status: "unresolvable", platform: null, sourceUrl: null, notes: null, bundle: null, error: lastError, handles };
}

export interface EnrichSummary {
  attempted: number;
  enriched: number;
  no_match: number;
  unresolvable: number;
  no_source: number;
  failed: number;
  cleaned: number;
  purgedBlockedDrafts: number;
}

export async function runEnrichPersonalize(
  db: Db = createDb(),
  deps?: EnrichDeps,
  opts: { cap?: number } = {},
): Promise<EnrichSummary> {
  const cap = opts.cap ?? Number(process.env.ENRICH_DAILY_CAP ?? 40);
  const telegram = telegramFromEnv();
  const summary: EnrichSummary = { attempted: 0, enriched: 0, no_match: 0, unresolvable: 0, no_source: 0, failed: 0, cleaned: 0, purgedBlockedDrafts: 0 };
  const startedAt = new Date();
  const [run] = await db.insert(schema.syncRuns).values({ job: "enrich-personalize", status: "running", startedAt }).$returningId();

  try {
    // Actor overrides live in the config table (spec §3); env supplies keys.
    if (!deps) {
      const row = await db.query.config.findFirst({ where: eq(schema.config.key, "scraping_actors") });
      deps = enrichDepsFromEnv(process.env, (row?.value as Record<string, string> | undefined) ?? {});
    }

    // One-time cleanup (idempotent): August failure markers are not notes.
    const all = await db.select().from(schema.leads);
    const stale = all.filter(
      (l) => l.personalizationNotes != null && !hasUsableNotes(l.personalizationNotes) && FAILURE_NOTE_PATTERN.test(l.personalizationNotes),
    );
    if (stale.length > 0) {
      await db
        .update(schema.leads)
        .set({ personalizationNotes: null, enrichmentStatus: "pending" })
        .where(inArray(schema.leads.id, stale.map((l) => l.id)));
      summary.cleaned = stale.length;
    }
    // Blocked drafts whose only reason was missing notes are not real claims.
    const blocked = (await db.select().from(schema.messages).where(eq(schema.messages.state, "blocked"))).filter((m) => {
      const rep = (m.lintReport as Array<{ rule: string }> | null) ?? [];
      return rep.length > 0 && rep.every((v) => v.rule === "no-personalization");
    });
    if (blocked.length > 0) {
      await db.delete(schema.messages).where(inArray(schema.messages.id, blocked.map((m) => m.id)));
      summary.purgedBlockedDrafts = blocked.length;
    }
    // Retention: history rows older than 90 days.
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    await db.delete(schema.leadEnrichments).where(lt(schema.leadEnrichments.createdAt, cutoff));

    const fresh = stale.length > 0 ? await db.select().from(schema.leads) : all;
    const batch = fresh
      .filter(
        (l) =>
          !l.isDead &&
          !isSp5(l.subProfile) &&
          !isConverted(l.affiliationStatus) &&
          !TERMINAL_STATUSES.includes(l.status ?? "") &&
          !hasUsableNotes(l.personalizationNotes) &&
          (l.enrichmentStatus == null ||
            l.enrichmentStatus === "pending" ||
            (l.enrichmentStatus === "failed" && l.enrichmentAttempts < MAX_ATTEMPTS)),
      )
      .sort((a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9))
      .slice(0, cap);

    for (const lead of batch) {
      summary.attempted++;
      const out = await enrichOne(lead, deps);
      summary[out.status]++;
      const now = new Date();
      await db
        .update(schema.leads)
        .set({
          enrichmentStatus: out.status,
          enrichmentAttempts: sql`${schema.leads.enrichmentAttempts} + 1`,
          ...(out.status === "enriched" ? { personalizationNotes: out.notes, enrichedAt: now, enrichmentSourceUrl: out.sourceUrl } : {}),
        })
        .where(eq(schema.leads.id, lead.id));
      if (out.status !== "no_source") {
        await db.insert(schema.leadEnrichments).values({
          leadId: lead.id,
          platform: out.platform ?? "none",
          sourceUrl: out.sourceUrl ?? "",
          bundle: out.bundle,
          notes: out.notes,
          status: out.status,
          error: out.error,
        });
      }
      for (const h of out.handles) {
        await db
          .insert(schema.leadHandles)
          .values({ leadId: lead.id, handleKey: h.key, profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) })
          .onDuplicateKeyUpdate({ set: { profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) } });
      }
    }

    await db.update(schema.syncRuns).set({ status: "ok", finishedAt: new Date(), detail: summary }).where(eq(schema.syncRuns.id, run!.id));
    console.log(`[enrich-personalize] ok — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: message, ...summary } })
      .where(eq(schema.syncRuns.id, run!.id));
    await alert(telegram, `enrich-personalize FAILED: ${message}`);
    throw err;
  }
}
