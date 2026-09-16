import { describe, expect, it } from "vitest";
import { nextOutreachStep, variantFor, type FlowEvent, type TemplateId } from "../src/outreach-flow.js";
import { DEFAULT_OUTREACH_SETTINGS, gapIndexFor, outreachSettings, renderTemplate } from "../src/outreach-templates.js";

const t0 = new Date("2026-09-16T12:00:00Z");
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const opts = { checkinDays: 3, maxNoReplyCheckins: 2, variant: "soft" as const };
const sent = (templateId: TemplateId, d: number): FlowEvent => ({ type: "sent", templateId, at: day(d) });
const reply = (kind: "yes" | "tell_me_more" | "no" | "no_info", d: number): FlowEvent => ({ type: "reply", kind, at: day(d) });
const next = (path: "offer1" | "offer2", events: FlowEvent[], now = day(1)) => nextOutreachStep(path, events, now, opts);

describe("outreach flow chart", () => {
  it("starts with Offer 1 or Offer 2, soft or direct, and never messages unqualified leads", () => {
    expect(next("offer1", [])).toMatchObject({ kind: "send", templateId: "offer1_soft", alternatives: ["offer1_direct"] });
    expect(nextOutreachStep("offer2", [], t0, { ...opts, variant: "direct" })).toMatchObject({ kind: "send", templateId: "offer2_direct" });
    expect(nextOutreachStep("unsigned", [], t0, opts)).toMatchObject({ kind: "done", outcome: "not_qualified" });
    expect([variantFor(2), variantFor(3)]).toEqual(["soft", "direct"]);
  });

  it("Offer 1 branch: yes → sign-up ask → details received; tell me more → details; no → recruitment + Aro → Aro replies", () => {
    expect(next("offer1", [sent("offer1_soft", 0), reply("yes", 1)])).toMatchObject({ templateId: "reply1_signup" });
    expect(next("offer1", [sent("offer1_soft", 0), reply("yes", 1), sent("reply1_signup", 1), reply("yes", 2)])).toMatchObject({ kind: "signup" });
    expect(next("offer1", [sent("offer1_direct", 0), reply("tell_me_more", 1)])).toMatchObject({ templateId: "reply2_details" });
    expect(next("offer1", [sent("offer1_direct", 0), reply("tell_me_more", 1), sent("reply2_details", 1), reply("no", 2)])).toMatchObject({ templateId: "recruit_aro" });
    expect(next("offer1", [sent("offer1_soft", 0), reply("no", 1)])).toMatchObject({ templateId: "recruit_aro" });
    const afterRecruit = [sent("offer1_soft", 0), reply("no", 1), sent("recruit_aro", 1)];
    expect(next("offer1", [...afterRecruit, reply("yes", 2)])).toMatchObject({ templateId: "reply1b_aro_signup", alternatives: ["reply1_signup"] });
    expect(next("offer1", [...afterRecruit, reply("tell_me_more", 2)])).toMatchObject({ templateId: "reply2b_aro_details" });
    expect(next("offer1", [...afterRecruit, reply("no", 2)])).toMatchObject({ templateId: "reply3_aro_referral" });
    expect(next("offer1", [...afterRecruit, reply("tell_me_more", 2), sent("reply2b_aro_details", 2), reply("no", 3)])).toMatchObject({ templateId: "reply3_aro_referral" });
    expect(next("offer1", [...afterRecruit, reply("no", 2), sent("reply3_aro_referral", 2)], day(9))).toMatchObject({ kind: "done", outcome: "declined" });
  });

  it("Offer 2 branch: no → referral ask; tell me more → details", () => {
    expect(next("offer2", [sent("offer2_soft", 0), reply("no", 1)])).toMatchObject({ templateId: "reply3_referral" });
    expect(next("offer2", [sent("offer2_soft", 0), reply("tell_me_more", 1), sent("reply2_details", 1), reply("no", 2)])).toMatchObject({ templateId: "reply3_referral" });
  });

  it("check-ins: replied without details, and no reply after the wait (twice, then closed)", () => {
    expect(next("offer1", [sent("offer1_soft", 0), reply("yes", 1), sent("reply1_signup", 1), reply("no_info", 2)])).toMatchObject({ templateId: "checkin_no_info" });
    // A reply after a check-in is read against the stage before it.
    expect(next("offer1", [sent("reply1_signup", 1), reply("no_info", 2), sent("checkin_no_info", 2), reply("yes", 3)])).toMatchObject({ kind: "signup" });
    expect(next("offer1", [sent("offer1_soft", 0)], day(2))).toMatchObject({ kind: "wait" });
    expect(next("offer1", [sent("offer1_soft", 0)], day(3))).toMatchObject({ kind: "send", templateId: "checkin_no_reply" });
    expect(next("offer1", [sent("offer1_soft", 0), sent("checkin_no_reply", 3)], day(6))).toMatchObject({ templateId: "checkin_no_reply" });
    expect(next("offer1", [sent("offer1_soft", 0), sent("checkin_no_reply", 3), sent("checkin_no_reply", 6)], day(9))).toMatchObject({ kind: "done", outcome: "no_reply" });
    expect(next("offer1", [sent("offer1_soft", 0), sent("checkin_no_reply", 3), reply("yes", 4)])).toMatchObject({ templateId: "reply1_signup" });
  });
});

describe("templates", () => {
  const base = { recruiterName: "Raza Khan", brand: "Amino Club", creatorFirstName: "Jamie", settings: DEFAULT_OUTREACH_SETTINGS };
  it("fills the opening line, first names, brand; keeps the copy's own brackets; lists missing values", () => {
    const r = renderTemplate("offer2_soft", { ...base, curiosityGap: "don't tell [brand] about this..." });
    expect(r.text.split("\n")[0]).toBe("don't tell Amino Club about this...");
    expect(r.text).toContain("I'm Raza, a Biolinx partner recruiter, and we saw that you're working with Amino Club.");
    expect(renderTemplate("offer1_soft", { ...base, curiosityGap: "want to make more money?" }).text.split("\n")[0]).toBe("want to make more money?");
    expect(renderTemplate("offer1_soft", { ...base, curiosityGap: "we can give you more" }).text.split("\n")[0]).toBe("we can give you more.");
    const signup = renderTemplate("reply1_signup", { ...base, curiosityGap: "x" });
    expect(signup.text).toContain("[name or nickname] + [last name initial] + 10");
    expect(signup.text).toContain("Welcome to the team Jamie!");
    expect(renderTemplate("reply2_details", { ...base, curiosityGap: "x" }).missing).toEqual(["details link"]);
    expect(renderTemplate("reply2_details", { ...base, curiosityGap: "x", settings: { ...DEFAULT_OUTREACH_SETTINGS, detailsLink: "https://biolinxlabs.com/affiliates" } }).missing).toEqual([]);
  });
  it("edited templates override defaults; junk settings fall back", () => {
    const s = outreachSettings({ templates: { offer1_soft: "hey [first name]", nope: "x" }, gaps: [{ kind: "bad", text: "x" }], checkinDays: 99 });
    expect(renderTemplate("offer1_soft", { ...base, curiosityGap: "x", settings: s }).text).toBe("hey Jamie");
    expect(s.gaps.length).toBe(7);
    expect(s.checkinDays).toBe(3);
    expect(gapIndexFor(10, 7)).toBe(5);
  });
});

describe("unclear replies at each stage", () => {
  it("offers details at an offer, nudges at a sign-up ask, and stops after a referral ask", () => {
    expect(next("offer1", [sent("offer1_soft", 0), reply("no_info", 1)])).toMatchObject({ templateId: "reply2_details" });
    expect(next("offer1", [sent("offer1_soft", 0), reply("no", 1), sent("recruit_aro", 1), reply("no_info", 2)])).toMatchObject({ templateId: "reply2b_aro_details" });
    expect(next("offer1", [sent("reply1_signup", 1), reply("no_info", 2)])).toMatchObject({ templateId: "checkin_no_info" });
    expect(next("offer2", [sent("offer2_soft", 0), reply("no", 1), sent("reply3_referral", 1), reply("no_info", 2)])).toMatchObject({ kind: "done", outcome: "declined" });
  });
});
