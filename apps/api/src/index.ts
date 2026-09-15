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
  NICHE_PRIORITY,
  SETTINGS_SECTIONS,
  brandFitForNiche,
  normalizeNiche,
} from "@biolinx/core";
import { DEFAULT_EXCLUDE_TERMS } from "@biolinx/scraping";
import {
  approveMessage,
  confirmSent,
  confirmSignup,
  ingestReply,
  instantlyPusher,
  provisionSignup,
  runCustomerioSync,
  runEnrichPersonalize,
  runIdevSync,
  runLeadIngest,
  applyBiolinxPost,
  applyCallback,
  approveSwipePost,
  cleanHashtags,
  contentConfigFromEnv,
  createContentClient,
  declineAndRegenerate,
  redoSwipeImage,
  runSwipeSearch,
  unusedSwipeSources,
  recentSwipeSearches,
  biolinxMakesImages,
  editSwipePost,
  generateSwipeDrafts,
  sendApprovedSwipePosts,
  verifySignature,
  type CallbackBody,
  sourcedDetails,
  sourcedLeadsCsv,
  type DetailBundle,
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

interface SamplePost {
  url: string;
  text: string;
  postedAt: string | null;
  likes?: number;
  views?: number;
  comments?: number;
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

/** Sends one test message with the saved Telegram settings and reports Telegram's answer, so an
 *  admin can confirm alerts work right after entering the bot token and chat ID. */
app.post("/api/settings/alerts/test", { preHandler: requireRole("admin"), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return reply.code(400).send({ error: "Save a bot token and a chat ID first." });
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `✅ BiolinX Engine test alert from ${req.user!.name}. Failed jobs and the daily digest will arrive here.`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    await audit(req, "settings.alerts_test", "app_settings", null, { ok: !!body.ok });
    if (!res.ok || !body.ok) return reply.code(400).send({ error: `Telegram said: ${body.description ?? `HTTP ${res.status}`}` });
    return { ok: true };
  } catch (e) {
    return reply.code(502).send({ error: `Could not reach Telegram: ${(e as Error).message}` });
  }
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
    // Sourced view only
    review?: string;
    niche?: string;
    competitor?: string;
    store?: string;
    active?: string;
    minReach?: string;
    minScore?: string;
    minEngagement?: string;
    country?: string;
    audience?: string;
    competitorName?: string;
  };
  const rows = await db.select().from(schema.leads);
  const sourcedView = q.view === "sourced";
  // Derived details for every lead (engagement, activity, bio, surfaced post) from its latest
  // profile read: the sourcing read, or a research run's read for imported leads.
  const details = new Map<number, ReturnType<typeof sourcedDetails>>();
  {
    const now = new Date();
    const bundles = await latestReadBundles();
    for (const l of rows) details.set(l.id, sourcedDetails(l, bundles.get(l.id) ?? null, now));
  }
  const reviewable = (l: { sourcingReview: string | null }) => l.sourcingReview == null || l.sourcingReview === "accepted";
  let filtered =
    q.view === "triage"
      ? rows.filter((l) => l.needsTriage && reviewable(l))
      : sourcedView
        ? rows.filter((l) => l.source === "sourcing" && (q.review === "all" ? true : l.sourcingReview === (q.review || "pending")))
      : q.view === "queue"
        ? rows.filter(
            (l) =>
              reviewable(l) &&
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
    filtered = filtered.filter((l) => {
      const d = details.get(l.id);
      return [l.firstName, l.lastName, l.email, l.primaryPlatform, l.niche, l.whatTheyPromoted, l.otherCreatorCompany, l.affiliateCode, d?.handle, d?.bio, d?.term, d?.niche]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(s));
    });
  }
  {
    const num = (v?: string) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const minReach = num(q.minReach);
    const minScore = num(q.minScore);
    const minEng = num(q.minEngagement); // percent
    filtered = filtered.filter((l) => {
      const d = details.get(l.id);
      if (q.niche && d?.niche !== q.niche) return false;
      if (q.competitor === "yes" && !l.otherCreatorCompany) return false;
      if (q.competitor === "no" && l.otherCreatorCompany) return false;
      if (q.competitorName && l.otherCreatorCompany !== q.competitorName) return false;
      if (q.store === "hide" && d?.isStore) return false;
      if (q.store === "only" && !d?.isStore) return false;
      if (q.active === "yes" && !(d?.daysSinceLastPost != null && d.daysSinceLastPost <= 30)) return false;
      if (minReach != null && !(l.totalReach != null && l.totalReach >= minReach)) return false;
      if (minScore != null && (l.sourcingScore ?? 0) < minScore) return false;
      if (minEng != null && !(d?.engagementRate != null && d.engagementRate * 100 >= minEng)) return false;
      if (q.country && (l.geoCountry ?? "") !== q.country) return false;
      if (q.audience && d?.audience !== q.audience) return false;
      return true;
    });
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
    sourcedPending: rows.filter((l) => l.sourcingReview === "pending").length,
  };

  // Sort — every comparator is ASCENDING; `dir` flips it. Each column has a
  // sensible default direction used when the user hasn't picked one.
  const sort = q.sort ?? (q.view === "sourced" ? "score" : "rank");
  const asc: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
    rank: (a, b) => (a.conversionRank ?? 1e9) - (b.conversionRank ?? 1e9),
    reach: (a, b) => (a.totalReach ?? -1) - (b.totalReach ?? -1),
    status: (a, b) => (a.status ?? "").localeCompare(b.status ?? ""),
    platform: (a, b) => (a.primaryPlatform ?? "").localeCompare(b.primaryPlatform ?? ""),
    sp: (a, b) => (a.subProfile ?? "").localeCompare(b.subProfile ?? ""),
    lastTouch: (a, b) => new Date(a.lastReachedOut ?? 0).getTime() - new Date(b.lastReachedOut ?? 0).getTime(),
    name: (a, b) => (a.firstName ?? "").localeCompare(b.firstName ?? ""),
    score: (a, b) => (a.sourcingScore ?? 0) - (b.sourcingScore ?? 0),
    niche: (a, b) => (details.get(a.id)?.niche ?? a.niche ?? "").localeCompare(details.get(b.id)?.niche ?? b.niche ?? ""),
    avgViews: (a, b) => (details.get(a.id)?.avgViews ?? -1) - (details.get(b.id)?.avgViews ?? -1),
    engagement: (a, b) => (details.get(a.id)?.engagementRate ?? -1) - (details.get(b.id)?.engagementRate ?? -1),
    posts30: (a, b) => (details.get(a.id)?.postsLast30 ?? -1) - (details.get(b.id)?.postsLast30 ?? -1),
    lastPost: (a, b) => new Date(a.lastPostAt ?? 0).getTime() - new Date(b.lastPostAt ?? 0).getTime(),
    competitor: (a, b) => (a.otherCreatorCompany ?? "").localeCompare(b.otherCreatorCompany ?? ""),
  };
  const defaultDir: Record<string, 1 | -1> = { rank: 1, name: 1, status: 1, platform: 1, sp: 1, reach: -1, lastTouch: -1, score: -1, niche: 1, avgViews: -1, engagement: -1, posts30: -1, lastPost: -1, competitor: 1 };
  const sorter = asc[sort] ?? asc.rank!;
  const dir = q.dir === "asc" ? 1 : q.dir === "desc" ? -1 : (defaultDir[sort] ?? 1);
  filtered.sort((a, b) => dir * sorter(a, b));

  // Paginate
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(q.pageSize) || 50));
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Dropdown options for the filters, from every lead this view can show (not just this page).
  const facets = (() => {
    const all = sourcedView ? rows.filter((l) => l.source === "sourcing") : rows;
    const sourced = rows.filter((l) => l.source === "sourcing");
    const uniq = (vals: Array<string | null | undefined>) => [...new Set(vals.filter((v): v is string => !!v))].sort();
    const counts = new Map<string, number>();
    for (const l of all) if (l.otherCreatorCompany) counts.set(l.otherCreatorCompany, (counts.get(l.otherCreatorCompany) ?? 0) + 1);
    return {
      niches: uniq(all.map((l) => details.get(l.id)?.niche)),
      countries: uniq(all.map((l) => l.geoCountry)),
      audiences: uniq(all.map((l) => details.get(l.id)?.audience)),
      platforms: uniq(all.map((l) => l.primaryPlatform)),
      competitors: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n })),
      review: {
        pending: sourced.filter((l) => l.sourcingReview === "pending").length,
        accepted: sourced.filter((l) => l.sourcingReview === "accepted").length,
        rejected: sourced.filter((l) => l.sourcingReview === "rejected").length,
      },
    };
  })();

  return {
    analytics,
    facets,
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
      sourcingScore: l.sourcingScore,
      sourcingReason: l.sourcingReason,
      sourcingReview: l.sourcingReview,
      brandFit: l.brandFit,
      affiliateCode: l.affiliateCode,
      competitor: l.otherCreatorCompany,
      lastPostAt: l.lastPostAt,
      doesLive: l.doesLive,
      promoTrackRecord: l.promoTrackRecord,
      contentOriginal: l.contentOriginal,
      scoreReasons: l.sourcingReview ? (l.notes ?? "").split("\n").filter(Boolean) : [],
      sample: (l.sourcingSample as SamplePost[] | null) ?? [],
      enrichmentStatus: l.enrichmentStatus,
      profileUrl: profileUrlFor(l),
      country: l.geoCountry,
      currentOffer: l.currentOffer,
      rejectedReason: l.sourcingRejectedReason,
      details: details.get(l.id) ?? null,
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

/** Latest profile-read bundle per lead: sourcing reads and research-run reads (not failed runs). */
async function latestReadBundles(): Promise<Map<number, DetailBundle>> {
  const out = new Map<number, DetailBundle>();
  for (const e of await db
    .select({ leadId: schema.leadEnrichments.leadId, bundle: schema.leadEnrichments.bundle, status: schema.leadEnrichments.status })
    .from(schema.leadEnrichments)
    .orderBy(desc(schema.leadEnrichments.id))) {
    if (out.has(e.leadId) || e.status === "failed") continue;
    const b = e.bundle as DetailBundle | null;
    if (b && (Array.isArray(b.items) || b.bio || b.followers != null)) out.set(e.leadId, b);
  }
  return out;
}

/** CSV of sourced leads for marketing to check (columns follow their scoring spec).
 *  ?review=pending (default) | accepted | rejected | all. Holds PII: admin/ops only, audited. */
app.get("/api/leads/sourced.csv", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const review = String((req.query as { review?: string } | undefined)?.review ?? "pending");
  if (!["pending", "accepted", "rejected", "all"].includes(review)) return reply.code(400).send({ error: "review must be pending, accepted, rejected or all" });
  const rows = (await db.select().from(schema.leads).where(eq(schema.leads.source, "sourcing")))
    .filter((l) => review === "all" || l.sourcingReview === review)
    .sort((a, b) => (b.sourcingScore ?? 0) - (a.sourcingScore ?? 0));
  await audit(req, "leads.sourced.export", "leads", null, { review, count: rows.length });
  const bundles = await latestReadBundles();
  const now = new Date();
  const byId = new Map(rows.map((l) => [l.id, l]));
  const stamp = new Date().toISOString().slice(0, 10);
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="biolinx-sourced-leads-${review}-${stamp}.csv"`)
    .header("cache-control", "no-store")
    .send(sourcedLeadsCsv(rows, now, (l) => sourcedDetails(byId.get(l.id)!, bundles.get(l.id) ?? null, now)));
});

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

// ── Audiences (sourcing profiles) + competitors ─────────────────────────

const PLATFORMS = ["tiktok", "youtube", "skool", "reddit", "instagram"] as const;
type Platform = (typeof PLATFORMS)[number];

const AUDIENCE_DEFAULTS = {
  followerMin: { tiktok: 5000, instagram: 5000, youtube: 2000, skool: 100 } as Record<string, number>,
  followerMax: { tiktok: 500000, instagram: 500000, youtube: 300000, skool: 20000 } as Record<string, number>,
  countries: ["US", "CA", "GB", "AU"],
  language: "en",
  activityDays: 30,
  excludeTerms: DEFAULT_EXCLUDE_TERMS,
  dailyCap: 50,
  spendCapUsd: "2.00",
};

function lines(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

type AudienceInsert = Omit<typeof schema.sourcingProfiles.$inferInsert, "id">;

/** Validate an audience body. Returns the row to write, or a plain-language error. */
function parseAudience(body: Record<string, unknown>): { row: AudienceInsert } | { error: string } {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 120) return { error: "name is required (max 120 characters)" };
  const niche = normalizeNiche(String(body.niche ?? ""));
  if (!niche) return { error: `niche must be one of: ${NICHE_PRIORITY.join(", ")}` };
  const platforms = lines(body.platforms).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  if (platforms.length === 0) return { error: "pick at least one platform" };
  const termsIn = (body.terms ?? {}) as Record<string, unknown>;
  const terms: Partial<Record<Platform, string[]>> = {};
  for (const p of platforms) {
    const t = lines(termsIn[p]);
    if (t.length === 0) return { error: `add at least one search term for ${p}` };
    terms[p] = t;
  }
  const num = (v: unknown, lo: number, hi: number, label: string): number | { error: string } => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) return { error: `${label} must be between ${lo} and ${hi}` };
    return n;
  };
  const dailyCap = num(body.dailyCap ?? AUDIENCE_DEFAULTS.dailyCap, 1, 200, "daily cap");
  if (typeof dailyCap !== "number") return dailyCap;
  // Low floor so many small audiences (Skool, Reddit) can share the daily limit.
  const spend = num(body.spendCapUsd ?? AUDIENCE_DEFAULTS.spendCapUsd, 0.1, 10, "spend cap");
  if (typeof spend !== "number") return spend;
  const activityDays = num(body.activityDays ?? AUDIENCE_DEFAULTS.activityDays, 1, 365, "activity window");
  if (typeof activityDays !== "number") return activityDays;
  const bounds = (v: unknown): Partial<Record<Platform, number>> => {
    const out: Partial<Record<Platform, number>> = {};
    for (const p of platforms) {
      const n = Number((v as Record<string, unknown> | undefined)?.[p]);
      if (Number.isFinite(n) && n > 0) out[p] = n;
    }
    return out;
  };
  const brandFit = ["biolinx", "aro", "both"].includes(String(body.brandFit)) ? String(body.brandFit) : brandFitForNiche(niche);
  return {
    row: {
      name,
      active: body.active !== false,
      niche,
      brandFit,
      platforms,
      terms,
      seedAccounts: body.seedAccounts ?? null,
      followerMin: bounds(body.followerMin ?? AUDIENCE_DEFAULTS.followerMin),
      followerMax: bounds(body.followerMax ?? AUDIENCE_DEFAULTS.followerMax),
      activityDays,
      countries: lines(body.countries ?? AUDIENCE_DEFAULTS.countries).map((c) => c.toUpperCase()),
      language: String(body.language ?? AUDIENCE_DEFAULTS.language).slice(0, 8),
      matchTerms: lines(body.matchTerms),
      excludeTerms: lines(body.excludeTerms ?? AUDIENCE_DEFAULTS.excludeTerms),
      excludeHandles: lines(body.excludeHandles).map((h) => h.replace(/^@/, "").toLowerCase()),
      dailyCap,
      spendCapUsd: spend.toFixed(2),
    },
  };
}

app.get("/api/audiences", { preHandler: requireRole("admin", "ops") }, async () => ({
  profiles: await db.select().from(schema.sourcingProfiles).orderBy(desc(schema.sourcingProfiles.id)),
  competitors: await db.select().from(schema.competitors).orderBy(schema.competitors.name),
  niches: [...NICHE_PRIORITY],
  platforms: [...PLATFORMS],
  defaults: AUDIENCE_DEFAULTS,
}));

app.post("/api/audiences", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const parsed = parseAudience((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const [ins] = await db
    .insert(schema.sourcingProfiles)
    .values({ ...parsed.row, createdByUserId: req.user!.id, updatedByUserId: req.user!.id })
    .$returningId();
  await audit(req, "audience.create", "sourcing_profiles", ins!.id, { name: parsed.row.name });
  return { ok: true, id: ins!.id };
});

app.put("/api/audiences/:id", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const parsed = parseAudience((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  await db.update(schema.sourcingProfiles).set({ ...parsed.row, updatedByUserId: req.user!.id }).where(eq(schema.sourcingProfiles.id, id));
  await audit(req, "audience.update", "sourcing_profiles", id, { name: parsed.row.name, active: parsed.row.active });
  return { ok: true };
});

app.delete("/api/audiences/:id", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  await db.delete(schema.sourcingProfiles).where(eq(schema.sourcingProfiles.id, id));
  await audit(req, "audience.delete", "sourcing_profiles", id, {});
  return { ok: true };
});

app.post("/api/audiences/:id/run", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const result = await withMysqlLock(conn.pool, "job:lead-ingest", () => runLeadIngest(db, undefined, { profileId: id }));
  if (result === null) return reply.code(409).send({ error: "sourcing is already running" });
  await audit(req, "audience.run", "sourcing_profiles", id, { inserted: result.inserted, cost: result.estimatedCostUsd });
  return { ok: true, result };
});

type CompetitorInsert = Omit<typeof schema.competitors.$inferInsert, "id">;

function parseCompetitor(body: Record<string, unknown>): { row: CompetitorInsert } | { error: string } {
  const name = String(body.name ?? "").trim();
  if (!name) return { error: "name is required" };
  const codePattern = body.codePattern ? String(body.codePattern).slice(0, 120) : null;
  if (codePattern) {
    try {
      new RegExp(codePattern);
    } catch {
      return { error: "code pattern is not a valid regular expression" };
    }
  }
  const pct = body.commissionPct == null || body.commissionPct === "" ? null : Number(body.commissionPct);
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return { error: "commission must be 0-100" };
  return {
    row: {
      name,
      domains: lines(body.domains).map((d) => d.toLowerCase()),
      codePattern,
      codePrefix: body.codePrefix ? String(body.codePrefix).trim().toUpperCase().slice(0, 24) : null,
      commissionPct: pct,
      recurring: typeof body.recurring === "boolean" ? body.recurring : null,
      notes: body.notes ? String(body.notes) : null,
      active: body.active !== false,
    },
  };
}

app.post("/api/competitors", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const parsed = parseCompetitor((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const [ins] = await db.insert(schema.competitors).values(parsed.row).$returningId();
  await audit(req, "competitor.create", "competitors", ins!.id, { name: parsed.row.name });
  return { ok: true, id: ins!.id };
});
app.put("/api/competitors/:id", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const parsed = parseCompetitor((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  await db.update(schema.competitors).set(parsed.row).where(eq(schema.competitors.id, id));
  await audit(req, "competitor.update", "competitors", id, { name: parsed.row.name });
  return { ok: true };
});
app.delete("/api/competitors/:id", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  await db.delete(schema.competitors).where(eq(schema.competitors.id, id));
  await audit(req, "competitor.delete", "competitors", id, {});
  return { ok: true };
});

// ── Sourced-lead review ─────────────────────────────────────────────────

app.post("/api/leads/:id/review", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const lead = await db.query.leads.findFirst({ where: eq(schema.leads.id, id) });
  if (!lead) return reply.code(404).send({ error: "not found" });
  if (lead.sourcingReview !== "pending") return reply.code(409).send({ error: "this lead is not waiting for review" });
  // The only fields a human sets to true/false by hand. Unchecked = unknown, so absent keys stay null.
  const flags: Partial<typeof schema.leads.$inferInsert> = {};
  for (const k of ["doesLive", "promoTrackRecord", "contentOriginal"] as const) if (typeof b[k] === "boolean") flags[k] = b[k] as boolean;

  if (b.decision === "reject") {
    await db
      .update(schema.leads)
      .set({ sourcingReview: "rejected", sourcingRejectedReason: b.reason ? String(b.reason).slice(0, 120) : null, ...flags })
      .where(eq(schema.leads.id, id));
    await audit(req, "lead.sourcing.reject", "leads", id, { reason: b.reason ?? null });
    return { ok: true };
  }
  if (b.decision !== "accept") return reply.code(400).send({ error: "decision must be accept or reject" });
  const affiliation = String(b.affiliationStatus ?? "");
  if (affiliation !== "Unsigned" && affiliation !== "Signed elsewhere") return reply.code(400).send({ error: "affiliation must be Unsigned or Signed elsewhere" });
  const sp = String(b.subProfile ?? "").toUpperCase();
  if (!["SP1", "SP2", "SP3", "SP4"].includes(sp)) return reply.code(400).send({ error: "sub-profile must be SP1-SP4 (reject goodwill advocates instead)" });
  const niche = normalizeNiche(String(b.niche ?? lead.niche ?? ""));
  if (!niche) return reply.code(400).send({ error: "niche is required" });
  const brandFit = ["biolinx", "aro", "both"].includes(String(b.brandFit)) ? String(b.brandFit) : (lead.brandFit ?? brandFitForNiche(niche));
  await db
    .update(schema.leads)
    .set({ sourcingReview: "accepted", affiliationStatus: affiliation, subProfile: sp, subProfileConfidence: "human", niche, brandFit, enrichmentStatus: "pending", ...flags })
    .where(eq(schema.leads.id, id));
  await audit(req, "lead.sourcing.accept", "leads", id, { affiliation, subProfile: sp, niche });
  if (lead.email) void runCustomerioSync(db, undefined, { leadIds: [id] }).catch(() => {});
  return { ok: true };
});

// ── Jobs (manual triggers, lock-guarded) ────────────────────────────────

const jobTriggers: Record<string, () => Promise<unknown>> = {
  "idev-sync": () => runIdevSync(db),
  "rank-recompute": () => runRankRecompute(db),
  "referral-expiry": () => runReferralExpiry(db),
  "metrics-digest": () => runMetricsDigest(db),
  "enrich-personalize": () => runEnrichPersonalize(db),
  "lead-ingest": () => runLeadIngest(db),
  "customerio-sync": () => runCustomerioSync(db),
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

// ── Swipe file → Biolinx content library ───────────────────────────────
// Biolinx checks compliance, not quality, so nothing is sent without a person's
// Approve here (Biolinx then holds each post as a draft until Publish). Decline asks what should change and regenerates.

const CALLBACK_PATH = "/webhooks/biolinx/content";
const contentClient = () => {
  const cfg = contentConfigFromEnv();
  return cfg ? createContentClient(cfg) : null;
};
const draftModel = () => process.env.DRAFT_MODEL ?? "claude-sonnet-5";

app.get("/api/swipe", { preHandler: requireRole("admin", "ops") }, async (req) => {
  const q = (req.query ?? {}) as { status?: string };
  const rows = await db.select().from(schema.swipePosts).orderBy(desc(schema.swipePosts.id)).limit(500);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const list = q.status && q.status !== "all" ? rows.filter((r) => r.status === q.status) : rows.filter((r) => r.status !== "declined");
  const origin = (process.env.ADMIN_ORIGIN ?? "https://gemboxpk.com").split(",")[0]!.replace(/\/+$/, "");
  const [lastSearch] = await recentSwipeSearches(db, 1);
  return {
    sources: { ...(await unusedSwipeSources(db)), searchDaily: process.env.SWIPE_SEARCH_DAILY === "true", lastSearch: lastSearch ? { at: lastSearch.startedAt, status: lastSearch.status, detail: lastSearch.detail } : null },
    connection: {
      configured: !!process.env.BIOLINX_CONTENT_SECRET,
      autoSend: process.env.BIOLINX_CONTENT_ENABLED === "true",
      biolinxMakesImages: biolinxMakesImages(),
      baseUrl: process.env.BIOLINX_CONTENT_BASE_URL || "https://biolinxlabs.com",
      callbackUrl: `${origin}${CALLBACK_PATH}`,
    },
    counts,
    posts: list.map((r) => ({
      ...r,
      sourcePostUrl: r.sourcePostUrl && /^https?:\/\//.test(r.sourcePostUrl) ? r.sourcePostUrl : null,
      imageUrl: r.imageUrl && /^https:\/\//.test(r.imageUrl) ? r.imageUrl : null,
      mediaUrl: r.mediaUrl && /^https:\/\//.test(r.mediaUrl) ? r.mediaUrl : null,
    })),
  };
});

app.post("/api/swipe/generate", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const count = Math.max(1, Math.min(10, Number((req.body as { count?: number } | undefined)?.count) || 3));
  let llm;
  try {
    llm = anthropicFromEnv();
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const result = await withMysqlLock(conn.pool, "job:swipe-generate", () => generateSwipeDrafts(db, llm, draftModel(), count));
  if (result === null) return reply.code(409).send({ error: "posts are already being generated" });
  await audit(req, "swipe.generate", "swipe_posts", null, { count, created: result.created, failed: result.failed.length });
  return { ok: true, result };
});

app.post("/api/swipe/find-sources", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const result = await withMysqlLock(conn.pool, "job:swipe-search", () => runSwipeSearch(db));
  if (result === null) return reply.code(409).send({ error: "a search is already running" });
  await audit(req, "swipe.find_sources", "swipe_sources", null, { added: result.added, cost: result.estimatedCostUsd, skipped: result.skipped ?? null });
  return { ok: true, result };
});

app.put("/api/swipe/:id", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const b = (req.body ?? {}) as { hook?: string; caption?: string; hashtags?: string[] | string; imageText?: string; imageBrief?: string; imageUrl?: string | null };
  const imageUrl = b.imageUrl === undefined ? undefined : b.imageUrl ? String(b.imageUrl).trim().slice(0, 1000) : null;
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) return reply.code(400).send({ error: "the image link must start with https://" });
  const r = await editSwipePost(db, id, {
    ...(b.hook !== undefined ? { hook: String(b.hook).slice(0, 120) } : {}),
    ...(b.caption !== undefined ? { caption: String(b.caption).slice(0, 2200) } : {}),
    ...(b.hashtags !== undefined ? { hashtags: cleanHashtags(b.hashtags) } : {}),
    ...(b.imageText !== undefined ? { imageText: String(b.imageText).slice(0, 120) } : {}),
    ...(b.imageBrief !== undefined ? { imageBrief: String(b.imageBrief).slice(0, 1000) } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  });
  if (!r.ok) return reply.code(409).send({ error: r.reason });
  await audit(req, "swipe.edit", "swipe_posts", id, { fields: Object.keys(b) });
  return r;
});

app.post("/api/swipe/:id/approve", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const r = await approveSwipePost(db, id, req.user!.id);
  if (!r.ok) return reply.code(409).send({ error: r.reason });
  await audit(req, "swipe.approve", "swipe_posts", id, {});
  return r;
});

app.post("/api/swipe/:id/decline", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const feedback = String((req.body as { feedback?: string } | undefined)?.feedback ?? "").trim();
  if (feedback.length < 3) return reply.code(400).send({ error: "Tell the writer what should change (what's wrong, what you want instead)." });
  let llm;
  try {
    llm = anthropicFromEnv();
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const r = await declineAndRegenerate(db, llm, draftModel(), id, feedback, req.user!.id);
  await audit(req, "swipe.decline", "swipe_posts", id, { feedback: feedback.slice(0, 300), regenerated: r.ok ? r.newId : null });
  if (!r.ok) return reply.code(409).send({ error: r.reason });
  return r;
});

app.post("/api/swipe/send", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const client = contentClient();
  if (!client) return reply.code(400).send({ error: "Add the Biolinx shared secret in Settings first." });
  const r = await withMysqlLock(conn.pool, "job:swipe-sync", () => sendApprovedSwipePosts(db, client));
  if (r === null) return reply.code(409).send({ error: "a send is already running" });
  await audit(req, "swipe.send", "swipe_posts", null, r);
  return { ok: true, result: r };
});

app.post("/api/swipe/:id/redo-image", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const b = (req.body ?? {}) as { note?: string; imageText?: string; imageBrief?: string };
  const note = String(b.note ?? "").trim();
  if (note.length < 3) return reply.code(400).send({ error: "Say what should change in the image." });
  const client = contentClient();
  if (!client) return reply.code(400).send({ error: "Add the Biolinx shared secret in Settings first." });
  const r = await redoSwipeImage(db, client, id, {
    note,
    ...(b.imageText !== undefined ? { imageText: String(b.imageText) } : {}),
    ...(b.imageBrief !== undefined ? { imageBrief: String(b.imageBrief) } : {}),
  });
  await audit(req, "swipe.redo_image", "swipe_posts", id, { note: note.slice(0, 300), ok: r.ok });
  if (!r.ok) return reply.code(409).send({ error: r.reason });
  return r;
});

app.post("/api/swipe/:id/refresh", { preHandler: requireRole("admin", "ops") }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const client = contentClient();
  if (!client) return reply.code(400).send({ error: "Add the Biolinx shared secret in Settings first." });
  const [row] = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.id, id));
  if (!row) return reply.code(404).send({ error: "post not found" });
  try {
    const post = await client.getPost(row.externalId);
    if (!post) return reply.code(404).send({ error: "Biolinx doesn't know this post (it may not have been sent)." });
    await applyBiolinxPost(db, post, null);
    return { ok: true, post };
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

/** Proves the secret and URL work without creating anything: a signed lookup of an id that
 *  can't exist should come back 404. 401 means a wrong secret, 503 means receiving is off. */
app.post("/api/swipe/test-connection", { preHandler: requireRole("admin"), config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
  const client = contentClient();
  if (!client) return reply.code(400).send({ error: "Add the Biolinx shared secret in Settings first." });
  try {
    const post = await client.getPost(`bs-connection-test-${Date.now()}`);
    await audit(req, "swipe.test_connection", "swipe_posts", null, { ok: true });
    return { ok: true, message: post ? "Connected (unexpected: a test id exists)." : "Connected: Biolinx accepted our signature." };
  } catch (e) {
    await audit(req, "swipe.test_connection", "swipe_posts", null, { ok: false, error: (e as Error).message.slice(0, 200) });
    return reply.code(502).send({ error: (e as Error).message });
  }
});

// Callbacks from Biolinx. The signature covers the exact bytes, so this route parses
// JSON itself from the raw body instead of using Fastify's re-serializable parse.
await app.register(async (scope) => {
  scope.removeContentTypeParser("application/json");
  scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body));
  scope.post(CALLBACK_PATH, async (req, reply) => {
    const secret = process.env.BIOLINX_CONTENT_SECRET;
    if (!secret) return reply.code(503).send({ error: "content secret not configured" });
    const raw = typeof req.body === "string" ? req.body : "";
    const check = verifySignature({
      timestamp: req.headers["x-biolinx-timestamp"] as string | undefined,
      signature: req.headers["x-biolinx-signature"] as string | undefined,
      rawBody: raw,
      secret,
    });
    if (!check.ok) {
      req.log.warn({ reason: check.reason }, "biolinx callback refused");
      return reply.code(401).send({ error: "bad signature" });
    }
    let body: CallbackBody;
    try {
      body = JSON.parse(raw) as CallbackBody;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    const known = await applyCallback(db, body);
    await db.insert(schema.auditLog).values({ actorUserId: null, actorJob: "biolinx-callback", action: `swipe.${body.event ?? "unknown"}`, subjectTable: "swipe_posts", subjectId: null, detail: { external_id: body.post?.external_id, status: body.post?.status, image_check: body.post?.image_check, known } });
    // Unknown ids still get a 2xx so Biolinx doesn't retry something we can never match.
    return { received: true, known };
  });
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
