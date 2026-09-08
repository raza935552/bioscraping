import { describe, expect, it } from "vitest";
import { resolveCandidates } from "../src/resolve.js";

const base = { primaryPlatform: null, socialProfiles: null, whereFound: null, websiteUrl: null, reachSourceUrl: null };

describe("resolveCandidates", () => {
  it("parses the 'IG @a (2M); TikTok @b (597.7K)' format", () => {
    const out = resolveCandidates({ ...base, socialProfiles: "IG @tamsenfadal (2M); TikTok @tamsenfadal (597.7K)" });
    expect(out).toEqual([
      { platform: "instagram", handle: "tamsenfadal", url: "https://www.instagram.com/tamsenfadal/" },
      { platform: "tiktok", handle: "tamsenfadal", url: "https://www.tiktok.com/@tamsenfadal" },
    ]);
  });

  it("puts the primary platform first", () => {
    const out = resolveCandidates({
      ...base,
      primaryPlatform: "TikTok",
      socialProfiles: "IG @dave.asprey; TikTok @daveasprey",
    });
    expect(out[0]?.platform).toBe("tiktok");
    expect(out[1]?.platform).toBe("instagram");
  });

  it("infers the platform for a bare @handle from primaryPlatform", () => {
    const out = resolveCandidates({ ...base, primaryPlatform: "Instagram", socialProfiles: "@drgabriellelyon" });
    expect(out).toEqual([{ platform: "instagram", handle: "drgabriellelyon", url: "https://www.instagram.com/drgabriellelyon/" }]);
  });

  it("parses YT @handle and YouTube channel URLs", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "YT @ThomasDeLauerOfficial" })).toEqual([
      { platform: "youtube", handle: "ThomasDeLauerOfficial", url: "https://www.youtube.com/@ThomasDeLauerOfficial" },
    ]);
    expect(resolveCandidates({ ...base, websiteUrl: "https://www.youtube.com/channel/UC70SrI3VkT1MXALRtf0pcHg" })).toEqual([
      { platform: "youtube", handle: null, url: "https://www.youtube.com/channel/UC70SrI3VkT1MXALRtf0pcHg" },
    ]);
  });

  it("parses reddit u/name and profile URLs", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "Reddit u/peptide_pete" })[0]).toEqual({
      platform: "reddit",
      handle: "peptide_pete",
      url: "https://www.reddit.com/user/peptide_pete/",
    });
    expect(resolveCandidates({ ...base, whereFound: "https://www.reddit.com/user/peptide_pete/comments/" })[0]?.handle).toBe("peptide_pete");
  });

  it("parses x.com and twitter.com URLs and 'X @handle'", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "X @biohackerjoe" })[0]).toEqual({
      platform: "x",
      handle: "biohackerjoe",
      url: "https://x.com/biohackerjoe",
    });
    expect(resolveCandidates({ ...base, websiteUrl: "https://twitter.com/biohackerjoe/status/1" })[0]?.handle).toBe("biohackerjoe");
  });

  it("classifies link hubs and plain websites", () => {
    expect(resolveCandidates({ ...base, websiteUrl: "https://linktr.ee/OfficialShelbyPepTalk" })).toEqual([
      { platform: "linkhub", handle: null, url: "https://linktr.ee/OfficialShelbyPepTalk" },
    ]);
    expect(resolveCandidates({ ...base, websiteUrl: "https://outliyr.com/best-longevity-influencers" })).toEqual([
      { platform: "web", handle: null, url: "https://outliyr.com/best-longevity-influencers" },
    ]);
  });

  it("drops non-http URLs and dedups by url", () => {
    const out = resolveCandidates({
      ...base,
      socialProfiles: "TikTok @meg.boggs",
      whereFound: "https://www.tiktok.com/@meg.boggs",
      websiteUrl: "javascript:alert(1)",
    });
    expect(out).toEqual([{ platform: "tiktok", handle: "meg.boggs", url: "https://www.tiktok.com/@meg.boggs" }]);
  });

  it("returns [] when nothing usable exists", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "The Human Upgrade Podcast" })).toEqual([]);
  });
});
