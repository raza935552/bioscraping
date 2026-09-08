import type { Fetcher, SourcePlatform } from "../types.js";
import { fetchInstagram } from "./instagram.js";
import { fetchReddit } from "./reddit.js";
import { fetchTikTok } from "./tiktok.js";
import { fetchLinkHub, fetchWeb } from "./web.js";
import { fetchX } from "./x.js";
import { fetchYouTube } from "./youtube.js";

const REGISTRY: Record<SourcePlatform, Fetcher> = {
  tiktok: fetchTikTok,
  instagram: fetchInstagram,
  youtube: fetchYouTube,
  reddit: fetchReddit,
  x: fetchX,
  web: fetchWeb,
  linkhub: fetchLinkHub,
};

export function fetcherFor(platform: SourcePlatform): Fetcher {
  return REGISTRY[platform];
}

export { fetchInstagram, fetchLinkHub, fetchReddit, fetchTikTok, fetchWeb, fetchX, fetchYouTube };
export { clip, safeSlice } from "./shared.js";
