// Worker entry — no Docker, no Redis: plain Node process (PM2-managed in
// production) running scheduled jobs under MySQL named locks.

import { loadEnv } from "@biolinx/core";
loadEnv();

const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runIdevSync, runRankRecompute, runReferralExpiry, runMetricsDigest, runEnrichPersonalize } = await import("@biolinx/jobs");
const { startScheduler } = await import("./scheduler.js");

const conn = connect();
const HOUR = 60 * 60 * 1000;

// Pull UI-managed secrets from the DB before any job reads them.
await hydrateEnvFromSettings(conn.db);
// Re-hydrate periodically so a settings change in the admin reaches the worker
// without a restart (secrets are cheap to re-read).
setInterval(() => void hydrateEnvFromSettings(conn.db), 2 * 60 * 1000);

startScheduler(conn, [
  { name: "idev-sync", everyMs: 30 * 60 * 1000, runOnBoot: true, fn: () => runIdevSync(conn.db) },
  { name: "rank-recompute", everyMs: 6 * HOUR, runOnBoot: true, fn: async () => void (await runRankRecompute(conn.db)) },
  { name: "referral-expiry", everyMs: 24 * HOUR, runOnBoot: true, fn: async () => void (await runReferralExpiry(conn.db)) },
  { name: "enrich-personalize", everyMs: 24 * HOUR, runOnBoot: true, fn: async () => void (await runEnrichPersonalize(conn.db)) },
  { name: "metrics-digest", everyMs: 24 * HOUR, runOnBoot: false, fn: async () => void (await runMetricsDigest(conn.db)) },
  // Phase 3+: lead-ingest, outreach-dispatch, reply-ingest on a schedule.
]);

console.log("[worker] up — idev-sync 30m · rank 6h · referral-expiry 24h · enrich 24h · digest 24h");
