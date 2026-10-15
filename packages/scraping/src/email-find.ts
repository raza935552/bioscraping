// Finding an address a creator published for business, on their own site or link hub.
//
// Why this exists: an email written in a TikTok bio is saved with provenance "scraped", and the
// compliance linter refuses to send automated mail to it — writing your address in a bio is not
// consent to be put in a campaign. An address published on their own website's contact page, or in
// the business-contact field a platform offers, is a different thing: it is there to be written to.
// Those are saved as "published_business", which the linter allows.
//
// Everything here is a plain fetch from our own server: no Apify, no cost. It reads at most a
// handful of pages per creator, follows one hop off a link hub to their real site, and gives up
// quietly on anything slow, large, or not HTML.

import { isPlausibleEmail } from "./contact.js";

const UA = "Mozilla/5.0 (compatible; BiolinxEngine/1.0; +https://biolinxlabs.com)";
const MAX_REDIRECTS = 3;

/** Where a fetch must never go. These URLs come from a creator's bio link, which anyone can set, so
 *  "https://169.254.169.254/" in a TikTok bio would otherwise have this server read its own cloud
 *  metadata, and "http://127.0.0.1:3001/..." would have it call our own API from inside. Both the
 *  hostname and every address it resolves to are checked, and again on each redirect. */
const BLOCKED_V4 = [
  [0, 0], // 0.0.0.0/8 "this host"
  [10, 10], // private
  [127, 127], // loopback
  [169, 169], // link-local 169.254/16, narrowed below
  [172, 172], // 172.16/12, narrowed below
  [192, 192], // 192.168/16 + 192.0.0/24, narrowed below
  [100, 100], // CGNAT 100.64/10, narrowed below
  [224, 255], // multicast + reserved
] as const;

export function isBlockedIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 169) return b === 254;
    if (a === 172) return b >= 16 && b <= 31;
    if (a === 192) return b === 168 || b === 0 || b === 88; // private, protocol assignments, 6to4 relay
    if (a === 100) return b >= 64 && b <= 127;
    if (a === 198) return b === 18 || b === 19 || b === 51; // benchmarking, TEST-NET-2
    if (a === 203) return b === 0; // TEST-NET-3
    return BLOCKED_V4.some(([lo, hi]) => a >= lo && a <= hi && ![169, 172, 192, 100, 198, 203].includes(a));
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (v6 === "::" || v6 === "::1") return true;
  // The same address wearing another hat: IPv4-mapped (::ffff:127.0.0.1), IPv4-compatible
  // (::127.0.0.1) and NAT64 (64:ff9b::7f00:1) all reach an IPv4 host through IPv6.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (embedded) return isBlockedIp(embedded[1]!);
  if (/^64:ff9b:/.test(v6)) {
    // NAT64 in hex form: the last 32 bits are the IPv4 address.
    const groups = v6.split(":").filter(Boolean);
    const tail = groups.slice(-2);
    if (tail.length === 2 && tail.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const [hi, lo] = tail.map((g) => parseInt(g, 16)) as [number, number];
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true; // anything else in the NAT64 prefix is not worth reaching
  }
  return /^(fe[89ab]|fc|fd)/.test(v6); // link-local, unique-local
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || /^\[/.test(host);
}

/** Resolves a hostname to its addresses. Injected in tests so they never touch DNS. */
export type ResolveHost = (host: string) => Promise<string[]>;

const resolveWithDns: ResolveHost = async (host) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
};

/** True when this URL may be fetched: a named host, a normal web port, and every address it
 *  resolves to is on the public internet. */
export async function isFetchable(url: string, resolve: ResolveHost = resolveWithDns): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  if (isIpLiteral(u.hostname)) return false;
  try {
    const addresses = await resolve(u.hostname);
    return addresses.length > 0 && !addresses.some(isBlockedIp);
  } catch {
    return false; // no DNS answer: nothing to fetch
  }
}

const MAX_BYTES = 600_000;
const TIMEOUT_MS = 12_000;

/** Pages that carry a contact address, in the order worth trying. */
const CONTACT_PATHS = ["/", "/contact", "/contact-us", "/about", "/work-with-me", "/collab", "/pages/contact"];

/** Wording next to an address that says it is for business. */
const BUSINESS_WORDS = /\b(business|inquir|enquir|contact|collab|partnership|sponsor|press|media kit|booking|work with)\b/i;

/** Addresses that belong to a platform or a plugin, never to the creator. */
const NOT_THEIRS =
  /^(no-?reply|donotreply|postmaster|abuse|webmaster|privacy|legal|dmca|unsubscribe|wordpress|sentry|wix|squarespace|shopify|godaddy|cloudflare|mailer-daemon)@|@(wix|squarespace|shopify|wordpress|sentry|godaddy|example|email|domain|sentry\.io)\./i;

/** Link hubs: the page itself holds no address, but the site it points at usually does. */
const LINK_HUBS = /^(www\.)?(linktr\.ee|beacons\.ai|linkin\.bio|link\.me|stan\.store|komi\.io|snipfeed\.co|solo\.to|tap\.bio|carrd\.co|allmylinks\.com|hoo\.be|bio\.link|lnk\.bio|milkshake\.app|flowcode\.com|withkoji\.com)$/i;

/** A link in a bio carrying a referral code or landing on a coupon page is the brand's store, which
 *  is exactly what we must not read an address off: it would be the competitor's support inbox. */
const AFFILIATE_LINK = /[?&](ref|aff|affiliate|rfsn|via|discount|coupon|promo|utm_campaign)=|\/(coupons?|discount|promo|vendors?|deals?)(\/|$)/i;

/** Hosts that are somebody else's platform, not the creator's own site. */
const NOT_A_SITE =
  /(^|\.)(tiktok|instagram|youtube|youtu|facebook|twitter|x|threads|reddit|snapchat|pinterest|twitch|discord|telegram|whatsapp|t|amazon|amzn|google|apple|spotify|paypal|venmo|cash|gofundme|patreon|substack|shopmy|ltk|liketoknow)\.(com|be|it|me|co|us|app|to|gg|io|live|shop)$/i;

export interface FoundEmail {
  email: string;
  /** The page it was on. */
  foundAt: string;
  /** "mailto": a link they put there. "labelled": written next to business wording. "text": in the page text. */
  how: "mailto" | "labelled" | "text";
}

export interface FindDeps {
  /** Tests only. Left out in production so the pinned request is used, which is what makes the
   *  address check binding; a plain fetch re-resolves the name and can be rebound. */
  fetchImpl?: typeof fetch;
  /** Pages per creator across every hop; the default keeps a run polite and quick. */
  maxPages?: number;
  /** Domains that belong to competitors, deal sites or anyone else who isn't this creator. Nothing
   *  is read off them, and no address on them is kept. */
  rejectDomains?: string[];
  /** Their handle and name. An address is only theirs if its domain looks like one of these; without
   *  it a creator linking a brand store would be given that brand's support address. */
  creatorTokens?: string[];
  /** How a hostname is resolved before it is fetched. Injected in tests; real DNS otherwise. */
  resolveHost?: ResolveHost;
}

/** The domain without its public suffix or "www", letters and digits only. */
function domainCore(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  const name = parts.length > 2 ? parts.slice(0, -2).concat(parts[parts.length - 2]!).join("") : (parts[0] ?? "");
  return name.replace(/[^a-z0-9]/g, "");
}

/** True when a domain plausibly belongs to this creator: "bodyhackguide.co" for @bodyhackguide,
 *  never "peptira.com" for someone who merely promotes Peptira. */
export function domainLooksLikeCreator(host: string, tokens: string[]): boolean {
  const core = domainCore(host);
  if (!core) return false;
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length < 5) continue;
    if (core.includes(t) || t.includes(core)) return true;
    // "sarah fit" ↔ sarahfit.com: every word of a name, in order, inside the domain.
    const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (words.length > 1 && words.every((w) => core.includes(w))) return true;
  }
  return false;
}

function rejected(host: string, rejects: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return rejects.some((d) => {
    const r = d.toLowerCase().replace(/^www\./, "");
    return !!r && (h === r || h.endsWith(`.${r}`) || domainCore(h) === domainCore(r));
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** An http(s) URL with its fragment and tracking dropped, or null if it isn't one. */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    // An address rather than a name, or a port that isn't the web's, is nothing a creator publishes.
    if (isIpLiteral(u.hostname)) return null;
    if (u.port && u.port !== "80" && u.port !== "443") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igshid)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

export function isLinkHub(url: string): boolean {
  const h = hostOf(url);
  return !!h && LINK_HUBS.test(h);
}

/** True when the URL looks like the creator's own site rather than another platform's page. */
export function isOwnSite(url: string): boolean {
  const h = hostOf(url);
  return !!h && !NOT_A_SITE.test(h) && !LINK_HUBS.test(h);
}

const DECODE: Array<[RegExp, string]> = [
  // Pages embed their data as JSON, where < > & / arrive escaped; without this a hit came back as
  // "u003ehelp@skool.com" on 2026-10-15.
  [/\\u003c/gi, "<"],
  [/\\u003e/gi, ">"],
  [/\\u0026/gi, "&"],
  [/\\u002f/gi, "/"],
  [/\\"/g, '"'],
  [/&amp;/g, "&"],
  [/&#64;|&#x40;/gi, "@"],
  [/&#46;|&#x2e;/gi, "."],
  [/\s*\(\s*at\s*\)\s*|\s*\[\s*at\s*\]\s*/gi, "@"],
  [/\s*\(\s*dot\s*\)\s*|\s*\[\s*dot\s*\]\s*/gi, "."],
];

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

/** Every address on a page, best first: a mailto they put there, then one written next to business
 *  wording, then anything else. Plugin and platform addresses are dropped. */
export function emailsFromHtml(html: string, pageUrl: string): FoundEmail[] {
  let text = html;
  for (const [from, to] of DECODE) text = text.replace(from, to);
  const out: FoundEmail[] = [];
  const seen = new Set<string>();
  const add = (raw: string, how: FoundEmail["how"]) => {
    const email = raw.trim().toLowerCase().replace(/^[.:;,<([-]+|[.:;,>)\]-]+$/g, "");
    if (!isPlausibleEmail(email) || NOT_THEIRS.test(email) || seen.has(email)) return;
    seen.add(email);
    out.push({ email, foundAt: pageUrl, how });
  };
  for (const m of text.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>]+)/gi)) add(m[1]!, "mailto");
  // Wording in the same element as the address says whether it was offered for business. The window
  // stops at the element's edges: without that, "Business inquiries:" on the next line labelled the
  // line above it.
  for (const m of text.matchAll(EMAIL_IN_TEXT)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 140), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 40);
    const sameElement = `${before.slice(before.lastIndexOf(">") + 1)} ${after.split("<")[0] ?? ""}`;
    add(m[0], BUSINESS_WORDS.test(sameElement) ? "labelled" : "text");
  }
  const rank = { mailto: 0, labelled: 1, text: 2 };
  return out.sort((a, b) => rank[a.how] - rank[b.how]);
}

/** Outbound links on a link hub, in page order: their real site comes before their socials. */
export function linksFromHtml(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const here = hostOf(pageUrl);
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    const url = normalizeUrl(m[0].replace(/&amp;/g, "&"));
    if (!url) continue;
    const h = hostOf(url);
    if (!h || h === here || seen.has(h)) continue;
    seen.add(h);
    out.push(url);
  }
  return out;
}

/** The pages worth asking for on one site, the contact page first once we know the root works. */
export function contactUrlsFor(siteUrl: string): string[] {
  const u = normalizeUrl(siteUrl);
  if (!u) return [];
  const root = new URL(u);
  const base = `${root.protocol}//${root.host}`;
  const onPath = root.pathname !== "/" && root.pathname !== "" ? [u] : [];
  return [...new Set([...onPath, ...CONTACT_PATHS.map((p) => `${base}${p}`)])];
}

/** A reply, cut down to what the finder reads off it. */
export interface HttpReply {
  status: number;
  /** Where the request ended up (we never auto-follow, so this is the URL asked for). */
  url: string;
  header(name: string): string | null;
  body(): Promise<string>;
}

export type HttpGet = (url: string, timeoutMs: number) => Promise<HttpReply | null>;

/** Node's own request, with a lookup hook that decides the address the socket connects to. This is
 *  stronger than checking DNS first and fetching after: there is no window in between for the name
 *  to be re-resolved to 127.0.0.1 (DNS rebinding), because this answer IS the one that is used. */
const pinnedGet: HttpGet = async (url, timeoutMs) => {
  const { request: httpsRequest } = await import("node:https");
  const { request: httpRequest } = await import("node:http");
  const { lookup: dnsLookup } = await import("node:dns");
  const u = new URL(url);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node's LookupFunction overloads
  const lookup: any = (hostname: string, options: any, callback: any) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const bad = list.find((a) => isBlockedIp(a.address));
      if (bad || list.length === 0) return callback(new Error(`blocked address for ${hostname}`), "", 0);
      if (options?.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
  return new Promise<HttpReply | null>((resolve) => {
    // One way out, however the request ends. Cutting a page off at MAX_BYTES destroys the response,
    // which never emits "end", so settling only there hung the whole run (2026-10-15).
    let settled = false;
    const settle = (reply: HttpReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(reply);
    };
    const req = request(
      url,
      { method: "GET", headers: { "user-agent": UA, accept: "text/html,*/*" }, lookup, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          settle({
            status: res.statusCode ?? 0,
            url,
            header: (name) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
            body: async () => Buffer.concat(chunks).toString("utf8"),
          });
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BYTES) chunks.push(c);
          else res.destroy(); // enough read: whatever is here is answered below
        });
        res.on("end", done);
        res.on("close", done); // destroyed by the cap, or cut off by the server
        res.on("aborted", () => settle(null));
        res.on("error", () => settle(null));
      },
    );
    // A server that connects and then says nothing would otherwise sit here: the socket timeout
    // only covers inactivity, so the whole request gets its own deadline.
    const deadline = setTimeout(() => {
      req.destroy();
      settle(null);
    }, timeoutMs + 2_000);
    req.on("timeout", () => req.destroy());
    req.on("error", () => settle(null)); // unreachable, blocked address, bad certificate
    req.end();
  });
};

/** A fetch-like function, as the tests inject, read through the same small surface. */
function fromFetch(fetchImpl: typeof fetch): HttpGet {
  return async (url, timeoutMs) => {
    const res = await fetchImpl(url, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: res.status,
      url: res.url || url,
      header: (name) => res.headers.get(name),
      body: () => res.text(),
    };
  };
}

interface Page {
  html: string;
  /** Where the request ended up: a bit.ly in a bio lands on the brand's store. */
  url: string;
}

/** One page, if it may be fetched. Redirects are followed by hand so each hop is checked too: a
 *  public URL that redirects to 127.0.0.1 is the usual way around a check done only on the first. */
async function getPage(url: string, get: HttpGet, resolve: ResolveHost): Promise<Page | null> {
  let next: string | null = url;
  try {
    for (let hop = 0; next && hop <= MAX_REDIRECTS; hop++) {
      if (!(await isFetchable(next, resolve))) return null;
      const here: string = next;
      const res = await get(here, TIMEOUT_MS);
      if (!res) return null;
      if (res.status >= 300 && res.status < 400) {
        const location = res.header("location");
        next = location ? normalizeUrl(new URL(location, here).toString()) : null;
        continue;
      }
      if (res.status < 200 || res.status >= 300) return null;
      if (!/text\/html|text\/plain|application\/xhtml/i.test(res.header("content-type") ?? "")) return null;
      const body = await res.body();
      return { html: body.slice(0, MAX_BYTES), url: normalizeUrl(res.url) ?? here };
    }
    return null;
  } catch {
    return null; // unreachable, too slow, bad certificate: not an error worth a row
  }
}

export interface FindResult {
  found: FoundEmail | null;
  /** Pages actually fetched, for the run summary. */
  pages: number;
  /** The creator's own site, when a link hub led us to one: worth saving either way. */
  site?: string;
  /** Why nothing was kept, when the reason is worth counting: the link was a brand's store or a
   *  deal site, or the only addresses on it belong to somebody else. */
  skipped?: "affiliate_link" | "not_their_domain" | "rejected_domain";
}

/** Looks for a business address behind one URL: their site's contact pages, or, for a link hub,
 *  the first real site it points at. Stops at the first address worth having. */
export async function findBusinessEmail(url: string, deps: FindDeps): Promise<FindResult> {
  const start = normalizeUrl(url);
  const maxPages = deps.maxPages ?? 6;
  const rejects = deps.rejectDomains ?? [];
  const resolve = deps.resolveHost ?? resolveWithDns;
  const get = deps.fetchImpl ? fromFetch(deps.fetchImpl) : pinnedGet;
  const tokens = deps.creatorTokens ?? [];
  let pages = 0;
  if (!start) return { found: null, pages };
  // A referral or coupon link is the brand's shop. Reading an address there gives us the brand's
  // support inbox, which is how a creator lead would end up pointing at a competitor's help desk.
  if (AFFILIATE_LINK.test(start)) return { found: null, pages, skipped: "affiliate_link" };
  if (hostOf(start) && rejected(hostOf(start)!, rejects)) return { found: null, pages, skipped: "rejected_domain" };

  /** An address is only this creator's when its own domain looks like theirs. Without a name to
   *  compare against, the domain of the site they linked has to be theirs to begin with. */
  const theirs = (e: FoundEmail, siteHost: string | null): boolean => {
    const domain = e.email.split("@")[1] ?? "";
    if (!domain || rejected(domain, rejects)) return false;
    if (tokens.length === 0) return !!siteHost && domainCore(domain) === domainCore(siteHost);
    return domainLooksLikeCreator(domain, tokens);
  };

  let skipped: FindResult["skipped"];
  const trySite = async (siteUrl: string): Promise<FoundEmail | null> => {
    for (const candidate of contactUrlsFor(siteUrl)) {
      if (pages >= maxPages) return null;
      pages++;
      const page = await getPage(candidate, get, resolve);
      if (!page) continue;
      const host = hostOf(page.url);
      // A shortener or a redirect can land us somewhere that isn't theirs after all.
      if (host && rejected(host, rejects)) {
        skipped = "rejected_domain";
        return null;
      }
      if (AFFILIATE_LINK.test(page.url)) {
        skipped = "affiliate_link";
        return null;
      }
      const all = emailsFromHtml(page.html, page.url);
      const mine = all.filter((e) => theirs(e, host));
      if (all.length > 0 && mine.length === 0) skipped = "not_their_domain";
      const hit = mine.find((e) => e.how !== "text") ?? mine[0] ?? null;
      if (hit) return hit;
    }
    return null;
  };

  if (isLinkHub(start)) {
    pages++;
    const hub = await getPage(start, get, resolve);
    if (!hub) return { found: null, pages };
    // A hub sometimes prints the address itself; otherwise follow the first site that is theirs.
    const onHub = emailsFromHtml(hub.html, start).filter((e) => theirs(e, null)).find((e) => e.how !== "text");
    if (onHub) return { found: onHub, pages };
    const site = linksFromHtml(hub.html, start).find(
      (l) => isOwnSite(l) && !AFFILIATE_LINK.test(l) && !rejected(hostOf(l) ?? "", rejects) && (tokens.length === 0 || domainLooksLikeCreator(hostOf(l) ?? "", tokens)),
    );
    if (!site) return { found: null, pages, skipped: "not_their_domain" };
    const found = await trySite(site);
    return { found, pages, site, ...(found ? {} : skipped ? { skipped } : {}) };
  }

  if (!isOwnSite(start)) return { found: null, pages };
  const found = await trySite(start);
  return { found, pages, site: start, ...(found ? {} : skipped ? { skipped } : {}) };
}
