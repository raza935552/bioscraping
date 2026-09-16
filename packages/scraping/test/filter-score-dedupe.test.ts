import { describe, expect, it } from "vitest";
import { applyFilters, DEFAULT_EXCLUDE_TERMS } from "../src/filter.js";
import { findAffiliateCode, PROMO_PATTERN, scoreHit, type CompetitorRule } from "../src/score.js";
import { emptyKnown, handlesInText, isKnown, nameKey, urlKey, urlsInText } from "../src/dedupe.js";
import type { DiscoveryHit } from "../src/discovery/types.js";

const hit = (over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok",
  handle: "ann",
  profileUrl: "https://www.tiktok.com/@ann",
  displayName: "Ann",
  bio: "NP · hormones",
  followers: 42000,
  postUrl: "https://www.tiktok.com/@ann/video/1",
  postText: "menopause tips",
  postedAt: "2026-09-01T00:00:00.000Z",
  country: "US",
  isRepost: null,
  term: "#perimenopause",
  ...over,
});
const rules = {
  followerMin: { tiktok: 5000 },
  followerMax: { tiktok: 500000 },
  countries: ["US", "CA"],
  language: "en",
  excludeTerms: DEFAULT_EXCLUDE_TERMS,
  excludeHandles: ["spamguy"],
};
const ps: CompetitorRule = { id: 1, name: "Peptide Sciences", domains: ["peptidesciences.com"], codePattern: null, codePrefix: "PS", commissionPct: 15 };

describe("applyFilters", () => {
  it("counts each reject reason and keeps the rest", () => {
    const out = applyFilters(
      [
        hit(),
        hit({ handle: "spamguy" }),
        hit({ handle: "b", followers: 10 }),
        hit({ handle: "c", followers: 9e6 }),
        hit({ handle: "d", country: "DE" }),
        hit({ handle: "e", bio: "semaglutide coach" }),
        hit({ handle: "f", followers: null, country: null }),
      ],
      rules,
    );
    expect(out.kept.map((h) => h.handle)).toEqual(["ann", "f"]);
    expect(out.rejected).toEqual({ excluded_handle: 1, excluded_term: 1, followers_low: 1, followers_high: 1, country: 1 });
  });
  it("ships the GLP-1 names as default exclusions", () => {
    expect(DEFAULT_EXCLUDE_TERMS).toEqual(expect.arrayContaining(["semaglutide", "tirzepatide", "retatrutide", "ozempic", "wegovy", "mounjaro", "zepbound"]));
  });
});

describe("findAffiliateCode / PROMO_PATTERN", () => {
  it("finds a prefixed code and its competitor; domain match without code returns the competitor with code null", () => {
    expect(findAffiliateCode("use code PS20 at checkout", [ps])).toEqual({ code: "PS20", competitor: ps });
    // A referral link carries the affiliate's code (live 2026-09-16: "ameanopeptides.com/?ref=Chasity").
    expect(findAffiliateCode("shop peptidesciences.com/?ref=ann", [ps])).toEqual({ code: "ANN", competitor: ps });
    const named = { ...ps, domains: [...ps.domains, "peptide sciences"] };
    expect(findAffiliateCode("love peptide sciences, great stuff", [named])).toEqual({ code: null, competitor: named });
    expect(findAffiliateCode("use code 'Mel' at checkout with peptide sciences", [named])?.code).toBe("MEL");
    expect(findAffiliateCode("Peptide Sciences💙 S@Le cod3: ThatGeek #glowup", [named])?.code).toBe("THATGEEK");
    expect(findAffiliateCode("nothing here", [ps])).toBeNull();
    expect(findAffiliateCode("code ABC12", [{ ...ps, codePrefix: null, codePattern: "^ABC\\d+$" }])).toEqual({
      code: "ABC12",
      competitor: expect.objectContaining({ id: 1 }),
    });
  });
  it("promo pattern catches discount language and #ad", () => {
    for (const s of ["20% off with my link", "link in bio", "#ad", "use code ANN", "discount code"]) expect(PROMO_PATTERN.test(s)).toBe(true);
    expect(PROMO_PATTERN.test("what I eat in a day")).toBe(false);
  });
});

describe("scoreHit", () => {
  const base = {
    rules: { followerMin: 5000, followerMax: 500000, activityDays: 30, matchTerms: ["menopause", "hormones"], excludeTerms: DEFAULT_EXCLUDE_TERMS },
    competitors: [ps],
    now: new Date("2026-09-14T00:00:00.000Z"),
  };
  it("adds every line Jakob listed and explains each", () => {
    const r = scoreHit({
      ...base,
      hit: hit(),
      verified: { followers: 42000, bio: "NP · hormones · code PS20", lastPostAt: "2026-09-10T00:00:00.000Z", items: [{ text: "20% off with PS20", url: "https://t/1" }], isRepostRatio: 0 },
    });
    // competitor 30 + commission<25 15 + reach 15 + active 15 + promo 10 + original 5 + on-niche 10
    expect(r.score).toBe(100);
    expect(r.competitor?.name).toBe("Peptide Sciences");
    expect(r.affiliateCode).toBe("PS20");
    expect(r.promoTrackRecord).toBe(true);
    expect(r.contentOriginal).toBe(true);
    expect(r.reasons).toContain("competitor affiliate: Peptide Sciences (+30)");
  });
  it("dormant is a penalty, unknowns are null not false, GLP-1-only is −30", () => {
    const r = scoreHit({
      ...base,
      hit: hit({ bio: "ozempic journey", postText: null }),
      verified: { followers: 42000, bio: "ozempic journey", lastPostAt: "2026-01-01T00:00:00.000Z", items: [], isRepostRatio: null },
    });
    expect(r.score).toBe(0); // 15 − 20 − 30 clamps to 0
    expect(r.reasons).toContain('GLP-1-only content: "ozempic" (−30)');
    expect(r.promoTrackRecord).toBeNull();
    expect(r.contentOriginal).toBeNull();
    expect(r.glp1Only).toBe(true);
  });
  it("no verification read → no reach and no activity points; nothing invented", () => {
    const r = scoreHit({ ...base, hit: hit(), verified: null });
    expect(r.score).toBe(10); // on-niche only ("menopause tips" in the surfaced post)
    expect(r.promoTrackRecord).toBeNull();
  });
});

describe("isKnown", () => {
  it("matches on any of the five keys", () => {
    const k = emptyKnown();
    expect(isKnown(hit(), null, k)).toBe(false);
    k.codes.add("ps20");
    expect(isKnown(hit(), "PS20", k)).toBe(true);
    const k2 = emptyKnown();
    k2.handles.add("tiktok:ann");
    expect(isKnown(hit(), null, k2)).toBe(true);
    const k3 = emptyKnown();
    k3.urls.add(urlKey("https://www.tiktok.com/@ann/"));
    expect(isKnown(hit(), null, k3)).toBe(true);
    const k4 = emptyKnown();
    k4.names.add(nameKey("Ann", "tiktok")!);
    expect(isKnown(hit(), null, k4)).toBe(true);
    expect(nameKey("  ", "tiktok")).toBeNull();
    expect(urlKey("HTTPS://WWW.TikTok.com/@Ann/?x=1")).toBe("tiktok.com/@ann");
  });
});

describe("handlesInText (imported social_profiles formats)", () => {
  const cases: Array<[string, string | null, string[]]> = [
    ["TikTok @jamiehiraldo — https://www.tiktok.com/@jamiehiraldo", "TikTok", ["tiktok:jamiehiraldo"]],
    ["@holisticglpgirly", "TikTok", ["tiktok:holisticglpgirly"]],
    ["@don_madsen (IG/YT/WhatsApp)", "Instagram", ["instagram:don_madsen", "youtube:don_madsen"]],
    ["Reddit u/allstealdeals — https://www.reddit.com/user/allstealdeals", "Reddit", ["reddit:allstealdeals"]],
    ["YT @moreplatesmoredates; IG @moreplatesmoredates; X @Derek_Fitness", "YouTube", ["youtube:moreplatesmoredates", "instagram:moreplatesmoredates", "x:derek_fitness"]],
    ["TikTok @nota.dimadozen.girl", "TikTok", ["tiktok:nota.dimadozen.girl"]],
    ["t.me/peptidepartners; @PeptidePartners on X", "Telegram", ["x:peptidepartners"]],
    ["YT Michael Duggal (86K)", "YouTube", []],
    ["email ann@gmail.com, TikTok @ann.", "TikTok", ["tiktok:ann"]],
    ["https://www.youtube.com/channel/UCabc123", "YouTube", ["youtube:ucabc123"]],
    ["https://www.instagram.com/p/XYZ/", "Instagram", []],
  ];
  it.each(cases)("%s", (text, platform, keys) => {
    expect(handlesInText(text, platform).sort()).toEqual([...keys].sort());
  });

  it("urlsInText keys every profile URL", () => {
    expect(urlsInText("Stan Store @chelefit — https://stan.store/chelefit/")).toEqual(["stan.store/chelefit"]);
  });

  it("isKnown matches a hit through the handle in its profile URL", () => {
    const known = emptyKnown();
    known.handles.add("youtube:aminoedge");
    const hit = { platform: "youtube", handle: "uc123", profileUrl: "https://www.youtube.com/@AminoEdge", displayName: null } as Parameters<typeof isKnown>[0];
    expect(isKnown(hit, null, known)).toBe(true);
  });
});
