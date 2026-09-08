// apidojo/twitter-profile-scraper: one row per tweet with an embedded author.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface XRow {
  fullText?: string;
  text?: string;
  url?: string;
  twitterUrl?: string;
  createdAt?: string;
  isRetweet?: boolean;
  author?: { userName?: string; name?: string; description?: string; followers?: number; url?: string };
}

export const fetchX: Fetcher = async (c, deps) => {
  const rows = await runActorSync<XRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.x ?? "apidojo/twitter-profile-scraper",
    { twitterHandles: [c.handle ?? c.url], maxItems: deps.maxItems, includeNativeRetweets: false },
  );
  const tweets = rows.filter((r) => !r.isRetweet);
  const a = tweets[0]?.author;
  const items: SourceItem[] = tweets.map((r) => ({ url: r.url ?? r.twitterUrl ?? "", text: clip(r.fullText ?? r.text), postedAt: toIso(r.createdAt) }));
  return {
    platform: "x",
    profileUrl: a?.url ?? c.url,
    displayName: a?.name ?? a?.userName ?? null,
    bio: a?.description ? clip(a.description, 300) : null,
    followers: toNumber(a?.followers),
    items: takeItems(items, deps.maxItems),
  };
};
