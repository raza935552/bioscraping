# Dedicated Recruiting Email Setup — biolinxlabsaffiliates.co

Goal: 2–3 warmed inboxes on `biolinxlabsaffiliates.co`, isolated from the
product-selling fleet, attached to the recruiting campaign
(`8169958c-6731-4c45-b5d1-4c07499586b0`). Warmup takes ~2–3 weeks before real
cold sends — that ramp cannot be skipped.

## What YOU do after purchase (registrar + Google/Instantly)

**1. Create 3 mailboxes on the domain.** Two options:
- **Google Workspace** (~$7/inbox/mo) — add the domain, create 3 users, e.g.
  `partners@`, `hello@`, `team@biolinxlabsaffiliates.co`. Real, natural names.
- **OR Instantly done-for-you inboxes** — Instantly → Accounts → Add → "Buy
  domains & inboxes." If your Hyper Growth plan includes it, Instantly handles
  the mailboxes + DNS + warmup automatically. Simplest path — check first.

**2. DNS records** at the registrar (skip if Instantly DFY did it):
- **MX** → your mail provider (Google: `aspmx.l.google.com`, etc.)
- **SPF** (TXT): `v=spf1 include:_spf.google.com ~all`
- **DKIM** (TXT): the key Google Workspace generates for you (Admin → Apps →
  Gmail → Authenticate email)
- **DMARC** (TXT `_dmarc`): `v=DMARC1; p=none; rua=mailto:dmarc@biolinxlabsaffiliates.co`
- **Custom tracking domain** (CNAME, e.g. `track`) pointed at Instantly's
  tracking host — Instantly shows the exact target when you add the domain.

**3. Connect the 3 inboxes to Instantly** — Accounts → Add → Google/Microsoft
OAuth (or IMAP/SMTP). One entry per inbox.

**4. Turn on warmup** for each inbox in Instantly. Leave it running ~2–3 weeks.
Instantly ramps volume automatically; don't send real cold email before it's
warm or the domain gets flagged immediately.

## What I do (engine side, once inboxes are connected + warmed)

- Attach the 3 inboxes to the recruiting campaign (Instantly API).
- Set a conservative daily cap (start ~10–20/day/inbox, ramp with reputation).
- Activate the campaign.
- Run dispatch: the engine drafts + compliance-lints each email and pushes the
  personalized ones as leads into the campaign; Instantly sends on the
  business-hours schedule.
- CAN-SPAM footer is already handled: `insert_unsubscribe_header=true` on the
  campaign injects the unsubscribe + your workspace physical address (same as
  the BX/PP campaigns).

## The one thing I need from you to move the engine side

Once the inboxes exist and warmup is running, tell me the 3 inbox addresses
(or just "they're connected"), and I attach + configure + activate. Until then
there is nothing for me to wire — warmup is the gate.

## Meanwhile

Run the **DM channel now** — most of the 412 leads are social-only (no email
anyway), drafts are already in the Approvals queue, and it needs none of this.
That's the real first channel while email warms.
