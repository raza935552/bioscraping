// Conversion Rank — reimplementation of the client's 2026-08-09 overnight run,
// per airtable/ranking-spec.md and the Conversion Rank field description.
//
// Bands (ascending = contact first):
//   1  Unsigned + verified reach (Total Reach present)
//   2  Unsigned + reach unverified (blank — blank is a SENTINEL, never 0)
//   3  Signed + Diamond/Gold
//   3b Signed + Silver
//   4  Signed + Bronze
//   5  Uncovered by any spec rule (blank status / Signed with no tier) —
//      flagged for human triage rather than guessed into a band.
// Tiebreakers within a band: reach-per-person desc, then niche priority.
// SP5 leads ARE ranked (they're excluded at the outreach-queue layer, L4).

import { NICHE_PRIORITY, normalizeNiche, type AffiliationStatus, type EntryTier } from "./enums.js";

export interface RankInput {
  id: string;
  affiliationStatus: AffiliationStatus | string | null;
  totalReach: number | null; // null = unverified. NEVER default to 0.
  entryTier: EntryTier | string | null;
  niche: string | null; // raw label; normalized against NICHE_PRIORITY
  /** Divisor for brand/team accounts. Defaults to 1 (individual creator). */
  personCount?: number;
}

export type Band = "1" | "2" | "3" | "3b" | "4" | "5";

const BAND_ORDER: Record<Band, number> = { "1": 0, "2": 1, "3": 2, "3b": 3, "4": 4, "5": 5 };

/** "Our affiliate" = already converted — ranked last, excluded from outreach
 *  queues, and NOT a triage case. */
export function isConverted(affiliationStatus: string | null | undefined): boolean {
  return affiliationStatus?.trim().toLowerCase() === "our affiliate";
}

export function bandOf(lead: RankInput): Band {
  const status = lead.affiliationStatus?.trim().toLowerCase() ?? null;
  if (status === "unsigned") {
    return lead.totalReach != null ? "1" : "2";
  }
  // Ranking-spec's "Signed" is the live board's "Signed elsewhere".
  if (status === "signed" || status === "signed elsewhere") {
    if (lead.entryTier === "Diamond" || lead.entryTier === "Gold") return "3";
    if (lead.entryTier === "Silver") return "3b";
    if (lead.entryTier === "Bronze") return "4";
  }
  return "5"; // converted or uncovered — both sort last; triage flag differs
}

function reachPerPerson(lead: RankInput): number {
  if (lead.totalReach == null) return -1; // unverified sorts below any verified reach
  const persons = lead.personCount && lead.personCount > 0 ? lead.personCount : 1;
  return lead.totalReach / persons;
}

function nicheIndex(niche: string | null): number {
  const normalized = normalizeNiche(niche);
  if (normalized == null) return NICHE_PRIORITY.length; // unlisted/blank sorts last
  return NICHE_PRIORITY.indexOf(normalized);
}

export interface RankResult {
  id: string;
  band: Band;
  rank: number; // global ordinal, 1 = contact first
  needsTriage: boolean; // band 5 with no covering rule — human decides
  converted: boolean; // "Our affiliate" — ours already, not an outreach target
}

/**
 * Pure global ranking: assign band, order within band by reach-per-person
 * desc then niche priority, then stable by input order, and number the whole
 * list 1..N. Callers persist `rank` and diff-write only changed rows.
 */
export function rankAll(leads: RankInput[]): RankResult[] {
  const decorated = leads.map((lead, i) => ({
    lead,
    band: bandOf(lead),
    rpp: reachPerPerson(lead),
    niche: nicheIndex(lead.niche),
    stable: i,
  }));

  decorated.sort((a, b) => {
    const band = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (band !== 0) return band;
    if (a.rpp !== b.rpp) return b.rpp - a.rpp;
    if (a.niche !== b.niche) return a.niche - b.niche;
    return a.stable - b.stable;
  });

  return decorated.map((d, i) => {
    const converted = isConverted(d.lead.affiliationStatus);
    return {
      id: d.lead.id,
      band: d.band,
      rank: i + 1,
      needsTriage: d.band === "5" && !converted,
      converted,
    };
  });
}
