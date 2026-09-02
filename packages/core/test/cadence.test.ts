import { describe, expect, it } from "vitest";
import {
  COLD_CADENCE,
  WARM_CADENCE,
  nextDue,
  transition,
  type CadenceState,
} from "../src/cadence.js";

describe("warm cadence (Motion B, 12 touches)", () => {
  it("first follow-up is due 10 days after the opener", () => {
    const afterOpener = transition(WARM_CADENCE, { kind: "active", touchesSent: 0, nextDueInDays: null }, { type: "sent" });
    expect(afterOpener).toEqual({ kind: "active", touchesSent: 1, nextDueInDays: 10 });
  });

  it("exhausts at 12 touches", () => {
    let state: CadenceState = { kind: "active", touchesSent: 0, nextDueInDays: null };
    for (let i = 0; i < 12; i++) state = transition(WARM_CADENCE, state, { type: "sent" });
    expect(state).toEqual({ kind: "terminal", reason: "exhausted" });
  });

  it("silence never terminates early — 11 sends still active", () => {
    let state: CadenceState = { kind: "active", touchesSent: 0, nextDueInDays: null };
    for (let i = 0; i < 11; i++) state = transition(WARM_CADENCE, state, { type: "sent" });
    expect(state.kind).toBe("active");
  });
});

describe("cold cadence (Motion A, provisional 4 touches)", () => {
  it("terminates after maxTouches", () => {
    let state: CadenceState = { kind: "active", touchesSent: 0, nextDueInDays: null };
    for (let i = 0; i < 4; i++) state = transition(COLD_CADENCE, state, { type: "sent" });
    expect(state).toEqual({ kind: "terminal", reason: "exhausted" });
  });
});

describe("reply handling", () => {
  const active: CadenceState = { kind: "active", touchesSent: 2, nextDueInDays: 9 };

  it("explicit no is terminal", () => {
    expect(transition(WARM_CADENCE, active, { type: "reply", replyClass: "no" })).toEqual({
      kind: "terminal",
      reason: "no",
    });
  });

  it("opt-out is terminal (suppression also blocks channel switching upstream)", () => {
    expect(transition(WARM_CADENCE, active, { type: "reply", replyClass: "opt_out" })).toEqual({
      kind: "terminal",
      reason: "opt_out",
    });
  });

  it("a question pauses without losing touch count, resume continues the clock", () => {
    const paused = transition(WARM_CADENCE, active, { type: "reply", replyClass: "question" });
    expect(paused).toEqual({ kind: "paused", reason: "question", touchesSent: 2 });
    const resumed = transition(WARM_CADENCE, paused, { type: "resolved" });
    expect(resumed).toEqual({ kind: "active", touchesSent: 2, nextDueInDays: nextDue(WARM_CADENCE, 2) });
  });

  it("terminal states absorb every later event", () => {
    const done: CadenceState = { kind: "terminal", reason: "signed_up" };
    expect(transition(WARM_CADENCE, done, { type: "sent" })).toEqual(done);
  });
});
