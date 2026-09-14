// Customer.io Track API client. One call: identify a person by email.
// Credentials travel only in the Authorization header; errors carry the
// status, never the key or the payload (it is PII).

export interface CustomerioConfig {
  siteId: string;
  apiKey: string;
  region: "us" | "eu";
}

export function customerioFromEnv(env: NodeJS.ProcessEnv = process.env): CustomerioConfig | null {
  const siteId = env.CUSTOMERIO_SITE_ID ?? "";
  const apiKey = env.CUSTOMERIO_TRACK_API_KEY ?? "";
  if (!siteId || !apiKey) return null;
  return { siteId, apiKey, region: env.CUSTOMERIO_REGION === "eu" ? "eu" : "us" };
}

export type CustomerioAttributes = Record<string, string | number | boolean | null>;

export interface CustomerioClient {
  identify(email: string, attributes: CustomerioAttributes): Promise<void>;
}

export function customerioClient(cfg: CustomerioConfig, fetchImpl: typeof fetch = fetch): CustomerioClient {
  const base = cfg.region === "eu" ? "https://track-eu.customer.io" : "https://track.customer.io";
  const auth = `Basic ${Buffer.from(`${cfg.siteId}:${cfg.apiKey}`).toString("base64")}`;
  return {
    async identify(email, attributes) {
      const id = email.trim().toLowerCase();
      const res = await fetchImpl(`${base}/api/v1/customers/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ email: id, ...attributes }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Customer.io identify: HTTP ${res.status}`);
    },
  };
}
