// Where a creator is, from evidence only. Platforms rarely say, so this reads,
// in order: the platform's own field (YouTube channel location, the country
// TikTok stamps on each video), then explicit location wording in the bio
// ("📍Austin, TX", "London based", "🇬🇧"). Conflicting or absent evidence
// returns null — unknown, never a guess.

import { countryCode } from "./discovery/types.js";

const US_STATES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware",
  FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky",
  LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri",
  MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york",
  NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island",
  SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
  WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia",
};

const US_CITIES = [
  "new york city", "nyc", "los angeles", "chicago", "houston", "htx", "phoenix", "philadelphia", "san antonio", "san diego", "dallas",
  "austin", "san francisco", "seattle", "denver", "nashville", "boston", "las vegas", "miami", "atlanta", "orlando", "tampa",
  "charlotte", "portland", "scottsdale", "salt lake city", "brooklyn", "manhattan", "the woodlands", "tucson", "raleigh",
];

const PLACES: Array<[RegExp, string]> = [
  [/\b(usa|u\.s\.a\.?|united states)\b/i, "US"],
  [/\b(uk|u\.k\.|united kingdom|england|scotland|wales|london|manchester|birmingham uk|liverpool|glasgow|edinburgh)\b/i, "GB"],
  [/\b(canada|toronto|vancouver|montreal|calgary|ottawa|edmonton)\b/i, "CA"],
  [/\b(australia|sydney|melbourne|brisbane|perth|adelaide|gold coast)\b/i, "AU"],
  [/\b(new zealand|auckland|wellington nz)\b/i, "NZ"],
  [/\b(ireland|dublin)\b/i, "IE"],
  [/\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|chennai|pune)\b/i, "IN"],
  [/\b(pakistan|karachi|lahore|islamabad)\b/i, "PK"],
  [/\b(philippines|manila)\b/i, "PH"],
  [/\b(nigeria|lagos|abuja)\b/i, "NG"],
  [/\b(dubai|abu dhabi|uae)\b/i, "AE"],
  [/\b(south africa|johannesburg|cape town)\b/i, "ZA"],
  [/\b(sweden|stockholm|norway|oslo|denmark|copenhagen)\b/i, "SE"],
  [/\b(germany|berlin|munich|france|paris|spain|madrid|barcelona|italy|milan|rome|netherlands|amsterdam)\b/i, "EU"],
  [/\b(mexico|méxico|cdmx|brazil|brasil|são paulo|argentina|colombia|chile|peru)\b/i, "LATAM"],
  [/\b(indonesia|jakarta|malaysia|kuala lumpur|singapore|thailand|bangkok|vietnam)\b/i, "ASIA"],
];

const FLAGS: Record<string, string> = {
  "🇺🇸": "US", "🇬🇧": "GB", "🇨🇦": "CA", "🇦🇺": "AU", "🇳🇿": "NZ", "🇮🇪": "IE", "🇮🇳": "IN", "🇵🇰": "PK", "🇵🇭": "PH", "🇳🇬": "NG",
  "🇦🇪": "AE", "🇿🇦": "ZA", "🇸🇪": "SE", "🇳🇴": "NO", "🇩🇰": "DK", "🇩🇪": "DE", "🇫🇷": "FR", "🇪🇸": "ES", "🇮🇹": "IT", "🇳🇱": "NL",
  "🇲🇽": "MX", "🇧🇷": "BR", "🇮🇩": "ID", "🇲🇾": "MY", "🇸🇬": "SG",
};

/** A country from bio text, or null when there's no clear, single answer.
 *  Place names beat flags: flags are often heritage ("📍HTX 🇳🇬" is a Houston creator). */
export function countryFromText(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/https?:\/\/\S+/g, " ");
  if (!t.trim()) return null;
  const places = new Set<string>();
  // "Austin, TX" / "Miami FL" / "📍 Texas"
  if (/\b[A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+)?,? (?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(t)) places.add("US");
  const lower = t.toLowerCase();
  if (Object.values(US_STATES).some((s) => new RegExp(`(📍|\\bbased in |\\bfrom |\\bin |,\\s*|^|\\|\\s*)${s}\\b`).test(lower))) places.add("US");
  if (US_CITIES.some((c) => new RegExp(`(^|[^\\p{L}])${c.replace(/\./g, "\\.")}([^\\p{L}]|$)`, "u").test(lower))) places.add("US");
  for (const [re, code] of PLACES) if (re.test(t)) places.add(code);
  // Regions (EU, LATAM, ASIA) are kept as-is: they are clearly not US, which is all the filter needs.
  if (places.size === 1) return [...places][0]!;
  if (places.size > 1) return null; // "NYC | from London": conflicting, so unknown
  const flags = new Set([...t.matchAll(/\p{Regional_Indicator}{2}/gu)].map((m) => FLAGS[m[0]] ?? "OTHER"));
  return flags.size === 1 ? [...flags][0]! : null;
}

/** The most common valid country among per-post values (TikTok's locationCreated), when one clearly leads. */
export function countryFromPosts(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    const c = countryCode(v);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[1]![1] * 2 > ranked[0]![1]) return null; // no clear majority
  return ranked[0]![0];
}

/** A country named in at least two captions, with no caption naming another. One mention is not
 *  evidence: a US pharmacist's single caption about Sweden read as "SE" on 2026-09-15. */
export function countryFromCaptions(captions: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const c of captions) {
    const found = countryFromText(c);
    if (found) counts.set(found, (counts.get(found) ?? 0) + 1);
  }
  if (counts.size !== 1) return null;
  const [country, n] = [...counts.entries()][0]!;
  return n >= 2 ? country : null;
}

/** Best evidence for a creator's country: platform field, then posts, then bio, then captions. */
export function resolveCountry(sources: {
  platform?: string | null | undefined;
  posts?: Array<string | null | undefined> | undefined;
  bio?: string | null | undefined;
  captions?: Array<string | null | undefined> | undefined;
}): { country: string | null; source: "platform" | "posts" | "bio" | "captions" | null } {
  const p = countryCode(sources.platform);
  if (p) return { country: p, source: "platform" };
  const fromPosts = countryFromPosts(sources.posts ?? []);
  if (fromPosts) return { country: fromPosts, source: "posts" };
  const fromBio = countryFromText(sources.bio);
  if (fromBio) return { country: fromBio, source: "bio" };
  const fromCaptions = countryFromCaptions(sources.captions ?? []);
  if (fromCaptions) return { country: fromCaptions, source: "captions" };
  return { country: null, source: null };
}
