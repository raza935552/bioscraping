// One Claude call turns a SourceBundle into 1–3 talking points, each tied to
// a URL from the bundle. Code verifies every URL and builds the note text;
// the model never writes to the database directly.

import type { LlmClient } from "@biolinx/drafting";
import type { SourceBundle, Summary, SummaryPoint } from "./types.js";

const SYSTEM = `You research creators for an affiliate-recruiting team at a research-peptide brand. From the profile and posts given, extract 1 to 3 genuine, specific talking points a recruiter could reference in a first message.
Rules:
- Every point must cite the exact "url" of the post it comes from (or the profile url for a bio detail). Never invent a post, a quote, or a number.
- Quote short fragments verbatim where useful. Prefer wellness, fitness, recovery, biohacking, hormones, longevity, women's health, or supplement-adjacent content.
- If the content is unrelated to health or fitness, or too thin to say anything specific, answer verdict "no_match".
- Never mention drug names, dosing, or what any product does to a body.
Respond with JSON only: {"verdict":"match"|"no_match","points":[{"text":string,"url":string}]}`;

function userPrompt(b: SourceBundle): string {
  const lines = [
    `Platform: ${b.platform}`,
    `Profile url: ${b.profileUrl}`,
    `Name: ${b.displayName ?? "(unknown)"}`,
    `Bio: ${b.bio ?? "(none)"}`,
    `Followers: ${b.followers ?? "(unknown)"}`,
    "",
    "Posts:",
    ...b.items.map((i, n) => `${n + 1}. url: ${i.url}\n   text: ${i.text}`),
  ];
  return lines.join("\n");
}

export function verifyPoints(points: SummaryPoint[], bundle: SourceBundle): SummaryPoint[] {
  const allowed = new Set([bundle.profileUrl, ...bundle.items.map((i) => i.url)]);
  return points.filter((p) => typeof p.text === "string" && p.text.trim().length > 0 && allowed.has(p.url));
}

export function buildNote(points: SummaryPoint[]): string {
  if (points.length === 0) return "";
  return `MATCH — ${points.map((p) => `${p.text.trim()} (${p.url})`).join("; ")}.`;
}

export async function summarizeBundle(
  llm: LlmClient,
  bundle: SourceBundle,
  model = process.env.DRAFT_MODEL ?? "claude-sonnet-5",
): Promise<Summary> {
  if (bundle.items.length === 0) return { verdict: "no_match", points: [], note: "" };
  const raw = await llm.complete(SYSTEM, userPrompt(bundle), model);
  const jsonText = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: { verdict?: string; points?: SummaryPoint[] };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    throw new Error(`summarize: unparseable model output (${raw.slice(0, 80)})`);
  }
  const points = verifyPoints(Array.isArray(parsed.points) ? parsed.points : [], bundle).slice(0, 3);
  if (parsed.verdict !== "match" || points.length === 0) return { verdict: "no_match", points: [], note: "" };
  return { verdict: "match", points, note: buildNote(points) };
}
