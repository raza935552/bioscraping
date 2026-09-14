// customerio-sync (sourcing spec §8): mirror every lead email as a person.
// Nothing is enrolled in a campaign here; segments live in Customer.io.

import { eq, inArray, isNotNull } from "drizzle-orm";
import { normalizeEmail } from "@biolinx/core";
import { customerioClient, customerioFromEnv, type CustomerioAttributes, type CustomerioClient } from "@biolinx/customerio";
import { createDb, schema, type Db } from "@biolinx/db";

type Lead = typeof schema.leads.$inferSelect;

/** The documented attribute list (spec §8) and nothing else. A suppressed
 *  address is sent as unsubscribed only. */
export function leadAttributes(l: Lead, suppressed: boolean): CustomerioAttributes {
  if (suppressed) return { unsubscribed: true };
  return {
    first_name: l.firstName ?? null,
    last_name: l.lastName ?? null,
    lead_id: l.id,
    source: l.source ?? null,
    email_provenance: l.emailProvenance ?? null,
    niche: l.niche ?? null,
    brand_fit: l.brandFit ?? null,
    primary_platform: l.primaryPlatform ?? null,
    affiliation_status: l.affiliationStatus ?? null,
    lead_status: l.status ?? null,
    sourcing_review: l.sourcingReview ?? null,
    total_reach: l.totalReach ?? null,
    geo_country: l.geoCountry ?? null,
    unsubscribed: false,
  };
}

export interface CustomerioSyncSummary {
  considered: number;
  synced: number;
  suppressed: number;
  failed: number;
  skippedNotConfigured: boolean;
}

export async function runCustomerioSync(
  db: Db = createDb(),
  client?: CustomerioClient,
  opts: { leadIds?: number[] } = {},
): Promise<CustomerioSyncSummary> {
  const summary: CustomerioSyncSummary = { considered: 0, synced: 0, suppressed: 0, failed: 0, skippedNotConfigured: false };
  if (!client) {
    const cfg = customerioFromEnv();
    if (!cfg) {
      summary.skippedNotConfigured = true;
      return summary;
    }
    client = customerioClient(cfg);
  }
  const rows = opts.leadIds
    ? await db.select().from(schema.leads).where(inArray(schema.leads.id, opts.leadIds))
    : await db.select().from(schema.leads).where(isNotNull(schema.leads.email));
  // Due = never synced, or changed since the last sync (updated_at moves on every write).
  const due = rows.filter((l) => l.email && (opts.leadIds || l.customerioSyncedAt == null || l.customerioSyncedAt < l.updatedAt));
  const suppressed = new Set((await db.select({ e: schema.suppressions.emailNormalized }).from(schema.suppressions)).map((s) => s.e));
  for (const l of due) {
    summary.considered++;
    const isSuppressed = suppressed.has(normalizeEmail(l.email!));
    try {
      await client.identify(l.email!, leadAttributes(l, isSuppressed));
      // Stamp after updated_at so the next sweep sees this row as current.
      await db.update(schema.leads).set({ customerioSyncedAt: new Date(Date.now() + 1000) }).where(eq(schema.leads.id, l.id));
      if (isSuppressed) summary.suppressed++;
      else summary.synced++;
    } catch (err) {
      summary.failed++;
      console.error(`[customerio-sync] lead ${l.id}: ${(err as Error).message}`);
    }
  }
  console.log(`[customerio-sync] ${JSON.stringify(summary)}`);
  return summary;
}
