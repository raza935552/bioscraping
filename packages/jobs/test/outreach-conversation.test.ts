import { describe, expect, it } from "vitest";
import { DEFAULT_OUTREACH_SETTINGS, DEFAULT_TEMPLATES, type TemplateId } from "@biolinx/core";
import { renderFor, stepSummary, suggestReplyKind } from "../src/outreach-conversation.js";

describe("outreach flow messages", () => {
  const settings = { ...DEFAULT_OUTREACH_SETTINGS, detailsLink: "https://biolinxlabs.com/affiliates", aroDetailsLink: "https://example.org/aro", aroCommission: "25% on every order", aroCookie: "lifetime" };
  const lead = { id: 2, firstName: "Jamie", geoCountry: "US", emailProvenance: null, followUpsSent: 0 };

  it("every default template, with every opening line, passes the compliance linter once links are set", () => {
    for (const id of Object.keys(DEFAULT_TEMPLATES) as TemplateId[]) {
      for (let gap = 0; gap < settings.gaps.length; gap++) {
        const r = renderFor(id, { ...lead, followUpsSent: id.startsWith("offer") ? 0 : 1 }, "Amino Club", "Raza Khan", settings, gap);
        expect({ id, gap, blocked: r.blocked, violations: r.violations.filter((v) => v.severity === "block") }).toEqual({ id, gap, blocked: false, violations: [] });
      }
    }
  });

  it("a message that still needs a link can't be marked ready", () => {
    const r = renderFor("reply2_details", { ...lead, followUpsSent: 1 }, "Amino Club", "Raza", DEFAULT_OUTREACH_SETTINGS, 0);
    expect(r.missing).toEqual(["details link"]);
    expect(r.blocked).toBe(true);
  });

  it("summarises a step for the table", () => {
    expect(stepSummary({ kind: "send", templateId: "offer1_soft", alternatives: [], why: "" })).toMatchObject({ kind: "send", label: "Send: Offer 1 · soft" });
    expect(stepSummary({ kind: "wait", since: new Date(0), dueAt: new Date(86_400_000), lastTemplateId: "offer1_soft", why: "" })).toMatchObject({ kind: "wait", dueAt: "1970-01-02T00:00:00.000Z" });
  });
});

describe("reply suggestion", () => {
  it("uses keywords when sure, and asks the model only when unsure", async () => {
    const calls: string[] = [];
    const llm = { complete: async (_s: string, u: string) => (calls.push(u), '{"kind":"tell_me_more","reason":"asks about payout"}') };
    expect(await suggestReplyKind("no thanks", { lastMessageLabel: "Offer 1 · soft" }, llm)).toMatchObject({ kind: "no", source: "keywords" });
    expect(calls).toHaveLength(0);
    expect(await suggestReplyKind("hmm maybe, payouts how", { lastMessageLabel: "Offer 1 · soft" }, llm)).toMatchObject({ kind: "tell_me_more", source: "ai" });
    expect(await suggestReplyKind("🙂", { lastMessageLabel: null }, null)).toMatchObject({ kind: "no_info", source: "keywords" });
    const broken = { complete: async () => "not json" };
    expect(await suggestReplyKind("🙂", { lastMessageLabel: null }, broken)).toMatchObject({ kind: "no_info", source: "keywords" });
  });
});

describe("where to reach a lead", () => {
  const base = { primaryPlatform: "TikTok", socialProfiles: null, whereFound: null, firstName: "Aaron", lastName: "Homoki" };
  it("uses any handle we have, a TikTok post link, or else a name search; never a website", async () => {
    const { dmTargetFor } = await import("../src/outreach-conversation.js");
    expect(dmTargetFor({ ...base, socialProfiles: "TikTok @jaws" })).toEqual({ url: "https://www.tiktok.com/@jaws", kind: "profile", handle: "jaws" });
    expect(dmTargetFor(base, ["tiktok:aaronjaws"])).toMatchObject({ url: "https://www.tiktok.com/@aaronjaws", kind: "profile" });
    expect(dmTargetFor({ ...base, whereFound: "https://www.tiktok.com/@jawsclips/video/1" })).toMatchObject({ kind: "profile", handle: "jawsclips" });
    expect(dmTargetFor({ ...base, primaryPlatform: "Instagram", firstName: "Aaron 'Jaws'" })).toMatchObject({ kind: "search", url: expect.stringContaining("instagram.com/explore/search") });
    expect(dmTargetFor({ ...base, primaryPlatform: "YouTube" })).toBeNull();
  });

  it("opens an Instagram chat directly and keeps the profile to check it's them", async () => {
    const { dmTargetFor, messageLinkFor } = await import("../src/outreach-conversation.js");
    expect(dmTargetFor({ ...base, primaryPlatform: "Instagram", socialProfiles: "Instagram @drnadolsky" })).toEqual({
      url: "https://ig.me/m/drnadolsky",
      kind: "message",
      handle: "drnadolsky",
      profileUrl: "https://www.instagram.com/drnadolsky/",
    });
    // Only Instagram has a message link; a name Instagram couldn't have falls back to the profile.
    expect(messageLinkFor("TikTok", "jaws")).toBeNull();
    expect(messageLinkFor("Instagram", "bad-name")).toBeNull();
    expect(dmTargetFor({ ...base, primaryPlatform: "Instagram", socialProfiles: "Instagram @bad-name" })).toMatchObject({ kind: "profile", url: "https://www.instagram.com/bad-name/" });
  });
});
