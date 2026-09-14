import { describe, expect, it } from "vitest";
import { handleOf, sourcedDetails, type DetailLead } from "../src/sourced-details.js";

const now = new Date("2026-09-15T12:00:00Z");
const lead: DetailLead = {
  socialProfiles: "TikTok @chaoticallycannella",
  niche: "Women's Wellness",
  totalReach: 56900,
  whereFound: "https://www.tiktok.com/@c/video/1",
  sourcingReason: "found by Weight-loss seeker · TikTok + IG via #peptidesforweightloss",
  sourcingSample: [{ url: "https://www.tiktok.com/@c/video/1", text: "surfaced", postedAt: "2026-08-01T00:00:00Z", views: 12000, likes: 900, comments: 60 }],
  lastPostAt: "2026-09-12T00:00:00Z",
};

describe("sourcedDetails", () => {
  it("computes engagement per view, activity, surfaced stats, audience and term", () => {
    const d = sourcedDetails(lead, {
      bio: "mom of 3 · peptide journey",
      followers: 56900,
      items: [
        { url: "https://www.tiktok.com/@c/video/9", postedAt: "2026-09-12T00:00:00Z", views: 10000, likes: 500, comments: 0 },
        { url: "https://www.tiktok.com/@c/video/8", postedAt: "2026-09-01T00:00:00Z", views: 30000, likes: 2400, comments: 600 },
        { url: "https://www.tiktok.com/@c/video/7", postedAt: "2026-07-01T00:00:00Z", views: 20000, likes: 1000, comments: 0 },
      ],
    }, now);
    expect(d).toMatchObject({
      handle: "chaoticallycannella",
      niche: "Weight-loss seeker",
      bio: "mom of 3 · peptide journey",
      avgViews: 20000,
      engagementBasis: "views",
      postsLast30: 2,
      postsRead: 3,
      surfaced: { url: "https://www.tiktok.com/@c/video/1", views: 12000, likes: 900, comments: 60 },
      isStore: false,
      audience: "Weight-loss seeker · TikTok + IG",
      term: "#peptidesforweightloss",
      daysSinceLastPost: 3,
    });
    expect(d.engagementRate).toBeCloseTo((0.05 + 0.1 + 0.05) / 3, 4);
  });

  it("falls back to engagement per follower when posts have no views (Instagram photos)", () => {
    const d = sourcedDetails({ ...lead, socialProfiles: "IG @shop.peptides", sourcingSample: [] }, {
      bio: "Order now — free shipping", followers: 10000,
      items: [{ url: "https://instagram.com/p/1", likes: 300, comments: 20 }, { url: "https://instagram.com/p/2", likes: 100, comments: 0 }],
    }, now);
    expect(d.engagementBasis).toBe("followers");
    expect(d.engagementRate).toBe(0.021);
    expect(d.avgViews).toBeNull();
    expect(d.postsLast30).toBeNull(); // no dates, so unknown, not zero
    expect(d.isStore).toBe(true);
  });

  it("unknowns stay null without a profile read", () => {
    const d = sourcedDetails({ ...lead, sourcingSample: [{ url: "https://x.com/1" }], sourcingReason: null, lastPostAt: null, totalReach: null }, null, now);
    expect(d).toMatchObject({ avgViews: null, engagementRate: null, postsLast30: null, bio: null, audience: null, term: null, daysSinceLastPost: null });
    expect(d.surfaced).toEqual({ url: "https://www.tiktok.com/@c/video/1", views: null, likes: null, comments: null });
  });

  it("reads handles from each platform's social_profiles format", () => {
    expect(handleOf("TikTok @kit4less.com")).toBe("kit4less.com");
    expect(handleOf("Reddit u/Vegetable-Today")).toBe("Vegetable-Today");
    expect(handleOf(null)).toBeNull();
  });
});
