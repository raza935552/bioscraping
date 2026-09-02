// One-time: create the affiliate-recruiting shell campaign in Instantly and
// store its id in the config table. Idempotent — if config already has a
// campaign id that still exists in Instantly, it is reused.

import { eq } from "drizzle-orm";
import { createRecruitingCampaign, getCampaign, instantlyFromEnv } from "@biolinx/instantly";
import { createDb, schema, type Db } from "@biolinx/db";

export interface CampaignSetupResult {
  campaignId: string;
  created: boolean;
}

export async function setupRecruitingCampaign(
  db: Db = createDb(),
  opts: { name?: string; timezone?: string } = {},
): Promise<CampaignSetupResult> {
  const config = instantlyFromEnv();

  // Reuse an existing campaign if config already points at a live one.
  const existing = await db.query.config.findFirst({ where: eq(schema.config.key, "recruiting_campaign_id") });
  if (existing) {
    const id = (existing.value as { id?: string }).id;
    if (id) {
      try {
        await getCampaign(config, id);
        return { campaignId: id, created: false };
      } catch {
        /* stale — fall through and create a new one */
      }
    }
  }

  const campaign = await createRecruitingCampaign(config, opts);
  await db
    .insert(schema.config)
    .values({ key: "recruiting_campaign_id", value: { id: campaign.id, name: opts.name ?? "Affiliate Recruiting (engine-driven)" } })
    .onDuplicateKeyUpdate({ set: { value: { id: campaign.id, name: opts.name ?? "Affiliate Recruiting (engine-driven)" } } });

  return { campaignId: campaign.id, created: true };
}
