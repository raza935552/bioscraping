import { describe, expect, it, vi } from "vitest";
import { fetchTikTok } from "../src/fetchers/tiktok.js";
import { fetchInstagram } from "../src/fetchers/instagram.js";
import { fetchYouTube } from "../src/fetchers/youtube.js";
import { fetchReddit } from "../src/fetchers/reddit.js";
import { fetchX } from "../src/fetchers/x.js";
import type { FetchDeps } from "../src/types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deps(items: unknown, capture?: (body: unknown) => void): FetchDeps {
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(items);
  });
  return {
    fetchImpl: fetchImpl as typeof fetch,
    apify: {
      token: "t",
      actors: {
        tiktok: "clockworks/tiktok-profile-scraper",
        instagram: "apify/instagram-profile-scraper",
        youtube: "streamers/youtube-channel-scraper",
        reddit: "harshmaur/reddit-user-scraper",
        x: "apidojo/twitter-profile-scraper",
      },
    },
    maxItems: 12,
  };
}

describe("fetchTikTok", () => {
  it("maps videos to items and authorMeta to profile fields", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          text: "what I eat in a day pregnant",
          webVideoUrl: "https://www.tiktok.com/@maryanadvorska/video/1",
          createTimeISO: "2026-08-01T10:00:00.000Z",
          diggCount: 500,
          playCount: 12000,
          commentCount: 40,
          authorMeta: {
            name: "maryanadvorska",
            nickName: "Maryana",
            signature: "first time mom - PCOS",
            fans: 10800,
            profileUrl: "https://www.tiktok.com/@maryanadvorska",
          },
        },
        {
          text: "second",
          webVideoUrl: "https://www.tiktok.com/@maryanadvorska/video/2",
          createTimeISO: "2026-07-01T10:00:00.000Z",
          authorMeta: { name: "maryanadvorska", fans: 10800 },
        },
      ],
      (b) => (sent = b),
    );
    const b = await fetchTikTok({ platform: "tiktok", handle: "maryanadvorska", url: "https://www.tiktok.com/@maryanadvorska" }, d);
    expect(sent).toEqual({ profiles: ["maryanadvorska"], resultsPerPage: 12, profileScrapeSections: ["videos"], profileSorting: "latest" });
    expect(b.platform).toBe("tiktok");
    expect(b.displayName).toBe("Maryana");
    expect(b.bio).toBe("first time mom - PCOS");
    expect(b.followers).toBe(10800);
    expect(b.items).toHaveLength(2);
    expect(b.items[0]).toEqual({
      url: "https://www.tiktok.com/@maryanadvorska/video/1",
      text: "what I eat in a day pregnant",
      postedAt: "2026-08-01T10:00:00.000Z",
      likes: 500,
      views: 12000,
      comments: 40,
    });
  });

  it("returns an empty bundle (not an error) when the actor reports the profile missing", async () => {
    const d = deps([{ error: "not_found", errorCode: "not_found", input: "ghost" }]);
    const b = await fetchTikTok({ platform: "tiktok", handle: "ghost", url: "https://www.tiktok.com/@ghost" }, d);
    expect(b.items).toEqual([]);
  });

  it("drops items with empty text and caps at maxItems", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      text: i === 0 ? "" : `post ${i}`,
      webVideoUrl: `https://t/${i}`,
      authorMeta: { name: "a" },
    }));
    const b = await fetchTikTok({ platform: "tiktok", handle: "a", url: "https://www.tiktok.com/@a" }, deps(many));
    expect(b.items).toHaveLength(12);
    expect(b.items[0]?.text).toBe("post 1");
  });
});

describe("fetchInstagram", () => {
  it("maps one profile row with latestPosts", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          username: "annie",
          fullName: "Annie August",
          biography: "NP · hormones",
          followersCount: 42000,
          url: "https://www.instagram.com/annie/",
          latestPosts: [
            { caption: "The exact list I pull…", url: "https://www.instagram.com/p/abc/", timestamp: "2026-08-20T00:00:00.000Z", likesCount: 900, commentsCount: 12 },
          ],
        },
      ],
      (b) => (sent = b),
    );
    const b = await fetchInstagram({ platform: "instagram", handle: "annie", url: "https://www.instagram.com/annie/" }, d);
    expect(sent).toEqual({ usernames: ["annie"] });
    expect(b.displayName).toBe("Annie August");
    expect(b.bio).toBe("NP · hormones");
    expect(b.followers).toBe(42000);
    expect(b.items).toEqual([
      { url: "https://www.instagram.com/p/abc/", text: "The exact list I pull…", postedAt: "2026-08-20T00:00:00.000Z", likes: 900, comments: 12 },
    ]);
  });

  it("returns an empty bundle for a private or missing account", async () => {
    const d = deps([{ username: "x", private: true, latestPosts: [] }]);
    const b = await fetchInstagram({ platform: "instagram", handle: "x", url: "https://www.instagram.com/x/" }, d);
    expect(b.items).toEqual([]);
    const gone = await fetchInstagram(
      { platform: "instagram", handle: "x", url: "u" },
      deps([{ error: "not found", errorDescription: "Page not found" }]),
    );
    expect(gone.items).toEqual([]);
  });
});

describe("fetchYouTube", () => {
  it("maps videos and channel info; sends startUrls with maxResults", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          title: "Fasting mistakes",
          url: "https://www.youtube.com/watch?v=1",
          date: "2026-08-01T00:00:00.000Z",
          viewCount: 1500,
          channelName: "Thomas",
          channelDescription: "Science-based nutrition",
          numberOfSubscribers: 3600000,
          channelUrl: "https://www.youtube.com/@ThomasDeLauerOfficial",
        },
      ],
      (b) => (sent = b),
    );
    const b = await fetchYouTube(
      { platform: "youtube", handle: "ThomasDeLauerOfficial", url: "https://www.youtube.com/@ThomasDeLauerOfficial" },
      d,
    );
    expect(sent).toEqual({
      startUrls: [{ url: "https://www.youtube.com/@ThomasDeLauerOfficial" }],
      maxResults: 12,
      maxResultsShorts: 0,
      maxResultStreams: 0,
      sortVideosBy: "NEWEST",
    });
    expect(b.displayName).toBe("Thomas");
    expect(b.followers).toBe(3600000);
    expect(b.items).toEqual([{ url: "https://www.youtube.com/watch?v=1", text: "Fasting mistakes", postedAt: "2026-08-01T00:00:00.000Z", views: 1500 }]);
  });
});

describe("fetchReddit", () => {
  it("keeps posts and comments, reads profile from the user row", async () => {
    let sent: unknown;
    const d = deps(
      [
        { dataType: "user", username: "pete", profileDescription: "peptide nerd", followersCount: 12, profileUrl: "https://www.reddit.com/user/pete/" },
        { dataType: "post", title: "My BPC experience", body: "long story", postUrl: "https://www.reddit.com/r/x/comments/1/", createdAt: "2026-08-01T00:00:00.000Z", score: 33, numComments: 4 },
        { dataType: "comment", body: "agreed, purity matters", postUrl: "https://www.reddit.com/r/x/comments/2/c1/", createdAt: "2026-08-02T00:00:00.000Z" },
      ],
      (b) => (sent = b),
    );
    const b = await fetchReddit({ platform: "reddit", handle: "pete", url: "https://www.reddit.com/user/pete/" }, d);
    expect(sent).toEqual({ usernames: ["https://www.reddit.com/user/pete/"], maxPostsCount: 8, maxCommentsCount: 8, includeNSFW: false });
    expect(b.bio).toBe("peptide nerd");
    expect(b.items).toEqual([
      { url: "https://www.reddit.com/r/x/comments/1/", text: "My BPC experience — long story", postedAt: "2026-08-01T00:00:00.000Z", likes: 33, comments: 4 },
      { url: "https://www.reddit.com/r/x/comments/2/c1/", text: "agreed, purity matters", postedAt: "2026-08-02T00:00:00.000Z" },
    ]);
  });
});

describe("fetchX", () => {
  it("maps tweets and author; sends twitterHandles with maxItems", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          fullText: "Sleep is the cheapest nootropic",
          url: "https://x.com/joe/status/1",
          createdAt: "Mon Aug 04 12:00:00 +0000 2026",
          author: { userName: "joe", name: "Joe", description: "biohacker", followers: 900, url: "https://x.com/joe" },
        },
      ],
      (b) => (sent = b),
    );
    const b = await fetchX({ platform: "x", handle: "joe", url: "https://x.com/joe" }, d);
    expect(sent).toEqual({ twitterHandles: ["joe"], maxItems: 12, includeNativeRetweets: false });
    expect(b.displayName).toBe("Joe");
    expect(b.followers).toBe(900);
    expect(b.items[0]?.text).toBe("Sleep is the cheapest nootropic");
    expect(b.items[0]?.postedAt).toBe("2026-08-04T12:00:00.000Z");
  });
});

describe("live output formats (2026-09-14)", () => {
  it("YouTube relative upload dates parse", async () => {
    const { relativeAgo, toIso } = await import("../src/fetchers/shared.js");
    const now = new Date("2026-09-14T12:00:00Z");
    expect(relativeAgo("5d ago", now)).toBe("2026-09-09T12:00:00.000Z");
    expect(relativeAgo("12 days ago", now)).toBe("2026-09-02T12:00:00.000Z");
    expect(relativeAgo("3 weeks ago", now)).toBe("2026-08-24T12:00:00.000Z");
    expect(relativeAgo("Streamed 2 months ago", now)).toBe("2026-07-16T12:00:00.000Z");
    expect(relativeAgo("1 year ago", now)).toBe("2025-09-14T12:00:00.000Z");
    expect(relativeAgo("yesterday", now)).toBe("2026-09-13T12:00:00.000Z");
    expect(relativeAgo("Feb 6, 2019", now)).toBeNull();
    expect(toIso("5d ago", now)).toBe("2026-09-09T12:00:00.000Z");
    expect(toIso("2026-08-01T00:00:00.000Z")).toBe("2026-08-01T00:00:00.000Z");
  });

  it("Reddit user scraper: user_profile rows, comment dates, exact-case URL as input", async () => {
    let sent: any;
    const rows = [
      { dataType: "user_profile", username: "Vegetable-Today", bio: "I have tattoos and I like cheese.", profileDescription: "", followersCount: 0, profileUrl: "https://www.reddit.com/user/Vegetable-Today/" },
      { dataType: "comment", url: "https://www.reddit.com/r/Peptides/comments/1w470yj/x/", body: "Been over 2 years for me", commentCreatedAt: "2026-09-01T16:26:08.000Z", commentUpVotes: 3 },
    ];
    const fetchImpl = (async (_u: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(rows)); }) as unknown as typeof fetch;
    const b = await fetchReddit({ platform: "reddit", handle: "vegetable-today", url: "https://www.reddit.com/user/Vegetable-Today/" }, { fetchImpl, apify: { token: "t", actors: {} }, maxItems: 12 });
    expect(sent.usernames).toEqual(["https://www.reddit.com/user/Vegetable-Today/"]);
    expect(b.bio).toBe("I have tattoos and I like cheese.");
    expect(b.followers).toBeNull(); // invariant: Reddit reach stays null
    expect(b.items).toEqual([{ url: "https://www.reddit.com/r/Peptides/comments/1w470yj/x/", text: "Been over 2 years for me", postedAt: "2026-09-01T16:26:08.000Z", likes: 3 }]);
  });
});
