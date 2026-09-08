// Turns the messy identifier fields on a lead into an ordered list of places
// to look. Pure. Formats seen in the live data: "IG @a (2M); TikTok @b
// (597.7K)", "YT @Channel", bare "@name", full URLs, link hubs.

import type { SourceCandidate, SourcePlatform } from "./types.js";

export interface ResolveInput {
  primaryPlatform: string | null;
  socialProfiles: string | null;
  whereFound: string | null;
  websiteUrl: string | null;
  reachSourceUrl: string | null;
}

const PLATFORM_WORDS: Array<[RegExp, SourcePlatform]> = [
  [/^(ig|insta|instagram)$/i, "instagram"],
  [/^(tt|tiktok)$/i, "tiktok"],
  [/^(yt|youtube)$/i, "youtube"],
  [/^reddit$/i, "reddit"],
  [/^(x|twitter)$/i, "x"],
];

function platformFromWord(word: string | null | undefined): SourcePlatform | null {
  if (!word) return null;
  for (const [re, p] of PLATFORM_WORDS) if (re.test(word.trim())) return p;
  return null;
}

function cleanHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, "")
    .replace(/^u\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/[),.;]+$/, "");
}

export function canonicalUrl(platform: SourcePlatform, handle: string): string {
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "youtube":
      return `https://www.youtube.com/@${handle}`;
    case "reddit":
      return `https://www.reddit.com/user/${handle}/`;
    case "x":
      return `https://x.com/${handle}`;
    default:
      return handle;
  }
}

const LINK_HUB_HOSTS = /(^|\.)(linktr\.ee|beacons\.ai|stan\.store|bio\.site|linkin\.bio|allmylinks\.com|hoo\.be)$/i;

/** Classify one http(s) URL. Returns null for non-http schemes. */
export function candidateFromUrl(raw: string): SourceCandidate | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);

  if (host === "tiktok.com" && seg[0]?.startsWith("@")) {
    const h = cleanHandle(seg[0]);
    return { platform: "tiktok", handle: h, url: canonicalUrl("tiktok", h) };
  }
  if (host === "instagram.com" && seg[0] && !["p", "reel", "explore", "stories"].includes(seg[0])) {
    const h = cleanHandle(seg[0]);
    return { platform: "instagram", handle: h, url: canonicalUrl("instagram", h) };
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (seg[0]?.startsWith("@")) {
      const h = cleanHandle(seg[0]);
      return { platform: "youtube", handle: h, url: canonicalUrl("youtube", h) };
    }
    if ((seg[0] === "channel" || seg[0] === "c" || seg[0] === "user") && seg[1]) {
      return { platform: "youtube", handle: null, url: `https://www.youtube.com/${seg[0]}/${seg[1]}` };
    }
  }
  if (host === "reddit.com" && (seg[0] === "user" || seg[0] === "u") && seg[1]) {
    const h = cleanHandle(seg[1]);
    return { platform: "reddit", handle: h, url: canonicalUrl("reddit", h) };
  }
  if ((host === "x.com" || host === "twitter.com") && seg[0] && !["i", "search", "home"].includes(seg[0])) {
    const h = cleanHandle(seg[0]);
    return { platform: "x", handle: h, url: canonicalUrl("x", h) };
  }
  if (LINK_HUB_HOSTS.test(host)) {
    return { platform: "linkhub", handle: null, url: u.toString() };
  }
  return { platform: "web", handle: null, url: u.toString() };
}

/** Parse free text like "IG @a (2M); TikTok @b (597.7K)" or "@name". */
function candidatesFromText(text: string, primary: SourcePlatform | null): SourceCandidate[] {
  const out: SourceCandidate[] = [];
  for (const chunk of text.split(/[;\n,]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const urlMatch = part.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      const c = candidateFromUrl(urlMatch[0]);
      if (c) out.push(c);
      continue;
    }
    // "<platform word> @handle", "<platform word> u/handle", or bare "@handle"
    const m = part.match(/^(?:([A-Za-z]+)\s*[:\-]?\s*)?(@[\w.\-]+|u\/[\w\-]+)/);
    if (!m) continue;
    const word = m[1] ?? null;
    const token = m[2]!;
    const platform = platformFromWord(word) ?? (token.startsWith("u/") ? "reddit" : primary);
    if (!platform || platform === "web" || platform === "linkhub") continue;
    const h = cleanHandle(token);
    if (!h) continue;
    out.push({ platform, handle: h, url: canonicalUrl(platform, h) });
  }
  return out;
}

export function resolveCandidates(lead: ResolveInput): SourceCandidate[] {
  const primary = platformFromWord(lead.primaryPlatform);
  const raw: SourceCandidate[] = [];
  if (lead.socialProfiles) raw.push(...candidatesFromText(lead.socialProfiles, primary));
  for (const field of [lead.websiteUrl, lead.whereFound, lead.reachSourceUrl]) {
    if (!field) continue;
    const c = candidateFromUrl(field);
    if (c) raw.push(c);
  }
  // Dedup by url, keep first occurrence.
  const seen = new Set<string>();
  const unique = raw.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  // Primary platform first, stable otherwise.
  return unique
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.platform === primary ? 0 : 1) - (b.c.platform === primary ? 0 : 1) || a.i - b.i)
    .map((x) => x.c);
}
