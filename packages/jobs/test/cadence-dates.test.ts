import { describe, expect, it } from "vitest";
import { maxTouchesFor, nextFollowUpDateAfterSend, todayInTz } from "../src/cadence-dates.js";

describe("todayInTz", () => {
  it("uses the business calendar date, not UTC", () => {
    // 2026-09-09T05:30Z is still 2026-09-08 in Los Angeles.
    const d = todayInTz("America/Los_Angeles", new Date("2026-09-09T05:30:00Z"));
    expect(d.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("nextFollowUpDateAfterSend", () => {
  const now = new Date("2026-09-08T20:00:00Z");
  it("cold motion A: opener → +4 days", () => {
    expect(nextFollowUpDateAfterSend("A", 1, now, "UTC")?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
  it("cold motion A: touch 4 is the last → null", () => {
    expect(nextFollowUpDateAfterSend("A", 4, now, "UTC")).toBeNull();
  });
  it("warm motion B: opener → +10 days, touch 7 → +30", () => {
    expect(nextFollowUpDateAfterSend("B", 1, now, "UTC")?.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(nextFollowUpDateAfterSend("B", 7, now, "UTC")?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
});

describe("maxTouchesFor", () => {
  it("is 4 for cold and 12 for warm", () => {
    expect(maxTouchesFor("A")).toBe(4);
    expect(maxTouchesFor("B")).toBe(12);
  });
});
