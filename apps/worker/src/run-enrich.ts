// One-shot manual run:  pnpm --filter @biolinx/worker exec tsx src/run-enrich.ts [cap]
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runEnrichPersonalize } = await import("@biolinx/jobs");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const cap = Number(process.argv[2] ?? 5);
const summary = await runEnrichPersonalize(conn.db, undefined, { cap });
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
