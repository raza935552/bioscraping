// Jakob's scoring criteria (sourcing spec §5), deterministic. Every point
// has a reason string so the reviewer sees why. Unknown signals are null,
// never false: only a human marks LIVE / promo / original as false.

import type { DiscoveryHit } from "./discovery/types.js";
import { hasTerm } from "./filter.js";
import { compact, compactTokens, looksLikeStore } from "./quality.js";

export interface CompetitorRule {
  id: number;
  name: string;
  domains: string[];
  codePattern: string | null;
  codePrefix: string | null;
  commissionPct: number | null;
}

export interface VerifiedProfile {
  followers: number | null;
  bio: string | null;
  lastPostAt: string | null;
  items: Array<{ text: string; url: string }>;
  /** Share of recent items flagged as reposts; null when the platform says nothing. */
  isRepostRatio: number | null;
}

export interface ScoreRules {
  followerMin?: number;
  followerMax?: number;
  activityDays: number;
  matchTerms: string[];
  excludeTerms: string[];
}

export interface ScoreInput {
  hit: DiscoveryHit;
  verified: VerifiedProfile | null;
  rules: ScoreRules;
  competitors: CompetitorRule[];
  now: Date;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  competitor: CompetitorRule | null;
  affiliateCode: string | null;
  promoTrackRecord: true | null;
  contentOriginal: true | null;
  glp1Only: boolean;
}

export const PROMO_PATTERN = /(\d{1,2}\s?%\s?off|link in (my )?bio|#ad\b|#sponsored|use (my )?code|discount code|promo code|coupon|affiliate link)/i;

const CODE_TOKEN = /\b(?:(?:use\s+)?(?:my\s+)?code|use)\s*[:\-]?\s*([A-Z][A-Z0-9]{2,15})\b/gi;
const NOT_CODES = new Set(["CODE", "MY", "THE", "THIS", "LINK"]);

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** Index of a whole-word mention of `needle` (a name or domain) in lowercase text, or -1.
 *  A plural or possessive is allowed ("Ion Peptides", "Amino Club's"); a word that merely
 *  contains it is not ("informatION PEPTIDEs"). */
export function mentionIndex(lower: string, needle: string): number {
  const n = needle.trim().toLowerCase();
  if (!n) return -1;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?:'?s)?(?![\\p{L}\\p{N}])`, "u").exec(lower);
  return m ? m.index : -1;
}

/** A competitor code (by prefix or pattern) wins; a bare domain match is a
 *  weaker signal that still names the competitor. */
export function findAffiliateCode(text: string, competitors: CompetitorRule[]): { code: string | null; competitor: CompetitorRule } | null {
  const lower = text.toLowerCase();
  const tokens = [...text.matchAll(CODE_TOKEN)].map((m) => m[1]!.toUpperCase()).filter((t) => !NOT_CODES.has(t));
  for (const c of competitors) {
    const prefix = c.codePrefix?.trim().toUpperCase();
    const re = c.codePattern ? safeRegex(c.codePattern) : null;
    for (const t of tokens) {
      if ((prefix && t.startsWith(prefix) && t.length > prefix.length) || (re && re.test(t))) return { code: t, competitor: c };
    }
  }
  // Name or domain mention. Competitor codes are usually personal ("code JACOB at Amino
  // Club"), so a code within 80 characters of the mention is taken as theirs.
  const codeNear = (at: number): string | null => {
    for (const m of text.matchAll(CODE_TOKEN)) {
      const t = m[1]!.toUpperCase();
      if (!NOT_CODES.has(t) && Math.abs((m.index ?? 0) - at) <= 80) return t;
    }
    return null;
  };
  for (const c of competitors) {
    for (const raw of c.domains) {
      const at = mentionIndex(lower, raw);
      if (at >= 0) return { code: codeNear(at), competitor: c };
    }
  }
  // Hashtag spelling: "#offlinepeptides" or "#offlinepeptidesreview" for "Offline Peptides".
  // A word or hashtag must start with the squashed name; never matched across words.
  const words = compactTokens(text);
  for (const c of competitors) {
    const names = [c.name, ...c.domains].map((d) => compact(d.trim().replace(/\.[a-z]{2,}$/i, ""))).filter((t) => t.length >= 8);
    if (names.some((n) => words.some((w) => w.startsWith(n)))) return { code: null, competitor: c };
  }
  return null;
}

export function scoreHit(input: ScoreInput): ScoreResult {
  const { hit, verified, rules, competitors, now } = input;
  const reasons: string[] = [];
  let score = 0;
  const corpus = [hit.bio, hit.postText, verified?.bio, ...(verified?.items.map((i) => i.text) ?? [])].filter(Boolean).join("\n");

  const found = findAffiliateCode(corpus, competitors);
  if (found) {
    score += 30;
    reasons.push(`competitor affiliate: ${found.competitor.name} (+30)`);
    if (found.competitor.commissionPct != null) {
      if (found.competitor.commissionPct < 25) {
        score += 15;
        reasons.push(`their commission ${found.competitor.commissionPct}% < 25% (+15)`);
      } else {
        score += 5;
        reasons.push(`their commission ${found.competitor.commissionPct}% ≥ 25%, counter-offer angle (+5)`);
      }
    }
  }

  const followers = verified?.followers ?? null;
  if (followers != null && (rules.followerMin == null || followers >= rules.followerMin) && (rules.followerMax == null || followers <= rules.followerMax)) {
    score += 15;
    reasons.push(`verified reach ${followers.toLocaleString()} in range (+15)`);
  }

  const last = verified?.lastPostAt ? new Date(verified.lastPostAt) : null;
  if (last && !Number.isNaN(last.getTime())) {
    const days = (now.getTime() - last.getTime()) / 86_400_000;
    if (days <= rules.activityDays) {
      score += 15;
      reasons.push(`active, posted ${Math.round(days)}d ago (+15)`);
    } else {
      score -= 20;
      reasons.push(`dormant, last post ${Math.round(days)}d ago (−20)`);
    }
  }

  const promo = PROMO_PATTERN.test(corpus) || found?.code != null;
  if (promo) {
    score += 10;
    reasons.push("promo track record seen (+10)");
  }

  const original = verified?.isRepostRatio != null && verified.isRepostRatio === 0 ? true : null;
  if (original) {
    score += 5;
    reasons.push("original content, no reposts (+5)");
  }

  const onNiche = hasTerm(corpus, rules.matchTerms);
  if (onNiche) {
    score += 10;
    reasons.push(`on-niche: "${onNiche}" (+10)`);
  }

  const glp1 = hasTerm(corpus, rules.excludeTerms);
  const glp1Only = !!glp1 && !onNiche;
  if (glp1Only) {
    score -= 30;
    reasons.push(`GLP-1-only content: "${glp1}" (−30)`);
  }

  if (looksLikeStore(hit.handle, verified?.bio ?? hit.bio, (verified as { businessCategory?: string | null } | null)?.businessCategory)) {
    score -= 25;
    reasons.push("looks like a store, clinic or business, not a creator (−25)");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    competitor: found?.competitor ?? null,
    affiliateCode: found?.code ?? null,
    promoTrackRecord: promo ? true : null,
    contentOriginal: original,
    glp1Only,
  };
}
