// One-shot manual run:  pnpm --filter @biolinx/worker run:ingest [profileId]
// Spends real Apify credit. Do not run until the team has approved a live run.
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings, withMysqlLock } = await import("@biolinx/db");
const { runLeadIngest } = await import("@biolinx/jobs");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const profileId = process.argv[2] ? Number(process.argv[2]) : undefined;
// Same lock as the scheduler and the admin buttons: two runs at once could both
// pass the daily limit check and could both insert the same person.
const summary = await withMysqlLock(conn.pool, "job:lead-ingest", () => runLeadIngest(conn.db, undefined, profileId ? { profileId } : {}));
if (summary === null) {
  console.error("lead-ingest is already running (scheduler or admin). Try again when it finishes.");
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
