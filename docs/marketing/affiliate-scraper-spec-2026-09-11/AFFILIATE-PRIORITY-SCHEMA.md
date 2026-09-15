# BIOLINX AFFILIATE PRIORITY SCHEMA
Built 2026-09-11. The labeling spec Raza's scraper (Python) reads to
score and rank every candidate before it's added to the board. This
file defines the fields and universal rules. The 5 tier files
(`AFFILIATE-TIER-*.md`) define which niches get worked first and why,
each with real evidence, not a guess.

**Every field below applies to every candidate, every tier.** Tier
files only differ on niche, brand tag, and evidence — the schema
itself doesn't change per tier.

---

## THE FIELDS

| Field | Values | Rule |
|---|---|---|
| **platform** | TikTok, YouTube, Reddit, Skool | TikTok + YouTube first, Reddit + Skool second wave |
| **niche** | one of the 5 tiers — see tier files | Score against Hormozi's 4 criteria (pain, purchasing power, findability, growth) before a niche earns tier status. Already done for all 5, see tier files |
| **brand tag** | Both / Biolinx only | **Both** only on the Weight-Loss Seeker niche — the one niche Aro's actual product (GLP-1 weight loss) fits. Every other niche tags **Biolinx only** — Aro doesn't sell anything for those audiences, a counter-offer there wouldn't be real |
| **affiliate type** | competitor affiliate / individual creator | Competitor affiliate = has a community + already knows how to sell to it. Individual = no current code |
| **commission comparison** | lower than 25%+lifetime / same or higher | Lower = easier pitch (we beat their current deal). Same or higher = counter-offer angle (smaller company, more attention, more flexibility) |
| **audience size** | real number, verified only | Never estimated. `NOT FOUND` beats a guess — 270+ of the board's existing 411 rows are already blank here, don't make it worse |
| **posting activity** | active (posted last 30 days) / dormant | Dormant accounts don't get worked first regardless of other scores |
| **organic mention** | yes / no | Already talks about peptides/GLP-1 without holding a code — warmer than a cold competitor affiliate |
| **live status** | checked live / not checked | Checked via a real per-username `is_live()` call (TikTokLive Python library, or Apify's TikTok Live Status Scraper — both confirmed real, no login needed), sampled over a real window (e.g. daily for 7 days). **Never guessed from posting frequency alone** — no public "who goes live" search exists, this is the actual verified method. A visible **LIVE Pro badge** on the profile is a standalone strong signal on its own |
| **promotion track record** | proven / no history found | Has this person run a dedicated launch, review, or discount-link promotion before — for anyone, not just a peptide competitor. Real filter, Matt McWilliams: proof of execution beats account size alone |
| **content originality** | original / reposts only | Their own reviews/comparisons in their own words vs. reposted/aggregated content. Real filter, Geno Prussakov: original content is what makes an audience actually trust the recommendation |

---

## UNIVERSAL RULES — apply before a candidate is ever added

**1. De-dup, before adding, not after.** Check every candidate against the live board on all 5: name + known aliases, email, website URL, social handles, and **the discount code itself** — the code is the strongest match, since the same person shows up under different handles per platform but keeps one code. Real precedent: this exact method caught 48 duplicates in one past run (`recurring/lead-discovery-weekly.md`).

**2. `where found` is a real post link, or it stays blank.** Never a directory page, a Linktree, a "top creators" listicle. Valid: `tiktok.com/@handle/video/{id}`, `youtube.com/watch?v={id}`, `reddit.com/r/{sub}/comments/{id}/...`. Real precedent: 310 of the board's original 310 records had directory links — only 1 had a real post. A blank field is honest; a directory link is worse than nothing, because it reads as usable and isn't.

**3. Spend cap — $2.00 per run** on the live-status checks specifically (the metered part of this pipeline). Stop and report at the cap, don't continue and reconcile after. Reference economics: Apify's `google-search-scraper` ran ~$0.0023/record on the last comparable job — this cap is a circuit breaker, not a real ceiling on volume.

**4. Automation boundary — no exceptions.** Discovery, scoring, dedupe, and writing to the board are automated. **First contact is never automated** — no DM, comment, reply, follow, or connection request from any script or agent, at any point. This spec fills the board. A human sends the first message.

**5. No account creation, no logins, no purchases, no testing a discount code at checkout.** Every page read must be public.

---

## SOURCES THIS SPEC READS

- `xpay/biolinx/marketing/outreach/TARGETING-PLAN.md` — real per-niche lead counts and platform concentration, the evidence behind every tier score
- `xpay/aro/marketing/icp/ICP.md` — Aro's real customer ICP, the basis for the Weight-Loss Seeker niche and the brand-tag rule
- `xpay/biolinx/CLAUDE.md` §0 — the real 25%+lifetime commission baseline
- `recurring/lead-discovery-weekly.md` — the proven de-dup and vendor-roster mechanisms this schema reuses
