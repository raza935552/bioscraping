// The outreach conversation behind the lead dialog: what's been sent and replied, the next message
// from the flow chart filled in for this lead, and recording each step. A person copies and sends
// every message by hand; nothing here sends anything.

import { and, asc, eq, gte, inArray } from "drizzle-orm";
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
import { handleOf } from "./sourced-details.js";

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
    const flowT = flowTemplateOf(m);
    // A DM sent earlier through Send messages counts as the first offer, so nobody sends them a second opener.
    const t: TemplateId = flowT ?? (`offer1_${variantFor(m.leadId)}` as TemplateId);
    const at = m.sentAt ?? m.createdAt;
    bucket(m.leadId).order.push({ at: new Date(at).getTime(), seq: seq++, e: { type: "sent", templateId: t, at: new Date(at) }, h: { type: "sent", at: new Date(at).toISOString(), templateId: t, label: flowT ? DEFAULT_TEMPLATES[t].label : "Earlier message (Send messages)", body: m.body, channel: m.channel, byUserId: m.sentByUserId } });
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

export function flowStepFor(
  path: OutreachPath,
  events: FlowEvent[],
  leadId: number,
  settings: OutreachSettings,
  now = new Date(),
  lead?: { status: string | null; isDead: boolean },
): FlowStep {
  // The lead row knows what the flow can't: a sign-up was recorded, they were closed, or the account is gone.
  if (lead?.status === "Signed" || lead?.status === "Signed up") return { kind: "done", outcome: "signed_up", why: "They signed up." };
  if (lead?.status === "Passed" || lead?.status === "No") return { kind: "done", outcome: "declined", why: "Closed: not a fit or they declined." };
  if (lead?.isDead) return { kind: "done", outcome: "declined", why: "The account is gone." };
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

export function lintFlowMessage(text: string, touchNumber: number, channel: "dm" | "email", lead: { geoCountry: string | null; emailProvenance: string | null }, approvedCopy = true): LintViolation[] {
  return lint(text, {
    channel,
    touchNumber,
    isPublic: false,
    audience: "prospect",
    approvedCopy,
    // A person sends email from their own inbox, one message at a time. The bulk-mail rules (unsubscribe
    // link, postal address, "a scraped address is never auto-emailed") are about automated sends and are
    // satisfied here. The non-US rule still applies, and an unknown country stays unknown, never assumed US.
    ...(channel === "email" ? { hasUnsubscribeLink: true, hasPostalAddress: true, recipientCountry: lead.geoCountry, emailProvenance: null } : {}),
  });
}

/** Placeholders the system fills; one left in a message means it isn't ready. */
export const PLACEHOLDER = /\[(curiosity gap|name|brand|first name|details link|aro details link|aro commission|aro cookie|intro)\]/i;

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
  const step = flowStepFor(path, flow.events, leadId, settings, opts.now, lead);
  const gapIndex = opts.gapIndex != null && opts.gapIndex >= 0 && opts.gapIndex < settings.gaps.length ? opts.gapIndex : gapIndexFor(leadId, settings.gaps.length);
  const messages = step.kind === "send" ? [step.templateId, ...step.alternatives].map((t) => renderFor(t, lead, brand, recruiterName, settings, gapIndex)) : [];
  return { path, qualified: isQualifiedPath(path), brand, step, history: flow.history, messages, gapIndex, gaps: settings.gaps, channels: CONTACT_CHANNELS };
}

export class FlowError extends Error {}

const CLOSED = ["Signed", "Signed up", "Passed", "No"];

/** Refuses outreach on a lead the rules keep out of reach, whatever screen the request came from. */
export function assertContactable(lead: { sourcingReview: string | null; subProfile: string | null; isDead: boolean; affiliationStatus: string | null; status: string | null }, action: "send" | "reply" | "signup"): void {
  if (lead.sourcingReview === "pending" || lead.sourcingReview === "rejected") throw new FlowError("This lead hasn't been accepted for outreach.");
  if ((lead.subProfile ?? "").trim().toUpperCase().startsWith("SP5")) throw new FlowError("Never message this person: they're already a Biolinx fan.");
  if ((lead.affiliationStatus ?? "").toLowerCase() === "our affiliate") throw new FlowError("They're already our affiliate.");
  if (action !== "signup" && lead.isDead) throw new FlowError("This account is marked as gone.");
  if (CLOSED.includes(lead.status ?? "")) throw new FlowError("This conversation is closed.");
}

/** The team's approved copy may name the commission in a first message and run long. A message still
 *  counts as their copy after small edits (a greeting, a name, another opening line) as long as every
 *  line of the template is still there; anything rewritten is checked like any other message. */
export function isApprovedWording(
  body: string,
  templateId: TemplateId,
  lead: { firstName: string | null },
  brand: string | null,
  recruiterName: string,
  settings: OutreachSettings,
): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const b = norm(body);
  for (let g = 0; g < Math.max(1, settings.gaps.length); g++) {
    const r = renderTemplate(templateId, { curiosityGap: settings.gaps[g]?.text ?? "", recruiterName, brand, creatorFirstName: lead.firstName, settings });
    if (norm(r.text) === b) return true;
    const lines = r.text
      .split("\n")
      .map(norm)
      .filter((l, i) => l && !(i === 0 && templateId.startsWith("offer")));
    if (lines.length > 0 && lines.every((l) => b.includes(l))) return true;
  }
  return false;
}

/** When to record an event: now, but always after the lead's last event (the columns keep whole seconds). */
export function eventTime(now: Date, events: FlowEvent[]): Date {
  const last = events[events.length - 1];
  const lastSecond = last ? Math.floor(last.at.getTime() / 1000) * 1000 : -Infinity;
  return Math.floor(now.getTime() / 1000) * 1000 <= lastSecond ? new Date(lastSecond + 1000) : now;
}

/** A person sent a flow message by hand. Checks the lead, the flow's next step, the linter and suppression, then records it once. */
export async function recordFlowSent(
  db: Db,
  input: { leadId: number; templateId: TemplateId; body: string; channel: ContactChannel; gapIndex: number | null; userId: number; recruiterName?: string },
  now = new Date(),
): Promise<{ messageId: number }> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, input.leadId) });
  if (!lead) throw new FlowError("lead not found");
  assertContactable(lead, "send");
  if (!(input.templateId in DEFAULT_TEMPLATES)) throw new FlowError("unknown message");
  if (!(CONTACT_CHANNELS as readonly string[]).includes(input.channel)) throw new FlowError("pick where you sent it");
  const body = input.body.trim();
  if (body.length < 5) throw new FlowError("the message is empty");
  if (PLACEHOLDER.test(body)) throw new FlowError("fill in every [placeholder] before sending");
  const competitors = await db.select().from(schema.competitors);
  const path = pathOf(lead, ratesById(competitors));
  if (!isQualifiedPath(path)) throw new FlowError("this lead doesn't qualify for outreach (not signed with a named competitor)");
  const channel = input.channel === "Email" ? "email" : "dm";
  if (channel === "email") {
    if (!lead.email) throw new FlowError("this lead has no email address");
    const suppressed = await db.query.suppressions.findFirst({ where: eq(schema.suppressions.emailNormalized, normalizeEmail(lead.email)) });
    if (suppressed) throw new FlowError("this email address opted out; never email it");
  }
  const settings = await loadOutreachSettings(db);
  // Only the message the flow expects now can be recorded: a second press of "I sent it", or an old tab,
  // would otherwise log the same message twice and push the check-in date.
  const flow = (await flowEventsByLead(db, [lead.id])).get(lead.id) ?? { events: [], history: [] };
  const step = flowStepFor(path, flow.events, lead.id, settings, now, lead);
  if (step.kind !== "send" || ![step.templateId, ...step.alternatives].includes(input.templateId)) {
    throw new FlowError(step.kind === "wait" ? "Already recorded. The next message shows when they reply or a check-in is due." : "That isn't the next message for this lead any more. Reload to see what to send.");
  }
  const brand = (lead.competitorId != null ? competitors.find((c) => c.id === lead.competitorId)?.name : null) ?? lead.otherCreatorCompany ?? null;
  const approved = isApprovedWording(body, input.templateId, lead, brand, input.recruiterName ?? "", settings);
  const touchNumber = (lead.followUpsSent ?? 0) + 1;
  const violations = lintFlowMessage(body, touchNumber, channel, lead, approved);
  if (isBlocked(violations)) throw new FlowError(`compliance: ${violations.filter((v) => v.severity === "block").map((v) => v.detail).join("; ")}`);
  const at = eventTime(now, flow.events);
  const closing = input.templateId === "reply3_referral" || input.templateId === "reply3_aro_referral";
  let messageId = 0;
  await db.transaction(async (tx) => {
    // Claim the touch number first: two presses at once can't both move follow_ups_sent from k to k+1.
    const [res] = await tx
      .update(schema.leads)
      .set({
        lastReachedOut: at,
        followUpsSent: touchNumber,
        contactChannel: input.channel,
        status: closing ? "Passed" : lead.status === "In talks" ? "In talks" : "Contacted",
        nextFollowUpDate: closing ? null : new Date(at.getTime() + settings.checkinDays * 86_400_000),
      })
      .where(and(eq(schema.leads.id, lead.id), eq(schema.leads.followUpsSent, lead.followUpsSent ?? 0)));
    if (!(res as { affectedRows?: number }).affectedRows) throw new FlowError("Already recorded. The next message shows when they reply or a check-in is due.");
    const [ins] = await tx
      .insert(schema.messages)
      .values({
        idempotencyKey: `flow:${lead.id}:${touchNumber}`,
        leadId: lead.id,
        touchNumber,
        channel,
        state: "sent",
        draftVariant: input.templateId.slice(0, 24),
        body,
        lintReport: { flowTemplate: input.templateId, gapIndex: input.gapIndex, contactChannel: input.channel, approvedCopy: approved, violations },
        approvedByUserId: input.userId,
        approvedAt: at,
        sentAt: at,
        sentByUserId: input.userId,
      })
      .$returningId();
    messageId = ins!.id;
  });
  return { messageId };
}

/** A person logged the creator's reply. */
export async function recordFlowReply(db: Db, input: { leadId: number; kind: ReplyKind; body: string; channel: string; userId: number }, now = new Date()): Promise<{ replyId: number }> {
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, input.leadId) });
  if (!lead) throw new FlowError("lead not found");
  assertContactable(lead, "reply");
  if (!REPLY_KINDS.includes(input.kind)) throw new FlowError("pick what they replied");
  const flow = (await flowEventsByLead(db, [lead.id])).get(lead.id) ?? { events: [], history: [] };
  if (!flow.events.some((e) => e.type === "sent")) throw new FlowError("Send them a message first; there's nothing for them to reply to yet.");
  const at = eventTime(now, flow.events);
  const [ins] = await db
    .insert(schema.replies)
    .values({ leadId: lead.id, channel: input.channel.slice(0, 24) || "dm", body: input.body.trim().slice(0, 5000) || null, classifiedAs: `${REPLY_PREFIX}${input.kind}`, classifierConfidence: "human", handledAt: at, handledByUserId: input.userId, receivedAt: at })
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
  assertContactable(lead, "signup");
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim();
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!firstName || !lastName) throw new FlowError("first and last name are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new FlowError("that email doesn't look right");
  if (code.length < 3 || code.length > 20) throw new FlowError("the code should be 3 to 20 letters or numbers (like JOHND10)");
  if (await db.query.signups.findFirst({ where: eq(schema.signups.leadId, lead.id) })) throw new FlowError("this lead already has a sign-up (see Signups)");
  const emailNormalized = normalizeEmail(email);
  if (await db.query.signups.findFirst({ where: eq(schema.signups.emailNormalized, emailNormalized) })) throw new FlowError("a sign-up with this email already exists (see Signups)");
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
  counts: {
    answer: number; checkin: number; new: number; waiting: number; sentToday: number; sentTodayByMe: number;
    /** First messages left out because the lead came from the imported research board, not sourcing. */
    importedNew: number;
  };
  /** The next lead to work on, or null when everything is done. */
  next: { leadId: number; bucket: WorkBucket } | null;
  waiting: Array<{ leadId: number; name: string; handle: string | null; platform: string | null; dmUrl: string | null; lastLabel: string; sentAt: string; dueAt: string }>;
}

export interface DmTarget {
  url: string;
  /** "profile": their account, where the DM button is. "search": no handle on file, a search for their name. */
  kind: "profile" | "search";
  handle: string | null;
}

/** Where to reach a lead: their profile from any handle we have (sourcing, the research board's handles,
 *  a post link), or else a search for their name on their platform. Never their website: that opened a
 *  competitor's store for research-board leads (2026-09-16). */
export function dmTargetFor(
  lead: { primaryPlatform: string | null; socialProfiles: string | null; whereFound: string | null; firstName: string | null; lastName: string | null },
  handleKeys: string[] = [],
): DmTarget | null {
  const platform = (lead.primaryPlatform ?? "").toLowerCase();
  const key = platform.includes("tiktok") ? "tiktok" : platform.includes("instagram") ? "instagram" : platform.includes("reddit") ? "reddit" : platform === "x" ? "x" : null;
  const candidates: string[] = [];
  if (key) for (const k of handleKeys) if (k.startsWith(`${key}:`)) candidates.push(k.slice(key.length + 1));
  const fromSocial = handleOf(lead.socialProfiles);
  if (fromSocial) candidates.push(fromSocial);
  const fromPost = (lead.whereFound ?? "").match(/tiktok\.com\/@([\w.\-]+)/i)?.[1];
  if (fromPost && key === "tiktok") candidates.push(fromPost);
  for (const h of candidates) {
    const url = dmLinkFor(lead.primaryPlatform, h);
    if (url) return { url, kind: "profile", handle: h };
  }
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").replace(/\(([^)]*)\)/g, " $1 ").replace(/\s+/g, " ").trim();
  if (!name || !key) return null;
  const q = encodeURIComponent(name.slice(0, 60));
  const search: Record<string, string> = {
    tiktok: `https://www.tiktok.com/search/user?q=${q}`,
    instagram: `https://www.instagram.com/explore/search/keyword/?q=${q}`,
    reddit: `https://www.reddit.com/search/?q=${q}&type=user`,
    x: `https://x.com/search?q=${q}&f=user`,
  };
  return { url: search[key]!, kind: "search", handle: null };
}

/** A link that opens the creator's profile where a DM can be sent, from platform + handle. YouTube has no DMs. */
export function dmLinkFor(platform: string | null, handle: string | null): string | null {
  const p = (platform ?? "").toLowerCase();
  const h = (handle ?? "").replace(/^@/, "").trim();
  if (!h || !/^[\w.\-]{1,60}$/.test(h)) return null;
  if (p.includes("tiktok")) return `https://www.tiktok.com/@${h}`;
  if (p.includes("instagram")) return `https://www.instagram.com/${h}/`;
  if (p.includes("reddit")) return `https://www.reddit.com/user/${h}/`;
  if (p === "x" || p.includes("twitter")) return `https://x.com/${h}`;
  return null;
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
  const handleKeys = new Map<number, string[]>();
  for (const h of await db.select({ leadId: schema.leadHandles.leadId, key: schema.leadHandles.handleKey }).from(schema.leadHandles)) handleKeys.set(h.leadId, [...(handleKeys.get(h.leadId) ?? []), h.key]);
  // Leads with a draft still open in the older Send messages queue are handled there, so nobody messages
  // them twice. (A DM already sent there counts as their first offer: see flowEventsByLead.)
  const legacy = new Set(
    (await db.select({ leadId: schema.messages.leadId }).from(schema.messages).where(inArray(schema.messages.state, ["drafted", "linted", "approved"]))).map((m) => m.leadId),
  );
  const buckets: Record<WorkBucket, Array<{ leadId: number; sortKey: number }>> = { answer: [], checkin: [], new: [] };
  const waiting: WorkQueue["waiting"] = [];
  // The queue hands out first messages to leads this engine sourced. The imported research board
  // (no sourcing profile) is a different kind of list — older, unverified, and nobody is working
  // through it — so it isn't mixed in here; those leads are still reachable from the Leads page,
  // and a conversation already under way counts wherever the lead came from (Raza, 2026-09-17).
  let importedNew = 0;
  for (const l of eligible) {
    if (legacy.has(l.id)) continue;
    const events = flows.get(l.id)?.events ?? [];
    const step = flowStepFor(pathOf(l, rates), events, l.id, settings, now, l);
    const last = events[events.length - 1];
    if (step.kind === "wait") {
      const target = dmTargetFor(l, handleKeys.get(l.id));
      waiting.push({ leadId: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", handle: target?.handle ?? null, platform: l.primaryPlatform, dmUrl: target?.url ?? null, lastLabel: DEFAULT_TEMPLATES[step.lastTemplateId].label, sentAt: step.since.toISOString(), dueAt: step.dueAt.toISOString() });
      continue;
    }
    if (step.kind === "done") continue;
    if (last?.type === "reply") buckets.answer.push({ leadId: l.id, sortKey: last.at.getTime() });
    else if (last?.type === "sent") buckets.checkin.push({ leadId: l.id, sortKey: last.at.getTime() });
    // New leads we can open straight on their profile come before the ones that need a name search.
    else if (l.sourcingProfileId != null || l.id === opts.forceLeadId) buckets.new.push({ leadId: l.id, sortKey: (dmTargetFor(l, handleKeys.get(l.id)) ?.kind === "profile" ? 0 : 1e7) + (l.conversionRank ?? 1e6) });
    else importedNew++;
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

  const today = (
    await db
      .select({ by: schema.messages.sentByUserId, report: schema.messages.lintReport })
      .from(schema.messages)
      .where(and(eq(schema.messages.state, "sent"), gte(schema.messages.sentAt, opts.dayStart)))
  ).filter((m) => (m.report as { flowTemplate?: string } | null)?.flowTemplate);
  return {
    counts: {
      answer: buckets.answer.length,
      checkin: buckets.checkin.length,
      new: buckets.new.length,
      waiting: waiting.length,
      sentToday: today.length,
      sentTodayByMe: today.filter((m) => m.by === opts.userId).length,
      importedNew,
    },
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
