# Lead enrichment (enrich-personalize) — design

Date: 2026-09-08. Status: approved in conversation, awaiting written review.
Plan of record: `../affiliate-system-spec/MASTER-PLAN.md` §4.2 (`enrich-personalize`) and §4.1 (`packages/scraping`).

## 1. Problem

Cold outreach cannot start without a real, sourced detail about the lead. The
drafting engine refuses to write a first touch without personalization notes,
by rule. On 2026-09-08 the live database holds 412 leads; 27 have usable notes,
51 carry failure markers from the August pass, and 334 have nothing. Every
one of the 25 blocked drafts in the database was blocked for this reason. The
engine is starved of input, not of capacity.

Two defects compound it:

1. Dispatch writes a `blocked` message row under the lead's idempotency key
   and skips any lead whose key exists. A lead blocked for missing notes can
   never be drafted for that touch again, even after it is researched.
2. Nothing writes `next_follow_up_date`. The cadence engine in `@biolinx/core`
   is tested but never called, so a second touch is due the moment the first
   is sent.

## 2. Scope

In scope:

- A new package `packages/scraping` that turns a lead's identifiers into
  verified talking points with source URLs.
- A new job `enrich-personalize` in `packages/jobs`, scheduled in the worker
  and triggerable from the admin.
- Database additions to track enrichment state and history.
- Fixing the two dispatch defects above.
- Admin: enrichment status on the Leads page and an "Enrich next batch" action.

Out of scope for this build (documented in §9 as the follow-on):

- Sourcing new leads. This build researches leads already in the database.
- Admin-configurable target audience for sourcing.
- Re-enrichment on a schedule. A lead is researched once; a manual re-run per
  lead is a later addition if needed.

## 3. Platforms and tools

Every lead with any URL or handle is attempted. Tool per platform, pinned by
actor name and overridable in the `config` table under `scraping_actors`:

| Platform | Source of identifier | Tool |
|---|---|---|
| TikTok | handle or URL | Apify `clockworks/tiktok-profile-scraper` |
| Instagram | handle or URL | Apify `apify/instagram-profile-scraper` |
| YouTube | channel URL or handle | Apify `streamers/youtube-channel-scraper` |
| Reddit | username or URL | Apify `harshmaur/reddit-user-scraper` |
| X | handle or URL | Apify `apidojo/twitter-profile-scraper` |
| Website, Substack, podcast page, Telegram/Discord landing | URL | plain fetch + HTML-to-text |
| Link hub (Linktree, Beacons, Stan) | URL | plain fetch; discovered TikTok/Instagram/YouTube links become extra candidates (one hop) |

Leads with no URL and no handle are marked `no_source` and left for a human to
add one.

Observed prices (bronze tier, 2026-09-08): TikTok about $0.002 per result,
Instagram about $0.0023 per profile, YouTube about $0.001 per video, Reddit
about $0.0015 per item, X about $0.016 per profile. A 40-lead batch at 10 items
each is under one dollar.

## 4. Package layout: `packages/scraping`

Four units, each with one job and a stable interface.

### 4.1 `resolve`

Pure. Input: the lead's `primaryPlatform`, `socialProfiles`, `whereFound`,
`websiteUrl`, `reachSourceUrl`. Output: an ordered list of candidates.

```ts
interface SourceCandidate {
  platform: "tiktok" | "instagram" | "youtube" | "reddit" | "x" | "web" | "linkhub";
  handle: string | null;   // normalized, no leading @
  url: string;             // canonical URL for the platform
}
```

Parses the formats present in the live data: `IG @name (2M); TikTok @name
(597K)`, `YT @Channel`, bare `@name` with the platform inferred from
`primaryPlatform`, full URLs, `linktr.ee` / `beacons.ai` / `stan.store` links.
Ordering: the primary platform first, then the rest in the order found. Only
http(s) URLs are ever emitted.

### 4.2 `fetchers`

One function per platform, all with the same signature and return type:

```ts
interface SourceItem { url: string; text: string; postedAt: string | null }
interface SourceBundle {
  platform: SourceCandidate["platform"];
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  followers: number | null;
  items: SourceItem[];     // captions, titles, post bodies; max 12
  discovered?: SourceCandidate[];  // link hubs only: social links found on the page
}
type Fetcher = (c: SourceCandidate, deps: FetchDeps) => Promise<SourceBundle>;
```

Apify-backed fetchers call the actor synchronously with a 90-second timeout
and read the default dataset. The web fetcher does a plain GET with a 15-second
timeout, strips scripts and styles, and keeps the first 4,000 characters of
visible text as one item. The link-hub fetcher returns an empty bundle plus
discovered candidates.

An empty `items` array is a valid result meaning "reachable, nothing to say".
A thrown error means the tool failed.

### 4.3 `summarize`

Takes a bundle, calls Claude once (model from `DRAFT_MODEL`), and returns:

```ts
interface Summary {
  verdict: "match" | "no_match";
  points: Array<{ text: string; url: string }>;  // 1–3
  note: string;   // the notes text in the August format
}
```

The prompt asks for two or three genuine, specific talking points, each tied
to one item URL from the bundle, and forbids inventing anything not present.
The output is parsed as JSON. Deterministic post-processing drops any point
whose `url` is not in the bundle's item or profile URLs. Zero surviving points
means `no_match` regardless of the model's verdict. The note text is built by
code from the surviving points, not taken from the model, so the format is
always `MATCH — <point> (<url>); <point> (<url>).`

### 4.4 `apify` client

`runActorSync(actorId, input, {timeoutMs})` and `getDatasetItems(datasetId)`,
fetch-based, injectable for tests, token from `APIFY_TOKEN`. Errors carry the
actor id and run id, never the token.

## 5. Data model (`packages/db`)

On `leads`:

- `enrichment_status` varchar(16): `pending` | `enriched` | `no_match` |
  `no_source` | `unresolvable` | `failed`. Null means never attempted.
- `enriched_at` datetime.
- `enrichment_source_url` varchar(500).
- `enrichment_attempts` int default 0.
- Remove `needs_enrichment` boolean; the status replaces it.

New table `lead_enrichments`: `id`, `lead_id`, `platform`, `source_url`,
`bundle` json (compact: profile fields plus item URLs and first 300 chars of
each text), `notes` text, `status`, `error` text, `created_at`. Index on
`lead_id`. Raw bundles older than 90 days are deleted by the job (plan §6,
PII retention).

`lead_handles` (exists, empty) is populated with every resolved
`platform:handle` key and profile URL, `verified_at` stamped when a fetch
returned a bundle.

## 6. Job: `enrich-personalize`

Each run:

1. Records a `sync_runs` row. Refuses to start without `APIFY_TOKEN` or
   `ANTHROPIC_API_KEY`, with a clear error.
2. One-time cleanup: any lead whose notes match the August failure-marker
   pattern (`hasUsableNotes` false but notes non-null) has notes cleared and
   status set to `pending`.
3. Selects up to the cap (config `ENRICH_DAILY_CAP`, default 40) of leads that
   are alive, not SP5, not converted, not in a terminal status, with status
   null, `pending`, or `failed` with fewer than 3 attempts. Ordered by
   `conversion_rank`.
4. Per lead: resolve. No candidates → `no_source`.
5. Try candidates in order. First bundle with at least one item wins. All
   candidates empty → `unresolvable`. A fetcher error on one candidate moves to
   the next; if every candidate errored → `failed`, attempts +1.
6. Summarize. `match` → write notes, `enriched`, stamp source URL and time.
   `no_match` → status `no_match`, notes untouched. Claude error → `failed`,
   bundle still saved.
7. Every attempt writes a `lead_enrichments` row. Every resolved handle upserts
   `lead_handles`.
8. Summary into the run: attempted, enriched, no_match, unresolvable,
   no_source, failed, estimated cost.

Failure of the run as a whole (database down, token rejected) alerts
Telegram. Per-lead failures do not.

Scheduling: worker entry adds `{ name: "enrich-personalize", everyMs: 24h,
runOnBoot: true }` under the MySQL lock. Admin: the existing
`POST /api/jobs/:job` trigger gains `enrich-personalize`; the Leads page gets
an "Enrich next batch" button for admin and ops.

## 7. Dispatch fixes (`packages/jobs/src/outreach-dispatch.ts`)

**Precondition, not block.** Candidate selection adds
`hasUsableNotes(lead.personalizationNotes)`. Leads without notes are counted as
`skippedUnenriched` in the summary and never get a message row. The
`no-personalization` block inside `draftMessage` stays as a last line of
defense but should never fire from dispatch.

**One-time cleanup.** A migration step deletes message rows where `state =
'blocked'` and the lint report's only rule is `no-personalization`. On
2026-09-08 that is 25 rows.

**Cadence wired.** A helper `scheduleNextTouch(lead, touchNumber)` in the jobs
package: picks `WARM_CADENCE` for motion B and `COLD_CADENCE` for motion A,
calls `nextDue(config, touchNumber)`, and writes `next_follow_up_date` as the
business-timezone date plus that many days, or null when exhausted. Called
from both the auto-send path and `confirmSent`. Dispatch candidate selection
adds `followUpsSent < config.maxTouches` for the lead's motion.

## 8. Admin changes

- Leads table: the Notes column shows the enrichment status (`ready`, `none`,
  `no match`, `unreachable`, `no source`, `failed`) with hover text; the row
  detail shows the source URL and a link to the `lead_enrichments` history.
- Leads toolbar: "Enrich next batch" for admin and ops, showing the run
  summary in the same green notice as ranking.
- Activity and Dashboard: `describeRun` gains a case for the new job.

## 9. Follow-on: sourcing with an admin-defined target audience

Requested 2026-09-08: the marketing team should be able to set who the engine
looks for, from the admin, without a code change. This is the plan's
`lead-ingest` job (§4.2). It is not built here, but this build is shaped so it
plugs in:

- The same fetchers and `SourceBundle` serve discovery: a hashtag or keyword
  search on TikTok, Instagram, YouTube, or Reddit yields profiles, and each
  profile then goes through the same resolve → fetch → summarize path.
- `lead_handles` gives the dedup key so a discovered creator who is already a
  lead, or already a rep's warm contact, is never re-added.
- The audience definition lives in a new `sourcing_profiles` table edited from
  a Settings-style page: name, niches (from the canonical niche list),
  platforms, search terms and hashtags, follower range, countries, exclusions
  (competitor brands, GLP-1-only creators per D11), daily cap, active flag.
  Multiple profiles can be active; each run records which profile produced
  each lead in `leads.source`.
- Sub-profile classification (SP1–SP5) stays a separate step, fail-safe to SP5
  on low confidence, as the plan requires.

This section is the brief for the next spec, not part of this one.

## 10. Testing

Unit, vitest, matching the existing layout:

- `resolve`: every handle format in the live data, link-hub hop, primary
  platform first, non-http URLs dropped.
- `summarize`: invented URL dropped, zero points → `no_match`, note format
  exact, malformed JSON → error.
- fetchers: mocked fetch; one bundle-shape test per platform; empty dataset;
  actor failure; web fetcher strips scripts and caps length.
- job: mocked fetchers and LLM; status transitions for every branch; cap;
  attempt limit; failure-marker cleanup; `lead_enrichments` and
  `lead_handles` writes.
- dispatch: unenriched lead skipped with no row; `next_follow_up_date` set
  after auto-send and after `confirmSent`; exhausted lead excluded.

Acceptance: a live run with the cap set to 5 against the local database,
notes checked by hand for fabrication before the schedule is enabled.
