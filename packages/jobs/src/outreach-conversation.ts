// The outreach conversation behind the lead dialog: what's been sent and replied, the next message
// from the flow chart filled in for this lead, and recording each step. A person copies and sends
// every message by hand; nothing here sends anything.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { LlmClient } from "@biolinx/drafting";
import {
  classifyReplyKeywords,
  type ReplySuggestion,
  CONTACT_CHANNELS,
  DEFAULT_FLOW_OPTIONS,
  DEFAULT_TEMPLATES,
  gapIndexFor,
  isQualifiedPath,
  nextOutreachStep,
  normalizeEmail,
  outreachSettings,
  renderTemplate,
  variantFor,
  type ContactChannel,
  type FlowEvent,
  type FlowStep,
  type OutreachPath,
  type OutreachSettings,
  type ReplyKind,
  type TemplateId,
} from "@biolinx/core";
import { isBlocked, lint, type LintViolation } from "@biolinx/compliance";
import { schema, type Db } from "@biolinx/db";
import { pathOf, ratesById } from "./qualification.js";

export const OUTREACH_SETTINGS_KEY = "outreach_templates";
const REPLY_PREFIX = "flow_";
const REPLY_KINDS: ReplyKind[] = ["yes", "tell_me_more", "no", "no_info"];

export async function loadOutreachSettings(db: Db): Promise<OutreachSettings> {
  const row = await db.query.config.findFirst({ where: eq(schema.config.key, OUTREACH_SETTINGS_KEY) });
  return outreachSettings(row?.value);
}

export async function saveOutreachSettings(db: Db, value: unknown, userId: number | null): Promise<OutreachSettings> {
  const clean = outreachSettings(value);
  await db
    .insert(schema.config)
    .values({ key: OUTREACH_SETTINGS_KEY, value: clean, updatedByUserId: userId })
    .onDuplicateKeyUpdate({ set: { value: clean, updatedByUserId: userId } });
  return clean;
}

type MessageRow = typeof schema.messages.$inferSelect;
type ReplyRow = typeof schema.replies.$inferSelect;

export interface HistoryItem {
  type: "sent" | "reply";
  at: string;
  templateId?: TemplateId;
  label: string;
  body: string | null;
  channel: string;
  byUserId: number | null;
}

function flowTemplateOf(m: MessageRow): TemplateId | null {
  const t = (m.lintReport as { flowTemplate?: string } | null)?.flowTemplate;
  return t && t in DEFAULT_TEMPLATES ? (t as TemplateId) : null;
}

function flowReplyKind(r: ReplyRow): ReplyKind | null {
  const k = r.classifiedAs?.startsWith(REPLY_PREFIX) ? r.classifiedAs.slice(REPLY_PREFIX.length) : null;
  return k && (REPLY_KINDS as string[]).includes(k) ? (k as ReplyKind) : null;
}

/** Flow events per lead, in time order. Only messages sent through the flow and replies logged in it count. */
export async function flowEventsByLead(db: Db, leadIds?: number[]): Promise<Map<number, { events: FlowEvent[]; history: HistoryItem[] }>> {
  const msgs = await db
    .select()
    .from(schema.messages)
    .where(leadIds ? and(eq(schema.messages.state, "sent"), inArray(schema.messages.leadId, leadIds.length ? leadIds : [-1])) : eq(schema.messages.state, "sent"))
    .orderBy(asc(schema.messages.id));
  const reps = await db
    .select()
    .from(schema.replies)
    .where(leadIds ? inArray(schema.replies.leadId, leadIds.length ? leadIds : [-1]) : undefined)
    .orderBy(asc(schema.replies.id));
  const out = new Map<number, { events: FlowEvent[]; history: HistoryItem[]; order: Array<{ at: number; seq: number; e: FlowEvent; h: HistoryItem }> }>();
  const bucket = (id: number) => {
    let b = out.get(id);
    if (!b) out.set(id, (b = { events: [], history: [], order: [] }));
    return b;
  };
  let seq = 0;
  for (const m of msgs) {
    const t = flowTemplateOf(m);
    if (!t) continue;
    const at = m.sentAt ?? m.createdAt;
    bucket(m.leadId).order.push({ at: new Date(at).getTime(), seq: seq++, e: { type: "sent", templateId: t, at: new Date(at) }, h: { type: "sent", at: new Date(at).toISOString(), templateId: t, label: DEFAULT_TEMPLATES[t].label, body: m.body, channel: m.channel, byUserId: m.sentByUserId } });
  }
  for (const r of reps) {
    const k = flowReplyKind(r);
    if (!k) continue;
    bucket(r.leadId).order.push({ at: new Date(r.receivedAt).getTime(), seq: seq++, e: { type: "reply", kind: k, at: new Date(r.receivedAt) }, h: { type: "reply", at: new Date(r.receivedAt).toISOString(), label: k, body: r.body, channel: r.channel, byUserId: r.handledByUserId } });
  }
  for (const b of out.values()) {
    b.order.sort((x, y) => x.at - y.at || x.seq - y.seq);
    b.events = b.order.map((o) => o.e);
    b.history = b.order.map((o) => o.h);
  }
  return out as unknown as Map<number, { events: FlowEvent[]; history: HistoryItem[] }>;
}

export function flowStepFor(path: OutreachPath, events: FlowEvent[], leadId: number, settings: OutreachSettings, now = new Date()): FlowStep {
  return nextOutreachStep(path, events, now, { ...DEFAULT_FLOW_OPTIONS, checkinDays: settings.checkinDays, variant: variantFor(leadId) });
}

export interface RenderedMessage {
  templateId: TemplateId;
  label: string;
  when: string;
  source: "marketing" | "drafted";
  text: string;
  missing: string[];
  violations: LintViolation[];
  blocked: boolean;
}

function lintFlowMessage(text: string, touchNumber: number, channel: "dm" | "email", lead: { geoCountry: string | null; emailProvenance: string | null }): LintViolation[] {
  return lint(text, {
    channel,
    touchNumber,
    isPublic: false,
    audience: "prospect",
    approvedCopy: true,
    // A person sends email from their own inbox, one at a time: CAN-SPAM footer rules apply to bulk
    // sends. The scraped-address and non-US rules still apply.
    ...(channel === "email" ? { hasUnsubscribeLink: true, hasPostalAddress: true, recipientCountry: lead.geoCountry ?? "US", emailProvenance: null } : {}),
  });
}

export function renderFor(
  templateId: TemplateId,
  lead: { id: number; firstName: string | null; geoCountry: string | null; emailProvenance: string | null; followUpsSent: number },
  brand: string | null,
  recruiterName: string,
  settings: OutreachSettings,
  gapIndex: number | null,
): RenderedMessage {
  const gaps = settings.gaps;
  const gi = gapIndex != null && gapIndex >= 0 && gapIndex < gaps.length ? gapIndex : gapIndexFor(lead.id, gaps.length);
  const r = renderTemplate(templateId, { curiosityGap: gaps[gi]?.text ?? "", recruiterName, brand, creatorFirstName: lead.firstName, settings });
  const violations = lintFlowMessage(r.text, (lead.followUpsSent ?? 0) + 1, "dm", lead);
  const def = DEFAULT_TEMPLATES[templateId];
  return { templateId, label: def.label, when: def.when, source: settings.templates[templateId] ? "marketing" : def.source, text: r.text, missing: r.missing, violations, blocked: isBlocked(violations) || r.missing.length > 0 };
}

export interface ConversationView {
  path: OutreachPath;
  qualified: boolean;
  brand: string | null;
  step: FlowStep;
  history: HistoryItem[];
  /** The message to send now plus the alternatives the flow allows, rendered. */
  messages: RenderedMessage[];
  gapIndex: number;
  gaps: OutreachSettings["gaps"];
  channels: readonly string[];
}

export async function conversationView(db: Db, leadId: number, recruiterName: string, opts: { gapIndex?: number | null; now?: Date } = {}): Promise<ConversationView | null> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, leadId) });
  if (!lead) return null;
  const competitors = await db.select().from(schema.competitors);
  const path = pathOf(lead, ratesById(competitors));
  const brand = (lead.competitorId != null ? competitors.find((c) => c.id === lead.competitorId)?.name : null) ?? lead.otherCreatorCompany ?? null;
  const settings = await loadOutreachSettings(db);
  const flow = (await flowEventsByLead(db, [leadId])).get(leadId) ?? { events: [], history: [] };
  const step = flowStepFor(path, flow.events, leadId, settings, opts.now);
  const gapIndex = opts.gapIndex != null && opts.gapIndex >= 0 && opts.gapIndex < settings.gaps.length ? opts.gapIndex : gapIndexFor(leadId, settings.gaps.length);
  const messages = step.kind === "send" ? [step.templateId, ...step.alternatives].map((t) => renderFor(t, lead, brand, recruiterName, settings, gapIndex)) : [];
  return { path, qualified: isQualifiedPath(path), brand, step, history: flow.history, messages, gapIndex, gaps: settings.gaps, channels: CONTACT_CHANNELS };
}

export class FlowError extends Error {}

/** A person sent a flow message by hand. Checks qualification, the linter and suppression, then records it. */
export async function recordFlowSent(
  db: Db,
  input: { leadId: number; templateId: TemplateId; body: string; channel: ContactChannel; gapIndex: number | null; userId: number },
  now = new Date(),
): Promise<{ messageId: number }> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, input.leadId) });
  if (!lead) throw new FlowError("lead not found");
  if (!(input.templateId in DEFAULT_TEMPLATES)) throw new FlowError("unknown message");
  if (!(CONTACT_CHANNELS as readonly string[]).includes(input.channel)) throw new FlowError("pick where you sent it");
  const body = input.body.trim();
  if (body.length < 5) throw new FlowError("the message is empty");
  if (/\[(curiosity gap|name|brand|first name|details link|aro details link|aro commission|aro cookie|intro)\]/i.test(body)) throw new FlowError("fill in every [placeholder] before sending");
  const competitors = await db.select().from(schema.competitors);
  const path = pathOf(lead, ratesById(competitors));
  if (!isQualifiedPath(path)) throw new FlowError("this lead doesn't qualify for outreach (not signed with a named competitor)");
  const channel = input.channel === "Email" ? "email" : "dm";
  if (channel === "email") {
    if (!lead.email) throw new FlowError("this lead has no email address");
    const suppressed = await db.query.suppressions.findFirst({ where: eq(schema.suppressions.emailNormalized, normalizeEmail(lead.email)) });
    if (suppressed) throw new FlowError("this email address opted out; never email it");
  }
  const touchNumber = (lead.followUpsSent ?? 0) + 1;
  const violations = lintFlowMessage(body, touchNumber, channel, lead);
  if (isBlocked(violations)) throw new FlowError(`compliance: ${violations.filter((v) => v.severity === "block").map((v) => v.detail).join("; ")}`);
  const settings = await loadOutreachSettings(db);
  const [ins] = await db
    .insert(schema.messages)
    .values({
      idempotencyKey: `flow:${lead.id}:${touchNumber}:${now.getTime()}`,
      leadId: lead.id,
      touchNumber,
      channel,
      state: "sent",
      draftVariant: input.templateId.slice(0, 24),
      body,
      lintReport: { flowTemplate: input.templateId, gapIndex: input.gapIndex, contactChannel: input.channel, violations },
      approvedByUserId: input.userId,
      approvedAt: now,
      sentAt: now,
      sentByUserId: input.userId,
    })
    .$returningId();
  const closing = input.templateId === "reply3_referral" || input.templateId === "reply3_aro_referral";
  await db
    .update(schema.leads)
    .set({
      lastReachedOut: now,
      followUpsSent: touchNumber,
      contactChannel: input.channel,
      status: closing ? "Passed" : lead.status === "In talks" ? "In talks" : "Contacted",
      nextFollowUpDate: closing ? null : new Date(now.getTime() + settings.checkinDays * 86_400_000),
    })
    .where(eq(schema.leads.id, lead.id));
  return { messageId: ins!.id };
}

/** A person logged the creator's reply. */
export async function recordFlowReply(db: Db, input: { leadId: number; kind: ReplyKind; body: string; channel: string; userId: number }, now = new Date()): Promise<{ replyId: number }> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, input.leadId) });
  if (!lead) throw new FlowError("lead not found");
  if (!REPLY_KINDS.includes(input.kind)) throw new FlowError("pick what they replied");
  const [ins] = await db
    .insert(schema.replies)
    .values({ leadId: lead.id, channel: input.channel.slice(0, 24) || "dm", body: input.body.trim() || null, classifiedAs: `${REPLY_PREFIX}${input.kind}`, classifierConfidence: "human", handledAt: now, handledByUserId: input.userId, receivedAt: now })
    .$returningId();
  await db.update(schema.leads).set({ status: "In talks", nextFollowUpDate: null }).where(eq(schema.leads.id, lead.id));
  return { replyId: ins!.id };
}

/** They sent their details: create the sign-up, linked to the lead and the person who recruited them. */
export async function recordFlowSignup(
  db: Db,
  input: { leadId: number; firstName: string; lastName: string; email: string; code: string; userId: number; userName: string },
): Promise<{ signupId: number }> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, input.leadId) });
  if (!lead) throw new FlowError("lead not found");
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim();
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!firstName || !lastName) throw new FlowError("first and last name are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new FlowError("that email doesn't look right");
  if (code.length < 3 || code.length > 20) throw new FlowError("the code should be 3 to 20 letters or numbers (like JOHND10)");
  const emailNormalized = normalizeEmail(email);
  const existing = await db.query.signups.findFirst({ where: eq(schema.signups.emailNormalized, emailNormalized) });
  if (existing) throw new FlowError("a sign-up with this email already exists (see Signups)");
  const [ins] = await db
    .insert(schema.signups)
    .values({ leadId: lead.id, firstName, lastName, email, emailNormalized, couponWordSuggestion: code, recruitedByUserId: input.userId, recruitedByName: input.userName.slice(0, 120) })
    .$returningId();
  await db
    .update(schema.leads)
    .set({ status: "Signed", nextFollowUpDate: null, ...(lead.email ? {} : { email, emailNormalized, emailProvenance: "client_provided" }) })
    .where(eq(schema.leads.id, lead.id));
  return { signupId: ins!.id };
}

/** One-line summary for the Leads table bubble. */
export function stepSummary(step: FlowStep): { kind: FlowStep["kind"]; templateId: TemplateId | null; label: string; dueAt: string | null; outcome: string | null } {
  if (step.kind === "send") return { kind: "send", templateId: step.templateId, label: `Send: ${DEFAULT_TEMPLATES[step.templateId].label}`, dueAt: null, outcome: null };
  if (step.kind === "wait") return { kind: "wait", templateId: step.lastTemplateId, label: "Waiting for their reply", dueAt: step.dueAt.toISOString(), outcome: null };
  if (step.kind === "signup") return { kind: "signup", templateId: null, label: "Record their sign-up", dueAt: null, outcome: null };
  return { kind: "done", templateId: null, label: step.why, dueAt: null, outcome: step.outcome };
}

export type WorkBucket = "answer" | "checkin" | "new";

export interface WorkQueue {
  counts: { answer: number; checkin: number; new: number; waiting: number; sentToday: number; sentTodayByMe: number };
  /** The next lead to work on, or null when everything is done. */
  next: { leadId: number; bucket: WorkBucket } | null;
  waiting: Array<{ leadId: number; name: string; platform: string | null; lastLabel: string; sentAt: string; dueAt: string }>;
}

const CLOSED_STATUSES = ["Signed", "Passed", "No", "Signed up"];

/** The outreach person's to-do list, in the order they should work it: replies to answer, then
 *  check-ins that are due, then new leads by rank. Leads someone else has open are left out. */
export async function outreachWorkQueue(
  db: Db,
  opts: { userId: number; now?: Date; exclude?: Set<number>; dayStart: Date; forceLeadId?: number | null },
): Promise<WorkQueue> {
  const now = opts.now ?? new Date();
  const leads = await db.select().from(schema.leads);
  const rates = ratesById(await db.select().from(schema.competitors));
  const settings = await loadOutreachSettings(db);
  const eligible = leads.filter(
    (l) =>
      (l.sourcingReview == null || l.sourcingReview === "accepted") &&
      !l.isDead &&
      !(l.subProfile ?? "").toUpperCase().startsWith("SP5") &&
      !CLOSED_STATUSES.includes(l.status ?? "") &&
      isQualifiedPath(pathOf(l, rates)),
  );
  const flows = await flowEventsByLead(db, eligible.map((l) => l.id));
  const buckets: Record<WorkBucket, Array<{ leadId: number; sortKey: number }>> = { answer: [], checkin: [], new: [] };
  const waiting: WorkQueue["waiting"] = [];
  for (const l of eligible) {
    const events = flows.get(l.id)?.events ?? [];
    const step = flowStepFor(pathOf(l, rates), events, l.id, settings, now);
    const last = events[events.length - 1];
    if (step.kind === "wait") {
      waiting.push({ leadId: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", platform: l.primaryPlatform, lastLabel: DEFAULT_TEMPLATES[step.lastTemplateId].label, sentAt: step.since.toISOString(), dueAt: step.dueAt.toISOString() });
      continue;
    }
    if (step.kind === "done") continue;
    if (last?.type === "reply") buckets.answer.push({ leadId: l.id, sortKey: last.at.getTime() });
    else if (last?.type === "sent") buckets.checkin.push({ leadId: l.id, sortKey: last.at.getTime() });
    else buckets.new.push({ leadId: l.id, sortKey: l.conversionRank ?? 1e9 });
  }
  for (const b of Object.values(buckets)) b.sort((a, c) => a.sortKey - c.sortKey);
  waiting.sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  let next: WorkQueue["next"] = null;
  if (opts.forceLeadId != null) {
    for (const k of ["answer", "checkin", "new"] as WorkBucket[]) if (buckets[k].some((x) => x.leadId === opts.forceLeadId)) next = { leadId: opts.forceLeadId, bucket: k };
  }
  if (!next) {
    for (const k of ["answer", "checkin", "new"] as WorkBucket[]) {
      const hit = buckets[k].find((x) => !opts.exclude?.has(x.leadId));
      if (hit) {
        next = { leadId: hit.leadId, bucket: k };
        break;
      }
    }
  }

  const sent = await db.select({ by: schema.messages.sentByUserId, at: schema.messages.sentAt, report: schema.messages.lintReport }).from(schema.messages).where(eq(schema.messages.state, "sent"));
  const today = sent.filter((m) => m.at && new Date(m.at) >= opts.dayStart && (m.report as { flowTemplate?: string } | null)?.flowTemplate);
  return {
    counts: { answer: buckets.answer.length, checkin: buckets.checkin.length, new: buckets.new.length, waiting: waiting.length, sentToday: today.length, sentTodayByMe: today.filter((m) => m.by === opts.userId).length },
    next,
    waiting,
  };
}

/** Moves a lead out of the outreach person's way: the account is gone, or they're not a fit. */
export async function skipOutreachLead(db: Db, leadId: number, reason: "gone" | "not_fit"): Promise<void> {
  if (reason === "gone") await db.update(schema.leads).set({ isDead: true, nextFollowUpDate: null }).where(eq(schema.leads.id, leadId));
  else await db.update(schema.leads).set({ status: "Passed", nextFollowUpDate: null }).where(eq(schema.leads.id, leadId));
}

/** Setting OUTREACH_REPLY_AI: "true" = when keywords are unsure, a model reads the reply. */
export const REPLY_AI_MODEL = "claude-haiku-4-5-20251001";

/** Suggests the button for a pasted reply: keywords, then (if allowed and unsure) a small model. */
export async function suggestReplyKind(
  text: string,
  context: { lastMessageLabel: string | null },
  llm: LlmClient | null,
): Promise<ReplySuggestion & { source: "keywords" | "ai" }> {
  const byKeywords = classifyReplyKeywords(text);
  if (byKeywords.confidence === "high" || !llm || !text.trim()) return { ...byKeywords, source: "keywords" };
  try {
    const raw = await llm.complete(
      `You sort replies from social media creators to an affiliate recruiting message. Answer with JSON only: {"kind":"yes"|"tell_me_more"|"no"|"no_info","reason":"under 12 words"}.
yes = they agree, want to join, or sent sign-up details. tell_me_more = they ask a question or want details. no = they decline or aren't interested. no_info = anything else (emoji, thanks, unrelated, unclear).`,
      `The message they are replying to: ${context.lastMessageLabel ?? "a recruiting message"}\nTheir reply:\n"""${text.slice(0, 1500)}"""`,
      process.env.CLASSIFY_MODEL || REPLY_AI_MODEL,
      { maxTokens: 120 },
    );
    const m = raw.match(/\{[\s\S]*\}/);
    const j = m ? (JSON.parse(m[0]) as { kind?: string; reason?: string }) : null;
    if (j && (REPLY_KINDS as string[]).includes(j.kind ?? "")) {
      return { kind: j.kind as ReplyKind, confidence: "high", reason: String(j.reason ?? "read by AI").slice(0, 120), details: byKeywords.details, source: "ai" };
    }
  } catch {
    /* fall back to the keyword guess */
  }
  return { ...byKeywords, source: "keywords" };
}
