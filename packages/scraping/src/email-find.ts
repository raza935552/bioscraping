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

function isBlockedIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 169) return b === 254;
    if (a === 172) return b >= 16 && b <= 31;
    if (a === 192) return b === 168 || b === 0;
    if (a === 100) return b >= 64 && b <= 127;
    return BLOCKED_V4.some(([lo, hi]) => a >= lo && a <= hi && a !== 169 && a !== 172 && a !== 192 && a !== 100);
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::" || v6 === "::1") return true;
  // IPv4-mapped (::ffff:127.0.0.1) is the same address by another name.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mapped) return isBlockedIp(mapped[1]!);
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
  fetchImpl: typeof fetch;
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

interface Page {
  html: string;
  /** Where the request ended up: a bit.ly in a bio lands on the brand's store. */
  url: string;
}

/** One page, if it may be fetched. Redirects are followed by hand so each hop is checked too: a
 *  public URL that redirects to 127.0.0.1 is the usual way around a check done only on the first. */
async function getPage(url: string, fetchImpl: typeof fetch, resolve: ResolveHost): Promise<Page | null> {
  let next: string | null = url;
  try {
    for (let hop = 0; next && hop <= MAX_REDIRECTS; hop++) {
      if (!(await isFetchable(next, resolve))) return null;
      const here: string = next;
      const res = await fetchImpl(here, {
        headers: { "user-agent": UA, accept: "text/html,*/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        next = location ? normalizeUrl(new URL(location, here).toString()) : null;
        continue;
      }
      if (!res.ok) return null;
      if (!/text\/html|text\/plain|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return null;
      const body = await res.text();
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
      const page = await getPage(candidate, deps.fetchImpl, resolve);
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
    const hub = await getPage(start, deps.fetchImpl, resolve);
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
