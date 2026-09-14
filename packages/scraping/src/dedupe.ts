// The five dedupe keys (sourcing spec §6). The set is built once per run
// from leads, lead_handles, outreach_log, signups, and affiliates.

import { handleKey } from "@biolinx/core";
import type { DiscoveryHit } from "./discovery/types.js";

export interface KnownPeople {
  codes: Set<string>;
  handles: Set<string>;
  emails: Set<string>;
  urls: Set<string>;
  names: Set<string>;
}

export function emptyKnown(): KnownPeople {
  return { codes: new Set(), handles: new Set(), emails: new Set(), urls: new Set(), names: new Set() };
}

/** host + path, lowercase, no scheme/www/query/trailing slash. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function nameKey(name: string | null | undefined, platform: string): string | null {
  const n = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return n ? `${platform.toLowerCase()}|${n}` : null;
}

const LABELS: Array<[RegExp, string]> = [
  [/^(tiktok|tt)$/i, "tiktok"],
  [/^(instagram|insta|ig)$/i, "instagram"],
  [/^(youtube|yt)$/i, "youtube"],
  [/^reddit$/i, "reddit"],
  [/^(x|twitter)$/i, "x"],
  [/^skool$/i, "skool"],
];
const LABEL_WORD = /\b(tiktok|tt|instagram|insta|ig|youtube|yt|reddit|twitter|x|skool)\b/gi;

/** "TikTok" / "IG" / "YT" / "X" → canonical platform id, or null. */
export function platformOf(label: string | null | undefined): string | null {
  const l = (label ?? "").trim();
  for (const [re, p] of LABELS) if (re.test(l)) return p;
  return null;
}

const NOT_HANDLES: Record<string, Set<string>> = {
  instagram: new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts"]),
  x: new Set(["home", "i", "intent", "share", "search", "hashtag"]),
  skool: new Set(["discovery", "about", "signup", "login"]),
};
const URL_HANDLES: Array<[RegExp, string]> = [
  [/tiktok\.com\/@([\w.-]+)/gi, "tiktok"],
  [/instagram\.com\/([\w.]+)/gi, "instagram"],
  [/youtube\.com\/(?:@|c\/|user\/|channel\/)([\w.-]+)/gi, "youtube"],
  [/reddit\.com\/(?:user|u)\/([\w-]+)/gi, "reddit"],
  [/(?:\bx|twitter)\.com\/(\w+)/gi, "x"],
  [/skool\.com\/([\w-]+)/gi, "skool"],
];

function clean(handle: string): string {
  return handle.replace(/^@/, "").replace(/[.\-_]+$/, "").toLowerCase();
}

/** Every platform handle a free-text social_profiles cell names, as handle keys.
 *  Handles in profile URLs go to that URL's platform. "IG @ann" goes to the label.
 *  A bare "@ann" goes to every platform named in the same segment plus the lead's
 *  primary platform: over-matching only skips a lookalike, under-matching re-adds a person. */
export function handlesInText(text: string | null | undefined, primaryPlatform?: string | null): string[] {
  const keys = new Set<string>();
  const primary = platformOf(primaryPlatform);
  for (const segment of (text ?? "").split(/[;\n|]+/)) {
    const withoutUrls = segment.replace(/https?:\/\/\S+|\b[\w-]+\.(?:com|me|store|ee|gg|io)\/\S*/gi, (url) => {
      for (const [re, platform] of URL_HANDLES) {
        for (const m of url.matchAll(re)) {
          const h = clean(m[1]!);
          if (h && !NOT_HANDLES[platform]?.has(h)) keys.add(handleKey(platform, h));
        }
      }
      return " ";
    });
    const named = new Set<string>();
    for (const m of withoutUrls.matchAll(LABEL_WORD)) named.add(platformOf(m[1])!);
    const labelled = new Set<number>();
    for (const m of withoutUrls.matchAll(/\b(tiktok|tt|instagram|insta|ig|youtube|yt|reddit|twitter|x|skool)\b\s*[:\-]?\s*(?:@|u\/)([\w.]+)/gi)) {
      const h = clean(m[2]!);
      if (h) keys.add(handleKey(platformOf(m[1])!, h));
      labelled.add(m.index! + m[0].length - m[2]!.length);
    }
    for (const m of withoutUrls.matchAll(/(?<![\w.@/])(?:@|\bu\/)([\w.]{2,})/gi)) {
      const at = m.index! + m[0].length - m[1]!.length;
      if (labelled.has(at)) continue;
      const h = clean(m[1]!);
      if (!h) continue;
      const targets = new Set(named);
      if (primary) targets.add(primary);
      for (const p of targets) keys.add(handleKey(p, h));
    }
  }
  return [...keys];
}

/** Every URL in a free-text cell, as url keys. */
export function urlsInText(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(/https?:\/\/[^\s,;|)]+/gi)].map((m) => urlKey(m[0]));
}

export function isKnown(hit: DiscoveryHit, code: string | null, known: KnownPeople): boolean {
  if (code && known.codes.has(code.toLowerCase())) return true;
  if (known.handles.has(handleKey(hit.platform, hit.handle))) return true;
  // A YouTube hit keyed by channel id can still carry an @handle URL, and vice versa.
  if (handlesInText(hit.profileUrl).some((k) => known.handles.has(k))) return true;
  if (known.urls.has(urlKey(hit.profileUrl))) return true;
  const nk = nameKey(hit.displayName, hit.platform);
  if (nk && known.names.has(nk)) return true;
  return false;
}
