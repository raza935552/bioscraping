// Writes an original affiliate post for the Biolinx content library, inspired by a
// post that outperformed its creator's average. Claude drafts three variants; the
// deterministic pre-flight decides which may be used. Nothing is copied from the
// source post, and no variant is used unless it passes every rule.

import type { LlmClient } from "@biolinx/drafting";
import type { BiolinxFormat, BiolinxNiche, BiolinxPlatform } from "./biolinx-client.js";
import { cleanHashtags, preflight, withDisclosures } from "./content-rules.js";

export interface SwipeSource {
  platform: string;
  url: string;
  text: string;
  views: number;
  likes: number | null;
  comments: number | null;
  /** Views ÷ the creator's average views over the posts read. */
  outlierRatio: number;
  niche: string | null;
}

export interface WriteRequest {
  source: SwipeSource;
  biolinxNiche: BiolinxNiche;
  platform: BiolinxPlatform;
  format: BiolinxFormat;
  /** What the reviewer asked for after declining the previous version. */
  feedback?: string | null;
  previous?: { hook: string; caption: string; imageText: string | null; imageBrief: string | null } | null;
  /** Verified facts about Biolinx (Settings → BIOLINX_BRAND_FACTS). The writer may state only these. */
  facts?: string[];
  /** Recent hooks and angles, so the swipe file doesn't repeat itself. */
  avoid?: { hooks: string[]; angles: string[] };
}

/** Caption length before disclosures, by platform: short-form reads short. */
export const CAPTION_LIMIT: Record<BiolinxPlatform, number> = { tiktok: 450, instagram: 600, facebook: 600, x: 240, youtube: 700 };

export interface WrittenPost {
  hook: string;
  caption: string;
  hashtags: string[];
  hookType: "pleasure" | "pain" | "curiosity";
  angle: string;
  imageText: string;
  imageBrief: string;
}

export type WriteResult = { status: "ok"; post: WrittenPost; attempts: number; rejectedVariants: Array<{ hook: string; reasons: string[] }> } | { status: "failed"; reason: string; attempts: number; rejectedVariants: Array<{ hook: string; reasons: string[] }> };

const NICHE_ANGLES: Record<BiolinxNiche, string> = {
  metabolic: "people researching metabolic peptides who care about purity, third-party COAs, honest sourcing and not getting scammed by sketchy suppliers",
  research: "biohackers and self-directed researchers who read COAs, compare suppliers, care about purity percentages, batch testing, storage and handling",
  fitness: "gym-goers who research compounds seriously and want a supplier they can trust, with lab reports, clear labeling and fast US shipping",
  bodybuilding: "serious lifters who vet suppliers hard: testing, purity, consistency batch to batch, and no underdosed or mislabeled vials",
  longevity: "longevity-minded researchers who value transparency, testing standards and a supplier that documents everything",
  skin: "people researching skin-related peptides who want documented purity and a supplier that shows its testing",
  wellness: "wellness researchers who want a transparent, well-documented supplier",
};

export const WRITER_SYSTEM = `You are the best short-form social copywriter in the research-peptide space. You write posts that Biolinx Labs affiliates publish on their own accounts to send people to biolinxlabs.com with their personal code.

What makes your posts win:
- The first line stops the scroll. Use one of three hook types: pleasure (something they gain or get), pain (a mistake, a rip-off, a thing that goes wrong), curiosity (an open loop they need closed). Specific beats vague. Short beats long.
- It sounds like a real person talking to a friend, native to the platform. Short lines. No hype words, no ALL CAPS, no emoji walls (0 to 2 emoji total).
- One idea per post, told with concrete, checkable detail. Strong idea families: what a real certificate of analysis (COA) shows and how to read one, red flags in a supplier, questions to ask before ordering from anyone, how research compounds should arrive and be stored, what "research use only" means, myths people repeat, a quick checklist, a "save this" explainer.
- Truth first. State something about Biolinx itself ONLY if it appears under VERIFIED FACTS in the request. If it isn't listed, don't claim it: talk about what to look for in any supplier and invite people to check biolinxlabs.com themselves. Never invent testing, shipping, sourcing, awards, numbers or guarantees.
- Vary the craft. Don't reuse the hooks or angles listed under ALREADY USED, and avoid stock phrases like "the vial in your hand", "here's the thing" or "nobody tells you".
- A clear, low-pressure call to action that uses the affiliate's code.

Hard rules. Any violation gets the post thrown away:
- Biolinx sells research peptides for laboratory research use only. Never suggest anyone uses, takes, injects or doses anything. No personal stories of use.
- Never use these words or ideas, in any form: cure, treat, heal, recovery, weight loss, fat loss, lose weight, burn fat, muscle growth, build muscle, dose, dosing, dosage, protocol, cycle, inject, anti-aging, results, benefits, boost, improve, enhance, performance, energy, sleep better, libido, skin tightening, wrinkles, younger, therapy, patients, prescription, FDA, clinically proven.
- Never name any drug or GLP product (GLP-1, GLP-3, semaglutide, tirzepatide, retatrutide, cagrilintide, liraglutide, Ozempic, Wegovy, Mounjaro, Zepbound, Rybelsus, Saxenda) or product codes like G1-S, G2-T, G3-R.
- No @handles. No websites except biolinxlabs.com. No earnings, commission or money-making claims. No before/after, no bodies.
- Never use an em dash or en dash. Use commas or full stops.
- The caption must contain the literal placeholder {CODE} exactly once (the affiliate's code is inserted later). You may use {DISCOUNT} once for the discount amount. Do not invent a code or a percentage.
- Hook: 120 characters max. Caption: stay under the character limit given in the request (before disclosures). Do not add the research-use line or #ad; they are added automatically.

The image (made separately) follows the same rules:
- image_text: the words printed on the image, 8 words max, same banned words.
- image_brief: one or two sentences describing the visual. Allowed: Biolinx-branded vials and packaging, lab or clean studio settings, COA documents, shipping boxes, typography-led designs. Forbidden: needles, syringes, pills, people using or holding products to their body, bodies or before/after, other brands or logos, vials that aren't Biolinx, any readable drug name.

You will get a post that outperformed its creator's average. Study why it worked (the hook pattern, the structure, the emotion) and write something original for Biolinx. Never copy its words.

Respond with JSON only, no code fence:
{"variants":[{"hook":"","caption":"","hashtags":["",""],"hook_type":"pleasure|pain|curiosity","angle":"one short line: the idea this post sells","image_text":"","image_brief":"","score":1-10,"why":"one line: why this will outperform"}]}
Give exactly 3 variants with different hook types or angles, best first.`;

export function writerPrompt(req: WriteRequest, repair?: Array<{ hook: string; reasons: string[] }>): string {
  const s = req.source;
  const lines = [
    `Audience for this post: ${NICHE_ANGLES[req.biolinxNiche]}.`,
    `Platform: ${req.platform}. Image format: ${req.format}. Caption limit: ${CAPTION_LIMIT[req.platform]} characters before disclosures.`,
    "",
    req.facts?.length ? `VERIFIED FACTS about Biolinx (the only Biolinx claims you may make):\n${req.facts.map((f) => `- ${f}`).join("\n")}` : "VERIFIED FACTS about Biolinx: none provided. Make no claims about Biolinx's testing, shipping, sourcing or quality; teach what to look for and point to biolinxlabs.com.",
    "",
    "Post that outperformed (inspiration only, do not copy):",
    `- Platform: ${s.platform}`,
    `- Views: ${s.views.toLocaleString("en-US")} (${s.outlierRatio.toFixed(1)}x the creator's average)${s.likes != null ? `, likes ${s.likes.toLocaleString("en-US")}` : ""}${s.comments != null ? `, comments ${s.comments.toLocaleString("en-US")}` : ""}`,
    `- Text: """${s.text.slice(0, 700)}"""`,
  ];
  if (req.avoid && (req.avoid.hooks.length || req.avoid.angles.length)) {
    lines.push("", "ALREADY USED (write something clearly different):");
    for (const h of req.avoid.hooks.slice(0, 15)) lines.push(`- hook: ${h}`);
    for (const a of req.avoid.angles.slice(0, 15)) lines.push(`- angle: ${a}`);
  }
  if (req.previous) {
    lines.push("", "A reviewer declined the previous version:", `- Hook: ${req.previous.hook}`, `- Caption: ${req.previous.caption.slice(0, 700)}`, `- Image text: ${req.previous.imageText ?? ""}`, `- Image brief: ${req.previous.imageBrief ?? ""}`);
  }
  if (req.feedback?.trim()) lines.push("", `What the reviewer wants instead (follow this closely): ${req.feedback.trim().slice(0, 1000)}`);
  if (repair?.length) {
    lines.push("", "Your last variants broke rules and were thrown away. Fix these exact problems:");
    for (const r of repair) lines.push(`- "${r.hook.slice(0, 80)}": ${r.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

interface RawVariant {
  hook?: unknown;
  caption?: unknown;
  hashtags?: unknown;
  hook_type?: unknown;
  angle?: unknown;
  image_text?: unknown;
  image_brief?: unknown;
  score?: unknown;
}

export function parseVariants(raw: string): RawVariant[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { variants?: RawVariant[] };
    return Array.isArray(parsed.variants) ? parsed.variants : [];
  } catch {
    return [];
  }
}

function toPost(v: RawVariant): WrittenPost | null {
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const hook = str(v.hook);
  const caption = str(v.caption);
  if (!hook || !caption) return null;
  const ht = str(v.hook_type).toLowerCase();
  return {
    hook,
    caption: withDisclosures(caption),
    hashtags: cleanHashtags(Array.isArray(v.hashtags) ? (v.hashtags as string[]) : str(v.hashtags)),
    hookType: ht === "pleasure" || ht === "pain" ? ht : "curiosity",
    angle: str(v.angle).slice(0, 255),
    imageText: str(v.image_text).slice(0, 120),
    imageBrief: str(v.image_brief).slice(0, 1000),
  };
}

/** Draft, check, repair once. The first variant (the writer's own best) that passes pre-flight wins. */
export async function writeSwipePost(llm: LlmClient, model: string, req: WriteRequest): Promise<WriteResult> {
  const rejected: Array<{ hook: string; reasons: string[] }> = [];
  let repair: Array<{ hook: string; reasons: string[] }> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete(WRITER_SYSTEM, writerPrompt(req, repair), model, { maxTokens: 2500 });
    } catch (e) {
      return { status: "failed", reason: `writer unavailable: ${(e as Error).message}`, attempts: attempt, rejectedVariants: rejected };
    }
    const variants = parseVariants(raw)
      .map((v) => ({ v, post: toPost(v), score: typeof v.score === "number" ? v.score : 0 }))
      .filter((x) => x.post)
      .sort((a, b) => b.score - a.score);
    if (variants.length === 0) {
      repair = [{ hook: "(no parsable JSON)", reasons: ["respond with the JSON object only"] }];
      continue;
    }
    const thisRound: Array<{ hook: string; reasons: string[] }> = [];
    const limit = CAPTION_LIMIT[req.platform];
    for (const { post, v } of variants) {
      const reasons = preflight({ external_id: "draft", hook: post!.hook, caption: post!.caption, hashtags: post!.hashtags, imageText: post!.imageText });
      const bodyLength = typeof v.caption === "string" ? v.caption.trim().length : 0;
      if (bodyLength > limit + 60) reasons.push(`caption is ${bodyLength} characters; keep it under ${limit} for ${req.platform}`);
      if (reasons.length === 0) return { status: "ok", post: post!, attempts: attempt, rejectedVariants: [...rejected, ...thisRound] };
      thisRound.push({ hook: post!.hook, reasons });
    }
    rejected.push(...thisRound);
    repair = thisRound;
  }
  return { status: "failed", reason: "no variant passed the content rules after one repair", attempts: 2, rejectedVariants: rejected };
}
