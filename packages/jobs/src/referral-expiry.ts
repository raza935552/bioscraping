// referral-expiry — the job iDev cannot do (no expiry field for tier
// commissions; FAQ: "It's currently lifetime. Matt approved 12 months.
// Unresolved."). REPORT-ONLY until the recruiter-tree probe lands: computes
// override_expires_at = signup + 12 months from the synced signup dates and
// flags expired affiliates. Automated iDev writes stay probe-gated; Diana
// acts on the report. Never touches the `20` referral setting.

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { createDb, schema, type Db } from "@biolinx/db";

export interface ExpirySummary {
  stamped: number;
  newlyExpired: number;
  expiredTotal: number;
}

export async function runReferralExpiry(db: Db = createDb(), now = new Date()): Promise<ExpirySummary> {
  const startedAt = new Date();
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ job: "referral-expiry", status: "running", startedAt })
    .$returningId();

  try {
    // Stamp override_expires_at for anyone with a signup date but no stamp.
    const unstamped = await db
      .select()
      .from(schema.affiliates)
      .where(and(isNotNull(schema.affiliates.signedUpAt), isNull(schema.affiliates.overrideExpiresAt)));
    for (const a of unstamped) {
      const expires = new Date(a.signedUpAt!);
      expires.setUTCFullYear(expires.getUTCFullYear() + 1);
      await db
        .update(schema.affiliates)
        .set({ overrideExpiresAt: expires })
        .where(eq(schema.affiliates.id, a.id));
    }

    // Flag newly-expired (12 months elapsed, not yet flagged).
    const newlyExpired = await db
      .select()
      .from(schema.affiliates)
      .where(
        and(
          eq(schema.affiliates.overrideExpired, false),
          isNotNull(schema.affiliates.overrideExpiresAt),
          lt(schema.affiliates.overrideExpiresAt, now),
        ),
      );
    for (const a of newlyExpired) {
      await db.update(schema.affiliates).set({ overrideExpired: true }).where(eq(schema.affiliates.id, a.id));
    }

    const expiredTotal = (
      await db.select().from(schema.affiliates).where(eq(schema.affiliates.overrideExpired, true))
    ).length;

    const summary: ExpirySummary = {
      stamped: unstamped.length,
      newlyExpired: newlyExpired.length,
      expiredTotal,
    };
    await db
      .update(schema.syncRuns)
      .set({ status: "ok", finishedAt: new Date(), detail: summary })
      .where(eq(schema.syncRuns.id, run!.id));
    console.log(`[referral-expiry] ok — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: (err as Error).message } })
      .where(eq(schema.syncRuns.id, run!.id));
    throw err;
  }
}
