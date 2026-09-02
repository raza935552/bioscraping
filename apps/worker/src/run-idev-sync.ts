// One-shot manual run:  pnpm --filter @biolinx/worker run:idev-sync
import { loadEnv } from "@biolinx/core";
loadEnv();
const { runIdevSync } = await import("@biolinx/jobs");
runIdevSync()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
