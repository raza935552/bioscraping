// outreach-dispatch (MASTER-PLAN §4.2) — the core loop. Selects due leads,
// drafts + lints each message, and routes it:
//   email + CHANNEL_AUTOSEND_EMAIL=true → push to Instantly
//   otherwise                           → approval queue (state 'linted')
// Nothing is ever sent that failed the linter or hits the suppression list.
// Idempotency: one message row per (lead, touch, channel); a claimed row is
// never re-drafted.

import { and, eq } from "drizzle-orm";
import {
  hasUsableNotes,
  isConverted,
  isSp5,
  messageKey,
  normalizeEmail,
  type ContactChannel,
} from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { draftMessage, type DraftRequest, type LlmClient } from "@biolinx/drafting";
import type { LintContext } from "@biolinx/compliance";
import { maxTouchesFor, nextFollowUpDateAfterSend, type Motion } from "./cadence-dates.js";

const TERMINAL_STATUSES = ["Passed", "Signed", "No", "Signed up"];

export interface CandidateLead {
  id: number;
  isDead: boolean;
  subProfile: string | null;
  affiliationStatus: string | null;
  status: string | null;
  email: string | null;
  conversionRank: number | null;
  nextFollowUpDate: Date | string | null;
  followUpsSent: number;
  motion: string;
  personalizationNotes: string | null;
  /** Sourced leads: pending | accepted | rejected. Null for everyone else. */
  sourcingReview: string | null;
}

/** Sourced leads are invisible to outreach and research until a human accepts them. */
export function isReviewable(l: { sourcingReview: string | null }): boolean {
  return l.sourcingReview == null || l.sourcingReview === "accepted";
}

export type CandidateVerdict = "ok" | "unenriched" | "ineligible";

/** Pure eligibility check. "unenriched" is the only soft skip: the lead is
 *  fine, it just has no talking points yet. */
export function isDispatchCandidate(
  l: CandidateLead,
  o: { channel: "email" | "dm"; today: Date; openReplyLeadIds: Set<number> },
): CandidateVerdict {
  if (!isReviewable(l)) return "ineligible";
  if (l.isDead || isSp5(l.subProfile) || isConverted(l.affiliationStatus)) return "ineligible";
  if (TERMINAL_STATUSES.includes(l.status ?? "")) return "ineligible";
  if (o.channel === "email" && !l.email) return "ineligible";
  if (l.conversionRank == null) return "ineligible";
  if (o.openReplyLeadIds.has(l.id)) return "ineligible";
  if (l.nextFollowUpDate != null && new Date(l.nextFollowUpDate) > o.today) return "ineligible";
  if ((l.followUpsSent ?? 0) >= maxTouchesFor(l.motion === "B" ? "B" : "A")) return "ineligible";
  if (!hasUsableNotes(l.personalizationNotes)) return "unenriched";
  return "ok";
}

/** Lead-row update after a confirmed send: bookkeeping + next due date. */
export function touchUpdate(
  l: { motion: string },
  touchNumber: number,
  contactChannel: ContactChannel,
  now = new Date(),
  tz?: string,
): { lastReachedOut: Date; followUpsSent: number; status: string; contactChannel: ContactChannel; nextFollowUpDate: Date | null } {
  const motion: Motion = l.motion === "B" ? "B" : "A";
  return {
    lastReachedOut: now,
    followUpsSent: touchNumber,
    status: "Contacted",
    contactChannel,
    nextFollowUpDate: nextFollowUpDateAfterSend(motion, touchNumber, now, tz),
  };
}

export interface DispatchOptions {
  llm: LlmClient;
  channel: "email" | "dm";
  dailyCap?: number;
  autosend?: boolean;
  senderName?: string;
  /** CAN-SPAM footer inputs (email). */
  postalConfigured?: boolean;
  /** Pushes an approved+ready email into the ESP. */
  pushToEsp?: (row: { email: string; firstName: string | null; lastName: string | null; subject: string; body: string }) => Promise<void>;
  templateGuidance?: string;
}

export interface DispatchSummary {
  considered: number;
  drafted: number;
  blocked: number;
  queued: number;
  sent: number;
  skippedSuppressed: number;
  skippedUnenriched: number;
}

const DEFAULT_GUIDANCE =
  "Warm, specific first-touch recruiting message. Reference one real detail from the personalization notes. Offer a short conversation, easy out.";

export async function runOutreachDispatch(opts: DispatchOptions, db: Db = createDb()): Promise<DispatchSummary> {
  const cap = opts.dailyCap ?? 10;
  const summary: DispatchSummary = { considered: 0, drafted: 0, blocked: 0, queued: 0, sent: 0, skippedSuppressed: 0, skippedUnenriched: 0 };

  const startedAt = new Date();
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ job: `outreach-dispatch:${opts.channel}`, status: "running", startedAt })
    .$returningId();

  try {
    // Candidate leads: ranked, alive, not SP5/converted, not in a terminal
    // status, and (email) actually have an email address.
    const all = await db.select().from(schema.leads);
    // Leads with an unhandled inbound reply are OFF-LIMITS (replies-first rule).
    const openReplyLeadIds = new Set(
      (await db.select().from(schema.replies))
        .filter((r) => r.handledAt == null)
        .map((r) => r.leadId),
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const verdictOpts = { channel: opts.channel, today, openReplyLeadIds };
    const candidates = all
      .filter((l) => {
        const v = isDispatchCandidate(l, verdictOpts);
        if (v === "unenriched") summary.skippedUnenriched++;
        return v === "ok";
      })
      .sort((a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9));

    for (const lead of candidates) {
      if (summary.sent + summary.queued >= cap) break;
      summary.considered++;

      const touchNumber = (lead.followUpsSent ?? 0) + 1;
      const key = messageKey(String(lead.id), touchNumber, opts.channel);

      // Idempotency: skip if this touch already exists in any live state.
      const existing = await db.query.messages.findFirst({
        where: eq(schema.messages.idempotencyKey, key),
      });
      if (existing) continue;

      // Suppression gate (email) — never draft for a suppressed address.
      if (opts.channel === "email" && lead.email) {
        const suppressed = await db.query.suppressions.findFirst({
          where: eq(schema.suppressions.emailNormalized, normalizeEmail(lead.email)),
        });
        if (suppressed) {
          summary.skippedSuppressed++;
          continue;
        }
      }

      const lintCtx: LintContext = {
        channel: opts.channel,
        touchNumber,
        isPublic: false,
        audience: "prospect",
        ...(opts.channel === "email"
          ? {
              hasUnsubscribeLink: true, // Instantly appends the unsubscribe link
              hasPostalAddress: opts.postalConfigured ?? false,
              recipientCountry: lead.geoCountry ?? "US",
              emailProvenance: (lead.emailProvenance as LintContext["emailProvenance"]) ?? "client_provided",
              isSuppressed: false,
            }
          : {}),
      };

      const req: DraftRequest = {
        templateGuidance: opts.templateGuidance ?? DEFAULT_GUIDANCE,
        lead: {
          firstName: lead.firstName,
          personalizationNotes: lead.personalizationNotes,
          channel: opts.channel,
          touchNumber,
        },
        senderName: opts.senderName ?? "the team",
        variant: "curiosity",
      };

      const draft = await draftMessage(opts.llm, req, lintCtx);
      summary.drafted++;

      if (draft.status === "blocked") {
        summary.blocked++;
        await db.insert(schema.messages).values({
          idempotencyKey: key,
          leadId: lead.id,
          touchNumber,
          channel: opts.channel,
          state: "blocked",
          draftVariant: req.variant,
          subject: draft.subject,
          body: draft.body,
          lintReport: draft.lintReport,
        });
        continue;
      }

      const canAutoSend = opts.channel === "email" && opts.autosend && opts.pushToEsp && lead.email;

      // Insert the claim FIRST in a non-terminal state (unique index dedups a
      // race; a duplicate-key just means another run claimed it — skip).
      try {
        await db.insert(schema.messages).values({
          idempotencyKey: key,
          leadId: lead.id,
          touchNumber,
          channel: opts.channel,
          state: canAutoSend ? "approved" : "linted", // NOT 'sent' until the push resolves
          draftVariant: req.variant,
          subject: draft.subject,
          body: draft.body,
          lintReport: draft.lintReport,
        });
      } catch (err) {
        if (/duplicate|ER_DUP_ENTRY|1062/i.test((err as Error).message)) continue;
        throw err;
      }

      if (canAutoSend) {
        // Push to the ESP, THEN mark sent — a failed send must not record success.
        try {
          await opts.pushToEsp!({
            email: lead.email!,
            firstName: lead.firstName,
            lastName: lead.lastName,
            subject: draft.subject ?? "",
            body: draft.body ?? "",
          });
        } catch (err) {
          // Leave the row 'approved' (re-drivable) and record the failure.
          await db
            .update(schema.messages)
            .set({ lintReport: { ...(draft.lintReport as object), espError: (err as Error).message } })
            .where(eq(schema.messages.idempotencyKey, key));
          summary.blocked++;
          continue;
        }
        await db.update(schema.messages).set({ state: "sent", sentAt: new Date() }).where(eq(schema.messages.idempotencyKey, key));
        await db.update(schema.leads).set(touchUpdate(lead, touchNumber, "Email")).where(eq(schema.leads.id, lead.id));
        summary.sent++;
      } else {
        summary.queued++;
      }
    }

    await db
      .update(schema.syncRuns)
      .set({ status: "ok", finishedAt: new Date(), detail: summary })
      .where(eq(schema.syncRuns.id, run!.id));
    console.log(`[outreach-dispatch:${opts.channel}] ok — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: (err as Error).message, ...summary } })
      .where(eq(schema.syncRuns.id, run!.id));
    throw err;
  }
}

/** Approve a queued message (admin action). Marks it ready + sends if an ESP
 *  pusher is provided; otherwise the operator sends and confirms separately. */
export async function approveMessage(
  db: Db,
  messageId: number,
  approvedByUserId: number,
): Promise<void> {
  await db
    .update(schema.messages)
    .set({ state: "approved", approvedByUserId, approvedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.state, "linted")));
}

/** Mark an approved message actually sent (operator confirm for DMs, or ESP
 *  callback for email) and advance the lead's touch bookkeeping. */
export async function confirmSent(
  db: Db,
  messageId: number,
  sentByUserId: number | null,
  contactChannel: ContactChannel,
): Promise<void> {
  const msg = await db.query.messages.findFirst({ where: eq(schema.messages.id, messageId) });
  if (!msg) return;
  await db
    .update(schema.messages)
    .set({ state: "sent", sentAt: new Date(), sentByUserId })
    .where(eq(schema.messages.id, messageId));
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, msg.leadId) });
  await db
    .update(schema.leads)
    .set(touchUpdate({ motion: lead?.motion ?? "A" }, msg.touchNumber, contactChannel))
    .where(eq(schema.leads.id, msg.leadId));
}
