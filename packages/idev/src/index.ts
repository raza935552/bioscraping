// iDevAffiliate client — the store's proven live recipe (IdevAffiliateService
// in the production codebase, confirmed working 2026-09-01):
//
//   Step 1: POST {url}/API/rest-api/authenticate.php  body: api_secret=<SITE_KEY>
//           → { token: "<bearer JWT issued by iDev>" }
//   Step 2: GET  {url}/API/rest-api/getAffiliate.php?affiliate_type=…
//           header: Authorization: Bearer <token>
//           → success when the call returns rows in data.aaData
//
// TWO different secrets for TWO different iDev API systems — do not mix:
//   REST API  (/API/rest-api/…)  → api_secret = IDEVAFFILIATE_SITE_KEY
//   Legacy    (/API/scripts/…)   → secret     = IDEVAFFILIATE_API_SECRET
//
// Tokens are cacheable (~10 min); on a rejection we drop the cache and
// re-authenticate once before failing.

export interface IdevConfig {
  url: string; // e.g. https://biolinxlabs.idevaffiliate.com
  siteKey: string; // REST API api_secret (IDEVAFFILIATE_SITE_KEY)
  apiSecret: string; // legacy /API/scripts secret (IDEVAFFILIATE_API_SECRET)
}

export interface IdevAffiliate {
  id: number;
  email: string | null;
  username: string | null;
  f_name: string | null;
  l_name: string | null;
  /** MM/DD/YYYY as returned by iDev. */
  signup_date?: string | null;
}

export function idevConfigFromEnv(env = process.env): IdevConfig {
  const url = env.IDEVAFFILIATE_URL ?? "https://biolinxlabs.idevaffiliate.com";
  const siteKey = env.IDEVAFFILIATE_SITE_KEY ?? "";
  const apiSecret = env.IDEVAFFILIATE_API_SECRET ?? "";
  if (!siteKey) {
    throw new Error("iDevAffiliate is not configured (IDEVAFFILIATE_SITE_KEY missing)");
  }
  return { url, siteKey, apiSecret };
}

/** Redact secrets before anything reaches a log line. */
export function redactUrl(url: string): string {
  return url.replace(/(secret|key|token)=[^&]+/gi, "$1=REDACTED");
}

const TOKEN_TTL_MS = 9 * 60 * 1000; // iDev tokens last ~10 min; refresh at 9

interface CachedToken {
  token: string;
  fetchedAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export async function authenticate(
  config: IdevConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cached = tokenCache.get(config.url);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;

  const res = await fetchImpl(`${config.url}/API/rest-api/authenticate.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_secret: config.siteKey }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`iDev authenticate: HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string; message?: string };
  if (!body.token) {
    throw new Error(`iDev authenticate rejected: ${body.message ?? "no token in response"}`);
  }
  tokenCache.set(config.url, { token: body.token, fetchedAt: Date.now() });
  return body.token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

/** iDev returned an empty/non-JSON body — page too large or a poisoned row. */
export class EmptyBodyError extends Error {}

interface GetAffiliatePage {
  message?: string;
  bool?: unknown;
  data?: { iTotalRecords?: number; aaData?: IdevAffiliate[] };
}

async function fetchPage(
  config: IdevConfig,
  type: string,
  start: number,
  length: number,
  fetchImpl: typeof fetch,
): Promise<GetAffiliatePage> {
  const call = async (): Promise<{ res: Response; body: GetAffiliatePage }> => {
    const token = await authenticate(config, fetchImpl);
    const qs = new URLSearchParams({
      affiliate_type: type,
      iDisplayLength: String(length),
      iDisplayStart: String(start),
    });
    const res = await fetchImpl(`${config.url}/API/rest-api/getAffiliate.php?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    let body: GetAffiliatePage;
    try {
      body = JSON.parse(raw) as GetAffiliatePage;
    } catch {
      // iDev returns an EMPTY body for (a) oversized iDisplayLength and
      // (b) specific records whose data breaks its JSON encoder ("poisoned"
      // rows — observed live 2026-09-01 at roster position 16). Callers
      // bisect around these; this is never "zero affiliates".
      throw new EmptyBodyError(
        `iDev getAffiliate ${type}: empty/unparseable response (status ${res.status}, ${raw.length} bytes, start=${start}, length=${length})`,
      );
    }
    return { res, body };
  };

  let { res, body } = await call();
  const rejected = !res.ok || res.status === 401 || /unauthorized/i.test(body.message ?? "");
  if (rejected) {
    // Stale token — drop cache, re-authenticate once, retry.
    tokenCache.delete(config.url);
    ({ res, body } = await call());
  }
  if (!res.ok) throw new Error(`iDev getAffiliate ${type}: HTTP ${res.status}`);
  if (/unauthorized/i.test(body.message ?? "")) {
    throw new Error(`iDev getAffiliate ${type} rejected: ${body.message}`);
  }
  return body;
}

export interface RosterResult {
  affiliates: IdevAffiliate[];
  /** iTotalRecords as reported by iDev (includes poisoned rows). */
  total: number;
  /** Roster positions whose record data breaks iDev's JSON encoder — the
   *  record exists and is approved, but cannot be read via the API. */
  poisonedPositions: number[];
}

/**
 * Fetch the complete roster for a type. iDev quirks handled here:
 * - EMPTY body above ~16 rows per page → fixed page size 15 (the store's
 *   reference value).
 * - EMPTY body for specific poisoned records → bisect down to size 1, record
 *   the position, skip it, continue. Poisoned rows are surfaced, never
 *   silently dropped (they still count toward the approved total).
 */
export async function getRoster(
  config: IdevConfig,
  type: "approved" | "pending" | "declined" = "approved",
  fetchImpl: typeof fetch = fetch,
): Promise<RosterResult> {
  const PAGE = 15;
  const affiliates: IdevAffiliate[] = [];
  const poisonedPositions: number[] = [];
  let total = Number.POSITIVE_INFINITY;
  let start = 0;
  let length = PAGE;

  while (start < total) {
    try {
      const page = await fetchPage(config, type, start, length, fetchImpl);
      const rows = page.data?.aaData ?? [];
      if (page.data?.iTotalRecords != null) total = page.data.iTotalRecords;
      if (rows.length === 0) break; // genuine end of data
      affiliates.push(...rows);
      start += rows.length;
      length = PAGE;
    } catch (err) {
      if (!(err instanceof EmptyBodyError)) throw err;
      if (length > 1) {
        length = Math.max(1, Math.floor(length / 2)); // bisect toward the bad row
      } else {
        poisonedPositions.push(start); // single unreadable record — skip it
        start += 1;
        length = PAGE;
      }
    }
  }
  if (!Number.isFinite(total)) total = affiliates.length + poisonedPositions.length;
  return { affiliates, total, poisonedPositions };
}

/** Back-compat convenience: roster rows only. */
export async function getAffiliates(
  config: IdevConfig,
  type: "approved" | "pending" | "declined" = "approved",
  fetchImpl: typeof fetch = fetch,
): Promise<IdevAffiliate[]> {
  return (await getRoster(config, type, fetchImpl)).affiliates;
}

/** Parse iDev's MM/DD/YYYY signup_date to a Date (UTC midnight), or null. */
export function parseSignupDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
}

/**
 * Legacy scripts API (/API/scripts/…) — uses IDEVAFFILIATE_API_SECRET.
 * PROBE-GATED (plan §2.1): parameter semantics (commission_value vs the 25%
 * payout level) silently change real pay. Refuses to run until probed.
 */
export async function assignCouponCode(
  config: IdevConfig,
  params: {
    couponCode: string;
    affiliateId: number;
    commissionType: 1 | 2 | 3; // 1=% 2=flat 3=use payout level
    commissionValue?: number;
    notifyAffiliate: boolean;
  },
  opts: { probeConfirmed: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!opts.probeConfirmed) {
    throw new Error("assignCouponCode blocked: iDev parameter semantics not yet probe-confirmed (Phase 0)");
  }
  if (!config.apiSecret) throw new Error("IDEVAFFILIATE_API_SECRET missing (legacy scripts API)");
  const qs = new URLSearchParams({
    secret: config.apiSecret,
    coupon_code: params.couponCode,
    affiliate_id: String(params.affiliateId),
    commission_type: String(params.commissionType),
    notify_affiliate: params.notifyAffiliate ? "1" : "0",
  });
  if (params.commissionValue != null) qs.set("commission_value", String(params.commissionValue));
  const url = `${config.url}/API/scripts/assign_coupon_code.php?${qs}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`iDev assign_coupon_code: HTTP ${res.status} (${redactUrl(url)})`);
}
