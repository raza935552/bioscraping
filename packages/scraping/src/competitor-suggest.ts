// New competitors, suggested from what creators write: "use code JAMIE at Nova Peptides",
// "novapeptides.com/?ref=jamie", "code X @novapeptides". A person approves each suggestion before
// it's searched or counted; nothing is added automatically.

import { compact } from "./quality.js";

// A vendor name holds one of these as its own word ("Nova Peptides") or ends with one ("novalabs").
// Matching them anywhere made genius.com, linkinbio.com and labcorp.com look like vendors (review, 2026-09-16).
const VENDOR_WORD = /(^|[^a-z])(peptides?|aminos?|labs?|labz|chems?|research|biotech|compounds?|tides?|peps)($|[^a-z])|(peptides?|aminos?|labs|labz|chems|biotech|tides?|sciences?)$/i;
const NOT_BRANDS = new Set(
  "checkout the my all your any first orders order purchase purchases link bio site website tiktok instagram youtube shop store everything anything sitewide amazon today now".split(" "),
);
const STOP_WORDS = new Set("for and to off with use at on code is are discount get save or the a an in by from your my".split(" "));
const NOT_DOMAINS = /^(biolinx|biolinxlabs|tiktok|instagram|youtube|youtu|amazon|linktr|beacons|stan|shopify|facebook|twitter|x|reddit|google|apple|spotify|gmail|yahoo|hotmail|icloud)$/i;

export interface Suggestion {
  name: string;
  /** A domain when one was written, so the competitor can be matched and searched by it. */
  domain: string | null;
}

function cleanBrand(raw: string): string | null {
  const words = raw
    .replace(/[^\p{L}\p{N}&.' -]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // A brand name ends at the first ordinary word: "Nova Peptides for 20% off" → "Nova Peptides".
  const stop = words.findIndex((w, i) => i > 0 && STOP_WORDS.has(w.toLowerCase().replace(/[.!']+$/, "")));
  if (stop > 0) words.splice(stop);
  while (words.length && NOT_BRANDS.has(words[words.length - 1]!.toLowerCase().replace(/[.!']+$/, ""))) words.pop();
  const name = words.join(" ").replace(/[.']+$/, "");
  if (name.length < 4 || name.length > 40 || NOT_BRANDS.has(name.toLowerCase()) || !VENDOR_WORD.test(name)) return null;
  return name;
}

/** Vendor names and domains in the text that aren't already known competitors. */
export function suggestCompetitors(text: string | null | undefined, known: Array<{ name: string; domains?: string[] | null }>): Suggestion[] {
  if (!text) return [];
  const knownKeys = new Set(known.flatMap((c) => [c.name, ...(c.domains ?? [])].map((d) => compact(d.replace(/\.[a-z]{2,}$/i, "")))).filter((k) => k.length >= 4));
  const isKnown = (s: string) => {
    const k = compact(s.replace(/\.[a-z]{2,}$/i, ""));
    return k.length < 4 || [...knownKeys].some((kk) => k.includes(kk) || kk.includes(k)) || k.includes("biolinx");
  };
  const out = new Map<string, Suggestion>();
  const add = (name: string | null, domain: string | null) => {
    if (!name || isKnown(name) || (domain && isKnown(domain))) return;
    const key = compact(domain ? domain.replace(/\.[a-z]{2,}$/i, "") : name);
    if (!out.has(key)) out.set(key, { name, domain });
  };
  // "code JAMIE at Nova Peptides" / "use code 'x' with nova labs" / "code X @novapeptides"
  for (const m of text.matchAll(/\bc[o0]d[e3]\s*[:\-]?\s*["'“‘]?[A-Za-z0-9]{3,15}["'”’]?(?:\s+(?:at|on|with|for|from)\s+@?|\s*@)([A-Za-z][\w&'.-]*(?:\s+[A-Za-z][\w&'-]*){0,2})/gi)) {
    const raw = m[1]!;
    const dom = raw.match(/^([a-z0-9-]{3,30})\.(com|co|net|shop|store|io|org|us)\b/i);
    if (dom) add(cleanBrand(dom[1]!.replace(/-/g, " ")) ?? dom[1]!, `${dom[1]!.toLowerCase()}.${dom[2]!.toLowerCase()}`);
    else add(cleanBrand(raw), null);
  }
  // Store domains: "novapeptides.com", "shop.nova-labs.co/?ref=jamie"
  for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)?([a-z][a-z0-9-]{2,30})\.(com|co|net|shop|store|io|us)\b/gi)) {
    // The domain of an email address is someone's inbox, not a store.
    if (text[(m.index ?? 0) - 1] === "@" || /@[^\s]*$/.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0))) continue;
    const base = m[1]!.toLowerCase();
    if (NOT_DOMAINS.test(base) || !VENDOR_WORD.test(base)) continue;
    add(base, `${base}.${m[2]!.toLowerCase()}`);
  }
  return [...out.values()];
}
