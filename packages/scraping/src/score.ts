// Jakob's scoring criteria (sourcing spec §5), deterministic. Every point
// has a reason string so the reviewer sees why. Unknown signals are null,
// never false: only a human marks LIVE / promo / original as false.

import type { DiscoveryHit } from "./discovery/types.js";
import { hasTerm } from "./filter.js";

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
  for (const c of competitors) {
    if (c.domains.some((d) => d.trim() && lower.includes(d.trim().toLowerCase()))) return { code: null, competitor: c };
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
