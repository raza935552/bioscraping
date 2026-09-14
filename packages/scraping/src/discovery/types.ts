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

/** Price of a profile verification read (existing fetchers), per profile. */
export const VERIFY_UNIT_PRICE = 0.005;

export function estimateCost(platform: DiscoveryPlatform, items: number): number {
  return Math.round(ACTOR_UNIT_PRICE[platform] * items * 10000) / 10000;
}

export function isHttpUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}
