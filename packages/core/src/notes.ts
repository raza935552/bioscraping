// Personalization notes: the August 2026 pass left failure markers in the
// notes field ("NOT USABLE — …", "NO PERSONALIZATION — …"). Those are not
// talking points. Anything that counts or drafts from notes must use this.

export const FAILURE_NOTE_PATTERN = /^\s*(NOT USABLE|NO MATCH|NO PERSONALIZATION|NOT PERSONALIZED|FLAGGED)\b/i;

/** True only when the notes hold real talking points, not a failure marker. */
export function hasUsableNotes(notes: string | null | undefined): boolean {
  if (!notes) return false;
  const t = notes.trim();
  return t.length > 0 && !FAILURE_NOTE_PATTERN.test(t);
}
