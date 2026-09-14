// Everything the Sourced table and the marketing CSV show beyond the raw lead
// row, derived from what sourcing already stored: the lead, its sample posts,
// and the profile read bundle. Pure and deterministic; unknown stays null.

import { normalizeNiche } from "@biolinx/core";
import { looksLikeStore } from "@biolinx/scraping";

export interface DetailPost {
  url: string;
  text?: string;
  postedAt?: string | null;
  views?: number;
  likes?: number;
  comments?: number;
}

export interface DetailBundle {
  bio?: string | null;
  followers?: number | null;
  items?: DetailPost[];
}

export interface DetailLead {
  socialProfiles: string | null;
  niche: string | null;
  totalReach: number | null;
  whereFound: string | null;
  sourcingReason: string | null;
  sourcingSample: unknown;
  lastPostAt: Date | string | null;
}

export interface SourcedDetails {
  handle: string | null;
  niche: string | null;
  bio: string | null;
  /** Mean views across the recent posts that report views. */
  avgViews: number | null;
  /** Mean (likes + comments) / views, or / followers when posts carry no view count. 0.042 = 4.2%. */
  engagementRate: number | null;
  engagementBasis: "views" | "followers" | null;
  /** Posts in the last 30 days among the posts read, and how many were read (a read caps at 12). */
  postsLast30: number | null;
  postsRead: number;
  surfaced: { url: string; views: number | null; likes: number | null; comments: number | null } | null;
  isStore: boolean;
  audience: string | null;
  term: string | null;
  /** Whole days since the last post, or null. */
  daysSinceLastPost: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function handleOf(socialProfiles: string | null): string | null {
  const m = (socialProfiles ?? "").match(/(?:@|u\/)([\w.\-]+)/);
  return m ? m[1]! : null;
}

export function sourcedDetails(lead: DetailLead, bundle: DetailBundle | null, now: Date): SourcedDetails {
  const sample = (Array.isArray(lead.sourcingSample) ? lead.sourcingSample : []) as DetailPost[];
  // Recent posts: the profile read when there is one (up to 12, newest first), else what the sample kept.
  const posts = (bundle?.items?.length ? bundle.items : sample).filter((p) => p && typeof p.url === "string");

  const viewed = posts.filter((p) => typeof p.views === "number" && p.views! > 0);
  const avgViews = mean(viewed.map((p) => p.views!));
  let engagementRate: number | null = null;
  let engagementBasis: SourcedDetails["engagementBasis"] = null;
  // A post counts toward engagement only if it reports likes or comments; YouTube's channel
  // reader returns views alone, which would otherwise read as 0% engagement.
  const reacts = (p: DetailPost) => typeof p.likes === "number" || typeof p.comments === "number";
  const viewedWithReactions = viewed.filter(reacts);
  if (viewedWithReactions.length > 0) {
    engagementRate = mean(viewedWithReactions.map((p) => ((p.likes ?? 0) + (p.comments ?? 0)) / p.views!));
    engagementBasis = "views";
  } else if (viewed.length === 0) {
    const followers = bundle?.followers ?? lead.totalReach;
    const reacted = posts.filter(reacts);
    if (followers && followers > 0 && reacted.length > 0) {
      engagementRate = mean(reacted.map((p) => ((p.likes ?? 0) + (p.comments ?? 0)) / followers));
      engagementBasis = "followers";
    }
  }

  const dated = posts.filter((p) => p.postedAt && !Number.isNaN(new Date(p.postedAt).getTime()));
  const postsLast30 = dated.length ? dated.filter((p) => now.getTime() - new Date(p.postedAt!).getTime() <= 30 * 86_400_000).length : null;

  const first = sample[0];
  const fromRead = bundle?.items?.find((i) => i.url === lead.whereFound);
  const pick = (k: "views" | "likes" | "comments") => (typeof first?.[k] === "number" ? first[k]! : typeof fromRead?.[k] === "number" ? fromRead[k]! : null);
  const surfaced = lead.whereFound ? { url: lead.whereFound, views: pick("views"), likes: pick("likes"), comments: pick("comments") } : null;

  const found = (lead.sourcingReason ?? "").match(/^found by (.+) via (.+)$/);
  const handle = handleOf(lead.socialProfiles);
  const bio = bundle?.bio?.trim() || null;
  const last = lead.lastPostAt ? new Date(lead.lastPostAt) : null;

  return {
    handle,
    niche: normalizeNiche(lead.niche) ?? lead.niche,
    bio,
    avgViews: avgViews == null ? null : Math.round(avgViews),
    engagementRate: engagementRate == null ? null : Math.round(engagementRate * 10000) / 10000,
    engagementBasis,
    postsLast30,
    postsRead: dated.length,
    surfaced,
    isStore: handle ? looksLikeStore(handle, bio) : false,
    audience: found?.[1] ?? null,
    term: found?.[2] ?? null,
    daysSinceLastPost: last && !Number.isNaN(last.getTime()) ? Math.floor((now.getTime() - last.getTime()) / 86_400_000) : null,
  };
}
