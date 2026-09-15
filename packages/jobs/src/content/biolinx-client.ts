// Client for the Biolinx Post Intake API (docs/integrations/biolinx-content-api.md).
// Both directions sign "<unix seconds>.<raw body>" with HMAC-SHA256 and a shared
// secret; the timestamp must be within 5 minutes. Pure helpers are exported for tests.

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 300;
export const MAX_POSTS_PER_REQUEST = 25;

export type BiolinxNiche = "fitness" | "bodybuilding" | "longevity" | "research" | "skin" | "metabolic" | "wellness";
export type BiolinxPlatform = "instagram" | "tiktok" | "youtube" | "facebook" | "x";
export type BiolinxFormat = "square" | "portrait" | "thumbnail";

export interface OutboundPost {
  external_id: string;
  /** Our own image. Omitted when Biolinx makes the image from image_text and image_brief. */
  image_url?: string;
  /** Words printed on the image (8 words max). Sent when Biolinx makes the image. */
  image_text?: string;
  /** What the image shows, for Biolinx's image generator. Sent when Biolinx makes the image. */
  image_brief?: string;
  hook: string;
  caption: string;
  hashtags?: string[];
  niche: BiolinxNiche;
  platform: BiolinxPlatform;
  format: BiolinxFormat;
  hook_type?: string;
  source_post_url?: string;
  meta?: Record<string, unknown>;
}

export interface PostResult {
  external_id: string;
  result: "accepted" | "duplicate" | "rejected";
  id?: number;
  status?: string;
  added?: string[];
  reasons?: string[];
}

export interface SendResponse {
  ok: boolean;
  accepted: number;
  duplicates: number;
  rejected: number;
  remaining_today: number;
  results: PostResult[];
}

export interface BiolinxPost {
  id: number;
  external_id: string;
  status: "processing" | "in_review" | "published" | "retired" | "failed";
  image_url: string | null;
  media_id: number | null;
  image_check: "passed" | "flagged" | "unchecked" | null;
  issues: string[];
  error: string | null;
  added: string[];
  copies?: number;
  downloads?: number;
  received_at?: string;
  updated_at?: string;
}

export interface ImageRequest {
  /** What the reviewer wants changed in the image. */
  note: string;
  image_text: string;
  image_brief: string;
}

export interface CallbackBody {
  event: "post.ready" | "post.failed" | "post.published" | "post.retired";
  sent_at: string;
  post: BiolinxPost;
}

export function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signedHeaders(secret: string, rawBody: string, now: Date = new Date()): Record<string, string> {
  const ts = Math.floor(now.getTime() / 1000).toString();
  return { "X-Biolinx-Timestamp": ts, "X-Biolinx-Signature": signBody(secret, ts, rawBody) };
}

/** Checks a request from Biolinx. `rawBody` must be the exact bytes received, not re-serialized JSON. */
export function verifySignature(input: {
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  secret: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  const { timestamp, signature, rawBody, secret } = input;
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "missing or malformed timestamp" };
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "missing or malformed signature" };
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside 5 minutes" };
  const expected = Buffer.from(signBody(secret, timestamp, rawBody), "hex");
  const provided = Buffer.from(signature, "hex");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export interface ContentClientConfig {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class BiolinxApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function contentConfigFromEnv(env = process.env): ContentClientConfig | null {
  const secret = env.BIOLINX_CONTENT_SECRET;
  if (!secret) return null;
  return { baseUrl: (env.BIOLINX_CONTENT_BASE_URL || "https://biolinxlabs.com").replace(/\/+$/, ""), secret };
}

export function createContentClient(cfg: ContentClientConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
      method,
      redirect: "error",
      headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...signedHeaders(cfg.secret, raw, now()) },
      ...(method === "POST" ? { body: raw } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    return { status: res.status, json, text };
  };
  const explain = (status: number, json: unknown, text: string) => {
    const msg = (json as { message?: string; error?: string } | null)?.message ?? (json as { error?: string } | null)?.error;
    const meaning: Record<number, string> = { 401: "bad or expired signature", 422: "malformed batch", 429: "rate limit", 503: "receiving is turned off in the Biolinx admin" };
    return `Biolinx API HTTP ${status} (${meaning[status] ?? "error"})${msg ? `: ${String(msg).slice(0, 200)}` : text ? `: ${text.slice(0, 120)}` : ""}`;
  };
  return {
    /** POST /api/content/assets. At most 25 posts per request. */
    async sendPosts(posts: OutboundPost[]): Promise<SendResponse> {
      if (posts.length === 0 || posts.length > MAX_POSTS_PER_REQUEST) throw new Error(`send 1-${MAX_POSTS_PER_REQUEST} posts per request (got ${posts.length})`);
      const r = await call("POST", "/api/content/assets", { posts });
      if (r.status !== 200) throw new BiolinxApiError(r.status, explain(r.status, r.json, r.text));
      return r.json as SendResponse;
    },
    /** GET /api/content/assets/{external_id}. null when Biolinx doesn't know the id (404). */
    async getPost(externalId: string): Promise<BiolinxPost | null> {
      const r = await call("GET", `/api/content/assets/${encodeURIComponent(externalId)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new BiolinxApiError(r.status, explain(r.status, r.json, r.text));
      return (r.json as { post: BiolinxPost }).post;
    },
    /** POST /api/content/assets/{external_id}/image: ask Biolinx for a new image with a reviewer's
     *  note. The new link arrives later as a post.ready callback. */
    async requestImage(externalId: string, body: ImageRequest): Promise<BiolinxPost | null> {
      const r = await call("POST", `/api/content/assets/${encodeURIComponent(externalId)}/image`, body);
      if (r.status === 404) throw new BiolinxApiError(404, "Biolinx doesn't know this post, or hasn't added the new-image endpoint yet");
      if (r.status !== 200 && r.status !== 202) throw new BiolinxApiError(r.status, explain(r.status, r.json, r.text));
      return (r.json as { post?: BiolinxPost } | null)?.post ?? null;
    },
  };
}
