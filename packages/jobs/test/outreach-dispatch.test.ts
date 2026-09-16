import { describe, expect, it } from "vitest";
import { isDispatchCandidate, touchUpdate } from "../src/outreach-dispatch.js";

const lead = {
  id: 1,
  isDead: false,
  subProfile: "SP1 self-verifying veteran",
  affiliationStatus: "Signed elsewhere",
  competitorId: 7 as number | null,
  status: "Not contacted",
  email: "a@b.com",
  conversionRank: 5,
  nextFollowUpDate: null as Date | null,
  followUpsSent: 0,
  motion: "A",
  personalizationNotes: "MATCH — real detail (https://x/1).",
  sourcingReview: null as string | null,
};
const today = new Date("2026-09-08T00:00:00Z");
// Competitor 7 pays 20% (under our 25%): Offer 1. Competitor 8 pays 30%. Competitor 9 has no rate on file.
const competitorRates = new Map<number, number | null>([[7, 20], [8, 30], [9, null]]);

describe("isDispatchCandidate", () => {
  it("only competitor affiliates at or under our 25% get messages (outreach flow chart)", () => {
    const o = { channel: "dm" as const, today, openReplyLeadIds: new Set<number>(), competitorRates };
    expect(isDispatchCandidate(lead, o)).toBe("ok");
    expect(isDispatchCandidate({ ...lead, affiliationStatus: "Unsigned", competitorId: null }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, competitorId: 8 }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, competitorId: 9 }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, competitorId: null }, o)).toBe("ineligible");
  });
  it("accepts a ranked, alive, noted, uncontacted lead", () => {
    expect(isDispatchCandidate(lead, { channel: "dm", today, openReplyLeadIds: new Set(), competitorRates })).toBe("ok");
  });
  it("skips leads without usable notes (precondition, not a block)", () => {
    expect(isDispatchCandidate({ ...lead, personalizationNotes: null }, { channel: "dm", today, openReplyLeadIds: new Set(), competitorRates })).toBe("unenriched");
    expect(
      isDispatchCandidate({ ...lead, personalizationNotes: "NOT USABLE — nothing" }, { channel: "dm", today, openReplyLeadIds: new Set(), competitorRates }),
    ).toBe("unenriched");
  });
  it("skips SP5, dead, converted, terminal status, open reply, not-yet-due", () => {
    const o = { channel: "dm" as const, today, openReplyLeadIds: new Set<number>(), competitorRates };
    expect(isDispatchCandidate({ ...lead, subProfile: "SP5 goodwill advocate — DO NOT DM" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, isDead: true }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, affiliationStatus: "Our affiliate" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, status: "Passed" }, o)).toBe("ineligible");
    expect(isDispatchCandidate(lead, { ...o, openReplyLeadIds: new Set([1]) })).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, nextFollowUpDate: new Date("2026-09-09T00:00:00Z") }, o)).toBe("ineligible");
  });
  it("pending or rejected sourced leads are ineligible; accepted and non-sourced pass", () => {
    const o = { channel: "dm" as const, today, openReplyLeadIds: new Set<number>(), competitorRates };
    expect(isDispatchCandidate({ ...lead, sourcingReview: "pending" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, sourcingReview: "rejected" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, sourcingReview: "accepted" }, o)).toBe("ok");
    expect(isDispatchCandidate({ ...lead, sourcingReview: null }, o)).toBe("ok");
  });
  it("skips leads that exhausted their cadence", () => {
    expect(isDispatchCandidate({ ...lead, followUpsSent: 4, motion: "A" }, { channel: "dm", today, openReplyLeadIds: new Set(), competitorRates })).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, followUpsSent: 4, motion: "B" }, { channel: "dm", today, openReplyLeadIds: new Set(), competitorRates })).toBe("ok");
  });
  it("requires an email for the email channel", () => {
    expect(isDispatchCandidate({ ...lead, email: null }, { channel: "email", today, openReplyLeadIds: new Set(), competitorRates })).toBe("ineligible");
  });
});

describe("touchUpdate", () => {
  it("writes touch bookkeeping and the next follow-up date from the cadence", () => {
    const u = touchUpdate({ motion: "A" }, 1, "Email", new Date("2026-09-08T20:00:00Z"), "UTC");
    expect(u.followUpsSent).toBe(1);
    expect(u.status).toBe("Contacted");
    expect(u.contactChannel).toBe("Email");
    expect(u.nextFollowUpDate?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
  it("sets nextFollowUpDate null when exhausted", () => {
    expect(touchUpdate({ motion: "A" }, 4, "TikTok DM", new Date(), "UTC").nextFollowUpDate).toBeNull();
  });
});
