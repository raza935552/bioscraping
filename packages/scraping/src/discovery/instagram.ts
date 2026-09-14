// apify/instagram-hashtag-scraper: one row per post, owner fields on the
// row. No follower count at this stage; verification reads the profile.

import { runActorSync } from "../apify.js";
import { clip, toIso } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  ownerUsername?: string;
  ownerFullName?: string;
  caption?: string;
  url?: string;
  timestamp?: string;
  error?: string;
}

export const discoverInstagram: Discoverer = async (term, deps) => {
  const isTag = term.trim().startsWith("#");
  const value = term.trim().replace(/^#/, "").toLowerCase();
  const input: Record<string, unknown> = { hashtags: [value], resultsLimit: deps.perTerm, resultsType: "posts" };
  if (!isTag) input.keywordSearch = true;
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors["discover:instagram"] ?? DISCOVERY_ACTORS.instagram,
    input,
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const handle = r.ownerUsername?.trim().toLowerCase();
    if (r.error || !handle) continue;
    const postedAt = toIso(r.timestamp);
    const hit: DiscoveryHit = {
      platform: "instagram",
      handle,
      profileUrl: `https://www.instagram.com/${handle}/`,
      displayName: r.ownerFullName ?? null,
      bio: null,
      followers: null,
      postUrl: isHttpUrl(r.url) ? r.url : null,
      postText: r.caption ? clip(r.caption, 300) : null,
      postedAt,
      country: null,
      isRepost: null,
      term,
    };
    const prev = byHandle.get(handle);
    if (!prev || (postedAt ?? "") > (prev.postedAt ?? "")) {
      byHandle.set(handle, { ...hit, displayName: hit.displayName ?? prev?.displayName ?? null });
    }
  }
  return [...byHandle.values()];
};
