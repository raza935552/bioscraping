// Airtable → MySQL import (the one-time migration, plan §2.3).
//   pnpm migrate:import [-- --dir migration/out]
// Reads the JSON files produced by export-airtable.ts and upserts by
// airtable record id (safe to re-run). D8 enum mapping applied ("Said no" →
// "No"). Rep/owner names are matched to invited users by exact name; the
// original string is always preserved for fidelity.
//
// Field map source: airtable/schema.json in the spec pack (34 fields,
// verified against the live base metadata export at run time).

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { loadEnv, normalizeEmail } from "@biolinx/core";
import { connect, schema } from "@biolinx/db";

loadEnv();

interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

const args = process.argv.slice(2);
const dirFlag = args.indexOf("--dir");
const DIR = dirFlag >= 0 ? path.resolve(args[dirFlag + 1] ?? "") : path.join(import.meta.dirname, "out");

const { db } = connect();

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dateStr = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** D8: live-form enum wins; map the spec doc's variant. */
const mapStatus = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  return s.toLowerCase() === "said no" ? "No" : s;
};

async function loadTable(label: string, tableName: string): Promise<AirtableRecord[]> {
  const files = await readdir(DIR).catch(() => [] as string[]);
  const wanted = `${label}.${tableName.replace(/\W+/g, "_")}.json`;
  const file = files.find((f) => f === wanted);
  if (!file) return [];
  return JSON.parse(await readFile(path.join(DIR, file), "utf8")) as AirtableRecord[];
}

async function userIdByName(name: string | null): Promise<number | null> {
  if (!name) return null;
  const users = await db.select().from(schema.users);
  const hit = users.find((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase());
  return hit?.id ?? null;
}

// ── Leads (Affiliate Outreach Board) ────────────────────────────────────

async function importLeads(): Promise<number> {
  const records = await loadTable("outreach", "Affiliate Outreach Board");
  let n = 0;
  for (const r of records) {
    const f = r.fields;
    const email = str(f["Email"]);
    const ownerName = str(f["Owner"]);
    const ownerUserId = await userIdByName(ownerName);
    const notes = [str(f["Notes"]), ownerName && !ownerUserId ? `Owner (unmatched): ${ownerName}` : null]
      .filter(Boolean)
      .join("\n");
    const row = {
      airtableId: r.id,
      firstName: str(f["First Name"]),
      lastName: str(f["Last Name"]),
      email,
      emailNormalized: email ? normalizeEmail(email) : null,
      emailProvenance: email ? ("client_provided" as const) : null,
      phone: str(f["Phone"]),
      socialProfiles: str(f["Social Profiles"]),
      websiteUrl: str(f["Website URL"]),
      whereFound: str(f["Where Found"]),
      whatTheyPromoted: str(f["What They Promoted"]),
      otherCreatorCompany: str(f["Other Creator/Company"]),
      firstReachedOut: dateStr(f["First Reached Out"]),
      lastReachedOut: dateStr(f["Last Reached Out"]),
      followUpsSent: num(f["Follow-ups Sent"]) ?? 0,
      niche: str(f["Niche"]),
      primaryPlatform: str(f["Primary Platform"]),
      totalReach: num(f["Total Reach"]), // NULL stays NULL — blank is a sentinel
      affiliationStatus: str(f["Affiliation Status"]),
      currentOffer: str(f["Current Offer"]),
      entryTier: str(f["Entry Tier"]),
      pitch: str(f["Pitch"]),
      status: mapStatus(f["Status"]),
      ownerUserId,
      nextFollowUpDate: dateStr(f["Next Follow-up Date"]),
      replyType: str(f["Reply Type"]),
      source: str(f["Source"]),
      dateAdded: dateStr(f["Date Added"]),
      notes: notes || null,
      conversionRank: num(f["Conversion Rank"]),
      subProfile: str(f["Sub-Profile"]),
      personalizationNotes: str(f["Personalization Notes"]),
      objectionReason: str(f["Objection Reason"]),
      escalationAction: str(f["Escalation Action"]),
      contactChannel: str(f["Contact Channel"]),
      motion: "A" as const,
    };
    const existing = await db.query.leads.findFirst({ where: eq(schema.leads.airtableId, r.id) });
    if (existing) await db.update(schema.leads).set(row).where(eq(schema.leads.id, existing.id));
    else await db.insert(schema.leads).values(row);
    n++;
  }
  return n;
}

// ── Outreach Log (Motion B) — accepts both live-form and spec field names ──

async function importOutreachLog(label: string): Promise<number> {
  const records = await loadTable(label, "Outreach Log");
  let n = 0;
  for (const r of records) {
    const f = r.fields;
    const repName = str(f["Recruited by"]) ?? str(f["Rep"]);
    const row = {
      airtableId: r.id,
      repName,
      repUserId: await userIdByName(repName),
      prospectName: str(f["Name"]) ?? str(f["Prospect"]) ?? "(unnamed)",
      aboutThem: str(f["About them"]),
      channel: str(f["Channel"]),
      whatHappened: str(f["What happened"]),
      status: mapStatus(f["Status"]) ?? "Reached out",
      firstMessageDate: dateStr(f["Date"]) ?? dateStr(f["First message date"]),
      lastTouch: dateStr(f["Last touch"]) ?? dateStr(f["Date"]),
      followUpCount: num(f["Follow-up count"]) ?? 0,
      nextFollowUpDue: dateStr(f["Follow up date"]) ?? dateStr(f["Next follow-up due"]),
    };
    const existing = await db.query.outreachLog.findFirst({ where: eq(schema.outreachLog.airtableId, r.id) });
    if (existing) await db.update(schema.outreachLog).set(row).where(eq(schema.outreachLog.id, existing.id));
    else await db.insert(schema.outreachLog).values(row);
    n++;
  }
  return n;
}

// ── Signup Queue ────────────────────────────────────────────────────────

async function importSignups(label: string): Promise<number> {
  const records = await loadTable(label, "Signup Queue");
  let n = 0;
  for (const r of records) {
    const f = r.fields;
    const email = str(f["Email"]);
    if (!email) continue; // unusable without an email (unique key)
    const recruitedByName = str(f["Recruited by"]);
    const row = {
      airtableId: r.id,
      emailNormalized: normalizeEmail(email),
      email,
      firstName: str(f["First name"]) ?? str(f["Name"])?.split(" ")[0] ?? "",
      lastName: str(f["Last name"]) ?? "",
      streetAddress: str(f["Street address"]) ?? str(f["Address"]),
      city: str(f["City"]),
      state: str(f["State"]),
      zip: str(f["Zip"]),
      country: str(f["Country"]),
      phone: str(f["Phone"]),
      website: str(f["Website"]),
      couponWordSuggestion: str(f["Coupon code word"]) ?? str(f["Coupon word suggestion"]),
      recruitedByName,
      recruitedByUserId: await userIdByName(recruitedByName),
      status: (str(f["Status"]) ?? "Pending Diana").toLowerCase().replace(/\s+/g, "_"),
    };
    const existing = await db.query.signups.findFirst({
      where: eq(schema.signups.emailNormalized, row.emailNormalized),
    });
    if (existing) await db.update(schema.signups).set(row).where(eq(schema.signups.id, existing.id));
    else await db.insert(schema.signups).values(row);
    n++;
  }
  return n;
}

// ── Gaps ────────────────────────────────────────────────────────────────

async function importGaps(label: string): Promise<number> {
  const records = await loadTable(label, "Gaps");
  let n = 0;
  for (const r of records) {
    const f = r.fields;
    const question = str(f["Question"]);
    if (!question) continue;
    const askedByName = str(f["Asked by"]);
    const row = {
      airtableId: r.id,
      question,
      askedByName,
      askedByUserId: await userIdByName(askedByName),
      context: str(f["Context"]),
      status: (str(f["Status"]) ?? "open").toLowerCase(),
      answer: str(f["Answer"]),
    };
    const existing = await db.query.gaps.findFirst({ where: eq(schema.gaps.airtableId, r.id) });
    if (existing) await db.update(schema.gaps).set(row).where(eq(schema.gaps.id, existing.id));
    else await db.insert(schema.gaps).values(row);
    n++;
  }
  return n;
}

// ── Run ─────────────────────────────────────────────────────────────────

console.log(`Importing from ${DIR}`);
const leads = await importLeads();
// Both partner bases hold data in practice (live export 2026-09-01: live has
// signups+gaps, spec has outreach rows) — import BOTH; airtableId upserts
// keep records distinct and re-runs idempotent.
let outreach = 0;
let signups = 0;
let gapsN = 0;
for (const label of ["partnerLive", "partnerSpec"]) {
  outreach += await importOutreachLog(label);
  signups += await importSignups(label);
  gapsN += await importGaps(label);
}
console.log(`done — leads=${leads} outreach_log=${outreach} signups=${signups} gaps=${gapsN}`);
console.log("next: run rank-recompute, then spot-check counts against Airtable before cutover.");
process.exit(0);
