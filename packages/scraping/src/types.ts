// Shared shapes for the enrichment pipeline. Every fetcher, on every
// platform, returns the same SourceBundle so summarize() never cares where
// the content came from.

export type SourcePlatform = "tiktok" | "instagram" | "youtube" | "reddit" | "x" | "web" | "linkhub";

export interface SourceCandidate {
  platform: SourcePlatform;
  /** Normalized handle without a leading @ (null for plain web pages). */
  handle: string | null;
  /** Canonical http(s) URL for this candidate. */
  url: string;
}

export interface SourceItem {
  url: string;
  text: string;
  postedAt: string | null; // ISO 8601 or null
  /** Engagement when the platform read provides it; omitted otherwise. */
  likes?: number;
  views?: number;
  comments?: number;
  isRepost?: boolean;
}

export interface SourceBundle {
  platform: SourcePlatform;
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  followers: number | null;
  /** Captions, titles, post bodies. Max 12. */
  items: SourceItem[];
  /** Link hubs only: social links found on the page. */
  discovered?: SourceCandidate[];
  /** Country the platform states for the account (YouTube channel location), raw. */
  country?: string | null;
  /** Country each post was created in, when the platform stamps it (TikTok locationCreated), raw. */
  postCountries?: Array<string | null>;
  /** Instagram business account category ("Gym/Physical Fitness Center"), or null for personal/creator accounts. */
  businessCategory?: string | null;
}

export interface FetchDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  /** Items to request per profile. */
  maxItems: number;
}

export type Fetcher = (candidate: SourceCandidate, deps: FetchDeps) => Promise<SourceBundle>;

export interface SummaryPoint {
  text: string;
  url: string;
}

export interface Summary {
  verdict: "match" | "no_match";
  points: SummaryPoint[];
  /** Notes text in the established format, built by code. Empty on no_match. */
  note: string;
}

/** Max items kept per bundle, per spec §4.2. */
export const MAX_ITEMS = 12;
