// Instantly.ai API v2 client (https://api.instantly.ai/api/v2, Bearer auth).
// The cold-email arm of D5: Instantly owns sending, warmup, and unsubscribe
// mechanics; the engine owns WHO gets contacted and WHAT the message says
// (drafted + L-rules-linted before any lead is pushed).
//
// D2 discipline is enforced upstream: a lead reaches pushLead() only after
// its message passed the linter and (until the client signs off on
// unattended email) a human approved the batch.

export interface InstantlyConfig {
  apiKey: string;
  baseUrl?: string;
}

const BASE = "https://api.instantly.ai/api/v2";

export function instantlyFromEnv(env = process.env): InstantlyConfig {
  const apiKey = env.COLD_EMAIL_API_KEY ?? "";
  if (!apiKey) throw new Error("COLD_EMAIL_API_KEY missing (Instantly API key)");
  return { apiKey };
}

async function request<T>(
  config: InstantlyConfig,
  method: string,
  pathname: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body != null ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  };
  if (body != null) init.body = JSON.stringify(body);
  const res = await fetchImpl(`${config.baseUrl ?? BASE}${pathname}`, init);
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // fall through with raw text in the error below
  }
  if (!res.ok) {
    const message = (parsed as { message?: string }).message ?? text.slice(0, 200);
    throw new Error(`Instantly ${method} ${pathname}: HTTP ${res.status} — ${message}`);
  }
  return parsed as T;
}

export interface InstantlyAccount {
  email: string;
  status: number;
  warmup_status?: number;
}

/** Sending inboxes on the workspace (read-only; used for health checks). */
export async function listAccounts(
  config: InstantlyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstantlyAccount[]> {
  const body = await request<{ items?: InstantlyAccount[] }>(config, "GET", "/accounts?limit=100", undefined, fetchImpl);
  return body.items ?? [];
}

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: number;
}

export async function listCampaigns(
  config: InstantlyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstantlyCampaign[]> {
  const body = await request<{ items?: InstantlyCampaign[] }>(
    config,
    "GET",
    "/campaigns?limit=100",
    undefined,
    fetchImpl,
  );
  return body.items ?? [];
}

/**
 * Push one approved lead + its linted, personalized message into a campaign.
 * The message travels as custom variables so the campaign template is just
 * {{personalized_body}} — content is authored and linted on OUR side, never
 * improvised inside Instantly.
 */
export async function pushLead(
  config: InstantlyConfig,
  params: {
    campaignId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    subject: string;
    body: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id?: string }> {
  return request(
    config,
    "POST",
    "/leads",
    {
      campaign: params.campaignId,
      email: params.email,
      first_name: params.firstName ?? undefined,
      last_name: params.lastName ?? undefined,
      custom_variables: {
        personalized_subject: params.subject,
        personalized_body: params.body,
      },
    },
    fetchImpl,
  );
}

/**
 * Create the affiliate-recruiting campaign as a SHELL: one email step whose
 * subject/body are the custom variables our engine fills per lead. This keeps
 * message authoring + compliance linting on OUR side — Instantly only sends
 * the {{personalized_*}} content we push, never a template of its own.
 */
export async function createRecruitingCampaign(
  config: InstantlyConfig,
  opts: { name?: string; timezone?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const body = {
    name: opts.name ?? "Affiliate Recruiting (engine-driven)",
    // Instantly auto-injects the CAN-SPAM footer (unsubscribe link + the
    // workspace's physical address) — same mechanism the account's existing
    // BX/PP campaigns use, so recruiting emails carry the same entity address.
    insert_unsubscribe_header: true,
    campaign_schedule: {
      schedules: [
        {
          name: "Business hours",
          timing: { from: "09:00", to: "17:00" },
          days: { "1": true, "2": true, "3": true, "4": true, "5": true },
          // Instantly send-schedule tz must be from its enum; the account's
          // other campaigns use America/Detroit (Eastern).
          timezone: opts.timezone ?? "America/Detroit",
        },
      ],
    },
    sequences: [
      {
        steps: [
          {
            type: "email",
            delay: 3,
            delay_unit: "days",
            variants: [
              {
                // Filled per-lead from custom_variables at push time.
                subject: "{{personalized_subject}}",
                body: "{{personalized_body}}",
              },
            ],
          },
        ],
      },
    ],
  };
  return request<{ id: string }>(config, "POST", "/campaigns", body, fetchImpl);
}

export async function getCampaign(
  config: InstantlyConfig,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstantlyCampaign & { sequences?: unknown }> {
  return request(config, "GET", `/campaigns/${id}`, undefined, fetchImpl);
}

/** Move a campaign to active (status 1) so pushed leads actually send. */
export async function activateCampaign(
  config: InstantlyConfig,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request(config, "POST", `/campaigns/${id}/activate`, {}, fetchImpl);
}

/** Add an address to Instantly's block list (mirrors our suppressions). */
export async function suppress(
  config: InstantlyConfig,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request(config, "POST", "/block-lists-entries", { bl_value: email.trim().toLowerCase() }, fetchImpl);
}
