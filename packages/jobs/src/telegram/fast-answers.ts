// The questions people actually ask, answered straight from the database with no model call: no
// cost, no waiting, and the same words every time. Anything that isn't one of these, or that leans
// on what was said earlier in the chat, goes to the model instead.

import type { Snapshot } from "./snapshot.js";

/** A follow-up only makes sense against the conversation, so it must never be answered from a rule. */
const FOLLOW_UP = /^(and|but|so|ok|okay|also|what about|how about|why|why not|then|those|them|it|that|this|he|she|they)\b/i;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface FastAnswer {
  intent: string;
  text: string;
}

type Rule = { intent: string; when: RegExp; answer: (s: Snapshot) => string };

const RULES: Rule[] = [
  {
    intent: "affiliates",
    when: /\b(how many|number of|count of)\b.*\baffiliate|^affiliates\b|\bgoal\b.*\baffiliate|\baffiliate\b.*\bgoal\b|how (are|r) we (doing|tracking)\b.*\bgoal\b/i,
    answer: (s) =>
      `${s.goal.external} of ${s.goal.target} external affiliates. ${s.goal.unclassified > 0 ? `${s.goal.unclassified} more are signed up but nobody has confirmed whether they count yet. ` : ""}${s.goal.daysToBlackFriday} days to Black Friday.`,
  },
  {
    intent: "review queue",
    when: /\b(waiting|pending|queue|to review|need(s)? review|review queue)\b/i,
    answer: (s) =>
      `${plural(s.leads.pendingReview, "lead")} waiting for someone to accept or reject them. ${s.leads.accepted} accepted so far, ${s.leads.rejected} rejected.`,
  },
  {
    intent: "sourcing",
    when: /\b(scrape|scraping|sourcing|last night|tonight|finding leads|new leads)\b/i,
    answer: (s) => {
      const last = s.sourcing.nightly[0];
      const recent = s.sourcing.nightly.slice(0, 4).map((r) => `${r.day}: ${r.added} for $${r.costUsd}`).join(", ");
      return last
        ? `Yes, it runs every night. Last run added ${plural(last.added, "creator")} for $${last.costUsd}, searching ${s.sourcing.competitorsActive} competitor brands. Recent nights — ${recent}.`
        : `No sourcing runs are recorded yet. ${s.sourcing.competitorsActive} competitor brands are set up to search.`;
    },
  },
  {
    intent: "outreach queue",
    when: /\b(outreach|to contact|not contacted|messages? to send|dm queue|who('s| is) next)\b/i,
    answer: (s) =>
      `${plural(s.outreach.queueNew, "accepted lead")} waiting for a first message, ${plural(s.outreach.repliesToAnswer, "reply")} to answer, and ${s.outreach.waitingForReply} people we're waiting on. ${s.outreach.messagesSent} messages sent so far.`,
  },
  {
    intent: "signups",
    when: /\b(sign ?ups?|signed up|new partners?|joined)\b/i,
    answer: (s) => `${plural(s.signups.total, "sign-up")} so far${s.signups.pending > 0 ? `, ${s.signups.pending} not yet confirmed` : ""}.`,
  },
  {
    intent: "content",
    when: /\b(swipe|content|posts? to approve|drafts?|assets?)\b/i,
    answer: (s) =>
      `${plural(s.content.sourcePostsBanked, "source post")} banked to write from, ${plural(s.content.drafts, "draft")} waiting for approval, ${s.content.sent} sent to the library.`,
  },
  {
    intent: "requests",
    when: /\b(requests?|tasks?|to ?do|open items?)\b/i,
    answer: (s) =>
      s.tasks.open === 0
        ? "Nothing open. Everything asked for in here has been dealt with."
        : `${plural(s.tasks.open, "open request")}: ${s.tasks.lastTitles.join("; ")}.`,
  },
  {
    intent: "bottleneck",
    when: /\b(slow(ing)?|bottleneck|blocked|holding (us )?up|stuck|what('s| is) wrong|why (so )?(slow|few))\b/i,
    answer: (s) => {
      const bits: string[] = [];
      if (s.leads.pendingReview > 0) bits.push(`${s.leads.pendingReview} leads waiting for a yes or no`);
      if (s.outreach.queueNew > 0) bits.push(`${s.outreach.queueNew} accepted leads nobody has messaged yet`);
      if (s.outreach.repliesToAnswer > 0) bits.push(`${plural(s.outreach.repliesToAnswer, "reply", "replies")} to answer`);
      if (bits.length === 0) return "Nothing is stuck: the review queue is clear and every accepted lead has been contacted.";
      const list = bits.length === 1 ? bits[0]! : `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}`;
      return `${bits.length === 1 ? "One thing" : `${bits.length} things`}, all people rather than software: ${list}. The engine keeps finding leads either way.`;
    },
  },
  {
    intent: "leads total",
    when: /\b(how many leads|total leads|leads (do )?we have|size of (the )?(list|database))\b/i,
    answer: (s) =>
      `${s.leads.total} leads in total. ${s.leads.sourced} of those were found by the engine, and ${s.leads.withCompetitor} are tied to a named competitor.`,
  },
  {
    intent: "competitors",
    when: /\b(competitors?|brands? we search|which brands)\b/i,
    answer: (s) => `${s.sourcing.competitorsActive} competitor brands are searched every night, three ways each.`,
  },
];

/**
 * An instant answer when the question is clearly one of the usual ones. Returns null when the model
 * should handle it: a follow-up, a long or layered question, or one that matches nothing.
 */
export function fastAnswer(question: string, snapshot: Snapshot, opts: { hasHistory?: boolean } = {}): FastAnswer | null {
  const q = question.trim();
  if (!q || q.length > 140) return null;
  // Two questions in one message deserve a written answer, not a canned line.
  if ((q.match(/\?/g) ?? []).length > 1) return null;
  if (opts.hasHistory && FOLLOW_UP.test(q)) return null;
  const hits = RULES.filter((r) => r.when.test(q));
  if (hits.length === 0) return null;
  // Two topics joined by "and" is a written answer, not a canned line. One topic that happens to
  // match a broader rule as well takes the more specific rule, which is the earlier one in RULES.
  if (hits.length > 1 && /\band\b/i.test(q)) return null;
  const rule = hits[0]!;
  return { intent: rule.intent, text: rule.answer(snapshot) };
}
