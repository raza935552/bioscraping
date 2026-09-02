// The documented 14-person internal team (PROMPTS.md RULE 0, verbatim) plus
// known house-account patterns. Used ONLY to SUGGEST internal classification
// in the admin UI — a human confirms every one (never-guess rule). Matching is
// deliberately conservative: exact email locals/known emails and full-name
// matches, not fuzzy similarity.

export const TEAM_ROSTER = [
  "Algernon Lam",
  "Jakob Mesina",
  "Josh Pham",
  "Raza Khan",
  "Muhammad Zain",
  "Kevin Tran",
  "Hamilton Phan",
  "Diana Saltzman",
  "Lynn Le",
  "Nick Boots",
  "Katherine (Kat) Hoang",
  "Jennifer Ferguson",
  "Angie Lam",
  "Kimling Lam",
] as const;

/** Emails/domains confirmed to belong to team or house accounts. */
const KNOWN_INTERNAL_EMAILS = new Set([
  "razakkhanafridi@gmail.com",
  "jakobmesina@gmail.com",
  "nboots87@gmail.com",
  "josh@invicus.com",
  "josh@inviscus.com",
  "hoang.katherine@gmail.com",
  "lynnnnple@gmail.com",
  "jenndee6@gmail.com",
  "saltzmandiana@gmail.com",
  "algernon.lam@gmail.com",
  "ham.xpay@gmail.com",
  "biolinxlabs@gmail.com",
  "optimusmanagementllc@gmail.com",
]);

const DISPOSABLE_DOMAINS = new Set(["mailinator.com", "guerrillamail.com", "tempmail.com", "yopmail.com"]);

const rosterLastFirst = new Set(
  TEAM_ROSTER.map((n) =>
    n
      .toLowerCase()
      .replace(/\(.*?\)\s*/g, "")
      .trim(),
  ),
);

export type InternalSuggestion = "team" | "house" | "test" | null;

export function suggestClassification(a: {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): InternalSuggestion {
  const email = a.email?.trim().toLowerCase() ?? "";
  const domain = email.split("@")[1] ?? "";
  if (DISPOSABLE_DOMAINS.has(domain)) return "test";
  if (KNOWN_INTERNAL_EMAILS.has(email)) {
    return email === "biolinxlabs@gmail.com" || email === "optimusmanagementllc@gmail.com" ? "house" : "team";
  }
  const full = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim().toLowerCase();
  if (full && rosterLastFirst.has(full)) return "team";
  return null;
}
