// crustapi/skool-community-scraper: one row per community with owner
// details. The owner is the candidate, member count is their reach.

import { runActorSync } from "../apify.js";
import { clip } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, countryCode, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  name?: string;
  displayName?: string;
  communityUrl?: string;
  description?: string;
  totalMembers?: number;
  ownerName?: string;
  ownerProfileUrl?: string;
  ownerBio?: string;
  ownerLocation?: string | null;
}

export const discoverSkool: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors["discover:skool"] ?? DISCOVERY_ACTORS.skool,
    { searchTerms: [term.trim()], maxCommunities: deps.perTerm, includeOwnerDetails: true },
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const ownerUrl = isHttpUrl(r.ownerProfileUrl) ? r.ownerProfileUrl : null;
    const handle = ownerUrl?.match(/skool\.com\/@([^/?#]+)/)?.[1]?.toLowerCase();
    if (!handle || !ownerUrl) continue;
    const country = r.ownerLocation?.split(",").pop()?.trim() ?? null;
    const title = [r.displayName ?? r.name, r.description].filter((s) => s && s.trim()).join(" — ");
    const hit: DiscoveryHit = {
      platform: "skool",
      handle,
      profileUrl: ownerUrl,
      displayName: r.ownerName ?? null,
      bio: r.ownerBio ? clip(r.ownerBio, 300) : null,
      followers: typeof r.totalMembers === "number" ? r.totalMembers : null,
      postUrl: isHttpUrl(r.communityUrl) ? r.communityUrl : null,
      postText: title ? clip(title, 300) : null,
      postedAt: null,
      country: countryCode(country),
      isRepost: null,
      term,
    };
    const prev = byHandle.get(handle);
    if (!prev || (hit.followers ?? 0) > (prev.followers ?? 0)) byHandle.set(handle, hit);
  }
  return [...byHandle.values()];
};
