import { describe, expect, it } from "vitest";
import type { LlmClient } from "@biolinx/drafting";
import { buildNote, summarizeBundle, verifyPoints } from "../src/summarize.js";
import type { SourceBundle } from "../src/types.js";

const bundle: SourceBundle = {
  platform: "tiktok",
  profileUrl: "https://www.tiktok.com/@annie",
  displayName: "Annie",
  bio: "NP · hormones",
  followers: 42000,
  items: [
    { url: "https://www.tiktok.com/@annie/video/1", text: "The exact list I pull when a woman says she doesn't feel like herself", postedAt: null },
    { url: "https://www.tiktok.com/@annie/video/2", text: "HRT not working? your body lacks a foundation", postedAt: null },
  ],
};

const llm = (reply: string): LlmClient => ({ complete: async () => reply });

describe("verifyPoints", () => {
  it("drops points whose url is not in the bundle", () => {
    const kept = verifyPoints(
      [
        { text: "real", url: "https://www.tiktok.com/@annie/video/1" },
        { text: "invented", url: "https://www.tiktok.com/@annie/video/999" },
        { text: "profile-level ok", url: "https://www.tiktok.com/@annie" },
      ],
      bundle,
    );
    expect(kept.map((p) => p.text)).toEqual(["real", "profile-level ok"]);
  });
});

describe("buildNote", () => {
  it("formats exactly like the August notes", () => {
    expect(buildNote([{ text: "a", url: "https://x/1" }, { text: "b", url: "https://x/2" }])).toBe("MATCH — a (https://x/1); b (https://x/2).");
  });
});

describe("summarizeBundle", () => {
  it("returns match with verified points and a built note", async () => {
    const s = await summarizeBundle(
      llm(
        JSON.stringify({
          verdict: "match",
          points: [{ text: "NP posting real perimenopause content: 'the exact list I pull'", url: "https://www.tiktok.com/@annie/video/1" }],
        }),
      ),
      bundle,
    );
    expect(s.verdict).toBe("match");
    expect(s.points).toHaveLength(1);
    expect(s.note).toBe("MATCH — NP posting real perimenopause content: 'the exact list I pull' (https://www.tiktok.com/@annie/video/1).");
  });

  it("becomes no_match when every point is unverifiable, even if the model said match", async () => {
    const s = await summarizeBundle(llm(JSON.stringify({ verdict: "match", points: [{ text: "x", url: "https://nowhere" }] })), bundle);
    expect(s).toEqual({ verdict: "no_match", points: [], note: "" });
  });

  it("returns no_match for an empty bundle without calling the model", async () => {
    let called = 0;
    const spy: LlmClient = { complete: async () => (called++, "") };
    const s = await summarizeBundle(spy, { ...bundle, items: [] });
    expect(s.verdict).toBe("no_match");
    expect(called).toBe(0);
  });

  it("throws on malformed JSON so the caller marks the lead failed", async () => {
    await expect(summarizeBundle(llm("not json"), bundle)).rejects.toThrow(/summarize: unparseable/);
  });

  it("caps at 3 points", async () => {
    const pts = Array.from({ length: 5 }, (_, i) => ({ text: `p${i}`, url: bundle.items[i % 2]!.url }));
    const s = await summarizeBundle(llm(JSON.stringify({ verdict: "match", points: pts })), bundle);
    expect(s.points).toHaveLength(3);
  });
});
