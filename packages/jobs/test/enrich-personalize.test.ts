import { describe, expect, it } from "vitest";
import type { Fetcher, SourceBundle, SourceCandidate } from "@biolinx/scraping";
import type { LlmClient } from "@biolinx/drafting";
import { enrichOne, type EnrichDeps } from "../src/enrich-personalize.js";

const bundle = (platform: SourceBundle["platform"], items: number, extra: Partial<SourceBundle> = {}): SourceBundle => ({
  platform,
  profileUrl: `https://${platform}.example/p`,
  displayName: "P",
  bio: null,
  followers: null,
  items: Array.from({ length: items }, (_, i) => ({ url: `https://${platform}.example/p/${i}`, text: `post ${i}`, postedAt: null })),
  ...extra,
});

function deps(fetchers: Partial<Record<string, Fetcher>>, llmReply: string | Error): EnrichDeps {
  const llm: LlmClient = {
    complete: async () => {
      if (llmReply instanceof Error) throw llmReply;
      return llmReply;
    },
  };
  return {
    llm,
    fetchDeps: { fetchImpl: fetch, apify: { token: "t", actors: {} }, maxItems: 12 },
    fetcherFor: (p) =>
      fetchers[p] ??
      (async () => {
        throw new Error(`no fetcher for ${p}`);
      }),
    model: "test-model",
  };
}

const lead = { id: 7, primaryPlatform: "TikTok", socialProfiles: "TikTok @a; IG @b", whereFound: null, websiteUrl: null, reachSourceUrl: null };
const match = (url: string) => JSON.stringify({ verdict: "match", points: [{ text: "real thing", url }] });

describe("enrichOne", () => {
  it("no candidates → no_source", async () => {
    const out = await enrichOne({ ...lead, socialProfiles: null, primaryPlatform: null }, deps({}, "{}"));
    expect(out.status).toBe("no_source");
  });

  it("first candidate with items wins; notes built; handles recorded", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, match("https://tiktok.example/p/0")));
    expect(out.status).toBe("enriched");
    expect(out.notes).toBe("MATCH — real thing (https://tiktok.example/p/0).");
    expect(out.sourceUrl).toBe("https://tiktok.example/p");
    expect(out.handles).toEqual([
      { key: "tiktok:a", url: "https://www.tiktok.com/@a", verified: true },
      { key: "instagram:b", url: "https://www.instagram.com/b/", verified: false },
    ]);
  });

  it("empty first candidate falls through to the second", async () => {
    const out = await enrichOne(
      lead,
      deps({ tiktok: async () => bundle("tiktok", 0), instagram: async () => bundle("instagram", 1) }, match("https://instagram.example/p/0")),
    );
    expect(out.status).toBe("enriched");
    expect(out.platform).toBe("instagram");
  });

  it("all candidates empty → unresolvable", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 0), instagram: async () => bundle("instagram", 0) }, "{}"));
    expect(out.status).toBe("unresolvable");
  });

  it("fetcher error on one candidate moves on; all errored → failed with the last error", async () => {
    const boom: Fetcher = async () => {
      throw new Error("actor timeout");
    };
    const partial = await enrichOne(lead, deps({ tiktok: boom, instagram: async () => bundle("instagram", 1) }, match("https://instagram.example/p/0")));
    expect(partial.status).toBe("enriched");
    const all = await enrichOne(lead, deps({ tiktok: boom, instagram: boom }, "{}"));
    expect(all.status).toBe("failed");
    expect(all.error).toMatch(/actor timeout/);
  });

  it("link hub discoveries are appended as candidates", async () => {
    const hubLead = { ...lead, primaryPlatform: null, socialProfiles: null, websiteUrl: "https://linktr.ee/x" };
    const disc: SourceCandidate = { platform: "tiktok", handle: "found", url: "https://www.tiktok.com/@found" };
    const out = await enrichOne(
      hubLead,
      deps({ linkhub: async () => bundle("linkhub", 0, { discovered: [disc] }), tiktok: async () => bundle("tiktok", 1) }, match("https://tiktok.example/p/0")),
    );
    expect(out.status).toBe("enriched");
    expect(out.platform).toBe("tiktok");
  });

  it("model says no → no_match with the bundle kept", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, JSON.stringify({ verdict: "no_match", points: [] })));
    expect(out.status).toBe("no_match");
    expect(out.bundle?.items).toHaveLength(2);
  });

  it("LLM error → failed, bundle still returned for the history row", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, new Error("529")));
    expect(out.status).toBe("failed");
    expect(out.bundle).not.toBeNull();
  });
});
