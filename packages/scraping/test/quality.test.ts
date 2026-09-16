import { describe, expect, it } from "vitest";
import { compact, findTerm, looksLikeStore, looksNonEnglish, qualityGate, deadWithoutRead, reachCheck } from "../src/quality.js";
import { emailFromText } from "../src/contact.js";
import { suggestCompetitors } from "../src/competitor-suggest.js";
import { findAffiliateCode, scoreHit } from "../src/score.js";
import type { DiscoveryHit } from "../src/discovery/types.js";

// Captions and bios are from the first live run, 2026-09-14.
const SPANISH = "¿Sabías que los péptidos inyectados funcionan como mensajes directos para tus células? Tu cuerpo los produce";
const SPANISH2 = "Retatrutide está en Fase 3 de ensayos clínicos. Proyección de aprobación: 2027. Hoy no existe una versión aprobada";
const NORWEGIAN = "Dette er video nr 6 i serien om peptider. Mulig det kommer flere etterhvert, men siste for denne gang.";
const ENGLISH = "I have been on a weight loss journey for a while and these are the things that actually worked for me";

const now = new Date("2026-09-14T14:00:00Z");
const hit = (over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok", handle: "creator", profileUrl: "https://www.tiktok.com/@creator", displayName: "Creator", bio: null, followers: 20000,
  postUrl: "https://www.tiktok.com/@creator/video/1", postText: ENGLISH, postedAt: "2026-09-10T00:00:00Z", country: null, isRepost: null, term: "#weightlosspeptides", ...over,
});
const read = (texts: string[], lastPostAt = "2026-09-12T00:00:00Z", bio: string | null = null) => ({ bio, lastPostAt, items: texts.map((text) => ({ text })) });
const base = { matchTerms: ["weight loss", "fat loss", "lose weight", "peptide", "metabolism"], language: "en", competitorFound: false, now };

describe("looksNonEnglish", () => {
  it.each([SPANISH, SPANISH2, NORWEGIAN])("flags %s", (t) => expect(looksNonEnglish(t)).toBe(true));
  it("keeps English, short text, and English with a stray foreign word", () => {
    expect(looksNonEnglish(ENGLISH)).toBe(false);
    expect(looksNonEnglish("#fyp #gym #weightloss #peps")).toBe(false);
    expect(looksNonEnglish("Hard work!")).toBe(false);
    expect(looksNonEnglish("My favorite taco place in LA, que rico, you have to try it with the salsa and the chips")).toBe(false);
  });
  it("flags mostly non-Latin script", () => expect(looksNonEnglish("Пептиды для похудения работают лучше чем вы думаете, вот почему")).toBe(true));
});

describe("findTerm / compact", () => {
  it("matches hashtag spellings of multi-word terms", () => {
    expect(compact("#Weight-Loss")).toBe("weightloss");
    expect(findTerm("Hard work! #fyp #gym #weightloss #peps", ["weight loss"])).toBe("weight loss");
    expect(findTerm("#peptidesforweightloss", ["peptide"])).toBe("peptide");
    expect(findTerm("LMAO RANDOM VENT I GUESS HAHA", ["weight loss", "peptide"])).toBeNull();
  });
});

describe("qualityGate", () => {
  it("drops non-English creators before the paid read", () => {
    expect(qualityGate({ ...base, hit: hit({ postText: SPANISH }), verified: null })).toBe("non_english");
  });
  it("drops off-niche videos from competitor hashtags, unless the competitor is mentioned", () => {
    const art = hit({ postText: "LMAO RANDOM VENT I GUESS HAHA! This happened about 6 or 7 years ago? I am so strict about mods on servers", term: "Amino Innovations" });
    expect(qualityGate({ ...base, hit: art, verified: null })).toBe("off_niche");
    expect(qualityGate({ ...base, hit: art, verified: null, competitorFound: true })).toBeNull();
    const hair = hit({ postText: "#healthyhair #howtogrowthickhair #growhealthyhair #thickhair" });
    expect(qualityGate({ ...base, hit: hair, verified: read(["hair oil routine for growth", "rosemary oil results"]) })).toBe("off_niche");
  });
  it("an off-niche surfaced post passes when the profile read shows the niche", () => {
    expect(qualityGate({ ...base, hit: hit({ postText: "#fyp morning routine" }), verified: read(["my peptide stack for fat loss this month"]) })).toBeNull();
  });
  it("dead is decided from the profile read, not an old surfaced post", () => {
    expect(qualityGate({ ...base, hit: hit({ postedAt: "2025-01-01T00:00:00Z" }), verified: null })).toBeNull();
    expect(qualityGate({ ...base, hit: hit(), verified: read(["weight loss tips"], "2026-01-20T00:00:00Z") })).toBe("dead"); // 237 days
    expect(qualityGate({ ...base, hit: hit(), verified: read(["weight loss tips"], "2026-06-01T00:00:00Z") })).toBe("dead"); // 105 days: dead since the 60-day rule
    expect(qualityGate({ ...base, hit: hit(), verified: read(["weight loss tips"], "2026-08-01T00:00:00Z") })).toBeNull(); // 44 days: dormant, kept and scored down
    expect(deadWithoutRead(hit({ postedAt: "2021-12-16T00:00:00Z" }), now)).toBe(true);
  });
  it("language gate is skipped for non-English audiences", () => {
    expect(qualityGate({ ...base, language: "es", matchTerms: ["péptidos"], hit: hit({ postText: SPANISH }), verified: null })).toBeNull();
  });
});

describe("store detection and competitor spellings", () => {
  it("flags seller accounts", () => {
    expect(looksLikeStore("kit4less.com", "Quality-focused peptide products")).toBe(true);
    expect(looksLikeStore("peptideshop", null)).toBe(true);
    expect(looksLikeStore("creator", "Order now, free shipping on all kits")).toBe(true);
    expect(looksLikeStore("chaoticallycannella", "mom of 3, fitness")).toBe(false);
  });
  it("store penalty shows in the score reasons", () => {
    const s = scoreHit({ hit: hit({ handle: "kit4less.com" }), verified: null, rules: { activityDays: 30, matchTerms: ["peptide"], excludeTerms: [] }, competitors: [], now });
    expect(s.reasons.some((r) => r.includes("store"))).toBe(true);
  });
  const offline = { id: 1, name: "Offline Peptides", domains: ["offlinepeptides.com", "offline peptides"], codePattern: null, codePrefix: null, commissionPct: null };
  const club = { id: 2, name: "Amino Club", domains: ["aminoclub.com", "amino club"], codePattern: null, codePrefix: null, commissionPct: null };
  it("finds a competitor by hashtag spelling", () => {
    expect(findAffiliateCode("new haul #offlinepeptides #peptides", [offline])?.competitor.name).toBe("Offline Peptides");
  });
  it("takes a personal code next to the competitor mention", () => {
    expect(findAffiliateCode("Use code JACOB at Amino Club for 20% off", [club])).toMatchObject({ code: "JACOB", competitor: { name: "Amino Club" } });
    expect(findAffiliateCode("amino club is great. " + "x".repeat(200) + " use code FAR", [club])?.code).toBeNull();
  });
});

describe("no matches across word boundaries (live false positives 2026-09-14)", () => {
  const ion = { id: 3, name: "Ion Peptide", domains: ["ionpeptide", "ion peptide"], codePattern: null, codePrefix: null, commissionPct: null };
  const ng = { id: 4, name: "NextGen Peptides", domains: ["ngpeptide.com", "nextgen peptides"], codePattern: null, codePrefix: null, commissionPct: null };
  it("'clear product information peptides' is not Ion Peptide", () => {
    expect(findAffiliateCode("Quality-focused peptide products, clear product information peptides and more", [ion])).toBeNull();
  });
  it("'amazing peptide' is not NextGen (ngpeptide)", () => {
    expect(findAffiliateCode("this amazing peptide changed my morning, so strong peptide effect", [ng])).toBeNull();
  });
  it("still matches the real hashtag and the plain name", () => {
    expect(findAffiliateCode("haul from #ionpeptide today", [ion])?.competitor.name).toBe("Ion Peptide");
    expect(findAffiliateCode("ordered from Ion Peptide again", [ion])?.competitor.name).toBe("Ion Peptide");
  });
  it("findTerm does not stitch words together", () => {
    expect(findTerm("I weigh tlossy things", ["weight loss"])).toBeNull();
  });
});

describe("50-lead run: languages and businesses", () => {
  it("flags Indonesian, Turkish and Swedish captions", () => {
    expect(looksNonEnglish("Dokter kulit yang bisa bantu kamu untuk kulit sehat dan awet muda, ini tips dari saya")).toBe(true);
    expect(looksNonEnglish("bu antrenman için çok iyi bir program ama daha fazla ağırlık gibi şey lazım")).toBe(true);
    expect(looksNonEnglish("jag tränar varje dag och det är inte lätt men också mycket roligt för mig")).toBe(true);
    expect(looksNonEnglish("I help women over 40 lose menopause weight and feel strong again in their bodies")).toBe(false);
  });
  it("flags studios, clinics, gyms and companies but not doctors who mention a clinic", () => {
    expect(looksLikeStore("body20pontevedra", "Boutique EMS Fitness Studio 20-Minute Full Body")).toBe(true);
    expect(looksLikeStore("topcorefitnessgym", "Your goals. Our guidance.")).toBe(true);
    expect(looksLikeStore("officialtrttucson", "TRT care for men in Tucson. Energy, strength")).toBe(true);
    expect(looksLikeStore("getstateos", "The world's first Human Operating System")).toBe(true);
    expect(looksLikeStore("dralextatem", "Board-certified urologist. I see patients at my clinic in Texas")).toBe(false);
    expect(looksLikeStore("nic.is.fit", "Team BecomingHER helps women 40–65 lose menopause weight")).toBe(false);
  });
});

describe("Instagram business categories", () => {
  it("places and sellers are businesses; creator categories are not", () => {
    expect(looksLikeStore("topcorefitness", "Your goals.", "Gym/Physical Fitness Center")).toBe(true);
    expect(looksLikeStore("spectrawellnesstampa", "Medicine Redefined", "Medical Center")).toBe(true);
    expect(looksLikeStore("nic.is.fit", "helps women 40-65", "Health/Beauty")).toBe(false);
    expect(looksLikeStore("nic.is.fit", "helps women 40-65", "Digital creator")).toBe(false);
  });
});

describe("reach that doesn't match engagement (47-lead review, 2026-09-15)", () => {
  const posts = (views: number[]) => views.map((v) => ({ views: v }));

  it("flags big accounts whose posts reach almost nobody, per platform", () => {
    // Lead 440: 466,300 followers, typical views in the hundreds.
    expect(reachCheck("tiktok", 466_300, posts([526, 480, 610, 900, 300, 12_000]))).toMatchObject({ weak: true, medianViews: 568 });
    // Healthy: 217,800 followers, ~20K views.
    expect(reachCheck("tiktok", 217_800, posts([20_650, 18_000, 25_000, 30_000, 9_000])).weak).toBe(false);
    // YouTube floor is 1%: 168K subscribers at 1,250 views fails, 108K at 4,000 passes.
    expect(reachCheck("youtube", 168_000, posts([1250, 1200, 1300, 1100, 1400])).weak).toBe(true);
    expect(reachCheck("youtube", 108_000, posts([4000, 3900, 4100, 4200, 3800])).weak).toBe(false);
  });

  it("uses the median so one viral post can't hide dead reach, and skips thin or unviewed reads", () => {
    expect(reachCheck("tiktok", 400_000, posts([100, 120, 90, 110, 3_000_000])).weak).toBe(true);
    expect(reachCheck("tiktok", 400_000, posts([100, 120, 90])).weak).toBe(false); // under 5 posts with views
    expect(reachCheck("instagram", 400_000, posts([1, 1, 1, 1, 1])).weak).toBe(false); // no floor for Instagram
    expect(reachCheck("tiktok", null, posts([1, 1, 1, 1, 1])).weak).toBe(false);
    // Zeros are unreported views, not zero reach (lead 465, YouTube, 2026-09-15).
    expect(reachCheck("youtube", 194_000, posts([0, 0, 0, 9500, 14_000, 8000, 12_000, 9000])).weak).toBe(false);
  });

  it("the gate rejects weak reach after a read, and dead now means 60 days", () => {
    const read = { bio: "weight loss tips", lastPostAt: "2026-09-10T00:00:00Z", followers: 466_300, items: [526, 480, 610, 900, 300].map((v) => ({ text: "weight loss", views: v })) };
    const input = { hit: { platform: "tiktok", handle: "a", profileUrl: "https://www.tiktok.com/@a", displayName: null, bio: null, followers: 466_300, postUrl: null, postText: "weight loss", postedAt: null, country: null, isRepost: null, term: "t" } as const, matchTerms: ["weight loss"], language: "en", competitorFound: false, now: new Date("2026-09-15T00:00:00Z") };
    expect(qualityGate({ ...input, verified: read })).toBe("weak_reach");
    expect(qualityGate({ ...input, verified: { ...read, followers: 20_000 } })).toBeNull();
    expect(qualityGate({ ...input, verified: { ...read, followers: 20_000, lastPostAt: "2026-07-10T00:00:00Z" } })).toBe("dead"); // 67 days
    expect(qualityGate({ ...input, verified: { ...read, followers: 20_000, lastPostAt: "2026-07-25T00:00:00Z" } })).toBeNull(); // 52 days
  });
});

describe("email from the bio", () => {
  it("finds written-out and [at]-style addresses, ignores asset names and placeholders", () => {
    expect(emailFromText("Collabs 📩 Jane.Doe+work@Gmail.com | coach")).toBe("jane.doe+work@gmail.com");
    expect(emailFromText("business: hello [at] fitwithmadz [dot] com")).toBe("hello@fitwithmadz.com");
    expect(emailFromText("logo@2x.png and your@email.com")).toBeNull();
    expect(emailFromText("no contact here @handle")).toBeNull();
    expect(emailFromText(null)).toBeNull();
  });
});

describe("competitor suggestions", () => {
  const known = [{ name: "Amino Club", domains: ["aminoclub.com", "amino club"] }, { name: "Peptira", domains: ["peptira"] }];
  it("finds vendors named next to a code or as a store domain, skipping known competitors and non-vendors", () => {
    expect(suggestCompetitors("use code JAMIE at Nova Peptides for 20% off", known)).toEqual([{ name: "Nova Peptides", domain: null }]);
    expect(suggestCompetitors("shop novalabs.com/?ref=jamie", known)).toEqual([{ name: "novalabs", domain: "novalabs.com" }]);
    expect(suggestCompetitors("code CLAY @petratidescience", known)).toEqual([{ name: "petratidescience", domain: null }]);
    expect(suggestCompetitors("use code JAMIE222 at Amino Club, also peptira.com", known)).toEqual([]);
    expect(suggestCompetitors("use code SAVE10 at checkout, link in bio", known)).toEqual([]);
    expect(suggestCompetitors("my site biolinxlabs.com and tiktok.com", known)).toEqual([]);
    expect(suggestCompetitors("code DDT10 at Gymshark", known)).toEqual([]);
  });
});
