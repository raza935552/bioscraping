# BiolinX Affiliate Engine

Automated affiliate recruiting system for biolinxlabs.com. The plan of record is
`../affiliate-system-spec/MASTER-PLAN.md` (v3); the access checklist is
`../affiliate-system-spec/PHASE0-CHECKLIST.md`.

Node 22 + TypeScript · MySQL 8 (system of record) · no Docker, no Redis —
scheduled jobs run under MySQL named locks, PM2 in production · Fastify API ·
React admin · iDevAffiliate kept as the affiliate platform · Instantly for
cold email (client has an account).

## Status — Phase 1 scaffold

Built and tested with no external credentials:

| Piece | State |
|---|---|
| `packages/core` | Conversion Rank engine (bands 1/2/3/3b/4 + triage band 5, reach-per-person + niche tiebreakers) and per-motion follow-up cadence state machines — **unit-tested** |
| `packages/compliance` | Deterministic L-rules linter (drug names → G1-S/G2-T/G3-R, claim phrases, template contract, restricted SKUs, RUO line, CAN-SPAM mechanics, earnings-claims rule) — **unit-tested** |
| `packages/idev` | JWT recipe (HS512, matches the store's CouponController), roster client, probe-gated coupon assignment, `pnpm probe:idev` read-only probe — **JWT unit-tested** |
| `packages/db` | Full Drizzle schema: users/leads (34-field model)/messages/replies/suppressions/outreach_log/signups (saga)/affiliates/program_status/orders/sync_runs/gaps/knowledge_versions/config/audit_log |
| `apps/worker` | MySQL-locked scheduler + the real `idev-sync` job (fail-loud, external-only count, unresolved verbatim, roster-vs-signups attribution alert) |
| `apps/api` | Fastify skeleton: /health + HMAC store-webhook receiver (hard-fails without secret) |
| `apps/admin` | React shell (Phase 1 build order in `src/App.tsx`) |
| `migration/` | Airtable full export script (both bases + metadata/enums) |

Blocked on Phase 0 (see checklist): iDev credentials, Airtable token, domain
purchase + ESP choice, Telegram bot, Apify account, old-machine files.

## Run

```bash
pnpm install
pnpm test                      # core + compliance + idev unit tests
# Local MySQL: Laragon's works as-is — create schema `biolinx_engine`,
# set DATABASE_URL in .env (e.g. mysql://root:@localhost:3306/biolinx_engine)
pnpm --filter @biolinx/db push # create tables
pnpm dev:api                   # :3001
pnpm dev:worker                # schedules idev-sync (needs iDev creds)
pnpm dev:admin                 # :5173
```

Production (no Docker): see `infra/SERVER-SETUP.md` — Ubuntu VPS, native
MySQL 8, PM2 (`infra/ecosystem.config.cjs`), Caddy serving
`engine.biolinxlabs.com` with automatic TLS.

## Invariants (never violate — enforced in code)

- SP5 leads never enter an outreach queue. Blank Total Reach is never defaulted.
- Program Status never holds the raw affiliate total; nothing is written on a
  failed sync (staleness stays visible).
- The iDev referral tier setting `20` is never changed (20 = 5% of sale).
- Every outbound string passes the L-rules linter; suppressed emails are never
  sent; attribution is a foreign key, never a matched string.
- Secrets live in env only; PII lives in MySQL only (never logs, never the repo).
