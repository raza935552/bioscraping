// Follow-up cadence state machines (per-motion, per-channel — a review
// finding: the 12-touch table is Motion B's WARM cadence; cold outreach gets
// a short cadence to protect deliverability).
//
// Rules that hold for every cadence:
// - A touch is BLOCKED while any unprocessed inbound exists for the lead.
// - Explicit "No" or opt-out is terminal (opt-out also blocks channel-switch).
// - Silence never terminates a warm cadence; it DOES terminate cold after
//   maxTouches.
// - Replied / question / not-now PAUSE the clock until resolved.

export interface CadenceConfig {
  /** Days after the previous touch at which touch N+1 becomes due. */
  intervals: number[];
  maxTouches: number;
  /** After this many silent touches on one channel, suggest switching. */
  channelSwitchAfterSilent?: number;
}

/** Motion B warm network — day 10, then 8–10d ×5 (we use 9), then monthly,
 *  12 touches max. Source: SOP.md / PROMPTS.md / TEMPLATES.md (consistent). */
export const WARM_CADENCE: CadenceConfig = {
  intervals: [10, 9, 9, 9, 9, 9, 30, 30, 30, 30, 30],
  maxTouches: 12,
  channelSwitchAfterSilent: 2,
};

/** Motion A cold — PROVISIONAL pending recovery of the reps' SOP.md timing
 *  table (Phase 0 item 6). 3–4 silent touches max per plan §4.2. */
export const COLD_CADENCE: CadenceConfig = {
  intervals: [4, 8, 12],
  maxTouches: 4,
  channelSwitchAfterSilent: 2,
};

export type CadenceState =
  | { kind: "active"; touchesSent: number; nextDueInDays: number | null }
  | { kind: "paused"; reason: "replied" | "question" | "not_now"; touchesSent: number }
  | { kind: "terminal"; reason: "no" | "opt_out" | "signed_up" | "exhausted" | "unreachable" };

export function nextDue(config: CadenceConfig, touchesSent: number): number | null {
  if (touchesSent >= config.maxTouches) return null;
  // intervals[0] gates touch #2 (the first follow-up after the opener).
  const interval = config.intervals[touchesSent - 1];
  return interval ?? null;
}

export interface CadenceEvent {
  type: "sent" | "reply" | "resolved" | "marked_unreachable";
  replyClass?: "interested" | "not_now" | "no" | "question" | "opt_out" | "signed_up";
}

export function transition(
  config: CadenceConfig,
  state: CadenceState,
  event: CadenceEvent,
): CadenceState {
  if (state.kind === "terminal") return state;

  switch (event.type) {
    case "sent": {
      // A 'sent' while paused is invalid (touches are blocked until the reply
      // is resolved) — preserve the paused state rather than resetting the clock.
      if (state.kind === "paused") return state;
      const touches = (state.kind === "active" ? state.touchesSent : 0) + 1;
      const due = nextDue(config, touches);
      if (due == null) return { kind: "terminal", reason: "exhausted" };
      return { kind: "active", touchesSent: touches, nextDueInDays: due };
    }
    case "reply": {
      const touches = state.kind === "active" || state.kind === "paused" ? state.touchesSent : 0;
      switch (event.replyClass) {
        case "no":
          return { kind: "terminal", reason: "no" };
        case "opt_out":
          return { kind: "terminal", reason: "opt_out" };
        case "signed_up":
          return { kind: "terminal", reason: "signed_up" };
        case "not_now":
          return { kind: "paused", reason: "not_now", touchesSent: touches };
        case "question":
          return { kind: "paused", reason: "question", touchesSent: touches };
        default:
          return { kind: "paused", reason: "replied", touchesSent: touches };
      }
    }
    case "resolved": {
      // A human or the objection engine finished handling the inbound;
      // cadence resumes where it left off.
      if (state.kind !== "paused") return state;
      return {
        kind: "active",
        touchesSent: state.touchesSent,
        nextDueInDays: nextDue(config, state.touchesSent),
      };
    }
    case "marked_unreachable":
      return { kind: "terminal", reason: "unreachable" };
  }
}
