import { describe, expect, it } from "vitest";
import { lint, isBlocked, RUO_LINE } from "@biolinx/compliance";
import { ASSET_ORDER, DEFAULT_ASSET_SETTINGS, RESEARCH_USE_LINE, affiliateAssetSettings, renderAsset, renderAssets } from "@biolinx/core";

const subject = { firstName: "Mindy", couponCode: "mindy10", referralLink: null };

describe("affiliate assets", () => {
  it("the research-use line matches the linter's word for word", () => {
    // They live in two packages that can't import each other; a drift here would ship non-compliant assets.
    expect(RESEARCH_USE_LINE).toBe(RUO_LINE);
  });

  it("every asset passes the compliance linter as public affiliate content", () => {
    for (const a of renderAssets(subject, DEFAULT_ASSET_SETTINGS)) {
      const violations = lint(a.text, { channel: "dm", touchNumber: 1, isPublic: true, audience: "affiliate" });
      expect({ id: a.id, blocked: isBlocked(violations), why: violations.map((v) => v.rule) }).toEqual({ id: a.id, blocked: false, why: [] });
    }
  });

  it("fills the code in upper case and fits the surface it goes on", () => {
    const bio = renderAsset("bio_line", subject, DEFAULT_ASSET_SETTINGS);
    expect(bio.text).toContain("MINDY10");
    expect(bio.text).toContain("10% off");
    expect(bio.missing).toEqual([]);
    expect(bio.tooLong).toBe(false);
  });

  it("says what is missing instead of handing over half-filled copy", () => {
    const a = renderAsset("feed_caption", { firstName: null, couponCode: null, referralLink: null }, DEFAULT_ASSET_SETTINGS);
    expect(a.missing).toContain("code");
    expect(a.text).toContain("[code]");
  });

  it("marketing's own wording is used when it is set, and junk falls back", () => {
    const s = affiliateAssetSettings({ assets: { bio_line: "Partner of Biolinx Labs. Code [code].", nope: "x" }, discountPct: 15, storeUrl: "https://biolinxlabs.com/" });
    expect(s.discountPct).toBe(15);
    expect(s.storeUrl).toBe("biolinxlabs.com");
    expect(renderAsset("bio_line", subject, s).text).toBe("Partner of Biolinx Labs. Code MINDY10.");
    expect(affiliateAssetSettings({ discountPct: 0 }).discountPct).toBe(10);
  });

  it("covers every asset in the list", () => {
    expect(renderAssets(subject, DEFAULT_ASSET_SETTINGS).map((a) => a.id)).toEqual(ASSET_ORDER);
  });
});
