# BiolinX Affiliate Engine — project handoff

Read this first in every session. It is the durable context that the code
and git history do not carry. Last updated 2026-09-15 after the first live
sourcing batches, US-only sourcing, and the admin review tooling.

## Who and why

- **Client:** Jakob Mesina, BiolinX Labs (biolinxlabs.com, research peptides;
  Laravel 12 store on Sticky.io; affiliates run on iDevAffiliate).
- **Builder:** Raza Khan (xpay marketing, `marketing.xpay@gmail.com`). Raza
  talks to Claude in short, informal messages; answer plainly, act, report.
  He works in manual mode: confirm before edits, commits, deploys, database
  writes, and anything that spends credit, unless he has just asked for it.
- **Team using the admin:** Diana Saltzman (cold DMs, owns iDev admin and
  payouts), Hamilton Phan (Reddit), Josh Pham (offers, BFCM), Jakob (owner).
  Matt is the external advisor whose method is "recruit competitors'
  affiliates". A marketing teammate owns outreach templates and the swipe
  file (Loom, 2026-09-14). Full roster in `packages/core/src/roster.ts`.
- **What it replaces:** a manual recruiting loop that ran through claude.ai
  chats plus Airtable. The Airtable data (412 leads) was imported once and
  Airtable is no longer the system of record. MySQL is.

## Goals, in order

1. **100 external affiliates by Black Friday, 2026-11-27.** The dashboard
   counts confirmed-external only and shows a range while any iDev account is
   unclassified.
2. **5,000 scored, deduped leads** across Jakob's niche tiers, found by the
   engine, reviewed by a human, researched, then contacted ("5K Scrape"
   canvas, 2026-09-14). Human review is the real bottleneck, not scraping.
3. **300 affiliates across BiolinX, Aro, and later Nutra.** Aro is the
   weight-loss brand; weight-loss creators fit both programs.
4. **Every affiliate can promote with zero friction:** compliance hub,
   assets, Telegram community, 25% lifetime commission on customers plus 5%
   on affiliates they recruit. Those pieces live outside this repo except the
   signup flow.

## Sourcing rules (Jakob's canvas + the marketing scoring spec)

The marketing team's spec is kept verbatim in
`docs/marketing/affiliate-scraper-spec-2026-09-11/` with a README on what is
implemented and where the engine differs.

- **US only.** Raza's standing rule: every audience is `countries: ["US"]`.
  Never widen it. Unknown location is shown as unknown, never assumed US.
- **Best affiliate:** already signed with a competitor, getting under 25%,
  not recurring. A competitor code in a bio or caption is the strongest
  signal and the strongest dedupe key.
- **Niche tiers:** 1 Weight-loss seeker (Aro + BiolinX; includes women's
  wellness, menopause, PCOS) and Biohacker; 2 Gym / PED-curious; 3
  Anti-aging; 4 Sexual wellness (paused until researched). `NICHE_PRIORITY`
  in core is the ranking tiebreaker and the audience run order.
- **Platforms:** TikTok and YouTube first; Instagram with them; Reddit and
  Skool are a second wave (audiences exist, paused). X is not a target.
- **Scoring** (`packages/scraping/src/score.ts`, deterministic, every point
  has a reason): competitor affiliate, their commission vs our 25%, verified
  reach in range, active in 30 days vs dormant, promo track record, original
  content, on-niche terms, GLP-1-only penalty, store/business penalty.
- **Hard rules:** dedupe on five fields; "where found" is a real post link or
  blank; spend caps; first contact is never automated, a human sends it.

## Invariants (enforced in code, never relax)

- SP5 ("goodwill advocate") leads are never contacted. Sourcing never sets a
  sub-profile; a reviewer does, SP1 to SP4 only, and rejects SP5s.
- Blank reach is never defaulted or estimated. Reach comes from a platform
  read or stays null. Reddit reach stays null even though Reddit's reader
  returns an opt-in follower count.
- The iDev referral tier setting `20` (= 5% of sale) is never changed.
- Every outbound string passes the compliance linter. Suppressed emails are
  never sent. Attribution is a foreign key, never a matched string.
- Secrets live in env or the encrypted Settings table, never in logs or the
  repo. PII lives in MySQL only.
- Only http(s) URLs are ever stored in link columns (XSS guard in admin).
- A sourced lead with `sourcing_review` pending or rejected is invisible to
  research, dispatch, and ranking: it has no conversion rank until accepted.
- `does_live`, `promo_track_record`, `content_original` are true or null from
  code. Only a human sets false.
- The worker never runs `lead-ingest` or `enrich-personalize` on boot. A
  restart must not spend money.
- Country, reach and activity come from evidence only. Heuristics that fail a
  check against real leads are not shipped (a "likely US by post times" hint
  was built and dropped: it labeled a UK account US).

## What is built (2026-09-15, all on `main`, 294 tests, 0 type errors)

- **Core:** rank engine (bands 1/2/3/3b/4/5), cadence (cold A: touches at
  4/8/12 days, max 4; warm B: max 12), compliance linter, settings registry,
  niche tiers and aliases, roster.
- **Jobs (worker, MySQL `GET_LOCK` scheduler):** `idev-sync` 30m,
  `rank-recompute` 6h, `referral-expiry` 24h, `enrich-personalize` 24h (cap
  40), `lead-ingest` 24h (both marked `spends`: never on boot, first run
  anchored to the last `sync_runs` row, at least 1h after a restart),
  `customerio-sync` 1h, `metrics-digest` 24h, `swipe-sync` 10m,
  `swipe-search` 24h (spends; only when switched on). `outreach-dispatch` and
  `reply-ingest` run only from admin buttons or one-shot runners.
- **Scraping (`packages/scraping`):** per-platform Apify profile readers
  (TikTok, Instagram with "About this account", YouTube, Reddit, X, web, link
  hubs) and five discoverers (search actors live under `discover:<platform>`
  keys, never the readers' bare keys). Claude summaries with deterministic URL
  verification for research notes.
- **Lead ingest (`packages/jobs/src/lead-ingest.ts`), per run:**
  - Audiences run in niche-priority order. A daily `$10` limit across all
    audiences (`SOURCING_DAILY_SPEND_USD`), each audience's own cap, and a
    review-queue limit (`SOURCING_MAX_PENDING`, currently 50: no new leads
    while that many wait) all gate spend. Real per-platform read prices in
    `VERIFY_PRICE`.
  - Search planning: audience terms round-robin across platforms, then
    competitor searches (40% of the search budget is reserved for them):
    `"<competitor> code"` as a TikTok keyword search (`clockworks/tiktok-scraper`,
    $0.003/result, config key `discover:tiktok-search`) and a YouTube search;
    Skool keeps the bare name. Searching the name as a hashtag (the old way)
    found 10 leads, none of whom mentioned the competitor. A competitor-search
    hit must name a competitor in its post or bio before any paid read
    (`no_mention`). Codes are read from "use code X", quoted codes, disguised
    "cod3", and referral links (`?ref=X`). Test on 2026-09-16 (Amino Club,
    Ameano, Peptira; about $0.40): TikTok keyword search returned real code
    posts (17 of 24 for Amino Club), but most code posters have under 5K
    followers (34 dropped by the minimum), so the follower minimum for
    competitor affiliates is a decision for Jakob. YouTube titles rarely carry
    codes (0-5 of about 20 channels). Daily
    rotation through competitors, a search already run by another audience
    this run is skipped, searches that stop finding new people rest (term
    memory in config `sourcing_term_stats:<id>`).
  - Quality gates (`quality.ts`, `country.ts`), free checks before the paid
    read and full checks after: non-English, off-niche,
    follower range (re-checked after the read), country outside the US,
    failed read, dead (no post in 60 days; was 180), and **weak reach**:
    median views of the recent posts under 0.5% of followers on TikTok or
    1% on YouTube (zeros ignored as unreported; Instagram has no view
    counts). The 47-lead review on 2026-09-15 (ours and an independent pass
    agreed) found this was the main failure: 466K followers, 526 views. Gated people are remembered 90 days in config
    `sourcing_gated_handles` so they aren't paid for again (failed reads are
    not remembered).
  - Country evidence, in order: platform field (YouTube channel location,
    Instagram "About this account"), TikTok post country, bio location
    wording (place names beat heritage flags), 2+ captions agreeing.
  - Store/business detection: handle, storefront or clinic bio wording,
    Instagram business category.
  - Competitor detection: whole-word names and domains, hashtag spellings per
    word, a personal code within 80 characters of the mention.
  - Email written in the bio is saved (`emailFromText`, provenance
    `scraped`, so the linter blocks automated email to it) and is a dedupe
    key, falling back to an email written in their posts; shown in the
    Sourced table, the lead dialog and the CSV with where it was written.
    The lead dialog groups "How we found them" (acquisition channel, the
    post and its stats), "Contact" and "Competitor" (the exact words and
    the post link); the CSV has the same columns.
  - Dedupe: five keys from every table holding a person, handles parsed from
    every imported `social_profiles` format, plus the unique `lead_handles`
    index inside a per-lead transaction.
- **Admin:**
  - Leads (Queue, Sourced, All, Needs triage), full width, 25–200 rows per
    page. Every view shows handle, bio, niche and brand, country, reach, avg
    views, engagement, posts in 30 days, competitor with code or offer, and a
    store flag, with filters (niche, competitor yes/no and by name, stores,
    active, country, min reach, min engagement). Sourced adds review status,
    audience, min score, surfaced-post stats, "US ✓ / location ?" flags, and
    Accept/Reject.
  - Clicking a lead opens a dialog with the summary, stats, links, and
    decisions; the Accept form is a dialog too.
  - "Download for marketing (CSV)" exports sourced leads with the spec's
    fields (`packages/jobs/src/sourced-export.ts`, formula-safe cells).
  - Audiences, Send messages, Email ops, Replies, Signups, Affiliates,
    Activity, Team (invite links, no email sent; marketing should get the
    `ops` role), Settings (encrypted; Alerts has "Send test alert").
- **Swipe file → Biolinx content library** (`packages/jobs/src/content/`,
  admin Swipe file page, `docs/integrations/biolinx-content-api.md`):
  picks posts with 1.5×+ their creator's average views and 10K+ views
  (loosened from 2×/20K on 2026-09-15 when every post was used), plus top
  TikTok posts from its own hashtag search (`swipe-search.ts`, table
  `swipe_sources`: 50K+ views and views ≥ followers, or 300K+; English, not
  known non-US, ≤ 1 year; "Find top posts" button, about $1 a run, counts
  toward the daily sourcing limit; daily when `SWIPE_SEARCH_DAILY` is on and
  fewer than 10 unused wait). Instagram's hashtag feed returns only brand-new
  posts, so it isn't searched; TikTok blocks #peptides and #bpc157. Claude writes three
  original variants, a pre-flight mirrors Biolinx's rejections plus our
  linter, and a person must Approve before anything is sent. Biolinx saves
  each post it accepts as a draft; it reaches affiliates only when someone
  presses Publish on Biolinx's Assets tab. Decline asks "what more do
  you need?" and writes a new version. Signed HMAC both ways; callbacks at
  `/webhooks/biolinx/content` are verified on the raw bytes; `swipe-sync`
  worker job every 10 minutes. The writer may state only facts listed in
  `BIOLINX_BRAND_FACTS` (Settings). Images are made by Biolinx's Gemini
  creator: with `BIOLINX_MAKES_IMAGES` on, approved posts go out with
  `image_text` + `image_brief` (no `image_url`), the image link comes back on
  `post.ready`, and "Redo image" asks for a new one with a note
  (`POST /api/content/assets/{id}/image`). The switch stays off until the
  Biolinx dev ships those changes (spec in the integration doc). A pasted
  https image link still works and is sent as `image_url`.
- **Customer.io:** every lead with an email is mirrored as a person hourly and
  on accept. Suppressed addresses go as unsubscribed only. No campaigns are
  triggered by us.

## Live state (2026-09-15)

- **Server:** gemboxpk.com, API and worker under PM2, 62 iDev affiliates
  synced (43 external). Admin logins: `marketing.xpay@gmail.com` and
  `razakkhanafridi@gmail.com`, both admin.
- **Keys set:** Apify, Anthropic, iDev, Instantly, Customer.io. **Telegram is
  not set**, so failure alerts go nowhere until it is.
- **Apify:** legacy Starter plan (Bronze prices) with the monthly usage limit
  raised to $200; the Scale upgrade was deferred. Six ingest runs so far,
  about $5.30 estimated; real bills ran about 10% above estimates.
- **Sourced leads:** 76 total. After the weak-reach backfill on 2026-09-15:
  32 waiting, 44 rejected (15 for weak reach, audit actor
  `quality-backfill`); 12 emails saved from bios. Earlier rejections (under 5K followers,
  businesses, non-English, UK/Sweden, off-niche, dead, failed reads).
- **Active audiences (8, US only):** TikTok and YouTube for Weight-loss
  seeker (caps 10/5), Biohacker (10/5), Gym (8/4), Anti-aging (5/3).
  Instagram was split out and paused on 2026-09-15 (17 of 18 Instagram leads
  rejected, 0 confirmed US). Skool, Reddit and Sexual wellness are paused;
  Skool was never run, so its value is unknown until tested.
- **Competitors:** 16, seeded from imported leads. Only 1 has a commission
  rate on file, so the under-25% / equal-25% split can't be automated yet.
- **Outreach:** 9 DM drafts waiting for approval, 1 sent.
- **Swipe file:** connected 2026-09-15. Secret saved (encrypted); signed test
  both ways passed (Biolinx answers a signed lookup, our callback URL accepts
  a signed callback). Auto-send off, brand facts empty, nothing sent yet. 2 drafts from the live test await an image; 2 earlier
  test drafts were declined for stating unverified facts. Only a handful of
  source posts qualify today, so swipe needs its own "top posts" searches to
  scale.

## Not built yet

- LIVE status checks (TikTok Live Status actor, per username over ~7 days).
- "Not recurring" in scoring (the competitors table has the field).
- Outreach template wiring from the marketing Loom: branch by competitor and
  rate, soft/direct A/B assigned within follower bands, reply templates
  (yes / tell me more / no → referral ask), check-ins, all through the
  approval queue. Blocked on competitor rates and a template for unsigned
  creators (most leads).
- Biolinx side of Biolinx-made images (accept posts without `image_url`,
  generate, call back, `/image` redo endpoint), and the Biolinx-side requests in
  `docs/integrations/biolinx-content-api.md` (visual policy check, shape check,
  Telegram note, retire endpoint, brand images, validate, rules, stats, test
  mode).
- Bulk accept/reject, post cover thumbnails, tier-specific score weights, an
  organic-mention field, email finding for sourced leads, forum discovery.
- From MASTER-PLAN v3 (sibling `affiliate-system-spec` folder): Motion B rep
  workspace, knowledge/gaps UI, store webhook beyond logging, live iDev
  signup writes, affiliate-monitor, payout-guard, Laravel store patches,
  scheduled dispatch and reply-ingest, removal of signup steps 1b–1d.

## Decisions for Jakob (defaults are live)

| # | Live default | Where to change |
|---|---|---|
| A1 | Women's Wellness, Menopause, PCOS → Weight-loss seeker (from the marketing spec) | `packages/core/src/enums.ts` aliases |
| A2 | Followers: TikTok/Instagram 5K–500K, YouTube 2K–300K, Skool 100–20K, Reddit unbounded | per audience |
| A3 | Dedupe keys: code, platform handle, email, website URL, name+platform | `packages/scraping/src/dedupe.ts` |
| A4 | **US only** (Raza's rule, replaces US/CA/GB/AU); English | per audience |
| A5 | Skool via community owners; forums later | — |
| A6 | Per-audience caps (above), $10/day across audiences, 50 leads waiting max | Audiences page, Settings |
| A7 | Every lead email goes to Customer.io, not only accepted ones | `packages/jobs/src/customerio-sync.ts` |
| D11 | GLP-1-only bios are dropped; the marketing spec calls organic GLP-1 talk warmer | `DEFAULT_EXCLUDE_TERMS`, per audience |

Matt's competitor list with commission rates has still not arrived. It goes in
the Competitors table on the Audiences page.

## Running it

```bash
pnpm install
pnpm -r test && pnpm -r typecheck      # note: the admin's typecheck script ends in `|| exit 0`
cd apps/admin && npx tsc --noEmit      # the real admin type check
pnpm --filter @biolinx/db apply-sql sql       # idempotent; run after every pull
pnpm dev:api      # :3001
pnpm dev:admin    # :5173
pnpm dev:worker   # all scheduled jobs; spending jobs wait ≥1h after boot
# one-shots (all spend real credit except dispatch to the approval queue):
pnpm --filter @biolinx/worker run:enrich 5
pnpm --filter @biolinx/worker run:ingest            # daily set: active audiences not run today
pnpm --filter @biolinx/worker run:ingest <id>       # one audience
pnpm --filter @biolinx/worker run:ingest all        # every active audience, even if run today
pnpm --filter @biolinx/worker run:dispatch dm 5
```

Production runs at `/var/www/bioscraping` on the gemboxpk.com server (nginx →
:3001; site config tracked in `infra/nginx-gemboxpk.conf`). Deploy with
`/var/www/bioscraping/infra/deploy.sh`: it finds Node 22 in
`/opt/node22/bin`, pulls, installs, applies SQL, builds the admin, restarts
PM2 from `infra/ecosystem.config.cjs`, and waits for /health. Push via the
`github-bioscraping` SSH alias. Repo: `github.com/raza935552/bioscraping`.
The older `biolinkxaffilaiteengine` repo is stale.

Settings (Apify, Anthropic, iDev, Instantly, Customer.io, Telegram, sourcing
limits) are entered on the admin Settings page and stored AES-encrypted with
`SETTINGS_KEY` from `.env`. The server's `.env` now uses Raza's local
`SETTINGS_KEY` (old one backed up in `.env.bak-2026-09-14`, gitignored). A
database dump only decrypts where `.env` has the same key.

## Gotchas learned the hard way

- `drizzle-kit push` hangs on an interactive rename prompt. Schema changes
  ship as SQL files in `packages/db/sql/` applied by `apply-sql`.
- Apify actor ids use `~` in the REST path. Discovery actors and profile
  readers must never share config keys (every search once called a reader).
- Actor output drifts. Seen live: TikTok country as GeoNames ids (`6252001`),
  YouTube upload dates as "5d ago", Reddit rows as `user_profile` with
  `commentCreatedAt`, a Reddit read returning nothing for a lowercased
  username (send the profile URL), Skool owner links as `/u/<name>`,
  Instagram hashtag feeds returning one post for small tags, Instagram search
  rows with no follower count. Smoke-test a reader on 2–5 real items before a
  full run.
- Scraped text needs whole-word matching: squashing text made "information
  peptides" look like the competitor "Ion Peptide".
- Long runs started from a Claude session die when the session ends. Start
  them detached (`setsid nohup … &`) and watch the log.
- `pkill -f <pattern>` inside a Bash tool call kills its own shell when the
  pattern appears in the command. Find the PID with `ps`, then `kill` it.
- Lead `created_at` is not in UTC; select new leads by id, not by time.
- To check an admin-only API route on the server without a password, sign a
  session with `issueSessionToken` from `apps/api/src/auth.ts` in a throwaway
  script and curl `127.0.0.1:3001`; delete the script after.
- Text sent to Anthropic must be cut by code point (`safeSlice`).
- Local MySQL (Raza's Windows machine) is Laragon 8.4; use the root URL.

## Next steps, in order

1. Raza: Telegram bot token and chat ID on Settings, then "Send test alert".
2. Raza: invite the marketing team from Team with the `ops` role.
3. Marketing reviews the 47 waiting leads (CSV or admin). Their feedback
   decides whether to raise `SOURCING_MAX_PENDING` and scale audiences.
4. Accept two sourced leads and reject one; confirm next-day research on the
   accepted ones and that the rejected one never returns.
5. Approve the 9 queued DM drafts; the first live check that
   `next_follow_up_date` is written on send.
6. Swipe file: Biolinx dev ships Biolinx-made images (integration doc,
   "Needed now"); turn on `BIOLINX_MAKES_IMAGES`; enter `BIOLINX_BRAND_FACTS`;
   approve one post, check the image arrives, then Publish it on Biolinx.
7. Competitor commission rates (Matt or research) and an unsigned-creator
   template, then wire the outreach templates.
8. LIVE status checks; "not recurring" in scoring.
9. Jakob: A2–A7 and D11. Apify Scale upgrade before scaling volume.
