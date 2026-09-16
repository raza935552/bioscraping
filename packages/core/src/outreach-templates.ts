// Default wording for the outreach flow (outreach-flow.ts). "marketing" templates are the team's
// copy from 2026-09-16 (typos fixed; the "free bac water" bet became a free order, since BAC water
// is an injection supply and conflicts with research-use-only). "drafted" templates fill the flow
// chart's gaps and are placeholders for marketing to rewrite. Every template can be edited in the
// admin (config key `outreach_templates`); these are used for anything not edited.

import type { TemplateId } from "./outreach-flow.js";

export interface TemplateDef {
  label: string;
  /** When it's used, in words. */
  when: string;
  source: "marketing" | "drafted";
  body: string;
}

export const DEFAULT_TEMPLATES: Record<TemplateId, TemplateDef> = {
  offer1_soft: {
    label: "Offer 1 · soft",
    when: "First message. Their competitor pays under our 25%, or the rate isn't known.",
    source: "marketing",
    body: `[curiosity gap].
I'm [name], a Biolinx partner recruiter, and without a doubt in my mind, we can give you a better commission.
lmk if you're interested or if we should give your spot to another partner!
have an amazing day ✌️`,
  },
  offer1_direct: {
    label: "Offer 1 · direct",
    when: "First message. Their competitor pays under our 25%, or the rate isn't known.",
    source: "marketing",
    body: `[curiosity gap].
I'm [name], a Biolinx partner recruiter, and we can offer you 25% commission on every order (4 life btw).
The catch? You'll have to deal with the problems of having more money...
lmk if you're interested or if we should give your spot to another affiliate!
have an amazing day ✌️`,
  },
  offer2_soft: {
    label: "Offer 2 · soft",
    when: "First message. Their competitor already pays 25%.",
    source: "marketing",
    body: `[curiosity gap].
I'm [name], a Biolinx partner recruiter, and we saw that you're working with [brand]. We can match the 25% (4 life btw), but...
I'll bet you a FREE order that we can give you perks [brand] doesn't have.
lmk if you're interested or if we should give your spot to another affiliate!
have an amazing day ✌️`,
  },
  offer2_direct: {
    label: "Offer 2 · direct",
    when: "First message. Their competitor already pays 25%.",
    source: "marketing",
    body: `[curiosity gap].
I'm [name], a Biolinx partner recruiter, and we saw that you're working with [brand]. We can match the 25% (4 life btw), AND give you a better...
reorder commission
recruitment commission
cookie length
and...
Full support from the cool folks here at Biolinx 😎
lmk if you're interested or if we should give your spot to another affiliate!
have an amazing day ✌️`,
  },
  recruit_aro: {
    label: "Offer 2 · Biolinx recruitment + Aro",
    when: "They said no to Offer 1 (or to the program details).",
    source: "drafted",
    body: `no worries at all, [first name]!
two quick things before I let you go:
1. you don't have to post anything to work with us. Send people our way and a 5% recruitment commission comes to you on every sale they make (4 life)
2. we also run Aro, our sister brand, and its partner program might be a better fit for your audience
want the details on either one?
have an amazing day ✌️`,
  },
  reply1_signup: {
    label: "Reply 1 · Biolinx sign-up",
    when: "They said yes.",
    source: "marketing",
    body: `Wow, you just made my day.
Only 4 things from you (and we'll take care of the rest):
first name
last name
email
your personal code (10% off btw)
we recommend [name or nickname] + [last name initial] + 10
(example: JOHND10)
Once you send that over...
I sign you up (asap)
YOU get an email (with everything you need)
WE make magic happen (as a team)
lmk if you have questions, but if you don't...
Welcome to the team [first name]! 🔥
ps - we can hop on a quick call if you need anything`,
  },
  reply1b_aro_signup: {
    label: "Reply 1b · Aro sign-up",
    when: "They said yes after the Aro offer.",
    source: "drafted",
    body: `Awesome, welcome to Aro!
Only 4 things from you (and we'll take care of the rest):
first name
last name
email
your personal code (10% off btw)
we recommend [name or nickname] + [last name initial] + 10
(example: JOHND10)
Once you send that over, I set you up with Aro (asap) and you get an email with everything you need.
lmk if you have questions!
ps - we can hop on a quick call if you need anything`,
  },
  reply2_details: {
    label: "Reply 2 · Biolinx program details",
    when: "They said tell me more.",
    source: "marketing",
    body: `[intro]
Here's the quick version:
commission rate: 25% on every order (4 life)
recruitment rate: 5% on every recruit sale (4 life)
cookie: lifetime
payout: monthly (check or zelle)
support: free promo assets + telegram community
(detailed version: [details link])
Here's how much some of our affiliates have earned so far:
Nick (team member) → $441.71
Jason (mortgage lender) → $222.49
David (influencer) → $190.55
lmk if you have any questions
ps - we reply FAST (within 48 hours)`,
  },
  reply2b_aro_details: {
    label: "Reply 2b · Aro program details",
    when: "They asked for more about Aro.",
    source: "drafted",
    body: `[intro]
Here's the quick version of the Aro partner program:
commission rate: [aro commission]
cookie: [aro cookie]
payout: monthly (check or zelle)
support: free promo assets + telegram community
(detailed version: [aro details link])
lmk if you have any questions
ps - we reply FAST (within 48 hours)`,
  },
  reply3_referral: {
    label: "Reply 3 · referral ask",
    when: "They said no.",
    source: "marketing",
    body: `No problem!
Feel free to say no, but... if you know anyone who'd be an awesome fit to join our small but humble crew, could you send me their contact info? You'll get a handsome recruitment commission (aka 5% per sale) for doing nothing besides the 30 seconds it takes to give us an introduction.
Regardless, thank you for your time!
ps - just because the door's closed now doesn't mean it has to be forever`,
  },
  reply3_aro_referral: {
    label: "Reply 3a/3b · Aro referral ask",
    when: "They said no to Aro too.",
    source: "drafted",
    body: `No problem at all!
if you know anyone who'd be a great fit for Aro or Biolinx, could you send me their contact info? You'll get a recruitment commission (5% per sale) just for the intro.
Regardless, thank you for your time!
ps - the door's always open`,
  },
  checkin_no_info: {
    label: "Check-in · replied but no info",
    when: "They replied but didn't send their details.",
    source: "marketing",
    body: `Have you given up on this?
ik life gets crazy, so I can sign you up in 60 seconds (or less)
All I need from you is:
first name
last name
email
your personal code (10% off btw)
we recommend [name or nickname] + [last name initial] + 10
(example: JOHND10)
ps - signing up won't hurt you, but losing your spot might.`,
  },
  checkin_no_reply: {
    label: "Check-in · no reply",
    when: "No reply after the check-in wait.",
    source: "marketing",
    body: `quick check-in: I'm running out of spots for the 25% lifetime commission, and I'd hate for you to lose it because you didn't see this message...
lmk if you're interested
ps - here's the deets: [details link]`,
  },
};

export type GapKind = "pleasure" | "pain" | "curiosity";

/** Opening lines for [curiosity gap]: one-liners that leave an open loop. */
export const DEFAULT_CURIOSITY_GAPS: Array<{ kind: GapKind; text: string }> = [
  { kind: "pleasure", text: "want to make more money?" },
  { kind: "pleasure", text: "we can give you more..." },
  { kind: "pleasure", text: "here's some good news:" },
  { kind: "pain", text: "i can't believe they're doing that to you..." },
  { kind: "pain", text: "don't tell [brand] about this..." },
  { kind: "curiosity", text: "you know what's better than peptides?" },
  { kind: "curiosity", text: "i bet you don't have this yet..." },
];

export interface OutreachSettings {
  templates: Partial<Record<TemplateId, string>>;
  gaps: Array<{ kind: GapKind; text: string }>;
  detailsLink: string;
  aroDetailsLink: string;
  aroCommission: string;
  aroCookie: string;
  checkinDays: number;
}

export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = {
  templates: {},
  gaps: DEFAULT_CURIOSITY_GAPS,
  detailsLink: "",
  aroDetailsLink: "",
  aroCommission: "",
  aroCookie: "",
  checkinDays: 3,
};

/** Stored settings merged over the defaults; anything malformed falls back. */
export function outreachSettings(stored: unknown): OutreachSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<OutreachSettings>;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const templates: Partial<Record<TemplateId, string>> = {};
  for (const [k, v] of Object.entries(s.templates ?? {})) if (k in DEFAULT_TEMPLATES && typeof v === "string" && v.trim()) templates[k as TemplateId] = v;
  const gaps = Array.isArray(s.gaps) ? s.gaps.filter((g) => g && typeof g.text === "string" && g.text.trim() && ["pleasure", "pain", "curiosity"].includes(g.kind)) : [];
  const days = Number(s.checkinDays);
  return {
    templates,
    gaps: gaps.length ? gaps : DEFAULT_CURIOSITY_GAPS,
    detailsLink: str(s.detailsLink, ""),
    aroDetailsLink: str(s.aroDetailsLink, ""),
    aroCommission: str(s.aroCommission, ""),
    aroCookie: str(s.aroCookie, ""),
    checkinDays: Number.isFinite(days) && days >= 1 && days <= 30 ? Math.round(days) : 3,
  };
}

export interface RenderVars {
  curiosityGap: string;
  recruiterName: string;
  brand: string | null;
  creatorFirstName: string | null;
  settings: OutreachSettings;
}

/** Fills the placeholders the system knows. Others ("[name or nickname]") are part of the copy
 *  and stay. `missing` lists known placeholders with no value, so the message isn't sent half-filled. */
export function renderTemplate(templateId: TemplateId, vars: RenderVars): { text: string; missing: string[] } {
  const body = vars.settings.templates[templateId] ?? DEFAULT_TEMPLATES[templateId].body;
  const missing: string[] = [];
  const firstName = vars.creatorFirstName?.trim() || "";
  const values: Record<string, string> = {
    name: vars.recruiterName.split(" ")[0] ?? vars.recruiterName,
    brand: vars.brand ?? "",
    "first name": firstName || "friend",
    intro: firstName ? `happy to share, ${firstName}!` : "happy to share!",
    "details link": vars.settings.detailsLink,
    "aro details link": vars.settings.aroDetailsLink,
    "aro commission": vars.settings.aroCommission,
    "aro cookie": vars.settings.aroCookie,
  };
  // "[curiosity gap]." keeps the line's own ending: "want to make more money?" gets no extra full stop.
  const gap = vars.curiosityGap.trim();
  const withGap = body.replace(/\[curiosity gap\]\.?/gi, (m) => (/[?!.…:]$/.test(gap) || !m.endsWith(".") ? gap : `${gap}.`) || m);
  // The gap line may itself hold [brand].
  const fill = (text: string) =>
    text.replace(/\[([a-z ]+)\]/gi, (whole, key: string) => {
      const k = key.toLowerCase();
      if (!(k in values)) return whole;
      if (!values[k]) {
        missing.push(k);
        return whole;
      }
      return values[k]!;
    });
  const text = fill(fill(withGap));
  if (!gap) missing.push("curiosity gap");
  return { text, missing: [...new Set(missing)] };
}

/** The opening line for a lead: rotates through the gaps by lead id so every line gets used. */
export function gapIndexFor(leadId: number, gapCount: number): number {
  return gapCount > 0 ? Math.floor(leadId / 2) % gapCount : 0;
}
