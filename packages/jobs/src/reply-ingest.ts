// reply-ingest (MASTER-PLAN §4.2). Takes an inbound reply, classifies it,
// applies the cadence transition, and routes escalations. opt_out is terminal
// AND writes the suppression list immediately (CAN-SPAM SLA). Unclassifiable
// or LLM-down → human queue, never a guess.

import { eq } from "drizzle-orm";
import { normalizeEmail, transition, COLD_CADENCE, WARM_CADENCE, type CadenceState } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { classifyReply, type LlmClient, type ReplyClass } from "@biolinx/drafting";

export interface InboundReply {
  leadId: number;
  channel: string;
  body: string;
  email?: string | null;
  receivedAt?: Date;
}

export interface ReplyResult {
  replyId: number;
  classifiedAs: ReplyClass;
  escalatedTo: "diana" | "jakob" | "support" | null;
  suppressed: boolean;
  needsHuman: boolean;
}

// Escalation routing (the four nevers + objection situations). Safety/product
// questions win over money when both match; agency needs real agency context;
// no escalation on a clear rejection.
export function escalationFor(text: string, classifiedAs?: ReplyClass): "diana" | "jakob" | "support" | null {
  if (classifiedAs === "no_with_reason" || classifiedAs === "opt_out") return null;
  const t = text.toLowerCase();
  // 1. Product / dosing / safety → support (highest priority — compliance).
  if (/\bdos(e|ing|age)|side effect|is it safe|reconstitut|how (much|many) mg|\bmg\b|inject|protocol|stack/.test(t)) return "support";
  // 2. Agency / multi-client / large-list → Jakob (needs agency context).
  if (/\bagency|multi[- ]?client|client roster|manage \w+ (creators?|clients?|accounts?)|newsletter|thousands? of (subs|subscribers|followers)/.test(t)) return "jakob";
  // 3. Money → Diana.
  if (/\bcommission|payout|payment|zelle|\binvoice\b|when (do|will) .*(get )?paid|how (do|will) .*(get )?paid/.test(t)) return "diana";
  return null;
}

export async function ingestReply(
  llm: LlmClient,
  reply: InboundReply,
  db: Db = createDb(),
): Promise<ReplyResult> {
  const classifiedAs = await classifyReply(llm, reply.body);
  const escalatedTo = escalationFor(reply.body, classifiedAs);

  const [row] = await db
    .insert(schema.replies)
    .values({
      leadId: reply.leadId,
      channel: reply.channel,
      body: reply.body,
      classifiedAs,
      classifierConfidence: classifiedAs === "unclassifiable" ? "low" : "ok",
      receivedAt: reply.receivedAt ?? new Date(),
    })
    .$returningId();

  // opt_out → suppress immediately (idempotent) and mark the lead dead. When
  // there's no email (DM opt-out), suppress on a lead-keyed sentinel so the
  // stop still blocks outreach and survives cross-channel re-ingestion; the
  // lead is also marked dead so no channel re-contacts it.
  let suppressed = false;
  if (classifiedAs === "opt_out") {
    const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, reply.leadId) });
    const email = reply.email ?? lead?.email;
    const suppKey = email ? normalizeEmail(email) : `lead:${reply.leadId}`;
    await db
      .insert(schema.suppressions)
      .values({ emailNormalized: suppKey, reason: "opt_out", sourceReplyId: row!.id })
      .onDuplicateKeyUpdate({ set: { reason: "opt_out" } });
    await db.update(schema.leads).set({ isDead: true }).where(eq(schema.leads.id, reply.leadId));
    suppressed = true;
  }

  // Lead-side status + objection logging.
  const leadUpdate: Record<string, unknown> = { replyType: mapReplyType(classifiedAs) };
  if (classifiedAs === "opt_out" || classifiedAs === "no_with_reason") {
    leadUpdate.status = "Passed";
    if (classifiedAs === "no_with_reason") leadUpdate.objectionReason = "Other";
  } else if (classifiedAs === "signed_up") {
    leadUpdate.status = "Signed";
  } else if (classifiedAs === "interested" || classifiedAs === "question") {
    leadUpdate.status = "In talks";
  }
  await db.update(schema.leads).set(leadUpdate).where(eq(schema.leads.id, reply.leadId));

  const needsHuman = classifiedAs === "unclassifiable" || escalatedTo != null;
  return { replyId: row!.id, classifiedAs, escalatedTo, suppressed, needsHuman };
}

function mapReplyType(c: ReplyClass): string {
  switch (c) {
    case "interested":
    case "signed_up":
      return "Yes";
    case "no_with_reason":
    case "opt_out":
      return "No";
    case "not_now":
    case "question":
      return "Maybe";
    default:
      return "No reply";
  }
}

/** Apply a reply to a lead's follow-up cadence (pure — for the scheduler). */
export function cadenceAfterReply(
  motion: "A" | "B",
  state: CadenceState,
  classifiedAs: ReplyClass,
): CadenceState {
  const config = motion === "B" ? WARM_CADENCE : COLD_CADENCE;
  const replyClass =
    classifiedAs === "no_with_reason"
      ? "no"
      : classifiedAs === "opt_out"
        ? "opt_out"
        : classifiedAs === "signed_up"
          ? "signed_up"
          : classifiedAs === "not_now"
            ? "not_now"
            : classifiedAs === "question"
              ? "question"
              : "interested";
  return transition(config, state, { type: "reply", replyClass });
}
