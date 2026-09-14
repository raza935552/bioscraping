// harshmaur/reddit-user-scraper: rows tagged by dataType (user | post |
// comment). Posts get "title — body"; comments get body.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, engagement, takeItems, toIso } from "./shared.js";

interface RedditRow {
  dataType?: string; // "user" (older output) or "user_profile", "post", "comment"
  username?: string;
  profileDescription?: string;
  bio?: string;
  followersCount?: number;
  profileUrl?: string;
  title?: string;
  postTitle?: string;
  body?: string;
  postUrl?: string;
  url?: string;
  contentUrl?: string;
  createdAt?: string;
  postCreatedAt?: string;
  commentCreatedAt?: string;
  score?: number;
  commentUpVotes?: number;
  numComments?: number;
}

export const fetchReddit: Fetcher = async (c, deps) => {
  const per = Math.max(1, Math.floor(deps.maxItems / 2)) + 2; // 8 each at maxItems 12
  const rows = await runActorSync<RedditRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.reddit ?? "harshmaur/reddit-user-scraper",
    // The profile URL keeps the username's real case; the actor returned nothing for a lowercased handle (live, 2026-09-14).
    { usernames: [c.url ?? c.handle], maxPostsCount: per, maxCommentsCount: per, includeNSFW: false },
  );
  const user = rows.find((r) => r.dataType === "user" || r.dataType === "user_profile");
  const items: SourceItem[] = rows
    .filter((r) => r.dataType === "post" || r.dataType === "comment")
    .map((r) => ({
      url: r.postUrl ?? r.url ?? r.contentUrl ?? "",
      text: r.dataType === "post" ? clip([r.title ?? r.postTitle, r.body].filter(Boolean).join(" — ")) : clip(r.body),
      postedAt: toIso(r.dataType === "comment" ? (r.commentCreatedAt ?? r.createdAt) : (r.postCreatedAt ?? r.createdAt)),
      ...engagement({ likes: r.score ?? r.commentUpVotes, comments: r.numComments }),
    }));
  const bio = user?.profileDescription || user?.bio;
  return {
    platform: "reddit",
    profileUrl: user?.profileUrl ?? c.url,
    displayName: user?.username ?? c.handle,
    bio: bio ? clip(bio, 300) : null,
    // Invariant: Reddit reach stays null. Its opt-in "followers" is almost always 0 and is not audience size.
    followers: null,
    items: takeItems(items, deps.maxItems),
  };
};
