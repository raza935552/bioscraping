import { describe, expect, it } from "vitest";
import type { DiscoveryHit } from "@biolinx/scraping";
import { emptyKnown } from "@biolinx/scraping";
import { planProfile, type ProfileRow, type VerifyFn } from "../src/lead-ingest.js";

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
