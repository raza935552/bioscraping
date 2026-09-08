// API entry — Fastify. Session auth (invite-only), admin data endpoints,
// store-webhook receiver. All admin routes require a valid session; mutations
// are role-gated and audit-logged.

import { loadEnv } from "@biolinx/core";
loadEnv();

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import {
  connect,
  hydrateEnvFromSettings,
  readSettingsForUi,
  recomputeProgramStatus,
  saveSettings,
  schema,
  withMysqlLock,
} from "@biolinx/db";
import {
  hasUsableNotes,
  isConverted,
  isSp5,
  suggestClassification,
  BLACK_FRIDAY,
  EXTERNAL_AFFILIATE_GOAL,
  SETTINGS_SECTIONS,
} from "@biolinx/core";
import {
  approveMessage,
  confirmSent,
  confirmSignup,
  ingestReply,
  instantlyPusher,
  provisionSignup,
  runEnrichPersonalize,
  runIdevSync,
  runMetricsDigest,
  runOutreachDispatch,
  runRankRecompute,
  runReferralExpiry,
  setupRecruitingCampaign,
} from "@biolinx/jobs";
import { anthropicFromEnv } from "@biolinx/drafting";
import { instantlyFromEnv, listAccounts, listCampaigns } from "@biolinx/instantly";
import {
  SESSION_COOKIE,
  dummyVerify,
  hashPassword,
  issueSessionToken,
  newInviteToken,
  verifyPassword,
  verifySessionToken,
} from "./auth.js";

const conn = connect();
const db = conn.db;

// Pull any UI-managed secrets/config out of the DB into process.env before
// anything reads them.
await hydrateEnvFromSettings(db);

const app = Fastify({
  // Redact secrets from request logs (defense in depth alongside URL redaction).
  logger: {
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-webhook-secret"]', 'req.headers["x-signature"]'],
      remove: true,
    },
  },
  trustProxy: true, // behind Caddy/Cloudflare
});

// ── Security middleware ──────────────────────────────────────────────────
await app.register(fastifyHelmet, {
  contentSecurityPolicy: false, // the admin SPA sets its own; API serves JSON
});
await app.register(fastifyCors, {
  origin: process.env.ADMIN_ORIGIN ? process.env.ADMIN_ORIGIN.split(",") : true,
  credentials: true,
});
await app.register(fastifyRateLimit, {
  global: false, // opt-in per route; auth routes get the tight limit
  max: 300,
  timeWindow: "1 minute",
});
await app.register(fastifyCookie);

type SessionUser = typeof schema.users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

app.decorateRequest("user", null);

app.addHook("preHandler", async (req) => {
  const session = verifySessionToken(req.cookies[SESSION_COOKIE]);
  if (session == null) return;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.userId) });
  // Token is valid only if the user is active AND its epoch still matches
  // (logout bumps the epoch, revoking every prior token).
  req.user = user && user.isActive && user.sessionEpoch === session.epoch ? user : null;
});

const requireAuth = async (req: any, reply: any) => {
  if (!req.user) return reply.code(401).send({ error: "not authenticated" });
};
const requireRole = (...roles: string[]) =>
  async (req: any, reply: any) => {
    if (!req.user) return reply.code(401).send({ error: "not authenticated" });
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: "forbidden" });
  };

async function audit(req: { user: SessionUser | null }, action: string, subjectTable: string, subjectId: number | null, detail: unknown) {
  await db.insert(schema.auditLog).values({
    actorUserId: req.user?.id ?? null,
    action,
    subjectTable,
    subjectId,
    detail,
  });
}

// ── Health ──────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, service: "biolinx-affiliate-engine" }));

// ── Auth ────────────────────────────────────────────────────────────────

app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) return reply.code(400).send({ error: "email and password required" });
  const user = await db.query.users.findFirst({
    where: eq(schema.users.email, email.trim().toLowerCase()),
  });
  // Always run a scrypt verification (real or dummy) so timing doesn't reveal
  // whether the email belongs to a real account.
  const ok = user && user.isActive ? verifyPassword(password, user.passwordHash) : (dummyVerify(password), false);
  if (!user || !ok) {
    return reply.code(401).send({ error: "invalid credentials" });
  }
  await audit({ user }, "auth.login", "users", user.id, {});
  return reply
    .setCookie(SESSION_COOKIE, issueSessionToken(user.id, user.sessionEpoch), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
      secure: process.env.NODE_ENV === "production",
    })
    .send({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post("/api/auth/accept-invite", async (req, reply) => {
  const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
  if (!token || !password || password.length < 10) {
    return reply.code(400).send({ error: "token and a password of at least 10 characters required" });
  }
  const user = await db.query.users.findFirst({ where: eq(schema.users.inviteToken, token) });
  if (!user || user.activatedAt) return reply.code(400).send({ error: "invalid or used invite" });
  await db
    .update(schema.users)
    .set({ passwordHash: hashPassword(password), activatedAt: new Date(), inviteToken: null })
    .where(eq(schema.users.id, user.id));
  await audit({ user }, "auth.invite_accepted", "users", user.id, {});
  return reply
    .setCookie(SESSION_COOKIE, issueSessionToken(user.id, user.sessionEpoch), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
      secure: process.env.NODE_ENV === "production",
    })
    .send({ ok: true });
});

app.post("/api/auth/logout", async (req, reply) => {
  // Bump the user's session epoch so the presented token (and any other) is
  // immediately revoked, not merely cleared client-side.
  if (req.user) {
    await db
      .update(schema.users)
      .set({ sessionEpoch: req.user.sessionEpoch + 1 })
      .where(eq(schema.users.id, req.user.id));
  }
  return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
});

app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
  const u = req.user!;
  return { id: u.id, name: u.name, email: u.email, role: u.role };
});

// ── Dashboard ───────────────────────────────────────────────────────────

app.get("/api/dashboard", { preHandler: requireAuth }, async () => {
  const program = await db.query.programStatus.findFirst({
    where: eq(schema.programStatus.program, "Biolinx Partner Program"),
  });
  const runs = await db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.id)).limit(8);
  const affiliates = await db.select().from(schema.affiliates);
  const counts = { external: 0, internal: 0, unresolved: 0 };
  for (const a of affiliates) counts[(a.classification as keyof typeof counts) ?? "unresolved"]++;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysToBlackFriday = Math.max(
    0,
    Math.ceil((new Date(`${BLACK_FRIDAY}T00:00:00-08:00`).getTime() - Date.now()) / msPerDay),
  );

  // Pipeline funnel across every phase (the "know everything" view).
  const leads = await db.select().from(schema.leads);
  const messages = await db.select().from(schema.messages);
  const replies = await db.select().from(schema.replies);
  const signups = await db.select().from(schema.signups);
  const suppressions = await db.select().from(schema.suppressions);
  const contactedLeadIds = new Set(messages.filter((m) => m.state === "sent").map((m) => m.leadId));

  const funnel = {
    leadsTotal: leads.length,
    inQueue: leads.filter(
      (l) =>
        !l.isDead &&
        !isSp5(l.subProfile) &&
        !isConverted(l.affiliationStatus) &&
        !["Passed", "Signed", "No", "Signed up"].includes(l.status ?? ""),
    ).length,
    withPersonalization: leads.filter((l) => hasUsableNotes(l.personalizationNotes)).length,
    sp5Protected: leads.filter((l) => isSp5(l.subProfile)).length,
    verifiedReach: leads.filter((l) => l.totalReach != null).length,
    contacted: contactedLeadIds.size,
    replies: replies.length,
    interested: replies.filter((r) => r.classifiedAs === "interested" || r.classifiedAs === "signed_up").length,
    signups: signups.length,
    signupsPending: signups.filter((s) => s.status !== "confirmed").length,
  };
  const email = {
    dispatched: messages.filter((m) => m.channel === "email").length,
    queued: messages.filter((m) => m.channel === "email" && m.state === "linted").length,
    sent: messages.filter((m) => m.channel === "email" && m.state === "sent").length,
    blocked: messages.filter((m) => m.state === "blocked").length,
    suppressions: suppressions.length,
  };
  const expiredOverrides = affiliates.filter((a) => a.overrideExpired).length;

  return {
    goal: EXTERNAL_AFFILIATE_GOAL,
    blackFriday: BLACK_FRIDAY,
    daysToBlackFriday,
    counts,
    approvedTotal: affiliates.length,
    lastSyncedAt: program?.lastSyncedAt ?? null,
    unresolvedAccounts: program?.unresolvedAccounts ?? "",
    syncRuns: runs,
    funnel,
    email,
    expiredOverrides,
  };
});

// ── Affiliates ──────────────────────────────────────────────────────────

app.get("/api/affiliates", { preHandler: requireAuth }, async (req) => {
  const { classification } = (req.query ?? {}) as { classification?: string };
  const rows = classification
    ? await db.select().from(schema.affiliates).where(eq(schema.affiliates.classification, classification))
    : await db.select().from(schema.affiliates);
  return rows
    .map((a) => ({
      ...a,
      suggestion: a.classification === "unresolved" ? suggestClassification(a) : null,
    }))
    .sort((x, y) => x.idevId - y.idevId);
});

const VALID_CLASSIFICATIONS = ["internal", "external", "unresolved"];

app.post("/api/affiliates/classify", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const { ids, classification } = (req.body ?? {}) as { ids?: number[]; classification?: string };
  if (!Array.isArray(ids) || ids.length === 0 || !VALID_CLASSIFICATIONS.includes(classification ?? "")) {
    return reply.code(400).send({ error: "ids[] and classification (internal|external|unresolved) required" });
  }
  await db
    .update(schema.affiliates)
    .set({
      classification: classification!,
      classifiedByUserId: classification === "unresolved" ? null : req.user!.id,
    })
    .where(inArray(schema.affiliates.id, ids));
  await audit(req, "affiliates.classify", "affiliates", null, { ids, classification });
  const counts = await recomputeProgramStatus(db);
  return { ok: true, counts };
});

// ── Team (invites) ──────────────────────────────────────────────────────

app.get("/api/team", { preHandler: requireRole("admin") }, async () => {
  const users = await db.select().from(schema.users);
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    activated: !!u.activatedAt,
    inviteToken: u.activatedAt ? null : u.inviteToken,
  }));
});

app.post("/api/team/invite", { preHandler: requireRole("admin") }, async (req, reply) => {
  const { name, email, role } = (req.body ?? {}) as { name?: string; email?: string; role?: string };
  if (!name || !email || !["admin", "ops", "rep", "operator"].includes(role ?? "")) {
    return reply.code(400).send({ error: "name, email and role (admin|ops|rep|operator) required" });
  }
  const token = newInviteToken();
  const [row] = await db
    .insert(schema.users)
    .values({
      name,
      email: email.trim().toLowerCase(),
      role: role!,
      inviteToken: token,
      invitedAt: new Date(),
    })
    .$returningId();
  await audit(req, "team.invite", "users", row!.id, { email, role });
  return { ok: true, inviteToken: token, invitePath: `/#/accept-invite/${token}` };
});

// ── Settings (encrypted secret store, managed by admins) ────────────────

app.get("/api/settings", { preHandler: requireRole("admin") }, async () => {
  const state = await readSettingsForUi(db); // secrets: { configured } only
  return {
    sections: SETTINGS_SECTIONS.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        const cur = state[f.key];
        return {
          ...f,
          configured: cur?.configured ?? !!process.env[f.key],
          // Non-secret current value for display; secrets never leave the server.
          value: f.kind === "secret" ? undefined : cur?.value ?? process.env[f.key] ?? "",
        };
      }),
    })),
  };
});

app.put("/api/settings/:section", { preHandler: requireRole("admin") }, async (req, reply) => {
  const sectionId = (req.params as { section: string }).section;
  const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
  if (!section) return reply.code(404).send({ error: "unknown settings section" });
  const values = (req.body ?? {}) as Record<string, string>;
  const allowed = new Set(section.fields.map((f) => f.key));
  const writes = Object.entries(values)
    .filter(([k]) => allowed.has(k))
    .map(([key, value]) => ({ key, value }));
  await saveSettings(db, writes, req.user!.id);
  // Never log the values — only which keys changed.
  await audit(req, "settings.save", "app_settings", null, { section: sectionId, keys: writes.map((w) => w.key) });
  return { ok: true };
});

// ── Leads ───────────────────────────────────────────────────────────────

app.get("/api/leads", { preHandler: requireAuth }, async (req) => {
  const q = (req.query ?? {}) as {
    view?: string;
    page?: string;
    pageSize?: string;
    sort?: string;
    dir?: string;
    search?: string;
    status?: string;
    platform?: string;
    sp?: string;
  };
  const rows = await db.select().from(schema.leads);
  let filtered =
    q.view === "triage"
      ? rows.filter((l) => l.needsTriage)
      : q.view === "queue"
        ? rows.filter(
            (l) =>
              !l.isDead &&
              !isSp5(l.subProfile) &&
              !isConverted(l.affiliationStatus) &&
              !["Passed", "Signed", "No", "Signed up"].includes(l.status ?? ""),
          )
        : rows;

  // Filters
  if (q.status) filtered = filtered.filter((l) => l.status === q.status);
  if (q.platform) filtered = filtered.filter((l) => l.primaryPlatform === q.platform);
  if (q.sp) filtered = filtered.filter((l) => (q.sp === "SP5" ? isSp5(l.subProfile) : l.subProfile === q.sp));
  if (q.search) {
    const s = q.search.toLowerCase();
    filtered = filtered.filter((l) =>
      [l.firstName, l.lastName, l.email, l.primaryPlatform, l.niche, l.whatTheyPromoted]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(s)),
    );
  }

  // Analytics over the FILTERED set (before pagination).
  const analytics = {
    total: filtered.length,
    contacted: filtered.filter((l) => l.status === "Contacted" || l.status === "In talks" || l.status === "Signed").length,
    inTalks: filtered.filter((l) => l.status === "In talks").length,
    signed: filtered.filter((l) => l.status === "Signed").length,
    notContacted: filtered.filter((l) => (l.status ?? "Not contacted") === "Not contacted").length,
    verifiedReach: filtered.filter((l) => l.totalReach != null).length,
    personalized: filtered.filter((l) => hasUsableNotes(l.personalizationNotes)).length,
    dead: filtered.filter((l) => l.isDead).length,
  };

  // Sort — every comparator is ASCENDING; `dir` flips it. Each column has a
  // sensible default direction used when the user hasn't picked one.
  const sort = q.sort ?? "rank";
  const asc: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
    rank: (a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9),
    reach: (a, b) => (a.totalReach ?? -1) - (b.totalReach ?? -1),
    status: (a, b) => (a.status ?? "").localeCompare(b.status ?? ""),
    platform: (a, b) => (a.primaryPlatform ?? "").localeCompare(b.primaryPlatform ?? ""),
    sp: (a, b) => (a.subProfile ?? "").localeCompare(b.subProfile ?? ""),
    lastTouch: (a, b) => new Date(a.lastReachedOut ?? 0).getTime() - new Date(b.lastReachedOut ?? 0).getTime(),
    name: (a, b) => (a.firstName ?? "").localeCompare(b.firstName ?? ""),
  };
  const defaultDir: Record<string, 1 | -1> = { rank: 1, name: 1, status: 1, platform: 1, sp: 1, reach: -1, lastTouch: -1 };
  const sorter = asc[sort] ?? asc.rank!;
  const dir = q.dir === "asc" ? 1 : q.dir === "desc" ? -1 : (defaultDir[sort] ?? 1);
  filtered.sort((a, b) => dir * sorter(a, b));

  // Paginate
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(q.pageSize) || 50));
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  return {
    analytics,
    page,
    pageSize,
    totalPages: Math.ceil(filtered.length / pageSize),
    rows: pageRows.map((l) => ({
      id: l.id,
      rank: l.conversionRank,
      band: l.rankBand,
      name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)",
      niche: l.niche,
      platform: l.primaryPlatform,
      reach: l.totalReach,
      status: l.status,
      subProfile: l.subProfile,
      needsTriage: l.needsTriage,
      isDead: l.isDead,
      contactChannel: l.contactChannel,
      lastReachedOut: l.lastReachedOut,
      followUpsSent: l.followUpsSent,
      hasNotes: hasUsableNotes(l.personalizationNotes),
      enrichmentStatus: l.enrichmentStatus,
      profileUrl: profileUrlFor(l),
    })),
  };
});

/** Only http(s) URLs may become clickable links. Lead fields come from
 *  imports and scrapes, so a `javascript:` or `data:` value must never reach
 *  an href in the admin. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Best link to where a person can be found: explicit site, the promo URL
 *  we found them at, or the first URL inside the social-profiles text. */
function profileUrlFor(lead: { websiteUrl: string | null; whereFound: string | null; socialProfiles: string | null }): string | null {
  const fromSocial = lead.socialProfiles
    ? lead.socialProfiles
        .split(/\s|\n|;/)
        .map(safeHttpUrl)
        .find((u): u is string => u != null) ?? null
    : null;
  return safeHttpUrl(lead.websiteUrl) ?? safeHttpUrl(lead.whereFound) ?? fromSocial;
}

/** Distinct filter values for the Leads UI dropdowns. */
app.get("/api/leads/filters", { preHandler: requireAuth }, async () => {
  const rows = await db.select().from(schema.leads);
  const uniq = (vals: (string | null)[]) => [...new Set(vals.filter(Boolean) as string[])].sort();
  return {
    statuses: uniq(rows.map((l) => l.status)),
    platforms: uniq(rows.map((l) => l.primaryPlatform)),
    subProfiles: uniq(rows.map((l) => l.subProfile)),
  };
});

app.get("/api/leads/:id", { preHandler: requireAuth }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, id) });
  if (!lead) return reply.code(404).send({ error: "not found" });
  const messages = await db.select().from(schema.messages).where(eq(schema.messages.leadId, id));
  const replies = await db.select().from(schema.replies).where(eq(schema.replies.leadId, id));
  const enrichments = await db
    .select()
    .from(schema.leadEnrichments)
    .where(eq(schema.leadEnrichments.leadId, id))
    .orderBy(desc(schema.leadEnrichments.id))
    .limit(5);
  return { lead, messages, replies, enrichments };
});

// ── Jobs (manual triggers, lock-guarded) ────────────────────────────────

const jobTriggers: Record<string, () => Promise<unknown>> = {
  "idev-sync": () => runIdevSync(db),
  "rank-recompute": () => runRankRecompute(db),
  "referral-expiry": () => runReferralExpiry(db),
  "metrics-digest": () => runMetricsDigest(db),
  "enrich-personalize": () => runEnrichPersonalize(db),
};

app.post("/api/jobs/:job", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const job = (req.params as { job: string }).job;
  const fn = jobTriggers[job];
  if (!fn) return reply.code(404).send({ error: "unknown job" });
  const result = await withMysqlLock(conn.pool, `job:${job}`, async () => (await fn()) ?? true);
  if (result === null) return reply.code(409).send({ error: "job already running" });
  await audit(req, `jobs.${job}.manual`, "sync_runs", null, {});
  return { ok: true, result };
});

// Back-compat for the dashboard's sync button.
app.post("/api/jobs/idev-sync", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const result = await withMysqlLock(conn.pool, "job:idev-sync", async () => {
    await runIdevSync(db);
    return true;
  });
  if (result === null) return reply.code(409).send({ error: "sync already running" });
  await audit(req, "jobs.idev_sync.manual", "sync_runs", null, {});
  return { ok: true };
});

// ── Approvals (message queue) ───────────────────────────────────────────

app.get("/api/messages", { preHandler: requireAuth }, async (req) => {
  const { state } = (req.query ?? {}) as { state?: string };
  const rows = await db.select().from(schema.messages);
  const filtered = state ? rows.filter((m) => m.state === state) : rows;
  const leadsById = new Map((await db.select().from(schema.leads)).map((l) => [l.id, l]));
  return filtered
    .sort((a, b) => b.id - a.id)
    .slice(0, 200)
    .map((m) => {
      const lead = leadsById.get(m.leadId);
      // Where the operator sends a DM: first social profile / promo URL.
      const profileUrl = lead ? profileUrlFor(lead) : null;
      return {
        id: m.id,
        leadId: m.leadId,
        leadName: lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") : "?",
        platform: lead?.primaryPlatform ?? null,
        profileUrl: profileUrl ?? null,
        channel: m.channel,
        state: m.state,
        subject: m.subject,
        body: m.body,
        lintReport: m.lintReport,
        touchNumber: m.touchNumber,
      };
    });
});

// Edit a draft before it goes out (linted messages only).
app.patch("/api/messages/:id", { preHandler: requireRole("admin", "ops", "operator") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { body, subject } = (req.body ?? {}) as { body?: string; subject?: string };
  const msg = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
  if (!msg) return reply.code(404).send({ error: "not found" });
  if (msg.state !== "linted") return reply.code(409).send({ error: "can only edit a draft before approval" });
  await db
    .update(schema.messages)
    .set({ ...(body != null ? { body } : {}), ...(subject != null ? { subject } : {}) })
    .where(eq(schema.messages.id, id));
  await audit(req, "message.edit", "messages", id, {});
  return { ok: true };
});

// Approve. Email → push to Instantly and mark sent in one step (machine-sent).
// DM → just mark approved; the operator sends by hand and confirms separately.
app.post("/api/messages/:id/approve", { preHandler: requireRole("admin", "ops", "operator") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { body, subject } = (req.body ?? {}) as { body?: string; subject?: string };
  const msg = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
  if (!msg) return reply.code(404).send({ error: "not found" });
  if (body != null || subject != null) {
    await db
      .update(schema.messages)
      .set({ ...(body != null ? { body } : {}), ...(subject != null ? { subject } : {}) })
      .where(eq(schema.messages.id, id));
  }

  if (msg.channel === "email") {
    const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, msg.leadId) });
    const pusher = instantlyPusher();
    if (!pusher) return reply.code(409).send({ error: "email not configured (campaign/API key) — cannot send" });
    if (!lead?.email) return reply.code(409).send({ error: "lead has no email address" });
    await approveMessage(db, id, req.user!.id);
    await pusher({
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      subject: subject ?? msg.subject ?? "",
      body: body ?? msg.body ?? "",
    });
    await confirmSent(db, id, req.user!.id, "Email");
    await audit(req, "message.approve_send_email", "messages", id, {});
    return { ok: true, sent: true };
  }

  await approveMessage(db, id, req.user!.id);
  await audit(req, "message.approve", "messages", id, {});
  return { ok: true, sent: false };
});

// DM confirm: the operator sent it by hand, records the exact channel used.
app.post("/api/messages/:id/sent", { preHandler: requireRole("admin", "ops", "operator") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  const { contactChannel } = (req.body ?? {}) as { contactChannel?: string };
  await confirmSent(db, id, req.user!.id, (contactChannel as never) ?? "Other");
  await audit(req, "message.sent", "messages", id, { contactChannel });
  return { ok: true };
});

// ── Replies (inbound + triage) ──────────────────────────────────────────

app.get("/api/replies", { preHandler: requireAuth }, async () => {
  const rows = await db.select().from(schema.replies);
  const leadsById = new Map((await db.select().from(schema.leads)).map((l) => [l.id, l]));
  return rows
    .sort((a, b) => b.id - a.id)
    .slice(0, 200)
    .map((r) => ({
      id: r.id,
      leadId: r.leadId,
      leadName: leadsById.get(r.leadId)
        ? [leadsById.get(r.leadId)!.firstName, leadsById.get(r.leadId)!.lastName].filter(Boolean).join(" ")
        : "?",
      channel: r.channel,
      body: r.body,
      classifiedAs: r.classifiedAs,
      handledAt: r.handledAt,
      receivedAt: r.receivedAt,
    }));
});

// Instantly reply webhook (public; shared-secret gated — FAILS CLOSED).
app.post("/webhooks/instantly", async (req, reply) => {
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!secret) {
    req.log.error("INSTANTLY_WEBHOOK_SECRET unset — refusing webhook");
    return reply.code(503).send({ error: "webhook secret not configured" });
  }
  const provided = (req.headers["x-webhook-secret"] as string) ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.code(401).send({ error: "bad secret" });
  }
  const payload = (req.body ?? {}) as { email?: string; reply_text?: string; lead_email?: string };
  const email = payload.lead_email ?? payload.email;
  if (!email || !payload.reply_text) return reply.code(400).send({ error: "email and reply_text required" });
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.email, email) });
  if (!lead) return { received: true, matched: false };
  const result = await ingestReply(anthropicFromEnv(), {
    leadId: lead.id,
    channel: "Email",
    body: payload.reply_text,
    email,
  }, db);
  req.log.info(result, "instantly reply ingested");
  return { received: true, matched: true, result };
});

// ── Signups ─────────────────────────────────────────────────────────────

app.get("/api/signups", { preHandler: requireAuth }, async () => {
  return (await db.select().from(schema.signups)).sort((a, b) => b.id - a.id);
});

app.post("/api/signups/:id/provision", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  const result = await provisionSignup(id, db);
  await audit(req, "signup.provision", "signups", id, result);
  return result;
});

app.post("/api/signups/:id/confirm", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  await confirmSignup(db, id, req.user!.id);
  return { ok: true };
});

// ── Email / Instantly (live campaign visibility) ────────────────────────

app.get("/api/email/campaigns", { preHandler: requireAuth }, async (_req, reply) => {
  let config;
  try {
    config = instantlyFromEnv();
  } catch {
    return reply.code(200).send({ configured: false, campaigns: [], accounts: 0 });
  }
  try {
    const [campaigns, accounts] = await Promise.all([listCampaigns(config), listAccounts(config)]);
    return {
      configured: true,
      accounts: accounts.length,
      warmedAccounts: accounts.filter((a) => a.warmup_status === 1).length,
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    };
  } catch (err) {
    return reply.code(200).send({ configured: true, error: (err as Error).message, campaigns: [], accounts: 0 });
  }
});

// Run outreach-dispatch on demand. channel=email drafts + lints into the
// approval queue (or auto-sends if autosend is on and the client signed off).
// channel=dm drafts DMs into the queue for the operator to send.
app.post("/api/outreach/dispatch", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const { channel, cap, autosend } = (req.body ?? {}) as { channel?: string; cap?: number; autosend?: boolean };
  if (channel !== "email" && channel !== "dm") return reply.code(400).send({ error: "channel must be email or dm" });
  const anthropic = anthropicFromEnv();
  const result = await withMysqlLock(conn.pool, `job:dispatch:${channel}`, async () => {
    const pusher = channel === "email" ? instantlyPusher() : null;
    return runOutreachDispatch(
      {
        llm: anthropic,
        channel,
        dailyCap: cap ?? 10,
        autosend: channel === "email" && !!autosend && process.env.CHANNEL_AUTOSEND_EMAIL === "true",
        senderName: process.env.SENDER_NAME ?? "the team",
        postalConfigured: !!process.env.SENDER_POSTAL_ADDRESS,
        ...(pusher ? { pushToEsp: pusher } : {}),
      },
      db,
    );
  });
  if (result === null) return reply.code(409).send({ error: "dispatch already running" });
  await audit(req, `outreach.dispatch.${channel}`, "messages", null, result);
  return { ok: true, result };
});

// Create (or reuse) the Instantly recruiting campaign.
app.post("/api/email/setup-campaign", { preHandler: requireRole("admin") }, async (req, reply) => {
  try {
    const result = await setupRecruitingCampaign(db);
    await audit(req, "email.setup_campaign", "config", null, result);
    return result;
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// Our own email activity (from the messages table — what WE dispatched).
app.get("/api/email/activity", { preHandler: requireAuth }, async () => {
  const messages = await db.select().from(schema.messages);
  const email = messages.filter((m) => m.channel === "email");
  const replies = await db.select().from(schema.replies);
  const suppressions = await db.select().from(schema.suppressions);
  const byState = (rows: typeof messages) =>
    rows.reduce<Record<string, number>>((acc, m) => ((acc[m.state] = (acc[m.state] ?? 0) + 1), acc), {});
  return {
    email: { total: email.length, byState: byState(email) },
    dm: { total: messages.filter((m) => m.channel === "dm").length, byState: byState(messages.filter((m) => m.channel === "dm")) },
    replies: replies.length,
    suppressions: suppressions.length,
    recent: messages
      .sort((a, b) => b.id - a.id)
      .slice(0, 20)
      .map((m) => ({ id: m.id, leadId: m.leadId, channel: m.channel, state: m.state, subject: m.subject, sentAt: m.sentAt })),
  };
});

// ── Activity log (audit + sync runs unified) ────────────────────────────

app.get("/api/activity", { preHandler: requireAuth }, async () => {
  const audits = await db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(100);
  const runs = await db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.id)).limit(50);
  const userById = new Map((await db.select().from(schema.users)).map((u) => [u.id, u.name]));
  return {
    audit: audits.map((a) => ({
      id: a.id,
      actor: a.actorUserId ? userById.get(a.actorUserId) ?? `user ${a.actorUserId}` : "system",
      action: a.action,
      subject: a.subjectTable,
      detail: a.detail,
      at: a.createdAt,
    })),
    runs: runs.map((r) => ({ id: r.id, job: r.job, status: r.status, detail: r.detail, startedAt: r.startedAt, finishedAt: r.finishedAt })),
  };
});

// ── Store webhooks (Laravel PR, Phase 5) ────────────────────────────────

app.post("/webhooks/store", async (req, reply) => {
  const secret = process.env.STORE_WEBHOOK_SECRET;
  if (!secret) {
    req.log.error("STORE_WEBHOOK_SECRET unset — refusing webhook");
    return reply.code(503).send({ error: "webhook secret not configured" });
  }
  const signature = req.headers["x-signature"];
  const body = JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = typeof signature === "string" ? signature : "";
  const valid =
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return reply.code(401).send({ error: "bad signature" });
  req.log.info({ event: (req.body as { event?: string })?.event }, "store webhook received");
  return { received: true };
});

// ── Serve the admin SPA (single origin) ─────────────────────────────────
// In production the API also serves the built admin panel, so there is one
// origin and one process to run. Skipped in dev (Vite serves :5173).
const adminDist = path.resolve(process.cwd(), "apps/admin/dist");
if (existsSync(path.join(adminDist, "index.html"))) {
  await app.register(fastifyStatic, { root: adminDist, wildcard: false });
  // SPA fallback: anything that isn't an API/webhook route serves index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/webhooks") || req.url.startsWith("/health")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  app.log.info("serving admin SPA from apps/admin/dist");
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
