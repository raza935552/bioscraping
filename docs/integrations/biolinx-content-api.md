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
   - **Approve** — queued for sending. Needs a clean check and either an
     image link or, when Biolinx makes the images, the image words and brief.
   - **Decline** — the reviewer is asked "What more do you need?", and a new
     version is written from those notes (same source post, version + 1). The
     declined version is kept with the feedback.
   - **Edit** — hook, caption, hashtags, image words, image brief, image link;
     rechecked.
   - **Redo image** (after sending, Biolinx-made images) — the reviewer says
     what should change; Biolinx makes a new image for the same post.
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

**Images are made by Biolinx** (decided 2026-09-15). With Settings → "Biolinx
makes the images" on, approved posts are sent without `image_url` and with
`image_text` and `image_brief` instead; Biolinx's Gemini creator makes the image
and calls back with the link, which appears on the post in our admin. A
reviewer who doesn't like it presses "Redo image" with a note. A person can
still paste their own https image link on a post; then `image_url` is sent as
before. The switch stays off until Biolinx confirms the changes below.

## Setup on the Biolinx side

1. Biolinx admin → Affiliate content library → Settings → Bioscraper connection.
2. Callback URL: `https://gemboxpk.com/webhooks/biolinx/content` (connection
   tested 2026-09-15: signed lookup accepted, signed callback accepted)
3. Copy the secret into the bioscraper admin → Settings → "Biolinx content
   library (swipe file)". Rotate there and paste the new one here.
4. Turn receiving on. The daily limit (50) can stay while we test.

## Needed now: Biolinx makes the image

Our side is built and waiting behind a switch. Please add:

### 1. Accept posts without `image_url`

`POST /api/content/assets`, per post, exactly one of:

- `image_url` (as today), or
- `image_text` (string, max 120 characters, the words printed on the image,
  8 words max) **and** `image_brief` (string, max 1000 characters, what the
  image shows).

Example post:

```json
{
  "external_id": "bs-20260915-048b0c4e",
  "image_text": "Ask for the COA first",
  "image_brief": "One Biolinx vial beside a printed certificate of analysis on a clean white lab bench, soft daylight, label facing the camera.",
  "hook": "Most people never ask for this before they order",
  "caption": "... {CODE} ...",
  "hashtags": ["researchpeptides", "coa"],
  "niche": "research",
  "platform": "tiktok",
  "format": "portrait",
  "hook_type": "curiosity",
  "meta": { "bioscraper_id": 4, "version": 1, "angle": "..." }
}
```

Run the same text checks on `image_text` and `image_brief` that you run on the
hook and caption. Reply `accepted` with `status: "processing"` right away.

### 2. Generate the image

- Use the Gemini creator with **real Biolinx vial and packaging photos** as the
  reference, so labels are always real Biolinx labels.
- Print `image_text` on the image; follow `image_brief` for the scene.
- Shape from `format`: square 1:1, portrait 9:16, thumbnail 16:9.
- Visual rules: no needles or syringes, no pills, no people using or holding
  products to the body, no bodies or before/after, no other brands or logos,
  no vials that aren't Biolinx, no readable drug or GLP names.
- Save it to the media library, read the image text as you do today.

### 3. Call us back

`POST https://gemboxpk.com/webhooks/biolinx/content`, signed as today:

- `post.ready` with `post.image_url` = the media library link (https, public,
  no redirects), `media_id`, `image_check`, `issues`.
- `post.failed` with `post.error` saying why when the image can't be made.

`GET /api/content/assets/{external_id}` should return the same `image_url`
once ready (we use it as a backup every 10 minutes).

### 4. New image on request ("Redo image")

`POST /api/content/assets/{external_id}/image`, signed, body:

```json
{
  "note": "The words are too small. Show one vial with the label readable next to a COA.",
  "image_text": "Ask for the COA first",
  "image_brief": "One Biolinx vial beside a printed COA ..."
}
```

- Same `external_id`, same post: replace the image, don't create a new post.
- Pass `note` to the generator together with the brief.
- Reply `202` (or `200`) with `{ "ok": true, "post": { ...status "processing" } }`.
- When done, send `post.ready` again with the new `image_url`.
- `404` for an unknown id; `409` if the post is already published or retired.
- Doesn't count toward the 50 posts a day; a limit such as 5 new images per
  post is fine (reply `429` past it).

### 5. Tell us when it's live

We turn on "Biolinx makes the images" in our Settings, send one test post,
and check that the image arrives on our side.

## Other requests for the Biolinx developer

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
