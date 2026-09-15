// Worker entry — no Docker, no Redis: plain Node process (PM2-managed in
// production) running scheduled jobs under MySQL named locks.

import { loadEnv } from "@biolinx/core";
loadEnv();

const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runIdevSync, runRankRecompute, runReferralExpiry, runMetricsDigest, runEnrichPersonalize, runLeadIngest, runCustomerioSync, runSwipeSync } =
  await import("@biolinx/jobs");
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
  // Jobs that spend Apify/Anthropic credit never run on boot: a restart must not spend money.
  // Their first run follows their last run in sync_runs, at least an hour after boot.
  { name: "enrich-personalize", everyMs: 24 * HOUR, spends: true, fn: async () => void (await runEnrichPersonalize(conn.db)) },
  { name: "lead-ingest", everyMs: 24 * HOUR, spends: true, fn: async () => void (await runLeadIngest(conn.db)) },
  { name: "customerio-sync", everyMs: HOUR, runOnBoot: true, fn: async () => void (await runCustomerioSync(conn.db)) },
  { name: "metrics-digest", everyMs: 24 * HOUR, runOnBoot: false, fn: async () => void (await runMetricsDigest(conn.db)) },
  // Sends only posts a person approved (and only when auto-send is on); looks up missed callbacks.
  { name: "swipe-sync", everyMs: 10 * 60 * 1000, runOnBoot: false, fn: async () => void (await runSwipeSync(conn.db)) },
  // Phase 3+: outreach-dispatch, reply-ingest on a schedule.
]);

console.log("[worker] up — idev-sync 30m · rank 6h · referral-expiry 24h · enrich 24h · ingest 24h · customerio 1h · digest 24h · swipe-sync 10m");
