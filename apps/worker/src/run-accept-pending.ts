// One-shot: accept every sourced lead still waiting for review, the way the Sourced page's
// "Accept selected" does it, and (with --no-cap) take the review-queue brake off sourcing.
//
// Raza, 2026-10-15: the queue had been full at 150 since 4 October, so three of the four audiences
// ended every nightly run with `stoppedBy: review_full` and only auto-accepted leads got in. His
// decision was to keep what we have, accept it, and let sourcing run daily without waiting for
// review. A blanket accept is a reviewer's call, so the sub-profile confidence is recorded as
// "bulk" rather than "human": nobody read these one by one, and anything that needs a closer look
// is still visible on the Leads page.
//
//   pnpm --filter @biolinx/worker run:accept-pending            # dry run, prints what it would do
//   pnpm --filter @biolinx/worker run:accept-pending --write
//   pnpm --filter @biolinx/worker run:accept-pending --write --no-cap

import { brandFitForNiche, loadEnv, normalizeNiche } from "@biolinx/core";
import { createDb, saveSettings, schema } from "@biolinx/db";
import { eq } from "drizzle-orm";

loadEnv();

const args = process.argv.slice(2);
const write = args.includes("--write");
const noCap = args.includes("--no-cap");
const subProfile = (args.find((a) => /^SP[1-4]$/i.test(a)) ?? "SP1").toUpperCase();
const actorUserId = Number(args.find((a) => /^\d+$/.test(a)) ?? 1);

const db = createDb();
const pending = (await db.select().from(schema.leads)).filter((l) => l.sourcingReview === "pending");

const noNiche: number[] = [];
const accepted: number[] = [];
for (const l of pending) {
  const niche = normalizeNiche(l.niche ?? "");
  if (!niche) {
    noNiche.push(l.id);
    continue;
  }
  accepted.push(l.id);
  if (!write) continue;
  // Signed elsewhere vs unsigned decides whether the outreach flow has anything to say to them.
  const affiliation = l.otherCreatorCompany || l.competitorId != null ? "Signed elsewhere" : "Unsigned";
  await db
    .update(schema.leads)
    .set({
      sourcingReview: "accepted",
      affiliationStatus: affiliation,
      subProfile,
      subProfileConfidence: "bulk",
      niche,
      brandFit: l.brandFit ?? brandFitForNiche(niche),
      enrichmentStatus: "pending",
    })
    .where(eq(schema.leads.id, l.id));
}

const withBrand = pending.filter((l) => accepted.includes(l.id) && (l.competitorId != null || !!l.otherCreatorCompany)).length;
console.log(`${pending.length} waiting for review`);
console.log(`  accept: ${accepted.length} (${withBrand} name a competitor, so the flow has a message for them)`);
console.log(`  skip:   ${noNiche.length} without a niche the engine recognises${noNiche.length ? ` (${noNiche.join(", ")})` : ""}`);

if (write) {
  await db.insert(schema.auditLog).values({
    actorUserId,
    actorJob: "accept-pending",
    action: "lead.sourcing.accept_bulk",
    subjectTable: "leads",
    detail: { ids: accepted, subProfile, confidence: "bulk", reason: "keep what we have (Raza, 2026-10-15)" },
  });
  if (noCap) {
    // Blank = no limit, so sourcing never stops on a full review queue again.
    await saveSettings(db, [{ key: "SOURCING_MAX_PENDING", value: "" }], actorUserId);
    await db.insert(schema.auditLog).values({
      actorUserId,
      actorJob: "accept-pending",
      action: "settings.save",
      subjectTable: "app_settings",
      detail: { keys: ["SOURCING_MAX_PENDING"], value: "", meaning: "no limit" },
    });
    console.log("SOURCING_MAX_PENDING cleared: sourcing no longer waits for review.");
  }
  console.log("written.");
} else {
  console.log("dry run — nothing written. Add --write (and --no-cap to clear the review-queue limit).");
}
process.exit(0);
