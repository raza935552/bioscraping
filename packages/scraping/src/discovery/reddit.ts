// clearpath/reddit-subreddit-posts-scraper: raw Reddit post objects. The
// author is the candidate. Reddit has no follower count → followers null.

import { runActorSync } from "../apify.js";
import { clip, toIso } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  author?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  created_utc?: number;
}

const SKIP_AUTHORS = new Set(["[deleted]", "automoderator"]);

export function subredditOf(term: string): string {
  return term.trim().replace(/^\/?r\//i, "");
}

export const discoverReddit: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors["discover:reddit"] ?? DISCOVERY_ACTORS.reddit,
    { subreddits: [subredditOf(term)], maxPostsPerSubreddit: deps.perTerm, sort: "top", timeFilter: "month", includeComments: false },
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const author = r.author?.trim();
    if (!author || SKIP_AUTHORS.has(author.toLowerCase())) continue;
    const handle = author.toLowerCase();
    if (byHandle.has(handle)) continue; // top-of-month order: first is best
    const body = [r.title, r.selftext].filter((s) => s && s.trim()).join(" — ");
    byHandle.set(handle, {
      platform: "reddit",
      handle,
      profileUrl: `https://www.reddit.com/user/${author}/`,
      displayName: author,
      bio: null,
      followers: null,
      postUrl: r.permalink ? `https://www.reddit.com${r.permalink}` : null,
      postText: body ? clip(body, 300) : null,
      postedAt: toIso(r.created_utc),
      country: null,
      isRepost: null,
      term,
    });
  }
  return [...byHandle.values()];
};
