// The five dedupe keys (sourcing spec §6). The set is built once per run
// from leads, lead_handles, outreach_log, signups, and affiliates.

import { handleKey } from "@biolinx/core";
import type { DiscoveryHit } from "./discovery/types.js";

export interface KnownPeople {
  codes: Set<string>;
  handles: Set<string>;
  emails: Set<string>;
  urls: Set<string>;
  names: Set<string>;
}

export function emptyKnown(): KnownPeople {
  return { codes: new Set(), handles: new Set(), emails: new Set(), urls: new Set(), names: new Set() };
}

/** host + path, lowercase, no scheme/www/query/trailing slash. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function nameKey(name: string | null | undefined, platform: string): string | null {
  const n = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return n ? `${platform.toLowerCase()}|${n}` : null;
}

export function isKnown(hit: DiscoveryHit, code: string | null, known: KnownPeople): boolean {
  if (code && known.codes.has(code.toLowerCase())) return true;
  if (known.handles.has(handleKey(hit.platform, hit.handle))) return true;
  if (known.urls.has(urlKey(hit.profileUrl))) return true;
  const nk = nameKey(hit.displayName, hit.platform);
  if (nk && known.names.has(nk)) return true;
  return false;
}
