import { describe, expect, it } from "vitest";
import { classifyReply, draftMessage, type DraftRequest, type LlmClient } from "../src/index.js";
import type { LintContext } from "@biolinx/compliance";

const dmCtx: LintContext = { channel: "dm", touchNumber: 1, isPublic: false, audience: "prospect" };

const req: DraftRequest = {
  templateGuidance: "Warm creator opener",
  lead: {
    firstName: "Sam",
    personalizationNotes: "Posted about recovery routines on 2026-08-20 (https://tiktok.com/x)",
    channel: "dm",
    touchNumber: 1,
  },
  senderName: "Diana",
  variant: "curiosity",
};

const llmReturning = (...responses: string[]): LlmClient => {
  let i = 0;
  return { complete: async () => responses[Math.min(i++, responses.length - 1)]! };
};

const CLEAN =
  "Loved your recovery-routine post from last month. I'm helping run a partner program for a research supplement brand. Would a short conversation be worth your time? Only if it feels like a fit.";

describe("draftMessage", () => {
  it("passes a clean draft through the linter", async () => {
    const result = await draftMessage(llmReturning(CLEAN), req, dmCtx);
    expect(result.status).toBe("ok");
    expect(result.body).toBe(CLEAN);
    expect(result.attempts).toBe(1);
  });

  it("repairs once when the first draft violates, then blocks if still dirty", async () => {
    const dirty = "Our semaglutide is amazing for weight loss!";
    const repaired = await draftMessage(llmReturning(dirty, CLEAN), req, dmCtx);
    expect(repaired.status).toBe("ok");
    expect(repaired.attempts).toBe(2);

    const hopeless = await draftMessage(llmReturning(dirty, dirty), req, dmCtx);
    expect(hopeless.status).toBe("blocked");
    expect(hopeless.lintReport[0]?.rule).toBe("lint-unrepairable");
  });

  it("blocks a first touch with no personalization notes — never invents", async () => {
    const result = await draftMessage(
      llmReturning(CLEAN),
      { ...req, lead: { ...req.lead, personalizationNotes: null } },
      dmCtx,
    );
    expect(result.status).toBe("blocked");
    expect(result.lintReport[0]?.rule).toBe("no-personalization");
  });

  it("blocks (never guesses) when the LLM is unavailable", async () => {
    const down: LlmClient = { complete: async () => { throw new Error("529"); } };
    const result = await draftMessage(down, req, dmCtx);
    expect(result.status).toBe("blocked");
    expect(result.lintReport[0]?.rule).toBe("llm-unavailable");
  });

  it("parses email subjects from the SUBJECT: first line", async () => {
    const emailReq: DraftRequest = { ...req, lead: { ...req.lead, channel: "email" } };
    const emailCtx: LintContext = {
      channel: "email",
      touchNumber: 1,
      isPublic: false,
      audience: "prospect",
      hasUnsubscribeLink: true,
      hasPostalAddress: true,
      recipientCountry: "US",
      emailProvenance: "published_business",
    };
    const result = await draftMessage(llmReturning(`SUBJECT: quick question\n${CLEAN}`), emailReq, emailCtx);
    expect(result.status).toBe("ok");
    expect(result.subject).toBe("quick question");
  });
});

describe("classifyReply", () => {
  it("returns a known class verbatim and falls back to unclassifiable", async () => {
    expect(await classifyReply(llmReturning("opt_out"), "remove me")).toBe("opt_out");
    expect(await classifyReply(llmReturning("maybe interested??"), "hmm")).toBe("unclassifiable");
    const down: LlmClient = { complete: async () => { throw new Error("down"); } };
    expect(await classifyReply(down, "anything")).toBe("unclassifiable");
  });
});
