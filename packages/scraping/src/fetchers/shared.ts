import { MAX_ITEMS, type SourceItem } from "../types.js";

/** Truncate by code point, never by UTF-16 unit: a plain slice can split an
 *  emoji's surrogate pair and the lone half is invalid JSON downstream
 *  (Anthropic rejects it with "no low surrogate in string"). */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** Trim, collapse whitespace, cap length (surrogate-safe). */
export function clip(text: string | null | undefined, max = 600): string {
  return safeSlice((text ?? "").replace(/\s+/g, " ").trim(), max);
}

/** Best-effort ISO date from an ISO string, epoch seconds, or ms. */
export function toIso(value: unknown, now: Date = new Date()): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const rel = relativeAgo(value, now);
    if (rel) return rel;
  }
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(s|sec|secs|second|seconds)$/, 1_000],
  [/^(m|min|mins|minute|minutes)$/, 60_000],
  [/^(h|hr|hrs|hour|hours)$/, 3_600_000],
  [/^(d|day|days)$/, 86_400_000],
  [/^(w|wk|wks|week|weeks)$/, 7 * 86_400_000],
  [/^(mo|mos|month|months)$/, 30 * 86_400_000],
  [/^(y|yr|yrs|year|years)$/, 365 * 86_400_000],
];

/** "5d ago", "12 days ago", "3 weeks ago", "Streamed 2 months ago", "yesterday" → ISO, else null.
 *  YouTube's channel scraper returns upload dates only in this relative form. */
export function relativeAgo(value: string, now: Date = new Date()): string | null {
  const s = value.trim().toLowerCase();
  if (s === "yesterday") return new Date(now.getTime() - 86_400_000).toISOString();
  if (s === "today" || s === "just now") return now.toISOString();
  const m = s.match(/^(?:streamed|premiered|updated)?\s*(\d+)\s*([a-z]+)\s+ago$/);
  if (!m) return null;
  const unit = UNIT_MS.find(([re]) => re.test(m[2]!));
  return unit ? new Date(now.getTime() - Number(m[1]) * unit[1]).toISOString() : null;
}

/** Drop empty-text items, keep insertion order, cap at max. */
export function takeItems(items: SourceItem[], max = MAX_ITEMS): SourceItem[] {
  return items.filter((i) => i.text.length > 0 && /^https?:\/\//.test(i.url)).slice(0, max);
}

export function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build the optional engagement fields, omitting anything not numeric
 *  (exactOptionalPropertyTypes forbids `views: undefined`). */
export function engagement(o: { likes?: unknown; views?: unknown; comments?: unknown; isRepost?: unknown }): Pick<SourceItem, "likes" | "views" | "comments" | "isRepost"> {
  const out: Pick<SourceItem, "likes" | "views" | "comments" | "isRepost"> = {};
  const l = toNumber(o.likes);
  const v = toNumber(o.views);
  const c = toNumber(o.comments);
  if (l != null) out.likes = l;
  if (v != null) out.views = v;
  if (c != null) out.comments = c;
  if (typeof o.isRepost === "boolean") out.isRepost = o.isRepost;
  return out;
}
