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
    fields: [{ key: "APIFY_TOKEN", label: "Apify token", kind: "secret" }],
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
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", kind: "secret" },
      { key: "TELEGRAM_CHAT_ID", label: "Chat ID", kind: "text" },
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
