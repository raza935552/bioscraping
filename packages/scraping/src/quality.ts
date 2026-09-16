// Quality gates for sourced candidates, learned from the first live run
// (2026-09-14): Spanish and Norwegian creators, dead accounts, and off-niche
// videos surfaced by competitor-name hashtags took review slots. Gates run
// twice: on the free search row before paying for a profile read, and on the
// full profile read before a lead is written. Deterministic, never an LLM.

import type { DiscoveryHit } from "./discovery/types.js";

/** "followers": outside the audience's follower range once the profile read shows the real count
 *  (Instagram search rows carry no follower count, so the range can only be checked after the read). */
/** "country": evidence places the creator outside the audience's countries (see country.ts).
 *  "no_read": the profile read failed or found nothing, so reach and activity can't be verified.
 *  "weak_reach": recent posts reach a tiny share of the followers (bought, stale or dying reach). */
export type QualityReason = "non_english" | "dead" | "off_niche" | "followers" | "country" | "no_read" | "weak_reach" | "no_mention";

/** Lowercase letters and digits only: "#WeightLoss" and "weight loss" both → "weightloss". */
export function compact(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

const EN = new Set(
  "the and to of in is you for it this my with on that your me be are how what just so can do have not but we all get if will was they when about out one like from more who im its dont".split(" "),
);
// Common function words in the languages that showed up, excluding words that are also English.
const FOREIGN = new Set(
  [
    // Spanish / Portuguese
    "el la los las que y un una por para con es tus sus más mas como pero lo del al qué sí también muy está esta este son su cuando de hoy você não uma isso mais são seu sua ele ela",
    // Norwegian / Danish / Swedish
    "og er det som jeg ikke til på med et har dette denne kommer mulig etter hvert eller och att inte på är",
    // German / Dutch
    "und der die das ist nicht mit ich sie ein eine auch wird sind het een niet voor zijn",
    // French / Italian
    "les et est pas pour avec une des vous je nous sont dans il elle che non per sono della gli",
    // Indonesian / Malay (live 2026-09-14: an Indonesian anti-aging doctor passed)
    "yang dan untuk dengan ini itu tidak ada kamu aku kita ke dari juga bisa sudah akan atau karena saya dokter kulit",
    // Turkish
    "ve bir bu için ile çok ama gibi daha ben sen olan değil nasıl şey",
    // more Swedish / Danish / Norwegian / Dutch
    "jag inte också mig min mitt hur vad mycket ikke også meget hvad ik maar ook wat heb",
  ].join(" ").split(" "),
);

/** True when the text is clearly not English: mostly non-Latin script, or foreign
 *  function words clearly outnumber English ones. Short or mixed text is not flagged. */
export function looksNonEnglish(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/https?:\/\/\S+|[#@][\p{L}\p{N}_.]+/gu, " ");
  const letters = t.match(/\p{L}/gu) ?? [];
  if (letters.length >= 20) {
    const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
    if (nonLatin / letters.length > 0.3) return true;
  }
  const words = t.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return false;
  let en = 0;
  let foreign = 0;
  let accented = 0;
  for (const w of words) {
    if (EN.has(w)) en++;
    else if (FOREIGN.has(w)) foreign++;
    if (/[ñáéíóúãõçàèìòùâêôøåæß¿¡]/.test(w)) accented++;
  }
  if (foreign >= 3 && foreign > en * 1.5) return true;
  // Accented words are rare in English captions; several of them plus little English is decisive.
  return accented >= 3 && accented + foreign > en * 1.5;
}

/** Each word or hashtag in the text, compacted. Matching inside one token only: squashing the
 *  whole text made "informatION PEPTIDEs" look like the competitor "Ion Peptide". */
export function compactTokens(text: string): string[] {
  return text.split(/\s+/).map(compact).filter(Boolean);
}

/** First match term present in the text, matching hashtags too ("weight loss" finds #weightloss). */
export function findTerm(text: string | null | undefined, terms: string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let tokens: string[] | null = null;
  for (const raw of terms) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (lower.includes(t)) return raw.trim();
    const c = compact(t);
    if (c.length < 5 || !/\s/.test(t)) continue; // single words are already covered by the plain match
    tokens ??= compactTokens(text);
    if (tokens.some((tok) => tok.includes(c))) return raw.trim();
  }
  return null;
}

const STORE_BIO = /\b(shop now|order now|our products|free shipping|wholesale|we ship|buy now|add to cart|in stock|restock)\b/i;
// Businesses that passed as creators on 2026-09-14: an EMS studio, a clinic, a TRT clinic, a gym, a software company.
const BUSINESS_HANDLE = /(gym|clinic|studio|medspa|spa$|pharmacy|dental|physio|chiropractic)/;
// Deliberately narrow: doctors who mention "my clinic" are good creators, so a bare "clinic" doesn't count.
const BUSINESS_BIO = /\b(med ?spa|fitness studio|ems studio|boutique studio|our (team|clinic|studio|gym|services|patients|members|location)|book (a|your) (consult|consultation|appointment|session)|book now|appointments? available|now open|call (us|now)|franchise|care for (men|women) in|human operating system)\b/i;
// Instagram business categories that are places or sellers, not people who make content.
const BUSINESS_CATEGORY = /(gym|fitness center|clinic|medical center|hospital|dentist|pharmacy|spa|salon|shopping|retail|store|brand|product|company|restaurant|supplement|med ?spa|wellness center|doctor's office)/i;
/** A seller or business account rather than a creator: store-like or business-like handle, storefront or clinic
 *  language in the bio, or an Instagram business category that is a place or seller. */
export function looksLikeStore(handle: string, bio: string | null | undefined, businessCategory?: string | null): boolean {
  const h = handle.toLowerCase();
  const b = bio ?? "";
  return (
    /\.(com|co|shop|store|net)$/.test(h) ||
    /(shop|store)/.test(h) ||
    BUSINESS_HANDLE.test(h) ||
    STORE_BIO.test(b) ||
    BUSINESS_BIO.test(b) ||
    (!!businessCategory && BUSINESS_CATEGORY.test(businessCategory))
  );
}

/** No post in this many days = dead. Was 180; the lead score already treats 30 days as active. */
export const DEAD_AFTER_DAYS = 60;

/** Lowest typical views per follower before reach counts as not real. From the 47-lead review
 *  (2026-09-15): 12 of 23 rejected leads looked big but reached almost nobody (466K followers,
 *  526 typical views). Healthy leads in the same batch got 1% to 120% of followers as views.
 *  Instagram's reader returns no view counts, so it isn't checked here. */
export const REACH_FLOOR: Partial<Record<string, number>> = { tiktok: 0.005, youtube: 0.01 };
/** Fewer posts with view counts than this and the check is skipped: too little to judge. */
export const REACH_MIN_POSTS = 5;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Typical (median) views of recent posts ÷ followers, and whether that is below the platform's floor. */
export function reachCheck(platform: string, followers: number | null | undefined, items: Array<{ views?: number | null }>): { medianViews: number | null; viewsPerFollower: number | null; weak: boolean } {
  // 0 means "not reported" in practice: YouTube's reader returned 0 for a 194K channel whose other posts had ~9.5K views.
  const views = items.map((i) => i.views).filter((v): v is number => typeof v === "number" && v > 0);
  const medianViews = views.length >= REACH_MIN_POSTS ? median(views) : null;
  const viewsPerFollower = medianViews != null && followers && followers > 0 ? medianViews / followers : null;
  const floor = REACH_FLOOR[platform];
  return { medianViews, viewsPerFollower, weak: floor != null && viewsPerFollower != null && viewsPerFollower < floor };
}

export interface GateInput {
  hit: DiscoveryHit;
  /** Present after the profile read; null before it, or when the read failed. */
  verified: { bio: string | null; lastPostAt: string | null; followers?: number | null; items: Array<{ text: string; views?: number | null }> } | null;
  matchTerms: string[];
  language: string;
  /** A competitor was detected in the same text (counts as on-niche). */
  competitorFound: boolean;
  now: Date;
}

/** Why this candidate should not become a lead, or null when it passes. */
export function qualityGate(input: GateInput): QualityReason | null {
  const { hit, verified, matchTerms, language, competitorFound, now } = input;
  const corpus = [hit.bio, hit.postText, verified?.bio, ...(verified?.items.map((i) => i.text) ?? [])].filter(Boolean).join("\n");

  if (language.toLowerCase().startsWith("en") && looksNonEnglish(corpus)) return "non_english";

  // Hashtag search surfaces old top posts from creators who are still active, so "dead"
  // is decided only from a profile read (see deadWithoutRead for a failed read).
  if (verified?.lastPostAt) {
    const days = (now.getTime() - new Date(verified.lastPostAt).getTime()) / 86_400_000;
    if (Number.isFinite(days) && days > DEAD_AFTER_DAYS) return "dead";
  }

  if (matchTerms.length > 0 && !competitorFound && !findTerm(corpus, matchTerms)) return "off_niche";
  if (verified && reachCheck(hit.platform, verified.followers, verified.items).weak) return "weak_reach";
  return null;
}

/** The dead check for a candidate whose profile read failed: the surfaced post is all we have. */
export function deadWithoutRead(hit: DiscoveryHit, now: Date): boolean {
  if (!hit.postedAt) return false;
  const days = (now.getTime() - new Date(hit.postedAt).getTime()) / 86_400_000;
  return Number.isFinite(days) && days > DEAD_AFTER_DAYS;
}
