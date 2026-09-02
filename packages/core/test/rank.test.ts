import { describe, expect, it } from "vitest";
import { bandOf, rankAll, type RankInput } from "../src/rank.js";

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
    expect(results.map((r) => r.id)).toEqual(["gym", "noo", "mma"]);
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

  it("tiebreak 2: niche priority Longevity > … > MMA; blank niche last", () => {
    const results = rankAll([
      lead({ id: "mma", affiliationStatus: "Unsigned", totalReach: 1000, niche: "MMA" }),
      lead({ id: "none", affiliationStatus: "Unsigned", totalReach: 1000 }),
      lead({ id: "long", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Longevity" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["long", "mma", "none"]);
  });

  it("is stable for full ties", () => {
    const results = rankAll([
      lead({ id: "first", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Gym" }),
      lead({ id: "second", affiliationStatus: "Unsigned", totalReach: 1000, niche: "Gym" }),
    ]);
    expect(results.map((r) => r.id)).toEqual(["first", "second"]);
  });
});
