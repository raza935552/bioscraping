// Canonical enums. Sources: airtable/schema.json field descriptions,
// ranking-spec.md, diana-clock-in.md, PROMPTS.md (live form enums per D8).
// Airtable metadata export at migration time is the authority for any option
// list marked PARTIAL — extend, never reorder, the arrays below.

/** Niche priority order IS the ranking tiebreaker — index = priority.
 *  Live Airtable option labels (recovered from the metadata export
 *  2026-09-01) differ from the ranking-spec shorthand; normalizeNiche maps
 *  both vocabularies onto the canonical priority list. */
export const NICHE_PRIORITY = [
  "Longevity",
  "Biohacking",
  "Gym",
  "Women's Wellness",
  "Nootropics",
  "MMA",
] as const;
export type Niche = (typeof NICHE_PRIORITY)[number];

const NICHE_ALIASES: Record<string, Niche> = {
  "gym/bodybuilding": "Gym",
  "mma/combat": "MMA",
  "nootropics/cognitive": "Nootropics",
};

export function normalizeNiche(value: string | null | undefined): Niche | null {
  if (!value) return null;
  const v = value.trim();
  const direct = NICHE_PRIORITY.find((n) => n.toLowerCase() === v.toLowerCase());
  if (direct) return direct;
  return NICHE_ALIASES[v.toLowerCase()] ?? null;
}

/** Live enum: Unsigned | Signed elsewhere | Our affiliate.
 *  The ranking-spec's "Signed" means "Signed elsewhere". */
export const AFFILIATION_STATUSES = ["Unsigned", "Signed elsewhere", "Our affiliate"] as const;
export type AffiliationStatus = (typeof AFFILIATION_STATUSES)[number] | "Signed";

/** Live lead-board status enum (distinct from the Motion-B outreach enum). */
export const LEAD_STATUSES = ["Not contacted", "Contacted", "In talks", "Signed", "Passed"] as const;

/** Sub-Profile options are full labels ("SP5 goodwill advocate — DO NOT DM"). */
export function isSp5(subProfile: string | null | undefined): boolean {
  return !!subProfile && subProfile.trim().toUpperCase().startsWith("SP5");
}

export const ENTRY_TIERS = ["Diamond", "Gold", "Silver", "Bronze"] as const;
export type EntryTier = (typeof ENTRY_TIERS)[number];

/** Diana's clock-in doc enumerates these six; created 2026-08-28. */
export const CONTACT_CHANNELS = [
  "Instagram DM",
  "TikTok DM",
  "Facebook DM",
  "Reddit DM",
  "Email",
  "Other",
] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Live Motion-B form enum (D8): "Said no" maps to "No". */
export const OUTREACH_STATUSES = [
  "Reached out",
  "Replied",
  "Interested",
  "Not now",
  "No",
  "Signed up",
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/** SP5 is never cold-contacted — log and leave (hard guardrail L4). */
export const SUB_PROFILES = ["SP1", "SP2", "SP3", "SP4", "SP5"] as const;
export type SubProfile = (typeof SUB_PROFILES)[number];

export const USER_ROLES = ["admin", "ops", "rep", "operator"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const MESSAGE_STATES = [
  "drafted",
  "linted",
  "approved",
  "claimed",
  "sent",
  "logged",
  "blocked",
] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const REPLY_CLASSES = [
  "interested",
  "not_now",
  "no_with_reason",
  "question",
  "opt_out",
  "signed_up",
  "unclassifiable",
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

/** Deadline the whole program counts down to. */
export const BLACK_FRIDAY = "2026-11-27";
export const EXTERNAL_AFFILIATE_GOAL = 100;
