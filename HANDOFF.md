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

---

# PART 2 — Jakob's 5K Scrape canvas (as received 2026-09-14, lightly formatted)

**Definition of finished:** a file Raza can use to scrape 5K converting leads.

**References:** Matt → competitor affiliates. Hormozi → a great market has massive pain, purchasing power, is easy to target, growing, and is a niche (a community within a market).

**What defines the best affiliate:** a competitor affiliate: signed with a competitor, getting less than 25%, not recurring.

**Platforms with the best affiliates, in order:** TikTok (LIVE works like a webinar), YouTube (long copy beats short), Skool (hack smith etc.), Reddit (Professor Peptides should be joining and participating), forums, Instagram (like TikTok but more restrictions).

**Niche priority (highest conversion probability first):**
- Tier 1: weight-loss seeker (ICP for Aro, plus BiolinX) and biohacker (BiolinX only)
- Tier 2: gym / PED-curious (BiolinX only)
- Tier 3: anti-aging (BiolinX only)
- Tier 4: sexual wellness (BiolinX only)

**Scoring criteria:** competitor affiliate vs individual creator; their commission vs our 25% + lifetime (lower = easy pitch, same or higher = counter-offer angle); reach verified only, never estimated; activity in the last 30 days vs dormant (dormant deprioritized); LIVE status checked per account, never guessed; promo track record (has run one before or not); content original vs reposts.

**Hard rules (not set in stone):** dedupe on 5 fields, code match is the strongest signal; "where found" is a real post link or blank; spend cap $2 per run on metered checks; first contact never automated, this only finds and scores, a human sends the first message.

**Jargon:** market = group of people with a shared problem (health, wealth, relationships); niche = a specific slice (women in menopause dismissed by their doctor; dentists opening a second location; divorced men over 40 re-entering dating). Affiliate A = the recruiting affiliate; affiliate B = the recruited one; audience = the affiliate's community (the leads).

**Dream outcome:** the affiliate is promoting AND getting sales, consistently. Track per niche (weight-loss seeker, gym/PED-curious, anti-aging, sexual wellness), per platform (TikTok, YouTube, Skool, Reddit, Instagram), per brand (BiolinX, Aro, Nutra). Best templates per niche: outreach angle (win = highest "tell me more" rate), reply (win = highest "yes" rate), yes (win = easiest process), interested (win = assets that lead to yes), no (win = yes to Aro program, Nutra program, or joining the Telegram / Professor Peptide community).

**What the affiliate needs:** an irresistible offer; it must be stupid easy to understand the program, sign up, promote, and track progress. Foundation: sales lander (goal: click CTA), sign-up page (goal: fast), onboarding flow (goal: easy promotion), bonus assets. Systems: swipe file of winning posts, templates for outreach/reply/check-in, activation sequence with failure rule, 30-day posting calendar, affiliate performance dashboard.

**Offers:** Hero: 25% of any audience purchase, lifetime (audience buys $220 → affiliate gets $55, again next month). Affiliate-to-affiliate: 5% of audience B's order (not commission), lifetime (B gets $55, A gets $11, again next month). Bonuses: free compliance hub, free promotional assets (custom available), free Telegram community, product at COGS. Downsell: Aro program, Nutra program, BiolinX Telegram community. Payout monthly via cash or Zelle; cookie lifetime; done-for-you assets; optional video chat.

**Journey:** Step 0 acquisition (manual outreach: Diana + Hamilton; automated: Jakob + Raza; recruitment via team, friends and family, affiliates; ads only once the program is cooking). Step 1 sign up: keep first name, last name, email, phone (optional), "referred by"; REMOVE the "what is your world / links / audience" step, the "how will you promote / plan / why BiolinX / experience / preferred code / photo" step, and the "how did you hear / terms" step (assigned to Raza). Step 2 onboarding in Customer.io (welcome, toolkit, W-2, directory). Step 3 support: compliance hub (5 rules; what you can and can't say; 50 compliant content ideas; what you can show; where to put #ad; prompts and templates per platform) and Telegram "biolinx affiliate hub" (@biolinx_bot; Home, Pass or Flag quiz with $25 credit draws and a 200-point Bio Badge, The Biolinx Games monthly top-3 prizes $150/$75/$50, Bio-Lounge points to store credit, Got Questions FAQ + AI answers).

**Open to-dos from the canvas:** community QA of Telegram (Josh + Jakob, Raza troubleshoots); remove sign-up steps 1b–1d (Raza); templates for outreach / replies / check-ins per offer-vs-competitor case (below, equal, above 25%); yes/no/downsell flows; BFCM incentive (Josh); track Josh's methods; make outreach sound human; turn Matt's templates into outreach; quick-pitch PDF or link (offer, catalogue, community, sign-up with referred-by) and an SOP for it.

**Goal from the plan section:** 300 affiliates across BiolinX, Aro, (later) Nutra. Principles: build relationships, follow up all the time, track everything.

---

# PART 3 — Key sections of the MASTER-PLAN v3 (the plan of record, lives outside this repo)

### 1.1 The business
- **BiolinX Labs** (biolinxlabs.com): US research-peptide e-commerce ("research use
  only" / RUO — regulated category). Products $19.93–$329.09. GLP-1 analogs sold
  under **code names**: G1-S (semaglutide), G2-T (tirzepatide), G3-R (retatrutide).
- Stack: **custom Laravel 12** storefront (NOT Shopify) → **Sticky.io** CRM
  processes all orders/payments (dual-write: local MySQL mirror keyed by
  `sticky_order_id`). Payments compliance gatekeeper: **AuxPay** (strict
  banned-word rules). Cloudflare in front. Email: Resend (transactional) +
  Klaviyo or Customer.io (one active, DB-toggled).
- **Affiliate platform of record: iDevAffiliate**, hosted at
  `https://biolinxlabs.idevaffiliate.com`. Confirmed live in code (commits through
  2026-04-15; server-side conversion postback, REST roster API, coupon
  assignment). ⚠️ BUT the public /pages/affiliate-program advertises an in-house
  "one click from your account" flow the Laravel code cannot serve (no affiliate
  tables) — the onboarding surface is a **Phase-0 hypothesis to verify with a
  live test signup**, not a premise.

### 1.2 Program economics (FACTS canon)
| Fact | Value |
|---|---|
| Commission | 25% first order + 25% every reorder, for life; no tiers; retroactive |
| Customer discount | 10% via personal coupon (e.g. `JASON10`); code number = discount, never commission. ⚠️ Whether discounts still apply at checkout post-2026-07-30 rebuild is UNVERIFIED (may live in Sticky.io, not iDev) — Phase 0 test |
| Cookie | Lifetime (server-side customer↔affiliate binding claimed) |
| Referral override | 5% cash of recruit's sales, 12 months, one level. **iDev is set to `20` (= 20% of the 25% commission = 5% of sale). NEVER "fix" 20→5 — that pays 1.25%.** |
| 12-month expiry | **NOT enforceable in iDev** — currently lifetime. Must be built, incl. backfill for recruits already past 12 months |
| Payout | Monthly, Zelle or ACH ("ePayment"), no minimum, 30-day hold, W-9 + payout-auth form gate |
| Age | 21+ hard rule (Matt 2026-07-29), no exceptions — today a HUMAN gate (see D12) |
| Restricted | Affiliates may NOT promote/name/link GLP-1/GIP products (the flagship items) — affiliate-terms §6 (see D11) |
| Stats | EPC $12.04 (old 10% program — historical, rate retired; see linter rule L7), 26.5% repeat rate, $342.20 LTV, 24-day reorder cycle |
| Goal | 100 Partners in 100 days, internal deadline 2026-10-31; BF 27 days later. Was 19 (9 internal + 10 external) at spec time |

### 1.4 The client's operating mindset (rebuild-preserving invariants)
1. **Never guess** — blank is a sentinel (blank Total Reach = unverified).
2. **Fail loud, never silently stale.**
3. **Compliance as architecture** — code names, no claims, RUO line, SP5
   log-and-leave, per-venue rules, 21+, pre-approved creative only.
4. **Human judgment gates outbound** — the spec's one explicit hard boundary
   ("Don't automate the send step" — DMs AND emails). The rebuild redefines this
   gate rather than silently deleting it: see D2. Fully-unattended sending is a
   **client-signed decision**, never a default.
5. **Replies over volume** — quotas double as rate limits.
6. **Log immediately** — Contact Channel drives tomorrow's reply check.
7. **Fresh-read sources of truth** — trivially satisfied once MySQL is the only
   store.

---

## 3. DECISIONS

Locked: D1, D3, D4, D6, D7, D8, D10, D13.
⚠️ Client sign-off required: D2 (send modes), D5 (email infra spend), D9
(metric), D11 (GLP-1 sourcing), D12 (21+ mechanism), D14 (team migration date).

| # | Decision | Resolution |
|---|---|---|
| D1 | Runtime & storage | **Node.js 22 + TypeScript; MySQL 8** (owner's choice; matches store stack and user expertise). No Docker, no Redis: PM2-managed Node processes; jobs scheduled in-process under MySQL named locks (GET_LOCK) — overlap-safe, one moving part fewer. |
| D2 | Send modes | **Every channel ships with an approval queue; unattended sending is a per-channel, client-signed config change.** (a) **Email**: drafts land in the admin approval queue (batch-approve); after client sign-off, flips to full-auto with the L-rules (§4.4) as the machine gate. (b) **Social DMs**: approve → operator gets deep link + ready-to-paste text, sends from the real account, taps "sent" (~15–20 min/day at 10 DMs — the hours of research/drafting/logging are what's automated). Robot-sending DMs is NOT built in v1 (interface stub only); building it needs signed risk acceptance — platforms fingerprint automated sends AND reads; one ban kills a shared @biolinx account. (c) Social **inbox reads**: default = operator confirms replies in the same UI (machine-sequenced, 30 s/lead); session-based polling is opt-in + flagged risk. |
| D3 | Affiliate platform | **Keep iDevAffiliate**, isolated behind an `AffiliatePlatform` interface. Revisit in-house post-BF. |
| D4 | CRM topology | **Own system. MySQL 8 is the ONLY store; a full admin panel is the human surface.** Airtable dropped (owner decision 2026-09-01) — one-time migration per §2.3. Benefits: no sync engine, no rate limits, no silent-blank attribution, real roles/auth, pre-send gates read live truth by construction. Cost: one-time migration + team change management (D14). |
| D5 | Email infrastructure | **Instantly** (owner already has an account; API key verified 2026-09-01) — sending, warmup, unsubscribe handling, reply webhooks via its API. **New cousin domain** (e.g. `biolinxpartners.com`) bought **week 0** — fastest path is buying domain + 2–3 inboxes inside Instantly (it auto-configures SPF/DKIM/DMARC + warmup). Never a biolinxlabs.com subdomain for sending. Sender identity: BiolinX legal entity, truthful. |
| D6 | Timezone | Canonical **America/Los_Angeles** for business dates; storage UTC; date-math test suite. |
| D7 | Payout method at signup | Don't collect (PROMPTS Rule 1; Diana's welcome email settles it). |
| D8 | Status enums | Adopt live form enums (Reached out/Replied/Interested/Not now/No/Signed up); map "Said no"→"No". |
| D9 | Goal metric | Dashboard shows external-only vs 100 by 11-27 AND total vs 10-31 — plus §7 funnel math. |
| D10 | LLM | Claude API (sonnet default, haiku for classification). LLM drafts; deterministic code decides. LLM failure → skip + queue, never guess. |
| D11 | GLP-1 sourcing contradiction | Recruits courted from GLP-1 audiences are contractually banned from promoting GLP-1 SKUs (affiliate-terms §6). v1: templates + welcome email disclose the restricted catalog before signup; lead scoring penalizes GLP-1-only creators; signup requires restricted-SKU acknowledgment. Client may instead sign off on courting that audience knowingly — documented either way. |
| D12 | 21+ gate | Stays **human** in v1: every signup holds in `Pending Diana`; the 10-field contract unchanged. Probe iDev under-21 controls in Phase 0. |
| D13 | Motion B disposition | **Replaced by the rep workspace inside our admin panel** (§4.5): five-shapes intake, drafting, FACTS answers, logging, follow-up queues — reps get invited accounts (mobile-friendly). Telegram keeps alerts/digest + optional quick actions. Until cutover the claude.ai assistant + Airtable keep running unchanged. |
| D14 | Team migration | One cutover date, client-owned: Airtable frozen → export/import → team switches to the admin panel the same day (reps: a 10-minute walkthrough; their workflow gets EASIER — no memorized prompt, no form links). ⚠️ client picks the date; we provide rollback (Airtable re-opened) if week one fails. |

---

### 4.2 Jobs (worker) — every job runs under a MySQL named lock (GET_LOCK), so
runs never overlap in-process or across processes; an overrun logs loudly.
Crash-recovery contract: every outbound action claims its row transactionally
(idempotency key) before side effects.

| Job | Cadence | Behavior |
|---|---|---|
| `idev-sync` | every 30 min | Roster → classify internal/external (config list) → `program_status` + `affiliates` in MySQL (admin shows it live). Count semantics per §1.3 (range until confirmed). **Roster-vs-signups diff**: newly approved affiliate absent from `signups` → same-day attribution-triage alert. Failure: write nothing, alert, Last Synced untouched. |
| `rank-recompute` | on trigger-field change (now just a DB event — no external sync needed) + nightly | Ordinals in MySQL. Band 5 for uncovered records (blank status / Signed-no-tier) + triage flag. SP5 ranked but hard-excluded from queues. Serialized with dispatch; dispatch reads a rank snapshot. |
| `lead-ingest` | daily | Verifiable-only sourcing via Apify (resolving profile + observed promo URL; reach only from platform reads). Records email **provenance** (published-business vs scraped) and **geo**. Dedup vs board AND Motion B pipeline (identity keys) — a rep's active warm contact is never cold-touched. GLP-1-only creators: scoring penalty (D11). |
| `enrich-personalize` | on ingest + pre-first-touch | 2–3 genuine talking points + source URLs; failure → `needs-enrichment`, never invented. Health probes; stale scraper → channel suspended + alert + runbook. |
| `outreach-dispatch` | weekdays, business hours, jittered | Runs **after** that channel's reply pass. Final gate: live re-read of lead status/SP (MySQL — trivially fresh). Cold-email cadence: **max 3–4 silent touches** (12-touch table is Motion B's, warm only). Email: L-rules → approval queue (or auto post-sign-off) → send via D5 infra → MySQL write atomic with dispatch. DM: approval → deep link + paste text → operator "sent" confirm → log. Automated email only to US leads with published-business addresses; else human queue. |
| `follow-up-scheduler` | daily, post-reply-pass | Per-motion/per-channel state machines. Touch blocked while unprocessed inbound exists. Replied/question/not-now ⇒ paused until objection engine or human resolves. Suppressed ⇒ terminal (blocks channel-switch too). |
| `reply-ingest` | email: webhook, instant; social: operator-confirm flow (polling opt-in) | Classify: interested / not now / no+reason / question / **opt-out** / signed up. Opt-out → `suppressions` immediately. Objection engine: one clarifying reply before branch; logs Objection Reason + Escalation Action. Escalation router: money→Diana, product→support@, agency/vendor→Jakob, under-21→refuse+log. Unclassifiable → human queue. Unanswerable program question → **gap row + "logged it" reply** (§4.5). |
| `signup-provision` | on signup row | **Saga w/ per-step checkpoints + compensation**: validate (10 fields, roster user match — hard error) → dedupe (unique email) → iDev affiliate create/verify (probe-gated; else admin-assisted task) → coupon uniqueness check vs store+iDev → create (store+Sticky) → assign in iDev (params per probe) → welcome email (discloses restricted catalog) → W-9/payout-auth flags. Partial failure compensates (disable orphan coupon). Holds in `Pending Diana` until her confirm (D12). |
| `referral-expiry` | daily | Needs recruiter-tree + signup-date reads (Phase 0 probe; fallback iDev admin export). First run emits **backfill list** of already-expired recruits. Report + action list; automated iDev writes only if probes prove safe. Never touches the `20` setting. |
| `order-signal` | store webhooks | Orders + refund/void/chargeback transitions. Thank-you-skipped orders: automated sale.php re-fire **only with a coupon code** (deterministic attribution); couponless → human flag (server-side re-fire loses session+IP context). |
| `affiliate-monitor` | weekly | FTC 16 CFR 255: scan signed affiliates' known handles/links for drug names, health claims, missing #ad → enforcement queue. |
| `payout-guard` | monthly, pre-payout | Diana's report: iDev payable list vs W-9/payout-auth flags + **commissions-at-risk** (refund/chargeback inside the 30-day hold) to reverse before paying. |
| `metrics-digest` | daily 08:00 | Telegram + admin dashboard: external count (range) vs 100, days to 11-27, replies-not-sends, funnel vs §7, queue depths, scraper/ESP health. |

### 4.3 Automated vs human (honest accounting)
Automated 100%: sourcing, verification, enrichment, ranking, scheduling,
drafting, linting, logging, syncs, reconciliation, reporting, provisioning
mechanics, expiry tracking, all data plumbing. Human (minutes/day,
machine-prompted in the admin panel): DM send-confirms + reply confirms
(~15–20 min), email batch-approve (until sign-off flips it), Diana's signup
confirm + money actions, Jakob's weekly Gaps answers, triage queues. Going past
this ceiling (unattended email, robot DMs) is pre-designed as config, gated on
the client signing the risk.

## 7. FUNNEL MATH — CAN 100 BY 11-27 ACTUALLY HAPPEN?

Start ~10 external (spec time). Need ~90 in 12 weeks; outreach engine live
~week 5 (early October), email at full warmup ~mid-October.

- Cold email (post-warmup): ~40–60/day across inboxes × ~5–6 wk × 1–3%
  cold→signed ⇒ **~15–45**.
- Cold DM (10/day human-confirmed × ~6 wk × 2–4%) ⇒ **~8–15**.
- **Motion B warm network** (the spec's own engine: 14 reps × 5 asks ≈ 70 warm
  asks at 10–20% + customers + groups + dormant reactivations) ⇒ **~15–30** —
  if the reps actually work it; the rep workspace lowers friction, it doesn't
  replace relationships.
- Realistic band: **~40–90 new external by 11-27**. The 10-31 "100 Partners"
  deadline is arithmetically out of reach from a 2026-09-01 start.

Levers for the top of the band or beyond: multiple warmed domains/inboxes
(start week 0), all 14 reps activated hard on Motion B, more operator time on
DM confirms, paid creator placements (outside this system). **This math goes in
front of the client in week 0.**

---

