// Drafting engine (D10): the LLM drafts; deterministic code decides.
// Every draft passes the L-rules linter; one repair attempt with the
// violations fed back; still dirty → BLOCKED (never sent, alerted upstream).
// LLM unavailable → blocked with reason, never a guess.

import { isBlocked, lintEmail, type LintContext, type LintViolation } from "@biolinx/compliance";

export interface DraftRequest {
  /** Reconstructed template text or contract description for this segment. */
  templateGuidance: string;
  lead: {
    firstName: string | null;
    personalizationNotes: string | null; // real talking points + source URLs
    channel: "email" | "dm";
    touchNumber: number;
  };
  senderName: string;
  variant: "curiosity" | "rapport" | "direct";
}

export interface DraftResult {
  status: "ok" | "blocked";
  subject: string | null;
  body: string | null;
  lintReport: LintViolation[];
  attempts: number;
}

export interface LlmClient {
  complete(system: string, user: string, model: string, opts?: { maxTokens?: number }): Promise<string>;
  /** Same, with images alongside the text. Used by the Telegram assistant to read screenshots. */
  completeWithImages?(system: string, user: string, images: LlmImage[], model: string, opts?: { maxTokens?: number }): Promise<string>;
  /** A conversation rather than a single question: earlier turns, and images on the last one. */
  completeChat?(system: string, turns: LlmTurn[], model: string, opts?: { maxTokens?: number }): Promise<string>;
}

/** One turn of a conversation. Images belong on a user turn. */
export interface LlmTurn {
  role: "user" | "assistant";
  text: string;
  images?: LlmImage[];
}

/** An image for a vision call: the raw bytes base64-encoded, plus its media type. */
export interface LlmImage {
  mediaType: string;
  dataBase64: string;
}

/** Minimal Anthropic Messages API client (fetch-based; mocked in tests). */
export function anthropicFromEnv(env = process.env, fetchImpl: typeof fetch = fetch): LlmClient {
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  return {
    async complete(system, user, model, opts) {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts?.maxTokens ?? 1024,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        // Surface the API's own reason (type + message, never the key) so a
        // failed enrichment or draft is diagnosable from its history row.
        let reason = "";
        try {
          const err = (await res.json()) as { error?: { type?: string; message?: string } };
          reason = [err.error?.type, err.error?.message].filter(Boolean).join(": ");
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`Anthropic API: HTTP ${res.status}${reason ? ` — ${reason.slice(0, 200)}` : ""}`);
      }
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return body.content?.find((c) => c.type === "text")?.text ?? "";
    },

    async completeChat(system, turns, model, opts) {
      const messages = turns.map((turn) => ({
        role: turn.role,
        content: [
          ...(turn.images ?? []).map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 } })),
          { type: "text", text: turn.text },
        ],
      }));
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: opts?.maxTokens ?? 1024, system, messages }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        let reason = "";
        try {
          const err = (await res.json()) as { error?: { type?: string; message?: string } };
          reason = [err.error?.type, err.error?.message].filter(Boolean).join(": ");
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`Anthropic API: HTTP ${res.status}${reason ? ` — ${reason.slice(0, 200)}` : ""}`);
      }
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return body.content?.find((c) => c.type === "text")?.text ?? "";
    },

    async completeWithImages(system, user, images, model, opts) {
      const content = [
        ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 } })),
        { type: "text", text: user },
      ];
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: opts?.maxTokens ?? 1024, system, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        let reason = "";
        try {
          const err = (await res.json()) as { error?: { type?: string; message?: string } };
          reason = [err.error?.type, err.error?.message].filter(Boolean).join(": ");
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`Anthropic API: HTTP ${res.status}${reason ? ` — ${reason.slice(0, 200)}` : ""}`);
      }
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return body.content?.find((c) => c.type === "text")?.text ?? "";
    },
  };
}

const SYSTEM = `You draft outreach messages recruiting affiliate Partners for a research-peptide brand. Non-negotiable content rules (violations get your draft discarded):
- NEVER name real drugs (semaglutide/tirzepatide/retatrutide/Ozempic/Wegovy/Mounjaro/Zepbound) or the coded products G1-S/G2-T/G3-R.
- NEVER make claims about what any product does to a body; never imply anyone's personal use; no "weight loss", "anti-aging", "muscle gain", "FDA-approved", dosing or protocols.
- Four sentences, five max. One clause disclosing the sender helps run the program. End with an easy out. No links in a first message (email may include only the unsubscribe link, which is appended automatically). Never lead with the commission figure.
- NEVER use an em dash (—) or en dash (–). Use a comma or a full stop. Dashes read as AI-written and get the draft discarded.
- Use exactly one genuine personal detail from the personalization notes; if the notes are empty, output only the word INSUFFICIENT.
Respond with the message text only — no preamble, no quotes, no subject line unless asked.`;

function userPrompt(req: DraftRequest, repairNote?: string): string {
  return [
    `Channel: ${req.lead.channel}. Touch #${req.lead.touchNumber}. Variant: ${req.variant}.`,
    `Recipient first name: ${req.lead.firstName ?? "(unknown — address them without a name)"}.`,
    `Sender: ${req.senderName} (use the real name).`,
    `Personalization notes:\n${req.lead.personalizationNotes ?? "(none)"}`,
    `Template guidance for this segment:\n${req.templateGuidance}`,
    ...(req.lead.channel === "email" ? ["Also produce a subject line as the first line, prefixed 'SUBJECT: ' — plain, truthful, no clickbait."] : []),
    ...(repairNote ? [`Your previous draft was rejected by the compliance linter:\n${repairNote}\nProduce a corrected draft.`] : []),
  ].join("\n\n");
}

function parseDraft(raw: string, channel: "email" | "dm"): { subject: string | null; body: string } {
  const text = raw.trim();
  if (channel === "email" && text.toUpperCase().startsWith("SUBJECT:")) {
    const nl = text.indexOf("\n");
    if (nl > 0) {
      return { subject: text.slice(8, nl).trim(), body: text.slice(nl + 1).trim() };
    }
  }
  return { subject: null, body: text };
}

export async function draftMessage(
  llm: LlmClient,
  req: DraftRequest,
  lintCtx: LintContext,
  model = process.env.DRAFT_MODEL ?? "claude-sonnet-5",
): Promise<DraftResult> {
  // Never invent a personal detail — no notes means no cold draft (spec rule 2).
  if (!req.lead.personalizationNotes?.trim() && req.lead.touchNumber === 1) {
    return {
      status: "blocked",
      subject: null,
      body: null,
      lintReport: [{ rule: "no-personalization", severity: "block", detail: "no personalization notes — enrich first, never invent" }],
      attempts: 0,
    };
  }

  let repairNote: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete(SYSTEM, userPrompt(req, repairNote), model);
    } catch (err) {
      return {
        status: "blocked",
        subject: null,
        body: null,
        lintReport: [{ rule: "llm-unavailable", severity: "block", detail: (err as Error).message }],
        attempts: attempt,
      };
    }
    if (raw.trim() === "INSUFFICIENT") {
      return {
        status: "blocked",
        subject: null,
        body: null,
        lintReport: [{ rule: "no-personalization", severity: "block", detail: "model judged notes insufficient" }],
        attempts: attempt,
      };
    }
    const { subject, body } = parseDraft(raw, req.lead.channel);
    // Lint subject + body together (subject-line evasion was a red-team finding).
    const violations = lintEmail(subject, body, lintCtx);
    if (!isBlocked(violations)) {
      return { status: "ok", subject, body, lintReport: violations, attempts: attempt };
    }
    repairNote = violations.map((v) => `- ${v.rule}: ${v.detail}`).join("\n");
  }
  return {
    status: "blocked",
    subject: null,
    body: null,
    lintReport: [{ rule: "lint-unrepairable", severity: "block", detail: repairNote ?? "unknown" }],
    attempts: 2,
  };
}

// ── Reply classification ────────────────────────────────────────────────

export const REPLY_CLASSES = [
  "interested",
  "not_now",
  "no_with_reason",
  "question",
  "opt_out",
  "signed_up",
  "unclassifiable",
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

const CLASSIFY_SYSTEM = `Classify a reply to an affiliate-recruiting outreach message. Answer with EXACTLY one word from: interested, not_now, no_with_reason, question, opt_out, signed_up, unclassifiable.
opt_out = any request to stop contact ("remove me", "unsubscribe", "stop emailing me") — when in doubt between opt_out and anything else, choose opt_out.
unclassifiable = anything you are not confident about. Never guess.`;

export async function classifyReply(
  llm: LlmClient,
  replyText: string,
  model = process.env.CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001",
): Promise<ReplyClass> {
  try {
    const raw = (await llm.complete(CLASSIFY_SYSTEM, replyText.slice(0, 4000), model)).trim().toLowerCase();
    return (REPLY_CLASSES as readonly string[]).includes(raw) ? (raw as ReplyClass) : "unclassifiable";
  } catch {
    return "unclassifiable"; // LLM down ⇒ human queue, never a guess
  }
}
