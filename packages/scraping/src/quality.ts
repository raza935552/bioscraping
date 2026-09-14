// Quality gates for sourced candidates, learned from the first live run
// (2026-09-14): Spanish and Norwegian creators, dead accounts, and off-niche
// videos surfaced by competitor-name hashtags took review slots. Gates run
// twice: on the free search row before paying for a profile read, and on the
// full profile read before a lead is written. Deterministic, never an LLM.

import type { DiscoveryHit } from "./discovery/types.js";

export type QualityReason = "non_english" | "dead" | "off_niche";

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
/** A seller account rather than a creator: store-like handle or storefront language in the bio. */
export function looksLikeStore(handle: string, bio: string | null | undefined): boolean {
  const h = handle.toLowerCase();
  return /\.(com|co|shop|store|net)$/.test(h) || /(shop|store)/.test(h) || STORE_BIO.test(bio ?? "");
}

export const DEAD_AFTER_DAYS = 180;

export interface GateInput {
  hit: DiscoveryHit;
  /** Present after the profile read; null before it, or when the read failed. */
  verified: { bio: string | null; lastPostAt: string | null; items: Array<{ text: string }> } | null;
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
  return null;
}

/** The dead check for a candidate whose profile read failed: the surfaced post is all we have. */
export function deadWithoutRead(hit: DiscoveryHit, now: Date): boolean {
  if (!hit.postedAt) return false;
  const days = (now.getTime() - new Date(hit.postedAt).getTime()) / 86_400_000;
  return Number.isFinite(days) && days > DEAD_AFTER_DAYS;
}
