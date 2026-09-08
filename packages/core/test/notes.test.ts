import { describe, expect, it } from "vitest";
import { hasUsableNotes } from "../src/notes.js";

describe("hasUsableNotes", () => {
  it("rejects empty and whitespace", () => {
    expect(hasUsableNotes(null)).toBe(false);
    expect(hasUsableNotes("")).toBe(false);
    expect(hasUsableNotes("   ")).toBe(false);
  });
  it("rejects the August failure markers", () => {
    expect(hasUsableNotes("NOT USABLE — Scrape returned nothing")).toBe(false);
    expect(hasUsableNotes("NO MATCH / NOT USABLE — lifestyle content")).toBe(false);
    expect(hasUsableNotes("NO PERSONALIZATION — handle does not resolve")).toBe(false);
    expect(hasUsableNotes("  no personalization - lowercase too")).toBe(false);
  });
  it("accepts real talking points", () => {
    expect(hasUsableNotes("MATCH — Nurse practitioner posting hormone content (https://tiktok.com/...)")).toBe(true);
    expect(hasUsableNotes("Notes on their recent post about recovery")).toBe(true);
  });
});
