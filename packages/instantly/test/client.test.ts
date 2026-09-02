import { describe, expect, it, vi } from "vitest";
import { listAccounts, pushLead, suppress, type InstantlyConfig } from "../src/index.js";

const config: InstantlyConfig = { apiKey: "test-key" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("instantly client", () => {
  it("sends Bearer auth and parses items", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      expect(String(url)).toContain("/api/v2/accounts");
      return json({ items: [{ email: "a@x.com", status: 1 }] });
    });
    const accounts = await listAccounts(config, fetchMock as typeof fetch);
    expect(accounts).toEqual([{ email: "a@x.com", status: 1 }]);
  });

  it("pushLead carries the linted message as custom variables", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.campaign).toBe("camp-1");
      expect(body.custom_variables.personalized_body).toContain("hello");
      return json({ id: "lead-1" });
    });
    const res = await pushLead(
      config,
      { campaignId: "camp-1", email: "l@x.com", subject: "s", body: "hello there" },
      fetchMock as typeof fetch,
    );
    expect(res.id).toBe("lead-1");
  });

  it("surfaces API errors with status and message", async () => {
    const fetchMock = vi.fn(async () => json({ message: "invalid campaign" }, 422));
    await expect(suppress(config, "x@y.com", fetchMock as typeof fetch)).rejects.toThrow("422");
  });
});
