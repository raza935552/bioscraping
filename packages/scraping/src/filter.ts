// Hard rejects applied before any paid verification read. Every reject is
// counted so the run summary explains where candidates went.

import type { DiscoveryHit, DiscoveryPlatform } from "./discovery/types.js";
import { findTerm } from "./quality.js";

export interface AudienceRules {
  followerMin: Partial<Record<DiscoveryPlatform, number>>;
  followerMax: Partial<Record<DiscoveryPlatform, number>>;
  countries: string[];
  language: string;
  excludeTerms: string[];
  excludeHandles: string[];
}

export type RejectReason = "excluded_handle" | "excluded_term" | "followers_low" | "followers_high" | "country";

/** D11: GLP-1-only creators are filtered at the door. Same names the
 *  compliance linter refuses in outbound copy. Editable per profile. */
export const DEFAULT_EXCLUDE_TERMS = ["semaglutide", "tirzepatide", "retatrutide", "ozempic", "wegovy", "mounjaro", "zepbound"];

/** First term found in the text, or null. Case-insensitive, and hashtag-aware:
 *  "weight loss" matches #weightloss (see findTerm). */
export function hasTerm(text: string | null | undefined, terms: string[]): string | null {
  return findTerm(text, terms);
}

export function applyFilters(hits: DiscoveryHit[], rules: AudienceRules): { kept: DiscoveryHit[]; rejected: Record<RejectReason, number> } {
  const rejected: Record<RejectReason, number> = { excluded_handle: 0, excluded_term: 0, followers_low: 0, followers_high: 0, country: 0 };
  const excluded = new Set(rules.excludeHandles.map((h) => h.trim().toLowerCase().replace(/^@/, "")));
  const kept: DiscoveryHit[] = [];
  for (const h of hits) {
    if (excluded.has(h.handle)) {
      rejected.excluded_handle++;
      continue;
    }
    if (hasTerm(h.bio, rules.excludeTerms)) {
      rejected.excluded_term++;
      continue;
    }
    const min = rules.followerMin[h.platform];
    const max = rules.followerMax[h.platform];
    if (h.followers != null && min != null && h.followers < min) {
      rejected.followers_low++;
      continue;
    }
    if (h.followers != null && max != null && h.followers > max) {
      rejected.followers_high++;
      continue;
    }
    if (h.country && rules.countries.length > 0 && !rules.countries.includes(h.country.toUpperCase())) {
      rejected.country++;
      continue;
    }
    kept.push(h);
  }
  return { kept, rejected };
}
