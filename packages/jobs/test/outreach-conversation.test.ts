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
