import { describe, expect, it } from "vitest";
import { NICHE_PRIORITY, NICHE_TIER, brandFitForNiche, normalizeNiche } from "../src/enums.js";

describe("niche tiers", () => {
  it("priority order is Jakob's five tiers", () => {
    expect([...NICHE_PRIORITY]).toEqual(["Weight-loss seeker", "Biohacker", "Gym / PED-curious", "Anti-aging", "Sexual wellness"]);
    expect(NICHE_TIER["Weight-loss seeker"]).toBe(1);
    expect(NICHE_TIER["Biohacker"]).toBe(1);
    expect(NICHE_TIER["Gym / PED-curious"]).toBe(2);
    expect(NICHE_TIER["Anti-aging"]).toBe(3);
    expect(NICHE_TIER["Sexual wellness"]).toBe(4);
  });
  it("every old label maps onto a tier", () => {
    expect(normalizeNiche("Longevity")).toBe("Anti-aging");
    expect(normalizeNiche("Biohacking")).toBe("Biohacker");
    expect(normalizeNiche("Nootropics")).toBe("Biohacker");
    expect(normalizeNiche("Nootropics/Cognitive")).toBe("Biohacker");
    expect(normalizeNiche("Gym")).toBe("Gym / PED-curious");
    expect(normalizeNiche("Gym/Bodybuilding")).toBe("Gym / PED-curious");
    expect(normalizeNiche("MMA")).toBe("Gym / PED-curious");
    expect(normalizeNiche("MMA/Combat")).toBe("Gym / PED-curious");
    expect(normalizeNiche("Women's Wellness")).toBe("Weight-loss seeker"); // A1, per the 2026-09-11 scoring spec
    expect(normalizeNiche("Menopause")).toBe("Weight-loss seeker");
    expect(normalizeNiche("weight-loss seeker")).toBe("Weight-loss seeker");
    expect(normalizeNiche("nonsense")).toBeNull();
  });
  it("brand fit: weight-loss is both, everything else biolinx", () => {
    expect(brandFitForNiche("Weight-loss seeker")).toBe("both");
    expect(brandFitForNiche("Biohacker")).toBe("biolinx");
  });
});
