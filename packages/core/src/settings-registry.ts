// The registry of everything configurable through the admin Settings page.
// Each field maps to an env var name (so the app reads it the same way whether
// it came from .env or the encrypted DB store). `secret: true` fields are
// AES-encrypted at rest and never returned to the browser in plaintext.

export type SettingKind = "secret" | "text" | "number" | "bool";

export interface SettingField {
  key: string; // matches the env var name
  label: string;
  kind: SettingKind;
  help?: string;
  placeholder?: string;
}

export interface SettingsSection {
  id: string;
  title: string;
  blurb: string;
  fields: SettingField[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "idev",
    title: "Affiliate platform (iDevAffiliate)",
    blurb: "Credentials for the affiliate roster sync and provisioning.",
    fields: [
      { key: "IDEVAFFILIATE_URL", label: "iDev URL", kind: "text", placeholder: "https://biolinxlabs.idevaffiliate.com" },
      { key: "IDEVAFFILIATE_SITE_KEY", label: "Site key (REST API secret)", kind: "secret", help: "Used to authenticate the roster API." },
      { key: "IDEVAFFILIATE_API_SECRET", label: "Legacy scripts secret", kind: "secret", help: "For coupon assignment / terminate." },
      { key: "RECRUITER_IDEV_ID", label: "Your tier — recruiter iDev ID", kind: "text", help: "Recruits are placed under this affiliate.", placeholder: "100" },
    ],
  },
  {
    id: "email",
    title: "Cold email (Instantly)",
    blurb: "Sending fleet and the recruiting campaign.",
    fields: [
      { key: "COLD_EMAIL_API_KEY", label: "Instantly API key", kind: "secret" },
      { key: "COLD_EMAIL_CAMPAIGN_ID", label: "Recruiting campaign ID", kind: "text" },
      { key: "INSTANTLY_WEBHOOK_SECRET", label: "Reply webhook secret", kind: "secret", help: "Instantly signs reply webhooks with this." },
      { key: "SENDER_NAME", label: "Sender name (signs the messages)", kind: "text", placeholder: "Raza Khan" },
      { key: "SENDER_POSTAL_ADDRESS", label: "CAN-SPAM postal address", kind: "text", help: "Required in every email footer." },
      { key: "CHANNEL_AUTOSEND_EMAIL", label: "Auto-send email (skip approval)", kind: "bool", help: "OFF = every email waits for approval." },
    ],
  },
  {
    id: "customerio",
    title: "Customer.io (email mirror)",
    blurb: "Every lead email is mirrored as a person with lead attributes. Journeys are built in Customer.io.",
    fields: [
      { key: "CUSTOMERIO_SITE_ID", label: "Site ID", kind: "text" },
      { key: "CUSTOMERIO_TRACK_API_KEY", label: "Track API key", kind: "secret", help: "Site ID + Track API key identify people. Both are in Customer.io under Settings > API credentials." },
      { key: "CUSTOMERIO_APP_API_KEY", label: "App API key (optional)", kind: "secret", help: "Only needed later for reading segments and campaigns back." },
      { key: "CUSTOMERIO_REGION", label: "Region (us or eu)", kind: "text", placeholder: "us" },
    ],
  },
  {
    id: "ai",
    title: "AI drafting (Anthropic)",
    blurb: "The model that writes and classifies messages.",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", kind: "secret" },
      { key: "DRAFT_MODEL", label: "Drafting model", kind: "text", placeholder: "claude-sonnet-5" },
      { key: "CLASSIFY_MODEL", label: "Reply-classifier model", kind: "text", placeholder: "claude-haiku-4-5-20251001" },
    ],
  },
  {
    id: "sourcing",
    title: "Lead sourcing (Apify)",
    blurb: "Scraping creators and enriching contact details.",
    fields: [
      { key: "APIFY_TOKEN", label: "Apify token", kind: "secret" },
      {
        key: "SOURCING_DAILY_SPEND_USD",
        label: "Daily spend limit, all audiences (USD)",
        kind: "number",
        help: "Estimated Apify spend shared by every audience in one day (Los Angeles time). Each audience also keeps its own cap. Blank = $10.",
        placeholder: "10",
      },
      {
        key: "SOURCING_MAX_PENDING",
        label: "Most leads waiting for review",
        kind: "number",
        help: "Sourcing stops adding leads once this many are waiting for review, and continues as they are accepted or rejected. Blank = no limit.",
        placeholder: "50",
      },
      {
        key: "SOURCING_COMPETITOR_ONLY",
        label: "Competitor affiliates only",
        kind: "bool",
        help: "ON (and blank) = only competitor searches run (\"<competitor> code\", \"discount\", their domain) and only people who name a competitor are saved, since the outreach flow contacts no one else. OFF = audience hashtag searches run too.",
      },
    ],
  },
  {
    id: "migration",
    title: "Airtable (one-time migration)",
    blurb: "Only needed to import the original Airtable data.",
    fields: [{ key: "AIRTABLE_TOKEN", label: "Airtable token", kind: "secret" }],
  },
  {
    id: "alerts",
    title: "Alerts & digest (Telegram)",
    blurb: "Where fail-loud alerts and the daily number go.",
    fields: [
      // Plain text (visible) by request — a Telegram alert-bot token is low-risk.
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", kind: "text" },
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", kind: "text" },
    ],
  },
  {
    id: "content",
    title: "Biolinx content library (swipe file)",
    blurb: "Sends approved swipe posts to the affiliate content library and receives its callbacks. In Biolinx admin: Affiliate content library > Settings > Bioscraper connection.",
    fields: [
      { key: "BIOLINX_CONTENT_SECRET", label: "Shared secret", kind: "secret", help: "Copy it from the Bioscraper connection settings in Biolinx. Rotating it there means pasting the new one here." },
      { key: "BIOLINX_CONTENT_BASE_URL", label: "Biolinx site URL", kind: "text", placeholder: "https://biolinxlabs.com", help: "Blank = https://biolinxlabs.com." },
      { key: "BIOLINX_CONTENT_ENABLED", label: "Send approved posts automatically", kind: "bool", help: "ON = approved posts go out every 10 minutes. OFF = only the Send now button sends. Nothing is ever sent without Approve." },
      { key: "BIOLINX_MAKES_IMAGES", label: "Biolinx makes the images", kind: "bool", help: "ON = approved posts are sent with the image words and brief, Biolinx's generator makes the image and sends the link back, and Redo image asks it for a new one. Turn on only after Biolinx confirms it accepts posts without an image link. OFF = paste an image link on each post." },
      { key: "SWIPE_SEARCH_DAILY", label: "Find top posts automatically", kind: "bool", help: "ON = once a day, when fewer than 10 unused source posts are waiting, search TikTok for top posts on our topics (Apify credit, counts toward the daily sourcing limit). OFF = only the Find top posts button searches." },
      { key: "SWIPE_SEARCH_MAX_USD", label: "Top posts search budget per run (USD)", kind: "text", placeholder: "1", help: "Blank = $1 (about 12 hashtags, 40 posts each). Never more than what's left of the daily sourcing limit." },
      { key: "BIOLINX_BRAND_FACTS", label: "Verified Biolinx facts for posts", kind: "text", help: "Separate facts with ; — only true, confirmed statements (e.g. third-party COA per batch; ships from the US). The post writer may state only these about Biolinx. Blank = it makes no claims about Biolinx." },
    ],
  },
  {
    id: "store",
    title: "Store webhook (biolinxlabs.com)",
    blurb: "Signature secret for order events from the Laravel store.",
    fields: [{ key: "STORE_WEBHOOK_SECRET", label: "Webhook secret", kind: "secret" }],
  },
];

/** All field keys that are secrets (encrypted at rest, masked in the UI). */
export const SECRET_KEYS = new Set(
  SETTINGS_SECTIONS.flatMap((s) => s.fields.filter((f) => f.kind === "secret").map((f) => f.key)),
);

/** Env vars that must live in the server .env and are NOT UI-managed. */
export const ENV_ONLY_KEYS = ["DATABASE_URL", "APP_SECRET", "SETTINGS_KEY", "PORT", "NODE_ENV", "BUSINESS_TZ"];
