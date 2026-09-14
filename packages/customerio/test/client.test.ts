import { describe, expect, it, vi } from "vitest";
import { customerioClient, customerioFromEnv } from "../src/index.js";

describe("customerioFromEnv", () => {
  it("null when unset; us default; eu accepted", () => {
    expect(customerioFromEnv({})).toBeNull();
    expect(customerioFromEnv({ CUSTOMERIO_SITE_ID: "s", CUSTOMERIO_TRACK_API_KEY: "k" })).toEqual({ siteId: "s", apiKey: "k", region: "us" });
    expect(customerioFromEnv({ CUSTOMERIO_SITE_ID: "s", CUSTOMERIO_TRACK_API_KEY: "k", CUSTOMERIO_REGION: "eu" })?.region).toBe("eu");
  });
});

describe("identify", () => {
  it("PUTs to the track API with basic auth, email as id, and never leaks the key in errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    });
    const c = customerioClient({ siteId: "site", apiKey: "SECRETKEY", region: "us" }, ok as typeof fetch);
    await c.identify("Ann@Example.com", { first_name: "Ann", lead_id: 7, unsubscribed: false });
    expect(calls[0]?.url).toBe("https://track.customer.io/api/v1/customers/ann%40example.com");
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("site:SECRETKEY").toString("base64")}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: "ann@example.com", first_name: "Ann", lead_id: 7, unsubscribed: false });

    const bad = customerioClient({ siteId: "site", apiKey: "SECRETKEY", region: "eu" }, (async () => new Response("nope", { status: 401 })) as typeof fetch);
    await expect(bad.identify("a@b.c", {})).rejects.toThrow(/Customer\.io identify: HTTP 401/);
    await expect(bad.identify("a@b.c", {})).rejects.not.toThrow(/SECRETKEY/);
  });
  it("eu region uses track-eu", async () => {
    let url = "";
    const c = customerioClient({ siteId: "s", apiKey: "k", region: "eu" }, (async (u: string | URL) => ((url = String(u)), new Response("{}"))) as typeof fetch);
    await c.identify("a@b.c", {});
    expect(url.startsWith("https://track-eu.customer.io/")).toBe(true);
  });
});
