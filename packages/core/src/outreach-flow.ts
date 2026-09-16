// The outreach conversation from the flow chart (2026-09-16): which message goes next, given the
// lead's outreach path and what has been sent and replied so far. A person copies each message,
// sends it by hand, marks it sent, and logs the creator's reply; this decides the next message.
// Message wording lives in outreach-templates.ts and can be edited in the admin.

import type { OutreachPath } from "./outreach-path.js";

export type TemplateId =
  | "offer1_soft"
  | "offer1_direct"
  | "offer2_soft"
  | "offer2_direct"
  | "recruit_aro"
  | "reply1_signup"
  | "reply1b_aro_signup"
  | "reply2_details"
  | "reply2b_aro_details"
  | "reply3_referral"
  | "reply3_aro_referral"
  | "checkin_no_info"
  | "checkin_no_reply";

export type ReplyKind = "yes" | "tell_me_more" | "no" | "no_info";

export const REPLY_KIND_LABEL: Record<ReplyKind, string> = {
  yes: "Yes",
  tell_me_more: "Tell me more",
  no: "No",
  no_info: "Replied but no info",
};

export type FlowEvent = { type: "sent"; templateId: TemplateId; at: Date } | { type: "reply"; kind: ReplyKind; at: Date };

export interface FlowOptions {
  /** Days without a reply before a check-in is due. */
  checkinDays: number;
  /** No-reply check-ins before the lead is closed as no reply. */
  maxNoReplyCheckins: number;
  /** "soft" or "direct" for the first offer. */
  variant: "soft" | "direct";
}

export const DEFAULT_FLOW_OPTIONS: Omit<FlowOptions, "variant"> = { checkinDays: 3, maxNoReplyCheckins: 2 };

export type FlowStep =
  /** Send this message now. `alternatives` are other messages that also fit (e.g. Biolinx or Aro sign-up). */
  | { kind: "send"; templateId: TemplateId; alternatives: TemplateId[]; why: string }
  /** A message went out; nothing to send until they reply or the check-in is due. */
  | { kind: "wait"; since: Date; dueAt: Date; lastTemplateId: TemplateId; why: string }
  /** They sent their details: record the sign-up. */
  | { kind: "signup"; why: string }
  /** Nothing more to send. */
  | { kind: "done"; outcome: "not_qualified" | "declined" | "no_reply" | "signed_up"; why: string };

const SIGNUP_ASKS: TemplateId[] = ["reply1_signup", "reply1b_aro_signup"];
const CHECKINS: TemplateId[] = ["checkin_no_info", "checkin_no_reply"];

/** The last message that moved the conversation (check-ins keep the stage they followed). */
function stageOf(events: FlowEvent[]): TemplateId | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "sent" && !CHECKINS.includes(e.templateId)) return e.templateId;
  }
  return null;
}

/** What comes after a reply at a stage, per the flow chart. */
export function afterReply(stage: TemplateId, kind: ReplyKind, path: OutreachPath): FlowStep {
  const send = (templateId: TemplateId, why: string, alternatives: TemplateId[] = []): FlowStep => ({ kind: "send", templateId, alternatives, why });
  if (kind === "no_info") {
    return SIGNUP_ASKS.includes(stage) ? send("checkin_no_info", "They replied without their details.") : send("checkin_no_info", "They replied but didn't answer. Nudge them.");
  }
  switch (stage) {
    case "offer1_soft":
    case "offer1_direct":
      if (kind === "yes") return send("reply1_signup", "They said yes to Offer 1: ask for their sign-up details.");
      if (kind === "tell_me_more") return send("reply2_details", "They want to know more: send the program details.");
      return send("recruit_aro", "They said no to Offer 1: offer the recruitment commission and Aro.");
    case "offer2_soft":
    case "offer2_direct":
      if (kind === "yes") return send("reply1_signup", "They said yes to Offer 2: ask for their sign-up details.");
      if (kind === "tell_me_more") return send("reply2_details", "They want to know more: send the program details.");
      return send("reply3_referral", "They said no to Offer 2: ask for a referral and close kindly.");
    case "reply2_details":
      if (kind === "yes" || kind === "tell_me_more") return send("reply1_signup", "They're in after the details: ask for their sign-up details.");
      return path === "offer2" ? send("reply3_referral", "They said no after the details: ask for a referral.") : send("recruit_aro", "They said no after the details: offer the recruitment commission and Aro.");
    case "recruit_aro":
      if (kind === "yes") return send("reply1b_aro_signup", "They said yes: ask for their details (Aro sign-up, or Biolinx if that's what they chose).", ["reply1_signup"]);
      if (kind === "tell_me_more") return send("reply2b_aro_details", "They want to know more about Aro: send the Aro details.");
      return send("reply3_aro_referral", "They said no again: ask for a referral and close kindly.");
    case "reply2b_aro_details":
      if (kind === "yes" || kind === "tell_me_more") return send("reply1b_aro_signup", "They're in: ask for their Aro sign-up details.");
      return send("reply3_aro_referral", "They said no to Aro: ask for a referral and close kindly.");
    case "reply1_signup":
    case "reply1b_aro_signup":
      if (kind === "yes") return { kind: "signup", why: "They sent their details: record the sign-up." };
      if (kind === "tell_me_more") return send(stage === "reply1_signup" ? "reply2_details" : "reply2b_aro_details", "They have questions before signing up.");
      return send(stage === "reply1_signup" ? "reply3_referral" : "reply3_aro_referral", "They backed out: ask for a referral and close kindly.");
    case "reply3_referral":
    case "reply3_aro_referral":
      if (kind === "yes") return { kind: "signup", why: "They changed their mind: record the sign-up." };
      return { kind: "done", outcome: "declined", why: "They declined; the referral ask has been sent." };
    default:
      return { kind: "done", outcome: "declined", why: "No next message for this reply." };
  }
}

/** The next step for a lead. Events must be in time order. */
export function nextOutreachStep(path: OutreachPath, events: FlowEvent[], now: Date, opts: FlowOptions): FlowStep {
  if (path !== "offer1" && path !== "offer2") {
    if (events.length === 0) return { kind: "done", outcome: "not_qualified", why: "Not qualified under the outreach flow." };
  }
  if (events.length === 0) {
    const templateId: TemplateId = `${path === "offer2" ? "offer2" : "offer1"}_${opts.variant}`;
    const other: TemplateId = `${path === "offer2" ? "offer2" : "offer1"}_${opts.variant === "soft" ? "direct" : "soft"}`;
    return { kind: "send", templateId, alternatives: [other], why: path === "offer2" ? "First message: their competitor already pays 25%, so match it and lead with the perks." : "First message: pitch our 25% for life." };
  }
  const last = events[events.length - 1]!;
  if (last.type === "reply") {
    const stage = stageOf(events);
    if (!stage) return { kind: "done", outcome: "declined", why: "A reply was logged before any message." };
    return afterReply(stage, last.kind, path);
  }
  // Last event is a sent message: wait for a reply, or check in when it's overdue.
  if (last.templateId === "reply3_referral" || last.templateId === "reply3_aro_referral") {
    return { kind: "done", outcome: "declined", why: "The closing referral ask has been sent." };
  }
  const dueAt = new Date(last.at.getTime() + opts.checkinDays * 86_400_000);
  if (now < dueAt) return { kind: "wait", since: last.at, dueAt, lastTemplateId: last.templateId, why: "Waiting for their reply." };
  let noReplyCheckins = 0;
  for (let i = events.length - 1; i >= 0 && events[i]!.type === "sent"; i--) {
    if ((events[i] as { templateId: TemplateId }).templateId === "checkin_no_reply") noReplyCheckins++;
  }
  if (noReplyCheckins >= opts.maxNoReplyCheckins) return { kind: "done", outcome: "no_reply", why: `No reply after ${noReplyCheckins} check-ins.` };
  return { kind: "send", templateId: "checkin_no_reply", alternatives: [], why: `No reply in ${opts.checkinDays} days: check in.` };
}

/** Soft or direct for a lead, split 50/50 and stable per lead so results can be compared. */
export function variantFor(leadId: number): "soft" | "direct" {
  return leadId % 2 === 0 ? "soft" : "direct";
}
