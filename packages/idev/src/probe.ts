// Phase 0 read-only probe:  pnpm probe:idev
// Uses the store's proven two-step auth (authenticate.php → Bearer token).
// Answers, without writing anything: roster counts per affiliate_type, and
// which fields the API actually returns (signup_date confirmed 2026-09-01).

import { getAffiliates, idevConfigFromEnv, redactUrl } from "./index.js";

const config = idevConfigFromEnv();
console.log(`Probing ${redactUrl(config.url)} (read-only, token auth)…\n`);

for (const type of ["approved", "pending", "declined"] as const) {
  try {
    const affiliates = await getAffiliates(config, type);
    console.log(`affiliate_type=${type}: ${affiliates.length} records`);
    const sample = affiliates[0];
    if (sample) console.log(`  fields: ${Object.keys(sample).join(", ")}`);
  } catch (err) {
    console.log(`affiliate_type=${type}: FAILED — ${(err as Error).message}`);
  }
}

console.log(
  "\nStill manual (iDev admin UI, read-only): payout level (expect 25), referral tier " +
    "(expect 20 — DO NOT CHANGE), referral tree location, commission void capability, under-21 controls.",
);
