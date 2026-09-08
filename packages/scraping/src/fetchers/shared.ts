import { MAX_ITEMS, type SourceItem } from "../types.js";

/** Trim, collapse whitespace, cap length. */
export function clip(text: string | null | undefined, max = 600): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
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
