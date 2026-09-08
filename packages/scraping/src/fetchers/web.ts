// Plain-fetch reader for websites, Substack, podcast pages, and link hubs.
// No Apify cost. A 4xx is "reachable, nothing there"; a 5xx or network
// failure is a tool error.

import { candidateFromUrl } from "../resolve.js";
import type { Fetcher, SourceCandidate } from "../types.js";
import { clip } from "./shared.js";

const UA = "Mozilla/5.0 (compatible; BiolinxEngine/1.0; +https://biolinxlabs.com)";
const MAX_TEXT = 4000;

export function htmlToText(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  const text = withoutBlocks
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function titleOf(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clip(htmlToText(m[1] ?? ""), 120) || null : null;
}

async function getHtml(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(url, {
    headers: { "user-agent": UA, accept: "text/html,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status >= 500) throw new Error(`web fetch ${url}: HTTP ${res.status}`);
  if (!res.ok) return null;
  return res.text();
}

export const fetchWeb: Fetcher = async (c, deps) => {
  const html = await getHtml(c.url, deps.fetchImpl);
  if (html == null) return { platform: "web", profileUrl: c.url, displayName: null, bio: null, followers: null, items: [] };
  const text = htmlToText(html).slice(0, MAX_TEXT);
  return {
    platform: "web",
    profileUrl: c.url,
    displayName: titleOf(html),
    bio: null,
    followers: null,
    items: text ? [{ url: c.url, text, postedAt: null }] : [],
  };
};

export const fetchLinkHub: Fetcher = async (c, deps) => {
  const html = await getHtml(c.url, deps.fetchImpl);
  const discovered: SourceCandidate[] = [];
  const seen = new Set<string>();
  if (html) {
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      const cand = candidateFromUrl(m[1] ?? "");
      if (!cand || cand.platform === "web" || cand.platform === "linkhub" || seen.has(cand.url)) continue;
      seen.add(cand.url);
      discovered.push(cand);
    }
  }
  return {
    platform: "linkhub",
    profileUrl: c.url,
    displayName: html ? titleOf(html) : null,
    bio: null,
    followers: null,
    items: [],
    discovered,
  };
};
