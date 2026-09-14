# BiolinX Affiliate Engine — project handoff

Read this first in every session. It is the durable context that the code
and git history do not carry. Last updated 2026-09-14 by the session that
built lead sourcing.

## Who and why

- **Client:** Jakob Mesina, BiolinX Labs (biolinxlabs.com, research peptides;
  Laravel 12 store on Sticky.io; affiliates run on iDevAffiliate).
- **Builder:** Raza Khan (xpay marketing, `marketing.xpay@gmail.com`). Raza
  talks to Claude in short, informal messages; answer plainly, act, report.
- **Team using the admin:** Diana Saltzman (cold DMs, owns iDev admin and
  payouts), Hamilton Phan (Reddit), Josh Pham (offers, BFCM), Jakob (owner).
  Matt is the external advisor whose method is "recruit competitors'
  affiliates". Full roster in `packages/core/src/roster.ts`.
- **What it replaces:** a manual recruiting loop that ran through claude.ai
  chats plus Airtable. The Airtable data (412 leads) was imported once and
  Airtable is no longer the system of record. MySQL is.

## Goals, in order

1. **100 external affiliates by Black Friday, 2026-11-27.** The dashboard
   counts confirmed-external only and shows a range while any iDev account is
   unclassified.
2. **5,000 scored, deduped leads** across Jakob's five niche tiers, found by
   the engine, reviewed by a human, researched, then contacted. This is the
   "5K Scrape" canvas Jakob wrote on 2026-09-14.
3. **300 affiliates across BiolinX, Aro, and later Nutra.** Aro is the
   weight-loss brand; weight-loss creators fit both programs.
4. **Every affiliate can promote with zero friction:** compliance hub,
   assets, Telegram community, 25% lifetime commission on customers plus 5%
   on affiliates they recruit. Those pieces live outside this repo except the
   signup flow.

## Jakob's ICP canvas (the sourcing rules, verbatim intent)

- **Best affiliate:** already signed with a competitor, getting under 25%,
  not recurring. A competitor coupon code in a bio or caption is the strongest
  signal and the strongest dedupe key.
- **Niche tiers by conversion probability:** 1 Weight-loss seeker (Aro +
  BiolinX) and Biohacker; 2 Gym / PED-curious; 3 Anti-aging; 4 Sexual
  wellness. These are now `NICHE_PRIORITY` in core and the ranking tiebreaker.
  Old labels (Longevity, Biohacking, Gym, Women's Wellness, Nootropics, MMA)
  alias onto them.
- **Platform priority:** TikTok (LIVE converts like a webinar), YouTube,
  Skool, Reddit, Instagram. X exists in the fetchers but is not a target.
- **Scoring:** competitor affiliate, their commission vs our 25% lifetime,
  verified reach only, active in the last 30 days vs dormant, LIVE status
  checked never guessed, promo track record, original content vs reposts.
  Implemented deterministically in `packages/scraping/src/score.ts`.
- **Hard rules:** dedupe on five fields; "where found" is a real post link or
  blank; two dollars per run on metered checks; first contact is never
  automated, a human sends it; this system only finds and scores.

## Invariants (enforced in code, never relax)

- SP5 ("goodwill advocate") leads are never contacted. Sourcing never sets a
  sub-profile; a reviewer does, SP1 to SP4 only, and rejects SP5s.
- Blank reach is never defaulted or estimated. Reach comes from a platform
  read or stays null. Reddit has no follower count and stays null.
- The iDev referral tier setting `20` (= 5% of sale) is never changed.
- Every outbound string passes the compliance linter. Suppressed emails are
  never sent. Attribution is a foreign key, never a matched string.
- Secrets live in env or the encrypted Settings table, never in logs or the
  repo. PII lives in MySQL only.
- Only http(s) URLs are ever stored in link columns (XSS guard in admin).
- A sourced lead with `sourcing_review` pending or rejected is invisible to
  research, ranking queues, and dispatch.
- `does_live`, `promo_track_record`, `content_original` are true or null from
  code. Only a human sets false.
- The worker never runs `lead-ingest` on boot. A restart must not spend money.

## What is built (as of 2026-09-14, all on `main`, 152 tests, 0 type errors)

- **Core:** rank engine (bands 1/2/3/3b/4/5), cadence (cold A: touches at
  4/8/12 days, max 4; warm B: max 12), compliance linter, settings registry,
  niche tiers, roster.
- **Jobs (worker, MySQL `GET_LOCK` scheduler):** `idev-sync` 30m,
  `rank-recompute` 6h, `referral-expiry` 24h, `enrich-personalize` 24h (boot
  run, cap 40, ~$1 per batch), `lead-ingest` 24h (no boot run),
  `customerio-sync` 1h, `metrics-digest` 24h. `outreach-dispatch` and
  `reply-ingest` exist but run only from admin buttons or one-shot runners.
- **Scraping (`packages/scraping`):** resolve → per-platform Apify fetchers
  (TikTok, Instagram, YouTube, Reddit, X, web, link hubs) → Claude summary
  with deterministic URL verification → notes in the format
  `MATCH — <point> (<url>); …`. Discovery layer: five Apify discoverers,
  filters, Jakob's scoring, five-key dedupe. Every post read keeps likes,
  views, comments, and repost flags.
- **Sourcing flow:** Audiences page (admin, ops) → daily or "Run now" →
  Sourced view on Leads (score, reasons, surfaced post, recent posts) →
  Accept (affiliation, SP1–4, niche, brand) or Reject (tombstone).
- **Customer.io (`packages/customerio`):** every lead with an email is
  mirrored as a person with lead attributes, hourly and on accept. Suppressed
  addresses are sent as unsubscribed only. No campaigns are triggered by us.
- **Admin:** Dashboard, Leads (Queue, Sourced, All, Needs triage), Audiences,
  Send messages, Email ops, Replies, Signups, Affiliates, Activity, Team,
  Settings. Plain-language labels live in `apps/admin/src/labels.ts`.
- **Live acceptance so far:** enrichment ran on real leads (6 hand-verified
  with 0 fabricated citations, then a 40-lead boot batch: 20 ready, 14 no
  match, 6 no source). Five DM drafts are queued for approval. **No live
  sourcing run has happened yet.** Raza's rule: the first one runs on the
  server, not locally.

## Not built yet (from MASTER-PLAN v3 in the sibling `affiliate-system-spec`
folder, not in this repo)

Motion B rep workspace, knowledge/gaps UI, store webhook beyond logging, live
iDev signup writes (parked behind probes), affiliate-monitor, payout-guard,
Laravel store patches, scheduled dispatch and reply-ingest, forum discovery,
seed-account mining, removal of signup steps 1b–1d (Jakob asked Raza for
this), Telegram community troubleshooting.

## Decisions Jakob still has to confirm (defaults are live)

| # | Default in code | Where to change |
|---|---|---|
| A1 | Women's Wellness → Anti-aging | `packages/core/src/enums.ts` aliases |
| A2 | Followers: TikTok/Instagram 5K–500K, YouTube 2K–300K, Skool 100–20K, Reddit unbounded | per audience on the Audiences page |
| A3 | Dedupe keys: code, platform handle, email, website URL, name+platform | `packages/scraping/src/dedupe.ts` |
| A4 | Countries US, CA, GB, AU; English | per audience |
| A5 | Skool via community owners; forums later | — |
| A6 | $2 spend cap and 50 leads per audience per run | per audience |
| A7 | Every lead email goes to Customer.io, not only accepted ones | `packages/jobs/src/customerio-sync.ts` |

Matt's competitor list (names, link domains, code prefixes, commission rates)
has not been entered yet. It goes in the Competitors table on the Audiences
page and is what makes tier-one detection work.

## Running it

```bash
pnpm install
pnpm -r test && pnpm -r typecheck
pnpm --filter @biolinx/db apply-sql sql       # idempotent; run after every pull
pnpm dev:api      # :3001
pnpm dev:admin    # :5173
pnpm dev:worker   # all scheduled jobs; enrich runs on boot (real spend)
# one-shots (all spend real credit except dispatch to the approval queue):
pnpm --filter @biolinx/worker run:enrich 5
pnpm --filter @biolinx/worker run:ingest <audienceId>
pnpm --filter @biolinx/worker run:dispatch dm 5
```

Production: `cd /srv/engine && ./infra/deploy.sh` (pull, install, apply SQL,
build admin, PM2 reload). Repo: `github.com/raza935552/bioscraping`. The
older `biolinkxaffilaiteengine` repo is stale.

Settings (Apify token, Anthropic key, iDev keys, Instantly, Customer.io site
ID + track key + app key, Telegram) are entered on the admin Settings page and
stored AES-encrypted with `SETTINGS_KEY` from `.env`. A database dump moved
between machines only decrypts if the destination `.env` has the same
`SETTINGS_KEY`. Section A of `.env.example` lists what must be in the file.

## Gotchas learned the hard way

- `drizzle-kit push` hangs on an interactive rename prompt. Schema changes
  ship as SQL files in `packages/db/sql/` applied by `apply-sql`, which skips
  anything already applied.
- Local MySQL is Laragon 8.4 at `E:/laragon/bin/mysql/mysql-8.4.3-winx64`,
  started with `./bin/mysqld.exe --defaults-file=my.ini --console`. It has no
  `mysql_native_password`, so use the root URL in `.env`.
- Text sent to Anthropic must be cut by code point (`safeSlice`), never by
  UTF-16 index, or an emoji half breaks the JSON.
- Apify actor ids use `~` in the REST path (`clockworks~tiktok-hashtag-scraper`).
- The five-field dedupe set is loaded once per run; anything inserted during
  the run is added to it in memory so one run never inserts a person twice.
- Windows may kill background dev servers under memory pressure; check ports
  3001, 5173, 3306 before assuming anything is down or up.

## Next steps, in order

1. Deploy on the server, load or migrate the database, confirm every key
   shows "set" on Settings.
2. Enter Matt's competitor list. Create one audience (Weight-loss seeker,
   TikTok + Instagram, two terms each, cap 10, spend cap $1). Run it once.
   Review the ten by hand: real post links, null reach where no profile read
   succeeded, no false flags.
3. Accept two, reject one, confirm the accepted ones get researched next day
   and the rejected one never returns.
4. Approve the five queued DM drafts; that is the first live check that
   `next_follow_up_date` is written on send.
5. Schedule `outreach-dispatch` and `reply-ingest` in the worker.
6. Get Jakob's answers on A1–A7 and adjust the audiences.
