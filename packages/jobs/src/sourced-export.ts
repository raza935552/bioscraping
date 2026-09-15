// CSV of sourced leads for the marketing team to check, one column per field
// of their scoring spec (AFFILIATE-PRIORITY-SCHEMA.md, 2026-09-11). Unknown
// values say so ("NOT FOUND", "not checked") instead of guessing.

import { brandFitForNiche, normalizeNiche } from "@biolinx/core";
import type { SourcedDetails } from "./sourced-details.js";

export interface ExportLead {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email?: string | null;
  primaryPlatform: string | null;
  socialProfiles: string | null;
  reachSourceUrl: string | null;
  niche: string | null;
  brandFit: string | null;
  affiliationStatus: string | null;
  otherCreatorCompany: string | null;
  affiliateCode: string | null;
  currentOffer: string | null;
  totalReach: number | null;
  lastPostAt: Date | string | null;
  doesLive: boolean | null;
  promoTrackRecord: boolean | null;
  contentOriginal: boolean | null;
  whereFound: string | null;
  sourcingScore: number | null;
  notes: string | null;
  sourcingReason: string | null;
  sourcingReview: string | null;
  sourcingRejectedReason: string | null;
  geoCountry: string | null;
  dateAdded: Date | string | null;
}

export const EXPORT_COLUMNS = [
  "Lead ID",
  "Name",
  "Handle",
  "Email (from bio)",
  "Platform",
  "Profile link",
  "Bio",
  "Niche",
  "Brand tag",
  "Affiliate type",
  "Competitor",
  "Competitor code",
  "Commission comparison",
  "Audience size",
  "Avg views (recent posts)",
  "Engagement rate",
  "Posting activity",
  "Posts in last 30 days",
  "Last post",
  "Live status",
  "Promotion track record",
  "Content originality",
  "Where found (post link)",
  "Surfaced post views",
  "Surfaced post likes",
  "Surfaced post comments",
  "Store or vendor",
  "Country",
  "Score",
  "Why this score",
  "Found by",
  "Review status",
  "Reject reason",
  "Date added",
] as const;

const day = (d: Date | string | null): string => {
  if (!d) return "";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
};

/** One lead as a row of display values, in EXPORT_COLUMNS order. */
export function exportRow(l: ExportLead, now: Date, activityDays = 30, d: SourcedDetails | null = null): string[] {
  const niche = normalizeNiche(l.niche);
  const brand = (l.brandFit ?? (niche ? brandFitForNiche(niche) : null)) === "both" ? "Both" : "Biolinx only";
  const competitor = l.affiliationStatus === "Signed elsewhere" || !!l.otherCreatorCompany;
  const pct = l.currentOffer ? Number(l.currentOffer.replace(/[^0-9.]/g, "")) : NaN;
  const commission = !competitor ? "n/a (no competitor deal found)" : Number.isFinite(pct) ? (pct < 25 ? `lower (${pct}% vs our 25% lifetime)` : `same or higher (${pct}%)`) : "unknown (competitor rate not on file)";
  let activity = "NOT FOUND";
  if (l.lastPostAt) {
    const days = (now.getTime() - new Date(l.lastPostAt).getTime()) / 86_400_000;
    if (Number.isFinite(days)) activity = days <= activityDays ? `active (${Math.round(days)}d ago)` : `dormant (${Math.round(days)}d ago)`;
  }
  const tri = (v: boolean | null, yes: string, no: string, unknown: string) => (v === true ? yes : v === false ? no : unknown);
  const n = (v: number | null | undefined) => (v == null ? "NOT FOUND" : String(v));
  const engagement = d?.engagementRate == null ? "NOT FOUND" : `${(d.engagementRate * 100).toFixed(1)}% per ${d.engagementBasis === "views" ? "view" : "follower"}`;
  const posts30 = d?.postsLast30 == null ? "NOT FOUND" : `${d.postsLast30} of last ${d.postsRead} read`;
  return [
    String(l.id),
    [l.firstName, l.lastName].filter(Boolean).join(" "),
    d?.handle ?? "",
    l.email ?? "NOT FOUND",
    l.primaryPlatform ?? "",
    l.reachSourceUrl ?? "",
    d?.bio ?? "",
    niche ?? l.niche ?? "",
    brand,
    competitor ? "competitor affiliate" : "individual creator",
    l.otherCreatorCompany ?? "",
    l.affiliateCode ?? "",
    commission,
    l.totalReach != null ? String(l.totalReach) : "NOT FOUND",
    n(d?.avgViews),
    engagement,
    activity,
    posts30,
    day(l.lastPostAt),
    tri(l.doesLive, "live seen", "checked, not live", "not checked"),
    tri(l.promoTrackRecord, "proven", "no history found", "no history found"),
    tri(l.contentOriginal, "original", "reposts only", "not checked"),
    l.whereFound ?? "",
    d?.surfaced ? n(d.surfaced.views) : "",
    d?.surfaced ? n(d.surfaced.likes) : "",
    d?.surfaced ? n(d.surfaced.comments) : "",
    d?.isStore ? "yes" : "no",
    l.geoCountry ?? "",
    l.sourcingScore != null ? String(l.sourcingScore) : "",
    (l.notes ?? "").split("\n").filter(Boolean).join("; "),
    (l.sourcingReason ?? "").replace(/^found by /, ""),
    l.sourcingReview ?? "",
    l.sourcingRejectedReason ?? "",
    day(l.dateAdded),
  ];
}

/** A CSV cell. Text starting with = + - @ (or tab/CR) is prefixed with ' so a scraped
 *  bio or caption can't run as a formula when the file is opened in Excel or Sheets. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Full CSV text with a UTF-8 byte-order mark so Excel reads emoji and accents correctly. */
export function sourcedLeadsCsv(leads: ExportLead[], now: Date = new Date(), detailsFor: (l: ExportLead) => SourcedDetails | null = () => null): string {
  const lines = [EXPORT_COLUMNS.map(csvCell).join(","), ...leads.map((l) => exportRow(l, now, 30, detailsFor(l)).map(csvCell).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
