// Turns the cadence engine's "days until next touch" into a concrete
// next_follow_up_date in the business timezone (D6: America/Los_Angeles).

import { COLD_CADENCE, WARM_CADENCE, nextDue, type CadenceConfig } from "@biolinx/core";

export type Motion = "A" | "B";

export function cadenceFor(motion: Motion): CadenceConfig {
  return motion === "B" ? WARM_CADENCE : COLD_CADENCE;
}

export function maxTouchesFor(motion: Motion): number {
  return cadenceFor(motion).maxTouches;
}

/** UTC midnight of the calendar date `now` falls on in `tz`. */
export function todayInTz(tz: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${parts}T00:00:00Z`);
}

/** Date the next touch becomes due after touch `touchNumber` was sent, or
 *  null when the cadence is exhausted. */
export function nextFollowUpDateAfterSend(
  motion: Motion,
  touchNumber: number,
  now = new Date(),
  tz = process.env.BUSINESS_TZ ?? "America/Los_Angeles",
): Date | null {
  const days = nextDue(cadenceFor(motion), touchNumber);
  if (days == null) return null;
  const d = todayInTz(tz, now);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
