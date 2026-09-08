// streamers/youtube-channel-scraper: one row per video, channel fields on
// each row. Input is the channel URL (handle URLs work).

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface YouTubeRow {
  title?: string;
  url?: string;
  date?: string;
  channelName?: string;
  channelDescription?: string | null;
  numberOfSubscribers?: number | null;
  channelUrl?: string;
  error?: string;
}

export const fetchYouTube: Fetcher = async (c, deps) => {
  const rows = await runActorSync<YouTubeRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.youtube ?? "streamers/youtube-channel-scraper",
    { startUrls: [{ url: c.url }], maxResults: deps.maxItems, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: "NEWEST" },
  );
  const videos = rows.filter((r) => !r.error && r.url);
  const first = videos[0];
  const items: SourceItem[] = videos.map((r) => ({ url: r.url ?? "", text: clip(r.title), postedAt: toIso(r.date) }));
  return {
    platform: "youtube",
    profileUrl: first?.channelUrl ?? c.url,
    displayName: first?.channelName ?? null,
    bio: first?.channelDescription ? clip(first.channelDescription, 300) : null,
    followers: toNumber(first?.numberOfSubscribers),
    items: takeItems(items, deps.maxItems),
  };
};
