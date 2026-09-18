// What an affiliate posts, written for them. The marketing Loom (2026-09-17) asked for templates so a
// new affiliate never has to invent the wording: a bio line, story text in four angles, a feed caption,
// and the YouTube ad break with its on-screen banner. Their own code is filled in; they copy and post.
//
// Everything here is written to pass the compliance linter, which is stricter than what competitors
// post. Three rules shape every line:
//   - Never imply personal use. "where I get mine", "my source" and "what I take" are all blocked
//     (L1-personal-use), and they were in the draft SOP. Research-use-only products are not used by
//     the person promoting them.
//   - Never make a claim. No weight, muscle, aging, dosing, protocol or treatment wording (L1).
//   - Public content carries the research-use line (L3), so every asset ends with it.
// The API lints each rendered asset before it is handed over, so a wording change that breaks a rule
// is caught rather than posted.

/** Must stay byte-identical to RUO_LINE in @biolinx/compliance (that package can't be imported here
 *  without a cycle; the assets test and the API's lint both fail loudly if they drift apart). */
export const RESEARCH_USE_LINE =
  "All Biolinx products are sold for laboratory and research use only. Not for human consumption.";

export type AssetPlatform = "any" | "instagram" | "tiktok" | "youtube";

export interface AssetDef {
  label: string;
  /** Where this goes, in the affiliate's words. */
  where: string;
  platform: AssetPlatform;
  /** Limit for the surface, so nobody pastes something that will be cut off. */
  maxChars?: number;
  /** "all": the whole asset goes in one field (a bio). "firstLine": only the first line has to fit
   *  (a link title, an on-screen strip) and the research-use line goes in the field named in `note`. */
  limitScope?: "all" | "firstLine";
  /** Shown next to the asset when there is something the person has to know. */
  note?: string;
  body: string;
}

export type AssetId =
  | "bio_line"
  | "link_title"
  | "story_curiosity"
  | "story_code"
  | "story_partner"
  | "story_code_partner"
  | "feed_caption"
  | "youtube_script"
  | "youtube_banner"
  | "youtube_description";

export const DEFAULT_ASSETS: Record<AssetId, AssetDef> = {
  bio_line: {
    label: "Bio line",
    where: "Instagram or TikTok bio",
    platform: "any",
    maxChars: 150,
    limitScope: "all",
    note: "Instagram allows 150 characters in a bio, and the research-use line takes 94 of them.",
    body: `Biolinx Labs partner · code [code] · [discount]% off
${RESEARCH_USE_LINE}`,
  },
  link_title: {
    label: "Link title",
    where: "Linktree, Beacons, or the link in their bio",
    platform: "any",
    maxChars: 80,
    limitScope: "firstLine",
    note: "First line is the button title. Put the research-use line in the link's description, or in the bio above it.",
    body: `Biolinx Labs · code [code] for [discount]% off
${RESEARCH_USE_LINE}`,
  },
  story_curiosity: {
    label: "Story · curiosity",
    where: "Story text over any clip",
    platform: "any",
    body: `the lab everyone keeps asking me about 👀
code [code] at [store], [discount]% off
${RESEARCH_USE_LINE}`,
  },
  story_code: {
    label: "Story · code",
    where: "Story text over any clip",
    platform: "any",
    body: `[discount]% off at Biolinx Labs
code [code]
${RESEARCH_USE_LINE}`,
  },
  story_partner: {
    label: "Story · partner",
    where: "Story text over any clip",
    platform: "any",
    body: `proud to partner with Biolinx Labs
third party tested, COA on every batch
link in bio
${RESEARCH_USE_LINE}`,
  },
  story_code_partner: {
    label: "Story · partner + code",
    where: "Story text over any clip",
    platform: "any",
    body: `partnered with Biolinx Labs 🤝
code [code] takes [discount]% off your order at [store]
${RESEARCH_USE_LINE}`,
  },
  feed_caption: {
    label: "Feed caption",
    where: "Under a TikTok or Reel",
    platform: "any",
    maxChars: 2200,
    body: `I partnered with Biolinx Labs, so here is the part that matters to you: code [code] takes [discount]% off your order at [store].
Why them: third party tested, a COA for every batch, and support that answers.
Paid partnership. I earn a commission on orders through my code, at no extra cost to you.
${RESEARCH_USE_LINE}`,
  },
  youtube_script: {
    label: "Ad break · what to say",
    where: "Read it out, about 20 seconds, anywhere in the video",
    platform: "youtube",
    body: `Quick word from the partner of this video, Biolinx Labs.
They are a research supplier: third party tested, a COA with every batch.
If you order from them, my code [code] takes [discount]% off, and the link is in the description.
${RESEARCH_USE_LINE}`,
  },
  youtube_banner: {
    label: "Ad break · on-screen banner",
    where: "The strip along the bottom while they read it",
    platform: "youtube",
    maxChars: 90,
    limitScope: "firstLine",
    note: "First line goes on the strip. The research-use line is already in the description block below.",
    body: `[store] · code [code] · [discount]% off
${RESEARCH_USE_LINE}`,
  },
  youtube_description: {
    label: "Description block",
    where: "Top of the video description",
    platform: "youtube",
    maxChars: 600,
    body: `Partner of this video: Biolinx Labs. [link]
Code [code] for [discount]% off your order.
I earn a commission from orders placed through this link, at no extra cost to you.
${RESEARCH_USE_LINE}`,
  },
};

export interface AffiliateAssetSettings {
  /** Per-asset wording, edited in the admin; anything unset uses the default above. */
  assets: Partial<Record<AssetId, string>>;
  /** The discount their code gives, in percent. */
  discountPct: number;
  /** Where their audience lands. */
  storeUrl: string;
}

export const DEFAULT_ASSET_SETTINGS: AffiliateAssetSettings = {
  assets: {},
  discountPct: 10,
  storeUrl: "biolinxlabs.com",
};

/** Stored settings merged over the defaults; anything malformed falls back. */
export function affiliateAssetSettings(stored: unknown): AffiliateAssetSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<AffiliateAssetSettings>;
  const assets: Partial<Record<AssetId, string>> = {};
  for (const [k, v] of Object.entries(s.assets ?? {})) {
    if (k in DEFAULT_ASSETS && typeof v === "string" && v.trim()) assets[k as AssetId] = v;
  }
  const pct = Number(s.discountPct);
  const store = typeof s.storeUrl === "string" && s.storeUrl.trim() ? s.storeUrl.trim() : DEFAULT_ASSET_SETTINGS.storeUrl;
  return {
    assets,
    discountPct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct) : DEFAULT_ASSET_SETTINGS.discountPct,
    storeUrl: store.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  };
}

export interface AssetSubject {
  firstName: string | null;
  couponCode: string | null;
  referralLink: string | null;
}

export interface RenderedAsset {
  id: AssetId;
  label: string;
  where: string;
  platform: AssetPlatform;
  text: string;
  /** Placeholders with nothing to fill them: the asset isn't usable until these are known. */
  missing: string[];
  chars: number;
  maxChars: number | null;
  /** True when what has to fit is longer than the surface allows. */
  tooLong: boolean;
  note: string | null;
}

/** One asset, filled in for this affiliate. Unknown placeholders are left in the text and listed in
 *  `missing`, so nothing goes out reading "code [code]" without someone noticing. */
export function renderAsset(id: AssetId, subject: AssetSubject, settings: AffiliateAssetSettings): RenderedAsset {
  const def = DEFAULT_ASSETS[id];
  const body = settings.assets[id] ?? def.body;
  const missing: string[] = [];
  const values: Record<string, string> = {
    code: (subject.couponCode ?? "").trim().toUpperCase(),
    discount: String(settings.discountPct),
    store: settings.storeUrl,
    link: (subject.referralLink ?? "").trim() || `https://${settings.storeUrl}`,
    "first name": (subject.firstName ?? "").trim(),
  };
  const text = body.replace(/\[([a-z ]+)\]/gi, (whole, key: string) => {
    const k = key.toLowerCase();
    if (!(k in values)) return whole;
    if (!values[k]) {
      missing.push(k);
      return whole;
    }
    return values[k]!;
  });
  const max = def.maxChars ?? null;
  // A link title or an on-screen strip only has to fit on its first line; the research-use line
  // that follows goes somewhere else on the page.
  const measured = def.limitScope === "firstLine" ? (text.split("\n")[0] ?? "") : text;
  return {
    id,
    label: def.label,
    where: def.where,
    platform: def.platform,
    text,
    missing: [...new Set(missing)],
    chars: measured.length,
    maxChars: max,
    tooLong: max != null && measured.length > max,
    note: def.note ?? null,
  };
}

export const ASSET_ORDER: AssetId[] = [
  "bio_line",
  "link_title",
  "story_curiosity",
  "story_code",
  "story_partner",
  "story_code_partner",
  "feed_caption",
  "youtube_script",
  "youtube_banner",
  "youtube_description",
];

/** Every asset for an affiliate, in the order a person works through them. */
export function renderAssets(subject: AssetSubject, settings: AffiliateAssetSettings): RenderedAsset[] {
  return ASSET_ORDER.map((id) => renderAsset(id, subject, settings));
}
