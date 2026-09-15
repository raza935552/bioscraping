# Bioscraper ⇄ Biolinx content library

How the bioscraper (this repo, admin at https://gemboxpk.com) sends swipe-file
posts to the Biolinx affiliate content library, and what we need from the
Biolinx side. Written 2026-09-15 against the "Biolinx Post Intake API" doc.

## How the bioscraper uses the API

1. **Picks winning posts.** From creators it has already read, it takes posts
   with at least 2× that creator's average views, 20K+ views, posted in the
   last 120 days, in English, on-niche, never used before. They are
   inspiration only; nothing is copied.
2. **Writes original posts.** Claude writes three variants per source post
   (hook, caption with `{CODE}` once, hashtags, hook type, angle, the words
   for the image, and an image brief). Every variant is checked against
   Biolinx's text rules (claim words with stems, GLP names, @handles, outside
   websites, `{CODE}` count, lengths) and our own compliance linter. The best
   passing variant becomes a draft; if none pass, the writer repairs once with
   the exact reasons.
3. **A person decides.** Biolinx checks compliance, not quality, so the quality
   call is made in our admin (Swipe file page) before anything is sent. Biolinx
   then saves each accepted post as a draft, and it reaches affiliates only when
   someone presses Publish on Biolinx's Assets tab:
   - **Approve** — queued for sending. Needs an image and a clean check.
   - **Decline** — the reviewer is asked "What more do you need?", and a new
     version is written from those notes (same source post, version + 1). The
     declined version is kept with the feedback.
   - **Edit** — hook, caption, hashtags, image words, image link; rechecked.
4. **Sends** approved posts with `POST /api/content/assets`, max 25 per
   request, stopping when `remaining_today` hits 0. Automatic every 10 minutes
   when enabled in Settings, or with "Send approved now". Every external_id is
   new per version (`bs-YYYYMMDD-xxxxxxxx`), so a regenerated post is never a
   duplicate of the declined one.
5. **Receives callbacks** at `POST https://gemboxpk.com/webhooks/biolinx/content`.
   The signature is verified over the exact raw bytes with the 5-minute window.
   `post.ready`, `post.failed`, `post.published` and `post.retired` update the
   post's Biolinx status, media link, image check and issues. Unknown ids get a
   2xx so Biolinx doesn't retry them.
6. **Backup lookup.** Posts still `processing` or `in_review` 10 minutes after
   sending are checked with `GET /api/content/assets/{external_id}`.
7. **Connection test** (admin): a signed GET for an id that can't exist. 404
   means the secret works; 401 means a wrong secret; 503 means receiving is off.

Niche mapping we send: Weight-loss seeker → `metabolic`, Biohacker →
`research`, Gym / PED-curious → `fitness`, Anti-aging → `longevity`, Sexual
wellness → `wellness`. Formats: TikTok → `portrait`, YouTube → `thumbnail`,
Instagram → `square`.

**The image step is not decided yet.** Drafts carry the image words and an
image brief; until an image generator is chosen, a person can paste an https
image link. Images will follow the visual rules below either way.

## Setup on the Biolinx side

1. Biolinx admin → Affiliate content library → Settings → Bioscraper connection.
2. Callback URL: `https://gemboxpk.com/webhooks/biolinx/content`
3. Copy the secret into the bioscraper admin → Settings → "Biolinx content
   library (swipe file)". Rotate there and paste the new one here.
4. Turn receiving on. The daily limit (50) can stay while we test.

## Requests for the Biolinx developer

Posts now arrive as drafts and need Publish on the Assets tab, which is the
right safety net. Biolinx's automatic checks still look only at text, so these
help whoever presses Publish. In priority order:

1. **Visual policy check (safety).** Have Gemini look at the image itself, not
   only its text, and hold or reject: needles or syringes, pills, people using
   or holding products to the body, bodies or before/after shots, other
   brands' logos, and vials that aren't Biolinx. Today these pass if they have
   no readable words.
2. **Shape check.** Reject or hold when the real image proportions don't match
   `format` (square 1:1, portrait 9:16, thumbnail 16:9).
3. **Telegram note for every new draft**, with a link to publish or discard it,
   so posts don't sit unreviewed.
4. **Retire endpoint for us:** `POST /api/content/assets/{external_id}/retire`
   (signed). Our reviewers need to pull a published post from our admin
   without logging into Biolinx. Send `post.retired` as usual.
5. **Real brand images.** An endpoint for approved Biolinx vial and packaging
   photos (for example `GET /api/content/brand-assets`, signed) so our images
   are built from real Biolinx vials, the way your own generator does. This is
   the best protection against wrong or GLP vial labels.
6. **Validate without saving:** `POST /api/content/assets/validate` taking the
   same body and returning the same per-post `reasons`, without storing,
   counting toward the daily limit, or publishing. Lets us test copy safely.
7. **Rules endpoint:** `GET /api/content/rules` returning the claim words and
   how they're matched (whole word, stem, or substring), GLP names, allowed
   niches, platforms and formats, limits, and the exact research-use line. Our
   pre-check mirrors the doc today and would drift silently otherwise.
8. **Performance data back.** Copies and downloads per post over time, and if
   possible clicks and orders on each affiliate's code from that post (a daily
   `post.stats` callback or `GET /api/content/assets?updated_since=`). This is
   how the bioscraper learns which hooks and angles actually sell.
9. **A test mode.** A header such as `X-Biolinx-Test: 1` (or a second secret)
   that runs every check and sends callbacks but never publishes or shows the
   post to affiliates.

## Questions to confirm

- Our captions already end with our research-use line: "All Biolinx products
  are sold for laboratory and research use only. Not for human consumption."
  and `#ad`. Does that count as present, or will Biolinx append its own too?
- Claim-word matching: does "result" or "treatment" count as "results" or
  "treat"? We block stems to be safe.
- Is `https://gemboxpk.com/...` fine as an `image_url` host (valid certificate,
  no redirects)?
- A regenerated version gets a new `external_id`. If an older version was
  already published, should we retire it first (see request 4)?
- The niche mapping above: is `metabolic` right for weight-loss-seeker content,
  given that "weight loss", "fat loss" and "lose weight" are rejected words?
