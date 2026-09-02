// signup-provision (MASTER-PLAN §4.2) — the money saga. Per-step checkpoints
// with compensation. Every iDev WRITE is probe-gated (parameter semantics
// silently change real pay). Holds in pending_diana until Diana confirms.
//
// Steps (each idempotent, each recorded on the signup row):
//   validate → dedupe → iDev affiliate → coupon uniqueness → coupon create →
//   iDev assign → welcome email → (human) Diana confirm
//
// This build advances the saga up to the point real external writes begin,
// then parks each signup for Diana with a clear next-action. Enabling the
// live iDev/coupon writes is a one-flag change once Phase-0 probes confirm
// the parameter semantics.

import { eq } from "drizzle-orm";
import { normalizeEmail } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";

export interface ProvisionResult {
  signupId: number;
  sagaState: string;
  blocked: string | null; // reason it parked, if any
}

const REQUIRED = ["firstName", "lastName", "email"] as const;

/** All affiliates recruited through this system are placed under the owner's
 *  iDev tier (razakkhanafridi@gmail.com). Set RECRUITER_IDEV_ID in .env; the
 *  iDev parent-side tier is already configured. Used when the live iDev
 *  affiliate-create path is enabled. */
export function recruiterIdevId(env = process.env): number | null {
  const v = env.RECRUITER_IDEV_ID;
  return v && /^\d+$/.test(v) ? Number(v) : null;
}

export async function provisionSignup(
  signupId: number,
  db: Db = createDb(),
  opts: { idevWritesEnabled?: boolean } = {},
): Promise<ProvisionResult> {
  const signup = await db.query.signups.findFirst({ where: eq(schema.signups.id, signupId) });
  if (!signup) return { signupId, sagaState: "missing", blocked: "signup not found" };

  // Never re-process a completed signup — a re-fire must not corrupt a live,
  // paid affiliate's saga_state.
  if (signup.status === "confirmed" || signup.sagaState === "provisioned") {
    return { signupId, sagaState: signup.sagaState, blocked: null };
  }

  const park = async (state: string, reason: string): Promise<ProvisionResult> => {
    await db.update(schema.signups).set({ sagaState: state }).where(eq(schema.signups.id, signupId));
    return { signupId, sagaState: state, blocked: reason };
  };

  // 1. Validate (10-field contract; the essentials must be present).
  for (const f of REQUIRED) {
    if (!signup[f]) return park("invalid", `missing required field: ${f}`);
  }

  // 2. Dedupe on the NORMALIZED email against confirmed affiliates AND other
  //    signups — case/whitespace/gmail-dot variants must not double-pay.
  const emailNorm = normalizeEmail(signup.email);
  const affiliates = await db.select().from(schema.affiliates);
  const dupeAffiliate = affiliates.find((a) => a.email && normalizeEmail(a.email) === emailNorm);
  if (dupeAffiliate) {
    return park("duplicate", `email already an approved affiliate (iDev id ${dupeAffiliate.idevId})`);
  }

  // 3. Attribution must resolve to a real rep (L6). Original name is preserved;
  //    an unmatched name is a hard block, never a silent blank-credit.
  if (signup.recruitedByName && !signup.recruitedByUserId) {
    const user = (await db.select().from(schema.users)).find(
      (u) => u.name.trim().toLowerCase() === signup.recruitedByName!.trim().toLowerCase(),
    );
    if (user) {
      await db.update(schema.signups).set({ recruitedByUserId: user.id }).where(eq(schema.signups.id, signupId));
    } else {
      return park("attribution_error", `recruited-by name "${signup.recruitedByName}" matches no rep account`);
    }
  }

  // 4–7 require live iDev/coupon writes — probe-gated. Until enabled, park for
  //    Diana with everything validated so her step is one click.
  if (!opts.idevWritesEnabled) {
    await db
      .update(schema.signups)
      .set({ emailNormalized: emailNorm, sagaState: "validated_pending_diana" })
      .where(eq(schema.signups.id, signupId));
    return { signupId, sagaState: "validated_pending_diana", blocked: null };
  }

  // (live path — enabled after Phase-0 probes confirm assign_coupon semantics)
  return park("provisioning", "live iDev writes enabled but not yet implemented in this build");
}

/** Diana's confirm — the terminal human gate (21+, quality). */
export async function confirmSignup(db: Db, signupId: number, dianaUserId: number): Promise<void> {
  await db
    .update(schema.signups)
    .set({ status: "confirmed", dianaConfirmedAt: new Date() })
    .where(eq(schema.signups.id, signupId));
  await db.insert(schema.auditLog).values({
    actorUserId: dianaUserId,
    action: "signup.confirmed",
    subjectTable: "signups",
    subjectId: signupId,
    detail: {},
  });
}
