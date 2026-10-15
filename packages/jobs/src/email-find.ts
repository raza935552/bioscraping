// Finds business addresses for leads we already have, so email outreach has somewhere to go.
//
// Raza, 2026-10-15: 42 of 695 leads had an email and every one was scraped out of a bio, which the
// linter refuses to mail automatically. Meanwhile 186 leads had a link hub or a website on file and
// no address at all. This job walks those links — plain fetches from our own server, no Apify, no
// cost — and saves what the creator published for business on their own pages.
//
// What it will not do: guess an address (first.last@domain), buy one from a finder service, or
// promote a bio address to "published_business". A guessed address bounces, and bounces burn the
// sending domain for the addresses that are real.

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@biolinx/db";
import { normalizeEmail } from "@biolinx/core";
import { findBusinessEmail, normalizeUrl, type FoundEmail } from "@biolinx/scraping";
import { handleOf } from "./sourced-details.js";

export interface EmailFindSummary {
  /** Leads looked at this run. */
  checked: number;
  found: number;
  /** Found, but the address already belongs to someone else in the database. */
  duplicate: number;
  /** A link hub that led to their own site, which we saved for next time. */
  sitesLearned: number;
  pagesFetched: number;
  nothing: number;
  /** The link in their bio was a brand's store or a coupon page: nothing there is theirs. */
  brandStore: number;
  /** Addresses were on the page, but on somebody else's domain. */
  notTheirs: number;
  samples: Array<{ leadId: number; email: string; how: FoundEmail["how"]; foundAt: string }>;
}

export interface EmailFindOptions {
  /** Leads per run. Each one is a handful of plain fetches, so this is about politeness, not cost. */
  cap?: number;
  /** Only this lead, for checking one by hand from the admin. */
  leadId?: number;
  fetchImpl?: typeof fetch;
  /** Found addresses are written unless this is false (the admin's dry run). */
  write?: boolean;
}

/** Leads worth a look: accepted or waiting, not dead, a link on file, and no address we can mail. */
async function candidates(db: Db, opts: EmailFindOptions) {
  const rows = await db
    .select({
      id: schema.leads.id,
      website: schema.leads.websiteUrl,
      email: schema.leads.email,
      provenance: schema.leads.emailProvenance,
      rank: schema.leads.conversionRank,
      firstName: schema.leads.firstName,
      lastName: schema.leads.lastName,
      social: schema.leads.socialProfiles,
    })
    .from(schema.leads)
    .where(
      and(
        isNotNull(schema.leads.websiteUrl),
        eq(schema.leads.isDead, false),
        or(isNull(schema.leads.sourcingReview), inArray(schema.leads.sourcingReview, ["accepted", "pending"])),
        opts.leadId ? eq(schema.leads.id, opts.leadId) : sql`1 = 1`,
        // Nothing to gain where a business address is already on file.
        or(isNull(schema.leads.email), sql`${schema.leads.emailProvenance} = 'scraped'`),
      ),
    )
    .orderBy(sql`${schema.leads.conversionRank} is null, ${schema.leads.conversionRank}`)
    .limit(opts.leadId ? 1 : (opts.cap ?? 40));
  return rows;
}

export async function runEmailFind(db: Db, opts: EmailFindOptions = {}): Promise<EmailFindSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const write = opts.write !== false;
  const summary: EmailFindSummary = { checked: 0, found: 0, duplicate: 0, sitesLearned: 0, pagesFetched: 0, nothing: 0, brandStore: 0, notTheirs: 0, samples: [] };
  const rows = await candidates(db, opts);
  if (rows.length === 0) return summary;

  // Nothing is read off a competitor's domain, and no address on one is ever kept: a creator's link
  // in bio is usually the brand's shop, so the first live run found support@<competitor> for five
  // leads before this existed (2026-10-15).
  const rejectDomains = (await db.select().from(schema.competitors))
    .flatMap((c) => (Array.isArray(c.domains) ? (c.domains as unknown[]) : []))
    .map((d) => String(d).replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase())
    .filter((d) => d.includes("."));

  // Every address already in the database, so a shared agency inbox isn't saved onto two leads.
  const taken = new Set(
    (await db.select({ e: schema.leads.emailNormalized }).from(schema.leads).where(isNotNull(schema.leads.emailNormalized)))
      .map((r) => r.e)
      .filter((e): e is string => !!e),
  );

  for (const lead of rows) {
    summary.checked++;
    const start = normalizeUrl(lead.website);
    if (!start) continue;
    // Their own name and handle: an address only counts as theirs if its domain looks like one.
    const creatorTokens = [
      [lead.firstName, lead.lastName].filter(Boolean).join(" "),
      handleOf(lead.social) ?? "",
    ].filter((t) => t.trim().length >= 5);
    const res = await findBusinessEmail(start, { fetchImpl, rejectDomains, creatorTokens });
    summary.pagesFetched += res.pages;
    if (res.skipped === "affiliate_link" || res.skipped === "rejected_domain") summary.brandStore++;
    if (res.skipped === "not_their_domain") summary.notTheirs++;
    // A hub that led to their own site: save it, so next time we start a hop further along.
    const learned = res.site && res.site !== start ? res.site.slice(0, 500) : null;
    if (learned && write) {
      await db.update(schema.leads).set({ websiteUrl: learned }).where(eq(schema.leads.id, lead.id));
      summary.sitesLearned++;
    }
    if (!res.found) {
      summary.nothing++;
      continue;
    }
    const normalized = normalizeEmail(res.found.email);
    if (taken.has(normalized)) {
      summary.duplicate++;
      continue;
    }
    taken.add(normalized);
    summary.found++;
    if (summary.samples.length < 20) summary.samples.push({ leadId: lead.id, email: res.found.email, how: res.found.how, foundAt: res.found.foundAt });
    if (!write) continue;
    await db
      .update(schema.leads)
      .set({ email: res.found.email, emailNormalized: normalized, emailProvenance: "published_business" })
      .where(eq(schema.leads.id, lead.id));
    await db.insert(schema.auditLog).values({
      actorJob: "email-find",
      action: "lead.email.found",
      subjectTable: "leads",
      subjectId: lead.id,
      // The address itself is PII and lives in the leads row; the audit says where it came from.
      detail: { how: res.found.how, foundAt: res.found.foundAt, replacedScraped: lead.provenance === "scraped" },
    });
  }
  return summary;
}
