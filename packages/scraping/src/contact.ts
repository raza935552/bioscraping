// Contact details creators publish themselves. An email counts only when it is written out in
// the bio: 12 of 74 sourced profiles had one on 2026-09-15 and none were saved.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
// Asset names and placeholders that look like addresses.
const NOT_AN_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|@(example|domain|email)\.com$|^(name|your|you|email)@/i;
// A handle written next to a word ending in a dot reads as an address: "pepdeals.@glacier.aminosofficial"
// was saved as an email on 2026-09-17. Real endings are short, so anything longer isn't a domain.
const LONG_ENDINGS = new Set(["info", "site", "shop", "store", "space", "team", "club", "live", "link", "life", "world", "today", "email", "media", "group", "agency", "studio", "health", "fitness", "wellness", "coach", "online", "website", "digital", "company", "tech", "blog", "care", "news", "cloud", "clinic", "center", "expert", "plus"]);

/** Shape rules every address has to pass, wherever it was read: a bio, a caption, or a contact page.
 *  Written once because the two readers kept disagreeing — a handle next to a word ending in a dot
 *  ("pepdeals.@glacier.aminosofficial") was saved as an email on 2026-09-17. */
export function isPlausibleEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const e = raw.toLowerCase();
  if (e.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/.test(e)) return false;
  const [local, domain] = e.split("@") as [string, string];
  if (local.endsWith(".") || local.includes("..")) return false;
  const ending = domain.split(".").pop() ?? "";
  if (ending.length > 3 && !LONG_ENDINGS.has(ending)) return false;
  return !NOT_AN_EMAIL.test(e);
}

/** The first real email address in the text, lowercased, or null. Handles "name [at] site.com" too. */
export function emailFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
  for (const m of t.match(EMAIL) ?? []) {
    const e = m.replace(/^[._-]+|[._-]+$/g, "").toLowerCase();
    if (isPlausibleEmail(e)) return e;
  }
  return null;
}
