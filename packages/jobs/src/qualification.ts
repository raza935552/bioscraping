// Outreach qualification from the flow chart (core/outreach-path.ts): link each signed lead to
// one competitor, read that competitor's commission rate, and keep drafts away from anyone who
// doesn't qualify.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { isQualifiedPath, outreachPath, type OutreachPath } from "@biolinx/core";
import { schema, type Db } from "@biolinx/db";
import { compact, mentionIndex } from "@biolinx/scraping";

type CompetitorRow = Pick<typeof schema.competitors.$inferSelect, "id" | "name" | "domains" | "commissionPct" | "active">;

/** Short or common words that name a competitor only inside the research board's
 *  "Other creator company" field, never in scraped captions ("Flawless" alone is a normal word). */
const FIELD_ONLY_ALIASES: Record<string, string[]> = {
  "Flawless Compounds": ["flawless"],
  "Ion Peptide": ["ion"],
  "Ascension Peptides": ["ascension"],
  "True Peptide": ["true peptide"],
};

/** The competitor named first in the text, or null. "Unnamed source" and similar name nobody. */
export function linkCompetitor(text: string | null | undefined, competitors: Array<Pick<CompetitorRow, "id" | "name" | "domains">>): number | null {
  if (!text?.trim()) return null;
  const lower = text.toLowerCase();
  const squashed = compact(text);
  let best: { id: number; at: number } | null = null;
  for (const c of competitors) {
    const needles = [c.name, ...(((c.domains as string[] | null) ?? []).map((d) => d.replace(/\.[a-z]{2,}$/i, ""))), ...(FIELD_ONLY_ALIASES[c.name] ?? [])];
    let at = Infinity;
    for (const n of needles) {
      const i = mentionIndex(lower, n);
      if (i >= 0) at = Math.min(at, i);
      else {
        const sq = compact(n);
        if (sq.length >= 8 && squashed.includes(sq)) at = Math.min(at, 10_000 + squashed.indexOf(sq));
      }
    }
    if (at !== Infinity && (!best || at < best.at)) best = { id: c.id, at };
  }
  return best?.id ?? null;
}

export function ratesById(competitors: Array<Pick<CompetitorRow, "id" | "commissionPct">>): Map<number, number | null> {
  return new Map(competitors.map((c) => [c.id, c.commissionPct ?? null]));
}

export function pathOf(lead: { affiliationStatus: string | null; competitorId: number | null }, rates: Map<number, number | null>): OutreachPath {
  return outreachPath(lead, lead.competitorId != null ? rates.get(lead.competitorId) : null);
}

/** Links signed leads that have no competitor yet. Safe to run repeatedly: a lead a person
 *  or an earlier run already linked is never changed. */
export async function linkLeadCompetitors(db: Db): Promise<{ checked: number; linked: number }> {
  const competitors = await db.select().from(schema.competitors);
  const leads = await db
    .select({ id: schema.leads.id, company: schema.leads.otherCreatorCompany, promoted: schema.leads.whatTheyPromoted })
    .from(schema.leads)
    .where(and(eq(schema.leads.affiliationStatus, "Signed elsewhere"), isNull(schema.leads.competitorId)));
  let linked = 0;
  for (const l of leads) {
    const id = linkCompetitor([l.company, l.promoted].filter(Boolean).join(" ; "), competitors);
    if (id == null) continue;
    await db.update(schema.leads).set({ competitorId: id }).where(and(eq(schema.leads.id, l.id), isNull(schema.leads.competitorId)));
    linked++;
  }
  return { checked: leads.length, linked };
}

/** Drafts not yet sent for leads that don't qualify are blocked, with the reason in the lint report. */
export async function blockUnqualifiedDrafts(db: Db): Promise<{ blocked: number[] }> {
  const pending = await db.select().from(schema.messages).where(inArray(schema.messages.state, ["drafted", "linted", "approved"]));
  if (pending.length === 0) return { blocked: [] };
  const rates = ratesById(await db.select().from(schema.competitors));
  const leads = new Map(
    (await db.select({ id: schema.leads.id, affiliationStatus: schema.leads.affiliationStatus, competitorId: schema.leads.competitorId }).from(schema.leads).where(inArray(schema.leads.id, [...new Set(pending.map((m) => m.leadId))]))).map((l) => [l.id, l]),
  );
  const blocked: number[] = [];
  for (const m of pending) {
    const lead = leads.get(m.leadId);
    const path = lead ? pathOf(lead, rates) : "unsigned";
    if (isQualifiedPath(path)) continue;
    const report = { ...((m.lintReport as Record<string, unknown> | null) ?? {}), notQualified: path };
    await db.update(schema.messages).set({ state: "blocked", lintReport: report }).where(and(eq(schema.messages.id, m.id), eq(schema.messages.state, m.state)));
    blocked.push(m.id);
  }
  return { blocked };
}
