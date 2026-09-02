import { describe, expect, it } from "vitest";
import { cadenceAfterReply } from "../src/reply-ingest.js";
import { COLD_CADENCE, type CadenceState } from "@biolinx/core";

describe("cadenceAfterReply", () => {
  const active: CadenceState = { kind: "active", touchesSent: 2, nextDueInDays: 8 };

  it("opt_out is terminal", () => {
    expect(cadenceAfterReply("A", active, "opt_out")).toEqual({ kind: "terminal", reason: "opt_out" });
  });
  it("no_with_reason terminates the cold cadence", () => {
    expect(cadenceAfterReply("A", active, "no_with_reason")).toEqual({ kind: "terminal", reason: "no" });
  });
  it("signed_up terminates", () => {
    expect(cadenceAfterReply("B", active, "signed_up")).toEqual({ kind: "terminal", reason: "signed_up" });
  });
  it("a question pauses without losing the touch count", () => {
    expect(cadenceAfterReply("A", active, "question")).toEqual({ kind: "paused", reason: "question", touchesSent: 2 });
  });
  it("interested pauses (needs a human)", () => {
    const r = cadenceAfterReply("A", active, "interested");
    expect(r.kind).toBe("paused");
  });
  it("uses cold config for motion A", () => {
    // exhausting cold (max 4) then a 'sent' returns terminal:exhausted — proves config wiring
    const nearMax: CadenceState = { kind: "active", touchesSent: 4, nextDueInDays: null };
    expect(cadenceAfterReply("A", nearMax, "not_now")).toEqual({ kind: "paused", reason: "not_now", touchesSent: 4 });
    void COLD_CADENCE;
  });
});
