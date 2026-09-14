// Discovery turns a search term into creator candidates. Every platform
// returns the same DiscoveryHit so filter/dedupe/score never care where a
// candidate came from. Prices are bronze-tier list prices (2026-09-14) and
// exist only so the spend cap can stop a run; they are not billing.

export type DiscoveryPlatform = "tiktok" | "instagram" | "youtube" | "reddit" | "skool";

export interface DiscoveryHit {
  platform: DiscoveryPlatform;
  /** Normalized, no leading @. */
  handle: string;
  /** http(s) profile URL. */
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  /** From the search row; re-read at verification, never trusted for reach. */
  followers: number | null;
  /** The post that surfaced them → leads.where_found. */
  postUrl: string | null;
  postText: string | null;
  postedAt: string | null; // ISO
  country: string | null; // ISO-2 when the platform says so
  isRepost: boolean | null;
  /** Which term found them. */
  term: string;
}

export interface DiscoveryDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  /** Hits requested per term. */
  perTerm: number;
}

export interface DiscoveryOpts {
  followerMin?: number;
  followerMax?: number;
  country?: string;
  language?: string;
}

export type Discoverer = (term: string, deps: DiscoveryDeps, opts: DiscoveryOpts) => Promise<DiscoveryHit[]>;

/** Overridable via config key `sourcing_actors`. */
export const DISCOVERY_ACTORS: Record<DiscoveryPlatform, string> = {
  tiktok: "clockworks/tiktok-hashtag-scraper",
  instagram: "apify/instagram-hashtag-scraper",
  youtube: "maximedupre/youtube-channel-search-scraper",
  reddit: "clearpath/reddit-subreddit-posts-scraper",
  skool: "crustapi/skool-community-scraper",
};

/** USD per dataset item, bronze tier, 2026-09-14. */
export const ACTOR_UNIT_PRICE: Record<DiscoveryPlatform, number> = {
  tiktok: 0.002,
  instagram: 0.0023,
  youtube: 0.00035,
  reddit: 0.002,
  skool: 0.0035,
};

/** Posts read per profile when a sourced hit is verified. */
export const VERIFY_ITEMS = 12;

/** USD for one profile verification read of VERIFY_ITEMS posts, per platform,
 *  from each reader's pay-per-event prices (2026-09-14):
 *  TikTok profile scraper $0.002/video + $0.001 sort filter; Instagram profile
 *  scraper $0.0023/profile; YouTube channel scraper $0.001/video; Reddit user
 *  scraper $0.02 start + $0.0015/item for posts and comments. Skool has no read. */
export const VERIFY_PRICE: Record<DiscoveryPlatform, number> = {
  tiktok: 0.002 * VERIFY_ITEMS + 0.001,
  instagram: 0.0025,
  youtube: 0.001 * VERIFY_ITEMS,
  reddit: 0.02 + 0.0015 * VERIFY_ITEMS * 2,
  skool: 0,
};

/** @deprecated flat estimate; use VERIFY_PRICE[platform]. Kept as the most expensive common read. */
export const VERIFY_UNIT_PRICE = VERIFY_PRICE.tiktok;

export function estimateCost(platform: DiscoveryPlatform, items: number): number {
  return Math.round(ACTOR_UNIT_PRICE[platform] * items * 10000) / 10000;
}

// GeoNames ids TikTok puts in locationMeta.countryCode instead of ISO codes (seen live 2026-09-14: 6252001).
const GEONAMES: Record<string, string> = {
  "6252001": "US", "6251999": "CA", "2635167": "GB", "2077456": "AU", "2186224": "NZ", "2963597": "IE",
  "2921044": "DE", "3017382": "FR", "3175395": "IT", "2510769": "ES", "2750405": "NL", "1269750": "IN",
  "1168579": "PK", "1694008": "PH", "3996063": "MX", "3469034": "BR", "953987": "ZA", "290557": "AE",
};
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", "u.s.": "US", "u.s.a.": "US", america: "US",
  canada: "CA", "united kingdom": "GB", uk: "GB", england: "GB", scotland: "GB", wales: "GB", "great britain": "GB",
  australia: "AU", "new zealand": "NZ", ireland: "IE", germany: "DE", france: "FR", india: "IN", pakistan: "PK",
  philippines: "PH", mexico: "MX", brazil: "BR", "south africa": "ZA", "united arab emirates": "AE",
};

/** A platform's country value as ISO-2, or null when it can't be read with certainty.
 *  null means unknown, and the country filter keeps unknowns rather than guessing. */
export function countryCode(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (/^\d+$/.test(s)) return GEONAMES[s] ?? null;
  return COUNTRY_NAMES[s.toLowerCase()] ?? null;
}

export function isHttpUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}
