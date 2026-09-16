import { describe, expect, it } from "vitest";
import { bandOf, rankAll, type RankInput } from "../src/rank.js";
import { isQualifiedPath, outreachPath } from "../src/outreach-path.js";

const lead = (partial: Partial<RankInput> & { id: string }): RankInput => ({
  affiliationStatus: null,
  totalReach: null,
  entryTier: null,
  niche: null,
  ...partial,
});

describe("bandOf — ranking-spec.md bands", () => {
  it("band 1: Unsigned + verified reach", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Unsigned", totalReach: 5000 }))).toBe("1");
  });
  it("band 2: Unsigned + blank reach (blank is a sentinel, not 0)", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Unsigned" }))).toBe("2");
  });
  it("band 3: Signed Diamond or Gold share a band", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Signed", entryTier: "Diamond" }))).toBe("3");
    expect(bandOf(lead({ id: "b", affiliationStatus: "Signed", entryTier: "Gold" }))).toBe("3");
  });
  it("band 3b sits between 3 and 4", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Signed", entryTier: "Silver" }))).toBe("3b");
  });
  it("band 4: Signed Bronze", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Signed", entryTier: "Bronze" }))).toBe("4");
  });
  it("band 5 + triage for records no spec rule covers", () => {
    expect(bandOf(lead({ id: "a" }))).toBe("5"); // blank status
    expect(bandOf(lead({ id: "b", affiliationStatus: "Signed" }))).toBe("5"); // Signed, no tier
  });
});

describe("live Airtable vocabulary (recovered 2026-09-01)", () => {
  it("'Signed elsewhere' maps to the spec's Signed bands", () => {
    expect(bandOf(lead({ id: "a", affiliationStatus: "Signed elsewhere", entryTier: "Gold" }))).toBe("3");
    expect(bandOf(lead({ id: "b", affiliationStatus: "Signed elsewhere", entryTier: "Silver" }))).toBe("3b");
  });
  it("'Our affiliate' ranks last as converted — never triage", () => {
    const [r] = rankAll([lead({ id: "ours", affiliationStatus: "Our affiliate" })]);
    expect(r?.band).toBe("5");
    expect(r?.converted).toBe(true);
    expect(r?.needsTriage).toBe(false);
  });
  it("alias niches normalize onto the priority list", () => {
    const results = rankAll([
      lead({ id: "mma", affiliationStatus: "Unsigned", totalReach: 1000, niche: "MMA/Combat" }),
      lead({ id: "gym", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Gym/Bodybuilding" }),
      lead({ id: "noo", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Nootropics/Cognitive" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["noo", "mma", "gym"]);
  });
});

describe("rankAll — global ordinal", () => {
  it("orders band 1 < 2 < 3 < 3b < 4 < 5 and numbers 1..N", () => {
    const results = rankAll([
      lead({ id: "b5" }),
      lead({ id: "b4", affiliationStatus: "Signed", entryTier: "Bronze" }),
      lead({ id: "b3b", affiliationStatus: "Signed", entryTier: "Silver" }),
      lead({ id: "b3", affiliationStatus: "Signed", entryTier: "Gold" }),
      lead({ id: "b2", affiliationStatus: "Unsigned" }),
      lead({ id: "b1", affiliationStatus: "Unsigned", totalReach: 10 }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["b1", "b2", "b3", "b3b", "b4", "b5"]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.at(-1)?.needsTriage).toBe(true);
  });

  it("tiebreak 1: reach-per-person descending, with person-count divisor", () => {
    const results = rankAll([
      lead({ id: "team", affiliationStatus: "Unsigned", totalReach: 100_000, personCount: 4 }), // 25k/person
      lead({ id: "solo", affiliationStatus: "Unsigned", totalReach: 40_000 }), // 40k/person
    ]);
    expect(results.map((r) => r.id)).toEqual(["solo", "team"]);
  });

  it("tiebreak 2: niche tier order Weight-loss seeker > … > Sexual wellness; blank niche last", () => {
    const results = rankAll([
      lead({ id: "sex", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Sexual wellness" }),
      lead({ id: "none", affiliationStatus: "Unsigned", totalReach: 1000 }),
      lead({ id: "wl", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Weight-loss seeker" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["wl", "sex", "none"]);
  });

  it("is stable for full ties", () => {
    const results = rankAll([
      lead({ id: "first", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Gym" }),
      lead({ id: "second", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Gym" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["first", "second"]);
  });
});

describe("outreach flow chart (2026-09-16)", () => {
  it("only competitor affiliates with a lower or equal rate qualify", () => {
    const signed = { affiliationStatus: "Signed elsewhere", competitorId: 1 };
    expect(outreachPath(signed, 20)).toBe("offer1");
    expect(outreachPath(signed, 25)).toBe("offer2");
    expect(outreachPath(signed, 30)).toBe("higher");
    expect(outreachPath(signed, null)).toBe("rate_unknown");
    expect(outreachPath({ ...signed, competitorId: null }, 20)).toBe("competitor_unnamed");
    expect(outreachPath({ affiliationStatus: "Unsigned", competitorId: 1 }, 20)).toBe("unsigned");
    expect(outreachPath({ affiliationStatus: "Our affiliate", competitorId: null }, null)).toBe("converted");
    expect(["offer1", "offer2", "higher", "rate_unknown", "unsigned"].map((p) => isQualifiedPath(p as never))).toEqual([true, true, false, false, false]);
  });

  it("the path sorts before the band: a qualified signed lead outranks an unsigned band-1 lead", () => {
    const r = rankAll([
      { id: "u", affiliationStatus: "Unsigned", totalReach: 900_000, entryTier: null, niche: null, path: "unsigned" },
      { id: "wait", affiliationStatus: "Signed elsewhere", totalReach: 50_000, entryTier: "Gold", niche: null, path: "rate_unknown" },
      { id: "o1", affiliationStatus: "Signed elsewhere", totalReach: 5_000, entryTier: "Bronze", niche: null, path: "offer1" },
    ]);
    expect(r.map((x) => x.id)).toEqual(["o1", "wait", "u"]);
  });
});
