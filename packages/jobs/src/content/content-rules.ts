// Pre-flight checks for posts bound for the Biolinx content library. Biolinx
// accepts anything that passes its text and image-text checks as a draft, so it is a
// compliance filter, not a quality judge: these rules mirror its rejections (so a
// post is fixed here instead of rejected there) and add our own compliance linter.

import { lint, RUO_LINE } from "@biolinx/compliance";
import { normalizeNiche } from "@biolinx/core";
import type { BiolinxFormat, BiolinxNiche, BiolinxPlatform, OutboundPost } from "./biolinx-client.js";

/** Biolinx's rejected claim words (API doc, 2026-09-15), matched with word stems so
 *  "treatment", "healing", "results" and "boosts" are caught the way they would be there. */
export const BIOLINX_CLAIM_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bcur(e|es|ed|ing)\b/i, "cure"],
  [/\btreat\w*/i, "treat"],
  [/\bheal\w*/i, "heal"],
  [/\brecover\w*/i, "recovery"],
  [/\bweight[\s-]?loss\b/i, "weight loss"],
  [/\bfat[\s-]?loss\b/i, "fat loss"],
  [/\blos(e|ing)\s+weight\b/i, "lose weight"],
  [/\bburn(s|ing)?\s+fat\b/i, "burn fat"],
  [/\bmuscle[\s-]?growth\b/i, "muscle growth"],
  [/\bbuild(s|ing)?\s+muscle\w*/i, "build muscle"],
  [/\bdos(e|es|ed|ing|age)\b/i, "dose/dosing/dosage"],
  [/\bprotocol\w*/i, "protocol"],
  [/\binject\w*/i, "inject"],
  [/\banti[\s-]?aging\b/i, "anti-aging"],
  [/\bresult\w*/i, "results"],
  [/\bbenefit\w*/i, "benefits"],
  [/\bboost\w*/i, "boost"],
  [/\bimprov\w*/i, "improve"],
  [/\benhanc\w*/i, "enhance"],
  [/\bperform\w*/i, "performance"],
  [/\benerg\w*/i, "energy"],
  [/\bsleep\s+better\b/i, "sleep better"],
  [/\blibido\b/i, "libido"],
  [/\bskin[\s-]?tighten\w*/i, "skin tightening"],
  [/\bwrinkle\w*/i, "wrinkles"],
];

export const BIOLINX_GLP_PATTERN =
  /\b(glp[\s-]?[13]|semaglutide|tirzepatide|retatrutide|cagrilintide|liraglutide|ozempic|wegovy|mounjaro|zepbound|rybelsus|saxenda)\b/i;

const HANDLE = /(^|[\s(])@[a-z0-9_.]{2,}/i;
const URL_OR_DOMAIN = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|shop|store|link|me|us|app|xyz|info|biz|ly|gg|tv))\b/gi;

export const BIOLINX_NICHE_FOR: Record<string, BiolinxNiche> = {
  "Weight-loss seeker": "metabolic",
  Biohacker: "research",
  "Gym / PED-curious": "fitness",
  "Anti-aging": "longevity",
  "Sexual wellness": "wellness",
};

export function biolinxNiche(ourNiche: string | null | undefined): BiolinxNiche {
  const n = normalizeNiche(ourNiche);
  return (n && BIOLINX_NICHE_FOR[n]) || "research";
}

export function biolinxPlatform(ours: string | null | undefined): BiolinxPlatform {
  const p = (ours ?? "").toLowerCase();
  if (p === "tiktok" || p === "instagram" || p === "youtube" || p === "facebook" || p === "x") return p;
  return "instagram";
}

/** Natural image shape for where a post is used. */
export function formatFor(platform: BiolinxPlatform): BiolinxFormat {
  return platform === "youtube" ? "thumbnail" : platform === "tiktok" ? "portrait" : "square";
}

export function cleanHashtags(tags: ReadonlyArray<string> | string | null | undefined): string[] {
  const list = typeof tags === "string" ? tags.split(/[\s,]+/) : [...(tags ?? [])];
  const out = new Set<string>();
  for (const t of list) {
    const clean = t.replace(/^#/, "").replace(/[^a-z0-9_]/gi, "");
    if (clean.length >= 2 && clean.length <= 40) out.add(clean.toLowerCase());
  }
  return [...out].slice(0, 12);
}

/** Adds the research-use line and #ad when the caption doesn't carry them, so our own
 *  linter passes and Biolinx doesn't have to append anything. */
export function withDisclosures(caption: string): string {
  let c = caption.trim();
  if (!c.includes(RUO_LINE)) c = `${c}\n\n${RUO_LINE}`;
  if (!/(^|\s)#ad\b/i.test(c)) c = `${c}\n#ad`;
  return c;
}

export const EXTERNAL_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Every reason Biolinx (or our linter) would refuse this post. Empty means it can be sent. */
export function preflight(post: Pick<OutboundPost, "external_id" | "hook" | "caption" | "hashtags"> & { image_url?: string | null; imageText?: string | null }): string[] {
  const reasons: string[] = [];
  if (!EXTERNAL_ID.test(post.external_id)) reasons.push("external_id has characters Biolinx refuses or is over 120 characters");
  if (!post.hook.trim()) reasons.push("hook is empty");
  if (post.hook.length > 120) reasons.push(`hook is ${post.hook.length} characters (max 120)`);
  if (post.caption.length > 2200) reasons.push(`caption is ${post.caption.length} characters (max 2200)`);
  const codes = post.caption.match(/\{CODE\}/g)?.length ?? 0;
  if (codes !== 1) reasons.push(`caption must contain {CODE} exactly once (found ${codes})`);
  if (/<[a-z/][^>]*>/i.test(post.caption)) reasons.push("caption contains HTML");

  const surfaces: Array<[string, string]> = [
    ["hook", post.hook],
    ["caption", post.caption.replace(RUO_LINE, " ")],
    ["hashtags", (post.hashtags ?? []).join(" ")],
    ["image text", post.imageText ?? ""],
  ];
  for (const [where, text] of surfaces) {
    if (!text) continue;
    const claims = BIOLINX_CLAIM_PATTERNS.filter(([re]) => re.test(text)).map(([, word]) => word);
    if (claims.length) reasons.push(`${where}: claim words not allowed: ${[...new Set(claims)].join(", ")}`);
    const glp = text.match(BIOLINX_GLP_PATTERN);
    if (glp) reasons.push(`${where}: GLP product name not allowed: ${glp[0]}`);
    if (HANDLE.test(text)) reasons.push(`${where}: @handles not allowed`);
    const sites = [...text.matchAll(URL_OR_DOMAIN)].map((m) => m[1]!.toLowerCase()).filter((d) => d !== "biolinxlabs.com" && !d.endsWith(".biolinxlabs.com"));
    if (sites.length) reasons.push(`${where}: outside websites not allowed: ${[...new Set(sites)].join(", ")}`);
  }

  const violations = lint(`${post.hook}\n${post.caption}\n${post.imageText ?? ""}`, { channel: "dm", touchNumber: 2, isPublic: true, audience: "affiliate" });
  for (const v of violations) if (v.severity === "block") reasons.push(`compliance ${v.rule}: ${v.detail}`);
  if (/[—–]/.test(`${post.hook}${post.caption}`)) reasons.push("em or en dash (reads as AI-written)");

  if (post.image_url != null) {
    try {
      const u = new URL(post.image_url);
      if (u.protocol !== "https:" || (u.port && u.port !== "443")) reasons.push("image_url must be https on port 443");
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":")) reasons.push("image_url must use a hostname, not an IP");
    } catch {
      reasons.push("image_url is not a valid URL");
    }
  }
  return reasons;
}

