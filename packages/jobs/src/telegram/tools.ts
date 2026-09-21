// What the assistant can look up in the engine while it answers. Every tool is a read: there is no
// way from a chat message to change a lead, a message, a setting or a person. Results are capped so
// one question can never pull the database into a chat, and contact details are only ever returned
// for one lead at a time, never as a list.

import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { schema, type Db } from "@biolinx/db";

export interface AssistantTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "find_leads",
    description:
      "Search the creators in the engine. Use it for 'who did we find', 'show me the leads from <brand>', 'which leads are waiting', 'how many US leads'. Returns up to 25 rows, newest first, with handle, followers, competitor, code, country, review status and what stage of outreach they are at. No email or phone: use lead_detail for one person.",
    input_schema: {
      type: "object",
      properties: {
        competitor: { type: "string", description: "Competitor brand name, or part of it" },
        review: { type: "string", enum: ["pending", "accepted", "rejected", "any"], description: "Sourcing review status" },
        status: { type: "string", description: "Outreach status, e.g. 'Not contacted', 'Contacted', 'Signed'" },
        country: { type: "string", description: "Two-letter country code, e.g. US" },
        niche: { type: "string", description: "Niche, e.g. 'Weight-loss seeker', 'Biohacker'" },
        has_code: { type: "boolean", description: "Only creators who published a competitor discount code" },
        since_days: { type: "number", description: "Only ones added in the last N days" },
        search: { type: "string", description: "Free text against name, handle or competitor" },
        limit: { type: "number", description: "Rows to return, max 25" },
      },
    },
  },
  {
    name: "lead_detail",
    description:
      "Everything on one creator by id: stats, the post that surfaced them, the competitor words they used, their code, contact details, and their outreach history. Use only when someone asks about a specific person.",
    input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "list_competitors",
    description:
      "The competitor brands the engine searches, with how many leads each has produced and whether their commission rate is known.",
    input_schema: { type: "object", properties: { active_only: { type: "boolean" } } },
  },
  {
    name: "sourcing_runs",
    description:
      "The nightly sourcing runs: when they ran, how many creators they added, what they cost, and why each audience stopped. Use for 'did the scrape run', 'what did it find', 'why so few'.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "How many runs, max 14" } } },
  },
  {
    name: "affiliate_list",
    description:
      "The affiliates in the affiliate platform, with whether each counts toward the 100 goal and whether we hold their discount code.",
    input_schema: { type: "object", properties: { classification: { type: "string", enum: ["external", "internal", "unresolved", "any"] } } },
  },
  {
    name: "outreach_activity",
    description:
      "Messages sent, replies logged and sign-ups recorded, newest first: who, when, which template, and what came back. Use for 'have we messaged anyone', 'what did they say'.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "Rows, max 20" } } },
  },
  {
    name: "open_requests",
    description: "Requests logged from chat for Raza, with their status.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "doing", "done", "declined", "any"] } } },
  },
];

const cap = (n: unknown, fallback: number, max: number) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : fallback;
};

const nameOf = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";
const handleOf = (social: string | null) => /@([A-Za-z0-9._-]+)/.exec(social ?? "")?.[1] ?? null;

/** Runs one tool and returns what goes back to the model. Never throws: an error is an answer too. */
export async function runAssistantTool(db: Db, name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "find_leads":
        return await findLeads(db, input);
      case "lead_detail":
        return await leadDetail(db, Number(input.id));
      case "list_competitors":
        return await listCompetitors(db, input.active_only !== false);
      case "sourcing_runs":
        return await sourcingRuns(db, cap(input.limit, 5, 14));
      case "affiliate_list":
        return await affiliateList(db, String(input.classification ?? "any"));
      case "outreach_activity":
        return await outreachActivity(db, cap(input.limit, 10, 20));
      case "open_requests":
        return await openRequests(db, String(input.status ?? "open"));
      default:
        return `No tool called ${name}.`;
    }
  } catch (e) {
    return `That lookup failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

async function findLeads(db: Db, input: Record<string, unknown>): Promise<string> {
  const limit = cap(input.limit, 15, 25);
  const where = [] as unknown[];
  const review = String(input.review ?? "");
  if (review && review !== "any") where.push(eq(schema.leads.sourcingReview, review));
  if (input.status) where.push(eq(schema.leads.status, String(input.status)));
  if (input.country) where.push(eq(schema.leads.geoCountry, String(input.country).toUpperCase()));
  if (input.niche) where.push(eq(schema.leads.niche, String(input.niche)));
  if (input.has_code === true) where.push(sql`${schema.leads.affiliateCode} is not null and ${schema.leads.affiliateCode} <> ''`);
  if (input.since_days) where.push(gte(schema.leads.createdAt, new Date(Date.now() - cap(input.since_days, 7, 365) * 86_400_000)));
  if (input.search) {
    const q = `%${String(input.search)}%`;
    where.push(or(like(schema.leads.firstName, q), like(schema.leads.lastName, q), like(schema.leads.socialProfiles, q), like(schema.leads.otherCreatorCompany, q)));
  }

  const competitors = await db.select().from(schema.competitors);
  if (input.competitor) {
    const want = String(input.competitor).toLowerCase();
    const ids = competitors.filter((c) => c.name.toLowerCase().includes(want)).map((c) => c.id);
    if (ids.length === 0) return `No competitor matches "${input.competitor}". Known brands: ${competitors.map((c) => c.name).join(", ")}.`;
    where.push(inArray(schema.leads.competitorId, ids));
  }

  const rows = await db
    .select()
    .from(schema.leads)
    .where(where.length ? and(...(where as never[])) : undefined)
    .orderBy(desc(schema.leads.id))
    .limit(limit);
  if (rows.length === 0) return "No leads match that.";
  const byId = new Map(competitors.map((c) => [c.id, c.name]));
  const lines = rows.map((l) => {
    const bits = [
      `#${l.id} ${nameOf(l)}`,
      handleOf(l.socialProfiles) ? `@${handleOf(l.socialProfiles)}` : null,
      l.primaryPlatform,
      l.totalReach != null ? `${l.totalReach} followers` : null,
      l.geoCountry ?? "country unknown",
      l.competitorId ? (byId.get(l.competitorId) ?? l.otherCreatorCompany) : l.otherCreatorCompany,
      l.affiliateCode ? `code ${l.affiliateCode}` : null,
      l.sourcingReview ? `review: ${l.sourcingReview}` : "imported",
      l.status,
    ].filter(Boolean);
    return `- ${bits.join(" · ")}`;
  });
  return `${rows.length} shown (newest first):\n${lines.join("\n")}`;
}

async function leadDetail(db: Db, id: number): Promise<string> {
  const l = await db.query.leads.findFirst({ where: eq(schema.leads.id, id) });
  if (!l) return `No lead #${id}.`;
  const competitor = l.competitorId ? await db.query.competitors.findFirst({ where: eq(schema.competitors.id, l.competitorId) }) : null;
  const messages = await db.select().from(schema.messages).where(eq(schema.messages.leadId, id)).orderBy(desc(schema.messages.id)).limit(5);
  const replies = await db.select().from(schema.replies).where(eq(schema.replies.leadId, id)).orderBy(desc(schema.replies.id)).limit(5);
  return [
    `#${l.id} ${nameOf(l)}${handleOf(l.socialProfiles) ? ` (@${handleOf(l.socialProfiles)})` : ""}`,
    `Platform: ${l.primaryPlatform ?? "unknown"} · ${l.totalReach ?? "?"} followers · ${l.geoCountry ?? "country unknown"} · niche ${l.niche ?? "unknown"}`,
    `Competitor: ${competitor?.name ?? l.otherCreatorCompany ?? "none found"}${l.affiliateCode ? `, code ${l.affiliateCode}` : ""}`,
    `Review: ${l.sourcingReview ?? "imported (not from sourcing)"}${l.sourcingRejectedReason ? ` — ${l.sourcingRejectedReason}` : ""}`,
    `Outreach: ${l.status ?? "?"} · ${l.followUpsSent ?? 0} messages sent${l.lastReachedOut ? `, last on ${new Date(l.lastReachedOut).toISOString().slice(0, 10)}` : ""}`,
    l.email ? `Email on file: ${l.email}` : "No email on file",
    l.whereFound ? `Found at: ${l.whereFound}` : null,
    l.personalizationNotes ? `Notes: ${l.personalizationNotes.slice(0, 400)}` : null,
    messages.length ? `Messages: ${messages.map((m) => `${m.state} ${m.channel}${m.sentAt ? ` on ${new Date(m.sentAt).toISOString().slice(0, 10)}` : ""}`).join("; ")}` : "No messages yet",
    replies.length ? `Replies: ${replies.map((r) => `${r.classifiedAs ?? "?"}: ${(r.body ?? "").slice(0, 120)}`).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function listCompetitors(db: Db, activeOnly: boolean): Promise<string> {
  const rows = await db.select().from(schema.competitors);
  const leads = await db.select({ competitorId: schema.leads.competitorId }).from(schema.leads);
  const counts = new Map<number, number>();
  for (const l of leads) if (l.competitorId != null) counts.set(l.competitorId, (counts.get(l.competitorId) ?? 0) + 1);
  const shown = rows.filter((c) => (activeOnly ? c.active : true)).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  return `${shown.length} brands${activeOnly ? " searched nightly" : ""}:\n${shown
    .map((c) => `- ${c.name}: ${counts.get(c.id) ?? 0} leads${c.commissionPct != null ? `, pays ${c.commissionPct}%` : ", rate unknown"}${c.active ? "" : " (not searched)"}`)
    .join("\n")}`;
}

async function sourcingRuns(db: Db, limit: number): Promise<string> {
  const runs = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "lead-ingest")).orderBy(desc(schema.syncRuns.id)).limit(limit);
  if (runs.length === 0) return "No sourcing runs recorded.";
  return runs
    .map((r) => {
      const d = (r.detail ?? {}) as { inserted?: number; estimatedCostUsd?: number; profiles?: Array<{ name?: string; inserted?: number; stoppedBy?: string; quality?: Record<string, number> }> };
      const per = (d.profiles ?? [])
        .map((p) => `${p.name}: +${p.inserted ?? 0}${p.stoppedBy ? ` (stopped by ${p.stoppedBy})` : ""}`)
        .join("; ");
      return `${r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ") : "?"} — ${r.status}, added ${d.inserted ?? 0} for $${d.estimatedCostUsd ?? 0}${per ? `. ${per}` : ""}`;
    })
    .join("\n");
}

async function affiliateList(db: Db, classification: string): Promise<string> {
  const rows = await db.select().from(schema.affiliates);
  const shown = classification === "any" ? rows : rows.filter((a) => a.classification === classification);
  const withCode = shown.filter((a) => a.couponCode).length;
  return `${shown.length} affiliates${classification === "any" ? "" : ` (${classification})`}, ${withCode} with a discount code on file:\n${shown
    .slice(0, 60)
    .map((a) => `- ${[a.firstName, a.lastName].filter(Boolean).join(" ") || a.username || `#${a.idevId}`}${a.couponCode ? ` · code ${a.couponCode}` : ""} · ${a.classification}`)
    .join("\n")}`;
}

async function outreachActivity(db: Db, limit: number): Promise<string> {
  const messages = await db.select().from(schema.messages).orderBy(desc(schema.messages.id)).limit(limit);
  const replies = await db.select().from(schema.replies).orderBy(desc(schema.replies.id)).limit(limit);
  const signups = await db.select().from(schema.signups).orderBy(desc(schema.signups.id)).limit(limit);
  const leadIds = [...new Set([...messages.map((m) => m.leadId), ...replies.map((r) => r.leadId)])];
  const leads = leadIds.length ? await db.select().from(schema.leads).where(inArray(schema.leads.id, leadIds)) : [];
  const name = (id: number) => {
    const l = leads.find((x) => x.id === id);
    return l ? nameOf(l) : `lead #${id}`;
  };
  return [
    `Messages (${messages.length}):`,
    ...messages.map((m) => `- ${name(m.leadId)}: ${m.state} ${m.channel}${m.sentAt ? ` on ${new Date(m.sentAt).toISOString().slice(0, 10)}` : ""}`),
    `Replies (${replies.length}):`,
    ...replies.map((r) => `- ${name(r.leadId)}: ${r.classifiedAs ?? "unclassified"} — ${(r.body ?? "").slice(0, 140)}`),
    `Sign-ups (${signups.length}):`,
    ...signups.map((s) => `- ${s.firstName} ${s.lastName}, ${s.status}${s.couponWordSuggestion ? `, asked for code ${s.couponWordSuggestion}` : ""}`),
  ].join("\n");
}

async function openRequests(db: Db, status: string): Promise<string> {
  const rows = await db.select().from(schema.tasks).orderBy(desc(schema.tasks.id)).limit(30);
  const shown = status === "any" ? rows : rows.filter((t) => t.status === status);
  if (shown.length === 0) return status === "open" ? "Nothing open." : `No requests with status ${status}.`;
  return shown.map((t) => `#${t.id} [${t.status}] ${t.title} — asked by ${t.askedBy ?? "someone"}${t.pushedBack ? " (pushed back)" : ""}`).join("\n");
}
