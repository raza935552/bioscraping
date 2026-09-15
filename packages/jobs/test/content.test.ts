import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUO_LINE } from "@biolinx/compliance";
import { createContentClient, signBody, signedHeaders, verifySignature } from "../src/content/biolinx-client.js";
import { biolinxNiche, cleanHashtags, formatFor, preflight, withDisclosures } from "../src/content/content-rules.js";
import { parseVariants, writeSwipePost, writerPrompt, type WriteRequest } from "../src/content/post-writer.js";
import { pickCandidates, toOutbound } from "../src/content/swipe.js";

const SECRET = "test-secret";
const now = new Date("2026-09-15T03:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));

describe("Biolinx signing (API doc §1)", () => {
  it("signs '<timestamp>.<raw body>' with HMAC-SHA256 hex, like the doc's Node example", () => {
    const body = JSON.stringify({ posts: [] });
    expect(signBody(SECRET, ts, body)).toBe(createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex"));
    expect(signedHeaders(SECRET, "", now)).toEqual({ "X-Biolinx-Timestamp": ts, "X-Biolinx-Signature": signBody(SECRET, ts, "") });
  });

  it("verifies callbacks on the exact bytes and rejects tampering, old timestamps and the wrong secret", () => {
    const raw = '{"event":"post.ready","post":{"external_id":"bs-1"}}';
    const signature = signBody(SECRET, ts, raw);
    expect(verifySignature({ timestamp: ts, signature, rawBody: raw, secret: SECRET, now })).toEqual({ ok: true });
    expect(verifySignature({ timestamp: ts, signature, rawBody: raw.replace("ready", "failed"), secret: SECRET, now }).ok).toBe(false);
    expect(verifySignature({ timestamp: ts, signature, rawBody: JSON.stringify(JSON.parse(raw), null, 1), secret: SECRET, now }).ok).toBe(false); // re-serialized ≠ raw
    expect(verifySignature({ timestamp: String(Number(ts) - 301), signature: signBody(SECRET, String(Number(ts) - 301), raw), rawBody: raw, secret: SECRET, now })).toEqual({ ok: false, reason: "timestamp outside 5 minutes" });
    expect(verifySignature({ timestamp: ts, signature: signBody("other", ts, raw), rawBody: raw, secret: SECRET, now }).ok).toBe(false);
    expect(verifySignature({ timestamp: undefined, signature, rawBody: raw, secret: SECRET, now }).ok).toBe(false);
  });

  it("client sends signed JSON, refuses more than 25 posts, and maps 404 to null", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (String(url).includes("/assets/unknown")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ ok: true, accepted: 1, duplicates: 0, rejected: 0, remaining_today: 49, results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createContentClient({ baseUrl: "https://biolinxlabs.com", secret: SECRET, fetchImpl, now: () => now });
    await client.sendPosts([{ external_id: "bs-1", image_url: "https://x.com/a.png", hook: "h", caption: "c {CODE}", niche: "research", platform: "tiktok", format: "portrait" }]);
    const sent = calls[0]!;
    const headers = sent.init.headers as Record<string, string>;
    expect(sent.url).toBe("https://biolinxlabs.com/api/content/assets");
    expect(headers["X-Biolinx-Signature"]).toBe(signBody(SECRET, ts, String(sent.init.body)));
    expect(sent.init.redirect).toBe("error");
    await expect(client.sendPosts([])).rejects.toThrow();
    expect(await client.getPost("unknown")).toBeNull();
    expect((calls[1]!.init.headers as Record<string, string>)["X-Biolinx-Signature"]).toBe(signBody(SECRET, ts, "")); // GET signs "<ts>."
  });
});

describe("pre-flight mirrors Biolinx rejections", () => {
  const ok = { external_id: "bs-20260915-abc123", hook: "Check the supplier before you pay", caption: withDisclosures("Every vial ships with a third-party COA. My code {CODE} takes {DISCOUNT} off at biolinxlabs.com."), hashtags: ["researchpeptides", "coa"], imageText: "Ask for the COA", image_url: "https://gemboxpk.com/media/a.png" };

  it("a clean post passes", () => {
    expect(preflight(ok)).toEqual([]);
  });

  it("catches claim words with stems, GLP names, handles, outside sites, {CODE} count, dashes and bad image links", () => {
    const r = (over: Partial<typeof ok>) => preflight({ ...ok, ...over }).join(" | ");
    expect(r({ hook: "Real results, no fat loss hype" })).toMatch(/claim words not allowed: fat loss, results/);
    expect(r({ caption: withDisclosures("Proven treatment and healing. {CODE}") })).toMatch(/treat.*heal/);
    expect(r({ caption: withDisclosures("Better than GLP-1 stuff. {CODE}") })).toMatch(/GLP product name/);
    expect(r({ caption: withDisclosures("Shoutout @peptidegirl {CODE}") })).toMatch(/@handles/);
    expect(r({ caption: withDisclosures("Compare with aminoclub.com {CODE}") })).toMatch(/outside websites not allowed: aminoclub.com/);
    expect(r({ caption: withDisclosures("No code here") })).toMatch(/\{CODE\} exactly once \(found 0\)/);
    expect(r({ caption: withDisclosures("{CODE} and {CODE}") })).toMatch(/found 2/);
    expect(r({ hook: "Lab tested — every batch" })).toMatch(/dash/);
    expect(r({ imageText: "Boost your energy" })).toMatch(/image text: claim words/);
    expect(r({ image_url: "http://1.2.3.4/a.png" })).toMatch(/https on port 443.*hostname, not an IP/);
    expect(r({ external_id: "bad id!" })).toMatch(/external_id/);
  });

  it("disclosures are added once; hashtags are cleaned; niches and formats map", () => {
    const c = withDisclosures(withDisclosures("Hi {CODE}"));
    expect(c.split(RUO_LINE).length - 1).toBe(1);
    expect(c.match(/#ad\b/g)).toHaveLength(1);
    expect(cleanHashtags(["#Research-Peptides", "coa", "x", "COA"])).toEqual(["researchpeptides", "coa"]);
    expect(biolinxNiche("Women's Wellness")).toBe("metabolic");
    expect(biolinxNiche("Gym/Bodybuilding")).toBe("fitness");
    expect(formatFor("tiktok")).toBe("portrait");
    expect(formatFor("youtube")).toBe("thumbnail");
  });
});

describe("post writer", () => {
  const req: WriteRequest = {
    source: { platform: "tiktok", url: "https://www.tiktok.com/@a/video/1", text: "3 red flags your peptide supplier is lying to you", views: 480000, likes: 31000, comments: 900, outlierRatio: 6.2, niche: "Biohacker" },
    biolinxNiche: "research",
    platform: "tiktok",
    format: "portrait",
  };
  const variant = (o: Record<string, unknown>) => ({ hook: "Your supplier should send this before you ask", caption: "A real COA shows purity, batch number and the lab's name. If a supplier can't show you one, keep scrolling. Use {CODE} at biolinxlabs.com.", hashtags: ["coa", "researchpeptides"], hook_type: "curiosity", angle: "COA transparency", image_text: "Ask for the COA", image_brief: "Biolinx vial beside a printed COA on a white lab bench", score: 8, ...o });

  it("prompt carries the outlier numbers, feedback and previous version", () => {
    const p = writerPrompt({ ...req, feedback: "less salesy, talk about cold-chain shipping", previous: { hook: "old", caption: "old caption", imageText: null, imageBrief: null } });
    expect(p).toMatch(/480,000 \(6\.2x the creator's average\)/);
    expect(p).toMatch(/cold-chain shipping/);
    expect(p).toMatch(/declined the previous version/);
  });

  it("picks the best variant that passes and skips ones that break rules", async () => {
    const llm = { complete: async () => JSON.stringify({ variants: [variant({ hook: "Boost your results fast", score: 10 }), variant({ score: 7 })] }) };
    const r = await writeSwipePost(llm, "m", req);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.post.hook).toBe("Your supplier should send this before you ask");
      expect(r.post.caption).toContain(RUO_LINE);
      expect(r.rejectedVariants[0]!.reasons.join(" ")).toMatch(/boost, results|results, boost/);
    }
  });

  it("repairs once with the exact reasons, then gives up honestly", async () => {
    const prompts: string[] = [];
    const bad = JSON.stringify({ variants: [variant({ caption: "no code, weight loss" })] });
    const llm = { complete: async (_s: string, u: string) => (prompts.push(u), bad) };
    const r = await writeSwipePost(llm, "m", req);
    expect(r.status).toBe("failed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/Fix these exact problems/);
    expect(prompts[1]).toMatch(/\{CODE\} exactly once/);
  });

  it("parses JSON even with text around it", () => {
    expect(parseVariants('Sure:\n{"variants":[{"hook":"a"}]}\nthanks')).toHaveLength(1);
    expect(parseVariants("not json")).toEqual([]);
  });
});

describe("swipe candidates", () => {
  const items = (views: number[], text = "red flags your peptide supplier hides") =>
    views.map((v, i) => ({ url: `https://www.tiktok.com/@a/video/${i}`, text, postedAt: "2026-09-01T00:00:00Z", views: v, likes: Math.round(v / 20), comments: 10 }));
  it("keeps outliers from US or unknown, non-rejected, on-niche, unused, recent posts", () => {
    const leads = [
      { id: 1, niche: "Biohacker", primaryPlatform: "TikTok", geoCountry: null, source: "sourcing", sourcingReview: "pending" },
      { id: 2, niche: "Biohacker", primaryPlatform: "TikTok", geoCountry: "GB", source: "sourcing", sourcingReview: "pending" },
      { id: 3, niche: "Biohacker", primaryPlatform: "TikTok", geoCountry: "US", source: "sourcing", sourcingReview: "rejected" },
    ];
    const bundles = new Map([
      [1, { items: items([10_000, 12_000, 9_000, 150_000]) }],
      [2, { items: items([10_000, 12_000, 9_000, 150_000]) }],
      [3, { items: items([10_000, 12_000, 9_000, 150_000]) }],
    ]);
    const out = pickCandidates({ leads, bundles, matchTermsByNiche: new Map([["Biohacker", ["peptide"]]]), usedUrls: new Set(), now });
    expect(out.map((c) => [c.leadId, c.views])).toEqual([[1, 150_000]]);
    expect(out[0]!.outlierRatio).toBeGreaterThan(3);
    expect(pickCandidates({ leads, bundles, matchTermsByNiche: new Map([["Biohacker", ["nootropic"]]]), usedUrls: new Set(), now })).toEqual([]); // off-niche
    expect(pickCandidates({ leads, bundles, matchTermsByNiche: new Map(), usedUrls: new Set(["https://www.tiktok.com/@a/video/3"]), now })).toEqual([]); // already used
  });

  it("outbound payload matches the API fields", () => {
    const row = { id: 9, externalId: "bs-1", imageUrl: "https://gemboxpk.com/m.png", hook: "h", caption: "c {CODE}", hashtags: ["coa"], biolinxNiche: "research", platform: "tiktok", format: "portrait", hookType: "curiosity", sourcePostUrl: "https://www.tiktok.com/@a/video/1", version: 2, angle: "COA", imageBrief: "vial" } as never;
    expect(toOutbound(row)).toMatchObject({ external_id: "bs-1", image_url: "https://gemboxpk.com/m.png", niche: "research", platform: "tiktok", format: "portrait", hook_type: "curiosity", source_post_url: "https://www.tiktok.com/@a/video/1", meta: { bioscraper_id: 9, version: 2 } });
  });
});

describe("writer grounding and variety (live test 2026-09-15)", () => {
  const base: WriteRequest = {
    source: { platform: "tiktok", url: "https://www.tiktok.com/@a/video/1", text: "3 red flags your peptide supplier hides", views: 480000, likes: null, comments: null, outlierRatio: 6.2, niche: "Biohacker" },
    biolinxNiche: "research",
    platform: "tiktok",
    format: "portrait",
  };
  it("without verified facts the prompt forbids claims about Biolinx; with facts it lists only those", () => {
    expect(writerPrompt(base)).toMatch(/VERIFIED FACTS about Biolinx: none provided\. Make no claims/);
    const p = writerPrompt({ ...base, facts: ["Third-party COA for every batch"] });
    expect(p).toMatch(/- Third-party COA for every batch/);
  });
  it("recent hooks and angles are listed to avoid, and the platform caption limit is stated", () => {
    const p = writerPrompt({ ...base, avoid: { hooks: ["Most peptide suppliers hope you never ask for this one document."], angles: ["COA transparency"] } });
    expect(p).toMatch(/ALREADY USED/);
    expect(p).toMatch(/angle: COA transparency/);
    expect(p).toMatch(/Caption limit: 450 characters/);
  });
  it("a variant far over the platform limit is thrown away", async () => {
    const long = "A real certificate shows the lab, the date and a batch number. ".repeat(12) + "Use {CODE}.";
    const llm = { complete: async () => JSON.stringify({ variants: [{ hook: "Read this before you order", caption: long, hashtags: ["coa"], hook_type: "curiosity", angle: "a", image_text: "Read the COA", image_brief: "vial", score: 9 }] }) };
    const r = await writeSwipePost(llm, "m", base);
    expect(r.status).toBe("failed");
    expect(r.rejectedVariants[0]!.reasons.join(" ")).toMatch(/keep it under 450 for tiktok/);
  });
});
