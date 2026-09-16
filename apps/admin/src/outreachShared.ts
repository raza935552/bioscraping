// Small helpers shared by the Outreach page, the lead dialog's outreach box and the Leads table.

export type ReplyKind = "yes" | "tell_me_more" | "no" | "no_info";

export const REPLY_OPTIONS: Array<[ReplyKind, string, string]> = [
  ["yes", "Yes", "They're in, or they sent their details"],
  ["tell_me_more", "Tell me more", "They asked a question or want details"],
  ["no", "No", "They said no"],
  ["no_info", "Replied but no info", "They answered without saying yes or no, or without their details"],
];

export const REPLY_LABEL: Record<string, string> = Object.fromEntries(REPLY_OPTIONS.map(([k, l]) => [k, l]));

/** Where the message is sent, from the lead's platform. */
export function channelFor(platform: string | null): string {
  const p = (platform ?? "").toLowerCase();
  return p.includes("tiktok") ? "TikTok DM" : p.includes("instagram") ? "Instagram DM" : p.includes("reddit") ? "Reddit DM" : p.includes("facebook") ? "Facebook DM" : "Other";
}

/** "Jane Doe" → JANED10, the shape the sign-up message suggests. Empty for placeholder names. */
export function suggestCode(first: string, last: string): string {
  const f = first.trim().split(/\s+/)[0]?.replace(/[^a-z0-9]/gi, "") ?? "";
  const l = last.trim().replace(/[^a-z]/gi, "").slice(0, 1);
  return f.length >= 2 ? `${f}${l}10`.toUpperCase() : "";
}

/** A display name split for the sign-up form; "(no name)" gives blanks. */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const n = (name ?? "").trim();
  if (!n || n.startsWith("(")) return { firstName: "", lastName: "" };
  const [first = "", ...rest] = n.split(/\s+/);
  return { firstName: first, lastName: rest.join(" ") };
}

export const compact = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

/** Copies text; falls back to selecting a textarea and execCommand where the clipboard API is missing or refuses. */
export async function copyText(text: string, fallbackEl?: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the fallback */
  }
  try {
    const el = fallbackEl ?? Object.assign(document.createElement("textarea"), { value: text });
    if (!fallbackEl) {
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
    }
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    if (!fallbackEl) el.remove();
    return ok;
  } catch {
    return false;
  }
}
