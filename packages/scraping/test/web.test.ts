import { describe, expect, it, vi } from "vitest";
import { fetchLinkHub, fetchWeb, htmlToText } from "../src/fetchers/web.js";
import { fetcherFor } from "../src/fetchers/index.js";
import type { FetchDeps } from "../src/types.js";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const deps = (res: Response): FetchDeps => ({
  fetchImpl: vi.fn(async () => res) as typeof fetch,
  apify: { token: "t", actors: {} },
  maxItems: 12,
});

describe("htmlToText", () => {
  it("strips scripts, styles, tags; collapses whitespace", () => {
    const t = htmlToText(
      "<html><head><style>p{}</style><script>x()</script><title>Outliyr</title></head><body><h1>Top  biohackers</h1><p>Dave &amp; co</p></body></html>",
    );
    expect(t).toBe("Outliyr Top biohackers Dave & co");
  });
});

describe("fetchWeb", () => {
  it("returns one item with the page text, capped at 4000 chars, title as displayName", async () => {
    const long = "word ".repeat(2000);
    const b = await fetchWeb(
      { platform: "web", handle: null, url: "https://outliyr.com/x" },
      deps(html(`<title>Outliyr</title><body>${long}</body>`)),
    );
    expect(b.displayName).toBe("Outliyr");
    expect(b.items).toHaveLength(1);
    expect(b.items[0]?.url).toBe("https://outliyr.com/x");
    expect(b.items[0]?.text.length).toBeLessThanOrEqual(4000);
  });
  it("returns an empty bundle on 404 (reachable, nothing there) and throws on 5xx", async () => {
    const gone = await fetchWeb({ platform: "web", handle: null, url: "https://a.com" }, deps(html("nope", 404)));
    expect(gone.items).toEqual([]);
    await expect(fetchWeb({ platform: "web", handle: null, url: "https://a.com" }, deps(html("err", 503)))).rejects.toThrow(/503/);
  });
});

describe("fetchLinkHub", () => {
  it("discovers social links and returns no items itself", async () => {
    const page = `<a href="https://www.tiktok.com/@shelby">TikTok</a><a href="https://instagram.com/shelbypep">IG</a><a href="https://shop.example.com">Shop</a>`;
    const b = await fetchLinkHub({ platform: "linkhub", handle: null, url: "https://linktr.ee/shelby" }, deps(html(page)));
    expect(b.items).toEqual([]);
    expect(b.discovered).toEqual([
      { platform: "tiktok", handle: "shelby", url: "https://www.tiktok.com/@shelby" },
      { platform: "instagram", handle: "shelbypep", url: "https://www.instagram.com/shelbypep/" },
    ]);
  });
});

describe("fetcherFor", () => {
  it("returns a fetcher for every platform", () => {
    for (const p of ["tiktok", "instagram", "youtube", "reddit", "x", "web", "linkhub"] as const) {
      expect(typeof fetcherFor(p)).toBe("function");
    }
  });
});
