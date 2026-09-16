// Plain-language labels for every internal code the admin shows. Database
// values never change; people see these words. Hover text carries the longer
// explanation where one helps.

export const BAND_LABEL: Record<string, string> = {
  "1": "Unsigned · reach verified",
  "2": "Unsigned · reach unknown",
  "3": "Signed elsewhere · Diamond/Gold",
  "3b": "Signed elsewhere · Silver",
  "4": "Signed elsewhere · Bronze",
  "5": "Needs triage",
};

export const BAND_HELP: Record<string, string> = {
  "1": "Not with any program yet and we know their real reach. Contact first.",
  "2": "Not with any program yet, but nobody has verified their reach.",
  "3": "Already promotes someone else at the top tier. Worth a conversation.",
  "3b": "Already promotes someone else at Silver tier.",
  "4": "Already promotes someone else at Bronze tier. Lowest priority.",
  "5": "The record is missing something the ranking needs. A human decides.",
};

/** The accept choices, in plain words. SP5 isn't a choice: goodwill advocates are rejected. */
export const CREATOR_TYPES: Array<{ code: string; label: string }> = [
  { code: "SP1", label: "Expert: knows peptides well, posts codes or reviews" },
  { code: "SP2", label: "Beginner: interested, still learning" },
  { code: "SP3", label: "Community leader: runs a group, forum or Skool" },
  { code: "SP4", label: "Website owner: health blog or review site" },
];

/** Sub-profile codes → what they mean to a rep. SP5 is never contacted. */
export function subProfileLabel(sp: string | null | undefined): { text: string; danger: boolean; help: string } {
  const code = (sp ?? "").trim().toUpperCase().slice(0, 3);
  switch (code) {
    case "SP1":
      return { text: "Expert", danger: false, help: "Knows peptides well: posts codes, reviews or explainers." };
    case "SP2":
      return { text: "Beginner", danger: false, help: "Interested, still learning." };
    case "SP3":
      return { text: "Community leader", danger: false, help: "Runs or leads a group, forum or Skool." };
    case "SP4":
      return { text: "Website owner", danger: false, help: "Runs a health blog or review site." };
    case "SP5":
      return { text: "Fan: never message", danger: true, help: "Already a Biolinx fan. Never contacted, by rule." };
    default:
      return { text: sp ? sp.slice(0, 14) : "Unsorted", danger: false, help: sp ?? "No sub-profile assigned yet." };
  }
}

export const MESSAGE_STATE_LABEL: Record<string, string> = {
  drafted: "Drafting",
  linted: "Draft",
  approved: "Approved",
  claimed: "Claimed",
  sent: "Sent",
  logged: "Logged",
  blocked: "Blocked",
};

export const SAGA_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  received: { text: "Received", tone: "warn" },
  invalid: { text: "Missing information", tone: "bad" },
  duplicate: { text: "Already an affiliate", tone: "bad" },
  attribution_error: { text: "Recruiter name not matched", tone: "bad" },
  validated_pending_diana: { text: "Waiting for Diana", tone: "warn" },
  provisioning: { text: "Setting up in iDev", tone: "warn" },
  provisioned: { text: "Set up", tone: "ok" },
};

export const ENRICH_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad"; help: string }> = {
  enriched: { text: "ready", tone: "ok", help: "Has real, source-linked talking points. Can be drafted." },
  pending: { text: "queued", tone: "warn", help: "Waiting for the next research run." },
  no_match: { text: "no match", tone: "warn", help: "Profile found, but nothing relevant to say. A human can add notes by hand." },
  unresolvable: { text: "unreachable", tone: "bad", help: "Every handle we have is dead, private, or empty." },
  no_source: { text: "no source", tone: "bad", help: "No URL or handle on file. Add one and it will be researched." },
  failed: { text: "failed", tone: "bad", help: "The scraper or the model errored. Retried up to 3 times." },
};

export const PLATFORM_LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", reddit: "Reddit", skool: "Skool" };

export const TERM_HELP: Record<string, string> = {
  tiktok: "One per line. #hashtag searches that tag; a plain phrase is treated as a hashtag too.",
  instagram: "One per line. #hashtag for a tag; a plain phrase runs a keyword search.",
  youtube: "One per line. Plain search phrases, e.g. peptides for recovery.",
  reddit: "One per line. Subreddits as r/Peptides (top posts of the month).",
  skool: "One per line. Community search terms; the community owner becomes the lead.",
};

export const BRAND_LABEL: Record<string, string> = { biolinx: "BiolinX", aro: "Aro", both: "BiolinX + Aro" };

/** Default brand per niche tier (mirrors brandFitForNiche in core). */
export const NICHE_BRAND: Record<string, string> = {
  "Weight-loss seeker": "both",
  Biohacker: "biolinx",
  "Gym / PED-curious": "biolinx",
  "Anti-aging": "biolinx",
  "Sexual wellness": "biolinx",
};

export const REVIEW_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  pending: { text: "Waiting for review", tone: "warn" },
  accepted: { text: "Accepted", tone: "ok" },
  rejected: { text: "Rejected", tone: "bad" },
};

export const ROLE_HELP: Record<string, string> = {
  admin: "Full control, including keys and team",
  ops: "Runs jobs, decides affiliates, prepares signups",
  rep: "Warm-network recruiting",
  operator: "Outreach: copies each message into DMs and logs replies (sees only Outreach and Signups)",
};

const JOB_LABEL: Record<string, string> = {
  "idev-sync": "iDev roster sync",
  "rank-recompute": "Lead ranking",
  "referral-expiry": "Referral bonus expiry",
  "metrics-digest": "Daily digest",
  "outreach-dispatch:dm": "DM drafting",
  "outreach-dispatch:email": "Email drafting",
  "enrich-personalize": "Lead research",
  "lead-ingest": "Find new leads",
  "customerio-sync": "Customer.io mirror",
};

export function jobLabel(job: string): string {
  return JOB_LABEL[job] ?? job;
}

/** Turn a job's detail JSON into one readable sentence. */
export function describeRun(job: string, detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  if (typeof d.error === "string") return `Failed: ${d.error}`;
  switch (job) {
    case "idev-sync": {
      const parts = [
        `${n("approved") ?? "?"} approved in iDev`,
        `${n("external") ?? 0} real partners`,
        `${n("internal") ?? 0} team/house`,
        `${n("unresolved") ?? 0} need a decision`,
      ];
      if ((n("poisoned") ?? 0) > 0) parts.push(`${n("poisoned")} unreadable`);
      return parts.join(" · ");
    }
    case "rank-recompute":
      return `${n("total") ?? 0} leads ranked · ${n("changed") ?? 0} moved · ${n("triage") ?? 0} need triage · ${n("sp5Excluded") ?? 0} do-not-contact${n("notReviewed") ? ` · ${n("notReviewed")} sourced leads waiting for review (not ranked)` : ""}`;
    case "referral-expiry":
      return `${n("stamped") ?? 0} dated · ${n("newlyExpired") ?? 0} newly expired · ${n("expiredTotal") ?? 0} expired total`;
    case "outreach-dispatch:dm":
    case "outreach-dispatch:email":
      return `${n("considered") ?? 0} considered · ${n("drafted") ?? 0} drafted · ${n("queued") ?? 0} to review · ${n("sent") ?? 0} sent · ${n("blocked") ?? 0} blocked${(n("skippedUnenriched") ?? 0) > 0 ? ` · ${n("skippedUnenriched")} waiting for research` : ""}`;
    case "lead-ingest":
      return `${n("inserted") ?? 0} new leads waiting for review · about $${n("estimatedCostUsd") ?? 0}`;
    case "customerio-sync":
      return d.skippedNotConfigured ? "Customer.io is not configured" : `${n("synced") ?? 0} synced · ${n("suppressed") ?? 0} unsubscribed · ${n("failed") ?? 0} failed`;
    case "enrich-personalize":
      return `${n("attempted") ?? 0} researched · ${n("enriched") ?? 0} ready · ${n("no_match") ?? 0} no match · ${n("unresolvable") ?? 0} unreachable · ${n("no_source") ?? 0} no source · ${n("failed") ?? 0} failed`;
    default:
      return Object.entries(d)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ");
  }
}

/** The outreach flow chart's paths (packages/core/src/outreach-path.ts). */
export const PATH_LABEL: Record<string, { short: string; tone: "ok" | "wait" | "bad"; help: string }> = {
  offer1: { short: "Offer 1", tone: "ok", help: "Signed with a competitor: pitch our 25% for life (soft or direct). Used whenever the competitor's rate isn't known or is under 25%." },
  offer2: { short: "Offer 2", tone: "ok", help: "Signed with a competitor paying the same 25%: pitch the small-business offer (lifetime reorders, catalogue, assets, Telegram, monthly payout)." },
  competitor_unnamed: { short: "Competitor unknown", tone: "wait", help: "Marked signed elsewhere, but the competitor isn't identified. Find the brand, then set it." },
  higher: { short: "Rate over 25%", tone: "bad", help: "Their competitor pays more than our 25%. The flow has no offer for them: not contacted." },
  unsigned: { short: "Not qualified", tone: "bad", help: "Not signed with a competitor. The outreach flow only contacts competitor affiliates." },
  converted: { short: "Our affiliate", tone: "ok", help: "Already signed with us." },
};
