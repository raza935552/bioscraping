// One-shot manual run:  pnpm --filter @biolinx/worker run:ingest [profileId]
// Spends real Apify credit. Do not run until the team has approved a live run.
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runLeadIngest } = await import("@biolinx/jobs");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const profileId = process.argv[2] ? Number(process.argv[2]) : undefined;
const summary = await runLeadIngest(conn.db, undefined, profileId ? { profileId } : {});
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
