import { describe, expect, it, vi } from "vitest";
import { apifyConfigFromEnv, runActorSync } from "../src/apify.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("runActorSync", () => {
  it("POSTs input to run-sync-get-dataset-items with bearer auth and returns items", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?timeout=90&clean=true",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init?.body))).toEqual({ profiles: ["meg.boggs"] });
      return json([{ text: "hi" }]);
    });
    const items = await runActorSync<{ text: string }>(
      { token: "tok", fetchImpl: fetchMock as typeof fetch },
      "clockworks/tiktok-profile-scraper",
      { profiles: ["meg.boggs"] },
    );
    expect(items).toEqual([{ text: "hi" }]);
  });

  it("throws with the actor id and status, never the token", async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: "actor not found" } }, 404));
    await expect(runActorSync({ token: "SECRET", fetchImpl: fetchMock as typeof fetch }, "x/y", {})).rejects.toThrow(
      /x\/y.*404.*actor not found/,
    );
    await expect(runActorSync({ token: "SECRET", fetchImpl: fetchMock as typeof fetch }, "x/y", {})).rejects.not.toThrow(
      /SECRET/,
    );
  });

  it("treats a non-array body as an error", async () => {
    const fetchMock = vi.fn(async () => json({ data: {} }));
    await expect(runActorSync({ token: "t", fetchImpl: fetchMock as typeof fetch }, "x/y", {})).rejects.toThrow(/non-array/);
  });
});

describe("apifyConfigFromEnv", () => {
  it("requires APIFY_TOKEN", () => {
    expect(() => apifyConfigFromEnv({})).toThrow(/APIFY_TOKEN/);
  });
  it("uses default actors and allows overrides", () => {
    const cfg = apifyConfigFromEnv({ APIFY_TOKEN: "t" }, { tiktok: "me/custom" });
    expect(cfg.actors.tiktok).toBe("me/custom");
    expect(cfg.actors.instagram).toBe("apify/instagram-profile-scraper");
  });
});
