// harshmaur/reddit-user-scraper: rows tagged by dataType (user | post |
// comment). Posts get "title — body"; comments get body.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface RedditRow {
  dataType?: string;
  username?: string;
  profileDescription?: string;
  followersCount?: number;
  profileUrl?: string;
  title?: string;
  body?: string;
  postUrl?: string;
  contentUrl?: string;
  createdAt?: string;
}

export const fetchReddit: Fetcher = async (c, deps) => {
  const per = Math.max(1, Math.floor(deps.maxItems / 2)) + 2; // 8 each at maxItems 12
  const rows = await runActorSync<RedditRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.reddit ?? "harshmaur/reddit-user-scraper",
    { usernames: [c.handle ?? c.url], maxPostsCount: per, maxCommentsCount: per, includeNSFW: false },
  );
  const user = rows.find((r) => r.dataType === "user");
  const items: SourceItem[] = rows
    .filter((r) => r.dataType === "post" || r.dataType === "comment")
    .map((r) => ({
      url: r.postUrl ?? r.contentUrl ?? "",
      text: r.dataType === "post" ? clip([r.title, r.body].filter(Boolean).join(" — ")) : clip(r.body),
      postedAt: toIso(r.createdAt),
    }));
  return {
    platform: "reddit",
    profileUrl: user?.profileUrl ?? c.url,
    displayName: user?.username ?? c.handle,
    bio: user?.profileDescription ? clip(user.profileDescription, 300) : null,
    followers: toNumber(user?.followersCount),
    items: takeItems(items, deps.maxItems),
  };
};
