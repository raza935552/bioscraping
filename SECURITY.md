# Security posture

How the engine protects credentials, sessions, and its endpoints.

## Secrets

- **Never in git.** `.env`, `migration/out/` (contains PII), and all logs are
  gitignored. The repo was scanned for hard-coded keys before the first commit.
- **Two env-only secrets** live in the server's `.env` (chmod 600):
  `APP_SECRET` (session signing) and `SETTINGS_KEY` (settings encryption).
- **Every third-party API key** is entered in the admin Settings page and stored
  **AES-256-GCM encrypted** in the DB. Ciphertext is `gcm:iv:tag:data`; the auth
  tag makes tampering fail closed. Secrets are **never returned to the browser** —
  the UI only sees "set / not set".
- **Log redaction:** the request logger strips `authorization`, `cookie`, and
  the webhook-secret headers; iDev URLs with query-string secrets are redacted
  before logging.

## Authentication & sessions

- **Invite-only.** No open registration. An admin invites by email; the invite
  is a single-use token; the person sets their own password.
- **Passwords:** scrypt (N=16384) with a per-user random salt.
- **Sessions:** HMAC-SHA256-signed tokens in an httpOnly, SameSite=Lax cookie
  (Secure in production). Logout bumps a per-user `session_epoch`, which
  **revokes every outstanding token immediately** — not just clears the cookie.
- **Login timing:** a dummy scrypt runs on unknown emails so response time
  doesn't reveal whether an account exists. Login is rate-limited (10/min/IP).

## Authorization

- Four roles: `admin`, `ops`, `rep`, `operator`. Every mutating route is
  role-gated; Settings and Team are admin-only.
- Every human action and job run is written to `audit_log` with the actor.

## Transport & network

- **Caddy** terminates TLS (auto Let's Encrypt) and proxies to the API on
  localhost. **CORS** is locked to `ADMIN_ORIGIN`. **Helmet** sets security
  headers. `trustProxy` is on (behind Caddy/Cloudflare).
- **MySQL** binds to localhost only; port 3306 is never exposed. UFW allows
  only SSH + 80/443.

## Webhooks (fail closed)

- `/webhooks/store` and `/webhooks/instantly` **refuse (503) when their secret
  is unset**, and verify it with `timingSafeEqual`. No secret ⇒ no processing —
  the opposite of accept-all.

## Compliance guardrails (outbound safety)

- Every outbound message passes the deterministic L-rules linter (drug names,
  claims, restricted SKUs, CAN-SPAM, em dashes) with input normalization that
  defeats homoglyph/leetspeak/spacing evasion. A violation blocks the send.
- Opt-outs hit a suppression list checked before every email. Attribution is a
  foreign key, never a matched string. SP5 leads never enter an outreach queue.

## Rotation

- `SETTINGS_KEY` rotation: re-enter secrets in the Settings page after changing
  it (old ciphertext won't decrypt — by design).
- `APP_SECRET` rotation: logs everyone out (sessions re-issue on next login).
- Any third-party key: rotate at the provider, paste the new value in Settings.
