# Lead sourcing with admin-defined audiences — design

Date: 2026-09-14. Status: draft for review. Follows Jakob's "5K Scrape" canvas
(ICP definition, scoring criteria, platform priority, hard rules) received
2026-09-14, and the brief in the enrichment spec §9.

## 1. Goal

The engine today only researches the 412 leads that came from Airtable. This
feature makes it find new ones. The marketing team defines *who* in the admin,
the worker turns that into Apify searches, scores what comes back against
Jakob's criteria, and lands candidates in a review view. A human accepts or
rejects each one. Nothing sourced is researched, ranked, or contacted before
a human accepts it. Target: 5,000 scored, deduped leads across the five niche
tiers. Any email the engine holds is mirrored to Customer.io.

Jakob's hard rules, carried verbatim into code:

- Dedupe on five fields; an affiliate code match is the strongest signal.
- "Where found" is a real post link or blank. Never a search page.
- Two dollars per run on metered checks.
- First contact is never automated. This system only finds and scores.
- Reach is verified from a platform read or left blank. Never estimated.

## 2. Vocabulary changes (decision needed, default chosen)

**Niche tiers replace the niche list.** The ranking tiebreaker today is
`NICHE_PRIORITY` = Longevity, Biohacking, Gym, Women's Wellness, Nootropics,
MMA. Jakob's canvas ranks conversion probability by five tiers. The canonical
list becomes, in priority order:

| Tier | Niche label | Brand fit |
|---|---|---|
| 1 | Weight-loss seeker | Aro + BiolinX |
| 1 | Biohacker | BiolinX |
| 2 | Gym / PED-curious | BiolinX |
| 3 | Anti-aging | BiolinX |
| 4 | Sexual wellness | BiolinX |

Old labels stay valid as aliases so existing leads keep ranking:
Longevity → Anti-aging, Biohacking → Biohacker, Nootropics → Biohacker,
Gym and Gym/bodybuilding → Gym / PED-curious, MMA and MMA/combat →
Gym / PED-curious, Women's Wellness → Anti-aging. **Assumption A1:** Women's
Wellness (menopause, hormones) maps to Anti-aging rather than Weight-loss
seeker. Jakob can move it.

**Brand** is new on leads: `brand_fit` = `biolinx` | `aro` | `both`. Derived
from the tier at ingest, editable on review. Nutra is not a sourcing target yet.

## 3. Data model

### 3.1 `sourcing_profiles` (the "audience" the team edits)

| Column | Type | Notes |
|---|---|---|
| id | int | |
| name | varchar(120) | "Weight-loss TikTok", shown on every sourced lead |
| active | bool | inactive profiles never run |
| niche | varchar(40) | one canonical tier label |
| brand_fit | varchar(8) | default from tier |
| platforms | json | ordered subset of tiktok, youtube, skool, reddit, instagram |
| terms | json | `{tiktok: string[], youtube: string[], skool: string[], reddit: string[], instagram: string[]}` one per line in the editor; `#tag` = hashtag, plain = keyword, `r/name` = subreddit, Skool = community search term |
| seed_accounts | json | optional handles per platform whose recent commenters are mined (phase 2, stored now) |
| follower_min / follower_max | json | per platform, null = no bound |
| activity_days | int | default 30; older last post = dormant |
| countries | json | ISO codes, default `["US","CA","GB","AU"]` |
| language | varchar(8) | default `en` |
| match_terms | json | phrases that mean "on-niche" (used in scoring, not filtering) |
| exclude_terms | json | phrases that reject; seeded with the GLP-1 names the linter knows (D11) |
| exclude_handles | json | handles never to add |
| daily_cap | int | new leads per run, 1..200, default 50 |
| spend_cap_usd | decimal | per run, default 2.00 |
| last_run_at, last_run_summary | | stamped by the job |
| created_by_user_id, updated_by_user_id, timestamps | | every save audit-logged |

### 3.2 `competitors` (Matt's list)

| Column | Notes |
|---|---|
| name | "Peptide Sciences" |
| domains | json, affiliate link hosts and patterns, e.g. `["peptidesciences.com", "refersion.com/…"]` |
| code_pattern | regex the team pastes or a prefix, e.g. `^PS[A-Z0-9]{2,6}$` or `code_prefix: "PS"` |
| commission_pct | their known rate; null = unknown |
| recurring | bool null |
| notes | free text |

Competitor rows also seed discovery: each active competitor's name is added
as a keyword to every platform's term list at run time, because "people who
post competitor codes" is the tier-one target per Matt.

### 3.3 New columns on `leads`

| Column | Type | Source |
|---|---|---|
| brand_fit | varchar(8) | profile tier, editable |
| sourcing_review | varchar(12) | `pending` / `accepted` / `rejected`; null for non-sourced leads |
| sourcing_profile_id | int | which audience found them |
| sourcing_reason | varchar(255) | "found by Weight-loss TikTok via #perimenopause" |
| sourcing_sample | json | the post that surfaced them plus up to 12 recent posts from the verification read: `{url, text, postedAt, likes?, views?, comments?}` (requested 2026-09-14: "we need their post details") |
| sourcing_score | int | 0..100, §5 |
| sourcing_rejected_reason | varchar(120) | |
| affiliate_code | varchar(64) | code seen in bio or caption; dedupe key |
| last_post_at | datetime | from platform read |
| does_live | bool null | TikTok only, null unless the read says so |
| promo_track_record | bool null | true if any promo signal seen; never false by inference |
| content_original | bool null | true/false only when the platform read flags reposts |
| customerio_synced_at | datetime | §8 |

Existing columns reused: `primaryPlatform`, `socialProfiles` (same text
format the resolver parses), `totalReach` + `reachSourceUrl` (platform read
only), `whereFound` (the matching post URL), `whatTheyPromoted`,
`otherCreatorCompany` (competitor name), `currentOffer` (their commission when
visible), `affiliationStatus` (Unsigned / Signed elsewhere, set on review or
when a competitor code is found), `niche`, `emailProvenance`, `geoCountry`,
`source` (= "sourcing").

### 3.4 Sub-profile

Stays a separate step, unchanged: fail-safe to SP5 on low confidence, set by
the reviewer on accept. Sourcing never writes `subProfile`.

## 4. Discovery per platform

All through the existing `runActorSync` client, pinned by name and
overridable in config key `sourcing_actors`. Each returns the same
`DiscoveryHit`: `{platform, handle, profileUrl, displayName, bio, followers,
postUrl, postText, postedAt, country?, isRepost?}`.

| Platform | Actor | Input | Cost (bronze) |
|---|---|---|---|
| TikTok | `clockworks/tiktok-hashtag-scraper` | `hashtags`, `resultsPerPage` | $0.002 / video |
| Instagram | `apify/instagram-hashtag-scraper` | `hashtags`, `resultsLimit`, `keywordSearch` for plain words | $0.0023 / post |
| YouTube | `maximedupre/youtube-channel-search-scraper` | `searchTerms`, `minSubscribers`, `maxSubscribers`, `countryHint`, `languageHint` | $0.00035 / channel |
| Reddit | `clearpath/reddit-subreddit-posts-scraper` | `subreddits`, `maxPostsPerSubreddit`, `sort: top`, `timeFilter: month` | $0.002 / post |
| Skool | `crustapi/skool-community-scraper` | `searchTerms`, `includeOwnerDetails` | $0.0035 / community |

Skool candidates are community *owners* (the "hack smith" pattern), with
member count as reach and the community URL as profile. Forums are phase 2;
the profile stores nothing for them yet. Seed-account mining (commenters of a
named creator) is phase 2; the column exists so the editor can collect them.

Verification pass: every hit that survives filtering gets one profile read
through the existing per-platform fetcher (`packages/scraping/fetchers`) so
`totalReach`, bio, last post date, and the promo signals come from a direct
profile read, not from the search result. The same read supplies the recent
posts stored in `sourcing_sample` and, as a `lead_enrichments` row with status
`sourced`, the bundle the drafter can later cite. Reddit users have no follower count;
`totalReach` stays blank and the band logic already handles blank reach.

## 5. Scoring (Jakob's criteria, deterministic)

`sourcing_score` starts at 0 and adds:

| Signal | Points | How it is known |
|---|---|---|
| Competitor affiliate (code or link matched a `competitors` row) | +30 | regex over bio, captions, link-in-bio text |
| Their commission is below 25% (competitor row says so) | +15 | competitor row |
| Same or higher commission | +5 | counter-offer angle still viable |
| Verified reach inside the profile's range | +15 | profile read |
| Active: last post within `activity_days` | +15 | profile read |
| Dormant | −20 | profile read; deprioritised, not dropped |
| Runs TikTok LIVE | +10 | only when the profile read exposes it, else 0 |
| Promo track record (any code, discount, `#ad`, link-in-bio promo seen) | +10 | regex over items |
| Original content (platform flags no reposts) | +5 | only when the read flags it |
| On-niche language (`match_terms` hits in bio or sample) | +10 | text match |
| GLP-1-only content (`exclude_terms` hit with no other niche hit) | −30 | D11 penalty; a hard exclude_terms hit in the bio rejects outright |

Score orders the review view and decides which hits fit under the daily cap.
It does not touch `conversionRank`; ranking runs on accepted leads exactly as
today.

Nothing is guessed: LIVE, originality, and promo history are `null` when the
platform read gives no signal, and the reviewer can set them.

## 6. Dedupe (the five fields)

A hit is `alreadyKnown` and skipped, counted, and never inserted if any of
these match an existing lead, an outreach-log prospect, a signup, or an iDev
affiliate:

1. `affiliate_code` (strongest; a code seen anywhere equals a known lead's code)
2. `platform:handle` key in `lead_handles`
3. normalized email
4. website or link-hub URL (canonical form)
5. full name + primary platform (case-folded)

The known-people set is loaded once per run. Rejected sourced leads stay as
tombstones so their handles never come back.

## 7. Job: `lead-ingest`

Daily in the worker under the MySQL lock, after `enrich-personalize`, plus
"Run now" per profile from the admin (admin and ops). Each run:

1. Records a `sync_runs` row. Refuses to start without `APIFY_TOKEN`.
2. Loads the known-people set and the active competitor list.
3. For each active profile, for each platform in the profile's order, for
   each term (profile terms + competitor names): run discovery, up to 30 hits
   per term. A failing term is logged and skipped; it never stops the profile.
4. Merge hits by `platform:handle`. Apply rejects in order, each counted:
   excluded handle, hard exclude term in bio, follower range, country when
   known, language when known.
5. Drop `alreadyKnown`.
6. Verify the survivors by profile read, highest search-result followers
   first, stopping when the profile's spend cap is reached (price table per
   actor, summed per call) or the daily cap is filled.
7. Score. Insert as leads with `sourcing_review = pending`, `status = Not
   contacted`, `motion = A`, `source = sourcing`, `enrichment_status = null`.
   Write `lead_handles`. Stamp the profile's last run.
8. Summary into the run: per profile, per platform: hits, rejected by reason,
   alreadyKnown, verified, inserted, estimated cost.

Candidate checks in `enrich-personalize` and `outreach-dispatch` gain
`sourcing_review is null or accepted`. Pending or rejected leads are invisible
to both.

Cost: five terms on five platforms at 30 hits is about 750 search items, under
$1.50, plus verification at roughly half a cent per profile. The $2 cap holds
at the default sizes. Reaching 5,000 leads at five profiles times 50 a day is
about four weeks of runs; review throughput will be the real limit.

## 8. Customer.io mirror

Requested 2026-09-14: "whatever emails we get we send to Customer.io."

- New settings section: `CUSTOMERIO_SITE_ID`, `CUSTOMERIO_TRACK_API_KEY`
  (secret), `CUSTOMERIO_REGION` (`us` default, `eu`).
- New `packages/customerio` client: `identify(email, attributes)` via the
  Track API (`PUT /api/v1/customers/{email}`, basic auth), fetch-based,
  injectable, never logs the key or the payload.
- New job `customerio-sync`, hourly in the worker: every lead with a non-empty
  email and `customerio_synced_at` older than `updatedAt` is upserted with
  attributes `first_name, last_name, lead_id, source, email_provenance,
  niche, brand_fit, primary_platform, affiliation_status, lead_status,
  sourcing_review, total_reach, geo_country`. Suppressed emails are sent with
  `unsubscribed: true` and nothing else. Also triggered inline on accept and
  on signup creation so new emails land within seconds.
- Nothing is enrolled in a campaign by this system. Segments and journeys are
  the marketing team's, built in Customer.io on those attributes.
- **Flag, not a blocker:** Customer.io's terms forbid sending to purchased or
  scraped lists. Mirroring the records is fine; sending marketing email to a
  scraped address from there is the team's call and CAN-SPAM still applies.
  The `email_provenance` attribute is there so a segment can be limited to
  published-business addresses.

## 9. Admin

**Audiences page** (admin, ops): list with name, active switch, niche tier,
platforms, last run summary, Run now. One form to create or edit: name,
niche (radio, five tiers, brand fit shown), platforms (ordered checkboxes),
a textarea per selected platform for terms with the `#`/`r/` conventions
explained inline, follower min/max per platform, activity window, countries,
language, match terms, exclude terms (pre-filled), excluded handles, daily
cap, spend cap. Validation: at least one platform, at least one term for each
selected platform, cap 1..200, spend cap 0.5..10.

**Competitors** section on the same page: name, domains, code pattern or
prefix, commission, recurring, notes.

**Leads page, "Sourced" view:** pending leads ordered by score, showing
platform, verified followers, bio, the matching post, the score with its
reasons, and "found by <profile> via <term>". Two actions:

- **Accept** opens a three-field inline form: affiliation (prefilled Signed
  elsewhere when a competitor matched, with the competitor name), sub-profile
  (SP1..SP4), niche (prefilled). Saving sets `accepted`, and the lead enters
  ranking and the research queue like any other.
- **Reject** with an optional reason. "Goodwill advocate" is offered as a
  quick reason for SP5s.

Reviewer can tick LIVE, promo history, and original content on the row when
they checked by hand; those are the only fields a human sets to true.

## 10. Guardrails and invariants

- SP5 never contacted: unchanged, sourcing never sets a sub-profile.
- Blank reach never defaulted: Reddit and unread profiles keep `totalReach`
  null.
- Every outbound string linted: unchanged; sourcing sends nothing.
- Secrets in env or Settings only; the Customer.io key and Apify token are
  never logged. Every profile and competitor save is audit-logged with the
  actor.
- Only http(s) URLs stored in `whereFound`, `reachSourceUrl`, sample URLs.
- PII stays in MySQL; Customer.io receives only the attribute list in §8.
- A sourced lead cannot reach research or dispatch until accepted.

## 11. Assumptions made for Jakob to confirm

| # | Assumption | Why |
|---|---|---|
| A1 | Women's Wellness maps to Anti-aging | closest tier; menopause content is hormone content |
| A2 | Default follower ranges: TikTok and Instagram 5K–500K, YouTube 2K–300K, Skool 100–20K members, Reddit unbounded | micro and mid creators answer DMs; mega accounts route to agencies |
| A3 | Dedupe fields are code, handle, email, website URL, name+platform | Jakob said five, did not list them |
| A4 | Countries US, CA, GB, AU; English | the program pays in USD via Zelle or cash |
| A5 | Skool ships now via community owners; forums and seed-account mining are phase 2 | an actor exists for Skool, none for generic forums |
| A6 | Default spend cap $2 per profile per run, daily cap 50 | Jakob's rule; cap sized so five profiles stay under $10 a day |
| A7 | Customer.io receives every lead email, not just accepted ones | "whatever emails we get" |

## 12. Testing

- Vocabulary: alias table maps every old label; ranking tiebreak order equals
  the tier table.
- Discovery fetchers: mocked Apify responses, one shape test per platform,
  empty result, actor error, cost accounting.
- Filters, dedupe, and scoring as pure functions: every reject reason, every
  dedupe field, every score line, null-not-false for LIVE/promo/original.
- Job: mocked discovery and known-set; insert shape, per-term failure
  isolation, spend cap stops verification, daily cap respected, summary counts.
- Dispatch and enrichment candidate tests gain pending and rejected cases.
- Customer.io client: request shape, auth header, no key in errors;
  suppression sends unsubscribed only.
- Admin API: role guards, validation errors, audit rows on save.
- Acceptance: one profile (Weight-loss seeker, TikTok + Instagram, two terms
  each, cap 10) run once against the live database; the ten reviewed by hand;
  one accepted lead goes through research the next day; one email lands in
  Customer.io with the right attributes.
