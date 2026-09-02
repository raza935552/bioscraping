import { describe, expect, it } from "vitest";
import { isBlocked, lint, RUO_LINE, type LintContext } from "../src/index.js";

const emailCtx = (over: Partial<LintContext> = {}): LintContext => ({
  channel: "email",
  touchNumber: 2,
  isPublic: false,
  audience: "prospect",
  hasUnsubscribeLink: true,
  hasPostalAddress: true,
  recipientCountry: "US",
  emailProvenance: "published_business",
  isSuppressed: false,
  ...over,
});

const dmCtx = (over: Partial<LintContext> = {}): LintContext => ({
  channel: "dm",
  touchNumber: 1,
  isPublic: false,
  audience: "prospect",
  ...over,
});

describe("L1 — banned terms", () => {
  it("blocks real drug names and suggests coded replacements", () => {
    const v = lint("We carry semaglutide at great prices", dmCtx());
    expect(v.some((x) => x.rule === "L1-drug-name" && x.detail.includes("G1-S"))).toBe(true);
  });
  it("blocks claim phrases (weight loss, anti-aging, FDA-approved…)", () => {
    for (const bad of ["helps with weight loss", "great anti-aging results", "it's FDA-approved"]) {
      expect(isBlocked(lint(bad, dmCtx()))).toBe(true);
    }
  });
  it("blocks personal-use implications", () => {
    expect(isBlocked(lint("I take it daily and it works for me", dmCtx()))).toBe(true);
  });
  it("passes clean compliant copy", () => {
    const clean = "Loved your recent post about recovery routines. I'm helping run a partner program for a research supplement brand. Would it be worth a short conversation? Only if it's a good fit for you.";
    expect(lint(clean, dmCtx())).toEqual([]);
  });
});

describe("L2 — template contract", () => {
  it("blocks openers that lead with the commission", () => {
    expect(isBlocked(lint("Hey! You can earn 25% with us. Interested? Let me know. Thanks.", dmCtx()))).toBe(true);
  });
  it("blocks links in a first DM", () => {
    expect(isBlocked(lint("Check https://example.com out. Great stuff. Truly. Yes.", dmCtx()))).toBe(true);
  });
  it("blocks 6+ sentence prospect messages", () => {
    const six = "One. Two. Three. Four. Five. Six.";
    expect(lint(six, dmCtx()).some((x) => x.rule === "L2-length")).toBe(true);
  });
});

describe("L2 — no em/en dashes (client rule)", () => {
  it("blocks an em dash in prospect copy", () => {
    expect(lint("Loved your post, really thoughtful — worth a chat? Easy no.", dmCtx({ touchNumber: 2 })).some((x) => x.rule === "L2-em-dash")).toBe(true);
  });
  it("blocks an en dash too", () => {
    expect(lint("Great work – would you chat? No pressure.", dmCtx({ touchNumber: 2 })).some((x) => x.rule === "L2-em-dash")).toBe(true);
  });
  it("allows commas and full stops", () => {
    expect(lint("Loved your post, really thoughtful. Worth a chat? Easy no.", dmCtx({ touchNumber: 2 })).some((x) => x.rule === "L2-em-dash")).toBe(false);
  });
});

describe("L3 — restricted SKUs + RUO line", () => {
  it("blocks naming restricted GLP-1 products to prospects", () => {
    expect(isBlocked(lint("Our G2-T flies off the shelves", dmCtx()))).toBe(true);
  });
  it("requires the RUO line on public content", () => {
    const v = lint("A public post about our lab verification", dmCtx({ isPublic: true }));
    expect(v.some((x) => x.rule === "L3-ruo-line")).toBe(true);
    const ok = lint(`A public post about our lab verification. ${RUO_LINE}`, dmCtx({ isPublic: true }));
    expect(ok.some((x) => x.rule === "L3-ruo-line")).toBe(false);
  });
});

describe("L5 — CAN-SPAM", () => {
  it("blocks email without unsubscribe or postal address", () => {
    expect(lint("Hello there.", emailCtx({ hasUnsubscribeLink: false })).some((x) => x.rule === "L5-unsubscribe")).toBe(true);
    expect(lint("Hello there.", emailCtx({ hasPostalAddress: false })).some((x) => x.rule === "L5-postal")).toBe(true);
  });
  it("blocks suppressed recipients, non-US, and scraped addresses", () => {
    expect(lint("Hi.", emailCtx({ isSuppressed: true })).some((x) => x.rule === "L5-suppressed")).toBe(true);
    expect(lint("Hi.", emailCtx({ recipientCountry: "CA" })).some((x) => x.rule === "L5-geo")).toBe(true);
    expect(lint("Hi.", emailCtx({ emailProvenance: "scraped" })).some((x) => x.rule === "L5-provenance")).toBe(true);
  });
  it("allows the unsubscribe link in a first email while blocking other links", () => {
    const withUnsub = "Quick intro from a partner program. Reply if curious. https://mail.biolinxpartners.com/unsubscribe/abc";
    expect(lint(withUnsub, emailCtx({ touchNumber: 1 })).some((x) => x.rule === "L2-opener-link")).toBe(false);
    const withOther = "Quick intro. See https://biolinxlabs.com for more.";
    expect(lint(withOther, emailCtx({ touchNumber: 1 })).some((x) => x.rule === "L2-opener-link")).toBe(true);
  });
});

describe("L7 — earnings claims", () => {
  it("blocks EPC figures without the historical qualifier", () => {
    expect(isBlocked(lint("Affiliates earn $12.04 per click!", dmCtx({ touchNumber: 2 })))).toBe(true);
  });
  it("allows the figure with the qualifier", () => {
    const ok = lint("Historical EPC of $12.04 — rate retired.", dmCtx({ touchNumber: 2 }));
    expect(ok.some((x) => x.rule === "L7-earnings")).toBe(false);
  });
});
