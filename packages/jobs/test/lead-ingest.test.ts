import { describe, expect, it } from "vitest";
import type { DiscoveryHit } from "@biolinx/scraping";
import { emptyKnown } from "@biolinx/scraping";
import { effectiveSpendCap, isDuplicateKey, parseDailyLimit, planProfile, planSearches, startOfBusinessDay, verifyReserveUsd, type ProfileRow, type VerifyFn } from "../src/lead-ingest.js";

const profile: ProfileRow = {
  id: 1,
  name: "Weight-loss TikTok",
  active: true,
  niche: "Weight-loss seeker",
  brandFit: "both",
  platforms: ["tiktok"],
  terms: { tiktok: ["#perimenopause"] },
  seedAccounts: null,
  followerMin: { tiktok: 5000 },
  followerMax: { tiktok: 500000 },
  activityDays: 30,
  countries: ["US"],
  language: "en",
  matchTerms: ["menopause"],
  excludeTerms: ["ozempic"],
  excludeHandles: [],
  dailyCap: 2,
  spendCapUsd: "2.00",
};
const hit = (handle: string, over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok",
  handle,
  profileUrl: `https://www.tiktok.com/@${handle}`,
  displayName: handle,
  bio: "menopause coach",
  followers: 40000,
  postUrl: `https://www.tiktok.com/@${handle}/video/1`,
  postText: "menopause tips",
  postedAt: "2026-09-10T00:00:00.000Z",
  country: "US",
  isRepost: null,
  term: "#perimenopause",
  ...over,
});
const verified =
  (followers: number): VerifyFn =>
  async (h) => ({
    followers,
    bio: h.bio,
    lastPostAt: "2026-09-12T00:00:00.000Z",
    isRepostRatio: 0,
    profileUrl: h.profileUrl,
    items: [{ url: `${h.profileUrl}/video/2`, text: "menopause tips", postedAt: "2026-09-12T00:00:00.000Z", likes: 10 }],
  });
const now = new Date("2026-09-14T00:00:00.000Z");

describe("planProfile", () => {
  it("filters, dedupes, verifies highest-first, scores, respects the daily cap, and explains", async () => {
    const known = emptyKnown();
    known.handles.add("tiktok:known1");
    const hits = new Map([
      [
        "#perimenopause",
        [hit("a", { followers: 10000 }), hit("b", { followers: 90000 }), hit("c", { followers: 50000 }), hit("known1"), hit("tiny", { followers: 10 }), hit("de", { country: "DE" })],
      ],
    ]);
    const { candidates, summary } = await planProfile(profile, [], hits, known, verified(60000), now);
    expect(summary).toMatchObject({
      hits: 6,
      alreadyKnown: 1,
      rejected: { followers_low: 1, country: 1, excluded_handle: 0, excluded_term: 0, followers_high: 0 },
      verified: 2,
      inserted: 2,
      stoppedBy: "cap",
    });
    expect(candidates.map((c) => c.hit.handle)).toEqual(["b", "c"]);
    expect(candidates[0]?.lead).toMatchObject({
      firstName: "b",
      primaryPlatform: "TikTok",
      socialProfiles: "TikTok @b",
      totalReach: 60000,
      reachSourceUrl: "https://www.tiktok.com/@b",
      whereFound: "https://www.tiktok.com/@b/video/1",
      niche: "Weight-loss seeker",
      brandFit: "both",
      sourcingReview: "pending",
      sourcingProfileId: 1,
      sourcingReason: "found by Weight-loss TikTok via #perimenopause",
      status: "Not contacted",
      motion: "A",
      source: "sourcing",
      affiliationStatus: "Unsigned",
    });
    expect(candidates[0]?.lead.sourcingScore).toBe(45); // reach 15 + active 15 + original 5 + on-niche 10
    expect(candidates[0]?.lead.sourcingSample).toHaveLength(2); // surfaced post + 1 verified item
    expect(candidates[0]?.enrichment?.status).toBe("sourced");
  });

  it("stops on the spend cap and reports it", async () => {
    const cheap = { ...profile, spendCapUsd: "0.01", dailyCap: 50 };
    const hits = new Map([["#perimenopause", Array.from({ length: 10 }, (_, i) => hit(`h${i}`))]]);
    const { summary } = await planProfile(cheap, [], hits, emptyKnown(), verified(60000), now);
    expect(summary.stoppedBy).toBe("spend");
    expect(summary.verified).toBe(0); // 10 discovery items cost 0.02 > cap before any read
  });

  it("competitor match sets Signed elsewhere, competitor name, and the code; code dedupes", async () => {
    const ps = { id: 9, name: "Peptide Sciences", domains: [], codePattern: null, codePrefix: "PS", commissionPct: 15 };
    const hits = new Map([["#perimenopause", [hit("x", { bio: "use code PSANN for 10% off" })]]]);
    const { candidates } = await planProfile(profile, [ps], hits, emptyKnown(), verified(60000), now);
    expect(candidates[0]?.lead).toMatchObject({ affiliationStatus: "Signed elsewhere", otherCreatorCompany: "Peptide Sciences", affiliateCode: "PSANN", currentOffer: "15%" });
    const known = emptyKnown();
    known.codes.add("psann");
    const again = await planProfile(profile, [ps], hits, known, verified(60000), now);
    expect(again.summary.alreadyKnown).toBe(1);
  });

  it("a verify failure is counted and the lead still lands with search-row data only", async () => {
    const hits = new Map([["#perimenopause", [hit("v")]]]);
    const boom: VerifyFn = async () => {
      throw new Error("actor timeout");
    };
    const { candidates, summary } = await planProfile(profile, [], hits, emptyKnown(), boom, now);
    expect(summary.verifyFailed).toBe(1);
    expect(candidates[0]?.lead.totalReach).toBeNull(); // never the search-row number
    expect(candidates[0]?.enrichment).toBeNull();
  });
});

describe("planSearches", () => {
  const base = { platforms: ["tiktok", "reddit"] as ProfileRow["platforms"], terms: { tiktok: ["#weightloss", "#glp1journey"], reddit: ["r/loseit"] }, dailyCap: 10, spendCapUsd: "1.00" };
  const competitors = [{ name: "Peptide Sciences" }, { name: "Limitless Life" }];

  it("audience terms first, competitor names after, never competitor names on Reddit", () => {
    const { run, skipped } = planSearches(base, competitors, 30);
    expect(skipped).toEqual([]);
    expect(run.map((s) => `${s.platform} ${s.term}`)).toEqual([
      "tiktok #weightloss",
      "tiktok #glp1journey",
      "tiktok Peptide Sciences",
      "tiktok Limitless Life",
      "reddit r/loseit",
    ]);
  });

  it("the spend cap gates searching and keeps a reserve for profile reads", () => {
    // $0.20 cap, 10 reads reserved ($0.05) → $0.15 for searches at $0.06 each → 2 run.
    const { run, skipped, budgetUsd } = planSearches({ ...base, spendCapUsd: "0.20" }, competitors, 30);
    expect(budgetUsd).toBe(0.15);
    expect(run.map((s) => s.term)).toEqual(["#weightloss", "#glp1journey"]);
    expect(skipped.map((s) => s.term)).toEqual(["Peptide Sciences", "Limitless Life", "r/loseit"]);
    expect(run.reduce((a, s) => a + s.estimatedCostUsd, 0) + verifyReserveUsd({ ...base, spendCapUsd: "0.20" })).toBeLessThanOrEqual(0.2);
  });

  it("the reserve never takes more than half the budget", () => {
    expect(verifyReserveUsd({ dailyCap: 500, spendCapUsd: "1.00" })).toBe(0.5);
  });

  it("dedupes a competitor name that is already an audience term", () => {
    const { run } = planSearches({ ...base, platforms: ["tiktok"], terms: { tiktok: ["#peptidesciences"] } }, competitors, 30);
    expect(run.map((s) => s.term)).toEqual(["#peptidesciences", "Limitless Life"]);
  });
});

describe("daily limit across audiences", () => {
  it("an audience gets its own cap while the day has room, the remainder once it doesn't", () => {
    expect(effectiveSpendCap(2, 10, 3)).toEqual({ capUsd: 2, limitedByDaily: false });
    expect(effectiveSpendCap(2, 10, 8.5)).toEqual({ capUsd: 1.5, limitedByDaily: true });
    expect(effectiveSpendCap(2, 10, 12)).toEqual({ capUsd: 0, limitedByDaily: true });
  });

  it("a zero cap plans no searches at all", () => {
    const { run } = planSearches({ platforms: ["tiktok"], terms: { tiktok: ["#a"] }, dailyCap: 10, spendCapUsd: 0 }, [], 30);
    expect(run).toEqual([]);
  });

  it("setting parse: blank or junk means $10, 0 is a real stop", () => {
    expect(parseDailyLimit(undefined)).toBe(10);
    expect(parseDailyLimit("")).toBe(10);
    expect(parseDailyLimit("abc")).toBe(10);
    expect(parseDailyLimit("25")).toBe(25);
    expect(parseDailyLimit("0")).toBe(0);
  });

  it("the business day starts at Los Angeles midnight", () => {
    // 2026-09-14 06:00 UTC is still 2026-09-13 in LA (PDT, UTC-7).
    expect(startOfBusinessDay(new Date("2026-09-14T06:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-09-13T07:00:00.000Z");
    expect(startOfBusinessDay(new Date("2026-12-01T20:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(startOfBusinessDay(new Date("2026-09-14T06:00:00Z"), "UTC").toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("recognizes MySQL duplicate-key errors, wrapped or not", () => {
    expect(isDuplicateKey({ code: "ER_DUP_ENTRY" })).toBe(true);
    expect(isDuplicateKey({ message: "x", cause: { errno: 1062 } })).toBe(true);
    expect(isDuplicateKey(new Error("timeout"))).toBe(false);
  });
});
