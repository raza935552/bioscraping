// apify/instagram-profile-scraper: one row per profile with latestPosts.
// includeAboutSection adds Instagram's "About this account" (country the
// account is based in) for $0.006 per profile; live runs on 2026-09-15 showed
// "unknown location" Instagram leads were in the UK.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, engagement, takeItems, toIso, toNumber } from "./shared.js";

interface InstagramRow {
  username?: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  url?: string;
  private?: boolean;
  error?: string;
  isBusinessAccount?: boolean;
  businessCategoryName?: string | null;
  about?: { country?: string | null } | null;
  latestPosts?: Array<{ caption?: string; url?: string | null; timestamp?: string | null; likesCount?: number; commentsCount?: number; videoViewCount?: number }>;
}

export const fetchInstagram: Fetcher = async (c, deps) => {
  const rows = await runActorSync<InstagramRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.instagram ?? "apify/instagram-profile-scraper",
    { usernames: [c.handle ?? c.url], includeAboutSection: true },
  );
  const p = rows.find((r) => !r.error);
  const posts = p && !p.private ? (p.latestPosts ?? []) : [];
  const items: SourceItem[] = posts.map((x) => ({
    url: x.url ?? "",
    text: clip(x.caption),
    postedAt: toIso(x.timestamp),
    ...engagement({ likes: x.likesCount, comments: x.commentsCount, views: x.videoViewCount }),
  }));
  return {
    platform: "instagram",
    profileUrl: p?.url ?? c.url,
    displayName: p?.fullName ?? p?.username ?? null,
    bio: p?.biography ? clip(p.biography, 300) : null,
    followers: toNumber(p?.followersCount),
    items: takeItems(items, deps.maxItems),
    country: p?.about?.country ?? null,
    businessCategory: p?.isBusinessAccount ? (p.businessCategoryName ?? "business") : null,
  };
};
