// swipe-sync (worker, every 10 minutes): sends posts a person approved, when
// "Send approved posts automatically" is on, and looks up any sent post whose
// callback hasn't arrived. No Anthropic spend; only approved posts ever leave.

import { eq } from "drizzle-orm";
import { schema, type Db } from "@biolinx/db";
import { alert, telegramFromEnv } from "@biolinx/notify";
import { contentConfigFromEnv, createContentClient } from "./biolinx-client.js";
import { refreshSwipeStatuses, sendApprovedSwipePosts } from "./swipe.js";

export async function runSwipeSync(db: Db, env = process.env): Promise<{ skipped?: string; sent?: unknown; refreshed?: unknown }> {
  const cfg = contentConfigFromEnv(env);
  if (!cfg) return { skipped: "no Biolinx content secret" };
  const client = createContentClient(cfg);
  const out: { sent?: unknown; refreshed?: unknown } = {};
  if (env.BIOLINX_CONTENT_ENABLED === "true") {
    const pending = await db.select({ id: schema.swipePosts.id }).from(schema.swipePosts).where(eq(schema.swipePosts.status, "approved")).limit(1);
    if (pending.length) {
      const sent = await sendApprovedSwipePosts(db, client);
      out.sent = sent;
      if (sent.error) await alert(telegramFromEnv(env), `swipe-sync: sending to Biolinx failed: ${sent.error}`);
    }
  }
  out.refreshed = await refreshSwipeStatuses(db, client);
  return out;
}
