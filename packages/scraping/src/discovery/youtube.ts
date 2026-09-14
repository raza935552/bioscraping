// maximedupre/youtube-channel-search-scraper: one row per channel, already
// filtered by subscriber bounds server-side. sourceVideo is the post that
// surfaced the channel (null in channel-only mode).

import { runActorSync } from "../apify.js";
import { clip, toIso, toNumber } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, countryCode, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  channel?: { handle?: string; id?: string; title?: string; url?: string; description?: string | null };
  metrics?: { subscribers?: number };
  profile?: { country?: string | null };
  sourceVideo?: { url?: string; title?: string; publishedAt?: string } | null;
}

export const discoverYouTube: Discoverer = async (term, deps, opts) => {
  const input: Record<string, unknown> = {
    discoveryMode: "both",
    searchTerms: [term.trim()],
    maxChannelsPerSearchTerm: deps.perTerm,
    maxTotalResults: deps.perTerm,
  };
  if (opts.followerMin != null) input.minSubscribers = opts.followerMin;
  if (opts.followerMax != null) input.maxSubscribers = opts.followerMax;
  if (opts.country) input.countryHint = opts.country;
  if (opts.language) input.languageHint = opts.language;
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors["discover:youtube"] ?? DISCOVERY_ACTORS.youtube,
    input,
  );
  const hits: DiscoveryHit[] = [];
  for (const r of rows) {
    const rawHandle = r.channel?.handle?.replace(/^@/, "") ?? r.channel?.id;
    if (!rawHandle) continue;
    const channelUrl = r.channel?.url;
    const videoUrl = r.sourceVideo?.url;
    hits.push({
      platform: "youtube",
      handle: rawHandle.toLowerCase(),
      profileUrl: isHttpUrl(channelUrl) ? channelUrl : `https://www.youtube.com/@${rawHandle}`,
      displayName: r.channel?.title ?? null,
      bio: r.channel?.description ? clip(r.channel.description, 300) : null,
      followers: toNumber(r.metrics?.subscribers),
      postUrl: isHttpUrl(videoUrl) ? videoUrl : null,
      postText: r.sourceVideo?.title ? clip(r.sourceVideo.title, 300) : null,
      postedAt: toIso(r.sourceVideo?.publishedAt),
      country: countryCode(r.profile?.country),
      isRepost: null,
      term,
    });
  }
  return hits;
};
