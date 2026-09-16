// Who may be contacted, and with which offer: the outreach flow chart (2026-09-16).
// Only creators already signed with a named competitor are contacted. Their competitor's
// commission against our 25% picks the offer:
//   lower  → Offer 1 (25%, soft or direct pitch)
//   equal  → Offer 2 (small business: lifetime reorders, catalogue, assets, Telegram, monthly payout)
//   higher → no path in the flow: not contacted
// Unsigned creators have no path either. Rates are rarely published, so a competitor with no rate
// on file counts as paying under ours (Raza, 2026-09-16: "the competitor is what matters"); a known
// rate still picks Offer 2 or no contact.

export const BIOLINX_COMMISSION_PCT = 25;

export type OutreachPath = "offer1" | "offer2" | "higher" | "competitor_unnamed" | "unsigned" | "converted";

/** Contact order: qualified first, then the leads closest to qualifying. */
export const OUTREACH_PATH_ORDER: Record<OutreachPath, number> = {
  offer1: 0,
  offer2: 1,
  competitor_unnamed: 3,
  higher: 4,
  unsigned: 5,
  converted: 6,
};

export const OUTREACH_PATH_LABEL: Record<OutreachPath, string> = {
  offer1: "Offer 1 · pitch our 25% for life",
  offer2: "Offer 2 · their rate equals our 25%",
  higher: "Not contacted · their rate is over our 25%",
  competitor_unnamed: "Competitor not identified",
  unsigned: "Not qualified · not signed with a competitor",
  converted: "Already our affiliate",
};

export function outreachPath(
  lead: { affiliationStatus: string | null; competitorId: number | null },
  competitorRatePct: number | null | undefined,
): OutreachPath {
  const status = lead.affiliationStatus?.trim().toLowerCase() ?? "";
  if (status === "our affiliate") return "converted";
  if (status !== "signed elsewhere" && status !== "signed") return "unsigned";
  if (lead.competitorId == null) return "competitor_unnamed";
  if (competitorRatePct == null || competitorRatePct < BIOLINX_COMMISSION_PCT) return "offer1";
  if (competitorRatePct === BIOLINX_COMMISSION_PCT) return "offer2";
  return "higher";
}

/** Only Offer 1 and Offer 2 leads may get outreach drafts. */
export function isQualifiedPath(path: OutreachPath): boolean {
  return path === "offer1" || path === "offer2";
}
