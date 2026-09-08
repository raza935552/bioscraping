// clockworks/tiktok-profile-scraper: one dataset row per video; profile
// fields ride on each row's authorMeta. A missing profile comes back as a
// single row with `error` set — that is "reachable, nothing there", not a
// tool failure.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface TikTokRow {
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  error?: string;
  authorMeta?: { name?: string; nickName?: string; signature?: string; fans?: number; profileUrl?: string };
}

export const fetchTikTok: Fetcher = async (c, deps) => {
  const rows = await runActorSync<TikTokRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.tiktok ?? "clockworks/tiktok-profile-scraper",
    { profiles: [c.handle ?? c.url], resultsPerPage: deps.maxItems, profileScrapeSections: ["videos"], profileSorting: "latest" },
  );
  const videos = rows.filter((r) => !r.error);
  const meta = videos[0]?.authorMeta;
  const items: SourceItem[] = videos.map((r) => ({ url: r.webVideoUrl ?? "", text: clip(r.text), postedAt: toIso(r.createTimeISO) }));
  return {
    platform: "tiktok",
    profileUrl: meta?.profileUrl ?? c.url,
    displayName: meta?.nickName ?? meta?.name ?? null,
    bio: meta?.signature ? clip(meta.signature, 300) : null,
    followers: toNumber(meta?.fans),
    items: takeItems(items, deps.maxItems),
  };
};
