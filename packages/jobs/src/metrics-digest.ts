// metrics-digest — the daily Telegram summary (replaces clock-in message 1's
// live numbers). Shows the external count as a RANGE while unresolved
// accounts exist; flags stale syncs. Log-drops gracefully until the bot
// token is configured.

import { desc, eq } from "drizzle-orm";
import { BLACK_FRIDAY, EXTERNAL_AFFILIATE_GOAL } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { sendTelegram, telegramFromEnv } from "@biolinx/notify";

export async function runMetricsDigest(db: Db = createDb(), now = new Date()): Promise<string> {
  const program = await db.query.programStatus.findFirst({
    where: eq(schema.programStatus.program, "Biolinx Partner Program"),
  });
  const lastRuns = await db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.id)).limit(5);
  const affiliates = await db.select().from(schema.affiliates);
  const external = affiliates.filter((a) => a.classification === "external").length;
  const unresolved = affiliates.filter((a) => a.classification === "unresolved").length;
  const expired = affiliates.filter((a) => a.overrideExpired).length;

  const days = Math.max(
    0,
    Math.ceil((new Date(`${BLACK_FRIDAY}T00:00:00-08:00`).getTime() - now.getTime()) / 86_400_000),
  );
  const syncAgeMin = program?.lastSyncedAt
    ? Math.round((now.getTime() - new Date(program.lastSyncedAt).getTime()) / 60_000)
    : null;
  const failed = lastRuns.filter((r) => r.status === "failed").length;

  const countLine =
    unresolved > 0
      ? `${external}–${external + unresolved} / ${EXTERNAL_AFFILIATE_GOAL} external (${unresolved} unresolved — classify in admin)`
      : `${external} / ${EXTERNAL_AFFILIATE_GOAL} external`;

  const lines = [
    `📊 Biolinx affiliate engine — daily digest`,
    countLine,
    `${days} days to Black Friday (${BLACK_FRIDAY})`,
    syncAgeMin == null
      ? `⚠️ iDev never synced`
      : syncAgeMin > 45
        ? `⚠️ iDev sync STALE: ${syncAgeMin} min ago`
        : `iDev sync fresh (${syncAgeMin} min ago)`,
    ...(failed > 0 ? [`⚠️ ${failed} failed job run(s) in the last 5 — check admin`] : []),
    ...(expired > 0 ? [`💰 ${expired} affiliate(s) past the 12-month referral override — Diana's report`] : []),
  ];
  const text = lines.join("\n");
  await sendTelegram(telegramFromEnv(), text);
  return text;
}
