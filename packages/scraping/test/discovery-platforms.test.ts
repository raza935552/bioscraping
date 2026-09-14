import { describe, expect, it, vi } from "vitest";
import { discoverInstagram } from "../src/discovery/instagram.js";
import { discoverYouTube } from "../src/discovery/youtube.js";
import { discoverReddit } from "../src/discovery/reddit.js";
import { discoverSkool } from "../src/discovery/skool.js";
import { discovererFor } from "../src/discovery/index.js";
import type { DiscoveryDeps } from "../src/discovery/types.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function deps(rows: unknown, capture?: (b: unknown) => void): DiscoveryDeps {
  const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(rows);
  });
  return { fetchImpl: fetchImpl as typeof fetch, apify: { token: "t", actors: {} }, perTerm: 30 };
}

describe("discoverInstagram", () => {
  it("hashtag → hashtags[]; plain word → keywordSearch; one hit per owner", async () => {
    let sent: unknown;
    const rows = [
      { ownerUsername: "annie", ownerFullName: "Annie A", caption: "menopause tips", url: "https://www.instagram.com/p/abc/", timestamp: "2026-09-01T00:00:00.000Z" },
      { ownerUsername: "annie", caption: "older", url: "https://www.instagram.com/p/old/", timestamp: "2026-08-01T00:00:00.000Z" },
      { error: "not found" },
    ];
    const hits = await discoverInstagram("#menopause", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ hashtags: ["menopause"], resultsLimit: 30, resultsType: "posts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      platform: "instagram",
      handle: "annie",
      profileUrl: "https://www.instagram.com/annie/",
      displayName: "Annie A",
      postUrl: "https://www.instagram.com/p/abc/",
      followers: null,
      bio: null,
    });
    await discoverInstagram("peptide coach", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ hashtags: ["peptide coach"], resultsLimit: 30, resultsType: "posts", keywordSearch: true });
  });
});

describe("discoverYouTube", () => {
  it("passes subscriber bounds and country, maps channel rows", async () => {
    let sent: unknown;
    const rows = [
      {
        channel: { handle: "@ThomasD", id: "UC1", title: "Thomas", url: "https://www.youtube.com/@ThomasD", description: "Science-based nutrition" },
        metrics: { subscribers: 3600000 },
        profile: { country: "US" },
        sourceVideo: { url: "https://www.youtube.com/watch?v=1", title: "Fasting mistakes", publishedAt: "2026-08-01T00:00:00.000Z" },
      },
    ];
    const hits = await discoverYouTube("peptides for recovery", deps(rows, (b) => (sent = b)), {
      followerMin: 2000,
      followerMax: 300000,
      country: "US",
      language: "en",
    });
    expect(sent).toEqual({
      discoveryMode: "both",
      searchTerms: ["peptides for recovery"],
      maxChannelsPerSearchTerm: 30,
      maxTotalResults: 30,
      minSubscribers: 2000,
      maxSubscribers: 300000,
      countryHint: "US",
      languageHint: "en",
    });
    expect(hits[0]).toMatchObject({
      platform: "youtube",
      handle: "thomasd",
      profileUrl: "https://www.youtube.com/@ThomasD",
      followers: 3600000,
      bio: "Science-based nutrition",
      postUrl: "https://www.youtube.com/watch?v=1",
      postText: "Fasting mistakes",
      country: "US",
    });
  });
});

describe("discoverReddit", () => {
  it("r/name → subreddits[]; top of month; author becomes the hit; followers null", async () => {
    let sent: unknown;
    const rows = [
      { author: "peptide_pete", title: "My BPC log", selftext: "long", permalink: "/r/Peptides/comments/1/my_bpc_log/", created_utc: 1756684800, subreddit: "Peptides" },
      { author: "[deleted]", title: "x", permalink: "/r/Peptides/comments/2/", created_utc: 1756684800 },
      { author: "AutoModerator", title: "rules", permalink: "/r/Peptides/comments/3/", created_utc: 1756684800 },
    ];
    const hits = await discoverReddit("r/Peptides", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ subreddits: ["Peptides"], maxPostsPerSubreddit: 30, sort: "top", timeFilter: "month", includeComments: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      platform: "reddit",
      handle: "peptide_pete",
      profileUrl: "https://www.reddit.com/user/peptide_pete/",
      followers: null,
      postUrl: "https://www.reddit.com/r/Peptides/comments/1/my_bpc_log/",
      postText: "My BPC log — long",
      postedAt: "2025-09-01T00:00:00.000Z",
    });
  });
});

describe("discoverSkool", () => {
  it("community owner is the hit; member count is reach; community url is the post", async () => {
    let sent: unknown;
    const rows = [
      {
        name: "peptide-lab",
        displayName: "Peptide Lab",
        communityUrl: "https://www.skool.com/peptide-lab",
        description: "Learn peptides",
        totalMembers: 1200,
        ownerName: "Hack Smith",
        ownerProfileUrl: "https://www.skool.com/@hack-smith",
        ownerBio: "coach",
        ownerLocation: "Austin, US",
      },
    ];
    const hits = await discoverSkool("peptides", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ searchTerms: ["peptides"], maxCommunities: 30, includeOwnerDetails: true });
    expect(hits[0]).toMatchObject({
      platform: "skool",
      handle: "hack-smith",
      profileUrl: "https://www.skool.com/@hack-smith",
      displayName: "Hack Smith",
      bio: "coach",
      followers: 1200,
      postUrl: "https://www.skool.com/peptide-lab",
      postText: "Peptide Lab — Learn peptides",
      country: "US",
    });
  });
});

describe("discovererFor", () => {
  it("returns one function per platform", () => {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "skool"] as const) expect(typeof discovererFor(p)).toBe("function");
  });
});
