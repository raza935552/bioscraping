import { describe, expect, it, vi } from "vitest";
import { discoverTikTok, tagOf } from "../src/discovery/tiktok.js";
import type { DiscoveryDeps } from "../src/discovery/types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deps(rows: unknown, capture?: (b: unknown) => void): DiscoveryDeps {
  const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(rows);
  });
  return { fetchImpl: fetchImpl as typeof fetch, apify: { token: "t", actors: {} }, perTerm: 30 };
}

describe("discoverTikTok", () => {
  it("sends the hashtag without '#', one hit per distinct author, latest post wins", async () => {
    let sent: unknown;
    const hits = await discoverTikTok(
      "#perimenopause",
      deps(
        [
          {
            text: "older",
            webVideoUrl: "https://www.tiktok.com/@ann/video/1",
            createTimeISO: "2026-08-01T00:00:00.000Z",
            authorMeta: { name: "ann", nickName: "Ann", signature: "NP · hormones", fans: 42000, profileUrl: "https://www.tiktok.com/@ann" },
            locationMeta: { countryCode: "US" },
          },
          {
            text: "newer",
            webVideoUrl: "https://www.tiktok.com/@ann/video/2",
            createTimeISO: "2026-09-01T00:00:00.000Z",
            authorMeta: { name: "ann", fans: 42000, profileUrl: "https://www.tiktok.com/@ann" },
          },
          { text: "x", webVideoUrl: "https://www.tiktok.com/@bob/video/9", createTimeISO: "2026-09-02T00:00:00.000Z", authorMeta: { name: "bob", fans: 10 } },
          { error: "not_found", errorCode: "not_found" },
        ],
        (b) => (sent = b),
      ),
      {},
    );
    expect(sent).toEqual({ hashtags: ["perimenopause"], resultsPerPage: 30 });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      platform: "tiktok",
      handle: "ann",
      profileUrl: "https://www.tiktok.com/@ann",
      displayName: "Ann",
      bio: "NP · hormones",
      followers: 42000,
      postUrl: "https://www.tiktok.com/@ann/video/2",
      postText: "newer",
      postedAt: "2026-09-01T00:00:00.000Z",
      country: "US",
      isRepost: null,
      term: "#perimenopause",
    });
    expect(hits[1]?.profileUrl).toBe("https://www.tiktok.com/@bob");
  });

  it("returns [] on an empty dataset and throws on actor error", async () => {
    expect(await discoverTikTok("#x", deps([]), {})).toEqual([]);
    const bad: DiscoveryDeps = { ...deps([]), fetchImpl: (async () => json({ error: { message: "boom" } }, 500)) as typeof fetch };
    await expect(discoverTikTok("#x", bad, {})).rejects.toThrow(/boom/);
  });
});

describe("tagOf", () => {
  it("makes a single-token hashtag from a name with spaces and punctuation", () => {
    expect(tagOf("Peptide Sciences")).toBe("peptidesciences");
    expect(tagOf("#Limitless-Life Co.")).toBe("limitlesslifeco");
    expect(tagOf(" #glp1_journey ")).toBe("glp1_journey");
  });
});
