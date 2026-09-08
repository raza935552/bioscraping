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
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Drop empty-text items, keep insertion order, cap at max. */
export function takeItems(items: SourceItem[], max = MAX_ITEMS): SourceItem[] {
  return items.filter((i) => i.text.length > 0 && /^https?:\/\//.test(i.url)).slice(0, max);
}

export function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
