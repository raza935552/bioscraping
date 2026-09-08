// One-shot manual dispatch into the approval queue:
//   pnpm --filter @biolinx/worker exec tsx src/run-dispatch.ts [dm|email] [cap]
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runOutreachDispatch } = await import("@biolinx/jobs");
const { anthropicFromEnv } = await import("@biolinx/drafting");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const channel = (process.argv[2] ?? "dm") as "dm" | "email";
const cap = Number(process.argv[3] ?? 5);
const summary = await runOutreachDispatch(
  {
    llm: anthropicFromEnv(),
    channel,
    dailyCap: cap,
    autosend: false,
    senderName: process.env.SENDER_NAME ?? "the team",
    postalConfigured: !!process.env.SENDER_POSTAL_ADDRESS,
  },
  conn.db,
);
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
