import { describe, expect, it } from "vitest";
import { contactUrlsFor, domainLooksLikeCreator, emailsFromHtml, findBusinessEmail, isLinkHub, isOwnSite, linksFromHtml, normalizeUrl } from "../src/email-find.js";

describe("addresses on a page", () => {
  it("prefers a mailto, then one offered for business, over one buried in the text", () => {
    const html = `
      <p>reach me: hello@sarahfit.com</p>
      <p>Business inquiries: team@sarahfit.com</p>
      <a href="mailto:sarah@sarahfit.com?subject=hi">email me</a>`;
    expect(emailsFromHtml(html, "https://sarahfit.com/contact").map((e) => [e.email, e.how])).toEqual([
      ["sarah@sarahfit.com", "mailto"],
      ["team@sarahfit.com", "labelled"],
      ["hello@sarahfit.com", "text"],
    ]);
  });

  it("reads an address written to dodge scrapers, and drops the platform's own", () => {
    const html = `<p>collabs: jess (at) jesslifts (dot) com</p>
      <a href="mailto:no-reply@wix.com">x</a><p>support@squarespace.com</p>
      <img src="logo@2x.png">`;
    expect(emailsFromHtml(html, "https://jesslifts.com").map((e) => e.email)).toEqual(["jess@jesslifts.com"]);
  });

  it("keeps each address once, however many times it appears", () => {
    const html = `<a href="mailto:me@site.com">a</a><a href="mailto:me@site.com">b</a><p>me@site.com</p>`;
    expect(emailsFromHtml(html, "https://site.com")).toHaveLength(1);
  });
});

describe("where to look", () => {
  it("asks for the contact pages of a site, and nothing off it", () => {
    const urls = contactUrlsFor("https://sarahfit.com");
    expect(urls[0]).toBe("https://sarahfit.com/");
    expect(urls).toContain("https://sarahfit.com/contact");
    expect(urls.every((u) => u.startsWith("https://sarahfit.com"))).toBe(true);
  });

  it("knows a link hub from a creator's own site from another platform's page", () => {
    expect(isLinkHub("https://linktr.ee/nicoleerinn")).toBe(true);
    expect(isLinkHub("https://beacons.ai/tiffany")).toBe(true);
    expect(isOwnSite("https://sarahfit.com")).toBe(true);
    expect(isOwnSite("https://www.tiktok.com/@sarah")).toBe(false);
    expect(isOwnSite("https://linktr.ee/sarah")).toBe(false);
  });

  it("cleans a link in a bio, and refuses what isn't a web address", () => {
    expect(normalizeUrl("sarahfit.com/?utm_source=tiktok")).toBe("https://sarahfit.com/");
    expect(normalizeUrl("https://sarahfit.com/shop#top")).toBe("https://sarahfit.com/shop");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("takes the outbound links off a hub, their own site first, one per host", () => {
    const html = `<a href="https://www.tiktok.com/@nicole">tiktok</a>
      <a href="https://nicolewellness.com/shop">my shop</a>
      <a href="https://nicolewellness.com/about">about</a>
      <a href="https://www.instagram.com/nicole">ig</a>`;
    const links = linksFromHtml(html, "https://linktr.ee/nicoleerinn");
    expect(links.filter((l) => l.includes("nicolewellness"))).toHaveLength(1);
    expect(links.find((l) => !l.includes("tiktok") && !l.includes("instagram"))).toContain("nicolewellness.com");
  });
});

describe("finding one creator's address", () => {
  const page = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

  it("follows a link hub to their own site and reads the contact page", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      if (String(url).includes("linktr.ee")) return page(`<a href="https://amiemock.com">my site</a><a href="https://www.instagram.com/amie">ig</a>`);
      if (String(url) === "https://amiemock.com/contact") return page(`<a href="mailto:hello@amiemock.com">say hi</a>`);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await findBusinessEmail("https://linktr.ee/amiemock", { fetchImpl });
    expect(res.found).toMatchObject({ email: "hello@amiemock.com", how: "mailto" });
    expect(res.site).toBe("https://amiemock.com/");
    expect(asked.some((u) => u.includes("instagram"))).toBe(false);
  });

  it("gives up quietly on a hub with nothing but socials", async () => {
    const fetchImpl = (async () => page(`<a href="https://www.tiktok.com/@x">tiktok</a>`)) as unknown as typeof fetch;
    const res = await findBusinessEmail("https://linktr.ee/x", { fetchImpl });
    expect(res.found).toBeNull();
  });

  it("stops after the page budget and never leaves the creator's own site", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      expect(String(url)).toContain("amiemock.com");
      return page("<p>nothing here</p>");
    }) as unknown as typeof fetch;
    await findBusinessEmail("https://amiemock.com", { fetchImpl, maxPages: 3 });
    expect(calls).toBe(3);
  });

  it("ignores a page that isn't html, and a fetch that throws", async () => {
    const asJson = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect((await findBusinessEmail("https://amiemock.com", { fetchImpl: asJson })).found).toBeNull();
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await findBusinessEmail("https://amiemock.com", { fetchImpl: boom })).found).toBeNull();
  });
});

describe("whose address is it", () => {
  const page = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const always = (body: string) => (async () => page(body)) as unknown as typeof fetch;

  it("ties a domain to the creator, and refuses a brand they merely promote", () => {
    expect(domainLooksLikeCreator("bodyhackguide.co", ["bodyhackguide"])).toBe(true);
    expect(domainLooksLikeCreator("www.sarahfit.com", ["Sarah Fit"])).toBe(true);
    expect(domainLooksLikeCreator("peptira.com", ["bodyhackguide", "Dana Lewis"])).toBe(false);
    expect(domainLooksLikeCreator("shop.peptira.com", ["Peptira fan"])).toBe(false);
  });

  it("never reads a brand's store: a referral link is skipped before any fetch", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return page(`<a href="mailto:support@based.com">support</a>`);
    }) as unknown as typeof fetch;
    const res = await findBusinessEmail("https://based.com/?ref=MANUEL", { fetchImpl });
    expect(res).toMatchObject({ found: null, skipped: "affiliate_link" });
    expect(called).toBe(0);
  });

  it("drops a competitor's support inbox even when it is the only address there", async () => {
    const res = await findBusinessEmail("https://peptira.com", {
      fetchImpl: always(`<a href="mailto:support@peptira.com">help</a>`),
      rejectDomains: ["peptira.com"],
      creatorTokens: ["Dana Lewis", "danalifts"],
    });
    expect(res).toMatchObject({ found: null, skipped: "rejected_domain" });
  });

  it("keeps an address on the creator's own domain and nobody else's", async () => {
    const html = `<a href="mailto:hello@bodyhackguide.co">me</a><a href="mailto:support@peptira.com">brand</a>`;
    const mine = await findBusinessEmail("https://bodyhackguide.co", {
      fetchImpl: always(html),
      rejectDomains: ["peptira.com"],
      creatorTokens: ["bodyhackguide"],
    });
    expect(mine.found).toMatchObject({ email: "hello@bodyhackguide.co" });
    const notMine = await findBusinessEmail("https://somerandomshop.com", {
      fetchImpl: always(`<a href="mailto:info@somerandomshop.com">info</a>`),
      creatorTokens: ["Jamie Hunter", "diyskincarejamie"],
    });
    expect(notMine).toMatchObject({ found: null, skipped: "not_their_domain" });
  });

  it("reads an address out of escaped page data without the escape stuck to it", () => {
    const html = String.raw`{"contact":"<a href=\"mailto:hi@amiemock.com\">hi</a>"}`;
    expect(emailsFromHtml(html, "https://amiemock.com").map((e) => e.email)).toContain("hi@amiemock.com");
  });
});
