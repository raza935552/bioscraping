// Swipe file → Biolinx content library. The bioscraper is the quality judge
// (Biolinx checks compliance only, then holds posts as drafts until Publish), so every
// post is picked from real outperforming posts, written to pass the rules, and
// approved by a person before it is sent. A declined post is regenerated from the
// reviewer's feedback as a new version.

import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import { normalizeNiche } from "@biolinx/core";
import { schema, type Db } from "@biolinx/db";
import type { LlmClient } from "@biolinx/drafting";
import { findTerm, looksNonEnglish } from "@biolinx/scraping";
import { MAX_POSTS_PER_REQUEST, type BiolinxPost, type CallbackBody, type ImageRequest, type OutboundPost, type SendResponse } from "./biolinx-client.js";
import { biolinxNiche, biolinxPlatform, formatFor, preflight } from "./content-rules.js";
import { writeSwipePost, type SwipeSource } from "./post-writer.js";

type SwipeRow = typeof schema.swipePosts.$inferSelect;

export interface ContentClient {
  sendPosts(posts: OutboundPost[]): Promise<SendResponse>;
  getPost(externalId: string): Promise<BiolinxPost | null>;
  requestImage(externalId: string, body: ImageRequest): Promise<BiolinxPost | null>;
}

/** Settings → "Biolinx makes the images". ON = posts go out with image words and a brief, and
 *  Biolinx's generator makes the image and calls back with its link. OFF = a person adds a link. */
export function biolinxMakesImages(env = process.env): boolean {
  return env.BIOLINX_MAKES_IMAGES === "true";
}

export function newExternalId(now: Date = new Date()): string {
  return `bs-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
}

export interface SwipeCandidate extends SwipeSource {
  leadId: number;
  score: number;
}

/** Outlier posts worth learning from, best first. Pure: feed it leads, their read bundles,
 *  per-niche match terms, and the source URLs already used. */
export function pickCandidates(input: {
  leads: Array<{ id: number; niche: string | null; primaryPlatform: string | null; geoCountry: string | null; source: string | null; sourcingReview: string | null }>;
  bundles: Map<number, { items?: Array<{ url: string; text?: string; postedAt?: string | null; views?: number; likes?: number; comments?: number }> }>;
  matchTermsByNiche: Map<string, string[]>;
  usedUrls: Set<string>;
  now: Date;
  minViews?: number;
  minRatio?: number;
  maxAgeDays?: number;
}): SwipeCandidate[] {
  const { minViews = 20_000, minRatio = 2, maxAgeDays = 120, now } = input;
  const out: SwipeCandidate[] = [];
  for (const lead of input.leads) {
    if (lead.sourcingReview === "rejected") continue;
    if (lead.geoCountry && lead.geoCountry !== "US") continue;
    const niche = normalizeNiche(lead.niche);
    const terms = (niche && input.matchTermsByNiche.get(niche)) || [];
    const items = (input.bundles.get(lead.id)?.items ?? []).filter((i) => typeof i.views === "number" && i.views > 0 && /^https?:\/\//.test(i.url));
    if (items.length < 4) continue; // an average needs a few posts
    const avg = items.reduce((a, i) => a + i.views!, 0) / items.length;
    for (const i of items) {
      const ratio = i.views! / avg;
      const text = (i.text ?? "").trim();
      const age = i.postedAt ? (now.getTime() - new Date(i.postedAt).getTime()) / 86_400_000 : 0;
      // A source has to say something: at least 40 characters once hashtags and @mentions are removed.
      const words = text.replace(/[#@][\p{L}\p{N}_.]+/gu, " ").replace(/\s+/g, " ").trim();
      if (i.views! < minViews || ratio < minRatio || age > maxAgeDays || words.length < 40) continue;
      if (input.usedUrls.has(i.url) || looksNonEnglish(text)) continue;
      if (terms.length && !findTerm(text, terms)) continue;
      out.push({
        leadId: lead.id,
        platform: (lead.primaryPlatform ?? "").toLowerCase(),
        url: i.url,
        text,
        views: i.views!,
        likes: i.likes ?? null,
        comments: i.comments ?? null,
        outlierRatio: Math.round(ratio * 10) / 10,
        niche,
        score: ratio * Math.log10(i.views!),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

async function loadCandidates(db: Db, now: Date): Promise<SwipeCandidate[]> {
  const leads = await db
    .select({ id: schema.leads.id, niche: schema.leads.niche, primaryPlatform: schema.leads.primaryPlatform, geoCountry: schema.leads.geoCountry, source: schema.leads.source, sourcingReview: schema.leads.sourcingReview })
    .from(schema.leads);
  const bundles = new Map<number, { items?: Array<{ url: string; text?: string; postedAt?: string | null; views?: number; likes?: number; comments?: number }> }>();
  for (const e of await db.select({ leadId: schema.leadEnrichments.leadId, bundle: schema.leadEnrichments.bundle, status: schema.leadEnrichments.status }).from(schema.leadEnrichments).orderBy(desc(schema.leadEnrichments.id))) {
    if (!bundles.has(e.leadId) && e.status !== "failed" && e.bundle) bundles.set(e.leadId, e.bundle as never);
  }
  const matchTermsByNiche = new Map<string, string[]>();
  for (const p of await db.select({ niche: schema.sourcingProfiles.niche, matchTerms: schema.sourcingProfiles.matchTerms }).from(schema.sourcingProfiles)) {
    const n = normalizeNiche(p.niche);
    if (!n) continue;
    matchTermsByNiche.set(n, [...new Set([...(matchTermsByNiche.get(n) ?? []), ...(((p.matchTerms as string[] | null) ?? []))])]);
  }
  const usedUrls = new Set((await db.select({ u: schema.swipePosts.sourcePostUrl }).from(schema.swipePosts)).map((r) => r.u).filter((u): u is string => !!u));
  return pickCandidates({ leads, bundles, matchTermsByNiche, usedUrls, now });
}

export interface GenerateSummary {
  considered: number;
  created: number;
  failed: Array<{ source: string; reason: string }>;
}

/** Verified Biolinx facts from Settings (one per line). Empty until someone confirms them. */
export function brandFacts(env = process.env): string[] {
  return (env.BIOLINX_BRAND_FACTS ?? "")
    .split(/\r?\n|;/)
    .map((f) => f.trim())
    .filter((f) => f.length > 3)
    .slice(0, 30);
}

async function recentCraft(db: Db): Promise<{ hooks: string[]; angles: string[] }> {
  const rows = await db.select({ hook: schema.swipePosts.hook, angle: schema.swipePosts.angle }).from(schema.swipePosts).orderBy(desc(schema.swipePosts.id)).limit(20);
  return { hooks: rows.map((r) => r.hook), angles: [...new Set(rows.map((r) => r.angle).filter((a): a is string => !!a))] };
}

/** Writes up to `count` new drafts from the best unused outlier posts. Spends Anthropic credit. */
export async function generateSwipeDrafts(db: Db, llm: LlmClient, model: string, count: number, now = new Date()): Promise<GenerateSummary> {
  const candidates = await loadCandidates(db, now);
  const facts = brandFacts();
  const summary: GenerateSummary = { considered: candidates.length, created: 0, failed: [] };
  for (const c of candidates) {
    if (summary.created >= count) break;
    const niche = biolinxNiche(c.niche);
    const platform = biolinxPlatform(c.platform);
    const format = formatFor(platform);
    const result = await writeSwipePost(llm, model, { source: c, biolinxNiche: niche, platform, format, facts, avoid: await recentCraft(db) });
    if (result.status !== "ok") {
      summary.failed.push({ source: c.url, reason: result.reason });
      continue;
    }
    const externalId = newExternalId(now);
    const p = result.post;
    await db.insert(schema.swipePosts).values({
      externalId,
      sourceLeadId: c.leadId,
      sourcePostUrl: c.url,
      sourcePlatform: c.platform,
      sourceStats: { views: c.views, likes: c.likes, comments: c.comments, outlierRatio: c.outlierRatio, text: c.text.slice(0, 500), rejectedVariants: result.rejectedVariants },
      niche: c.niche,
      biolinxNiche: niche,
      platform,
      format,
      hookType: p.hookType,
      angle: p.angle,
      hook: p.hook,
      caption: p.caption,
      hashtags: p.hashtags,
      imageText: p.imageText,
      imageBrief: p.imageBrief,
      preflight: preflight({ external_id: externalId, hook: p.hook, caption: p.caption, hashtags: p.hashtags, imageText: p.imageText, imageBrief: p.imageBrief }),
      status: "draft",
    });
    summary.created++;
  }
  return summary;
}

/** Declined: keep the row as declined with the reviewer's words, write a new version from them. */
export async function declineAndRegenerate(db: Db, llm: LlmClient, model: string, id: number, feedback: string, userId: number | null, now = new Date()): Promise<{ ok: true; newId: number } | { ok: false; reason: string }> {
  const [row] = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.id, id));
  if (!row) return { ok: false, reason: "post not found" };
  if (!["draft", "approved", "rejected", "failed"].includes(row.status)) return { ok: false, reason: `a ${row.status} post can't be declined` };
  if (!feedback.trim()) return { ok: false, reason: "tell the writer what should change" };
  await db.update(schema.swipePosts).set({ status: "declined", reviewerFeedback: feedback.trim().slice(0, 2000), decidedByUserId: userId, decidedAt: now }).where(eq(schema.swipePosts.id, id));
  const stats = (row.sourceStats as { views?: number; likes?: number | null; comments?: number | null; outlierRatio?: number; text?: string } | null) ?? {};
  const result = await writeSwipePost(llm, model, {
    source: { platform: row.sourcePlatform ?? row.platform, url: row.sourcePostUrl ?? "", text: stats.text ?? "", views: stats.views ?? 0, likes: stats.likes ?? null, comments: stats.comments ?? null, outlierRatio: stats.outlierRatio ?? 1, niche: row.niche },
    biolinxNiche: row.biolinxNiche as never,
    platform: row.platform as never,
    format: row.format as never,
    feedback,
    previous: { hook: row.hook, caption: row.caption, imageText: row.imageText, imageBrief: row.imageBrief },
    facts: brandFacts(),
    avoid: await recentCraft(db),
  });
  if (result.status !== "ok") return { ok: false, reason: result.reason };
  const externalId = newExternalId(now);
  const p = result.post;
  const [ins] = await db
    .insert(schema.swipePosts)
    .values({
      externalId,
      parentId: row.id,
      version: row.version + 1,
      sourceLeadId: row.sourceLeadId,
      sourcePostUrl: row.sourcePostUrl,
      sourcePlatform: row.sourcePlatform,
      sourceStats: row.sourceStats,
      niche: row.niche,
      biolinxNiche: row.biolinxNiche,
      platform: row.platform,
      format: row.format,
      hookType: p.hookType,
      angle: p.angle,
      hook: p.hook,
      caption: p.caption,
      hashtags: p.hashtags,
      imageText: p.imageText,
      imageBrief: p.imageBrief,
      preflight: preflight({ external_id: externalId, hook: p.hook, caption: p.caption, hashtags: p.hashtags, imageText: p.imageText, imageBrief: p.imageBrief }),
      status: "draft",
    })
    .$returningId();
  return { ok: true, newId: ins!.id };
}

/** Human edits to a draft (copy, image words and brief, or image link). Pre-flight is recomputed. */
export async function editSwipePost(db: Db, id: number, edits: { hook?: string; caption?: string; hashtags?: string[]; imageText?: string; imageBrief?: string; imageUrl?: string | null }) {
  const [row] = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.id, id));
  if (!row) return { ok: false as const, reason: "post not found" };
  if (!["draft", "approved", "rejected", "failed"].includes(row.status)) return { ok: false as const, reason: `a ${row.status} post can't be edited` };
  const next = {
    hook: edits.hook ?? row.hook,
    caption: edits.caption ?? row.caption,
    hashtags: edits.hashtags ?? ((row.hashtags as string[] | null) ?? []),
    imageText: edits.imageText ?? row.imageText,
    imageBrief: edits.imageBrief ?? row.imageBrief,
    imageUrl: edits.imageUrl === undefined ? row.imageUrl : edits.imageUrl,
  };
  const reasons = preflight({ external_id: row.externalId, hook: next.hook, caption: next.caption, hashtags: next.hashtags, imageText: next.imageText, imageBrief: next.imageBrief, image_url: next.imageUrl });
  await db.update(schema.swipePosts).set({ ...next, preflight: reasons, status: "draft" }).where(eq(schema.swipePosts.id, id));
  return { ok: true as const, preflight: reasons };
}

/** Why a post can't be sent yet as far as its image goes, or null when it can. */
export function imageBlocker(row: Pick<SwipeRow, "imageUrl" | "imageText" | "imageBrief">, makesImages: boolean): string | null {
  if (row.imageUrl) return null;
  if (!makesImages) return "add the image link first (or turn on \"Biolinx makes the images\" in Settings)";
  if (!row.imageText?.trim() || (row.imageBrief ?? "").trim().length < 10) return "Biolinx needs the image words and an image brief to make the image";
  return null;
}

/** Approve for sending. Requires a clean pre-flight and either an image link or, when Biolinx
 *  makes the images, the image words and brief. */
export async function approveSwipePost(db: Db, id: number, userId: number | null, now = new Date(), makesImages = biolinxMakesImages()) {
  const [row] = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.id, id));
  if (!row) return { ok: false as const, reason: "post not found" };
  if (row.status !== "draft") return { ok: false as const, reason: `only drafts can be approved (this one is ${row.status})` };
  const blocker = imageBlocker(row, makesImages);
  if (blocker) return { ok: false as const, reason: blocker };
  const reasons = preflight({ external_id: row.externalId, hook: row.hook, caption: row.caption, hashtags: (row.hashtags as string[] | null) ?? [], imageText: row.imageText, imageBrief: row.imageBrief, image_url: row.imageUrl });
  if (reasons.length) {
    await db.update(schema.swipePosts).set({ preflight: reasons }).where(eq(schema.swipePosts.id, id));
    return { ok: false as const, reason: `fix before approving: ${reasons.join("; ")}` };
  }
  await db.update(schema.swipePosts).set({ status: "approved", decidedByUserId: userId, decidedAt: now, preflight: [] }).where(eq(schema.swipePosts.id, id));
  return { ok: true as const };
}

export function toOutbound(row: SwipeRow): OutboundPost {
  return {
    external_id: row.externalId,
    // Our own image when a person added one; otherwise Biolinx makes it from the words and brief.
    ...(row.imageUrl ? { image_url: row.imageUrl } : { image_text: row.imageText ?? "", image_brief: row.imageBrief ?? "" }),
    hook: row.hook,
    caption: row.caption,
    hashtags: (row.hashtags as string[] | null) ?? [],
    niche: row.biolinxNiche as OutboundPost["niche"],
    platform: row.platform as OutboundPost["platform"],
    format: row.format as OutboundPost["format"],
    ...(row.hookType ? { hook_type: row.hookType } : {}),
    ...(row.sourcePostUrl ? { source_post_url: row.sourcePostUrl } : {}),
    meta: { bioscraper_id: row.id, version: row.version, angle: row.angle, image_brief: row.imageBrief },
  };
}

export interface SendSummary {
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  remainingToday: number | null;
  error?: string;
}

/** Sends approved posts in batches of 25 until Biolinx's daily allowance runs out. */
export async function sendApprovedSwipePosts(db: Db, client: ContentClient, now = new Date()): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, remainingToday: null };
  for (;;) {
    const batch = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.status, "approved")).orderBy(schema.swipePosts.decidedAt).limit(MAX_POSTS_PER_REQUEST);
    if (batch.length === 0 || summary.remainingToday === 0) break;
    const ids = batch.map((r) => r.id);
    await db.update(schema.swipePosts).set({ status: "sending", sentAt: now }).where(inArray(schema.swipePosts.id, ids));
    let res: SendResponse;
    try {
      res = await client.sendPosts(batch.map(toOutbound));
    } catch (e) {
      // Nothing was accepted: put them back so the next run retries.
      await db.update(schema.swipePosts).set({ status: "approved", error: (e as Error).message.slice(0, 1000) }).where(inArray(schema.swipePosts.id, ids));
      summary.error = (e as Error).message;
      break;
    }
    summary.sent += batch.length;
    summary.remainingToday = res.remaining_today;
    const byExt = new Map(batch.map((r) => [r.externalId, r]));
    for (const r of res.results) {
      const row = byExt.get(r.external_id);
      if (!row) continue;
      if (r.result === "accepted") summary.accepted++;
      if (r.result === "duplicate") summary.duplicates++;
      if (r.result === "rejected") summary.rejected++;
      await db
        .update(schema.swipePosts)
        .set({
          status: r.result === "accepted" ? "sent" : r.result,
          biolinxId: r.id ?? null,
          biolinxStatus: r.status ?? null,
          added: r.added ?? null,
          reasons: r.reasons ?? null,
          error: null,
        })
        .where(eq(schema.swipePosts.id, row.id));
      byExt.delete(r.external_id);
    }
    // Any post Biolinx didn't mention goes back to approved.
    if (byExt.size) await db.update(schema.swipePosts).set({ status: "approved" }).where(inArray(schema.swipePosts.id, [...byExt.values()].map((r) => r.id)));
    if (batch.length < MAX_POSTS_PER_REQUEST) break;
  }
  return summary;
}

export interface RedoImageInput {
  note: string;
  /** Optional new words for the image and a new brief; the current ones are kept otherwise. */
  imageText?: string;
  imageBrief?: string;
}

/** "Redo image": ask Biolinx for a new image with the reviewer's note. The post keeps its
 *  external_id; the new link comes back as a post.ready callback. Published or retired posts
 *  are left alone (retire and write a new version instead). */
export async function redoSwipeImage(db: Db, client: ContentClient, id: number, input: RedoImageInput, now = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db.select().from(schema.swipePosts).where(eq(schema.swipePosts.id, id));
  if (!row) return { ok: false, reason: "post not found" };
  if (row.status !== "sent" && row.status !== "failed") return { ok: false, reason: "only posts already sent to Biolinx get a new image there (for a draft, edit the image words or brief)" };
  if (row.biolinxStatus === "published" || row.biolinxStatus === "retired") return { ok: false, reason: `this post is ${row.biolinxStatus} on Biolinx; decline it for a new version instead` };
  if (row.imageUrl) return { ok: false, reason: "this post uses our own image link; edit the link instead" };
  const note = input.note.trim();
  if (note.length < 3) return { ok: false, reason: "say what should change in the image" };
  const imageText = (input.imageText ?? row.imageText ?? "").trim().slice(0, 120);
  const imageBrief = (input.imageBrief ?? row.imageBrief ?? "").trim().slice(0, 1000);
  const reasons = preflight({ external_id: row.externalId, hook: row.hook, caption: row.caption, hashtags: (row.hashtags as string[] | null) ?? [], imageText, imageBrief }).filter((r) => r.startsWith("image"));
  if (reasons.length) return { ok: false, reason: `fix the image words first: ${reasons.join("; ")}` };
  try {
    await client.requestImage(row.externalId, { note: note.slice(0, 1000), image_text: imageText, image_brief: imageBrief });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  await db
    .update(schema.swipePosts)
    .set({ imageText, imageBrief, imageFeedback: note.slice(0, 2000), imageRequests: row.imageRequests + 1, mediaUrl: null, mediaId: null, imageCheck: null, issues: [], status: "sent", biolinxStatus: "processing", error: null, sentAt: now, lastEvent: "image.requested", lastEventAt: now })
    .where(eq(schema.swipePosts.id, id));
  // The new image link arrives by callback (or the 10-minute status lookup), never from this reply,
  // so an old link in the reply can't be mistaken for the new image.
  return { ok: true };
}

/** A Biolinx post object (from a callback or a status lookup) onto our row. */
export async function applyBiolinxPost(db: Db, post: BiolinxPost, event: string | null, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ id: schema.swipePosts.id }).from(schema.swipePosts).where(eq(schema.swipePosts.externalId, post.external_id));
  if (!row) return false;
  await db
    .update(schema.swipePosts)
    .set({
      biolinxId: post.id ?? null,
      biolinxStatus: post.status ?? null,
      mediaUrl: post.image_url && /^https:\/\//.test(post.image_url) ? post.image_url.slice(0, 1000) : null,
      mediaId: post.media_id ?? null,
      imageCheck: post.image_check ?? null,
      issues: post.issues ?? [],
      added: post.added ?? null,
      error: post.error ?? null,
      ...(post.status === "failed" ? { status: "failed" } : { status: "sent" }),
      ...(event ? { lastEvent: event, lastEventAt: now } : {}),
    })
    .where(eq(schema.swipePosts.id, row.id));
  return true;
}

export async function applyCallback(db: Db, body: CallbackBody, now = new Date()): Promise<boolean> {
  if (!body?.post?.external_id) return false;
  return applyBiolinxPost(db, body.post, body.event ?? null, now);
}

/** Backup to callbacks: look up sent posts Biolinx hasn't settled after 10 minutes. */
export async function refreshSwipeStatuses(db: Db, client: ContentClient, now = new Date()): Promise<{ checked: number; updated: number }> {
  const cutoff = new Date(now.getTime() - 10 * 60_000);
  const rows = await db
    .select()
    .from(schema.swipePosts)
    .where(and(eq(schema.swipePosts.status, "sent"), or(eq(schema.swipePosts.biolinxStatus, "processing"), eq(schema.swipePosts.biolinxStatus, "in_review")), isNotNull(schema.swipePosts.sentAt), lt(schema.swipePosts.sentAt, cutoff)))
    .limit(50);
  let updated = 0;
  for (const r of rows) {
    const post = await client.getPost(r.externalId);
    if (post && (await applyBiolinxPost(db, post, null, now))) updated++;
  }
  return { checked: rows.length, updated };
}

