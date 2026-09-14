// clockworks/tiktok-hashtag-scraper: one row per video, creator on authorMeta.
// We keep one hit per creator (the newest video) so the cap counts people.

import { runActorSync } from "../apify.js";
import { clip, toIso, toNumber } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  error?: string;
  authorMeta?: { name?: string; nickName?: string; signature?: string; fans?: number; profileUrl?: string };
  locationMeta?: { countryCode?: string };
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

export const discoverTikTok: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.tiktok ?? DISCOVERY_ACTORS.tiktok,
    { hashtags: [tagOf(term)], resultsPerPage: deps.perTerm },
  );
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
      country: r.locationMeta?.countryCode ?? null,
      isRepost: null,
      term,
    };
    const prev = byHandle.get(name);
    if (!prev) byHandle.set(name, hit);
    else {
      // Keep the newest post as the sample; keep any bio/name we learned.
      const newer = (postedAt ?? "") > (prev.postedAt ?? "");
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
