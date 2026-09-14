import { describe, expect, it } from "vitest";
import { isRankable } from "../src/rank-recompute.js";

describe("isRankable", () => {
  it("ranks imported leads and accepted sourced leads, never pending or rejected ones", () => {
    expect(isRankable({ sourcingReview: null })).toBe(true);
    expect(isRankable({ sourcingReview: "accepted" })).toBe(true);
    expect(isRankable({ sourcingReview: "pending" })).toBe(false);
    expect(isRankable({ sourcingReview: "rejected" })).toBe(false);
  });
});
