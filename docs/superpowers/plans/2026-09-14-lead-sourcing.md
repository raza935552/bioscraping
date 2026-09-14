# Lead Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the marketing team define target audiences in the admin, have the worker discover matching creators on TikTok, Instagram, YouTube, Reddit, and Skool through Apify, score them against Jakob's criteria, land them in a review view, and mirror every lead email to Customer.io.

**Architecture:** `packages/scraping` gains a `discovery/` layer (one Apify-backed discoverer per platform, all returning `DiscoveryHit`), plus pure `filter`, `dedupe`, and `score` modules. A new `lead-ingest` job in `packages/jobs` orchestrates: load audiences and competitors → discover → filter → dedupe against the known-people set → verify by profile read (existing fetchers) → score → insert as `sourcing_review = pending`. A new `packages/customerio` client and `customerio-sync` job mirror emails. The API gains audience, competitor, and review routes; the admin gains an Audiences page and a Sourced view on Leads.

**Tech Stack:** Node 22, TypeScript strict (NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), vitest, Drizzle on mysql2, Fastify, React/Vite, Apify REST v2 via the existing `runActorSync`, Customer.io Track API v1.

**Spec:** `docs/superpowers/specs/2026-09-14-lead-sourcing-design.md`

## Global Constraints

- Every package is `"type": "module"`, `main: ./src/index.ts`, no build step; relative imports end in `.js`.
- Strict TS: index results are `T | undefined`; optional props are omitted, never set to `undefined`.
- All HTTP goes through an injectable `fetchImpl: typeof fetch`; tests never touch the network.
- Secrets only from `process.env` (hydrated from Settings): `APIFY_TOKEN`, `CUSTOMERIO_SITE_ID`, `CUSTOMERIO_TRACK_API_KEY`, `CUSTOMERIO_REGION`. Never logged, never in error text.
- Only http(s) URLs are written to `whereFound`, `reachSourceUrl`, `sourcing_sample[].url`, `lead_handles.profile_url`.
- Reach is a platform read or null. Never estimated. Reddit stays null.
- `does_live`, `promo_track_record`, `content_original` are `true` or `null` from code; only a human sets `false`.
- A lead with `sourcing_review` = `pending` or `rejected` is invisible to enrichment and dispatch.
- SP5 never contacted; sourcing never writes `subProfile`.
- Per-profile spend cap (`spend_cap_usd`, default 2.00) and daily cap (`daily_cap`, default 50) are enforced in code.
- Tests: vitest under `test/`, imports from `../src/…js`; run with `pnpm --filter @biolinx/<pkg> test`.
- Conventional commits with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC
  ```
- Work on branch `feat/lead-sourcing` from `main`.
- `drizzle-kit push` hangs on interactive prompts here. Schema changes are applied with the SQL runner from Task 2.

---

## File structure

**Modify — `packages/core`**

| File | Change |
|---|---|
| `src/enums.ts` | `NICHE_PRIORITY` becomes Jakob's five tiers; alias table maps the old six; `NICHE_TIER`, `BRAND_FIT_FOR_NICHE` |
| `test/rank.test.ts` | tiebreak test uses the new order |
| `src/settings-registry.ts` | Customer.io section |

**Modify — `packages/db`**

| File | Change |
|---|---|
| `src/schema.ts` | `sourcingProfiles`, `competitors` tables; new lead columns |
| `scripts/apply-sql.ts` (create) | runs a `.sql` file statement by statement over mysql2 |
| `sql/2026-09-14-sourcing.sql` (create) | the DDL |
| `package.json` | `apply-sql` script |

**Create — `packages/scraping/src/discovery/`**

| File | Responsibility |
|---|---|
| `types.ts` | `DiscoveryHit`, `Discoverer`, `DiscoveryDeps`, `DISCOVERY_ACTORS`, `ACTOR_UNIT_PRICE` |
| `tiktok.ts`, `instagram.ts`, `youtube.ts`, `reddit.ts`, `skool.ts` | one discoverer each |
| `index.ts` | `discovererFor(platform)` |
| `../filter.ts` | `applyFilters(hits, profile)` → kept + reject counts |
| `../dedupe.ts` | `KnownPeople` set + `isKnown(hit)` |
| `../score.ts` | `scoreHit(...)` → `{score, reasons, competitor}` + promo/code regexes |

**Create — `packages/customerio`** (`@biolinx/customerio`): `src/index.ts` client, `test/client.test.ts`.

**Create — `packages/jobs/src/lead-ingest.ts`, `customerio-sync.ts`**; modify `enrich-personalize.ts`, `outreach-dispatch.ts`, `index.ts`.

**Modify — `apps/api/src/index.ts`**: audiences, competitors, sourced view, accept/reject, job triggers. **Modify — `apps/worker/src/index.ts`**, add `run-ingest.ts`.

**Modify — `apps/admin`**: `api.ts`, `App.tsx`, `labels.ts`, `pages/Leads.tsx`; create `pages/Audiences.tsx`.

---

### Task 1: Niche tiers replace the niche list

**Files:**
- Modify: `packages/core/src/enums.ts:10-32`
- Modify: `packages/core/test/rank.test.ts:46-95`
- Test: `packages/core/test/enums.test.ts` (create)

**Interfaces:**
- Produces: `NICHE_PRIORITY: readonly ["Weight-loss seeker","Biohacker","Gym / PED-curious","Anti-aging","Sexual wellness"]`, `type Niche`, `normalizeNiche(value): Niche | null` (unchanged signature), `NICHE_TIER: Record<Niche, 1|2|3|4>`, `type BrandFit = "biolinx"|"aro"|"both"`, `brandFitForNiche(niche: Niche): BrandFit`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/enums.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NICHE_PRIORITY, NICHE_TIER, brandFitForNiche, normalizeNiche } from "../src/enums.js";

describe("niche tiers", () => {
  it("priority order is Jakob's five tiers", () => {
    expect([...NICHE_PRIORITY]).toEqual(["Weight-loss seeker", "Biohacker", "Gym / PED-curious", "Anti-aging", "Sexual wellness"]);
    expect(NICHE_TIER["Weight-loss seeker"]).toBe(1);
    expect(NICHE_TIER["Biohacker"]).toBe(1);
    expect(NICHE_TIER["Gym / PED-curious"]).toBe(2);
    expect(NICHE_TIER["Anti-aging"]).toBe(3);
    expect(NICHE_TIER["Sexual wellness"]).toBe(4);
  });
  it("every old label maps onto a tier", () => {
    expect(normalizeNiche("Longevity")).toBe("Anti-aging");
    expect(normalizeNiche("Biohacking")).toBe("Biohacker");
    expect(normalizeNiche("Nootropics")).toBe("Biohacker");
    expect(normalizeNiche("Nootropics/Cognitive")).toBe("Biohacker");
    expect(normalizeNiche("Gym")).toBe("Gym / PED-curious");
    expect(normalizeNiche("Gym/Bodybuilding")).toBe("Gym / PED-curious");
    expect(normalizeNiche("MMA")).toBe("Gym / PED-curious");
    expect(normalizeNiche("MMA/Combat")).toBe("Gym / PED-curious");
    expect(normalizeNiche("Women's Wellness")).toBe("Anti-aging");
    expect(normalizeNiche("weight-loss seeker")).toBe("Weight-loss seeker");
    expect(normalizeNiche("nonsense")).toBeNull();
  });
  it("brand fit: weight-loss is both, everything else biolinx", () => {
    expect(brandFitForNiche("Weight-loss seeker")).toBe("both");
    expect(brandFitForNiche("Biohacker")).toBe("biolinx");
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @biolinx/core test -- enums`
Expected: FAIL, `NICHE_TIER` is not exported.

- [ ] **Step 3: Replace lines 10-32 of `packages/core/src/enums.ts`**

```ts
/** Niche priority order IS the ranking tiebreaker — index = priority.
 *  Jakob's 5K-scrape canvas (2026-09-14) ranks conversion probability by
 *  tier; the old Airtable labels stay valid through normalizeNiche. */
export const NICHE_PRIORITY = [
  "Weight-loss seeker",
  "Biohacker",
  "Gym / PED-curious",
  "Anti-aging",
  "Sexual wellness",
] as const;
export type Niche = (typeof NICHE_PRIORITY)[number];

export const NICHE_TIER: Record<Niche, 1 | 2 | 3 | 4> = {
  "Weight-loss seeker": 1,
  Biohacker: 1,
  "Gym / PED-curious": 2,
  "Anti-aging": 3,
  "Sexual wellness": 4,
};

export type BrandFit = "biolinx" | "aro" | "both";
export function brandFitForNiche(niche: Niche): BrandFit {
  return niche === "Weight-loss seeker" ? "both" : "biolinx";
}

const NICHE_ALIASES: Record<string, Niche> = {
  longevity: "Anti-aging",
  "women's wellness": "Anti-aging",
  biohacking: "Biohacker",
  nootropics: "Biohacker",
  "nootropics/cognitive": "Biohacker",
  gym: "Gym / PED-curious",
  "gym/bodybuilding": "Gym / PED-curious",
  mma: "Gym / PED-curious",
  "mma/combat": "Gym / PED-curious",
};

export function normalizeNiche(value: string | null | undefined): Niche | null {
  if (!value) return null;
  const v = value.trim();
  const direct = NICHE_PRIORITY.find((n) => n.toLowerCase() === v.toLowerCase());
  if (direct) return direct;
  return NICHE_ALIASES[v.toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Update `packages/core/test/rank.test.ts`**

In the test at line 79 (`tiebreak 2: niche priority Longevity > … > MMA`), rename it `tiebreak 2: niche tier order; blank niche last` and change the three leads to `niche: "Sexual wellness"` (expected last among named), `niche: "Weight-loss seeker"` (expected first), keeping the blank-niche lead last. Keep the alias test at line 46 as is; it still normalizes.

- [ ] **Step 5: Run core tests**

Run: `pnpm --filter @biolinx/core test`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/lead-sourcing
git add packages/core
git commit -m "feat(core): niche tiers from Jakob's canvas replace the niche list; old labels alias" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 2: Schema — `sourcing_profiles`, `competitors`, lead columns, SQL runner

**Files:**
- Modify: `packages/db/src/schema.ts` (leads table, add after `enrichmentAttempts`; new tables after `leadEnrichments`)
- Create: `packages/db/scripts/apply-sql.ts`, `packages/db/sql/2026-09-14-sourcing.sql`
- Modify: `packages/db/package.json` scripts

**Interfaces:**
- Produces: `schema.sourcingProfiles`, `schema.competitors`, and on `schema.leads`: `brandFit, sourcingReview, sourcingProfileId, sourcingReason, sourcingSample, sourcingScore, sourcingRejectedReason, affiliateCode, lastPostAt, doesLive, promoTrackRecord, contentOriginal, customerioSyncedAt`.

- [ ] **Step 1: Add lead columns in `schema.ts`, directly after `enrichmentAttempts`**

```ts
  // Sourcing (spec 2026-09-14 §3.3) — null on leads that were not sourced.
  brandFit: varchar("brand_fit", { length: 8 }), // biolinx | aro | both
  sourcingReview: varchar("sourcing_review", { length: 12 }), // pending | accepted | rejected
  sourcingProfileId: int("sourcing_profile_id"),
  sourcingReason: varchar("sourcing_reason", { length: 255 }),
  sourcingSample: json("sourcing_sample"), // [{url,text,postedAt}] max 3, reviewer only
  sourcingScore: int("sourcing_score"),
  sourcingRejectedReason: varchar("sourcing_rejected_reason", { length: 120 }),
  affiliateCode: varchar("affiliate_code", { length: 64 }), // strongest dedupe key
  lastPostAt: datetime("last_post_at"),
  doesLive: boolean("does_live"), // null = not observed; never inferred false
  promoTrackRecord: boolean("promo_track_record"),
  contentOriginal: boolean("content_original"),
  customerioSyncedAt: datetime("customerio_synced_at"),
```

- [ ] **Step 2: Add the two tables after `leadEnrichments`**

```ts
/** An audience the marketing team defines; the lead-ingest job turns it
 *  into Apify searches. Every save is audit-logged. */
export const sourcingProfiles = mysqlTable("sourcing_profiles", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  active: boolean("active").default(true).notNull(),
  niche: varchar("niche", { length: 40 }).notNull(),
  brandFit: varchar("brand_fit", { length: 8 }).notNull(),
  platforms: json("platforms").notNull(), // ordered: ["tiktok","youtube",...]
  terms: json("terms").notNull(), // { tiktok: string[], ... }
  seedAccounts: json("seed_accounts"), // phase 2, stored now
  followerMin: json("follower_min"), // { tiktok: 5000, ... } null = none
  followerMax: json("follower_max"),
  activityDays: int("activity_days").default(30).notNull(),
  countries: json("countries"), // ["US","CA","GB","AU"]
  language: varchar("language", { length: 8 }).default("en").notNull(),
  matchTerms: json("match_terms"),
  excludeTerms: json("exclude_terms"),
  excludeHandles: json("exclude_handles"),
  dailyCap: int("daily_cap").default(50).notNull(),
  spendCapUsd: decimal("spend_cap_usd", { precision: 6, scale: 2 }).default("2.00").notNull(),
  lastRunAt: datetime("last_run_at"),
  lastRunSummary: json("last_run_summary"),
  createdByUserId: int("created_by_user_id"),
  updatedByUserId: int("updated_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Matt's competitor list: their affiliates are the tier-one target. */
export const competitors = mysqlTable("competitors", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  domains: json("domains"), // ["peptidesciences.com"]
  codePattern: varchar("code_pattern", { length: 120 }), // regex source, or null
  codePrefix: varchar("code_prefix", { length: 24 }), // "PS" → matches PS20, PSJANE
  commissionPct: int("commission_pct"),
  recurring: boolean("recurring"),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
```

- [ ] **Step 3: Write the DDL `packages/db/sql/2026-09-14-sourcing.sql`**

```sql
ALTER TABLE leads
  ADD COLUMN brand_fit VARCHAR(8) NULL,
  ADD COLUMN sourcing_review VARCHAR(12) NULL,
  ADD COLUMN sourcing_profile_id INT NULL,
  ADD COLUMN sourcing_reason VARCHAR(255) NULL,
  ADD COLUMN sourcing_sample JSON NULL,
  ADD COLUMN sourcing_score INT NULL,
  ADD COLUMN sourcing_rejected_reason VARCHAR(120) NULL,
  ADD COLUMN affiliate_code VARCHAR(64) NULL,
  ADD COLUMN last_post_at DATETIME NULL,
  ADD COLUMN does_live TINYINT(1) NULL,
  ADD COLUMN promo_track_record TINYINT(1) NULL,
  ADD COLUMN content_original TINYINT(1) NULL,
  ADD COLUMN customerio_synced_at DATETIME NULL,
  ADD INDEX leads_sourcing_review (sourcing_review),
  ADD INDEX leads_affiliate_code (affiliate_code);

CREATE TABLE IF NOT EXISTS sourcing_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  niche VARCHAR(40) NOT NULL,
  brand_fit VARCHAR(8) NOT NULL,
  platforms JSON NOT NULL,
  terms JSON NOT NULL,
  seed_accounts JSON NULL,
  follower_min JSON NULL,
  follower_max JSON NULL,
  activity_days INT NOT NULL DEFAULT 30,
  countries JSON NULL,
  language VARCHAR(8) NOT NULL DEFAULT 'en',
  match_terms JSON NULL,
  exclude_terms JSON NULL,
  exclude_handles JSON NULL,
  daily_cap INT NOT NULL DEFAULT 50,
  spend_cap_usd DECIMAL(6,2) NOT NULL DEFAULT 2.00,
  last_run_at DATETIME NULL,
  last_run_summary JSON NULL,
  created_by_user_id INT NULL,
  updated_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS competitors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  domains JSON NULL,
  code_pattern VARCHAR(120) NULL,
  code_prefix VARCHAR(24) NULL,
  commission_pct INT NULL,
  recurring TINYINT(1) NULL,
  notes TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

- [ ] **Step 4: Write the runner `packages/db/scripts/apply-sql.ts`**

```ts
// Apply a .sql file statement by statement. drizzle-kit push hangs on its
// interactive rename prompt in this repo, so schema changes ship as SQL.
//   pnpm --filter @biolinx/db apply-sql sql/2026-09-14-sourcing.sql
import { readFileSync } from "node:fs";
import { loadEnv } from "@biolinx/core";
import mysql from "mysql2/promise";

loadEnv();
const file = process.argv[2];
if (!file) throw new Error("usage: apply-sql <file.sql>");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const statements = readFileSync(file, "utf8")
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
for (const sql of statements) {
  try {
    await conn.query(sql);
    console.log(`ok: ${sql.slice(0, 60).replace(/\s+/g, " ")}…`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Re-runs are fine: a column that already exists is not an error here.
    if (code === "ER_DUP_FIELDNAME" || code === "ER_DUP_KEYNAME") {
      console.log(`skip (exists): ${sql.slice(0, 60).replace(/\s+/g, " ")}…`);
      continue;
    }
    await conn.end();
    throw err;
  }
}
await conn.end();
```

Add to `packages/db/package.json` scripts: `"apply-sql": "tsx scripts/apply-sql.ts"` and to devDependencies `"tsx": "^4.19.2"`.

- [ ] **Step 5: Apply and typecheck**

Run: `pnpm install && pnpm --filter @biolinx/db apply-sql sql/2026-09-14-sourcing.sql && pnpm --filter @biolinx/db typecheck`
Expected: every statement prints `ok:`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): sourcing_profiles, competitors, sourcing columns on leads; sql runner" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 3: Discovery types, cost table, and the TikTok discoverer

**Files:**
- Create: `packages/scraping/src/discovery/types.ts`, `packages/scraping/src/discovery/tiktok.ts`
- Test: `packages/scraping/test/discovery-tiktok.test.ts`

**Interfaces:**
- Produces:
```ts
export type DiscoveryPlatform = "tiktok" | "instagram" | "youtube" | "reddit" | "skool";
export interface DiscoveryHit {
  platform: DiscoveryPlatform;
  handle: string;            // normalized, no @
  profileUrl: string;        // http(s)
  displayName: string | null;
  bio: string | null;
  followers: number | null;  // from the search row; re-read at verification
  postUrl: string | null;    // the post that surfaced them (whereFound)
  postText: string | null;
  postedAt: string | null;   // ISO
  country: string | null;    // ISO-2 when the platform says so
  isRepost: boolean | null;
  term: string;              // which term found them
}
export interface DiscoveryDeps { fetchImpl: typeof fetch; apify: { token: string; actors: Record<string, string> }; perTerm: number; }
export type Discoverer = (term: string, deps: DiscoveryDeps, opts: DiscoveryOpts) => Promise<DiscoveryHit[]>;
export interface DiscoveryOpts { followerMin?: number; followerMax?: number; country?: string; language?: string; }
export const DISCOVERY_ACTORS: Record<DiscoveryPlatform, string>;
export const ACTOR_UNIT_PRICE: Record<DiscoveryPlatform, number>; // USD per item
export function estimateCost(platform: DiscoveryPlatform, items: number): number;
```

- [ ] **Step 1: Write `types.ts`**

```ts
// Discovery turns a search term into creator candidates. Every platform
// returns the same DiscoveryHit so filter/dedupe/score never care where a
// candidate came from. Prices are bronze-tier list prices (2026-09-14) and
// exist only so the spend cap can stop a run; they are not billing.

export type DiscoveryPlatform = "tiktok" | "instagram" | "youtube" | "reddit" | "skool";

export interface DiscoveryHit {
  platform: DiscoveryPlatform;
  handle: string;
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  followers: number | null;
  postUrl: string | null;
  postText: string | null;
  postedAt: string | null;
  country: string | null;
  isRepost: boolean | null;
  term: string;
}

export interface DiscoveryDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  /** Hits requested per term. */
  perTerm: number;
}

export interface DiscoveryOpts {
  followerMin?: number;
  followerMax?: number;
  country?: string;
  language?: string;
}

export type Discoverer = (term: string, deps: DiscoveryDeps, opts: DiscoveryOpts) => Promise<DiscoveryHit[]>;

/** Overridable via config key `sourcing_actors`. */
export const DISCOVERY_ACTORS: Record<DiscoveryPlatform, string> = {
  tiktok: "clockworks/tiktok-hashtag-scraper",
  instagram: "apify/instagram-hashtag-scraper",
  youtube: "maximedupre/youtube-channel-search-scraper",
  reddit: "clearpath/reddit-subreddit-posts-scraper",
  skool: "crustapi/skool-community-scraper",
};

export const ACTOR_UNIT_PRICE: Record<DiscoveryPlatform, number> = {
  tiktok: 0.002,
  instagram: 0.0023,
  youtube: 0.00035,
  reddit: 0.002,
  skool: 0.0035,
};

/** Price of a profile verification read per platform (existing fetchers). */
export const VERIFY_UNIT_PRICE = 0.005;

export function estimateCost(platform: DiscoveryPlatform, items: number): number {
  return Math.round(ACTOR_UNIT_PRICE[platform] * items * 10000) / 10000;
}

export function isHttpUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}
```

- [ ] **Step 2: Write the failing test `test/discovery-tiktok.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { discoverTikTok } from "../src/discovery/tiktok.js";
import type { DiscoveryDeps } from "../src/discovery/types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deps(rows: unknown, capture?: (b: unknown) => void): DiscoveryDeps {
  const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(rows);
  });
  return { fetchImpl: fetchImpl as typeof fetch, apify: { token: "t", actors: {} }, perTerm: 30 };
}

describe("discoverTikTok", () => {
  it("sends the hashtag without '#', one hit per distinct author, latest post wins", async () => {
    let sent: unknown;
    const hits = await discoverTikTok(
      "#perimenopause",
      deps(
        [
          { text: "older", webVideoUrl: "https://www.tiktok.com/@ann/video/1", createTimeISO: "2026-08-01T00:00:00.000Z", authorMeta: { name: "ann", nickName: "Ann", signature: "NP · hormones", fans: 42000, profileUrl: "https://www.tiktok.com/@ann" }, locationMeta: { countryCode: "US" } },
          { text: "newer", webVideoUrl: "https://www.tiktok.com/@ann/video/2", createTimeISO: "2026-09-01T00:00:00.000Z", authorMeta: { name: "ann", fans: 42000, profileUrl: "https://www.tiktok.com/@ann" } },
          { text: "x", webVideoUrl: "https://www.tiktok.com/@bob/video/9", createTimeISO: "2026-09-02T00:00:00.000Z", authorMeta: { name: "bob", fans: 10 } },
          { error: "not_found", errorCode: "not_found" },
        ],
        (b) => (sent = b),
      ),
      {},
    );
    expect(sent).toEqual({ hashtags: ["perimenopause"], resultsPerPage: 30 });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      platform: "tiktok",
      handle: "ann",
      profileUrl: "https://www.tiktok.com/@ann",
      displayName: "Ann",
      bio: "NP · hormones",
      followers: 42000,
      postUrl: "https://www.tiktok.com/@ann/video/2",
      postText: "newer",
      postedAt: "2026-09-01T00:00:00.000Z",
      country: "US",
      isRepost: null,
      term: "#perimenopause",
    });
    expect(hits[1]?.profileUrl).toBe("https://www.tiktok.com/@bob");
  });

  it("returns [] on an empty dataset and throws on actor error", async () => {
    expect(await discoverTikTok("#x", deps([]), {})).toEqual([]);
    const bad: DiscoveryDeps = { ...deps([]), fetchImpl: (async () => json({ error: { message: "boom" } }, 500)) as typeof fetch };
    await expect(discoverTikTok("#x", bad, {})).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @biolinx/scraping test -- discovery-tiktok`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `discovery/tiktok.ts`**

```ts
// clockworks/tiktok-hashtag-scraper: one row per video, creator on authorMeta.
// We keep one hit per creator (the newest video) so the cap counts people.

import { runActorSync } from "../apify.js";
import { clip, toIso, toNumber } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  error?: string;
  authorMeta?: { name?: string; nickName?: string; signature?: string; fans?: number; profileUrl?: string };
  locationMeta?: { countryCode?: string };
}

export function tagOf(term: string): string {
  return term.trim().replace(/^#/, "").toLowerCase();
}

export const discoverTikTok: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.tiktok ?? DISCOVERY_ACTORS.tiktok,
    { hashtags: [tagOf(term)], resultsPerPage: deps.perTerm },
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const name = r.authorMeta?.name?.trim().toLowerCase();
    if (r.error || !name) continue;
    const postedAt = toIso(r.createTimeISO);
    const hit: DiscoveryHit = {
      platform: "tiktok",
      handle: name,
      profileUrl: isHttpUrl(r.authorMeta?.profileUrl) ? r.authorMeta!.profileUrl! : `https://www.tiktok.com/@${name}`,
      displayName: r.authorMeta?.nickName ?? null,
      bio: r.authorMeta?.signature ? clip(r.authorMeta.signature, 300) : null,
      followers: toNumber(r.authorMeta?.fans),
      postUrl: isHttpUrl(r.webVideoUrl) ? r.webVideoUrl : null,
      postText: r.text ? clip(r.text, 300) : null,
      postedAt,
      country: r.locationMeta?.countryCode ?? null,
      isRepost: null,
      term,
    };
    const prev = byHandle.get(name);
    if (!prev) byHandle.set(name, hit);
    else {
      // Keep the newest post as the sample; keep any bio/name we learned.
      const newer = (postedAt ?? "") > (prev.postedAt ?? "");
      byHandle.set(name, {
        ...(newer ? hit : prev),
        displayName: prev.displayName ?? hit.displayName,
        bio: prev.bio ?? hit.bio,
      });
    }
  }
  return [...byHandle.values()];
};
```

- [ ] **Step 5: Run it**

Run: `pnpm --filter @biolinx/scraping test -- discovery-tiktok`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/scraping
git commit -m "feat(scraping): discovery types, cost table, TikTok hashtag discoverer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 4: Instagram, YouTube, Reddit, and Skool discoverers + registry

**Files:**
- Create: `packages/scraping/src/discovery/instagram.ts`, `youtube.ts`, `reddit.ts`, `skool.ts`, `index.ts`
- Modify: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/discovery-platforms.test.ts`

**Interfaces:**
- Consumes: `DiscoveryHit`, `Discoverer`, `DISCOVERY_ACTORS`, `isHttpUrl` from Task 3; `runActorSync`, `clip`, `toIso`, `toNumber`.
- Produces: `discoverInstagram`, `discoverYouTube`, `discoverReddit`, `discoverSkool`, `discovererFor(platform: DiscoveryPlatform): Discoverer`.

- [ ] **Step 1: Write the failing test `test/discovery-platforms.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { discoverInstagram } from "../src/discovery/instagram.js";
import { discoverYouTube } from "../src/discovery/youtube.js";
import { discoverReddit } from "../src/discovery/reddit.js";
import { discoverSkool } from "../src/discovery/skool.js";
import { discovererFor } from "../src/discovery/index.js";
import type { DiscoveryDeps } from "../src/discovery/types.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function deps(rows: unknown, capture?: (b: unknown) => void): DiscoveryDeps {
  const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
    capture?.(JSON.parse(String(init?.body)));
    return json(rows);
  });
  return { fetchImpl: fetchImpl as typeof fetch, apify: { token: "t", actors: {} }, perTerm: 30 };
}

describe("discoverInstagram", () => {
  it("hashtag → hashtags[]; plain word → keywordSearch; one hit per owner", async () => {
    let sent: unknown;
    const rows = [
      { ownerUsername: "annie", ownerFullName: "Annie A", caption: "menopause tips", url: "https://www.instagram.com/p/abc/", timestamp: "2026-09-01T00:00:00.000Z" },
      { ownerUsername: "annie", caption: "older", url: "https://www.instagram.com/p/old/", timestamp: "2026-08-01T00:00:00.000Z" },
      { error: "not found" },
    ];
    const hits = await discoverInstagram("#menopause", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ hashtags: ["menopause"], resultsLimit: 30, resultsType: "posts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ platform: "instagram", handle: "annie", profileUrl: "https://www.instagram.com/annie/", displayName: "Annie A", postUrl: "https://www.instagram.com/p/abc/", followers: null, bio: null });
    await discoverInstagram("peptide coach", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ hashtags: ["peptide coach"], resultsLimit: 30, resultsType: "posts", keywordSearch: true });
  });
});

describe("discoverYouTube", () => {
  it("passes subscriber bounds and country, maps channel rows", async () => {
    let sent: unknown;
    const rows = [
      {
        channel: { handle: "@ThomasD", id: "UC1", title: "Thomas", url: "https://www.youtube.com/@ThomasD", description: "Science-based nutrition" },
        metrics: { subscribers: 3600000 },
        profile: { country: "US" },
        sourceVideo: { url: "https://www.youtube.com/watch?v=1", title: "Fasting mistakes", publishedAt: "2026-08-01T00:00:00.000Z" },
      },
    ];
    const hits = await discoverYouTube("peptides for recovery", deps(rows, (b) => (sent = b)), { followerMin: 2000, followerMax: 300000, country: "US", language: "en" });
    expect(sent).toEqual({ discoveryMode: "both", searchTerms: ["peptides for recovery"], maxChannelsPerSearchTerm: 30, maxTotalResults: 30, minSubscribers: 2000, maxSubscribers: 300000, countryHint: "US", languageHint: "en" });
    expect(hits[0]).toMatchObject({ platform: "youtube", handle: "thomasd", profileUrl: "https://www.youtube.com/@ThomasD", followers: 3600000, bio: "Science-based nutrition", postUrl: "https://www.youtube.com/watch?v=1", postText: "Fasting mistakes", country: "US" });
  });
});

describe("discoverReddit", () => {
  it("r/name → subreddits[]; top of month; author becomes the hit; followers null", async () => {
    let sent: unknown;
    const rows = [
      { author: "peptide_pete", title: "My BPC log", selftext: "long", permalink: "/r/Peptides/comments/1/my_bpc_log/", created_utc: 1756684800, subreddit: "Peptides" },
      { author: "[deleted]", title: "x", permalink: "/r/Peptides/comments/2/", created_utc: 1756684800 },
      { author: "AutoModerator", title: "rules", permalink: "/r/Peptides/comments/3/", created_utc: 1756684800 },
    ];
    const hits = await discoverReddit("r/Peptides", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ subreddits: ["Peptides"], maxPostsPerSubreddit: 30, sort: "top", timeFilter: "month", includeComments: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ platform: "reddit", handle: "peptide_pete", profileUrl: "https://www.reddit.com/user/peptide_pete/", followers: null, postUrl: "https://www.reddit.com/r/Peptides/comments/1/my_bpc_log/", postText: "My BPC log — long", postedAt: "2025-09-01T00:00:00.000Z" });
  });
});

describe("discoverSkool", () => {
  it("community owner is the hit; member count is reach; community url is the post", async () => {
    let sent: unknown;
    const rows = [
      { name: "peptide-lab", displayName: "Peptide Lab", communityUrl: "https://www.skool.com/peptide-lab", description: "Learn peptides", totalMembers: 1200, ownerName: "Hack Smith", ownerProfileUrl: "https://www.skool.com/@hack-smith", ownerBio: "coach", ownerLocation: "Austin, US" },
    ];
    const hits = await discoverSkool("peptides", deps(rows, (b) => (sent = b)), {});
    expect(sent).toEqual({ searchTerms: ["peptides"], maxCommunities: 30, includeOwnerDetails: true });
    expect(hits[0]).toMatchObject({ platform: "skool", handle: "hack-smith", profileUrl: "https://www.skool.com/@hack-smith", displayName: "Hack Smith", bio: "coach", followers: 1200, postUrl: "https://www.skool.com/peptide-lab", postText: "Peptide Lab — Learn peptides", country: "US" });
  });
});

describe("discovererFor", () => {
  it("returns one function per platform", () => {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "skool"] as const) expect(typeof discovererFor(p)).toBe("function");
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @biolinx/scraping test -- discovery-platforms`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `discovery/instagram.ts`**

```ts
// apify/instagram-hashtag-scraper: one row per post, owner fields on the
// row. No follower count at this stage; verification reads the profile.

import { runActorSync } from "../apify.js";
import { clip, toIso } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row { ownerUsername?: string; ownerFullName?: string; caption?: string; url?: string; timestamp?: string; error?: string }

export const discoverInstagram: Discoverer = async (term, deps) => {
  const isTag = term.trim().startsWith("#");
  const value = term.trim().replace(/^#/, "").toLowerCase();
  const input: Record<string, unknown> = { hashtags: [value], resultsLimit: deps.perTerm, resultsType: "posts" };
  if (!isTag) input.keywordSearch = true;
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.instagram ?? DISCOVERY_ACTORS.instagram,
    input,
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const handle = r.ownerUsername?.trim().toLowerCase();
    if (r.error || !handle) continue;
    const postedAt = toIso(r.timestamp);
    const hit: DiscoveryHit = {
      platform: "instagram",
      handle,
      profileUrl: `https://www.instagram.com/${handle}/`,
      displayName: r.ownerFullName ?? null,
      bio: null,
      followers: null,
      postUrl: isHttpUrl(r.url) ? r.url : null,
      postText: r.caption ? clip(r.caption, 300) : null,
      postedAt,
      country: null,
      isRepost: null,
      term,
    };
    const prev = byHandle.get(handle);
    if (!prev || (postedAt ?? "") > (prev.postedAt ?? "")) {
      byHandle.set(handle, { ...hit, displayName: hit.displayName ?? prev?.displayName ?? null });
    }
  }
  return [...byHandle.values()];
};
```

- [ ] **Step 4: Write `discovery/youtube.ts`**

```ts
// maximedupre/youtube-channel-search-scraper: one row per channel, already
// filtered by subscriber bounds server-side. sourceVideo is the post that
// surfaced the channel (null in channel-only mode).

import { runActorSync } from "../apify.js";
import { clip, toIso, toNumber } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  channel?: { handle?: string; id?: string; title?: string; url?: string; description?: string | null };
  metrics?: { subscribers?: number };
  profile?: { country?: string | null };
  sourceVideo?: { url?: string; title?: string; publishedAt?: string } | null;
}

export const discoverYouTube: Discoverer = async (term, deps, opts) => {
  const input: Record<string, unknown> = {
    discoveryMode: "both",
    searchTerms: [term.trim()],
    maxChannelsPerSearchTerm: deps.perTerm,
    maxTotalResults: deps.perTerm,
  };
  if (opts.followerMin != null) input.minSubscribers = opts.followerMin;
  if (opts.followerMax != null) input.maxSubscribers = opts.followerMax;
  if (opts.country) input.countryHint = opts.country;
  if (opts.language) input.languageHint = opts.language;
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.youtube ?? DISCOVERY_ACTORS.youtube,
    input,
  );
  const hits: DiscoveryHit[] = [];
  for (const r of rows) {
    const rawHandle = r.channel?.handle?.replace(/^@/, "") ?? r.channel?.id;
    if (!rawHandle) continue;
    const channelUrl = r.channel?.url;
    hits.push({
      platform: "youtube",
      handle: rawHandle.toLowerCase(),
      profileUrl: isHttpUrl(channelUrl) ? channelUrl : `https://www.youtube.com/@${rawHandle}`,
      displayName: r.channel?.title ?? null,
      bio: r.channel?.description ? clip(r.channel.description, 300) : null,
      followers: toNumber(r.metrics?.subscribers),
      postUrl: isHttpUrl(r.sourceVideo?.url) ? r.sourceVideo.url : null,
      postText: r.sourceVideo?.title ? clip(r.sourceVideo.title, 300) : null,
      postedAt: toIso(r.sourceVideo?.publishedAt),
      country: r.profile?.country ?? null,
      isRepost: null,
      term,
    });
  }
  return hits;
};
```

- [ ] **Step 5: Write `discovery/reddit.ts`**

```ts
// clearpath/reddit-subreddit-posts-scraper: raw Reddit post objects. The
// author is the candidate. Reddit has no follower count → followers null.

import { runActorSync } from "../apify.js";
import { clip, toIso } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row { author?: string; title?: string; selftext?: string; permalink?: string; created_utc?: number }

const SKIP_AUTHORS = new Set(["[deleted]", "automoderator"]);

export function subredditOf(term: string): string {
  return term.trim().replace(/^\/?r\//i, "");
}

export const discoverReddit: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.reddit ?? DISCOVERY_ACTORS.reddit,
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
```

- [ ] **Step 6: Write `discovery/skool.ts`**

```ts
// crustapi/skool-community-scraper: one row per community with owner
// details. The owner is the candidate, member count is their reach.

import { runActorSync } from "../apify.js";
import { clip } from "../fetchers/shared.js";
import { DISCOVERY_ACTORS, isHttpUrl, type Discoverer, type DiscoveryHit } from "./types.js";

interface Row {
  name?: string;
  displayName?: string;
  communityUrl?: string;
  description?: string;
  totalMembers?: number;
  ownerName?: string;
  ownerProfileUrl?: string;
  ownerBio?: string;
  ownerLocation?: string | null;
}

export const discoverSkool: Discoverer = async (term, deps) => {
  const rows = await runActorSync<Row>(
    { token: deps.apify.token, fetchImpl: deps.fetchImpl },
    deps.apify.actors.skool ?? DISCOVERY_ACTORS.skool,
    { searchTerms: [term.trim()], maxCommunities: deps.perTerm, includeOwnerDetails: true },
  );
  const byHandle = new Map<string, DiscoveryHit>();
  for (const r of rows) {
    const ownerUrl = isHttpUrl(r.ownerProfileUrl) ? r.ownerProfileUrl : null;
    const handle = ownerUrl?.match(/skool\.com\/@([^/?#]+)/)?.[1]?.toLowerCase();
    if (!handle || !ownerUrl) continue;
    const country = r.ownerLocation?.split(",").pop()?.trim() ?? null;
    const title = [r.displayName ?? r.name, r.description].filter((s) => s && s.trim()).join(" — ");
    const hit: DiscoveryHit = {
      platform: "skool",
      handle,
      profileUrl: ownerUrl,
      displayName: r.ownerName ?? null,
      bio: r.ownerBio ? clip(r.ownerBio, 300) : null,
      followers: typeof r.totalMembers === "number" ? r.totalMembers : null,
      postUrl: isHttpUrl(r.communityUrl) ? r.communityUrl : null,
      postText: title ? clip(title, 300) : null,
      postedAt: null,
      country: country && country.length === 2 ? country.toUpperCase() : null,
      isRepost: null,
      term,
    };
    const prev = byHandle.get(handle);
    if (!prev || (hit.followers ?? 0) > (prev.followers ?? 0)) byHandle.set(handle, hit);
  }
  return [...byHandle.values()];
};
```

- [ ] **Step 7: Write `discovery/index.ts` and export from the package**

```ts
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
```

Append to `packages/scraping/src/index.ts`:
```ts
export * from "./discovery/index.js";
```

- [ ] **Step 8: Run all scraping tests and typecheck**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add packages/scraping
git commit -m "feat(scraping): Instagram, YouTube, Reddit, Skool discoverers + registry" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 5: Filters, scoring, and the known-people dedupe (pure functions)

**Files:**
- Create: `packages/scraping/src/filter.ts`, `packages/scraping/src/score.ts`, `packages/scraping/src/dedupe.ts`
- Modify: `packages/scraping/src/index.ts`
- Test: `packages/scraping/test/filter-score-dedupe.test.ts`

**Interfaces:**
- Consumes: `DiscoveryHit`, `DiscoveryPlatform` (Task 3); `handleKey` from `@biolinx/core`.
- Produces:
```ts
// filter.ts
export interface AudienceRules { followerMin: Partial<Record<DiscoveryPlatform, number>>; followerMax: Partial<Record<DiscoveryPlatform, number>>; countries: string[]; language: string; excludeTerms: string[]; excludeHandles: string[]; }
export type RejectReason = "excluded_handle" | "excluded_term" | "followers_low" | "followers_high" | "country";
export function applyFilters(hits: DiscoveryHit[], rules: AudienceRules): { kept: DiscoveryHit[]; rejected: Record<RejectReason, number> };
export const DEFAULT_EXCLUDE_TERMS: string[]; // GLP-1 names from the linter
// score.ts
export interface CompetitorRule { id: number; name: string; domains: string[]; codePattern: string | null; codePrefix: string | null; commissionPct: number | null; }
export interface ScoreInput { hit: DiscoveryHit; verified: { followers: number | null; bio: string | null; lastPostAt: string | null; items: Array<{ text: string; url: string }>; isRepostRatio: number | null } | null; rules: { followerMin?: number; followerMax?: number; activityDays: number; matchTerms: string[]; excludeTerms: string[] }; competitors: CompetitorRule[]; now: Date; }
export interface ScoreResult { score: number; reasons: string[]; competitor: CompetitorRule | null; affiliateCode: string | null; promoTrackRecord: true | null; contentOriginal: true | null; glp1Only: boolean; }
export function scoreHit(input: ScoreInput): ScoreResult;
export function findAffiliateCode(text: string, competitors: CompetitorRule[]): { code: string; competitor: CompetitorRule } | null;
export const PROMO_PATTERN: RegExp;
// dedupe.ts
export interface KnownPeople { codes: Set<string>; handles: Set<string>; emails: Set<string>; urls: Set<string>; names: Set<string>; }
export function emptyKnown(): KnownPeople;
export function nameKey(name: string | null | undefined, platform: string): string | null;
export function urlKey(url: string): string;
export function isKnown(hit: DiscoveryHit, code: string | null, known: KnownPeople): boolean;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { applyFilters, DEFAULT_EXCLUDE_TERMS } from "../src/filter.js";
import { findAffiliateCode, PROMO_PATTERN, scoreHit, type CompetitorRule } from "../src/score.js";
import { emptyKnown, isKnown, nameKey, urlKey } from "../src/dedupe.js";
import type { DiscoveryHit } from "../src/discovery/types.js";

const hit = (over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok", handle: "ann", profileUrl: "https://www.tiktok.com/@ann", displayName: "Ann", bio: "NP · hormones",
  followers: 42000, postUrl: "https://www.tiktok.com/@ann/video/1", postText: "menopause tips", postedAt: "2026-09-01T00:00:00.000Z",
  country: "US", isRepost: null, term: "#perimenopause", ...over,
});
const rules = { followerMin: { tiktok: 5000 }, followerMax: { tiktok: 500000 }, countries: ["US", "CA"], language: "en", excludeTerms: DEFAULT_EXCLUDE_TERMS, excludeHandles: ["spamguy"] };
const ps: CompetitorRule = { id: 1, name: "Peptide Sciences", domains: ["peptidesciences.com"], codePattern: null, codePrefix: "PS", commissionPct: 15 };

describe("applyFilters", () => {
  it("counts each reject reason and keeps the rest", () => {
    const out = applyFilters(
      [hit(), hit({ handle: "spamguy" }), hit({ handle: "b", followers: 10 }), hit({ handle: "c", followers: 9e6 }), hit({ handle: "d", country: "DE" }), hit({ handle: "e", bio: "semaglutide coach" }), hit({ handle: "f", followers: null, country: null })],
      rules,
    );
    expect(out.kept.map((h) => h.handle)).toEqual(["ann", "f"]);
    expect(out.rejected).toEqual({ excluded_handle: 1, excluded_term: 1, followers_low: 1, followers_high: 1, country: 1 });
  });
  it("ships the GLP-1 names as default exclusions", () => {
    expect(DEFAULT_EXCLUDE_TERMS).toEqual(expect.arrayContaining(["semaglutide", "tirzepatide", "retatrutide", "ozempic", "wegovy", "mounjaro", "zepbound"]));
  });
});

describe("findAffiliateCode / PROMO_PATTERN", () => {
  it("finds a prefixed code and its competitor; domain match without code returns the competitor with code null", () => {
    expect(findAffiliateCode("use code PS20 at checkout", [ps])).toEqual({ code: "PS20", competitor: ps });
    expect(findAffiliateCode("shop peptidesciences.com/?ref=ann", [ps])).toEqual({ code: null, competitor: ps });
    expect(findAffiliateCode("nothing here", [ps])).toBeNull();
    expect(findAffiliateCode("code ABC12", [{ ...ps, codePrefix: null, codePattern: "^ABC\\d+$" }])).toEqual({ code: "ABC12", competitor: expect.objectContaining({ id: 1 }) });
  });
  it("promo pattern catches discount language and #ad", () => {
    for (const s of ["20% off with my link", "link in bio", "#ad", "use code ANN", "discount code"]) expect(PROMO_PATTERN.test(s)).toBe(true);
    expect(PROMO_PATTERN.test("what I eat in a day")).toBe(false);
  });
});

describe("scoreHit", () => {
  const base = { rules: { followerMin: 5000, followerMax: 500000, activityDays: 30, matchTerms: ["menopause", "hormones"], excludeTerms: DEFAULT_EXCLUDE_TERMS }, competitors: [ps], now: new Date("2026-09-14T00:00:00.000Z") };
  it("adds every line Jakob listed and explains each", () => {
    const r = scoreHit({ ...base, hit: hit(), verified: { followers: 42000, bio: "NP · hormones · code PS20", lastPostAt: "2026-09-10T00:00:00.000Z", items: [{ text: "20% off with PS20", url: "https://t/1" }], isRepostRatio: 0 } });
    // competitor 30 + commission<25 15 + reach 15 + active 15 + promo 10 + original 5 + on-niche 10
    expect(r.score).toBe(100);
    expect(r.competitor?.name).toBe("Peptide Sciences");
    expect(r.affiliateCode).toBe("PS20");
    expect(r.promoTrackRecord).toBe(true);
    expect(r.contentOriginal).toBe(true);
    expect(r.reasons).toContain("competitor affiliate: Peptide Sciences (+30)");
  });
  it("dormant is a penalty, unknowns are null not false, GLP-1-only is −30", () => {
    const r = scoreHit({ ...base, hit: hit({ bio: "ozempic journey" }), verified: { followers: 42000, bio: "ozempic journey", lastPostAt: "2026-01-01T00:00:00.000Z", items: [], isRepostRatio: null } });
    expect(r.score).toBe(15 - 20 - 30);
    expect(r.promoTrackRecord).toBeNull();
    expect(r.contentOriginal).toBeNull();
    expect(r.glp1Only).toBe(true);
  });
  it("never goes below 0 in the stored score", () => {
    const r = scoreHit({ ...base, hit: hit({ bio: "wegovy" }), verified: { followers: 1, bio: "wegovy", lastPostAt: "2025-01-01T00:00:00.000Z", items: [], isRepostRatio: null } });
    expect(r.score).toBe(0);
  });
});

describe("isKnown", () => {
  it("matches on any of the five keys", () => {
    const k = emptyKnown();
    expect(isKnown(hit(), null, k)).toBe(false);
    k.codes.add("ps20");
    expect(isKnown(hit(), "PS20", k)).toBe(true);
    const k2 = emptyKnown(); k2.handles.add("tiktok:ann");
    expect(isKnown(hit(), null, k2)).toBe(true);
    const k3 = emptyKnown(); k3.urls.add(urlKey("https://www.tiktok.com/@ann/"));
    expect(isKnown(hit(), null, k3)).toBe(true);
    const k4 = emptyKnown(); k4.names.add(nameKey("Ann", "tiktok")!);
    expect(isKnown(hit(), null, k4)).toBe(true);
    expect(nameKey("  ", "tiktok")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @biolinx/scraping test -- filter-score-dedupe`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `filter.ts`**

```ts
// Hard rejects applied before any paid verification read. Every reject is
// counted so the run summary explains where candidates went.

import type { DiscoveryHit, DiscoveryPlatform } from "./discovery/types.js";

export interface AudienceRules {
  followerMin: Partial<Record<DiscoveryPlatform, number>>;
  followerMax: Partial<Record<DiscoveryPlatform, number>>;
  countries: string[];
  language: string;
  excludeTerms: string[];
  excludeHandles: string[];
}

export type RejectReason = "excluded_handle" | "excluded_term" | "followers_low" | "followers_high" | "country";

/** D11: GLP-1-only creators are filtered at the door. Same names the
 *  compliance linter refuses in outbound copy. Editable per profile. */
export const DEFAULT_EXCLUDE_TERMS = ["semaglutide", "tirzepatide", "retatrutide", "ozempic", "wegovy", "mounjaro", "zepbound"];

export function hasTerm(text: string | null | undefined, terms: string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  return terms.find((t) => t.trim() && lower.includes(t.trim().toLowerCase())) ?? null;
}

export function applyFilters(hits: DiscoveryHit[], rules: AudienceRules): { kept: DiscoveryHit[]; rejected: Record<RejectReason, number> } {
  const rejected: Record<RejectReason, number> = { excluded_handle: 0, excluded_term: 0, followers_low: 0, followers_high: 0, country: 0 };
  const excluded = new Set(rules.excludeHandles.map((h) => h.trim().toLowerCase().replace(/^@/, "")));
  const kept: DiscoveryHit[] = [];
  for (const h of hits) {
    if (excluded.has(h.handle)) { rejected.excluded_handle++; continue; }
    if (hasTerm(h.bio, rules.excludeTerms)) { rejected.excluded_term++; continue; }
    const min = rules.followerMin[h.platform];
    const max = rules.followerMax[h.platform];
    if (h.followers != null && min != null && h.followers < min) { rejected.followers_low++; continue; }
    if (h.followers != null && max != null && h.followers > max) { rejected.followers_high++; continue; }
    if (h.country && rules.countries.length > 0 && !rules.countries.includes(h.country.toUpperCase())) { rejected.country++; continue; }
    kept.push(h);
  }
  return { kept, rejected };
}
```

- [ ] **Step 4: Write `score.ts`**

```ts
// Jakob's scoring criteria (spec §5), deterministic. Every point has a
// reason string so the reviewer sees why. Unknown signals are null, never
// false: only a human marks LIVE / promo / original as false.

import type { DiscoveryHit } from "./discovery/types.js";
import { hasTerm } from "./filter.js";

export interface CompetitorRule {
  id: number;
  name: string;
  domains: string[];
  codePattern: string | null;
  codePrefix: string | null;
  commissionPct: number | null;
}

export interface VerifiedProfile {
  followers: number | null;
  bio: string | null;
  lastPostAt: string | null;
  items: Array<{ text: string; url: string }>;
  /** share of recent items flagged as reposts; null when the platform says nothing */
  isRepostRatio: number | null;
}

export interface ScoreInput {
  hit: DiscoveryHit;
  verified: VerifiedProfile | null;
  rules: { followerMin?: number; followerMax?: number; activityDays: number; matchTerms: string[]; excludeTerms: string[] };
  competitors: CompetitorRule[];
  now: Date;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  competitor: CompetitorRule | null;
  affiliateCode: string | null;
  promoTrackRecord: true | null;
  contentOriginal: true | null;
  glp1Only: boolean;
}

export const PROMO_PATTERN = /(\d{1,2}\s?%\s?off|link in (my )?bio|#ad\b|#sponsored|use (my )?code|discount code|promo code|coupon|affiliate link)/i;

const CODE_TOKEN = /\b(?:code|use)\s*[:\-]?\s*([A-Z][A-Z0-9]{2,15})\b/gi;

export function findAffiliateCode(text: string, competitors: CompetitorRule[]): { code: string | null; competitor: CompetitorRule } | null {
  const lower = text.toLowerCase();
  const tokens = [...text.matchAll(CODE_TOKEN)].map((m) => m[1]!.toUpperCase());
  for (const c of competitors) {
    const prefix = c.codePrefix?.trim().toUpperCase();
    const re = c.codePattern ? safeRegex(c.codePattern) : null;
    for (const t of tokens) {
      if ((prefix && t.startsWith(prefix) && t.length > prefix.length) || (re && re.test(t))) return { code: t, competitor: c };
    }
  }
  for (const c of competitors) {
    if (c.domains.some((d) => d.trim() && lower.includes(d.trim().toLowerCase()))) return { code: null, competitor: c };
  }
  return null;
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

export function scoreHit(input: ScoreInput): ScoreResult {
  const { hit, verified, rules, competitors, now } = input;
  const reasons: string[] = [];
  let score = 0;
  const corpus = [hit.bio, hit.postText, verified?.bio, ...(verified?.items.map((i) => i.text) ?? [])].filter(Boolean).join("\n");

  const found = findAffiliateCode(corpus, competitors);
  if (found) {
    score += 30;
    reasons.push(`competitor affiliate: ${found.competitor.name} (+30)`);
    if (found.competitor.commissionPct != null) {
      if (found.competitor.commissionPct < 25) { score += 15; reasons.push(`their commission ${found.competitor.commissionPct}% < 25% (+15)`); }
      else { score += 5; reasons.push(`their commission ${found.competitor.commissionPct}% ≥ 25%, counter-offer angle (+5)`); }
    }
  }

  const followers = verified?.followers ?? null;
  if (followers != null && (rules.followerMin == null || followers >= rules.followerMin) && (rules.followerMax == null || followers <= rules.followerMax)) {
    score += 15;
    reasons.push(`verified reach ${followers.toLocaleString()} in range (+15)`);
  }

  const last = verified?.lastPostAt ? new Date(verified.lastPostAt) : null;
  if (last) {
    const days = (now.getTime() - last.getTime()) / 86_400_000;
    if (days <= rules.activityDays) { score += 15; reasons.push(`active, posted ${Math.round(days)}d ago (+15)`); }
    else { score -= 20; reasons.push(`dormant, last post ${Math.round(days)}d ago (−20)`); }
  }

  const promo = PROMO_PATTERN.test(corpus) || found?.code != null;
  if (promo) { score += 10; reasons.push("promo track record seen (+10)"); }

  const original = verified?.isRepostRatio != null && verified.isRepostRatio === 0 ? true : null;
  if (original) { score += 5; reasons.push("original content, no reposts (+5)"); }

  const onNiche = hasTerm(corpus, rules.matchTerms);
  if (onNiche) { score += 10; reasons.push(`on-niche: "${onNiche}" (+10)`); }

  const glp1 = hasTerm(corpus, rules.excludeTerms);
  const glp1Only = !!glp1 && !onNiche;
  if (glp1Only) { score -= 30; reasons.push(`GLP-1-only content: "${glp1}" (−30)`); }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    competitor: found?.competitor ?? null,
    affiliateCode: found?.code ?? null,
    promoTrackRecord: promo ? true : null,
    contentOriginal: original,
    glp1Only,
  };
}
```

- [ ] **Step 5: Write `dedupe.ts`**

```ts
// The five dedupe keys (spec §6). The set is built once per run from
// leads, lead_handles, outreach_log, signups, and affiliates.

import { handleKey } from "@biolinx/core";
import type { DiscoveryHit } from "./discovery/types.js";

/** host + path, lowercase, no scheme/www/query/trailing slash. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

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
```

Append to `src/index.ts`: `export * from "./filter.js"; export * from "./score.js"; export * from "./dedupe.js";`

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @biolinx/scraping test && pnpm --filter @biolinx/scraping typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/scraping
git commit -m "feat(scraping): audience filters, Jakob's scoring, five-key dedupe" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 6: Post details on every profile read (engagement on `SourceItem`)

**Files:**
- Modify: `packages/scraping/src/types.ts` (`SourceItem`), `src/fetchers/tiktok.ts`, `instagram.ts`, `youtube.ts`, `reddit.ts`
- Test: `packages/scraping/test/fetchers.test.ts` (extend the existing tests)

**Interfaces:**
- Produces: `SourceItem` gains optional `likes?: number; views?: number; comments?: number; isRepost?: boolean`. Existing consumers ignore them.

- [ ] **Step 1: Extend the existing TikTok test at `test/fetchers.test.ts:33`**

Add `diggCount: 500, playCount: 12000, commentCount: 40` to the first row and change the first-item expectation to:
```ts
    expect(b.items[0]).toEqual({
      url: "https://www.tiktok.com/@maryanadvorska/video/1",
      text: "what I eat in a day pregnant",
      postedAt: "2026-08-01T10:00:00.000Z",
      likes: 500,
      views: 12000,
      comments: 40,
    });
```
In the Instagram test add `likesCount: 900, commentsCount: 12` to the latest post and expect `likes: 900, comments: 12` on the item. In the Reddit test add `score: 33, numComments: 4` to the post row and expect `likes: 33, comments: 4`. In the YouTube test add `viewCount: 1500` and expect `views: 1500`.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @biolinx/scraping test -- fetchers`
Expected: FAIL on the four new expectations.

- [ ] **Step 3: Extend `SourceItem` in `types.ts`**

```ts
export interface SourceItem {
  url: string;
  text: string;
  postedAt: string | null; // ISO 8601 or null
  /** Engagement when the platform read provides it; omitted otherwise. */
  likes?: number;
  views?: number;
  comments?: number;
  isRepost?: boolean;
}
```

Add to `fetchers/shared.ts`:
```ts
/** Build the optional engagement fields, omitting anything not numeric
 *  (exactOptionalPropertyTypes forbids `views: undefined`). */
export function engagement(o: { likes?: unknown; views?: unknown; comments?: unknown; isRepost?: unknown }): Pick<SourceItem, "likes" | "views" | "comments" | "isRepost"> {
  const out: Pick<SourceItem, "likes" | "views" | "comments" | "isRepost"> = {};
  const l = toNumber(o.likes), v = toNumber(o.views), c = toNumber(o.comments);
  if (l != null) out.likes = l;
  if (v != null) out.views = v;
  if (c != null) out.comments = c;
  if (typeof o.isRepost === "boolean") out.isRepost = o.isRepost;
  return out;
}
```

- [ ] **Step 4: Wire each fetcher**

`tiktok.ts`: add `diggCount?: number; playCount?: number; commentCount?: number; isRepost?: boolean` to `TikTokRow`; map items as
```ts
  const items: SourceItem[] = videos.map((r) => ({
    url: r.webVideoUrl ?? "",
    text: clip(r.text),
    postedAt: toIso(r.createTimeISO),
    ...engagement({ likes: r.diggCount, views: r.playCount, comments: r.commentCount, isRepost: r.isRepost }),
  }));
```
`instagram.ts`: `latestPosts` items gain `likesCount?: number; commentsCount?: number; videoViewCount?: number`; map `...engagement({ likes: x.likesCount, comments: x.commentsCount, views: x.videoViewCount })`.
`youtube.ts`: row gains `viewCount?: number; likes?: number; commentsCount?: number`; map `...engagement({ views: r.viewCount, likes: r.likes, comments: r.commentsCount })`.
`reddit.ts`: row gains `score?: number; numComments?: number`; map `...engagement({ likes: r.score, comments: r.numComments })`.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @biolinx/scraping test && pnpm -r typecheck`
Expected: PASS.
```bash
git add packages/scraping
git commit -m "feat(scraping): keep likes/views/comments/repost on every post read" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 7: Customer.io client package

**Files:**
- Create: `packages/customerio/package.json`, `tsconfig.json`, `src/index.ts`, `test/client.test.ts`
- Modify: `packages/core/src/settings-registry.ts` (new section), `pnpm-workspace.yaml` (only if packages are listed explicitly; it is `packages/*`, so nothing)

**Interfaces:**
- Produces:
```ts
export interface CustomerioConfig { siteId: string; apiKey: string; region: "us" | "eu"; }
export function customerioFromEnv(env?: NodeJS.ProcessEnv): CustomerioConfig | null; // null when not configured
export interface CustomerioClient { identify(email: string, attributes: Record<string, string | number | boolean | null>): Promise<void>; }
export function customerioClient(cfg: CustomerioConfig, fetchImpl?: typeof fetch): CustomerioClient;
```

- [ ] **Step 1: Scaffold**

`packages/customerio/package.json`:
```json
{
  "name": "@biolinx/customerio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "devDependencies": { "@types/node": "^22.10.2", "typescript": "^5.7.2", "vitest": "^2.1.8" }
}
```
`tsconfig.json`: copy `packages/scraping/tsconfig.json` verbatim.

- [ ] **Step 2: Write the failing test `test/client.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { customerioClient, customerioFromEnv } from "../src/index.js";

describe("customerioFromEnv", () => {
  it("null when unset; us default; eu accepted", () => {
    expect(customerioFromEnv({})).toBeNull();
    expect(customerioFromEnv({ CUSTOMERIO_SITE_ID: "s", CUSTOMERIO_TRACK_API_KEY: "k" })).toEqual({ siteId: "s", apiKey: "k", region: "us" });
    expect(customerioFromEnv({ CUSTOMERIO_SITE_ID: "s", CUSTOMERIO_TRACK_API_KEY: "k", CUSTOMERIO_REGION: "eu" })?.region).toBe("eu");
  });
});

describe("identify", () => {
  it("PUTs to the track API with basic auth, email as id, and never leaks the key in errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    });
    const c = customerioClient({ siteId: "site", apiKey: "SECRETKEY", region: "us" }, ok as typeof fetch);
    await c.identify("Ann@Example.com", { first_name: "Ann", lead_id: 7, unsubscribed: false });
    expect(calls[0]?.url).toBe("https://track.customer.io/api/v1/customers/ann%40example.com");
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("site:SECRETKEY").toString("base64")}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: "ann@example.com", first_name: "Ann", lead_id: 7, unsubscribed: false });

    const bad = customerioClient({ siteId: "site", apiKey: "SECRETKEY", region: "eu" }, (async () => new Response("nope", { status: 401 })) as typeof fetch);
    await expect(bad.identify("a@b.c", {})).rejects.toThrow(/Customer\.io identify: HTTP 401/);
    await expect(bad.identify("a@b.c", {})).rejects.not.toThrow(/SECRETKEY/);
  });
  it("eu region uses track-eu", async () => {
    let url = "";
    const c = customerioClient({ siteId: "s", apiKey: "k", region: "eu" }, (async (u: string | URL) => ((url = String(u)), new Response("{}"))) as typeof fetch);
    await c.identify("a@b.c", {});
    expect(url.startsWith("https://track-eu.customer.io/")).toBe(true);
  });
});
```

- [ ] **Step 3: Write `src/index.ts`**

```ts
// Customer.io Track API client. One call: identify a person by email.
// Credentials travel only in the Authorization header; errors carry the
// status, never the key or the payload (it is PII).

export interface CustomerioConfig {
  siteId: string;
  apiKey: string;
  region: "us" | "eu";
}

export function customerioFromEnv(env: NodeJS.ProcessEnv = process.env): CustomerioConfig | null {
  const siteId = env.CUSTOMERIO_SITE_ID ?? "";
  const apiKey = env.CUSTOMERIO_TRACK_API_KEY ?? "";
  if (!siteId || !apiKey) return null;
  return { siteId, apiKey, region: env.CUSTOMERIO_REGION === "eu" ? "eu" : "us" };
}

export type CustomerioAttributes = Record<string, string | number | boolean | null>;

export interface CustomerioClient {
  identify(email: string, attributes: CustomerioAttributes): Promise<void>;
}

export function customerioClient(cfg: CustomerioConfig, fetchImpl: typeof fetch = fetch): CustomerioClient {
  const base = cfg.region === "eu" ? "https://track-eu.customer.io" : "https://track.customer.io";
  const auth = `Basic ${Buffer.from(`${cfg.siteId}:${cfg.apiKey}`).toString("base64")}`;
  return {
    async identify(email, attributes) {
      const id = email.trim().toLowerCase();
      const res = await fetchImpl(`${base}/api/v1/customers/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ email: id, ...attributes }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Customer.io identify: HTTP ${res.status}`);
    },
  };
}
```

- [ ] **Step 4: Settings section in `packages/core/src/settings-registry.ts`, after the `email` section**

```ts
  {
    id: "customerio",
    title: "Customer.io (email mirror)",
    blurb: "Every lead email is mirrored as a person with lead attributes. Journeys are built in Customer.io.",
    fields: [
      { key: "CUSTOMERIO_SITE_ID", label: "Site ID", kind: "text" },
      { key: "CUSTOMERIO_TRACK_API_KEY", label: "Track API key", kind: "secret" },
      { key: "CUSTOMERIO_REGION", label: "Region (us or eu)", kind: "text", placeholder: "us" },
    ],
  },
```

- [ ] **Step 5: Run and commit**

Run: `pnpm install && pnpm --filter @biolinx/customerio test && pnpm --filter @biolinx/core typecheck`
Expected: PASS.
```bash
git add packages/customerio packages/core pnpm-lock.yaml
git commit -m "feat(customerio): track-api client + settings section" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 8: `lead-ingest` job

**Files:**
- Create: `packages/jobs/src/lead-ingest.ts`
- Modify: `packages/jobs/src/index.ts`
- Test: `packages/jobs/test/lead-ingest.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 exports from `@biolinx/scraping`; `schema.sourcingProfiles`, `schema.competitors`, lead columns (Task 2); `NICHE_PRIORITY`, `brandFitForNiche`, `handleKey`, `normalizeEmail` from `@biolinx/core`.
- Produces:
```ts
export interface IngestDeps { fetchImpl: typeof fetch; apify: { token: string; actors: Record<string, string> }; discovererFor: (p: DiscoveryPlatform) => Discoverer; fetcherFor: (p: SourcePlatform) => Fetcher; now: () => Date; }
export function ingestDepsFromEnv(env?: NodeJS.ProcessEnv, actorOverrides?: Record<string, string>): IngestDeps;
export interface ProfileRunSummary { profileId: number; name: string; hits: number; rejected: Record<RejectReason, number>; alreadyKnown: number; verified: number; verifyFailed: number; inserted: number; estimatedCostUsd: number; stoppedBy: "cap" | "spend" | "exhausted"; termErrors: string[]; }
export interface IngestSummary { profiles: ProfileRunSummary[]; inserted: number; estimatedCostUsd: number; }
export function planProfile(profile: ProfileRow, competitors: CompetitorRule[], hitsByTerm: Map<string, DiscoveryHit[]>, known: KnownPeople, verify: (hit) => Promise<VerifiedProfile & { items: SourceItem[]; profileUrl: string } | null>, now: Date): Promise<{ candidates: Candidate[]; summary: ProfileRunSummary }>; // pure-ish core, tested without a DB
export async function runLeadIngest(db?: Db, deps?: IngestDeps, opts?: { profileId?: number }): Promise<IngestSummary>;
```

- [ ] **Step 1: Write the failing test for the pure core**

```ts
import { describe, expect, it } from "vitest";
import type { DiscoveryHit } from "@biolinx/scraping";
import { emptyKnown } from "@biolinx/scraping";
import { planProfile, type ProfileRow } from "../src/lead-ingest.js";

const profile: ProfileRow = {
  id: 1, name: "Weight-loss TikTok", active: true, niche: "Weight-loss seeker", brandFit: "both",
  platforms: ["tiktok"], terms: { tiktok: ["#perimenopause"] }, seedAccounts: null,
  followerMin: { tiktok: 5000 }, followerMax: { tiktok: 500000 }, activityDays: 30, countries: ["US"], language: "en",
  matchTerms: ["menopause"], excludeTerms: ["ozempic"], excludeHandles: [], dailyCap: 2, spendCapUsd: "2.00",
};
const hit = (handle: string, over: Partial<DiscoveryHit> = {}): DiscoveryHit => ({
  platform: "tiktok", handle, profileUrl: `https://www.tiktok.com/@${handle}`, displayName: handle, bio: "menopause coach",
  followers: 40000, postUrl: `https://www.tiktok.com/@${handle}/video/1`, postText: "menopause tips", postedAt: "2026-09-10T00:00:00.000Z",
  country: "US", isRepost: null, term: "#perimenopause", ...over,
});
const verified = (followers: number) => async (h: DiscoveryHit) => ({
  followers, bio: h.bio, lastPostAt: "2026-09-12T00:00:00.000Z", isRepostRatio: 0, profileUrl: h.profileUrl,
  items: [{ url: `${h.profileUrl}/video/1`, text: "menopause tips", postedAt: "2026-09-12T00:00:00.000Z", likes: 10 }],
});
const now = new Date("2026-09-14T00:00:00.000Z");

describe("planProfile", () => {
  it("filters, dedupes, verifies highest-first, scores, respects the daily cap, and explains", async () => {
    const known = emptyKnown();
    known.handles.add("tiktok:known1");
    const hits = new Map([["#perimenopause", [hit("a", { followers: 10000 }), hit("b", { followers: 90000 }), hit("c", { followers: 50000 }), hit("known1"), hit("tiny", { followers: 10 }), hit("de", { country: "DE" })]]]);
    const { candidates, summary } = await planProfile(profile, [], hits, known, verified(60000), now);
    expect(summary).toMatchObject({ hits: 6, alreadyKnown: 1, rejected: { followers_low: 1, country: 1, excluded_handle: 0, excluded_term: 0, followers_high: 0 }, verified: 2, inserted: 2, stoppedBy: "cap" });
    expect(candidates.map((c) => c.hit.handle)).toEqual(["b", "c"]);
    expect(candidates[0]?.lead).toMatchObject({
      firstName: "b", primaryPlatform: "TikTok", socialProfiles: "TikTok @b", totalReach: 60000, reachSourceUrl: "https://www.tiktok.com/@b",
      whereFound: "https://www.tiktok.com/@b/video/1", niche: "Weight-loss seeker", brandFit: "both", sourcingReview: "pending", sourcingProfileId: 1,
      sourcingReason: "found by Weight-loss TikTok via #perimenopause", status: "Not contacted", motion: "A", source: "sourcing", affiliationStatus: "Unsigned",
    });
    expect(candidates[0]?.lead.sourcingScore).toBe(50); // reach 15 + active 15 + original 5 + on-niche 10 + promo 0
    expect(candidates[0]?.lead.sourcingSample).toHaveLength(2); // surfaced post + 1 verified item
    expect(candidates[0]?.enrichment.status).toBe("sourced");
  });

  it("stops on the spend cap and reports it", async () => {
    const cheap = { ...profile, spendCapUsd: "0.01", dailyCap: 50 };
    const hits = new Map([["#perimenopause", Array.from({ length: 10 }, (_, i) => hit(`h${i}`))]]);
    const { summary } = await planProfile(cheap, [], hits, emptyKnown(), verified(60000), now);
    expect(summary.stoppedBy).toBe("spend");
    expect(summary.verified).toBe(0); // 10 discovery items cost 0.02 > cap before any read
  });

  it("competitor match sets Signed elsewhere, competitor name, and the code; code dedupes", async () => {
    const ps = { id: 9, name: "Peptide Sciences", domains: [], codePattern: null, codePrefix: "PS", commissionPct: 15 };
    const hits = new Map([["#perimenopause", [hit("x", { bio: "use code PSANN for 10% off" })]]]);
    const { candidates } = await planProfile(profile, [ps], hits, emptyKnown(), verified(60000), now);
    expect(candidates[0]?.lead).toMatchObject({ affiliationStatus: "Signed elsewhere", otherCreatorCompany: "Peptide Sciences", affiliateCode: "PSANN", currentOffer: "15%" });
    const known = emptyKnown(); known.codes.add("psann");
    const again = await planProfile(profile, [ps], hits, known, verified(60000), now);
    expect(again.summary.alreadyKnown).toBe(1);
  });

  it("a verify failure is counted and the lead still lands with search-row data only", async () => {
    const hits = new Map([["#perimenopause", [hit("v")]]]);
    const boom = async () => { throw new Error("actor timeout"); };
    const { candidates, summary } = await planProfile(profile, [], hits, emptyKnown(), boom, now);
    expect(summary.verifyFailed).toBe(1);
    expect(candidates[0]?.lead.totalReach).toBeNull(); // never the search-row number
    expect(candidates[0]?.enrichment).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @biolinx/jobs test -- lead-ingest`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `packages/jobs/src/lead-ingest.ts`**

```ts
// lead-ingest (sourcing spec §7): audiences → Apify discovery → filter →
// dedupe → verify by profile read → score → pending leads for review.
// planProfile is the testable core; runLeadIngest wraps it with the DB.

import { eq, inArray } from "drizzle-orm";
import { brandFitForNiche, handleKey, normalizeEmail, normalizeNiche, type Niche } from "@biolinx/core";
import { createDb, schema, type Db } from "@biolinx/db";
import { alert, telegramFromEnv } from "@biolinx/notify";
import {
  ACTOR_UNIT_PRICE,
  VERIFY_UNIT_PRICE,
  apifyConfigFromEnv,
  applyFilters,
  discovererFor as defaultDiscovererFor,
  emptyKnown,
  fetcherFor as defaultFetcherFor,
  isKnown,
  nameKey,
  scoreHit,
  urlKey,
  type CompetitorRule,
  type Discoverer,
  type DiscoveryHit,
  type DiscoveryPlatform,
  type Fetcher,
  type KnownPeople,
  type RejectReason,
  type SourceItem,
  type SourcePlatform,
  type VerifiedProfile,
} from "@biolinx/scraping";

export interface IngestDeps {
  fetchImpl: typeof fetch;
  apify: { token: string; actors: Record<string, string> };
  discovererFor: (p: DiscoveryPlatform) => Discoverer;
  fetcherFor: (p: SourcePlatform) => Fetcher;
  now: () => Date;
}

export function ingestDepsFromEnv(env = process.env, actorOverrides: Record<string, string> = {}): IngestDeps {
  const apify = apifyConfigFromEnv(env, actorOverrides);
  return { fetchImpl: fetch, apify, discovererFor: defaultDiscovererFor, fetcherFor: defaultFetcherFor, now: () => new Date() };
}

export interface ProfileRow {
  id: number;
  name: string;
  active: boolean;
  niche: string;
  brandFit: string;
  platforms: DiscoveryPlatform[];
  terms: Partial<Record<DiscoveryPlatform, string[]>>;
  seedAccounts: unknown;
  followerMin: Partial<Record<DiscoveryPlatform, number>> | null;
  followerMax: Partial<Record<DiscoveryPlatform, number>> | null;
  activityDays: number;
  countries: string[] | null;
  language: string;
  matchTerms: string[] | null;
  excludeTerms: string[] | null;
  excludeHandles: string[] | null;
  dailyCap: number;
  spendCapUsd: string | number;
}

export interface ProfileRunSummary {
  profileId: number;
  name: string;
  hits: number;
  rejected: Record<RejectReason, number>;
  alreadyKnown: number;
  verified: number;
  verifyFailed: number;
  inserted: number;
  estimatedCostUsd: number;
  stoppedBy: "cap" | "spend" | "exhausted";
  termErrors: string[];
}

export interface IngestSummary {
  profiles: ProfileRunSummary[];
  inserted: number;
  estimatedCostUsd: number;
}

export type VerifyFn = (hit: DiscoveryHit) => Promise<(VerifiedProfile & { items: SourceItem[]; profileUrl: string }) | null>;

export interface Candidate {
  hit: DiscoveryHit;
  lead: typeof schema.leads.$inferInsert;
  enrichment: { platform: string; sourceUrl: string; bundle: unknown; status: "sourced" } | null;
  handles: Array<{ key: string; url: string; verified: boolean }>;
}

const PLATFORM_LABEL: Record<DiscoveryPlatform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", reddit: "Reddit", skool: "Skool" };
const SOCIAL_PREFIX: Record<DiscoveryPlatform, string> = { tiktok: "TikTok @", instagram: "IG @", youtube: "YT @", reddit: "Reddit u/", skool: "Skool @" };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Search hits → scored candidates for one profile. No DB, no network:
 *  discovery results and the verify function are injected. */
export async function planProfile(
  profile: ProfileRow,
  competitors: CompetitorRule[],
  hitsByTerm: Map<string, DiscoveryHit[]>,
  known: KnownPeople,
  verify: VerifyFn,
  now: Date,
): Promise<{ candidates: Candidate[]; summary: ProfileRunSummary }> {
  const summary: ProfileRunSummary = {
    profileId: profile.id, name: profile.name, hits: 0,
    rejected: { excluded_handle: 0, excluded_term: 0, followers_low: 0, followers_high: 0, country: 0 },
    alreadyKnown: 0, verified: 0, verifyFailed: 0, inserted: 0, estimatedCostUsd: 0, stoppedBy: "exhausted", termErrors: [],
  };
  const spendCap = Number(profile.spendCapUsd);

  // Merge by platform:handle; discovery cost is what we already paid for.
  const merged = new Map<string, DiscoveryHit>();
  for (const hits of hitsByTerm.values()) {
    for (const h of hits) {
      summary.hits++;
      summary.estimatedCostUsd = round4(summary.estimatedCostUsd + ACTOR_UNIT_PRICE[h.platform]);
      const key = handleKey(h.platform, h.handle);
      if (!merged.has(key)) merged.set(key, h);
    }
  }

  const { kept, rejected } = applyFilters([...merged.values()], {
    followerMin: profile.followerMin ?? {},
    followerMax: profile.followerMax ?? {},
    countries: profile.countries ?? [],
    language: profile.language,
    excludeTerms: profile.excludeTerms ?? [],
    excludeHandles: profile.excludeHandles ?? [],
  });
  summary.rejected = rejected;

  const fresh = kept.filter((h) => {
    const pre = scoreHit({ hit: h, verified: null, rules: rulesFor(profile, h), competitors, now });
    if (isKnown(h, pre.affiliateCode, known)) { summary.alreadyKnown++; return false; }
    return true;
  });
  fresh.sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1));

  const niche = (normalizeNiche(profile.niche) ?? profile.niche) as Niche;
  const brandFit = profile.brandFit || brandFitForNiche(niche);
  const candidates: Candidate[] = [];

  for (const h of fresh) {
    if (candidates.length >= profile.dailyCap) { summary.stoppedBy = "cap"; break; }
    if (summary.estimatedCostUsd + VERIFY_UNIT_PRICE > spendCap) { summary.stoppedBy = "spend"; break; }
    summary.estimatedCostUsd = round4(summary.estimatedCostUsd + VERIFY_UNIT_PRICE);

    let v: Awaited<ReturnType<VerifyFn>> = null;
    try {
      v = await verify(h);
      if (v) summary.verified++;
    } catch {
      summary.verifyFailed++;
    }

    const s = scoreHit({ hit: h, verified: v, rules: rulesFor(profile, h), competitors, now });
    const sample = [
      ...(h.postUrl ? [{ url: h.postUrl, text: h.postText ?? "", postedAt: h.postedAt }] : []),
      ...(v?.items ?? []).filter((i) => i.url !== h.postUrl).slice(0, 12),
    ];
    const lastPost = v?.lastPostAt ?? h.postedAt ?? null;
    const lead: typeof schema.leads.$inferInsert = {
      firstName: (h.displayName ?? h.handle).split(" ")[0] ?? h.handle,
      lastName: (h.displayName ?? "").split(" ").slice(1).join(" ") || null,
      primaryPlatform: PLATFORM_LABEL[h.platform],
      socialProfiles: `${SOCIAL_PREFIX[h.platform]}${h.handle}`,
      whereFound: h.postUrl,
      totalReach: v?.followers ?? null,
      reachSourceUrl: v ? v.profileUrl : null,
      niche,
      brandFit,
      geoCountry: h.country,
      status: "Not contacted",
      motion: "A",
      source: "sourcing",
      affiliationStatus: s.competitor ? "Signed elsewhere" : "Unsigned",
      otherCreatorCompany: s.competitor?.name ?? null,
      currentOffer: s.competitor?.commissionPct != null ? `${s.competitor.commissionPct}%` : null,
      whatTheyPromoted: s.competitor ? s.competitor.name : null,
      affiliateCode: s.affiliateCode,
      lastPostAt: lastPost ? new Date(lastPost) : null,
      promoTrackRecord: s.promoTrackRecord,
      contentOriginal: s.contentOriginal,
      doesLive: null,
      sourcingReview: "pending",
      sourcingProfileId: profile.id,
      sourcingReason: `found by ${profile.name} via ${h.term}`,
      sourcingSample: sample,
      sourcingScore: s.score,
      notes: s.reasons.join("\n"),
      dateAdded: now,
    };
    candidates.push({
      hit: h,
      lead,
      enrichment: v ? { platform: h.platform, sourceUrl: v.profileUrl, bundle: { platform: h.platform, profileUrl: v.profileUrl, bio: v.bio, followers: v.followers, items: v.items }, status: "sourced" } : null,
      handles: [{ key: handleKey(h.platform, h.handle), url: h.profileUrl, verified: !!v }],
    });
    // Anything we just decided to insert is now "known" for the rest of this run.
    known.handles.add(handleKey(h.platform, h.handle));
    known.urls.add(urlKey(h.profileUrl));
    if (s.affiliateCode) known.codes.add(s.affiliateCode.toLowerCase());
    const nk = nameKey(h.displayName, h.platform);
    if (nk) known.names.add(nk);
  }
  summary.inserted = candidates.length;
  return { candidates, summary };
}

function rulesFor(profile: ProfileRow, h: DiscoveryHit) {
  const rules: { followerMin?: number; followerMax?: number; activityDays: number; matchTerms: string[]; excludeTerms: string[] } = {
    activityDays: profile.activityDays,
    matchTerms: profile.matchTerms ?? [],
    excludeTerms: profile.excludeTerms ?? [],
  };
  const min = profile.followerMin?.[h.platform];
  const max = profile.followerMax?.[h.platform];
  if (min != null) rules.followerMin = min;
  if (max != null) rules.followerMax = max;
  return rules;
}

/** Profile read through the existing fetchers. Skool has no profile
 *  fetcher: the discovery row is already the "read" (member count). */
export function makeVerify(deps: IngestDeps): VerifyFn {
  return async (h) => {
    if (h.platform === "skool") {
      return { followers: h.followers, bio: h.bio, lastPostAt: null, isRepostRatio: null, items: [], profileUrl: h.profileUrl };
    }
    const bundle = await deps.fetcherFor(h.platform)({ platform: h.platform, handle: h.handle, url: h.profileUrl }, { fetchImpl: deps.fetchImpl, apify: deps.apify, maxItems: 12 });
    if (bundle.items.length === 0 && bundle.followers == null) return null; // private or gone
    const dated = bundle.items.map((i) => i.postedAt).filter((d): d is string => !!d).sort();
    const flagged = bundle.items.filter((i) => typeof i.isRepost === "boolean");
    return {
      followers: bundle.followers,
      bio: bundle.bio,
      lastPostAt: dated.length > 0 ? dated[dated.length - 1]! : null,
      isRepostRatio: flagged.length > 0 ? flagged.filter((i) => i.isRepost).length / flagged.length : null,
      items: bundle.items,
      profileUrl: bundle.profileUrl,
    };
  };
}

export async function loadKnownPeople(db: Db): Promise<KnownPeople> {
  const known = emptyKnown();
  const leads = await db.select({ id: schema.leads.id, first: schema.leads.firstName, last: schema.leads.lastName, platform: schema.leads.primaryPlatform, email: schema.leads.emailNormalized, code: schema.leads.affiliateCode, site: schema.leads.websiteUrl, social: schema.leads.socialProfiles }).from(schema.leads);
  for (const l of leads) {
    if (l.code) known.codes.add(l.code.toLowerCase());
    if (l.email) known.emails.add(l.email);
    if (l.site) known.urls.add(urlKey(l.site));
    const nk = nameKey([l.first, l.last].filter(Boolean).join(" "), l.platform ?? "");
    if (nk) known.names.add(nk);
    for (const m of (l.social ?? "").matchAll(/(tiktok|ig|instagram|yt|youtube|reddit|x|skool)\s*@?u?\/?([a-z0-9._-]+)/gi)) {
      const p = m[1]!.toLowerCase();
      const platform = p === "ig" ? "instagram" : p === "yt" ? "youtube" : p;
      known.handles.add(handleKey(platform, m[2]!));
    }
  }
  for (const h of await db.select({ key: schema.leadHandles.handleKey, url: schema.leadHandles.profileUrl }).from(schema.leadHandles)) {
    known.handles.add(h.key);
    if (h.url) known.urls.add(urlKey(h.url));
  }
  for (const o of await db.select({ name: schema.outreachLog.prospectName, channel: schema.outreachLog.channel }).from(schema.outreachLog)) {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "skool"]) {
      const nk = nameKey(o.name, p);
      if (nk) known.names.add(nk);
    }
  }
  for (const s of await db.select({ email: schema.signups.emailNormalized }).from(schema.signups)) known.emails.add(s.email);
  for (const a of await db.select({ email: schema.affiliates.email }).from(schema.affiliates)) if (a.email) known.emails.add(normalizeEmail(a.email));
  return known;
}

function competitorRules(rows: Array<typeof schema.competitors.$inferSelect>): CompetitorRule[] {
  return rows.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, domains: (c.domains as string[] | null) ?? [], codePattern: c.codePattern, codePrefix: c.codePrefix, commissionPct: c.commissionPct }));
}

export async function runLeadIngest(db: Db = createDb(), deps?: IngestDeps, opts: { profileId?: number } = {}): Promise<IngestSummary> {
  const telegram = telegramFromEnv();
  const startedAt = new Date();
  const [run] = await db.insert(schema.syncRuns).values({ job: "lead-ingest", status: "running", startedAt }).$returningId();
  const summary: IngestSummary = { profiles: [], inserted: 0, estimatedCostUsd: 0 };
  try {
    if (!deps) {
      const row = await db.query.config.findFirst({ where: eq(schema.config.key, "sourcing_actors") });
      deps = ingestDepsFromEnv(process.env, (row?.value as Record<string, string> | undefined) ?? {});
    }
    const all = (await db.select().from(schema.sourcingProfiles)) as unknown as ProfileRow[];
    const profiles = all.filter((p) => (opts.profileId ? p.id === opts.profileId : p.active));
    const competitors = competitorRules(await db.select().from(schema.competitors));
    const known = await loadKnownPeople(db);
    const verify = makeVerify(deps);
    const now = deps.now();

    for (const profile of profiles) {
      const hitsByTerm = new Map<string, DiscoveryHit[]>();
      const termErrors: string[] = [];
      for (const platform of profile.platforms) {
        const terms = [...(profile.terms[platform] ?? []), ...competitors.map((c) => c.name)];
        const min = profile.followerMin?.[platform];
        const max = profile.followerMax?.[platform];
        const discoveryOpts: { followerMin?: number; followerMax?: number; country?: string; language?: string } = { language: profile.language };
        if (min != null) discoveryOpts.followerMin = min;
        if (max != null) discoveryOpts.followerMax = max;
        const country = profile.countries?.[0];
        if (country) discoveryOpts.country = country;
        for (const term of terms) {
          try {
            const hits = await deps.discovererFor(platform)(term, { fetchImpl: deps.fetchImpl, apify: deps.apify, perTerm: 30 }, discoveryOpts);
            hitsByTerm.set(`${platform}:${term}`, hits);
          } catch (err) {
            termErrors.push(`${platform} ${term}: ${(err as Error).message}`);
          }
        }
      }
      const { candidates, summary: ps } = await planProfile(profile, competitors, hitsByTerm, known, verify, now);
      ps.termErrors = termErrors;
      for (const c of candidates) {
        const [ins] = await db.insert(schema.leads).values(c.lead).$returningId();
        const leadId = ins!.id;
        if (c.enrichment) {
          await db.insert(schema.leadEnrichments).values({ leadId, platform: c.enrichment.platform, sourceUrl: c.enrichment.sourceUrl, bundle: c.enrichment.bundle, notes: null, status: c.enrichment.status, error: null });
        }
        for (const h of c.handles) {
          await db.insert(schema.leadHandles).values({ leadId, handleKey: h.key, profileUrl: h.url, ...(h.verified ? { verifiedAt: now } : {}) }).onDuplicateKeyUpdate({ set: { profileUrl: h.url } });
        }
      }
      await db.update(schema.sourcingProfiles).set({ lastRunAt: now, lastRunSummary: ps }).where(eq(schema.sourcingProfiles.id, profile.id));
      summary.profiles.push(ps);
      summary.inserted += ps.inserted;
      summary.estimatedCostUsd = round4(summary.estimatedCostUsd + ps.estimatedCostUsd);
    }

    await db.update(schema.syncRuns).set({ status: "ok", finishedAt: new Date(), detail: summary }).where(eq(schema.syncRuns.id, run!.id));
    console.log(`[lead-ingest] ok — inserted=${summary.inserted} cost≈$${summary.estimatedCostUsd}`);
    return summary;
  } catch (err) {
    const message = (err as Error).message;
    await db.update(schema.syncRuns).set({ status: "failed", finishedAt: new Date(), detail: { error: message, ...summary } }).where(eq(schema.syncRuns.id, run!.id));
    await alert(telegram, `lead-ingest FAILED: ${message}`);
    throw err;
  }
}
```

Add `export * from "./lead-ingest.js";` to `packages/jobs/src/index.ts`. `inArray` import is unused; remove it. Check `normalizeEmail` exists in `@biolinx/core` (`packages/core/src/idempotency.ts`); if it is named differently, use that name.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @biolinx/jobs test && pnpm --filter @biolinx/jobs typecheck`
Expected: PASS. The `lastPostAt` write of `new Date(lastPost)` and `dateAdded: now` must typecheck against the schema (`datetime` and `date` columns accept `Date`).

- [ ] **Step 5: Commit**

```bash
git add packages/jobs
git commit -m "feat(jobs): lead-ingest — audiences → discovery → filter → dedupe → verify → score → pending leads" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 9: Review gates in enrichment and dispatch; `customerio-sync` job

**Files:**
- Modify: `packages/jobs/src/enrich-personalize.ts:171-185` (batch filter), `packages/jobs/src/outreach-dispatch.ts:43-56` (`isDispatchCandidate`, `CandidateLead`)
- Create: `packages/jobs/src/customerio-sync.ts`
- Modify: `packages/jobs/src/index.ts`, `packages/jobs/package.json` (add `"@biolinx/customerio": "workspace:*"`)
- Test: `packages/jobs/test/outreach-dispatch.test.ts` (extend), `packages/jobs/test/customerio-sync.test.ts`

**Interfaces:**
- Produces: `isReviewable(l: { sourcingReview: string | null }): boolean` exported from `outreach-dispatch.ts` and reused by enrichment; `leadAttributes(lead, suppressed: boolean): CustomerioAttributes`; `runCustomerioSync(db?, client?, opts?: { leadIds?: number[] })`.

- [ ] **Step 1: Failing tests**

Append to `test/outreach-dispatch.test.ts` (find the existing `isDispatchCandidate` describe and add):
```ts
  it("pending or rejected sourced leads are ineligible; accepted and non-sourced pass", () => {
    const base = okLead(); // the fixture already used in this file for an "ok" verdict
    expect(isDispatchCandidate({ ...base, sourcingReview: "pending" }, opts)).toBe("ineligible");
    expect(isDispatchCandidate({ ...base, sourcingReview: "rejected" }, opts)).toBe("ineligible");
    expect(isDispatchCandidate({ ...base, sourcingReview: "accepted" }, opts)).toBe("ok");
    expect(isDispatchCandidate({ ...base, sourcingReview: null }, opts)).toBe("ok");
  });
```
If the file has no `okLead`/`opts` helpers, build one inline: a lead with `isDead: false, subProfile: "SP1", affiliationStatus: "Unsigned", status: "Not contacted", email: "a@b.c", conversionRank: 1, nextFollowUpDate: null, followUpsSent: 0, motion: "A", personalizationNotes: "MATCH — x (https://x/1)."` and `opts = { channel: "dm" as const, today: new Date(), openReplyLeadIds: new Set<number>() }`.

`test/customerio-sync.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { leadAttributes } from "../src/customerio-sync.js";

describe("leadAttributes", () => {
  it("maps the documented attribute list and nothing else", () => {
    const a = leadAttributes(
      { id: 7, firstName: "Ann", lastName: "A", source: "sourcing", emailProvenance: "published-business", niche: "Biohacker", brandFit: "biolinx", primaryPlatform: "TikTok", affiliationStatus: "Unsigned", status: "Not contacted", sourcingReview: "accepted", totalReach: 42000, geoCountry: "US", phone: "555" } as never,
      false,
    );
    expect(a).toEqual({ first_name: "Ann", last_name: "A", lead_id: 7, source: "sourcing", email_provenance: "published-business", niche: "Biohacker", brand_fit: "biolinx", primary_platform: "TikTok", affiliation_status: "Unsigned", lead_status: "Not contacted", sourcing_review: "accepted", total_reach: 42000, geo_country: "US", unsubscribed: false });
    expect(Object.keys(a)).not.toContain("phone");
  });
  it("suppressed sends only unsubscribed", () => {
    expect(leadAttributes({ id: 1 } as never, true)).toEqual({ unsubscribed: true });
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter @biolinx/jobs test -- outreach-dispatch customerio-sync`
Expected: FAIL.

- [ ] **Step 3: Gate dispatch**

In `outreach-dispatch.ts`, add `sourcingReview: string | null` to `CandidateLead`, add
```ts
/** Sourced leads are invisible to outreach and research until a human accepts them. */
export function isReviewable(l: { sourcingReview: string | null }): boolean {
  return l.sourcingReview == null || l.sourcingReview === "accepted";
}
```
and as the first line of `isDispatchCandidate`: `if (!isReviewable(l)) return "ineligible";`

- [ ] **Step 4: Gate enrichment**

In `enrich-personalize.ts` import `isReviewable` from `./outreach-dispatch.js` and add `isReviewable(l) &&` as the first condition inside the batch `.filter(`.

- [ ] **Step 5: Write `customerio-sync.ts`**

```ts
// customerio-sync (sourcing spec §8): mirror every lead email as a person.
// Nothing is enrolled in a campaign here; segments live in Customer.io.

import { eq, inArray, isNotNull } from "drizzle-orm";
import { normalizeEmail } from "@biolinx/core";
import { customerioClient, customerioFromEnv, type CustomerioAttributes, type CustomerioClient } from "@biolinx/customerio";
import { createDb, schema, type Db } from "@biolinx/db";

type Lead = typeof schema.leads.$inferSelect;

export function leadAttributes(l: Lead, suppressed: boolean): CustomerioAttributes {
  if (suppressed) return { unsubscribed: true };
  return {
    first_name: l.firstName ?? null,
    last_name: l.lastName ?? null,
    lead_id: l.id,
    source: l.source ?? null,
    email_provenance: l.emailProvenance ?? null,
    niche: l.niche ?? null,
    brand_fit: l.brandFit ?? null,
    primary_platform: l.primaryPlatform ?? null,
    affiliation_status: l.affiliationStatus ?? null,
    lead_status: l.status ?? null,
    sourcing_review: l.sourcingReview ?? null,
    total_reach: l.totalReach ?? null,
    geo_country: l.geoCountry ?? null,
    unsubscribed: false,
  };
}

export interface CustomerioSyncSummary { considered: number; synced: number; suppressed: number; failed: number; skippedNotConfigured: boolean }

export async function runCustomerioSync(db: Db = createDb(), client?: CustomerioClient, opts: { leadIds?: number[] } = {}): Promise<CustomerioSyncSummary> {
  const summary: CustomerioSyncSummary = { considered: 0, synced: 0, suppressed: 0, failed: 0, skippedNotConfigured: false };
  if (!client) {
    const cfg = customerioFromEnv();
    if (!cfg) { summary.skippedNotConfigured = true; return summary; }
    client = customerioClient(cfg);
  }
  const rows = opts.leadIds
    ? await db.select().from(schema.leads).where(inArray(schema.leads.id, opts.leadIds))
    : await db.select().from(schema.leads).where(isNotNull(schema.leads.email));
  const due = rows.filter((l) => l.email && (opts.leadIds || l.customerioSyncedAt == null || l.customerioSyncedAt < l.updatedAt));
  const suppressed = new Set((await db.select({ e: schema.suppressions.emailNormalized }).from(schema.suppressions)).map((s) => s.e));
  for (const l of due) {
    summary.considered++;
    const isSuppressed = suppressed.has(normalizeEmail(l.email!));
    try {
      await client.identify(l.email!, leadAttributes(l, isSuppressed));
      await db.update(schema.leads).set({ customerioSyncedAt: new Date() }).where(eq(schema.leads.id, l.id));
      if (isSuppressed) summary.suppressed++; else summary.synced++;
    } catch (err) {
      summary.failed++;
      console.error(`[customerio-sync] lead ${l.id}: ${(err as Error).message}`);
    }
  }
  console.log(`[customerio-sync] ${JSON.stringify(summary)}`);
  return summary;
}
```
Export from `index.ts`. Note `customerioSyncedAt < updatedAt` works because both are `Date`; a lead `update` that touches only `customerio_synced_at` also bumps `updated_at` (ON UPDATE), so the comparison must be `<`, not `<=`, and the sync write happens last. That is what the code does.

- [ ] **Step 6: Run everything and commit**

Run: `pnpm install && pnpm --filter @biolinx/jobs test && pnpm -r typecheck`
Expected: PASS.
```bash
git add packages/jobs pnpm-lock.yaml
git commit -m "feat(jobs): review gate in dispatch + enrichment; customerio-sync mirrors lead emails" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 10: API — audiences, competitors, sourced view, accept/reject, triggers

**Files:**
- Modify: `apps/api/src/index.ts` (imports; `/api/leads` view + row fields; new routes after the Leads block; `jobTriggers`)
- Modify: `apps/api/package.json` (no new deps; `@biolinx/jobs` already there)

**Interfaces:**
- Produces routes:
  - `GET /api/audiences` (admin, ops) → `{ profiles: ProfileRow & {lastRunAt,lastRunSummary}[], competitors: Competitor[] , niches: string[], platforms: string[], defaults: {...} }`
  - `POST /api/audiences`, `PUT /api/audiences/:id`, `DELETE /api/audiences/:id` (admin, ops), body = profile fields; validation errors `400 { error }`.
  - `POST /api/audiences/:id/run` (admin, ops) → runs `runLeadIngest(db, undefined, { profileId })` under lock `job:lead-ingest`.
  - `POST /api/competitors`, `PUT /api/competitors/:id`, `DELETE /api/competitors/:id` (admin, ops).
  - `GET /api/leads?view=sourced` → pending leads ordered by `sourcingScore desc`; rows gain `sourcingScore, sourcingReason, sourcingReview, brandFit, affiliateCode, competitor, lastPostAt, doesLive, promoTrackRecord, contentOriginal, sample`.
  - `POST /api/leads/:id/review` (admin, ops) body `{ decision: "accept" | "reject", affiliationStatus?, subProfile?, niche?, brandFit?, reason?, doesLive?, promoTrackRecord?, contentOriginal? }`.
  - `jobTriggers["lead-ingest"]`, `jobTriggers["customerio-sync"]`.

- [ ] **Step 1: Validation helper and routes**

Add near the other imports: `runLeadIngest, runCustomerioSync` from `@biolinx/jobs`; `NICHE_PRIORITY, brandFitForNiche, normalizeNiche, SUB_PROFILES, AFFILIATION_STATUSES` from `@biolinx/core`; `DEFAULT_EXCLUDE_TERMS` from `@biolinx/scraping` (add `"@biolinx/scraping": "workspace:*"` to `apps/api/package.json`).

After the `/api/leads/:id` route add:

```ts
// ── Audiences (sourcing profiles) + competitors ─────────────────────────

const PLATFORMS = ["tiktok", "youtube", "skool", "reddit", "instagram"] as const;
type Platform = (typeof PLATFORMS)[number];

const AUDIENCE_DEFAULTS = {
  followerMin: { tiktok: 5000, instagram: 5000, youtube: 2000, skool: 100 },
  followerMax: { tiktok: 500000, instagram: 500000, youtube: 300000, skool: 20000 },
  countries: ["US", "CA", "GB", "AU"],
  language: "en",
  activityDays: 30,
  excludeTerms: DEFAULT_EXCLUDE_TERMS,
  dailyCap: 50,
  spendCapUsd: "2.00",
};

function lines(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Returns the row to write, or an error string. */
function parseAudience(body: Record<string, unknown>): { row: Omit<typeof schema.sourcingProfiles.$inferInsert, "id">; } | { error: string } {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 120) return { error: "name is required (max 120 characters)" };
  const niche = normalizeNiche(String(body.niche ?? ""));
  if (!niche) return { error: `niche must be one of: ${NICHE_PRIORITY.join(", ")}` };
  const platforms = lines(body.platforms).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  if (platforms.length === 0) return { error: "pick at least one platform" };
  const termsIn = (body.terms ?? {}) as Record<string, unknown>;
  const terms: Partial<Record<Platform, string[]>> = {};
  for (const p of platforms) {
    const t = lines(termsIn[p]);
    if (t.length === 0) return { error: `add at least one search term for ${p}` };
    terms[p] = t;
  }
  const num = (v: unknown, lo: number, hi: number, label: string): number | { error: string } => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) return { error: `${label} must be between ${lo} and ${hi}` };
    return n;
  };
  const dailyCap = num(body.dailyCap ?? AUDIENCE_DEFAULTS.dailyCap, 1, 200, "daily cap");
  if (typeof dailyCap !== "number") return dailyCap;
  const spend = num(body.spendCapUsd ?? AUDIENCE_DEFAULTS.spendCapUsd, 0.5, 10, "spend cap");
  if (typeof spend !== "number") return spend;
  const activityDays = num(body.activityDays ?? AUDIENCE_DEFAULTS.activityDays, 1, 365, "activity window");
  if (typeof activityDays !== "number") return activityDays;
  const bounds = (v: unknown): Partial<Record<Platform, number>> => {
    const out: Partial<Record<Platform, number>> = {};
    for (const p of platforms) {
      const n = Number((v as Record<string, unknown> | undefined)?.[p]);
      if (Number.isFinite(n) && n > 0) out[p] = n;
    }
    return out;
  };
  const brandFit = ["biolinx", "aro", "both"].includes(String(body.brandFit)) ? String(body.brandFit) : brandFitForNiche(niche);
  return {
    row: {
      name,
      active: body.active !== false,
      niche,
      brandFit,
      platforms,
      terms,
      seedAccounts: body.seedAccounts ?? null,
      followerMin: bounds(body.followerMin ?? AUDIENCE_DEFAULTS.followerMin),
      followerMax: bounds(body.followerMax ?? AUDIENCE_DEFAULTS.followerMax),
      activityDays,
      countries: lines(body.countries ?? AUDIENCE_DEFAULTS.countries).map((c) => c.toUpperCase()),
      language: String(body.language ?? AUDIENCE_DEFAULTS.language).slice(0, 8),
      matchTerms: lines(body.matchTerms),
      excludeTerms: lines(body.excludeTerms ?? AUDIENCE_DEFAULTS.excludeTerms),
      excludeHandles: lines(body.excludeHandles).map((h) => h.replace(/^@/, "").toLowerCase()),
      dailyCap,
      spendCapUsd: spend.toFixed(2),
    },
  };
}

app.get("/api/audiences", { preHandler: requireRole("admin", "ops") }, async () => ({
  profiles: await db.select().from(schema.sourcingProfiles).orderBy(desc(schema.sourcingProfiles.id)),
  competitors: await db.select().from(schema.competitors).orderBy(schema.competitors.name),
  niches: [...NICHE_PRIORITY],
  platforms: [...PLATFORMS],
  defaults: AUDIENCE_DEFAULTS,
}));

app.post("/api/audiences", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const parsed = parseAudience((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const [ins] = await db.insert(schema.sourcingProfiles).values({ ...parsed.row, createdByUserId: req.user!.id, updatedByUserId: req.user!.id }).$returningId();
  await audit(req, "audience.create", "sourcing_profiles", ins!.id, { name: parsed.row.name });
  return { ok: true, id: ins!.id };
});

app.put("/api/audiences/:id", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const parsed = parseAudience((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  await db.update(schema.sourcingProfiles).set({ ...parsed.row, updatedByUserId: req.user!.id }).where(eq(schema.sourcingProfiles.id, id));
  await audit(req, "audience.update", "sourcing_profiles", id, { name: parsed.row.name, active: parsed.row.active });
  return { ok: true };
});

app.delete("/api/audiences/:id", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  await db.delete(schema.sourcingProfiles).where(eq(schema.sourcingProfiles.id, id));
  await audit(req, "audience.delete", "sourcing_profiles", id, {});
  return { ok: true };
});

app.post("/api/audiences/:id/run", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const result = await withMysqlLock(conn.pool, "job:lead-ingest", () => runLeadIngest(db, undefined, { profileId: id }));
  if (result === null) return reply.code(409).send({ error: "sourcing is already running" });
  await audit(req, "audience.run", "sourcing_profiles", id, { inserted: result.inserted, cost: result.estimatedCostUsd });
  return { ok: true, result };
});

function parseCompetitor(body: Record<string, unknown>): { row: Omit<typeof schema.competitors.$inferInsert, "id"> } | { error: string } {
  const name = String(body.name ?? "").trim();
  if (!name) return { error: "name is required" };
  const codePattern = body.codePattern ? String(body.codePattern).slice(0, 120) : null;
  if (codePattern) {
    try { new RegExp(codePattern); } catch { return { error: "code pattern is not a valid regular expression" }; }
  }
  const pct = body.commissionPct == null || body.commissionPct === "" ? null : Number(body.commissionPct);
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return { error: "commission must be 0-100" };
  return {
    row: {
      name,
      domains: lines(body.domains).map((d) => d.toLowerCase()),
      codePattern,
      codePrefix: body.codePrefix ? String(body.codePrefix).trim().toUpperCase().slice(0, 24) : null,
      commissionPct: pct,
      recurring: typeof body.recurring === "boolean" ? body.recurring : null,
      notes: body.notes ? String(body.notes) : null,
      active: body.active !== false,
    },
  };
}

app.post("/api/competitors", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const parsed = parseCompetitor((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const [ins] = await db.insert(schema.competitors).values(parsed.row).$returningId();
  await audit(req, "competitor.create", "competitors", ins!.id, { name: parsed.row.name });
  return { ok: true, id: ins!.id };
});
app.put("/api/competitors/:id", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const parsed = parseCompetitor((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  await db.update(schema.competitors).set(parsed.row).where(eq(schema.competitors.id, id));
  await audit(req, "competitor.update", "competitors", id, { name: parsed.row.name });
  return { ok: true };
});
app.delete("/api/competitors/:id", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  await db.delete(schema.competitors).where(eq(schema.competitors.id, id));
  await audit(req, "competitor.delete", "competitors", id, {});
  return { ok: true };
});

// ── Sourced-lead review ─────────────────────────────────────────────────

app.post("/api/leads/:id/review", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, id) });
  if (!lead) return reply.code(404).send({ error: "not found" });
  if (lead.sourcingReview !== "pending") return reply.code(409).send({ error: "this lead is not waiting for review" });
  const flags: Partial<typeof schema.leads.$inferInsert> = {};
  for (const k of ["doesLive", "promoTrackRecord", "contentOriginal"] as const) if (typeof b[k] === "boolean") flags[k] = b[k] as boolean;

  if (b.decision === "reject") {
    await db.update(schema.leads).set({ sourcingReview: "rejected", sourcingRejectedReason: b.reason ? String(b.reason).slice(0, 120) : null, ...flags }).where(eq(schema.leads.id, id));
    await audit(req, "lead.sourcing.reject", "leads", id, { reason: b.reason ?? null });
    return { ok: true };
  }
  if (b.decision !== "accept") return reply.code(400).send({ error: "decision must be accept or reject" });
  const affiliation = String(b.affiliationStatus ?? "");
  if (!(AFFILIATION_STATUSES as readonly string[]).includes(affiliation) || affiliation === "Our affiliate") return reply.code(400).send({ error: "affiliation must be Unsigned or Signed elsewhere" });
  const sp = String(b.subProfile ?? "").toUpperCase();
  if (!["SP1", "SP2", "SP3", "SP4"].includes(sp)) return reply.code(400).send({ error: "sub-profile must be SP1-SP4 (reject goodwill advocates instead)" });
  const niche = normalizeNiche(String(b.niche ?? lead.niche ?? ""));
  if (!niche) return reply.code(400).send({ error: "niche is required" });
  const brandFit = ["biolinx", "aro", "both"].includes(String(b.brandFit)) ? String(b.brandFit) : (lead.brandFit ?? brandFitForNiche(niche));
  await db.update(schema.leads).set({ sourcingReview: "accepted", affiliationStatus: affiliation, subProfile: sp, subProfileConfidence: "human", niche, brandFit, enrichmentStatus: "pending", ...flags }).where(eq(schema.leads.id, id));
  await audit(req, "lead.sourcing.accept", "leads", id, { affiliation, subProfile: sp, niche });
  if (lead.email) void runCustomerioSync(db, undefined, { leadIds: [id] }).catch(() => {});
  return { ok: true };
});
```

- [ ] **Step 2: Sourced view in `GET /api/leads`**

In the view ternary add a branch: `q.view === "sourced" ? rows.filter((l) => l.sourcingReview === "pending").sort((a, b) => (b.sourcingScore ?? 0) - (a.sourcingScore ?? 0)) :`. Because the later sort block re-sorts by `sort`, make the default sort for the sourced view `score`: in the sort switch add `case "score": cmp = (a, b) => (a.sourcingScore ?? 0) - (b.sourcingScore ?? 0)` with `dir` defaulting to `desc` when `q.view === "sourced" && !q.sort`. Add to each row:
```ts
      sourcingScore: l.sourcingScore,
      sourcingReason: l.sourcingReason,
      sourcingReview: l.sourcingReview,
      brandFit: l.brandFit,
      affiliateCode: l.affiliateCode,
      competitor: l.otherCreatorCompany,
      lastPostAt: l.lastPostAt,
      doesLive: l.doesLive,
      promoTrackRecord: l.promoTrackRecord,
      contentOriginal: l.contentOriginal,
      scoreReasons: l.sourcingReview ? (l.notes ?? "").split("\n").filter(Boolean) : [],
      sample: (l.sourcingSample as Array<{ url: string; text: string; postedAt: string | null; likes?: number; views?: number; comments?: number }> | null) ?? [],
      bio: l.sourcingReview ? (l.sourcingSample ? null : null) : null,
```
(Drop the `bio` line; the bio is in the enrichment bundle, shown from lead detail.) Also exclude pending and rejected from the `queue` view: add `&& (l.sourcingReview == null || l.sourcingReview === "accepted")` to its filter. Add analytics `sourcedPending: rows.filter((l) => l.sourcingReview === "pending").length`.

- [ ] **Step 3: Job triggers**

```ts
  "lead-ingest": () => runLeadIngest(db),
  "customerio-sync": () => runCustomerioSync(db),
```

- [ ] **Step 4: Typecheck and smoke**

Run: `pnpm --filter @biolinx/api typecheck`, then with the API running: `curl -s -c c.txt -X POST http://127.0.0.1:3001/api/auth/login -H 'content-type: application/json' -d '{"email":"<admin>","password":"<pw>"}'` is a password entry and must be done by the user; instead verify unauthenticated routes reject: `curl -s -X POST http://127.0.0.1:3001/api/audiences` → `{"error":"not authenticated"}`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): audiences + competitors CRUD, sourced review view, accept/reject, ingest + customerio triggers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 11: Worker schedule + one-shot runner

**Files:**
- Modify: `apps/worker/src/index.ts`, `apps/worker/package.json`
- Create: `apps/worker/src/run-ingest.ts`

- [ ] **Step 1: Schedule**

Import `runLeadIngest, runCustomerioSync` alongside the others and add to the `startScheduler` list, after `enrich-personalize`:
```ts
  { name: "lead-ingest", everyMs: 24 * HOUR, runOnBoot: false, fn: async () => void (await runLeadIngest(conn.db)) },
  { name: "customerio-sync", everyMs: HOUR, runOnBoot: true, fn: async () => void (await runCustomerioSync(conn.db)) },
```
`runOnBoot: false` for ingest: a restart must not spend money. Update the `[worker] up` log line to include `ingest 24h · customerio 1h`.

- [ ] **Step 2: `run-ingest.ts`**

```ts
// One-shot manual run:  pnpm --filter @biolinx/worker run:ingest [profileId]
import { loadEnv } from "@biolinx/core";
loadEnv();
const { connect, hydrateEnvFromSettings } = await import("@biolinx/db");
const { runLeadIngest } = await import("@biolinx/jobs");
const conn = connect();
await hydrateEnvFromSettings(conn.db);
const profileId = process.argv[2] ? Number(process.argv[2]) : undefined;
const summary = await runLeadIngest(conn.db, undefined, profileId ? { profileId } : {});
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
```
Add `"run:ingest": "tsx src/run-ingest.ts"` to the worker scripts.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm --filter @biolinx/worker typecheck`
```bash
git add apps/worker
git commit -m "feat(worker): schedule lead-ingest daily (no boot run) and customerio-sync hourly; run:ingest" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 12: Admin — Audiences page, Sourced view, labels

**Files:**
- Modify: `apps/admin/src/api.ts`, `App.tsx` (nav + route), `labels.ts`, `pages/Leads.tsx`, `styles.css`
- Create: `apps/admin/src/pages/Audiences.tsx`

- [ ] **Step 1: API client types and methods (`api.ts`)**

```ts
export interface AudienceProfile {
  id: number; name: string; active: boolean; niche: string; brandFit: string; platforms: string[];
  terms: Record<string, string[]>; followerMin: Record<string, number> | null; followerMax: Record<string, number> | null;
  activityDays: number; countries: string[] | null; language: string; matchTerms: string[] | null; excludeTerms: string[] | null;
  excludeHandles: string[] | null; dailyCap: number; spendCapUsd: string; lastRunAt: string | null; lastRunSummary: Record<string, unknown> | null;
}
export interface Competitor { id: number; name: string; domains: string[] | null; codePattern: string | null; codePrefix: string | null; commissionPct: number | null; recurring: boolean | null; notes: string | null; active: boolean }
export interface AudiencesPayload { profiles: AudienceProfile[]; competitors: Competitor[]; niches: string[]; platforms: string[]; defaults: Record<string, unknown> }
export interface SamplePost { url: string; text: string; postedAt: string | null; likes?: number; views?: number; comments?: number }
```
Extend `LeadRow` with `sourcingScore: number | null; sourcingReason: string | null; sourcingReview: string | null; brandFit: string | null; affiliateCode: string | null; competitor: string | null; lastPostAt: string | null; doesLive: boolean | null; promoTrackRecord: boolean | null; contentOriginal: boolean | null; scoreReasons: string[]; sample: SamplePost[];` and `LeadsPage.analytics` with `sourcedPending: number`.

Methods:
```ts
  audiences: () => request<AudiencesPayload>("/api/audiences"),
  saveAudience: (id: number | null, body: Record<string, unknown>) =>
    request<{ ok: true; id?: number }>(id ? `/api/audiences/${id}` : "/api/audiences", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
  deleteAudience: (id: number) => request<{ ok: true }>(`/api/audiences/${id}`, { method: "DELETE" }),
  runAudience: (id: number) => request<{ ok: true; result: { inserted: number; estimatedCostUsd: number; profiles: Array<Record<string, unknown>> } }>(`/api/audiences/${id}/run`, { method: "POST", body: "{}" }),
  saveCompetitor: (id: number | null, body: Record<string, unknown>) =>
    request<{ ok: true; id?: number }>(id ? `/api/competitors/${id}` : "/api/competitors", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
  deleteCompetitor: (id: number) => request<{ ok: true }>(`/api/competitors/${id}`, { method: "DELETE" }),
  reviewLead: (id: number, body: Record<string, unknown>) => request<{ ok: true }>(`/api/leads/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
```

- [ ] **Step 2: Labels (`labels.ts`)**

```ts
export const PLATFORM_LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", reddit: "Reddit", skool: "Skool" };
export const TERM_HELP: Record<string, string> = {
  tiktok: "One per line. #hashtag searches that tag; a plain phrase is treated as a hashtag too.",
  instagram: "One per line. #hashtag for a tag; a plain phrase runs a keyword search.",
  youtube: "One per line. Plain search phrases, e.g. peptides for recovery.",
  reddit: "One per line. Subreddits as r/Peptides (top posts of the month).",
  skool: "One per line. Community search terms; the community owner becomes the lead.",
};
export const BRAND_LABEL: Record<string, string> = { biolinx: "BiolinX", aro: "Aro", both: "BiolinX + Aro" };
export const REVIEW_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  pending: { text: "Waiting for review", tone: "warn" },
  accepted: { text: "Accepted", tone: "ok" },
  rejected: { text: "Rejected", tone: "bad" },
};
```
Extend `jobLabel`/`describeRun` with `lead-ingest` ("Find new leads": `${r.inserted} added, about $${r.estimatedCostUsd}`) and `customerio-sync` ("Customer.io mirror": `${r.synced} synced, ${r.failed} failed`).

- [ ] **Step 3: `pages/Audiences.tsx`**

One page with two sections. Structure (full component, follow the Settings page's form conventions and the existing `.settings-card`, `.settings-grid`, `.toolbar`, `.tablewrap` classes):

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, type AudienceProfile, type AudiencesPayload, type Competitor } from "../api.js";
import { PageInfo } from "../components.js";
import { BRAND_LABEL, PLATFORM_LABEL, TERM_HELP } from "../labels.js";

export function Audiences() {
  const [data, setData] = useState<AudiencesPayload | null>(null);
  const [editing, setEditing] = useState<AudienceProfile | "new" | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.audiences()); setError(""); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (p: AudienceProfile) => {
    setBusy(p.id); setMsg("");
    try {
      const r = await api.runAudience(p.id);
      setMsg(`${p.name}: ${r.result.inserted} new leads waiting for review, about $${r.result.estimatedCostUsd}.`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <>
      <PageInfo title="Audiences — who the engine looks for">
        Each audience is one niche and the search terms that find its creators. The engine runs every active audience
        once a day, finds new people, scores them, and puts them in the <strong>Sourced</strong> view on the Leads page
        for a human to accept or reject. Nobody is contacted from here. Each run is capped by the spend cap you set.
      </PageInfo>
      {error && <div className="error">{error}</div>}
      {msg && <div className="notice">{msg}</div>}
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Audiences</h1>
        <div className="grow" />
        <button className="primary" onClick={() => setEditing("new")}>New audience</button>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Niche</th><th>Brand</th><th>Platforms</th><th>Daily cap</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            {data?.profiles.length === 0 && <tr><td colSpan={7} className="muted">No audiences yet. Create one to start finding leads.</td></tr>}
            {data?.profiles.map((p) => (
              <tr key={p.id} className={p.active ? "" : "muted"}>
                <td>{p.name} {!p.active && <span className="chip unresolved">paused</span>}</td>
                <td>{p.niche}</td>
                <td>{BRAND_LABEL[p.brandFit] ?? p.brandFit}</td>
                <td>{p.platforms.map((x) => PLATFORM_LABEL[x] ?? x).join(", ")}</td>
                <td>{p.dailyCap}</td>
                <td className="muted">{p.lastRunAt ? `${new Date(p.lastRunAt).toLocaleDateString()} · ${String((p.lastRunSummary as { inserted?: number } | null)?.inserted ?? 0)} added` : "never"}</td>
                <td>
                  <button onClick={() => setEditing(p)}>Edit</button>{" "}
                  <button disabled={busy === p.id} onClick={() => void run(p)}>{busy === p.id ? "Running…" : "Run now"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && data && (
        <AudienceForm
          initial={editing === "new" ? null : editing}
          niches={data.niches}
          platforms={data.platforms}
          defaults={data.defaults}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
      <h2 style={{ marginTop: 32 }}>Competitor programs</h2>
      <p className="muted">Creators who post a competitor's code are the top target. Their code prefix or link domain is how the engine spots them.</p>
      {data && <CompetitorTable rows={data.competitors} onChanged={load} />}
    </>
  );
}
```

`AudienceForm`: a `<form className="settings-card">` with fields, in order: name; niche (radio group over `niches`, showing `BRAND_LABEL[brandFitForNiche]` next to each; since core is not imported in the admin, the brand is `both` for "Weight-loss seeker" and `biolinx` otherwise, computed inline); platforms (checkbox per platform; order of checking = run order, keep a `string[]` state); for each checked platform a `<textarea>` labelled `Search terms — ${PLATFORM_LABEL[p]}` with `TERM_HELP[p]` under it; follower min/max inputs per checked platform (prefilled from `defaults.followerMin/Max`); activity days; countries (comma list); language; match terms (textarea); exclude terms (textarea prefilled from defaults); exclude handles (textarea); daily cap; spend cap. On submit: `api.saveAudience(initial?.id ?? null, body)` and show the 400 error text inline. Also a "Pause"/"Resume" toggle bound to `active`, and a "Delete" button that calls `api.deleteAudience` only after a second click ("Click again to delete"), never `window.confirm`.

`CompetitorTable`: rows with name, domains, prefix, pattern, commission, recurring, active; an inline "Add competitor" form with the same fields; Edit toggles a row into inputs; Save calls `api.saveCompetitor`; Delete is two-click like above.

- [ ] **Step 4: Nav and route (`App.tsx`)**

Add `["/audiences", "Audiences", "🔎"]` after `/leads` for `admin` and `ops` (`me.role === "admin" || me.role === "ops"`), and `case "/audiences": return <Audiences />;`.

- [ ] **Step 5: Sourced view in `Leads.tsx`**

Add `["sourced", "Sourced"]` to `VIEWS` (after Queue) and `["score", "Score"]` to `SORTS`. Show a stat `Waiting for review` from `a.sourcedPending`. When `view === "sourced"`, render a different table body per row:

```tsx
<td>{l.sourcingScore ?? 0}</td>
<td>
  {l.name}
  {l.competitor && <span className="chip suggest" title={l.affiliateCode ? `code ${l.affiliateCode}` : "competitor link"}>promotes {l.competitor}</span>}
  <div className="muted" style={{ fontSize: 11 }}>{l.sourcingReason}</div>
</td>
<td className="muted">{l.platform ?? "—"}</td>
<td>{l.reach != null ? l.reach.toLocaleString() : <span className="muted">unverified</span>}</td>
<td className="muted">{l.lastPostAt?.slice(0, 10) ?? "—"}</td>
<td onClick={(e) => e.stopPropagation()}>
  {l.sample[0] && /^https?:\/\//.test(l.sample[0].url) && <a href={l.sample[0].url} target="_blank" rel="noreferrer">post ↗</a>}
  {" "}
  {l.profileUrl && /^https?:\/\//i.test(l.profileUrl) && <a href={l.profileUrl} target="_blank" rel="noreferrer">profile ↗</a>}
</td>
<td onClick={(e) => e.stopPropagation()}>
  {canRun && <button className="primary" onClick={() => setReviewing(l)}>Accept…</button>}{" "}
  {canRun && <button onClick={() => void reject(l)}>Reject</button>}
</td>
```

Clicking a row still opens the detail; in the detail add a card "Why this score" listing `scoreReasons`, and a card "Recent posts" listing `sample` with date, text, and `likes/views/comments` when present, each linking to the post URL if http(s).

`reject` calls `api.reviewLead(l.id, { decision: "reject", reason: "" })` after a two-click guard on that row (`confirmReject === l.id`), then `load()`. A quick reason button "Goodwill advocate" sends `reason: "goodwill advocate"`.

`ReviewForm` (inline card shown when `reviewing` is set): affiliation select (Unsigned / Signed elsewhere, prefilled Signed elsewhere when `l.competitor`), sub-profile select SP1..SP4 with `subProfileLabel` text, niche select over the five tiers prefilled from the row, brand select, three checkboxes "Runs LIVE", "Has run promos", "Original content" (unchecked = leave unknown; send only when checked). Submit → `api.reviewLead(id, { decision: "accept", affiliationStatus, subProfile, niche, brandFit, ...flags })` → close + `load()`.

- [ ] **Step 6: Styles**

Append to `styles.css`: `.chip.suggest { background: #fff4d6; color: #7a4d00; }` if not already present; `.review-form { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }`.

- [ ] **Step 7: Typecheck, run, look**

Run: `pnpm --filter @biolinx/admin typecheck && pnpm --filter @biolinx/admin build`
Expected: clean. Then open http://localhost:5173/#/audiences as admin, create an audience, and confirm the validation messages show for an empty platform list.

- [ ] **Step 8: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): Audiences page, competitor list, Sourced review view with accept/reject and post details" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01GNrYezY866HwZXFWfMWymC"
```

---

### Task 13: Live acceptance run and merge

- [ ] **Step 1: Seed one audience and one competitor through the admin** (or SQL): Weight-loss seeker, TikTok + Instagram, terms `#perimenopause`, `#menopauseweightloss` on both, daily cap 10, spend cap 1.00. Competitor: name from Matt's list with its code prefix; if the list is not available yet, leave competitors empty and note it in the acceptance log.

- [ ] **Step 2: Run** `pnpm --filter @biolinx/worker run:ingest <profileId>` and paste the summary into the spec's acceptance log section (§13, add it). Check by hand in the Sourced view: every row has a real post link or none, reach is null wherever no profile read succeeded, no row has `promoTrackRecord === false`.

- [ ] **Step 3: Accept two, reject one.** Confirm the accepted ones show `enrichment_status = pending`, appear in the Queue view, and that `run:enrich 2` researches them. Confirm the rejected one never reappears on a second `run:ingest`.

- [ ] **Step 4: Customer.io.** Set the three settings in the admin (the user enters the key). Give one accepted lead an email in the DB, run `POST /api/jobs/customerio-sync` from the Leads page button (add a small "Sync Customer.io" button next to "Research next batch" for admin), and confirm the person appears in Customer.io with `lead_id` and `source` attributes.

- [ ] **Step 5: Full test + typecheck**, then follow `superpowers:finishing-a-development-branch`: merge `feat/lead-sourcing` into `main` locally, keep the branch until the user confirms, do not push.

---

## Self-review

**Spec coverage.** §2 vocabulary → Task 1. §3.1–3.3 tables and columns → Task 2. §3.4 sub-profile untouched → Task 10 accept form sets it only from the human. §4 discovery per platform + verification read → Tasks 3, 4, 8 (`makeVerify`). §5 scoring → Task 5. §6 dedupe → Tasks 5, 8 (`loadKnownPeople`, in-run known set). §7 job → Task 8, gates → Task 9, schedule → Task 11. §8 Customer.io → Tasks 7, 9, 10 (inline on accept), 11 (hourly). §9 admin → Task 12. §10 guardrails: only http(s) URLs (`isHttpUrl` in every discoverer, `whereFound` from `postUrl`), reach null without a read (Task 8 verify-failure test), no false flags (Task 5 test), review gate (Task 9), audit on every save (Task 10). Post details (2026-09-14 request) → Task 6 + sample in Task 8 + detail card in Task 12. §11 assumptions A2/A4/A6 → `AUDIENCE_DEFAULTS` in Task 10; A1 → Task 1 alias table; A3 → Task 5; A5 → Skool in Task 4, forums absent; A7 → Task 9 syncs every lead with an email.

**Gaps found and fixed while reviewing:** `makeVerify` originally passed `{ platform: h.platform }` where `SourcePlatform` excludes `"skool"`; the Skool branch returns before the fetcher call, and the TypeScript narrowing after `if (h.platform === "skool") return` makes the remaining union assignable. If the compiler still complains, cast `h.platform as SourcePlatform` at that one call site.

**Type consistency.** `DiscoveryHit`, `Discoverer`, `DiscoveryDeps` (Task 3) are what Tasks 4, 5, 8 consume. `VerifiedProfile` is defined in `score.ts` (Task 5) and extended with `items` and `profileUrl` in `VerifyFn` (Task 8). `RejectReason` from `filter.ts` is the key type of `ProfileRunSummary.rejected`. `urlKey` is used in Tasks 5 and 8 with the same signature. `isReviewable` is defined in Task 9 and used in both jobs. API row fields in Task 10 match the `LeadRow` extension in Task 12.
