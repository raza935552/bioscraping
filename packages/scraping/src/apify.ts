// Minimal Apify REST client. One call: run an actor synchronously and get its
// default dataset back as JSON. Token travels only in the Authorization
// header; errors carry actor id + status, never the token.

export interface ApifyDeps {
  token: string;
  fetchImpl: typeof fetch;
}

export interface ApifyConfig {
  token: string;
  actors: Record<string, string>;
}

/** Actor per platform (spec §3). Overridable via config table `scraping_actors`. */
export const DEFAULT_ACTORS: Record<string, string> = {
  tiktok: "clockworks/tiktok-profile-scraper",
  instagram: "apify/instagram-profile-scraper",
  youtube: "streamers/youtube-channel-scraper",
  reddit: "harshmaur/reddit-user-scraper",
  x: "apidojo/twitter-profile-scraper",
};

export function apifyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): ApifyConfig {
  const token = env.APIFY_TOKEN ?? "";
  if (!token) throw new Error("APIFY_TOKEN missing (Apify API token)");
  return { token, actors: { ...DEFAULT_ACTORS, ...overrides } };
}

const BASE = "https://api.apify.com/v2";

export async function runActorSync<T>(
  deps: ApifyDeps,
  actorId: string,
  input: unknown,
  opts: { timeoutSec?: number } = {},
): Promise<T[]> {
  const timeout = opts.timeoutSec ?? 90;
  const path = `/acts/${actorId.replace("/", "~")}/run-sync-get-dataset-items?timeout=${timeout}&clean=true`;
  const res = await deps.fetchImpl(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeout + 15) * 1000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg = (parsed as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
    throw new Error(`Apify ${actorId}: HTTP ${res.status} — ${msg}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Apify ${actorId}: non-array dataset response`);
  return parsed as T[];
}
