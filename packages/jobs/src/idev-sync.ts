// idev-sync — the first shippable job (MASTER-PLAN §4.2). Replaces the
// client's recurring Claude Code task.
//
// Semantics (verbatim from the sync spec + review findings):
// - Pull approved roster from iDev.
// - Classify each affiliate internal/external via the config internal list;
//   anything not confidently classified goes VERBATIM into unresolved.
// - liveExternalCount = confirmed external ONLY. Never write the raw total.
//   Unresolved is tracked separately so the digest can show a range
//   (confirmed ↔ confirmed+unresolved) until the client confirms semantics.
// - FAIL LOUD: on ANY error, write nothing (lastSyncedAt untouched — staleness
//   stays visible), record a failed sync_run, alert Telegram.
// - Roster-vs-signups diff: a newly approved affiliate we have no signup row
//   for is a self-signup nobody logged → same-day attribution-triage alert.

import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@biolinx/db";
import { getRoster, idevConfigFromEnv, parseSignupDate, type IdevAffiliate } from "@biolinx/idev";
import { alert, telegramFromEnv } from "@biolinx/notify";

const PROGRAM_NAME = "Biolinx Partner Program";

export interface InternalAccountRule {
  /** Match by iDev id, exact email, or email domain — never by name pattern. */
  idevId?: number;
  email?: string;
  emailDomain?: string;
}

export function classify(
  affiliate: IdevAffiliate,
  internalRules: InternalAccountRule[],
): "internal" | "external" {
  const email = affiliate.email?.toLowerCase() ?? "";
  const domain = email.split("@")[1] ?? "";
  for (const rule of internalRules) {
    if (rule.idevId != null && rule.idevId === affiliate.id) return "internal";
    if (rule.email && rule.email.toLowerCase() === email) return "internal";
    if (rule.emailDomain && rule.emailDomain.toLowerCase() === domain) return "internal";
  }
  return "external";
}

export async function runIdevSync(db: Db = createDb()): Promise<void> {
  const telegram = telegramFromEnv();
  const startedAt = new Date();
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ job: "idev-sync", status: "running", startedAt })
    .$returningId();

  try {
    const config = idevConfigFromEnv();
    const { affiliates: roster, total, poisonedPositions } = await getRoster(config, "approved");

    // Never-guess: when the internal-accounts list has NOT been configured at
    // all, every account is unresolved (human triage) — an empty array, by
    // contrast, means "confirmed: zero internal accounts".
    const internalConfig = await db.query.config.findFirst({
      where: eq(schema.config.key, "internal_accounts"),
    });
    const internalRules = internalConfig?.value as InternalAccountRule[] | undefined;

    // Manual classifications in the admin panel override the rule list.
    const manual = new Map(
      (await db.select().from(schema.affiliates)).map((a) => [a.idevId, a] as const),
    );
    // First-ever sync imports the pre-existing roster — that's a baseline,
    // not 61 fresh self-signups; attribution alerts start from run #2.
    const baselineImport = manual.size === 0;

    let external = 0;
    let internal = 0;
    const unresolved: string[] = [];
    const now = new Date();

    // Approved records the API cannot render (poisoned rows) are still real
    // affiliates — verbatim into unresolved, never silently dropped.
    for (const pos of poisonedPositions) {
      unresolved.push(`roster position ${pos}: record unreadable via iDev API (data breaks its JSON encoder) — inspect in iDev admin`);
    }

    for (const a of roster) {
      const existing = manual.get(a.id);
      let classification: string;
      if (existing && existing.classification !== "unresolved" && existing.classifiedByUserId != null) {
        classification = existing.classification; // human decision wins
      } else if (internalRules == null || !a.email) {
        classification = "unresolved";
      } else {
        classification = classify(a, internalRules);
      }
      const signedUp = parseSignupDate(a.signup_date);

      if (classification === "external") external++;
      else if (classification === "internal") internal++;
      else unresolved.push(`${a.id} | ${a.f_name} ${a.l_name} | ${a.username} | ${a.email ?? "no email"}`);

      if (existing) {
        await db
          .update(schema.affiliates)
          .set({
            firstName: a.f_name,
            lastName: a.l_name,
            username: a.username,
            email: a.email,
            lastSeenAt: now,
            ...(signedUp ? { signedUpAt: signedUp } : {}),
            ...(existing.classifiedByUserId == null ? { classification } : {}),
          })
          .where(eq(schema.affiliates.idevId, a.id));
      } else {
        await db.insert(schema.affiliates).values({
          idevId: a.id,
          firstName: a.f_name,
          lastName: a.l_name,
          username: a.username,
          email: a.email,
          classification,
          ...(signedUp ? { signedUpAt: signedUp } : {}),
          firstSeenAt: now,
          lastSeenAt: now,
        });
        // New approved affiliate we never provisioned → attribution triage.
        const known = a.email
          ? await db.query.signups.findFirst({
              where: eq(schema.signups.emailNormalized, a.email.toLowerCase()),
            })
          : undefined;
        if (!known && !baselineImport) {
          await alert(
            telegram,
            `New approved iDev affiliate with no signup record: ${a.f_name} ${a.l_name} (${a.email ?? "no email"}). ` +
              `If a rep recruited them, fix attribution TODAY — it can be assigned by hand, it cannot be fixed if nobody knows.`,
          );
        }
      }
    }

    // Upsert Program Status by program name — never append rows.
    await db
      .insert(schema.programStatus)
      .values({
        program: PROGRAM_NAME,
        liveExternalCount: external,
        unresolvedCount: unresolved.length,
        lastSyncedAt: now,
        unresolvedAccounts: unresolved.join("\n"),
      })
      .onDuplicateKeyUpdate({
        set: {
          liveExternalCount: external,
          unresolvedCount: unresolved.length,
          lastSyncedAt: now,
          unresolvedAccounts: unresolved.join("\n"),
        },
      });

    await db
      .update(schema.syncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        detail: {
          approved: total,
          fetched: roster.length,
          poisoned: poisonedPositions.length,
          external,
          internal,
          unresolved: unresolved.length,
        },
      })
      .where(eq(schema.syncRuns.id, run!.id));

    console.log(
      `[idev-sync] ok — approved=${total} fetched=${roster.length} poisoned=${poisonedPositions.length} external=${external} internal=${internal} unresolved=${unresolved.length}`,
    );
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(schema.syncRuns)
      .set({ status: "failed", finishedAt: new Date(), detail: { error: message } })
      .where(eq(schema.syncRuns.id, run!.id));
    await alert(telegram, `idev-sync FAILED (wrote nothing, count is now stale): ${message}`);
    throw err;
  }
}

