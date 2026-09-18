# Bioscraper ⇄ Biolinx partner codes

What the bioscraper (this repo, admin at https://gemboxpk.com) needs from the
Biolinx store so affiliate discount codes stop being typed in by hand. Written
2026-09-18. The signing and error style are copied from the Post Intake API we
already use, so the same middleware works for both.

## Why

A peptide affiliate promotes one thing: their code. We need it for three jobs.

1. **Assets.** The Affiliates page generates what an affiliate posts (bio line,
   story text, caption, YouTube ad break) with their code filled in. Today every
   code is typed in by hand, because iDev's roster API returns only id, email,
   username, name and signup date. 43 real partners, 0 codes on file.
2. **Sign-up.** A new affiliate is asked for a personal code (like `JOHND10`).
   We cannot tell them whether it is free, and we cannot create it. A person
   does both in two admin panels, which is where sign-ups stall.
3. **Who actually sells.** Orders per code tell us which affiliates are worth
   more assets, more attention and better terms. iDev has commissions, the store
   has the orders.

Endpoint 1 alone removes the manual step for all 43 affiliates. Endpoints 2 and
3 make sign-up automatic. Endpoint 4 is the one we want next, not now.

## Authentication (same as the content API)

Every request from us carries:

- `X-Biolinx-Timestamp`: unix seconds
- `X-Biolinx-Signature`: `HMAC_SHA256(secret, "<timestamp>.<raw body>")`, hex

For GET requests the signed string is `"<timestamp>."` plus the path with its
query, exactly as sent, e.g. `1758124800./api/partners/codes?per_page=100`.
Reject anything more than 5 minutes old, and compare in constant time. Use a
**separate secret** from the content library one, so either can be rotated on
its own. We store it encrypted in Settings.

Errors: HTTP status plus `{ "error": { "code": "...", "message": "..." } }`.
`401` bad signature, `404` unknown code, `409` code already taken, `422`
validation, `429` rate limited with `Retry-After`.

Base URL: `https://biolinxlabs.com`. All paths below are under `/api`. Times are
ISO 8601 in UTC. We call at most once every 30 minutes for listings, and once
per sign-up for the rest.

## 1. List codes (needed first)

```
GET /api/partners/codes?updated_since=2026-09-01T00:00:00Z&page=1&per_page=100
```

```json
{
  "data": [
    {
      "code": "MINDY10",
      "status": "active",
      "discount_pct": 10,
      "owner": {
        "first_name": "Mindy",
        "last_name": "Kaur",
        "email": "mindy@example.com",
        "idev_affiliate_id": 118
      },
      "created_at": "2026-08-14T10:02:00Z",
      "updated_at": "2026-09-02T18:40:00Z"
    }
  ],
  "page": 1,
  "per_page": 100,
  "total": 47
}
```

- `status`: `active` or `disabled`.
- `owner.email` is what we match on, so please send it even when the code was
  created by hand in the admin. `idev_affiliate_id` is better still; send both
  when you have them.
- `updated_since` is optional; without it, return everything.

This is the one that unblocks us today. Everything else can follow later.

## 2. Is this code free?

```
GET /api/partners/codes/check?code=JOHND10
```

```json
{ "code": "JOHND10", "available": false, "reason": "taken", "suggestions": ["JOHND15", "JOHNDX10"] }
```

`reason` is `taken`, `reserved` (a word you don't allow) or `invalid` (wrong
shape). `suggestions` is optional and we will use it if it is there. We call
this while the affiliate is still in the conversation, so it needs to answer in
under a second.

## 3. Create a code

```
POST /api/partners/codes
X-Idempotency-Key: signup-412
```

```json
{
  "code": "JOHND10",
  "discount_pct": 10,
  "owner": {
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "idev_affiliate_id": 124
  }
}
```

Returns `201` with the same shape as a row in endpoint 1. Rules:

- **Idempotent.** The same `X-Idempotency-Key` returns the first result, never a
  second code. We retry on timeouts.
- `409` when the code is taken, with `suggestions` if you have them.
- Case: we send upper case; store and compare case-insensitively.
- The discount is the one the program uses (10% today). If you want that fixed
  on your side, ignore `discount_pct` and tell us what it is.
- No expiry. These are lifetime partner codes.

We assign the code in iDev ourselves (`assign_coupon_code.php`), so you do not
need to touch iDev.

## 4. What a code has sold (wanted, not urgent)

```
GET /api/partners/codes/MINDY10/stats?from=2026-08-01&to=2026-08-31
```

```json
{
  "code": "MINDY10",
  "orders": 14,
  "revenue_usd": 1284.50,
  "new_customers": 11,
  "first_order_at": "2026-08-03T14:22:00Z",
  "last_order_at": "2026-08-29T09:10:00Z"
}
```

Monthly totals per code are enough. This is what tells us which affiliates to
invest in, and it is the only place the number exists.

## 5. Disable a code (optional)

```
POST /api/partners/codes/MINDY10/disable
```

For when someone leaves the program. We will not call it without a human
pressing a button.

## 6. Tell us when something changes (optional)

If it is easy on your side, post to
`https://gemboxpk.com/webhooks/biolinx/partner`, signed exactly like the content
callbacks, on `code.created`, `code.updated` and `code.disabled`, with the row
from endpoint 1 as `code`. Without it we poll endpoint 1 every 30 minutes, which
is fine.

## What we do with it

- **On our side, once endpoint 1 exists:** every affiliate's assets fill
  themselves in, and a code that changes in the store follows within 30 minutes.
- **Once 2 and 3 exist:** the sign-up flow checks the code the affiliate asked
  for while we are still talking to them, creates it, assigns it in iDev, and
  the welcome email goes out with a code that works. Today that is three manual
  steps in two systems.
- **Once 4 exists:** the dashboard can show sales per affiliate, which is what
  decides who gets more of our time.

## Test checklist

1. A signed `GET /api/partners/codes?per_page=1` returns one row.
2. The same request with a wrong secret returns `401`.
3. A request with a timestamp 10 minutes old returns `401`.
4. `POST /api/partners/codes` twice with the same `X-Idempotency-Key` creates one
   code and returns the same body both times.
5. Creating a code that exists returns `409`, and the existing code is untouched.
