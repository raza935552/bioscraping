// The L-rules (MASTER-PLAN §4.4) — deterministic, runs on EVERY outbound
// string. A violation with severity "block" stops the send; the message row
// moves to state "blocked" and an alert fires.
//
// Hardened after the 2026-09-01 red-team: banned terms match a normalized
// SKELETON (defeats homoglyph/leet/spacing), links de-obfuscate 'dot com',
// claims/personal-use use proximity patterns, earnings need an ADJACENT
// qualifier, and subject lines are linted by the caller.

import {
  BANNED_DRUG_SKELETONS,
  BANNED_PHRASES,
  BARE_DOMAIN,
  EARNINGS_CLAIM_PATTERNS,
  OPENER_COMMISSION,
  PERSONAL_USE_PATTERNS,
  RESTRICTED_SKU_SKELETONS,
  RUO_LINE,
} from "./lists/banned-terms.js";
import { alnumSkeleton, deobfuscateDomains, foldConfusables, skeleton } from "./normalize.js";

export interface LintContext {
  channel: "email" | "dm";
  touchNumber: number; // 1 = opener
  isPublic: boolean; // public/forwardable content requires the RUO line
  audience: "prospect" | "affiliate" | "internal";
  /** L5 inputs (email only) */
  hasUnsubscribeLink?: boolean;
  hasPostalAddress?: boolean;
  recipientCountry?: string | null;
  emailProvenance?: "published_business" | "scraped" | "client_provided" | null;
  isSuppressed?: boolean;
  /** Wording the marketing team wrote for the outreach flow (outreach-templates.ts). Their
   *  offers name the commission and run past 5 sentences on purpose, so the two L2 rules made
   *  for AI-written cold messages (no commission in an opener, 5 sentences max) don't apply.
   *  Every other rule does: drugs, claims, personal use, dashes, links, SKUs, CAN-SPAM, earnings. */
  approvedCopy?: boolean;
}

export interface LintViolation {
  rule: string;
  severity: "block" | "warn";
  detail: string;
}

/** Qualifier must sit ADJACENT to an earnings figure, not merely in the text. */
const HISTORICAL_ADJACENT = /(rate retired|historical)[^.?!]{0,40}(\$\s?\d|\d+\s?%|epc)|(\$\s?\d[^.?!]{0,40}|\d+\s?%[^.?!]{0,40}|epc[^.?!]{0,40})(rate retired|historical)/i;

export function lint(text: string, ctx: LintContext): LintViolation[] {
  const v: LintViolation[] = [];
  const push = (rule: string, severity: "block" | "warn", detail: string) => v.push({ rule, severity, detail });

  const folded = foldConfusables(text); // homoglyph → ASCII, for phrase regexes
  const skel = skeleton(text); // letters-only, for contiguous-term evasion
  const alnum = alnumSkeleton(text); // keeps digits, for SKU codes (G2T)
  const deObf = deobfuscateDomains(text); // 'dot com' → '.com'

  // L1 — banned drug names (skeleton defeats homoglyph/leet/spacing)
  for (const { pattern, useInstead } of BANNED_DRUG_SKELETONS) {
    if (pattern.test(skel)) push("L1-drug-name", "block", `banned drug name (skeleton ${pattern}) — use ${useInstead}`);
  }
  // Claim + personal-use phrases match the folded (homoglyph-cleaned) text.
  for (const p of BANNED_PHRASES) {
    if (p.test(folded)) push("L1-claim-phrase", "block", `banned/claim phrase ${p}`);
  }
  for (const p of PERSONAL_USE_PATTERNS) {
    if (p.test(folded)) push("L1-personal-use", "block", `implies personal use: ${p}`);
  }

  // L2 — template contract (prospect-facing messages)
  if (ctx.audience === "prospect") {
    if (/[—–]/.test(text)) push("L2-em-dash", "block", "em/en dash in outbound copy (use a comma or full stop)");
    // Count sentence terminators (whitespace optional — defeats "One.Two.Three").
    const sentences = folded.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length > 5 && !ctx.approvedCopy) push("L2-length", "block", `${sentences.length} sentences (max 5)`);
    if (ctx.touchNumber === 1) {
      if (OPENER_COMMISSION.test(folded) && !ctx.approvedCopy) push("L2-opener-commission", "block", "commission figure in an opener");
      // Links in a first message. Email openers may carry ONLY the unsubscribe
      // link; any other domain (scheme-less or 'dot com') is a violation.
      // Strip whole unsubscribe URLs first so their domain token isn't flagged.
      const withoutUnsub = deObf.replace(/\S*unsub\w*\S*/gi, " ");
      const explicitUrls = withoutUnsub.match(/https?:\/\/\S+/gi) ?? [];
      const domains = withoutUnsub.match(new RegExp(BARE_DOMAIN, "gi")) ?? [];
      const offending = [...explicitUrls, ...domains];
      if (offending.length > 0) push("L2-opener-link", "block", `link in a first message: ${offending[0]}`);
    }
  }

  // L3 — restricted SKUs + RUO line
  if (ctx.audience === "prospect" || ctx.isPublic) {
    for (const p of RESTRICTED_SKU_SKELETONS) {
      if (p.test(alnum)) push("L3-restricted-sku", "block", `restricted product named (skeleton ${p})`);
    }
  }
  if (ctx.isPublic && !text.includes(RUO_LINE)) {
    push("L3-ruo-line", "block", "public content missing the research-use-only line");
  }

  // L5 — CAN-SPAM mechanics (email only)
  if (ctx.channel === "email") {
    if (ctx.isSuppressed) push("L5-suppressed", "block", "recipient is on the suppression list");
    if (!ctx.hasUnsubscribeLink) push("L5-unsubscribe", "block", "email missing unsubscribe link");
    if (!ctx.hasPostalAddress) push("L5-postal", "block", "email missing physical postal address");
    if (ctx.recipientCountry && ctx.recipientCountry !== "US") {
      push("L5-geo", "block", `automated email to non-US recipient (${ctx.recipientCountry})`);
    }
    if (ctx.emailProvenance === "scraped") {
      push("L5-provenance", "block", "harvested/scraped address — route to human queue, never auto-email");
    }
  }

  // L7 — earnings claims (qualifier must be ADJACENT to the figure)
  for (const p of EARNINGS_CLAIM_PATTERNS) {
    if (p.test(folded) && !HISTORICAL_ADJACENT.test(folded)) {
      push("L7-earnings", "block", `earnings figure without an adjacent historical qualifier: ${p}`);
    }
  }

  return v;
}

export function isBlocked(violations: LintViolation[]): boolean {
  return violations.some((x) => x.severity === "block");
}

/** Lint an email as a unit — subject + body both pass the same rules. */
export function lintEmail(subject: string | null, body: string, ctx: LintContext): LintViolation[] {
  const bodyViolations = lint(body, ctx);
  if (!subject) return bodyViolations;
  const subjectViolations = lint(subject, ctx).map((x) => ({ ...x, rule: `subject:${x.rule}` }));
  return [...subjectViolations, ...bodyViolations];
}
