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
  businessCategory?: string | null;
  items?: DetailPost[];
}

export interface DetailLead {
  socialProfiles: string | null;
  primaryPlatform?: string | null;
  email?: string | null;
  otherCreatorCompany?: string | null;
  affiliateCode?: string | null;
  /** Research-board provenance for imported leads ("Social discovery", "Brand roster"...). */
  source?: string | null;
  notes?: string | null;
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
  /** How the engine found them, in words: "TikTok keyword search for "Amino Club code"". */
  channel: { kind: "competitor" | "hashtag" | "keyword" | "community" | "research" | null; label: string } | null;
  /** Where the saved email was written: their bio or one of their posts (with its link). */
  emailSource: { where: "bio" | "post"; url: string | null } | null;
  /** The exact words that show the competitor deal, and the post they're in. */
  evidence: { quote: string; url: string | null } | null;
}

const PLATFORM_NAME: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", reddit: "Reddit", skool: "Skool" };

const HOSTS: Record<string, string> = { "tiktok.com": "TikTok", "instagram.com": "Instagram", "youtube.com": "YouTube", "reddit.com": "Reddit", "t.me": "Telegram", "x.com": "X", "twitter.com": "X", "skool.com": "Skool" };

/** How an imported research-board lead was found: its source bucket and where the post lives. */
export function researchChannel(source: string | null | undefined, whereFound: string | null | undefined): SourcedDetails["channel"] {
  if (!source || source === "sourcing") return null;
  let where = "";
  try {
    if (whereFound) {
      const host = new URL(whereFound).hostname.replace(/^www\./, "");
      where = ` (${HOSTS[host] ?? host} post)`;
    }
  } catch {
    /* not a URL */
  }
  return { kind: "research", label: `Research board · ${source}${where}` };
}

/** "found by Biohacker · TikTok via Amino Club code" → how they were found, in words. */
export function acquisitionChannel(sourcingReason: string | null, platform: string | null | undefined, competitor: string | null | undefined): SourcedDetails["channel"] {
  const m = (sourcingReason ?? "").match(/^found by (.+) via (.+)$/);
  if (!m) return null;
  const term = m[2]!.trim();
  const where = PLATFORM_NAME[(platform ?? "").toLowerCase()] ?? platform ?? "";
  if (/ code$/i.test(term) || (competitor && term.toLowerCase() === competitor.toLowerCase())) return { kind: "competitor", label: `${where} search for "${term}" (competitor affiliates)` };
  if (term.startsWith("#")) return { kind: "hashtag", label: `${where} hashtag ${term}` };
  if ((platform ?? "").toLowerCase() === "skool") return { kind: "community", label: `Skool community search for "${term}"` };
  return { kind: "keyword", label: `${where} search for "${term}"` };
}

/** The sentence around the first mention of `needle`, trimmed to about 200 characters. */
export function quoteAround(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || !needle.trim()) return null;
  const start = Math.max(0, text.lastIndexOf("\n", i) + 1, i - 100);
  const endLine = text.indexOf("\n", i + needle.length);
  const end = Math.min(endLine < 0 ? text.length : endLine, i + needle.length + 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
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

  const texts: Array<{ text: string; url: string | null; where: "bio" | "post" }> = [
    ...(bio ? [{ text: bio, url: null, where: "bio" as const }] : []),
    ...[...sample, ...(bundle?.items ?? [])].filter((p) => p?.text).map((p) => ({ text: p.text!, url: typeof p.url === "string" ? p.url : null, where: "post" as const })),
  ];
  const email = lead.email?.toLowerCase() ?? null;
  const emailHit = email ? texts.find((t) => t.text.toLowerCase().includes(email) || t.text.toLowerCase().replace(/\s*[\[(]\s*at\s*[\])]\s*/g, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/g, ".").includes(email)) : null;
  let evidence: SourcedDetails["evidence"] = null;
  // Research-board leads carry the proof in their notes: Evidence, verbatim: "use code CLAY".
  const verbatim = (lead.notes ?? "").match(/Evidence, verbatim:\s*["“]([\s\S]{3,400}?)["”](?:\s*\n|\s*$)/);
  if (verbatim) evidence = { quote: verbatim[1]!.trim(), url: lead.whereFound && /^https?:\/\//.test(lead.whereFound) ? lead.whereFound : null };
  const needles = [lead.affiliateCode, lead.otherCreatorCompany, lead.otherCreatorCompany?.replace(/\s+/g, "")].filter((n): n is string => !!n && n.length >= 3);
  for (const n of evidence ? [] : needles) {
    const hit = texts.find((t) => t.text.toLowerCase().includes(n.toLowerCase()));
    if (hit) {
      evidence = { quote: quoteAround(hit.text, n)!, url: hit.url };
      break;
    }
  }

  return {
    channel: acquisitionChannel(lead.sourcingReason, lead.primaryPlatform, lead.otherCreatorCompany) ?? researchChannel(lead.source, lead.whereFound),
    emailSource: email ? (emailHit ? { where: emailHit.where, url: emailHit.url } : { where: "bio", url: null }) : null,
    evidence,
    handle,
    niche: normalizeNiche(lead.niche) ?? lead.niche,
    bio,
    avgViews: avgViews == null ? null : Math.round(avgViews),
    engagementRate: engagementRate == null ? null : Math.round(engagementRate * 10000) / 10000,
    engagementBasis,
    postsLast30,
    postsRead: dated.length,
    surfaced,
    isStore: handle ? looksLikeStore(handle, bio, bundle?.businessCategory) : false,
    audience: found?.[1] ?? null,
    term: found?.[2] ?? null,
    daysSinceLastPost: last && !Number.isNaN(last.getTime()) ? Math.floor((now.getTime() - last.getTime()) / 86_400_000) : null,
  };
}
