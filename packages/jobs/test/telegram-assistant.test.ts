import { describe, expect, it } from "vitest";
import { askWithLookups, assistantConfigFromEnv, cleanQuestion, shouldAnswer, splitTaskTag } from "../src/telegram/assistant.js";
import { SYSTEM_BRIEF } from "../src/telegram/brief.js";
import { MAX_IMAGE_BYTES, imageRefOf, pickPhoto } from "../src/telegram/files.js";
import { snapshotLines, type Snapshot } from "../src/telegram/snapshot.js";


const SNAP: Snapshot = {
  takenAt: "2026-09-21T00:00:00Z",
  goal: { target: 100, external: 43, unclassified: 4, internal: 16, daysToBlackFriday: 67 },
  leads: { total: 625, sourced: 213, accepted: 57, pendingReview: 109, rejected: 47, withCompetitor: 312 },
  sourcing: { competitorsActive: 43, lastRunAt: "2026-09-20", lastRunAdded: 11, lastRunCostUsd: 2.82, nightly: [{ day: "2026-09-20", added: 11, costUsd: 2.82 }] },
  outreach: { queueNew: 42, repliesToAnswer: 1, checkinsDue: 0, waitingForReply: 3, messagesSent: 3, repliesLogged: 2 },
  signups: { total: 3, pending: 0 },
  content: { sourcePostsBanked: 95, drafts: 2, sent: 1 },
  tasks: { open: 2, lastTitles: ["add a sales report"] },
};

const msg = (over: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { text: "hello", chat: { id: 5, type: "private" }, from: { first_name: "Josh" }, ...over },
});

describe("telegram assistant", () => {
  it("answers everything in a private chat, and only when spoken to in a group", () => {
    expect(shouldAnswer(msg(), "biolinxbot")).toBe(true);
    expect(shouldAnswer(msg({ chat: { id: -100, type: "group" } }), "biolinxbot")).toBe(false);
    expect(shouldAnswer(msg({ chat: { id: -100, type: "group" }, text: "@biolinxbot how many leads" }), "biolinxbot")).toBe(true);
    expect(shouldAnswer(msg({ chat: { id: -100, type: "group" }, text: "/status" }), "biolinxbot")).toBe(true);
    expect(shouldAnswer(msg({ chat: { id: -100, type: "group" }, reply_to_message: { from: { is_bot: true } } }), "biolinxbot")).toBe(true);
    // Its own messages, and empty ones, are never answered.
    expect(shouldAnswer(msg({ from: { is_bot: true } }), "biolinxbot")).toBe(false);
    expect(shouldAnswer({ update_id: 2, message: { chat: { id: 5, type: "private" } } }, "biolinxbot")).toBe(false);
  });

  it("answers a screenshot even with no words, in a group too", () => {
    const photo = { photo: [{ file_id: "a", file_size: 900 }], text: undefined, caption: undefined };
    expect(shouldAnswer(msg(photo), "biolinxbot")).toBe(true);
    expect(shouldAnswer(msg({ ...photo, chat: { id: -100, type: "group" }, caption: "@biolinxbot what is this" }), "biolinxbot")).toBe(true);
  });

  it("takes the task out of the reply, and leaves an ordinary answer alone", () => {
    // The model marks a request itself; keyword rules used to get this wrong on real messages.
    const tagged = splitTaskTag("Not safely, here is why.\n\n[[task: look at auto-DM options for TikTok]]");
    expect(tagged.task).toBe("look at auto-DM options for TikTok");
    expect(tagged.reply).toBe("Not safely, here is why.");
    const plain = splitTaskTag("43 of 100 external affiliates.");
    expect(plain.task).toBeNull();
    expect(plain.reply).toBe("43 of 100 external affiliates.");
    // A tag in the middle of a sentence is not a task marker.
    expect(splitTaskTag("the [[task: x]] is mid sentence here").task).toBeNull();
  });

  it("strips the mention and the command from the question", () => {
    expect(cleanQuestion("@biolinxbot how many leads?", "biolinxbot")).toBe("how many leads?");
    expect(cleanQuestion("/status@biolinxbot", "biolinxbot")).toBe("");
    expect(cleanQuestion("/ask what is the queue", "biolinxbot")).toBe("what is the queue");
    // A doubled slash is a typo, not a different command (seen live, 2026-09-21).
    expect(cleanQuestion("//status@biolinxbot hi".replace(/^\/{2,}/, "/"), "biolinxbot")).toBe("hi");
    // Words after a command are the real question; only a bare command gets the canned answer.
    expect(cleanQuestion("/status@biolinxbot can you tell me about the last affiliates", "biolinxbot")).toBe("can you tell me about the last affiliates");
  });

  it("reads the allow-list and the caps from settings", () => {
    // Deny by default: the bot's address is public, so an empty list means nobody, not everybody.
    expect(assistantConfigFromEnv({} as never).allowedChats).toEqual([]);
    const cfg = assistantConfigFromEnv({ TELEGRAM_ALLOWED_CHATS: "-100123, 456 -100123", TELEGRAM_BOT_USERNAME: "@biolinxbot", TELEGRAM_DAILY_ANSWERS: "50" } as never);
    expect(cfg.allowedChats).toEqual(["-100123", "456"]);
    expect(cfg.botUsername).toBe("biolinxbot");
    expect(cfg.dailyAnswerCap).toBe(50);
    // A missing cap falls back rather than disabling the bot.
    expect(assistantConfigFromEnv({ TELEGRAM_CHAT_ID: "-100999" } as never).dailyAnswerCap).toBeGreaterThan(0);
  });

  it("picks the largest screenshot within the size cap, and ignores non-images", () => {
    expect(pickPhoto([{ file_id: "s", file_size: 100 }, { file_id: "l", file_size: 900 }])?.file_id).toBe("l");
    expect(pickPhoto([{ file_id: "huge", file_size: MAX_IMAGE_BYTES + 1 }])).toBeNull();
    expect(imageRefOf({ document: { file_id: "d", mime_type: "application/pdf", file_size: 10 } })).toBeNull();
    expect(imageRefOf({ document: { file_id: "d", mime_type: "image/png", file_size: 10 } })).toEqual({ fileId: "d", mediaType: "image/png" });
    expect(imageRefOf({})).toBeNull();
  });

  it("the brief tells the assistant the things it must never get wrong", () => {
    // These are the promises the client hears; a rewrite that drops one is a regression.
    expect(SYSTEM_BRIEF).toContain("No tool can send a first direct message");
    expect(SYSTEM_BRIEF).toMatch(/never reveal api keys/i);
    expect(SYSTEM_BRIEF).toMatch(/raza93552/i);
    expect(SYSTEM_BRIEF).toMatch(/positively/i);
    expect(SYSTEM_BRIEF).toMatch(/research use only/i);
    expect(SYSTEM_BRIEF).toMatch(/screenshot/i);
    // The model, not a keyword rule, decides what becomes a task.
    expect(SYSTEM_BRIEF).toContain("[[task:");
    expect(SYSTEM_BRIEF).toMatch(/talk like a person/i);
  });

  it("turns the snapshot into lines with every number a person asks for", () => {
    const s = SNAP;
    const lines = snapshotLines(s);
    expect(lines).toContain("43 of 100 external affiliates");
    expect(lines).toContain("109 waiting for review");
    expect(lines).toContain("+11 for $2.82");
    expect(lines).toContain("add a sales report");
  });

  it("runs the lookups the model asks for, then answers", async () => {
    const said: string[] = [];
    const replies = ['[[lookup: find_leads {"competitor":"Amino Club"}]]', "Two of them are Amino Club."];
    const cli = { ask: async (_s: string, prompt: string) => { said.push(prompt); return replies.shift()!; } };
    const db = {} as never; // the lookup fails against a stub db, which the loop reports rather than throws
    const r = await askWithLookups(db, cli, "system", "who did we find?");
    expect(r.lookups).toEqual(["find_leads"]);
    expect(r.answer).toBe("Two of them are Amino Club.");
    // The result of the lookup is handed back in the next prompt.
    expect(said[1]).toContain("You asked to look up find_leads");
  });

  it("stops asking for data instead of looping forever", async () => {
    const cli = { ask: async () => '[[lookup: find_leads {}]]' };
    const r = await askWithLookups({} as never, cli, "system", "who?", 2);
    expect(r.lookups.length).toBeLessThanOrEqual(3);
    expect(r.answer).toContain("Ask me again");
  });
});
