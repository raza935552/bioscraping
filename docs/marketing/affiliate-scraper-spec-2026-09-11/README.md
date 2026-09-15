# Marketing scoring spec (received 2026-09-14)

The marketing team's labeling spec for sourced affiliates, dated 2026-09-11,
delivered as `biolinx-affiliate-scraper-spec.zip`. Kept verbatim. It was
written for a Python scraper; the engine implements it in TypeScript.

How the engine follows it, and where it differs, as of 2026-09-15:

- Implemented: platform, niche tiers, brand tag (Both only for Weight-loss
  seeker), competitor affiliate vs individual creator, commission comparison
  (when the rate is on file), verified reach or NOT FOUND, active vs dormant,
  promo track record, five-field dedupe with code as the strongest key, real
  post link or blank, spend cap, human first contact, public pages only.
- Applied from it: Women's Wellness/menopause/PCOS → Weight-loss seeker
  (decision A1); Sexual wellness paused pending a research pass; Reddit and
  Skool held as a second wave.
- Not built yet: LIVE status (per-username checks over a window), organic
  mention field, content originality (TikTok gives no repost flag),
  tier-specific score weights.
- Open conflict for Jakob: the spec treats organic GLP-1 talk as warmer; the
  engine drops GLP-1-only bios (decision D11).
- The spec's source files (`TARGETING-PLAN.md`, Aro `ICP.md`,
  `lead-discovery-weekly.md`) were not in the zip.
