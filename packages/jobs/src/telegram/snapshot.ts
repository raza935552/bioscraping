// The live numbers the Telegram assistant answers from. Counts and aggregates only: no creator
// names, no emails, nothing that identifies a person, because the answer goes into a chat.

import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@biolinx/db";

export interface Snapshot {
  takenAt: string;
  goal: { target: number; external: number; unclassified: number; internal: number; daysToBlackFriday: number };
  leads: { total: number; sourced: number; accepted: number; pendingReview: number; rejected: number; withCompetitor: number };
  sourcing: { competitorsActive: number; lastRunAt: string | null; lastRunAdded: number | null; lastRunCostUsd: number | null; nightly: Array<{ day: string; added: number; costUsd: number }> };
  outreach: { queueNew: number; repliesToAnswer: number; checkinsDue: number; waitingForReply: number; messagesSent: number; repliesLogged: number };
  signups: { total: number; pending: number };
  content: { sourcePostsBanked: number; drafts: number; sent: number };
  tasks: { open: number; lastTitles: string[] };
}

const BLACK_FRIDAY = "2026-11-27";

/** One read of where everything stands, cheap enough to run on every question. */
export async function systemSnapshot(db: Db, now = new Date()): Promise<Snapshot> {
  const [leads, competitors, affiliates, messages, replies, signups, sources, posts, openTasks, runs] = await Promise.all([
    db.select({ id: schema.leads.id, review: schema.leads.sourcingReview, profile: schema.leads.sourcingProfileId, competitorId: schema.leads.competitorId, status: schema.leads.status }).from(schema.leads),
    db.select({ active: schema.competitors.active }).from(schema.competitors),
    db.select({ classification: schema.affiliates.classification }).from(schema.affiliates),
    db.select({ state: schema.messages.state }).from(schema.messages),
    db.select({ id: schema.replies.id, handledAt: schema.replies.handledAt }).from(schema.replies),
    db.select({ status: schema.signups.status }).from(schema.signups),
    db.select({ url: schema.swipeSources.url }).from(schema.swipeSources),
    db.select({ status: schema.swipePosts.status }).from(schema.swipePosts),
    db.select({ title: schema.tasks.title }).from(schema.tasks).where(eq(schema.tasks.status, "open")).orderBy(desc(schema.tasks.id)).limit(5),
    db.select({ startedAt: schema.syncRuns.startedAt, detail: schema.syncRuns.detail }).from(schema.syncRuns).where(eq(schema.syncRuns.job, "lead-ingest")).orderBy(desc(schema.syncRuns.id)).limit(7),
  ]);

  const sourced = leads.filter((l) => l.profile != null);
  const nightly = runs.map((r) => {
    const d = (r.detail ?? {}) as { inserted?: number; estimatedCostUsd?: number };
    return { day: r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 10) : "", added: d.inserted ?? 0, costUsd: d.estimatedCostUsd ?? 0 };
  });

  return {
    takenAt: now.toISOString(),
    goal: {
      target: 100,
      external: affiliates.filter((a) => a.classification === "external").length,
      unclassified: affiliates.filter((a) => a.classification === "unresolved").length,
      internal: affiliates.filter((a) => a.classification === "internal").length,
      daysToBlackFriday: Math.max(0, Math.ceil((new Date(`${BLACK_FRIDAY}T00:00:00-08:00`).getTime() - now.getTime()) / 86_400_000)),
    },
    leads: {
      total: leads.length,
      sourced: sourced.length,
      accepted: sourced.filter((l) => l.review === "accepted").length,
      pendingReview: sourced.filter((l) => l.review === "pending").length,
      rejected: sourced.filter((l) => l.review === "rejected").length,
      withCompetitor: leads.filter((l) => l.competitorId != null).length,
    },
    sourcing: {
      competitorsActive: competitors.filter((c) => c.active).length,
      lastRunAt: nightly[0]?.day ?? null,
      lastRunAdded: nightly[0]?.added ?? null,
      lastRunCostUsd: nightly[0]?.costUsd ?? null,
      nightly,
    },
    outreach: {
      // Filled in by the caller when it has the work queue; these are the cheap approximations.
      queueNew: sourced.filter((l) => l.review === "accepted" && l.status === "Not contacted").length,
      repliesToAnswer: replies.filter((r) => r.handledAt == null).length,
      checkinsDue: 0,
      waitingForReply: leads.filter((l) => l.status === "Contacted").length,
      messagesSent: messages.filter((m) => m.state === "sent").length,
      repliesLogged: replies.length,
    },
    signups: { total: signups.length, pending: signups.filter((s) => s.status !== "confirmed").length },
    content: { sourcePostsBanked: sources.length, drafts: posts.filter((p) => p.status === "draft").length, sent: posts.filter((p) => p.status === "sent").length },
    tasks: { open: openTasks.length, lastTitles: openTasks.map((t) => t.title) },
  };
}

/** The snapshot as short lines a model can read without wasting tokens on JSON punctuation. */
export function snapshotLines(s: Snapshot): string {
  const n = s.sourcing.nightly.slice(0, 4).map((r) => `${r.day}: +${r.added} for $${r.costUsd}`).join("; ");
  return [
    `Goal: ${s.goal.external} of ${s.goal.target} external affiliates, ${s.goal.unclassified} unclassified, ${s.goal.daysToBlackFriday} days to Black Friday.`,
    `Leads: ${s.leads.total} in total, ${s.leads.sourced} found by the engine, ${s.leads.accepted} accepted, ${s.leads.pendingReview} waiting for review, ${s.leads.rejected} rejected, ${s.leads.withCompetitor} tied to a named competitor.`,
    `Sourcing: ${s.sourcing.competitorsActive} competitor brands searched nightly. Recent nights — ${n || "no runs recorded"}.`,
    `Outreach: ${s.outreach.queueNew} accepted leads not yet contacted, ${s.outreach.repliesToAnswer} replies to answer, ${s.outreach.waitingForReply} waiting for a reply, ${s.outreach.messagesSent} messages sent, ${s.outreach.repliesLogged} replies logged.`,
    `Sign-ups: ${s.signups.total} in total, ${s.signups.pending} not yet confirmed.`,
    `Content: ${s.content.sourcePostsBanked} source posts banked, ${s.content.drafts} drafts waiting for approval, ${s.content.sent} sent to the library.`,
    `Open requests logged from chat: ${s.tasks.open}${s.tasks.lastTitles.length ? ` (latest: ${s.tasks.lastTitles.join("; ")})` : ""}.`,
  ].join("\n");
}
