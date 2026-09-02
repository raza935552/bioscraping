// rank-recompute — reimplementation of the client's overnight ranking run
// (MASTER-PLAN §4.2). Pure ranking lives in @biolinx/core (unit-tested);
// this job feeds it from MySQL and diff-writes only changed rows.

import { eq } from "drizzle-orm";
import { isSp5, rankAll, type AffiliationStatus, type EntryTier, type RankInput } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";

export interface RankSummary {
  total: number;
  changed: number;
  triage: number;
  sp5Excluded: number;
}

export async function runRankRecompute(db: Db = createDb()): Promise<RankSummary> {
  const startedAt = new Date();
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ job: "rank-recompute", status: "running", startedAt })
    .$returningId();

  try {
    const leads = await db.select().from(schema.leads);
    const inputs: RankInput[] = leads.map((l) => ({
      id: String(l.id),
      affiliationStatus: (l.affiliationStatus as AffiliationStatus) ?? null,
      totalReach: l.totalReach, // NULL stays NULL — blank is a sentinel
      entryTier: (l.entryTier as EntryTier) ?? null,
      niche: l.niche ?? null,
      ...(l.personCount ? { personCount: l.personCount } : {}),
    }));

    const results = rankAll(inputs);
    let changed = 0;
    let triage = 0;
    let sp5 = 0;
    const byId = new Map(leads.map((l) => [l.id, l]));

    for (const r of results) {
      const lead = byId.get(Number(r.id))!;
      if (r.needsTriage) triage++;
      if (lead.subProfile === "SP5") sp5++;
      if (lead.conversionRank !== r.rank || lead.rankBand !== r.band || lead.needsTriage !== r.needsTriage) {
        changed++;
        await db
          .update(schema.leads)
          .set({ conversionRank: r.rank, rankBand: r.band, needsTriage: r.needsTriage })
          .where(eq(schema.leads.id, Number(r.id)));
      }
    }

    const summary: RankSummary = { total: results.length, changed, triage, sp5Excluded: sp5 };
    await db
      .update(schema.syncRuns)
      .set({ status: "ok", finishedAt: new Date(), detail: summary })
      .where(eq(schema.syncRuns.id, run!.id));
    console.log(`[rank-recompute] ok — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: (err as Error).message } })
      .where(eq(schema.syncRuns.id, run!.id));
    throw err;
  }
}
