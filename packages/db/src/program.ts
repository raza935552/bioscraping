// Recompute Program Status from the affiliates table. Called after a human
// classifies accounts (admin) and by idev-sync after a pull. IMPORTANT:
// last_synced_at is stamped ONLY by idev-sync (a classification is not a
// pull — freshness semantics stay honest).

import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./index.js";

export const PROGRAM_NAME = "Biolinx Partner Program";

export interface ProgramCounts {
  external: number;
  internal: number;
  unresolved: number;
  unresolvedAccounts: string;
}

export async function computeProgramCounts(db: Db): Promise<ProgramCounts> {
  const rows = await db.select().from(schema.affiliates);
  let external = 0;
  let internal = 0;
  const unresolvedLines: string[] = [];
  for (const a of rows) {
    if (a.classification === "external") external++;
    else if (a.classification === "internal") internal++;
    else {
      unresolvedLines.push(
        `${a.idevId} | ${[a.firstName, a.lastName].filter(Boolean).join(" ") || "?"} | ${a.username ?? "?"} | ${a.email ?? "no email"}`,
      );
    }
  }
  return {
    external,
    internal,
    unresolved: unresolvedLines.length,
    unresolvedAccounts: unresolvedLines.join("\n"),
  };
}

/** Upsert counts WITHOUT touching last_synced_at. */
export async function recomputeProgramStatus(db: Db): Promise<ProgramCounts> {
  const counts = await computeProgramCounts(db);
  await db
    .insert(schema.programStatus)
    .values({
      program: PROGRAM_NAME,
      liveExternalCount: counts.external,
      unresolvedCount: counts.unresolved,
      unresolvedAccounts: counts.unresolvedAccounts,
    })
    .onDuplicateKeyUpdate({
      set: {
        liveExternalCount: counts.external,
        unresolvedCount: counts.unresolved,
        unresolvedAccounts: counts.unresolvedAccounts,
        // keep the row's last_synced_at exactly as-is
        program: sql`program`,
      },
    });
  return counts;
}
