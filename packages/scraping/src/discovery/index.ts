import { discoverInstagram } from "./instagram.js";
import { discoverReddit } from "./reddit.js";
import { discoverSkool } from "./skool.js";
import { discoverTikTok } from "./tiktok.js";
import { discoverYouTube } from "./youtube.js";
import type { Discoverer, DiscoveryPlatform } from "./types.js";

const REGISTRY: Record<DiscoveryPlatform, Discoverer> = {
  tiktok: discoverTikTok,
  instagram: discoverInstagram,
  youtube: discoverYouTube,
  reddit: discoverReddit,
  skool: discoverSkool,
};

export function discovererFor(platform: DiscoveryPlatform): Discoverer {
  return REGISTRY[platform];
}

export * from "./types.js";
export { discoverInstagram, discoverReddit, discoverSkool, discoverTikTok, discoverYouTube };
