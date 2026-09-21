// The Telegram assistant. People ask how the engine is doing or ask for a change; it answers from
// live data, argues back (kindly) when a request would break a platform rule or compliance, and logs
// anything that needs Raza into the tasks table so nothing said in a chat is lost.
//
// Safety: it only ever reads the engine. The single thing it writes is a task row and its own log.
// Only allow-listed chats are answered at all, and there is a daily cap on model calls.

import { and, desc, eq, gte } from "drizzle-orm";
import { schema, type Db } from "@biolinx/db";
import type { LlmClient, LlmImage } from "@biolinx/drafting";
import { imageRefOf, type ImageFetcher, type TelegramMessageFiles } from "./files.js";
import { REQUEST_GUIDANCE, STYLE_EXAMPLES, SYSTEM_BRIEF } from "./brief.js";
import { snapshotLines, systemSnapshot } from "./snapshot.js";

export const ASSISTANT_MODEL = "claude-sonnet-5";
export const DEFAULT_DAILY_ANSWERS = 120;

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessageFiles & {
    message_id?: number;
    text?: string;
    caption?: string;
    chat?: { id?: number | string; title?: string; type?: string };
    from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    reply_to_message?: { from?: { username?: string; is_bot?: boolean } };
    entities?: Array<{ type?: string; offset?: number; length?: number }>;
  };
}

export interface AssistantConfig {
  /** Chat ids allowed to talk to the bot. Empty means the alert chat only. */
  allowedChats: string[];
  botUsername: string;
  dailyAnswerCap: number;
  model: string;
}

export function assistantConfigFromEnv(env = process.env): AssistantConfig {
  const raw = (env.TELEGRAM_ALLOWED_CHATS ?? env.TELEGRAM_CHAT_ID ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const cap = Number(env.TELEGRAM_DAILY_ANSWERS);
  return {
    allowedChats: [...new Set(raw)],
    botUsername: (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""),
    dailyAnswerCap: Number.isFinite(cap) && cap > 0 ? Math.round(cap) : DEFAULT_DAILY_ANSWERS,
    model: env.TELEGRAM_ASSISTANT_MODEL || ASSISTANT_MODEL,
  };
}

export type MessageKind = "question" | "change" | "bug" | "idea";

const REQUEST_WORDS = [
  /\b(can|could|would) (you|we|u)\b.*\b(add|build|make|change|create|set up|setup|enable|turn on|turn off|remove|fix)\b/i,
  /\b(please|pls|plz)\b.*\b(add|build|make|change|create|fix|send|set)\b/i,
  /\b(we|i) (need|want|should)\b/i,
  /\b(add|build|create|implement|integrate|automate)\b.*\b(feature|page|button|report|system|bot|tool)\b/i,
  /\blet'?s (add|build|do|make|try)\b/i,
];
const BUG_WORDS = [/\b(broken|not working|doesn'?t work|does not work|error|failing|failed|bug|stuck|wrong)\b/i];
const IDEA_WORDS = [/\b(idea|what if|maybe we|thinking about|proposal|suggestion)\b/i];

/** Question, or something that needs a person? Keywords only: cheap, predictable, and overridable. */
export function classifyMessage(text: string): MessageKind {
  const t = text.trim();
  if (BUG_WORDS.some((r) => r.test(t))) return "bug";
  if (REQUEST_WORDS.some((r) => r.test(t))) return "change";
  if (IDEA_WORDS.some((r) => r.test(t))) return "idea";
  return "question";
}

/** In a group the bot stays quiet unless spoken to; in a private chat every message is for it. */
export function shouldAnswer(update: TelegramUpdate, botUsername: string): boolean {
  const m = update.message;
  const text = m?.text ?? m?.caption ?? "";
  const hasImage = !!m && imageRefOf(m) != null;
  if (!m || (!text && !hasImage) || m.from?.is_bot) return false;
  const type = m.chat?.type ?? "private";
  if (type === "private") return true;
  const mentioned = botUsername ? new RegExp(`@${botUsername}\\b`, "i").test(text) : false;
  const repliedToBot = m.reply_to_message?.from?.is_bot === true;
  const isCommand = /^\//.test(text.trim());
  return mentioned || repliedToBot || isCommand;
}

/** The question without the @mention or the /command in front of it. */
export function cleanQuestion(text: string, botUsername: string): string {
  let t = text.trim();
  if (botUsername) t = t.replace(new RegExp(`@${botUsername}\\b`, "gi"), " ");
  t = t.replace(/^\/(ask|status|tasks|help|start)(@\S+)?\s*/i, "");
  return t.replace(/\s+/g, " ").trim();
}

export interface HandleDeps {
  llm: LlmClient | null;
  /** Downloads a screenshot so the assistant can read it. Omitted = images are ignored. */
  fetchImage?: ImageFetcher;
  now?: Date;
}

export interface HandleResult {
  /** What to send back. Null means stay silent (not for us, or not allowed). */
  reply: string | null;
  kind?: MessageKind;
  taskId?: number;
  usedAi?: boolean;
  reason?: string;
}

const startOfDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

/** Answers one Telegram update. Never throws: a failure answers with a plain sentence instead. */
export async function handleTelegramUpdate(db: Db, update: TelegramUpdate, cfg: AssistantConfig, deps: HandleDeps): Promise<HandleResult> {
  const now = deps.now ?? new Date();
  const m = update.message;
  if (!shouldAnswer(update, cfg.botUsername)) return { reply: null, reason: "not addressed to the bot" };

  const chatId = String(m!.chat?.id ?? "");
  const deniedReply = `I only answer in the BiolinX team chats. Ask Raza to add this one — the chat id is ${chatId}.`;

  // Telegram retries an update it thinks failed; the unique index on update_id stops a double answer.
  if (update.update_id != null) {
    const seen = await db.query.telegramLog.findFirst({ where: eq(schema.telegramLog.updateId, update.update_id) });
    if (seen) return { reply: null, reason: "already answered" };
  }

  const askedBy = [m!.from?.first_name, m!.from?.last_name].filter(Boolean).join(" ") || m!.from?.username || "someone";
  const chatTitle = m!.chat?.title ?? null;
  const rawText = m!.text ?? m!.caption ?? "";
  const question = cleanQuestion(rawText, cfg.botUsername);
  const command = /^\/(\w+)/.exec(rawText.trim())?.[1]?.toLowerCase();
  const imageRef = imageRefOf(m!);

  const log = async (answer: string, kind: MessageKind | undefined, taskId: number | undefined, usedAi: boolean) => {
    await db.insert(schema.telegramLog).values({
      chatId,
      chatTitle,
      askedBy: askedBy.slice(0, 120),
      updateId: update.update_id ?? null,
      question: (imageRef ? "[screenshot] " : "") + rawText.slice(0, 2000),
      answer: answer.slice(0, 4000),
      kind: kind ?? null,
      taskId: taskId ?? null,
      usedAi,
    });
  };

  // Deny by default. The bot's address is public (anyone can find t.me/<name>), so an unconfigured
  // allow-list means "nobody yet", never "everybody". The attempt is logged with its chat id so a
  // chat can be allowed from the admin instead of by reading somebody's phone.
  if (!cfg.allowedChats.includes(chatId)) {
    await log(deniedReply, undefined, undefined, false);
    return { reply: deniedReply, reason: "chat not allowed" };
  }

  // ── Commands that need no model ────────────────────────────────────────
  if (command === "start" || command === "help") {
    const reply = [
      "I'm the BiolinX engine assistant. Ask me anything about the affiliate system in plain English.",
      "",
      "Try: how many affiliates do we have · is the scrape running · how many leads are waiting · what did last night find",
      "",
      "Ask for a change and I'll log it for Raza: /tasks shows what's open, /status gives the numbers.",
    ].join("\n");
    await log(reply, undefined, undefined, false);
    return { reply, usedAi: false };
  }

  if (command === "status") {
    const reply = snapshotLines(await systemSnapshot(db, now));
    await log(reply, "question", undefined, false);
    return { reply, kind: "question", usedAi: false };
  }

  if (command === "tasks") {
    const open = await db.select().from(schema.tasks).where(eq(schema.tasks.status, "open")).orderBy(desc(schema.tasks.id)).limit(15);
    const reply = open.length === 0
      ? "Nothing open. Everything asked for in here has been dealt with."
      : `${open.length} open:\n${open.map((t) => `#${t.id} ${t.title}${t.askedBy ? ` — ${t.askedBy}` : ""}`).join("\n")}`;
    await log(reply, undefined, undefined, false);
    return { reply, usedAi: false };
  }

  if (!question && !imageRef) return { reply: null, reason: "empty message" };

  // ── Daily cap on model calls ───────────────────────────────────────────
  const usedToday = (
    await db
      .select({ id: schema.telegramLog.id })
      .from(schema.telegramLog)
      .where(and(eq(schema.telegramLog.usedAi, true), gte(schema.telegramLog.createdAt, startOfDay(now))))
  ).length;
  if (usedToday >= cfg.dailyAnswerCap) {
    const reply = "I've hit today's answer limit. The numbers still work with /status, and Raza can raise the limit.";
    await log(reply, undefined, undefined, false);
    return { reply, usedAi: false, reason: "daily cap" };
  }

  const kind = classifyMessage(question);
  const snapshot = await systemSnapshot(db, now);
  const images: LlmImage[] = [];
  if (imageRef && deps.fetchImage) {
    const img = await deps.fetchImage(imageRef.fileId, imageRef.mediaType);
    if (img) images.push(img);
  }

  // ── The answer ─────────────────────────────────────────────────────────
  let answer: string;
  let usedAi = false;
  if (!deps.llm) {
    answer = "I can't write an answer right now (the writing service isn't configured), but here are the current numbers:\n\n" + snapshotLines(snapshot);
  } else {
    const system = [SYSTEM_BRIEF, "", "EXAMPLES OF THE RIGHT TONE", STYLE_EXAMPLES, ...(kind === "question" ? [] : ["", REQUEST_GUIDANCE])].join("\n");
    const user = [
      `Asked by ${askedBy}${chatTitle ? ` in ${chatTitle}` : ""}.`,
      `This message is a ${kind === "question" ? "question" : `request of kind "${kind}"`}.`,
      ...(images.length > 0 ? ["They attached a screenshot. Read it and answer about what it shows."] : []),
      ...(imageRef && images.length === 0 ? ["They attached an image that could not be downloaded. Say so briefly and answer what you can."] : []),
      "",
      "LIVE NUMBERS, RIGHT NOW:",
      snapshotLines(snapshot),
      "",
      "THE MESSAGE:",
      question || "(no words, just the screenshot)",
    ].join("\n");
    try {
      answer = (
        images.length > 0 && deps.llm.completeWithImages
          ? await deps.llm.completeWithImages(system, user, images, cfg.model, { maxTokens: 700 })
          : await deps.llm.complete(system, user, cfg.model, { maxTokens: 600 })
      ).trim();
      usedAi = true;
    } catch (e) {
      answer = `I couldn't write an answer just now (${(e as Error).message.slice(0, 80)}). Here are the current numbers:\n\n${snapshotLines(snapshot)}`;
    }
  }

  // ── Log anything that needs a person ───────────────────────────────────
  let taskId: number | undefined;
  if (kind !== "question") {
    const pushedBack = /\b(cannot|can't|not safely|instead|does not work|won'?t work|risk)\b/i.test(answer);
    const [ins] = await db
      .insert(schema.tasks)
      .values({
        source: "telegram",
        chatId,
        chatTitle,
        askedBy: askedBy.slice(0, 120),
        askedByUsername: m!.from?.username?.slice(0, 120) ?? null,
        kind,
        title: (question || "screenshot with no words").slice(0, 200),
        detail: (rawText + (imageRef ? "\n[screenshot attached]" : "")).slice(0, 4000),
        reply: answer.slice(0, 4000),
        pushedBack,
      })
      .$returningId();
    taskId = ins!.id;
    if (!/logged/i.test(answer)) answer += `\n\nLogged for Raza as #${taskId}.`;
    else answer += ` (#${taskId})`;
  }

  await log(answer, kind, taskId, usedAi);
  return { reply: answer, kind, usedAi, ...(taskId != null ? { taskId } : {}) };
}
