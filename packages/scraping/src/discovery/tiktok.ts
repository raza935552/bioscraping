// clockworks/tiktok-hashtag-scraper: one row per video, creator on authorMeta.
// We keep one hit per creator (the newest video) so the cap counts people.

import { runActorSync } from "../apify.js";
import { clip, engagement, toIso, toNumber } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, TIKTOK_KEYWORD_ACTOR, countryCode, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  error?: string;
  authorMeta?: { name?: string; nickName?: string; signature?: string; fans?: number; profileUrl?: string };
  locationMeta?: { countryCode?: string | number };
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
}

/** TikTok hashtags are one token: "#Peptide Sciences" → "peptidesciences".
 *  Spaces and punctuation would make the actor search a tag that can't exist. */
export function tagOf(term: string): string {
  return term
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_]/gu, "");
}

/** "#tag" searches the hashtag feed; any other term is a keyword search ("amino club code"),
 *  which finds captions that say the words even without a hashtag. */
export const discoverTikTok: Discoverer = async (term, deps) => {
  const keyword = !term.trim().startsWith("#");
  const rows = keyword
    ? await runActorSync<Row>(
        { token: deps.apify.token, fetchImpl: deps.fetchImpl },
        deps.apify.actors["discover:tiktok-search"] ?? TIKTOK_KEYWORD_ACTOR,
        { searchQueries: [term.trim()], searchSection: "/video", resultsPerPage: deps.perTerm, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false },
        { timeoutSec: 180 },
      )
    : await runActorSync<Row>(
        { token: deps.apify.token, fetchImpl: deps.fetchImpl },
        deps.apify.actors["discover:tiktok"] ?? DISCOVERY_ACTORS.tiktok,
        { hashtags: [tagOf(term)], resultsPerPage: deps.perTerm },
      );
  // For a keyword search, the post that says the searched words is the evidence to keep.
  const words = keyword ? term.toLowerCase().replace(/\b(code|discount|promo)\b/g, " ").split(/\s+/).filter((w) => w.length > 2) : [];
  const says = (text: string | null) => words.length > 0 && !!text && words.every((w) => text.toLowerCase().replace(/[^a-z0-9]/g, "").includes(w.replace(/[^a-z0-9]/g, "")));
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const name = r.authorMeta?.name?.trim().toLowerCase();
    if (r.error || !name) continue;
    const postedAt = toIso(r.createTimeISO);
    const profileUrl = r.authorMeta?.profileUrl;
    const hit: DiscoveryHit = {
      platform: "tiktok",
      handle: name,
      profileUrl: isHttpUrl(profileUrl) ? profileUrl : `https://www.tiktok.com/@${name}`,
      displayName: r.authorMeta?.nickName ?? null,
      bio: r.authorMeta?.signature ? clip(r.authorMeta.signature, 300) : null,
      followers: toNumber(r.authorMeta?.fans),
      postUrl: isHttpUrl(r.webVideoUrl) ? r.webVideoUrl : null,
      postText: r.text ? clip(r.text, 300) : null,
      postedAt,
      country: countryCode(r.locationMeta?.countryCode),
      isRepost: null,
      term,
      ...engagement({ views: r.playCount, likes: r.diggCount, comments: r.commentCount }),
    };
    const prev = byHandle.get(name);
    if (!prev) byHandle.set(name, hit);
    else {
      // Keep the post that says the searched words, else the newest; keep any bio/name we learned.
      const newer = says(hit.postText) !== says(prev.postText) ? says(hit.postText) : (postedAt ?? "") > (prev.postedAt ?? "");
      byHandle.set(name, {
        ...(newer ? hit : prev),
        displayName: prev.displayName ?? hit.displayName,
        bio: prev.bio ?? hit.bio,
        country: prev.country ?? hit.country,
      });
    }
  }
  return [...byHandle.values()];
};
