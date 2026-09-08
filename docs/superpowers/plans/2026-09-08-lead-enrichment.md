# Lead Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every contactable lead real, source-linked talking points so the drafting engine can write first touches, and fix the two dispatch defects that would otherwise waste that work.

**Architecture:** A new `packages/scraping` turns a lead's identifiers into a normalized `SourceBundle` (one fetcher per platform, Apify-backed for social, plain fetch for the web), then one Claude call plus deterministic URL verification turns the bundle into notes. A new `enrich-personalize` job in `packages/jobs` orchestrates it under the existing MySQL-lock scheduler. Dispatch gains a "has usable notes" precondition and writes the next follow-up date from the cadence engine.

**Tech Stack:** Node 22, TypeScript (strict, NodeNext), vitest, Drizzle on mysql2, Apify REST API v2 (`run-sync-get-dataset-items`), Anthropic Messages API via the existing `LlmClient`.

**Spec:** `docs/superpowers/specs/2026-09-08-lead-enrichment-design.md`

## Global Constraints

- Node `>=22`, pnpm workspace; every package is `"type": "module"`, `main: ./src/index.ts`, no build step (tsx runs TS directly).
- `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: index results are `T | undefined`; optional props must be omitted, never set to `undefined`.
- Relative imports use the `.js` extension (`./resolve.js`), matching every existing package.
- All HTTP goes through an injectable `fetchImpl: typeof fetch = fetch` parameter, as in `packages/instantly/src/index.ts`, so tests never touch the network.
- Secrets come from `process.env` only (`APIFY_TOKEN`, `ANTHROPIC_API_KEY`, `DRAFT_MODEL`). Never log them; error messages carry actor id and run id only.
- Only http(s) URLs are ever emitted by resolve or written to the database.
- Notes text is built by code, never taken verbatim from the model. Format: `MATCH — <point> (<url>); <point> (<url>).`
- Tests: vitest, files under `test/`, imports from `../src/…js`. Run a package's tests with `pnpm --filter @biolinx/<pkg> test`.
- Conventional commit messages (`feat:`, `fix:`, `test:`, `chore:`). Work on branch `feat/lead-enrichment`.
- Every outbound-affecting invariant from the README holds: SP5 leads never enter a queue; blank reach is never defaulted.

---

## File structure

**Create — `packages/scraping/`** (new package `@biolinx/scraping`)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | package scaffold, mirrors `packages/instantly` |
| `src/index.ts` | re-exports |
| `src/types.ts` | `SourceCandidate`, `SourceItem`, `SourceBundle`, `Fetcher`, `FetchDeps`, `Summary` |
| `src/resolve.ts` | lead fields → ordered `SourceCandidate[]` (pure) |
| `src/apify.ts` | `runActorSync` REST client + `apifyConfigFromEnv` |
| `src/fetchers/tiktok.ts`, `instagram.ts`, `youtube.ts`, `reddit.ts`, `x.ts` | Apify-backed fetchers |
| `src/fetchers/web.ts` | plain-fetch page reader + link-hub discovery |
| `src/fetchers/index.ts` | `fetcherFor(platform)` registry + `defaultActors` |
| `src/summarize.ts` | Claude call, JSON parse, URL verification, note builder |
| `test/resolve.test.ts`, `test/apify.test.ts`, `test/fetchers.test.ts`, `test/web.test.ts`, `test/summarize.test.ts` | unit tests |

**Modify**

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | `leads`: add `enrichmentStatus`, `enrichedAt`, `enrichmentSourceUrl`, `enrichmentAttempts`; drop `needsEnrichment`. New table `leadEnrichments`. |
| `packages/jobs/package.json` | add `@biolinx/scraping` dependency |
| `packages/jobs/src/enrich-personalize.ts` (create) | the job: cleanup, selection, per-lead loop, run summary |
| `packages/jobs/src/cadence-dates.ts` (create) | `nextFollowUpDateAfterSend()` pure helper |
| `packages/jobs/src/outreach-dispatch.ts` | notes precondition, cadence write in both send paths, exhausted-touch filter |
| `packages/jobs/src/index.ts` | exports |
| `packages/jobs/test/enrich-personalize.test.ts`, `test/cadence-dates.test.ts`, `test/outreach-dispatch.test.ts` (create) | unit tests |
| `apps/worker/src/index.ts` | schedule `enrich-personalize` daily |
| `apps/api/src/index.ts` | job trigger entry; `enrichmentStatus` on lead rows and detail |
| `apps/admin/src/api.ts`, `src/labels.ts`, `src/pages/Leads.tsx` | status chip, "Enrich next batch" button, `describeRun` case |

---

### Task 1: Scaffold `@biolinx/scraping` and the `resolve` unit

**Files:**
- Create: `packages/scraping/package.json`
- Create: `packages/scraping/tsconfig.json`
- Create: `packages/scraping/src/types.ts`
- Create: `packages/scraping/src/resolve.ts`
- Create: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/resolve.test.ts`

**Interfaces:**
- Produces: `resolveCandidates(lead: ResolveInput): SourceCandidate[]` and the shared types in `types.ts` that every later task imports.

- [ ] **Step 1: Create the package scaffold**

`packages/scraping/package.json`:

```json
{
  "name": "@biolinx/scraping",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@biolinx/core": "workspace:*",
    "@biolinx/drafting": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`packages/scraping/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test"]
}
```

Run: `pnpm install`
Expected: lockfile updated, `packages/scraping/node_modules` created.

- [ ] **Step 2: Write the shared types**

`packages/scraping/src/types.ts`:

```ts
// Shared shapes for the enrichment pipeline. Every fetcher, on every
// platform, returns the same SourceBundle so summarize() never cares where
// the content came from.

export type SourcePlatform = "tiktok" | "instagram" | "youtube" | "reddit" | "x" | "web" | "linkhub";

export interface SourceCandidate {
  platform: SourcePlatform;
  /** Normalized handle without a leading @ (null for plain web pages). */
  handle: string | null;
  /** Canonical http(s) URL for this candidate. */
  url: string;
}

export interface SourceItem {
  url: string;
  text: string;
  postedAt: string | null; // ISO 8601 or null
}

export interface SourceBundle {
  platform: SourcePlatform;
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  followers: number | null;
  /** Captions, titles, post bodies. Max 12. */
  items: SourceItem[];
  /** Link hubs only: social links found on the page. */
  discovered?: SourceCandidate[];
}

export interface FetchDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  /** Items to request per profile. */
  maxItems: number;
}

export type Fetcher = (candidate: SourceCandidate, deps: FetchDeps) => Promise<SourceBundle>;

export interface SummaryPoint {
  text: string;
  url: string;
}

export interface Summary {
  verdict: "match" | "no_match";
  points: SummaryPoint[];
  /** Notes text in the established format, built by code. Empty on no_match. */
  note: string;
}

/** Max items kept per bundle, per spec §4.2. */
export const MAX_ITEMS = 12;
```

- [ ] **Step 3: Write the failing resolve tests**

`packages/scraping/test/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveCandidates } from "../src/resolve.js";

const base = { primaryPlatform: null, socialProfiles: null, whereFound: null, websiteUrl: null, reachSourceUrl: null };

describe("resolveCandidates", () => {
  it("parses the 'IG @a (2M); TikTok @b (597.7K)' format", () => {
    const out = resolveCandidates({ ...base, socialProfiles: "IG @tamsenfadal (2M); TikTok @tamsenfadal (597.7K)" });
    expect(out).toEqual([
      { platform: "instagram", handle: "tamsenfadal", url: "https://www.instagram.com/tamsenfadal/" },
      { platform: "tiktok", handle: "tamsenfadal", url: "https://www.tiktok.com/@tamsenfadal" },
    ]);
  });

  it("puts the primary platform first", () => {
    const out = resolveCandidates({
      ...base,
      primaryPlatform: "TikTok",
      socialProfiles: "IG @dave.asprey; TikTok @daveasprey",
    });
    expect(out[0]?.platform).toBe("tiktok");
    expect(out[1]?.platform).toBe("instagram");
  });

  it("infers the platform for a bare @handle from primaryPlatform", () => {
    const out = resolveCandidates({ ...base, primaryPlatform: "Instagram", socialProfiles: "@drgabriellelyon" });
    expect(out).toEqual([{ platform: "instagram", handle: "drgabriellelyon", url: "https://www.instagram.com/drgabriellelyon/" }]);
  });

  it("parses YT @handle and YouTube channel URLs", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "YT @ThomasDeLauerOfficial" })).toEqual([
      { platform: "youtube", handle: "ThomasDeLauerOfficial", url: "https://www.youtube.com/@ThomasDeLauerOfficial" },
    ]);
    expect(resolveCandidates({ ...base, websiteUrl: "https://www.youtube.com/channel/UC70SrI3VkT1MXALRtf0pcHg" })).toEqual([
      { platform: "youtube", handle: null, url: "https://www.youtube.com/channel/UC70SrI3VkT1MXALRtf0pcHg" },
    ]);
  });

  it("parses reddit u/name and profile URLs", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "Reddit u/peptide_pete" })[0]).toEqual({
      platform: "reddit", handle: "peptide_pete", url: "https://www.reddit.com/user/peptide_pete/",
    });
    expect(resolveCandidates({ ...base, whereFound: "https://www.reddit.com/user/peptide_pete/comments/" })[0]?.handle).toBe("peptide_pete");
  });

  it("parses x.com and twitter.com URLs and 'X @handle'", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "X @biohackerjoe" })[0]).toEqual({
      platform: "x", handle: "biohackerjoe", url: "https://x.com/biohackerjoe",
    });
    expect(resolveCandidates({ ...base, websiteUrl: "https://twitter.com/biohackerjoe/status/1" })[0]?.handle).toBe("biohackerjoe");
  });

  it("classifies link hubs and plain websites", () => {
    expect(resolveCandidates({ ...base, websiteUrl: "https://linktr.ee/OfficialShelbyPepTalk" })).toEqual([
      { platform: "linkhub", handle: null, url: "https://linktr.ee/OfficialShelbyPepTalk" },
    ]);
    expect(resolveCandidates({ ...base, websiteUrl: "https://outliyr.com/best-longevity-influencers" })).toEqual([
      { platform: "web", handle: null, url: "https://outliyr.com/best-longevity-influencers" },
    ]);
  });

  it("drops non-http URLs and dedups by url", () => {
    const out = resolveCandidates({
      ...base,
      socialProfiles: "TikTok @meg.boggs",
      whereFound: "https://www.tiktok.com/@meg.boggs",
      websiteUrl: "javascript:alert(1)",
    });
    expect(out).toEqual([{ platform: "tiktok", handle: "meg.boggs", url: "https://www.tiktok.com/@meg.boggs" }]);
  });

  it("returns [] when nothing usable exists", () => {
    expect(resolveCandidates({ ...base, socialProfiles: "The Human Upgrade Podcast" })).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL, "Cannot find module '../src/resolve.js'".

- [ ] **Step 5: Implement resolve**

`packages/scraping/src/resolve.ts`:

```ts
// Turns the messy identifier fields on a lead into an ordered list of places
// to look. Pure. Formats seen in the live data: "IG @a (2M); TikTok @b
// (597.7K)", "YT @Channel", bare "@name", full URLs, link hubs.

import type { SourceCandidate, SourcePlatform } from "./types.js";

export interface ResolveInput {
  primaryPlatform: string | null;
  socialProfiles: string | null;
  whereFound: string | null;
  websiteUrl: string | null;
  reachSourceUrl: string | null;
}

const PLATFORM_WORDS: Array<[RegExp, SourcePlatform]> = [
  [/^(ig|insta|instagram)$/i, "instagram"],
  [/^(tt|tiktok)$/i, "tiktok"],
  [/^(yt|youtube)$/i, "youtube"],
  [/^reddit$/i, "reddit"],
  [/^(x|twitter)$/i, "x"],
];

function platformFromWord(word: string | null | undefined): SourcePlatform | null {
  if (!word) return null;
  for (const [re, p] of PLATFORM_WORDS) if (re.test(word.trim())) return p;
  return null;
}

function cleanHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").replace(/^u\//i, "").replace(/[/?#].*$/, "").replace(/[),.;]+$/, "");
}

export function canonicalUrl(platform: SourcePlatform, handle: string): string {
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "youtube":
      return `https://www.youtube.com/@${handle}`;
    case "reddit":
      return `https://www.reddit.com/user/${handle}/`;
    case "x":
      return `https://x.com/${handle}`;
    default:
      return handle;
  }
}

const LINK_HUB_HOSTS = /(^|\.)(linktr\.ee|beacons\.ai|stan\.store|bio\.site|linkin\.bio|allmylinks\.com|hoo\.be)$/i;

/** Classify one http(s) URL. Returns null for non-http schemes. */
export function candidateFromUrl(raw: string): SourceCandidate | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);

  if (host === "tiktok.com" && seg[0]?.startsWith("@")) {
    const h = cleanHandle(seg[0]);
    return { platform: "tiktok", handle: h, url: canonicalUrl("tiktok", h) };
  }
  if (host === "instagram.com" && seg[0] && !["p", "reel", "explore", "stories"].includes(seg[0])) {
    const h = cleanHandle(seg[0]);
    return { platform: "instagram", handle: h, url: canonicalUrl("instagram", h) };
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (seg[0]?.startsWith("@")) {
      const h = cleanHandle(seg[0]);
      return { platform: "youtube", handle: h, url: canonicalUrl("youtube", h) };
    }
    if ((seg[0] === "channel" || seg[0] === "c" || seg[0] === "user") && seg[1]) {
      return { platform: "youtube", handle: null, url: `https://www.youtube.com/${seg[0]}/${seg[1]}` };
    }
  }
  if (host === "reddit.com" && (seg[0] === "user" || seg[0] === "u") && seg[1]) {
    const h = cleanHandle(seg[1]);
    return { platform: "reddit", handle: h, url: canonicalUrl("reddit", h) };
  }
  if ((host === "x.com" || host === "twitter.com") && seg[0] && !["i", "search", "home"].includes(seg[0])) {
    const h = cleanHandle(seg[0]);
    return { platform: "x", handle: h, url: canonicalUrl("x", h) };
  }
  if (LINK_HUB_HOSTS.test(host)) {
    return { platform: "linkhub", handle: null, url: u.toString() };
  }
  return { platform: "web", handle: null, url: u.toString() };
}

/** Parse free text like "IG @a (2M); TikTok @b (597.7K)" or "@name". */
function candidatesFromText(text: string, primary: SourcePlatform | null): SourceCandidate[] {
  const out: SourceCandidate[] = [];
  for (const chunk of text.split(/[;\n,]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const urlMatch = part.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      const c = candidateFromUrl(urlMatch[0]);
      if (c) out.push(c);
      continue;
    }
    // "<platform word> @handle", "<platform word> u/handle", or bare "@handle"
    const m = part.match(/^(?:([A-Za-z]+)\s*[:\-]?\s*)?(@[\w.\-]+|u\/[\w\-]+)/);
    if (!m) continue;
    const word = m[1] ?? null;
    const platform = platformFromWord(word) ?? (m[2]!.startsWith("u/") ? "reddit" : primary);
    if (!platform || platform === "web" || platform === "linkhub") continue;
    const h = cleanHandle(m[2]!);
    if (!h) continue;
    out.push({ platform, handle: h, url: canonicalUrl(platform, h) });
  }
  return out;
}

export function resolveCandidates(lead: ResolveInput): SourceCandidate[] {
  const primary = platformFromWord(lead.primaryPlatform);
  const raw: SourceCandidate[] = [];
  if (lead.socialProfiles) raw.push(...candidatesFromText(lead.socialProfiles, primary));
  for (const field of [lead.websiteUrl, lead.whereFound, lead.reachSourceUrl]) {
    if (!field) continue;
    const c = candidateFromUrl(field);
    if (c) raw.push(c);
  }
  // Dedup by url, keep first occurrence.
  const seen = new Set<string>();
  const unique = raw.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  // Primary platform first, stable otherwise.
  return unique
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.platform === primary ? 0 : 1) - (b.c.platform === primary ? 0 : 1) || a.i - b.i)
    .map((x) => x.c);
}
```

`packages/scraping/src/index.ts`:

```ts
export * from "./types.js";
export * from "./resolve.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @biolinx/scraping test`
Expected: PASS, 9 tests.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @biolinx/scraping typecheck`
Expected: no output (clean).

```bash
git add packages/scraping pnpm-lock.yaml
git commit -m "feat(scraping): package scaffold, shared types, resolveCandidates"
```

---

### Task 2: Apify client

**Files:**
- Create: `packages/scraping/src/apify.ts`
- Modify: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/apify.test.ts`

**Interfaces:**
- Produces: `runActorSync<T>(deps, actorId, input, opts?): Promise<T[]>`, `apifyConfigFromEnv(env?)`, `DEFAULT_ACTORS`.

- [ ] **Step 1: Write the failing tests**

`packages/scraping/test/apify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { apifyConfigFromEnv, runActorSync } from "../src/apify.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("runActorSync", () => {
  it("POSTs input to run-sync-get-dataset-items with bearer auth and returns items", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?timeout=90&clean=true");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init?.body))).toEqual({ profiles: ["meg.boggs"] });
      return json([{ text: "hi" }]);
    });
    const items = await runActorSync<{ text: string }>(
      { token: "tok", fetchImpl: fetchMock as typeof fetch },
      "clockworks/tiktok-profile-scraper",
      { profiles: ["meg.boggs"] },
    );
    expect(items).toEqual([{ text: "hi" }]);
  });

  it("throws with the actor id and status, never the token", async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: "actor not found" } }, 404));
    await expect(
      runActorSync({ token: "SECRET", fetchImpl: fetchMock as typeof fetch }, "x/y", {}),
    ).rejects.toThrow(/x\/y.*404.*actor not found/);
    await expect(
      runActorSync({ token: "SECRET", fetchImpl: fetchMock as typeof fetch }, "x/y", {}),
    ).rejects.not.toThrow(/SECRET/);
  });

  it("treats a non-array body as an error", async () => {
    const fetchMock = vi.fn(async () => json({ data: {} }));
    await expect(runActorSync({ token: "t", fetchImpl: fetchMock as typeof fetch }, "x/y", {})).rejects.toThrow(/non-array/);
  });
});

describe("apifyConfigFromEnv", () => {
  it("requires APIFY_TOKEN", () => {
    expect(() => apifyConfigFromEnv({})).toThrow(/APIFY_TOKEN/);
  });
  it("uses default actors and allows overrides", () => {
    const cfg = apifyConfigFromEnv({ APIFY_TOKEN: "t" }, { tiktok: "me/custom" });
    expect(cfg.actors.tiktok).toBe("me/custom");
    expect(cfg.actors.instagram).toBe("apify/instagram-profile-scraper");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL, cannot find `../src/apify.js`.

- [ ] **Step 3: Implement**

`packages/scraping/src/apify.ts`:

```ts
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

export function apifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Record<string, string> = {}): ApifyConfig {
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
```

Append to `packages/scraping/src/index.ts`:

```ts
export * from "./apify.js";
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, 14 tests; typecheck clean.

```bash
git add packages/scraping
git commit -m "feat(scraping): Apify run-sync client with default actor registry"
```

---

### Task 3: TikTok and Instagram fetchers

**Files:**
- Create: `packages/scraping/src/fetchers/tiktok.ts`
- Create: `packages/scraping/src/fetchers/instagram.ts`
- Create: `packages/scraping/src/fetchers/shared.ts`
- Test: `packages/scraping/test/fetchers.test.ts`

**Interfaces:**
- Consumes: `runActorSync`, `SourceCandidate`, `FetchDeps`, `SourceBundle`, `MAX_ITEMS`.
- Produces: `fetchTikTok: Fetcher`, `fetchInstagram: Fetcher`, and `shared.ts` helpers `clip(text, n)`, `toIso(value)`, `takeItems(items)`.

- [ ] **Step 1: Write the failing tests**

`packages/scraping/test/fetchers.test.ts` (first half; Task 4 appends):

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchTikTok } from "../src/fetchers/tiktok.js";
import { fetchInstagram } from "../src/fetchers/instagram.js";
import type { FetchDeps } from "../src/types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deps(items: unknown, capture?: (body: unknown) => void): FetchDeps {
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(items);
  });
  return {
    fetchImpl: fetchImpl as typeof fetch,
    apify: { token: "t", actors: { tiktok: "clockworks/tiktok-profile-scraper", instagram: "apify/instagram-profile-scraper" } },
    maxItems: 12,
  };
}

describe("fetchTikTok", () => {
  it("maps videos to items and authorMeta to profile fields", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          text: "what I eat in a day pregnant",
          webVideoUrl: "https://www.tiktok.com/@maryanadvorska/video/1",
          createTimeISO: "2026-08-01T10:00:00.000Z",
          authorMeta: { name: "maryanadvorska", nickName: "Maryana", signature: "first time mom - PCOS", fans: 10800, profileUrl: "https://www.tiktok.com/@maryanadvorska" },
        },
        { text: "second", webVideoUrl: "https://www.tiktok.com/@maryanadvorska/video/2", createTimeISO: "2026-07-01T10:00:00.000Z", authorMeta: { name: "maryanadvorska", fans: 10800 } },
      ],
      (b) => (sent = b),
    );
    const b = await fetchTikTok({ platform: "tiktok", handle: "maryanadvorska", url: "https://www.tiktok.com/@maryanadvorska" }, d);
    expect(sent).toEqual({ profiles: ["maryanadvorska"], resultsPerPage: 12, profileScrapeSections: ["videos"], profileSorting: "latest" });
    expect(b.platform).toBe("tiktok");
    expect(b.displayName).toBe("Maryana");
    expect(b.bio).toBe("first time mom - PCOS");
    expect(b.followers).toBe(10800);
    expect(b.items).toHaveLength(2);
    expect(b.items[0]).toEqual({ url: "https://www.tiktok.com/@maryanadvorska/video/1", text: "what I eat in a day pregnant", postedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("returns an empty bundle (not an error) when the actor reports the profile missing", async () => {
    const d = deps([{ error: "not_found", errorCode: "not_found", input: "ghost" }]);
    const b = await fetchTikTok({ platform: "tiktok", handle: "ghost", url: "https://www.tiktok.com/@ghost" }, d);
    expect(b.items).toEqual([]);
  });

  it("drops items with empty text and caps at maxItems", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: i === 0 ? "" : `post ${i}`, webVideoUrl: `https://t/${i}`, authorMeta: { name: "a" } }));
    const b = await fetchTikTok({ platform: "tiktok", handle: "a", url: "https://www.tiktok.com/@a" }, deps(many));
    expect(b.items).toHaveLength(12);
    expect(b.items[0]?.text).toBe("post 1");
  });
});

describe("fetchInstagram", () => {
  it("maps one profile row with latestPosts", async () => {
    let sent: unknown;
    const d = deps(
      [
        {
          username: "annie", fullName: "Annie August", biography: "NP · hormones", followersCount: 42000,
          url: "https://www.instagram.com/annie/",
          latestPosts: [{ caption: "The exact list I pull…", url: "https://www.instagram.com/p/abc/", timestamp: "2026-08-20T00:00:00.000Z" }],
        },
      ],
      (b) => (sent = b),
    );
    const b = await fetchInstagram({ platform: "instagram", handle: "annie", url: "https://www.instagram.com/annie/" }, d);
    expect(sent).toEqual({ usernames: ["annie"] });
    expect(b.displayName).toBe("Annie August");
    expect(b.bio).toBe("NP · hormones");
    expect(b.followers).toBe(42000);
    expect(b.items).toEqual([{ url: "https://www.instagram.com/p/abc/", text: "The exact list I pull…", postedAt: "2026-08-20T00:00:00.000Z" }]);
  });

  it("returns an empty bundle for a private or missing account", async () => {
    const d = deps([{ username: "x", private: true, latestPosts: [] }]);
    const b = await fetchInstagram({ platform: "instagram", handle: "x", url: "https://www.instagram.com/x/" }, d);
    expect(b.items).toEqual([]);
    const gone = await fetchInstagram({ platform: "instagram", handle: "x", url: "u" }, deps([{ error: "not found", errorDescription: "Page not found" }]));
    expect(gone.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL on missing `../src/fetchers/tiktok.js`.

- [ ] **Step 3: Implement shared helpers and both fetchers**

`packages/scraping/src/fetchers/shared.ts`:

```ts
import { MAX_ITEMS, type SourceItem } from "../types.js";

/** Trim, collapse whitespace, cap length. */
export function clip(text: string | null | undefined, max = 600): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Best-effort ISO date from an ISO string, epoch seconds, or ms. */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Drop empty-text items, keep insertion order, cap at max. */
export function takeItems(items: SourceItem[], max = MAX_ITEMS): SourceItem[] {
  return items.filter((i) => i.text.length > 0 && /^https?:\/\//.test(i.url)).slice(0, max);
}

export function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
```

`packages/scraping/src/fetchers/tiktok.ts`:

```ts
// clockworks/tiktok-profile-scraper: one dataset row per video; profile
// fields ride on each row's authorMeta. A missing profile comes back as a
// single row with `error` set — that is "reachable, nothing there", not a
// tool failure.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface TikTokRow {
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  error?: string;
  authorMeta?: { name?: string; nickName?: string; signature?: string; fans?: number; profileUrl?: string };
}

export const fetchTikTok: Fetcher = async (c, deps) => {
  const rows = await runActorSync<TikTokRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.tiktok ?? "clockworks/tiktok-profile-scraper",
    { profiles: [c.handle ?? c.url], resultsPerPage: deps.maxItems, profileScrapeSections: ["videos"], profileSorting: "latest" },
  );
  const videos = rows.filter((r) => !r.error);
  const meta = videos[0]?.authorMeta;
  const items: SourceItem[] = videos.map((r) => ({ url: r.webVideoUrl ?? "", text: clip(r.text), postedAt: toIso(r.createTimeISO) }));
  return {
    platform: "tiktok",
    profileUrl: meta?.profileUrl ?? c.url,
    displayName: meta?.nickName ?? meta?.name ?? null,
    bio: meta?.signature ? clip(meta.signature, 300) : null,
    followers: toNumber(meta?.fans),
    items: takeItems(items, deps.maxItems),
  };
};
```

`packages/scraping/src/fetchers/instagram.ts`:

```ts
// apify/instagram-profile-scraper: one row per profile with latestPosts.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface InstagramRow {
  username?: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  url?: string;
  private?: boolean;
  error?: string;
  latestPosts?: Array<{ caption?: string; url?: string | null; timestamp?: string | null }>;
}

export const fetchInstagram: Fetcher = async (c, deps) => {
  const rows = await runActorSync<InstagramRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.instagram ?? "apify/instagram-profile-scraper",
    { usernames: [c.handle ?? c.url] },
  );
  const p = rows.find((r) => !r.error);
  const posts = p && !p.private ? (p.latestPosts ?? []) : [];
  const items: SourceItem[] = posts.map((x) => ({ url: x.url ?? "", text: clip(x.caption), postedAt: toIso(x.timestamp) }));
  return {
    platform: "instagram",
    profileUrl: p?.url ?? c.url,
    displayName: p?.fullName ?? p?.username ?? null,
    bio: p?.biography ? clip(p.biography, 300) : null,
    followers: toNumber(p?.followersCount),
    items: takeItems(items, deps.maxItems),
  };
};
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, 19 tests.

```bash
git add packages/scraping
git commit -m "feat(scraping): TikTok and Instagram fetchers"
```

---

### Task 4: YouTube, Reddit, and X fetchers

**Files:**
- Create: `packages/scraping/src/fetchers/youtube.ts`, `reddit.ts`, `x.ts`
- Modify: `packages/scraping/test/fetchers.test.ts` (append)

**Interfaces:**
- Produces: `fetchYouTube`, `fetchReddit`, `fetchX`, all `Fetcher`.

- [ ] **Step 1: Append failing tests**

Append to `packages/scraping/test/fetchers.test.ts`:

```ts
import { fetchYouTube } from "../src/fetchers/youtube.js";
import { fetchReddit } from "../src/fetchers/reddit.js";
import { fetchX } from "../src/fetchers/x.js";

describe("fetchYouTube", () => {
  it("maps videos and channel info; sends startUrls with maxResults", async () => {
    let sent: unknown;
    const d = deps(
      [
        { title: "Fasting mistakes", url: "https://www.youtube.com/watch?v=1", date: "2026-08-01T00:00:00.000Z", channelName: "Thomas", channelDescription: "Science-based nutrition", numberOfSubscribers: 3600000, channelUrl: "https://www.youtube.com/@ThomasDeLauerOfficial" },
      ],
      (b) => (sent = b),
    );
    d.apify.actors.youtube = "streamers/youtube-channel-scraper";
    const b = await fetchYouTube({ platform: "youtube", handle: "ThomasDeLauerOfficial", url: "https://www.youtube.com/@ThomasDeLauerOfficial" }, d);
    expect(sent).toEqual({ startUrls: [{ url: "https://www.youtube.com/@ThomasDeLauerOfficial" }], maxResults: 12, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: "NEWEST" });
    expect(b.displayName).toBe("Thomas");
    expect(b.followers).toBe(3600000);
    expect(b.items).toEqual([{ url: "https://www.youtube.com/watch?v=1", text: "Fasting mistakes", postedAt: "2026-08-01T00:00:00.000Z" }]);
  });
});

describe("fetchReddit", () => {
  it("keeps posts and comments, reads profile from the user row", async () => {
    let sent: unknown;
    const d = deps(
      [
        { dataType: "user", username: "pete", profileDescription: "peptide nerd", followersCount: 12, profileUrl: "https://www.reddit.com/user/pete/" },
        { dataType: "post", title: "My BPC experience", body: "long story", postUrl: "https://www.reddit.com/r/x/comments/1/", createdAt: "2026-08-01T00:00:00.000Z" },
        { dataType: "comment", body: "agreed, purity matters", postUrl: "https://www.reddit.com/r/x/comments/2/c1/", createdAt: "2026-08-02T00:00:00.000Z" },
      ],
      (b) => (sent = b),
    );
    d.apify.actors.reddit = "harshmaur/reddit-user-scraper";
    const b = await fetchReddit({ platform: "reddit", handle: "pete", url: "https://www.reddit.com/user/pete/" }, d);
    expect(sent).toEqual({ usernames: ["pete"], maxPostsCount: 8, maxCommentsCount: 8, includeNSFW: false });
    expect(b.bio).toBe("peptide nerd");
    expect(b.items).toEqual([
      { url: "https://www.reddit.com/r/x/comments/1/", text: "My BPC experience — long story", postedAt: "2026-08-01T00:00:00.000Z" },
      { url: "https://www.reddit.com/r/x/comments/2/c1/", text: "agreed, purity matters", postedAt: "2026-08-02T00:00:00.000Z" },
    ]);
  });
});

describe("fetchX", () => {
  it("maps tweets and author; sends twitterHandles with maxItems", async () => {
    let sent: unknown;
    const d = deps(
      [{ fullText: "Sleep is the cheapest nootropic", url: "https://x.com/joe/status/1", createdAt: "Mon Aug 04 12:00:00 +0000 2026", author: { userName: "joe", name: "Joe", description: "biohacker", followers: 900, url: "https://x.com/joe" } }],
      (b) => (sent = b),
    );
    d.apify.actors.x = "apidojo/twitter-profile-scraper";
    const b = await fetchX({ platform: "x", handle: "joe", url: "https://x.com/joe" }, d);
    expect(sent).toEqual({ twitterHandles: ["joe"], maxItems: 12, includeNativeRetweets: false });
    expect(b.displayName).toBe("Joe");
    expect(b.followers).toBe(900);
    expect(b.items[0]?.text).toBe("Sleep is the cheapest nootropic");
    expect(b.items[0]?.postedAt).toBe("2026-08-04T12:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL on missing fetcher modules.

- [ ] **Step 3: Implement the three fetchers**

`packages/scraping/src/fetchers/youtube.ts`:

```ts
// streamers/youtube-channel-scraper: one row per video, channel fields on
// each row. Input is the channel URL (handle URLs work).

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface YouTubeRow {
  title?: string;
  url?: string;
  date?: string;
  channelName?: string;
  channelDescription?: string | null;
  numberOfSubscribers?: number | null;
  channelUrl?: string;
  error?: string;
}

export const fetchYouTube: Fetcher = async (c, deps) => {
  const rows = await runActorSync<YouTubeRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.youtube ?? "streamers/youtube-channel-scraper",
    { startUrls: [{ url: c.url }], maxResults: deps.maxItems, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: "NEWEST" },
  );
  const videos = rows.filter((r) => !r.error && r.url);
  const first = videos[0];
  const items: SourceItem[] = videos.map((r) => ({ url: r.url ?? "", text: clip(r.title), postedAt: toIso(r.date) }));
  return {
    platform: "youtube",
    profileUrl: first?.channelUrl ?? c.url,
    displayName: first?.channelName ?? null,
    bio: first?.channelDescription ? clip(first.channelDescription, 300) : null,
    followers: toNumber(first?.numberOfSubscribers),
    items: takeItems(items, deps.maxItems),
  };
};
```

`packages/scraping/src/fetchers/reddit.ts`:

```ts
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
```

`packages/scraping/src/fetchers/x.ts`:

```ts
// apidojo/twitter-profile-scraper: one row per tweet with an embedded author.

import { runActorSync } from "../apify.js";
import type { Fetcher, SourceItem } from "../types.js";
import { clip, takeItems, toIso, toNumber } from "./shared.js";

interface XRow {
  fullText?: string;
  text?: string;
  url?: string;
  twitterUrl?: string;
  createdAt?: string;
  isRetweet?: boolean;
  author?: { userName?: string; name?: string; description?: string; followers?: number; url?: string };
}

export const fetchX: Fetcher = async (c, deps) => {
  const rows = await runActorSync<XRow>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.x ?? "apidojo/twitter-profile-scraper",
    { twitterHandles: [c.handle ?? c.url], maxItems: deps.maxItems, includeNativeRetweets: false },
  );
  const tweets = rows.filter((r) => !r.isRetweet);
  const a = tweets[0]?.author;
  const items: SourceItem[] = tweets.map((r) => ({ url: r.url ?? r.twitterUrl ?? "", text: clip(r.fullText ?? r.text), postedAt: toIso(r.createdAt) }));
  return {
    platform: "x",
    profileUrl: a?.url ?? c.url,
    displayName: a?.name ?? a?.userName ?? null,
    bio: a?.description ? clip(a.description, 300) : null,
    followers: toNumber(a?.followers),
    items: takeItems(items, deps.maxItems),
  };
};
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, 22 tests.

```bash
git add packages/scraping
git commit -m "feat(scraping): YouTube, Reddit, and X fetchers"
```

---

### Task 5: Web page and link-hub fetchers, and the fetcher registry

**Files:**
- Create: `packages/scraping/src/fetchers/web.ts`
- Create: `packages/scraping/src/fetchers/index.ts`
- Modify: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/web.test.ts`

**Interfaces:**
- Produces: `fetchWeb: Fetcher`, `fetchLinkHub: Fetcher`, `htmlToText(html): string`, `fetcherFor(platform): Fetcher`.

- [ ] **Step 1: Write failing tests**

`packages/scraping/test/web.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchLinkHub, fetchWeb, htmlToText } from "../src/fetchers/web.js";
import { fetcherFor } from "../src/fetchers/index.js";
import type { FetchDeps } from "../src/types.js";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const deps = (res: Response): FetchDeps => ({
  fetchImpl: vi.fn(async () => res) as typeof fetch,
  apify: { token: "t", actors: {} },
  maxItems: 12,
});

describe("htmlToText", () => {
  it("strips scripts, styles, tags; collapses whitespace", () => {
    const t = htmlToText("<html><head><style>p{}</style><script>x()</script><title>Outliyr</title></head><body><h1>Top  biohackers</h1><p>Dave &amp; co</p></body></html>");
    expect(t).toBe("Outliyr Top biohackers Dave & co");
  });
});

describe("fetchWeb", () => {
  it("returns one item with the page text, capped at 4000 chars, title as displayName", async () => {
    const long = "word ".repeat(2000);
    const b = await fetchWeb({ platform: "web", handle: null, url: "https://outliyr.com/x" }, deps(html(`<title>Outliyr</title><body>${long}</body>`)));
    expect(b.displayName).toBe("Outliyr");
    expect(b.items).toHaveLength(1);
    expect(b.items[0]?.url).toBe("https://outliyr.com/x");
    expect(b.items[0]?.text.length).toBeLessThanOrEqual(4000);
  });
  it("returns an empty bundle on 404 (reachable, nothing there) and throws on 5xx", async () => {
    const gone = await fetchWeb({ platform: "web", handle: null, url: "https://a.com" }, deps(html("nope", 404)));
    expect(gone.items).toEqual([]);
    await expect(fetchWeb({ platform: "web", handle: null, url: "https://a.com" }, deps(html("err", 503)))).rejects.toThrow(/503/);
  });
});

describe("fetchLinkHub", () => {
  it("discovers social links and returns no items itself", async () => {
    const page = `<a href="https://www.tiktok.com/@shelby">TikTok</a><a href="https://instagram.com/shelbypep">IG</a><a href="https://shop.example.com">Shop</a>`;
    const b = await fetchLinkHub({ platform: "linkhub", handle: null, url: "https://linktr.ee/shelby" }, deps(html(page)));
    expect(b.items).toEqual([]);
    expect(b.discovered).toEqual([
      { platform: "tiktok", handle: "shelby", url: "https://www.tiktok.com/@shelby" },
      { platform: "instagram", handle: "shelbypep", url: "https://www.instagram.com/shelbypep/" },
    ]);
  });
});

describe("fetcherFor", () => {
  it("returns a fetcher for every platform", () => {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "x", "web", "linkhub"] as const) {
      expect(typeof fetcherFor(p)).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL on missing modules.

- [ ] **Step 3: Implement**

`packages/scraping/src/fetchers/web.ts`:

```ts
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
  const res = await fetchImpl(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
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
  return { platform: "linkhub", profileUrl: c.url, displayName: html ? titleOf(html) : null, bio: null, followers: null, items: [], discovered };
};
```

`packages/scraping/src/fetchers/index.ts`:

```ts
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
```

Append to `packages/scraping/src/index.ts`:

```ts
export * from "./fetchers/index.js";
export { htmlToText } from "./fetchers/web.js";
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, 28 tests.

```bash
git add packages/scraping
git commit -m "feat(scraping): web and link-hub fetchers, fetcher registry"
```

---

### Task 6: `summarize` with URL verification

**Files:**
- Create: `packages/scraping/src/summarize.ts`
- Modify: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/summarize.test.ts`

**Interfaces:**
- Consumes: `LlmClient` from `@biolinx/drafting` (`complete(system, user, model): Promise<string>`).
- Produces: `summarizeBundle(llm, bundle, model?): Promise<Summary>`, `buildNote(points): string`, `verifyPoints(points, bundle): SummaryPoint[]`.

- [ ] **Step 1: Write failing tests**

`packages/scraping/test/summarize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LlmClient } from "@biolinx/drafting";
import { buildNote, summarizeBundle, verifyPoints } from "../src/summarize.js";
import type { SourceBundle } from "../src/types.js";

const bundle: SourceBundle = {
  platform: "tiktok",
  profileUrl: "https://www.tiktok.com/@annie",
  displayName: "Annie",
  bio: "NP · hormones",
  followers: 42000,
  items: [
    { url: "https://www.tiktok.com/@annie/video/1", text: "The exact list I pull when a woman says she doesn't feel like herself", postedAt: null },
    { url: "https://www.tiktok.com/@annie/video/2", text: "HRT not working? your body lacks a foundation", postedAt: null },
  ],
};

const llm = (reply: string): LlmClient => ({ complete: async () => reply });

describe("verifyPoints", () => {
  it("drops points whose url is not in the bundle", () => {
    const kept = verifyPoints(
      [
        { text: "real", url: "https://www.tiktok.com/@annie/video/1" },
        { text: "invented", url: "https://www.tiktok.com/@annie/video/999" },
        { text: "profile-level ok", url: "https://www.tiktok.com/@annie" },
      ],
      bundle,
    );
    expect(kept.map((p) => p.text)).toEqual(["real", "profile-level ok"]);
  });
});

describe("buildNote", () => {
  it("formats exactly like the August notes", () => {
    expect(buildNote([{ text: "a", url: "https://x/1" }, { text: "b", url: "https://x/2" }])).toBe("MATCH — a (https://x/1); b (https://x/2).");
  });
});

describe("summarizeBundle", () => {
  it("returns match with verified points and a built note", async () => {
    const s = await summarizeBundle(
      llm(JSON.stringify({ verdict: "match", points: [{ text: "NP posting real perimenopause content: 'the exact list I pull'", url: "https://www.tiktok.com/@annie/video/1" }] })),
      bundle,
    );
    expect(s.verdict).toBe("match");
    expect(s.points).toHaveLength(1);
    expect(s.note).toBe("MATCH — NP posting real perimenopause content: 'the exact list I pull' (https://www.tiktok.com/@annie/video/1).");
  });

  it("becomes no_match when every point is unverifiable, even if the model said match", async () => {
    const s = await summarizeBundle(llm(JSON.stringify({ verdict: "match", points: [{ text: "x", url: "https://nowhere" }] })), bundle);
    expect(s).toEqual({ verdict: "no_match", points: [], note: "" });
  });

  it("returns no_match for an empty bundle without calling the model", async () => {
    let called = 0;
    const spy: LlmClient = { complete: async () => (called++, "") };
    const s = await summarizeBundle(spy, { ...bundle, items: [] });
    expect(s.verdict).toBe("no_match");
    expect(called).toBe(0);
  });

  it("throws on malformed JSON so the caller marks the lead failed", async () => {
    await expect(summarizeBundle(llm("not json"), bundle)).rejects.toThrow(/summarize: unparseable/);
  });

  it("caps at 3 points", async () => {
    const pts = Array.from({ length: 5 }, (_, i) => ({ text: `p${i}`, url: bundle.items[i % 2]!.url }));
    const s = await summarizeBundle(llm(JSON.stringify({ verdict: "match", points: pts })), bundle);
    expect(s.points).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/scraping test`
Expected: FAIL on missing `../src/summarize.js`.

- [ ] **Step 3: Implement**

`packages/scraping/src/summarize.ts`:

```ts
// One Claude call turns a SourceBundle into 1–3 talking points, each tied to
// a URL from the bundle. Code verifies every URL and builds the note text;
// the model never writes to the database directly.

import type { LlmClient } from "@biolinx/drafting";
import type { SourceBundle, Summary, SummaryPoint } from "./types.js";

const SYSTEM = `You research creators for an affiliate-recruiting team at a research-peptide brand. From the profile and posts given, extract 1 to 3 genuine, specific talking points a recruiter could reference in a first message.
Rules:
- Every point must cite the exact "url" of the post it comes from (or the profile url for a bio detail). Never invent a post, a quote, or a number.
- Quote short fragments verbatim where useful. Prefer wellness, fitness, recovery, biohacking, hormones, longevity, women's health, or supplement-adjacent content.
- If the content is unrelated to health or fitness, or too thin to say anything specific, answer verdict "no_match".
- Never mention drug names, dosing, or what any product does to a body.
Respond with JSON only: {"verdict":"match"|"no_match","points":[{"text":string,"url":string}]}`;

function userPrompt(b: SourceBundle): string {
  const lines = [
    `Platform: ${b.platform}`,
    `Profile url: ${b.profileUrl}`,
    `Name: ${b.displayName ?? "(unknown)"}`,
    `Bio: ${b.bio ?? "(none)"}`,
    `Followers: ${b.followers ?? "(unknown)"}`,
    "",
    "Posts:",
    ...b.items.map((i, n) => `${n + 1}. url: ${i.url}\n   text: ${i.text}`),
  ];
  return lines.join("\n");
}

export function verifyPoints(points: SummaryPoint[], bundle: SourceBundle): SummaryPoint[] {
  const allowed = new Set([bundle.profileUrl, ...bundle.items.map((i) => i.url)]);
  return points.filter((p) => typeof p.text === "string" && p.text.trim().length > 0 && allowed.has(p.url));
}

export function buildNote(points: SummaryPoint[]): string {
  if (points.length === 0) return "";
  return `MATCH — ${points.map((p) => `${p.text.trim()} (${p.url})`).join("; ")}.`;
}

export async function summarizeBundle(
  llm: LlmClient,
  bundle: SourceBundle,
  model = process.env.DRAFT_MODEL ?? "claude-sonnet-5",
): Promise<Summary> {
  if (bundle.items.length === 0) return { verdict: "no_match", points: [], note: "" };
  const raw = await llm.complete(SYSTEM, userPrompt(bundle), model);
  const jsonText = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: { verdict?: string; points?: SummaryPoint[] };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    throw new Error(`summarize: unparseable model output (${raw.slice(0, 80)})`);
  }
  const points = verifyPoints(Array.isArray(parsed.points) ? parsed.points : [], bundle).slice(0, 3);
  if (parsed.verdict !== "match" || points.length === 0) return { verdict: "no_match", points: [], note: "" };
  return { verdict: "match", points, note: buildNote(points) };
}
```

Append to `packages/scraping/src/index.ts`:

```ts
export * from "./summarize.js";
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, 34 tests.

```bash
git add packages/scraping
git commit -m "feat(scraping): summarizeBundle with deterministic URL verification"
```

---

### Task 7: Database schema additions

**Files:**
- Modify: `packages/db/src/schema.ts` (leads block lines 86–90 and after `leadHandles`)

**Interfaces:**
- Produces: `schema.leads.enrichmentStatus | enrichedAt | enrichmentSourceUrl | enrichmentAttempts`, `schema.leadEnrichments`.

- [ ] **Step 1: Edit the leads table**

In `packages/db/src/schema.ts`, replace:

```ts
  isDead: boolean("is_dead").default(false).notNull(),
  needsEnrichment: boolean("needs_enrichment").default(false).notNull(),
```

with:

```ts
  isDead: boolean("is_dead").default(false).notNull(),
  // Enrichment (enrich-personalize job). NULL = never attempted.
  enrichmentStatus: varchar("enrichment_status", { length: 16 }), // pending | enriched | no_match | no_source | unresolvable | failed
  enrichedAt: datetime("enriched_at"),
  enrichmentSourceUrl: varchar("enrichment_source_url", { length: 500 }),
  enrichmentAttempts: int("enrichment_attempts").default(0).notNull(),
```

- [ ] **Step 2: Add the history table**

After the `leadHandles` table definition, add:

```ts
/** One row per enrichment attempt — the audit trail behind every note. The
 *  bundle is compact (profile fields + item urls + first 300 chars of text);
 *  rows older than 90 days are pruned by the job (PII retention). */
export const leadEnrichments = mysqlTable("lead_enrichments", {
  id: id(),
  leadId: int("lead_id").notNull(),
  platform: varchar("platform", { length: 16 }).notNull(),
  sourceUrl: varchar("source_url", { length: 500 }).notNull(),
  bundle: json("bundle"),
  notes: text("notes"),
  status: varchar("status", { length: 16 }).notNull(), // enriched | no_match | unresolvable | failed
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("enrich_lead").on(t.leadId), index("enrich_created").on(t.createdAt)]);
```

- [ ] **Step 3: Push the schema to the local database and typecheck**

Run: `pnpm --filter @biolinx/db typecheck && pnpm --filter @biolinx/db push`
Expected: typecheck clean; drizzle-kit reports the new columns and table applied. If it prompts about dropping `needs_enrichment`, confirm (no code reads it).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): enrichment status on leads + lead_enrichments history table"
```

---

### Task 8: Cadence date helper

**Files:**
- Create: `packages/jobs/src/cadence-dates.ts`
- Modify: `packages/jobs/src/index.ts`
- Test: `packages/jobs/test/cadence-dates.test.ts`

**Interfaces:**
- Consumes: `COLD_CADENCE`, `WARM_CADENCE`, `nextDue` from `@biolinx/core`.
- Produces: `todayInTz(tz, now?): Date` (UTC midnight of the local calendar date), `nextFollowUpDateAfterSend(motion, touchNumber, now?, tz?): Date | null`, `maxTouchesFor(motion): number`.

- [ ] **Step 1: Write failing tests**

`packages/jobs/test/cadence-dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { maxTouchesFor, nextFollowUpDateAfterSend, todayInTz } from "../src/cadence-dates.js";

describe("todayInTz", () => {
  it("uses the business calendar date, not UTC", () => {
    // 2026-09-09T05:30Z is still 2026-09-08 in Los Angeles.
    const d = todayInTz("America/Los_Angeles", new Date("2026-09-09T05:30:00Z"));
    expect(d.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("nextFollowUpDateAfterSend", () => {
  const now = new Date("2026-09-08T20:00:00Z");
  it("cold motion A: opener → +4 days", () => {
    expect(nextFollowUpDateAfterSend("A", 1, now, "UTC")?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
  it("cold motion A: touch 4 is the last → null", () => {
    expect(nextFollowUpDateAfterSend("A", 4, now, "UTC")).toBeNull();
  });
  it("warm motion B: opener → +10 days, touch 7 → +30", () => {
    expect(nextFollowUpDateAfterSend("B", 1, now, "UTC")?.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(nextFollowUpDateAfterSend("B", 7, now, "UTC")?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
});

describe("maxTouchesFor", () => {
  it("is 4 for cold and 12 for warm", () => {
    expect(maxTouchesFor("A")).toBe(4);
    expect(maxTouchesFor("B")).toBe(12);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/jobs test`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement**

`packages/jobs/src/cadence-dates.ts`:

```ts
// Turns the cadence engine's "days until next touch" into a concrete
// next_follow_up_date in the business timezone (D6: America/Los_Angeles).

import { COLD_CADENCE, WARM_CADENCE, nextDue, type CadenceConfig } from "@biolinx/core";

export type Motion = "A" | "B";

export function cadenceFor(motion: Motion): CadenceConfig {
  return motion === "B" ? WARM_CADENCE : COLD_CADENCE;
}

export function maxTouchesFor(motion: Motion): number {
  return cadenceFor(motion).maxTouches;
}

/** UTC midnight of the calendar date `now` falls on in `tz`. */
export function todayInTz(tz: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${parts}T00:00:00Z`);
}

/** Date the next touch becomes due after touch `touchNumber` was sent, or
 *  null when the cadence is exhausted. */
export function nextFollowUpDateAfterSend(
  motion: Motion,
  touchNumber: number,
  now = new Date(),
  tz = process.env.BUSINESS_TZ ?? "America/Los_Angeles",
): Date | null {
  const days = nextDue(cadenceFor(motion), touchNumber);
  if (days == null) return null;
  const d = todayInTz(tz, now);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
```

Append to `packages/jobs/src/index.ts`:

```ts
export * from "./cadence-dates.js";
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/jobs test && pnpm --filter @biolinx/jobs typecheck`
Expected: PASS, 11 tests in jobs.

```bash
git add packages/jobs
git commit -m "feat(jobs): cadence date helper for next_follow_up_date"
```

---

### Task 9: Dispatch fixes

**Files:**
- Modify: `packages/jobs/src/outreach-dispatch.ts`
- Test: `packages/jobs/test/outreach-dispatch.test.ts`

**Interfaces:**
- Consumes: `hasUsableNotes` from `@biolinx/core`; `nextFollowUpDateAfterSend`, `maxTouchesFor` from Task 8.
- Produces: exported pure `isDispatchCandidate(lead, opts)` and `touchUpdate(lead, touchNumber, channel)` used by the job and tested directly; `DispatchSummary.skippedUnenriched`.

- [ ] **Step 1: Write failing tests**

`packages/jobs/test/outreach-dispatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isDispatchCandidate, touchUpdate } from "../src/outreach-dispatch.js";

const lead = {
  id: 1,
  isDead: false,
  subProfile: "SP1 self-verifying veteran",
  affiliationStatus: "Unsigned",
  status: "Not contacted",
  email: "a@b.com",
  conversionRank: 5,
  nextFollowUpDate: null as Date | null,
  followUpsSent: 0,
  motion: "A",
  personalizationNotes: "MATCH — real detail (https://x/1).",
};
const today = new Date("2026-09-08T00:00:00Z");

describe("isDispatchCandidate", () => {
  it("accepts a ranked, alive, noted, uncontacted lead", () => {
    expect(isDispatchCandidate(lead, { channel: "dm", today, openReplyLeadIds: new Set() })).toBe("ok");
  });
  it("skips leads without usable notes (precondition, not a block)", () => {
    expect(isDispatchCandidate({ ...lead, personalizationNotes: null }, { channel: "dm", today, openReplyLeadIds: new Set() })).toBe("unenriched");
    expect(isDispatchCandidate({ ...lead, personalizationNotes: "NOT USABLE — nothing" }, { channel: "dm", today, openReplyLeadIds: new Set() })).toBe("unenriched");
  });
  it("skips SP5, dead, converted, terminal status, open reply, not-yet-due", () => {
    const o = { channel: "dm" as const, today, openReplyLeadIds: new Set<number>() };
    expect(isDispatchCandidate({ ...lead, subProfile: "SP5 goodwill advocate — DO NOT DM" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, isDead: true }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, affiliationStatus: "Our affiliate" }, o)).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, status: "Passed" }, o)).toBe("ineligible");
    expect(isDispatchCandidate(lead, { ...o, openReplyLeadIds: new Set([1]) })).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, nextFollowUpDate: new Date("2026-09-09T00:00:00Z") }, o)).toBe("ineligible");
  });
  it("skips leads that exhausted their cadence", () => {
    expect(isDispatchCandidate({ ...lead, followUpsSent: 4, motion: "A" }, { channel: "dm", today, openReplyLeadIds: new Set() })).toBe("ineligible");
    expect(isDispatchCandidate({ ...lead, followUpsSent: 4, motion: "B" }, { channel: "dm", today, openReplyLeadIds: new Set() })).toBe("ok");
  });
  it("requires an email for the email channel", () => {
    expect(isDispatchCandidate({ ...lead, email: null }, { channel: "email", today, openReplyLeadIds: new Set() })).toBe("ineligible");
  });
});

describe("touchUpdate", () => {
  it("writes touch bookkeeping and the next follow-up date from the cadence", () => {
    const u = touchUpdate({ motion: "A" }, 1, "Email", new Date("2026-09-08T20:00:00Z"), "UTC");
    expect(u.followUpsSent).toBe(1);
    expect(u.status).toBe("Contacted");
    expect(u.contactChannel).toBe("Email");
    expect(u.nextFollowUpDate?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
  it("sets nextFollowUpDate null when exhausted", () => {
    expect(touchUpdate({ motion: "A" }, 4, "TikTok DM", new Date(), "UTC").nextFollowUpDate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @biolinx/jobs test`
Expected: FAIL: `isDispatchCandidate` is not exported.

- [ ] **Step 3: Refactor dispatch**

In `packages/jobs/src/outreach-dispatch.ts`:

Replace the import block's `@biolinx/core` line with:

```ts
import {
  hasUsableNotes,
  isConverted,
  isSp5,
  messageKey,
  normalizeEmail,
  type ContactChannel,
} from "@biolinx/core";
import { maxTouchesFor, nextFollowUpDateAfterSend, type Motion } from "./cadence-dates.js";
```

Add `skippedUnenriched: number;` to `DispatchSummary` and initialize it to `0` in `summary`.

Add these exports above `runOutreachDispatch`:

```ts
const TERMINAL_STATUSES = ["Passed", "Signed", "No", "Signed up"];

export interface CandidateLead {
  id: number;
  isDead: boolean;
  subProfile: string | null;
  affiliationStatus: string | null;
  status: string | null;
  email: string | null;
  conversionRank: number | null;
  nextFollowUpDate: Date | string | null;
  followUpsSent: number;
  motion: string;
  personalizationNotes: string | null;
}

export type CandidateVerdict = "ok" | "unenriched" | "ineligible";

/** Pure eligibility check. "unenriched" is the only soft skip: the lead is
 *  fine, it just has no talking points yet. */
export function isDispatchCandidate(
  l: CandidateLead,
  o: { channel: "email" | "dm"; today: Date; openReplyLeadIds: Set<number> },
): CandidateVerdict {
  if (l.isDead || isSp5(l.subProfile) || isConverted(l.affiliationStatus)) return "ineligible";
  if (TERMINAL_STATUSES.includes(l.status ?? "")) return "ineligible";
  if (o.channel === "email" && !l.email) return "ineligible";
  if (l.conversionRank == null) return "ineligible";
  if (o.openReplyLeadIds.has(l.id)) return "ineligible";
  if (l.nextFollowUpDate != null && new Date(l.nextFollowUpDate) > o.today) return "ineligible";
  if ((l.followUpsSent ?? 0) >= maxTouchesFor((l.motion as Motion) === "B" ? "B" : "A")) return "ineligible";
  if (!hasUsableNotes(l.personalizationNotes)) return "unenriched";
  return "ok";
}

/** Lead-row update after a confirmed send: bookkeeping + next due date. */
export function touchUpdate(
  l: { motion: string },
  touchNumber: number,
  contactChannel: ContactChannel,
  now = new Date(),
  tz?: string,
): { lastReachedOut: Date; followUpsSent: number; status: string; contactChannel: ContactChannel; nextFollowUpDate: Date | null } {
  const motion: Motion = l.motion === "B" ? "B" : "A";
  return {
    lastReachedOut: now,
    followUpsSent: touchNumber,
    status: "Contacted",
    contactChannel,
    nextFollowUpDate: nextFollowUpDateAfterSend(motion, touchNumber, now, tz),
  };
}
```

Replace the candidate selection (from `const today = new Date();` through `.sort(...)`) with:

```ts
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const verdictOpts = { channel: opts.channel, today, openReplyLeadIds };
    const candidates = all
      .filter((l) => {
        const v = isDispatchCandidate(l, verdictOpts);
        if (v === "unenriched") summary.skippedUnenriched++;
        return v === "ok";
      })
      .sort((a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9));
```

In the auto-send success path, replace:

```ts
        await db
          .update(schema.leads)
          .set({ lastReachedOut: new Date(), followUpsSent: touchNumber, status: "Contacted", contactChannel: "Email" })
          .where(eq(schema.leads.id, lead.id));
```

with:

```ts
        await db.update(schema.leads).set(touchUpdate(lead, touchNumber, "Email")).where(eq(schema.leads.id, lead.id));
```

In `confirmSent`, replace the `db.update(schema.leads).set({...})` call with:

```ts
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, msg.leadId) });
  await db
    .update(schema.leads)
    .set(touchUpdate({ motion: lead?.motion ?? "A" }, msg.touchNumber, contactChannel))
    .where(eq(schema.leads.id, msg.leadId));
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/jobs test && pnpm --filter @biolinx/jobs typecheck`
Expected: PASS, 18 tests in jobs.

```bash
git add packages/jobs
git commit -m "fix(dispatch): notes are a precondition, not a block; write next_follow_up_date from the cadence"
```

---

### Task 10: The `enrich-personalize` job

**Files:**
- Modify: `packages/jobs/package.json` (add `"@biolinx/scraping": "workspace:*"`)
- Create: `packages/jobs/src/enrich-personalize.ts`
- Modify: `packages/jobs/src/index.ts`
- Test: `packages/jobs/test/enrich-personalize.test.ts`

**Interfaces:**
- Consumes: `resolveCandidates`, `fetcherFor`, `summarizeBundle`, `apifyConfigFromEnv`, types from `@biolinx/scraping`; `LlmClient` from `@biolinx/drafting`; `hasUsableNotes`, `FAILURE_NOTE_PATTERN` from `@biolinx/core`.
- Produces: `runEnrichPersonalize(db, deps, opts?)`, pure `enrichOne(lead, deps): Promise<EnrichOutcome>`, `EnrichDeps`, `enrichDepsFromEnv()`.

- [ ] **Step 1: Add the dependency**

In `packages/jobs/package.json` dependencies add `"@biolinx/scraping": "workspace:*"`. Run `pnpm install`.

- [ ] **Step 2: Write failing tests for the pure per-lead path**

`packages/jobs/test/enrich-personalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Fetcher, SourceBundle, SourceCandidate } from "@biolinx/scraping";
import type { LlmClient } from "@biolinx/drafting";
import { enrichOne, type EnrichDeps } from "../src/enrich-personalize.js";

const bundle = (platform: SourceBundle["platform"], items: number, extra: Partial<SourceBundle> = {}): SourceBundle => ({
  platform,
  profileUrl: `https://${platform}.example/p`,
  displayName: "P",
  bio: null,
  followers: null,
  items: Array.from({ length: items }, (_, i) => ({ url: `https://${platform}.example/p/${i}`, text: `post ${i}`, postedAt: null })),
  ...extra,
});

function deps(fetchers: Partial<Record<string, Fetcher>>, llmReply: string | Error): EnrichDeps {
  const llm: LlmClient = { complete: async () => { if (llmReply instanceof Error) throw llmReply; return llmReply; } };
  return {
    llm,
    fetchDeps: { fetchImpl: fetch, apify: { token: "t", actors: {} }, maxItems: 12 },
    fetcherFor: (p) => fetchers[p] ?? (async () => { throw new Error(`no fetcher for ${p}`); }),
    model: "test-model",
  };
}

const lead = { id: 7, primaryPlatform: "TikTok", socialProfiles: "TikTok @a; IG @b", whereFound: null, websiteUrl: null, reachSourceUrl: null };
const match = (url: string) => JSON.stringify({ verdict: "match", points: [{ text: "real thing", url }] });

describe("enrichOne", () => {
  it("no candidates → no_source", async () => {
    const out = await enrichOne({ ...lead, socialProfiles: null, primaryPlatform: null }, deps({}, "{}"));
    expect(out.status).toBe("no_source");
  });

  it("first candidate with items wins; notes built; handles recorded", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, match("https://tiktok.example/p/0")));
    expect(out.status).toBe("enriched");
    expect(out.notes).toBe("MATCH — real thing (https://tiktok.example/p/0).");
    expect(out.sourceUrl).toBe("https://tiktok.example/p");
    expect(out.handles).toEqual([
      { key: "tiktok:a", url: "https://www.tiktok.com/@a", verified: true },
      { key: "instagram:b", url: "https://www.instagram.com/b/", verified: false },
    ]);
  });

  it("empty first candidate falls through to the second", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 0), instagram: async () => bundle("instagram", 1) }, match("https://instagram.example/p/0")));
    expect(out.status).toBe("enriched");
    expect(out.platform).toBe("instagram");
  });

  it("all candidates empty → unresolvable", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 0), instagram: async () => bundle("instagram", 0) }, "{}"));
    expect(out.status).toBe("unresolvable");
  });

  it("fetcher error on one candidate moves on; all errored → failed with the last error", async () => {
    const boom: Fetcher = async () => { throw new Error("actor timeout"); };
    const partial = await enrichOne(lead, deps({ tiktok: boom, instagram: async () => bundle("instagram", 1) }, match("https://instagram.example/p/0")));
    expect(partial.status).toBe("enriched");
    const all = await enrichOne(lead, deps({ tiktok: boom, instagram: boom }, "{}"));
    expect(all.status).toBe("failed");
    expect(all.error).toMatch(/actor timeout/);
  });

  it("link hub discoveries are appended as candidates", async () => {
    const hubLead = { ...lead, primaryPlatform: null, socialProfiles: null, websiteUrl: "https://linktr.ee/x" };
    const disc: SourceCandidate = { platform: "tiktok", handle: "found", url: "https://www.tiktok.com/@found" };
    const out = await enrichOne(hubLead, deps({ linkhub: async () => bundle("linkhub", 0, { discovered: [disc] }), tiktok: async () => bundle("tiktok", 1) }, match("https://tiktok.example/p/0")));
    expect(out.status).toBe("enriched");
    expect(out.platform).toBe("tiktok");
  });

  it("model says no → no_match with the bundle kept", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, JSON.stringify({ verdict: "no_match", points: [] })));
    expect(out.status).toBe("no_match");
    expect(out.bundle?.items).toHaveLength(2);
  });

  it("LLM error → failed, bundle still returned for the history row", async () => {
    const out = await enrichOne(lead, deps({ tiktok: async () => bundle("tiktok", 2) }, new Error("529")));
    expect(out.status).toBe("failed");
    expect(out.bundle).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @biolinx/jobs test`
Expected: FAIL on missing module.

- [ ] **Step 4: Implement the job**

`packages/jobs/src/enrich-personalize.ts`:

```ts
// enrich-personalize (spec §6) — researches leads so the drafting engine has
// real talking points. Pure per-lead path (enrichOne) + a thin DB orchestrator.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { FAILURE_NOTE_PATTERN, handleKey, hasUsableNotes, isConverted, isSp5 } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { anthropicFromEnv, type LlmClient } from "@biolinx/drafting";
import { alert, telegramFromEnv } from "@biolinx/notify";
import {
  apifyConfigFromEnv,
  fetcherFor as defaultFetcherFor,
  resolveCandidates,
  summarizeBundle,
  type FetchDeps,
  type Fetcher,
  type ResolveInput,
  type SourceBundle,
  type SourceCandidate,
  type SourcePlatform,
} from "@biolinx/scraping";

export interface EnrichDeps {
  llm: LlmClient;
  fetchDeps: FetchDeps;
  fetcherFor: (platform: SourcePlatform) => Fetcher;
  model: string;
}

export type EnrichStatus = "enriched" | "no_match" | "no_source" | "unresolvable" | "failed";

export interface EnrichOutcome {
  status: EnrichStatus;
  platform: SourcePlatform | null;
  sourceUrl: string | null;
  notes: string | null;
  bundle: SourceBundle | null;
  error: string | null;
  handles: Array<{ key: string; url: string; verified: boolean }>;
}

const MAX_ATTEMPTS = 3;
const TERMINAL_STATUSES = ["Passed", "Signed", "No", "Signed up"];

export function enrichDepsFromEnv(env = process.env, actorOverrides: Record<string, string> = {}): EnrichDeps {
  const apify = apifyConfigFromEnv(env, actorOverrides);
  return {
    llm: anthropicFromEnv(env),
    fetchDeps: { fetchImpl: fetch, apify, maxItems: 12 },
    fetcherFor: defaultFetcherFor,
    model: env.DRAFT_MODEL ?? "claude-sonnet-5",
  };
}

/** Keep the history row small: item urls + first 300 chars of each text. */
function compactBundle(b: SourceBundle): SourceBundle {
  return { ...b, items: b.items.map((i) => ({ ...i, text: i.text.slice(0, 300) })) };
}

export async function enrichOne(lead: ResolveInput & { id: number }, deps: EnrichDeps): Promise<EnrichOutcome> {
  const queue: SourceCandidate[] = resolveCandidates(lead);
  const handles: EnrichOutcome["handles"] = [];
  const seenUrls = new Set(queue.map((c) => c.url));
  const noteHandle = (c: SourceCandidate, verified: boolean) => {
    if (!c.handle) return;
    const key = handleKey(c.platform, c.handle);
    const existing = handles.find((h) => h.key === key);
    if (existing) existing.verified = existing.verified || verified;
    else handles.push({ key, url: c.url, verified });
  };
  for (const c of queue) noteHandle(c, false);

  if (queue.length === 0) return { status: "no_source", platform: null, sourceUrl: null, notes: null, bundle: null, error: null, handles };

  let lastError: string | null = null;
  let anyReachable = false;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    let bundle: SourceBundle;
    try {
      bundle = await deps.fetcherFor(c.platform)(c, deps.fetchDeps);
    } catch (err) {
      lastError = `${c.platform} ${c.url}: ${(err as Error).message}`;
      continue;
    }
    anyReachable = true;
    for (const d of bundle.discovered ?? []) {
      if (!seenUrls.has(d.url)) {
        seenUrls.add(d.url);
        queue.push(d);
        noteHandle(d, false);
      }
    }
    if (bundle.items.length === 0) continue;
    noteHandle(c, true);

    try {
      const summary = await summarizeBundle(deps.llm, bundle, deps.model);
      const compact = compactBundle(bundle);
      if (summary.verdict === "match") {
        return { status: "enriched", platform: c.platform, sourceUrl: bundle.profileUrl, notes: summary.note, bundle: compact, error: null, handles };
      }
      return { status: "no_match", platform: c.platform, sourceUrl: bundle.profileUrl, notes: null, bundle: compact, error: null, handles };
    } catch (err) {
      return { status: "failed", platform: c.platform, sourceUrl: bundle.profileUrl, notes: null, bundle: compactBundle(bundle), error: (err as Error).message, handles };
    }
  }
  if (!anyReachable) return { status: "failed", platform: null, sourceUrl: null, notes: null, bundle: null, error: lastError, handles };
  return { status: "unresolvable", platform: null, sourceUrl: null, notes: null, bundle: null, error: lastError, handles };
}

export interface EnrichSummary {
  attempted: number;
  enriched: number;
  no_match: number;
  unresolvable: number;
  no_source: number;
  failed: number;
  cleaned: number;
  purgedBlockedDrafts: number;
}

export async function runEnrichPersonalize(
  db: Db = createDb(),
  deps: EnrichDeps = enrichDepsFromEnv(),
  opts: { cap?: number } = {},
): Promise<EnrichSummary> {
  const cap = opts.cap ?? Number(process.env.ENRICH_DAILY_CAP ?? 40);
  const telegram = telegramFromEnv();
  const summary: EnrichSummary = { attempted: 0, enriched: 0, no_match: 0, unresolvable: 0, no_source: 0, failed: 0, cleaned: 0, purgedBlockedDrafts: 0 };
  const startedAt = new Date();
  const [run] = await db.insert(schema.syncRuns).values({ job: "enrich-personalize", status: "running", startedAt }).$returningId();

  try {
    // One-time cleanup (idempotent): August failure markers are not notes.
    const all = await db.select().from(schema.leads);
    const stale = all.filter((l) => l.personalizationNotes != null && !hasUsableNotes(l.personalizationNotes) && FAILURE_NOTE_PATTERN.test(l.personalizationNotes));
    if (stale.length > 0) {
      await db.update(schema.leads).set({ personalizationNotes: null, enrichmentStatus: "pending" }).where(inArray(schema.leads.id, stale.map((l) => l.id)));
      summary.cleaned = stale.length;
    }
    // Blocked drafts whose only reason was missing notes are not real claims.
    const blocked = (await db.select().from(schema.messages).where(eq(schema.messages.state, "blocked"))).filter((m) => {
      const rep = (m.lintReport as Array<{ rule: string }> | null) ?? [];
      return rep.length > 0 && rep.every((v) => v.rule === "no-personalization");
    });
    if (blocked.length > 0) {
      await db.delete(schema.messages).where(inArray(schema.messages.id, blocked.map((m) => m.id)));
      summary.purgedBlockedDrafts = blocked.length;
    }
    // Retention: history rows older than 90 days.
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    await db.delete(schema.leadEnrichments).where(lt(schema.leadEnrichments.createdAt, cutoff));

    const fresh = stale.length > 0 ? await db.select().from(schema.leads) : all;
    const batch = fresh
      .filter(
        (l) =>
          !l.isDead &&
          !isSp5(l.subProfile) &&
          !isConverted(l.affiliationStatus) &&
          !TERMINAL_STATUSES.includes(l.status ?? "") &&
          !hasUsableNotes(l.personalizationNotes) &&
          (l.enrichmentStatus == null || l.enrichmentStatus === "pending" || (l.enrichmentStatus === "failed" && l.enrichmentAttempts < MAX_ATTEMPTS)),
      )
      .sort((a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9))
      .slice(0, cap);

    for (const lead of batch) {
      summary.attempted++;
      const out = await enrichOne(lead, deps);
      summary[out.status]++;
      const now = new Date();
      await db
        .update(schema.leads)
        .set({
          enrichmentStatus: out.status,
          enrichmentAttempts: sql`${schema.leads.enrichmentAttempts} + 1`,
          ...(out.status === "enriched" ? { personalizationNotes: out.notes, enrichedAt: now, enrichmentSourceUrl: out.sourceUrl } : {}),
        })
        .where(eq(schema.leads.id, lead.id));
      if (out.status !== "no_source") {
        await db.insert(schema.leadEnrichments).values({
          leadId: lead.id,
          platform: out.platform ?? "none",
          sourceUrl: out.sourceUrl ?? "",
          bundle: out.bundle,
          notes: out.notes,
          status: out.status,
          error: out.error,
        });
      }
      for (const h of out.handles) {
        await db
          .insert(schema.leadHandles)
          .values({ leadId: lead.id, handleKey: h.key, profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) })
          .onDuplicateKeyUpdate({ set: { profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) } });
      }
    }

    await db.update(schema.syncRuns).set({ status: "ok", finishedAt: new Date(), detail: summary }).where(eq(schema.syncRuns.id, run!.id));
    console.log(`[enrich-personalize] ok — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    const message = (err as Error).message;
    await db.update(schema.syncRuns).set({ status: "failed", finishedAt: new Date(), detail: { error: message, ...summary } }).where(eq(schema.syncRuns.id, run!.id));
    await alert(telegram, `enrich-personalize FAILED: ${message}`);
    throw err;
  }
}
```

Note for the implementer: `and` is imported for future filters; if the typechecker flags it unused, remove it from the import.

Append to `packages/jobs/src/index.ts`:

```ts
export * from "./enrich-personalize.js";
```

- [ ] **Step 5: Run, typecheck, commit**

Run: `pnpm --filter @biolinx/jobs test && pnpm --filter @biolinx/jobs typecheck`
Expected: PASS, 26 tests in jobs.

```bash
git add packages/jobs pnpm-lock.yaml
git commit -m "feat(jobs): enrich-personalize job with cleanup, retries, and history"
```

---

### Task 11: Worker schedule, API trigger, and admin surface

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/api/src/index.ts` (job triggers; lead rows; lead detail)
- Modify: `apps/admin/src/api.ts`, `apps/admin/src/labels.ts`, `apps/admin/src/pages/Leads.tsx`

**Interfaces:**
- Consumes: `runEnrichPersonalize` from `@biolinx/jobs`; `describeRun` in labels.

- [ ] **Step 1: Worker**

In `apps/worker/src/index.ts`, extend the jobs import to include `runEnrichPersonalize` and add to the `startScheduler` list, after `referral-expiry`:

```ts
  { name: "enrich-personalize", everyMs: 24 * HOUR, runOnBoot: true, fn: async () => void (await runEnrichPersonalize(conn.db)) },
```

Update the console line to mention `enrich 24h`.

- [ ] **Step 2: API trigger**

In `apps/api/src/index.ts`, add `runEnrichPersonalize` to the `@biolinx/jobs` import and to `jobTriggers`:

```ts
  "enrich-personalize": () => runEnrichPersonalize(db),
```

In the `/api/leads` row mapping add `enrichmentStatus: l.enrichmentStatus,` next to `hasNotes`. The `/api/leads/:id` detail already returns the whole lead row; add the last five history rows:

```ts
  const enrichments = await db
    .select()
    .from(schema.leadEnrichments)
    .where(eq(schema.leadEnrichments.leadId, id))
    .orderBy(desc(schema.leadEnrichments.id))
    .limit(5);
  return { lead, messages, replies, enrichments };
```

- [ ] **Step 3: Admin types and labels**

In `apps/admin/src/api.ts`: add `enrichmentStatus: string | null;` to `LeadRow`; add to `LeadDetail`:

```ts
  enrichments: Array<{ id: number; platform: string; sourceUrl: string; status: string; error: string | null; createdAt: string }>;
```

In `apps/admin/src/labels.ts` add:

```ts
export const ENRICH_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad"; help: string }> = {
  enriched: { text: "ready", tone: "ok", help: "Has real, source-linked talking points. Can be drafted." },
  pending: { text: "queued", tone: "warn", help: "Waiting for the next research run." },
  no_match: { text: "no match", tone: "warn", help: "Profile found, but nothing relevant to say. A human can add notes by hand." },
  unresolvable: { text: "unreachable", tone: "bad", help: "Every handle we have is dead, private, or empty." },
  no_source: { text: "no source", tone: "bad", help: "No URL or handle on file. Add one and it will be researched." },
  failed: { text: "failed", tone: "bad", help: "The scraper or the model errored. Retried up to 3 times." },
};
```

and a `describeRun` case:

```ts
    case "enrich-personalize":
      return `${n("attempted") ?? 0} researched · ${n("enriched") ?? 0} ready · ${n("no_match") ?? 0} no match · ${n("unresolvable") ?? 0} unreachable · ${n("no_source") ?? 0} no source · ${n("failed") ?? 0} failed`;
```

- [ ] **Step 4: Leads page**

In `apps/admin/src/pages/Leads.tsx`: import `ENRICH_LABEL`. Replace the Notes cell with:

```tsx
                <td>
                  {(() => {
                    const key = l.hasNotes ? "enriched" : (l.enrichmentStatus ?? "pending");
                    const e = ENRICH_LABEL[key] ?? ENRICH_LABEL.pending!;
                    return <span className={`chip ${e.tone === "ok" ? "ok" : e.tone === "bad" ? "failed" : "unresolved"}`} title={e.help}>{e.text}</span>;
                  })()}
                </td>
```

Next to the "Recompute ranks" button add (same `canRun` guard):

```tsx
        {canRun && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setRankMsg("");
              void api
                .runJob("enrich-personalize")
                .then((r) => {
                  setRankMsg(describeRun("enrich-personalize", r.result));
                  return load();
                })
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Working…" : "Research next batch"}
          </button>
        )}
```

Change the notice prefix from `Ranking done:` to `Done:` since it now serves both actions.

In the detail panel, after the Notes card, add:

```tsx
            {detail.enrichments.length > 0 && (
              <div className="card" style={{ gridColumn: "1 / -1" }}>
                <div className="k">Research history</div>
                {detail.enrichments.map((e) => (
                  <div key={e.id} className="muted" style={{ fontSize: 12.5 }}>
                    {new Date(e.createdAt).toLocaleDateString()} · {e.platform} · {ENRICH_LABEL[e.status]?.text ?? e.status}
                    {e.sourceUrl && /^https?:\/\//.test(e.sourceUrl) && (
                      <> · <a href={e.sourceUrl} target="_blank" rel="noreferrer">source</a></>
                    )}
                    {e.error && <> · {e.error}</>}
                  </div>
                ))}
              </div>
            )}
```

- [ ] **Step 5: Typecheck everything, build the admin, run all tests**

Run: `pnpm typecheck && pnpm --filter @biolinx/admin build && pnpm test`
Expected: all clean; tests: core 29, compliance 17, idev 8, instantly 3, drafting 6, scraping 34, jobs 26.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: schedule enrich-personalize, admin research button + status, history in lead detail"
```

---

### Task 12: Live acceptance run

**Files:** none created. Uses the running local MySQL and the real `APIFY_TOKEN` and `ANTHROPIC_API_KEY` from `.env`.

- [ ] **Step 1: Confirm prerequisites**

Run: `node -e "require('fs').readFileSync('.env','utf8').split('\n').filter(l=>/^(APIFY_TOKEN|ANTHROPIC_API_KEY|DATABASE_URL)=/.test(l)).forEach(l=>console.log(l.split('=')[0], l.split('=')[1]?'set':'BLANK'))"`
Expected: all three `set`.

- [ ] **Step 2: Run a capped batch via a one-off script**

Create `apps/worker/src/run-enrich.ts`:

```ts
// One-shot manual run:  pnpm --filter @biolinx/worker exec tsx src/run-enrich.ts [cap]
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runEnrichPersonalize } = await import("@biolinx/jobs");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const cap = Number(process.argv[2] ?? 5);
const summary = await runEnrichPersonalize(conn.db, undefined, { cap });
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
```

Run: `pnpm --filter @biolinx/worker exec tsx src/run-enrich.ts 5`
Expected: a JSON summary with `attempted: 5`, `cleaned: 51` on the first run, `purgedBlockedDrafts: 25` on the first run, and a mix of statuses.

- [ ] **Step 3: Inspect the results by hand**

Run this query (adapt the mysql2 path as done earlier in the session):

```sql
SELECT id, first_name, primary_platform, enrichment_status, enrichment_source_url, LEFT(personalization_notes, 200) notes
FROM leads WHERE enriched_at IS NOT NULL ORDER BY enriched_at DESC LIMIT 5;
SELECT lead_id, platform, status, error FROM lead_enrichments ORDER BY id DESC LIMIT 10;
```

For every `enriched` lead: open the cited URL and confirm the quoted fragment actually appears. If any note cites content not on the page, stop and treat it as a bug in `verifyPoints` or the fetcher's URL mapping.

- [ ] **Step 4: Run dispatch once and confirm the fixes**

From the admin, click "Prepare email drafts" or run DM dispatch via the API (`POST /api/outreach/dispatch` with `{"channel":"dm","cap":5}`). Then check:

```sql
SELECT state, COUNT(*) FROM messages GROUP BY state;            -- no new 'blocked' rows for missing notes
SELECT id, follow_ups_sent, next_follow_up_date FROM leads WHERE last_reached_out IS NOT NULL;  -- dates populated after the next confirmed send
```

- [ ] **Step 5: Commit the run script and note the acceptance in the spec**

Append to the spec under a new `## 11. Acceptance log` heading: date, cap, summary counts, and "hand-checked N notes, 0 fabricated". Then:

```bash
git add apps/worker/src/run-enrich.ts docs/superpowers/specs/2026-09-08-lead-enrichment-design.md
git commit -m "chore: one-shot enrichment runner + acceptance log"
```

---

## Self-review

**Spec coverage.** §3 platforms → Tasks 3–5 (all seven, actor names pinned in Task 2). §4.1 resolve → Task 1. §4.2 fetchers and bundle shape, including `discovered` → Tasks 3–5. §4.3 summarize with URL verification and code-built note → Task 6. §4.4 Apify client → Task 2. §5 data model → Task 7 (leads columns, `lead_enrichments`, `needs_enrichment` removed, `lead_handles` population in Task 10). §6 job steps 1–8 → Task 10, including cleanup, cap, retry limit, 90-day retention, Telegram on run failure. §7 dispatch fixes → Tasks 8–9, blocked-row purge in Task 10's cleanup. §8 admin → Task 11. §9 is explicitly out of scope. §10 testing → each task's tests plus Task 12 acceptance.

**Config overrides for actors** (spec §3 "overridable in the `config` table under `scraping_actors`"): `enrichDepsFromEnv` accepts overrides but nothing reads the config table yet. Added to Task 10's orchestrator: before building deps, the implementer should read `config` key `scraping_actors` and pass its value. Concretely, in `runEnrichPersonalize` when `deps` is not supplied, do:

```ts
const row = await db.query.config.findFirst({ where: eq(schema.config.key, "scraping_actors") });
deps = enrichDepsFromEnv(process.env, (row?.value as Record<string, string> | undefined) ?? {});
```

by changing the signature to `deps?: EnrichDeps` and resolving inside the try block. This is a small change; treat it as part of Task 10 Step 4.

**Placeholder scan.** No TBD/TODO. Every step has code or an exact command.

**Type consistency.** `SourceCandidate`, `SourceBundle`, `Fetcher`, `FetchDeps` defined in Task 1 and used unchanged through Task 10. `enrichOne` returns `EnrichOutcome` with `status: EnrichStatus`; `EnrichSummary` keys match the five statuses plus counters, and `summary[out.status]++` relies on that. `touchUpdate` return shape matches the Drizzle `leads` columns. `describeRun` in Task 11 uses the same summary keys as `EnrichSummary`.
