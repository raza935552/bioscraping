import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, csvCell, exportRow, sourcedLeadsCsv, type ExportLead } from "../src/sourced-export.js";

const now = new Date("2026-09-15T12:00:00Z");
const base: ExportLead = {
  id: 438, firstName: "chaoticallycannella", lastName: null, primaryPlatform: "TikTok", socialProfiles: "TikTok @chaoticallycannella",
  reachSourceUrl: "https://www.tiktok.com/@chaoticallycannella", niche: "Women's Wellness", brandFit: null, affiliationStatus: "Unsigned",
  otherCreatorCompany: null, affiliateCode: null, currentOffer: null, totalReach: 56900, lastPostAt: "2026-09-01T00:00:00Z",
  doesLive: null, promoTrackRecord: null, contentOriginal: null, whereFound: "https://www.tiktok.com/@chaoticallycannella/video/1",
  sourcingScore: 40, notes: "verified reach 56,900 in range (+15)\nactive, posted 13d ago (+15)", sourcingReason: "found by Weight-loss seeker · TikTok + IG via #peptidesforweightloss",
  sourcingReview: "pending", sourcingRejectedReason: null, geoCountry: "US", dateAdded: "2026-09-14T13:50:00Z",
};
const col = (row: string[], name: (typeof EXPORT_COLUMNS)[number]) => row[EXPORT_COLUMNS.indexOf(name)];

describe("sourced leads export", () => {
  it("labels every spec field plainly, never guessing unknowns", () => {
    const r = exportRow(base, now);
    expect(r).toHaveLength(EXPORT_COLUMNS.length);
    expect(col(r, "Niche")).toBe("Weight-loss seeker");
    expect(col(r, "Brand tag")).toBe("Both");
    expect(col(r, "Affiliate type")).toBe("individual creator");
    expect(col(r, "Commission comparison")).toBe("n/a (no competitor deal found)");
    expect(col(r, "Audience size")).toBe("56900");
    expect(col(r, "Posting activity")).toBe("active (15d ago)");
    expect(col(r, "Live status")).toBe("not checked");
    expect(col(r, "Content originality")).toBe("not checked");
    expect(col(r, "Why this score")).toBe("verified reach 56,900 in range (+15); active, posted 13d ago (+15)");
    expect(col(r, "Found by")).toBe("Weight-loss seeker · TikTok + IG via #peptidesforweightloss");
  });

  it("competitor, commission, missing reach, dormant, Biolinx-only", () => {
    const r = exportRow({ ...base, niche: "Biohacker", affiliationStatus: "Signed elsewhere", otherCreatorCompany: "Amino Club", affiliateCode: "JACOB", currentOffer: "DISCOUNT30 (30%)", competitorRatePct: 20, outreachPath: "offer1", totalReach: null, lastPostAt: "2026-06-01T00:00:00Z" }, now);
    // The commission comes from the competitor's rate, never from the lead's discount code.
    expect(col(r, "Brand tag")).toBe("Biolinx only");
    expect(col(r, "Affiliate type")).toBe("competitor affiliate");
    expect(col(r, "Commission comparison")).toBe("lower (20% vs our 25% lifetime)");
    expect(col(r, "Outreach path")).toBe("Offer 1 · pitch our 25% for life");
    expect(col(r, "Audience size")).toBe("NOT FOUND");
    expect(col(r, "Posting activity")).toBe("dormant (107d ago)");
    expect(col(exportRow({ ...base, otherCreatorCompany: "Swiss Chems", affiliationStatus: "Signed elsewhere" }, now), "Commission comparison")).toBe("unknown (competitor rate not on file)");
  });

  it("CSV cells are quoted and formula-safe", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("-20 dormant")).toBe("'-20 dormant");
    expect(csvCell("plain")).toBe("plain");
  });

  it("file starts with a BOM and the header row", () => {
    const csv = sourcedLeadsCsv([base], now);
    expect(csv.startsWith("\uFEFFLead ID,Name,Handle,Email,Email found in,Platform")).toBe(true);
    expect(csv.trim().split("\r\n")).toHaveLength(2);
  });
});

describe("export includes the derived details", () => {
  it("fills engagement, activity, bio, surfaced stats and store flag when details are given", async () => {
    const { sourcedDetails } = await import("../src/sourced-details.js");
    const d = sourcedDetails({ ...base, sourcingSample: [{ url: base.whereFound!, views: 12000, likes: 900, comments: 60 }] }, { bio: "peptide mom", followers: 56900, items: [{ url: "https://x/1", postedAt: "2026-09-10T00:00:00Z", views: 1000, likes: 50, comments: 0 }] }, now);
    const r = exportRow(base, now, 30, d);
    expect(r).toHaveLength(EXPORT_COLUMNS.length);
    expect(col(r, "Handle")).toBe("chaoticallycannella");
    expect(col(r, "Bio")).toBe("peptide mom");
    expect(col(r, "Avg views (recent posts)")).toBe("1000");
    expect(col(r, "Engagement rate")).toBe("5.0% per view");
    expect(col(r, "Posts in last 30 days")).toBe("1 of last 1 read");
    expect(col(r, "Surfaced post views")).toBe("12000");
    expect(col(r, "Store or vendor")).toBe("no");
  });
  it("without details, derived columns say NOT FOUND instead of guessing", () => {
    const r = exportRow(base, now);
    expect(col(r, "Avg views (recent posts)")).toBe("NOT FOUND");
    expect(col(r, "Engagement rate")).toBe("NOT FOUND");
  });
});
