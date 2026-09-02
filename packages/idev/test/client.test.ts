import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  clearTokenCache,
  getAffiliates,
  getRoster,
  parseSignupDate,
  type IdevConfig,
} from "../src/index.js";

const config: IdevConfig = {
  url: "https://example.idevaffiliate.com",
  siteKey: "site-key-value",
  apiSecret: "legacy-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => clearTokenCache());

describe("authenticate", () => {
  it("POSTs api_secret (the SITE_KEY) form-encoded and returns the token", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://example.idevaffiliate.com/API/rest-api/authenticate.php");
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toBe("api_secret=site-key-value");
      return json({ token: "tok-1" });
    });
    await expect(authenticate(config, fetchMock as typeof fetch)).resolves.toBe("tok-1");
  });

  it("caches the token across calls", async () => {
    const fetchMock = vi.fn(async () => json({ token: "tok-1" }));
    await authenticate(config, fetchMock as typeof fetch);
    await authenticate(config, fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces iDev's rejection message", async () => {
    const fetchMock = vi.fn(async () => json({ message: "Invalid Secret" }));
    await expect(authenticate(config, fetchMock as typeof fetch)).rejects.toThrow("Invalid Secret");
  });
});

describe("getAffiliates", () => {
  it("sends the Bearer token and assembles paginated results", async () => {
    const TOTAL = 61; // live roster size at time of writing
    const page = (start: number, length: number) => ({
      message: "Data Received.",
      data: {
        iTotalRecords: TOTAL,
        aaData: Array.from({ length: Math.max(0, Math.min(length, TOTAL - start)) }, (_, i) => ({
          id: start + i,
          email: `a${start + i}@x.com`,
          username: `u${start + i}`,
          f_name: "F",
          l_name: "L",
          signup_date: "04/05/2026",
        })),
      },
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("authenticate.php")) return json({ token: "tok-1" });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
      const params = new URL(u).searchParams;
      const length = Number(params.get("iDisplayLength"));
      expect(length).toBeLessThanOrEqual(16); // iDev returns EMPTY above ~16
      return json(page(Number(params.get("iDisplayStart")), length));
    });
    const all = await getAffiliates(config, "approved", fetchMock as typeof fetch);
    expect(all).toHaveLength(TOTAL);
    expect(all[0]?.id).toBe(0);
    expect(all[60]?.id).toBe(60);
  });

  it("re-authenticates once when the token is rejected", async () => {
    let auths = 0;
    let calls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("authenticate.php")) {
        auths++;
        return json({ token: `tok-${auths}` });
      }
      calls++;
      if (calls === 1) return json({ message: "Unauthorized Token", bool: false });
      return json({ message: "Data Received.", data: { iTotalRecords: 1, aaData: [{ id: 1, email: "a@x.com", username: "u", f_name: "F", l_name: "L" }] } });
    });
    const all = await getAffiliates(config, "approved", fetchMock as typeof fetch);
    expect(all).toHaveLength(1);
    expect(auths).toBe(2); // initial + re-auth after rejection
  });
});

describe("getRoster — poisoned-row bisection", () => {
  it("skips a record that returns an empty body, reports its position, keeps the rest", async () => {
    // Live-observed iDev bug: one affiliate's data breaks the JSON encoder —
    // any page containing it comes back as a 0-byte body.
    const TOTAL = 40;
    const POISONED = 16;
    const row = (i: number) => ({ id: 100 + i, email: `a${i}@x.com`, username: `u${i}`, f_name: "F", l_name: "L" });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("authenticate.php")) return json({ token: "tok-1" });
      const params = new URL(u).searchParams;
      const start = Number(params.get("iDisplayStart"));
      const length = Number(params.get("iDisplayLength"));
      const end = Math.min(start + length, TOTAL);
      if (start <= POISONED && POISONED < end) return new Response("", { status: 200 }); // empty body
      const rows = Array.from({ length: Math.max(0, end - start) }, (_, i) => row(start + i));
      return json({ message: "Data Received.", data: { iTotalRecords: TOTAL, aaData: rows } });
    });
    const result = await getRoster(config, "approved", fetchMock as typeof fetch);
    expect(result.total).toBe(TOTAL);
    expect(result.poisonedPositions).toEqual([POISONED]);
    expect(result.affiliates).toHaveLength(TOTAL - 1);
    expect(result.affiliates.map((a) => a.id)).not.toContain(100 + POISONED);
  });
});

describe("parseSignupDate", () => {
  it("parses iDev's MM/DD/YYYY", () => {
    expect(parseSignupDate("04/05/2026")?.toISOString()).toBe("2026-04-05T00:00:00.000Z");
  });
  it("returns null for blank or malformed values", () => {
    expect(parseSignupDate(null)).toBeNull();
    expect(parseSignupDate("2026-04-05")).toBeNull();
  });
});
