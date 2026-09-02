// Bridges outreach-dispatch → Instantly. Builds the pushToEsp callback that
// sends a linted, personalized recruiting email through the shell campaign
// (our content rides in custom variables, Instantly just delivers).

import { instantlyFromEnv, pushLead, type InstantlyConfig } from "@biolinx/instantly";

export interface EspPushRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  subject: string;
  body: string;
}

/** Returns a pushToEsp for outreach-dispatch, or null if email isn't
 *  configured (campaign id + API key must both be present). */
export function instantlyPusher(env = process.env): ((row: EspPushRow) => Promise<void>) | null {
  const campaignId = env.COLD_EMAIL_CAMPAIGN_ID;
  if (!campaignId) return null;
  let config: InstantlyConfig;
  try {
    config = instantlyFromEnv(env);
  } catch {
    return null;
  }
  return async (row: EspPushRow) => {
    await pushLead(config, {
      campaignId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      subject: row.subject,
      body: row.body,
    });
  };
}
