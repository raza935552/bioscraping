import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type EmailActivity, type EmailCampaigns } from "../api.js";

const CAMPAIGN_STATUS: Record<number, string> = { 0: "draft", 1: "active", 2: "paused", 3: "completed", 4: "running" };

// Group Instantly campaigns by their [n] BRAND EMOJI AUDIENCE naming.
function brandOf(name: string): string {
  const m = name.match(/\]\s*([A-Z]{2,3})\b/);
  return m ? m[1]! : "Other";
}

export function Email() {
  const [camp, setCamp] = useState<EmailCampaigns | null>(null);
  const [act, setAct] = useState<EmailActivity | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.emailCampaigns(), api.emailActivity()]);
      setCamp(c);
      setAct(a);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const [busy, setBusy] = useState("");
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!camp || !act) return null;

  const byBrand = camp.campaigns.reduce<Record<string, typeof camp.campaigns>>((acc, c) => {
    const b = brandOf(c.name);
    (acc[b] ??= []).push(c);
    return acc;
  }, {});

  return (
    <>
      <PageInfo title="Email operations — the Instantly fleet + our activity">The live cold-email infrastructure: how many sending inboxes are warmed, every campaign grouped by brand (BX = BiolinX, PP = Professor Peptides), and what our recruiting engine has dispatched. This is where you see what is actually going out over email.</PageInfo>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Email operations</h1>
        <div className="grow" />
        <button disabled={!!busy} onClick={() => void run("prep", () => api.dispatch("email", 20))}>
          {busy === "prep" ? "Drafting…" : "Prepare email drafts (→ Approvals)"}
        </button>
      </div>

      <div className="cards">
        <div className="card">
          <div className="k">Sending inboxes</div>
          <div className="v">{camp.accounts}</div>
          <div className="sub">{camp.warmedAccounts ?? 0} warmed · Instantly fleet</div>
        </div>
        <div className="card">
          <div className="k">Campaigns</div>
          <div className="v">{camp.campaigns.length}</div>
          <div className="sub">{Object.keys(byBrand).join(" · ")}</div>
        </div>
        <div className="card">
          <div className="k">Our emails dispatched</div>
          <div className="v">{act.email.total}</div>
          <div className="sub">
            {Object.entries(act.email.byState)
              .map(([s, n]) => `${n} ${s}`)
              .join(" · ") || "none yet"}
          </div>
        </div>
        <div className="card">
          <div className="k">Replies · Suppressions</div>
          <div className="v">
            {act.replies} <span className="muted" style={{ fontSize: 16 }}>· {act.suppressions}</span>
          </div>
          <div className="sub">inbound replies · opt-outs honored</div>
        </div>
      </div>

      {!camp.configured && (
        <p className="muted">Instantly not configured (COLD_EMAIL_API_KEY). Campaign data hidden.</p>
      )}
      {camp.error && <div className="error">Instantly: {camp.error}</div>}

      <h2>Instantly campaigns by brand</h2>
      {Object.entries(byBrand).map(([brand, list]) => (
        <div key={brand} style={{ marginBottom: 14 }}>
          <div className="muted" style={{ margin: "8px 0 4px", fontWeight: 600 }}>
            {brand} — {list.length} campaigns
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      <span className={`chip ${c.status === 1 || c.status === 4 ? "ok" : "unresolved"}`}>
                        {CAMPAIGN_STATUS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="muted">{c.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <h2>Recent dispatch activity (ours)</h2>
      <div className="tablewrap scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Lead</th>
              <th>Channel</th>
              <th>State</th>
              <th>Subject</th>
              <th>Sent</th>
            </tr>
          </thead>
          <tbody>
            {act.recent.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No messages dispatched yet — run outreach-dispatch (needs the recruiting campaign wired).
                </td>
              </tr>
            )}
            {act.recent.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td>#{m.leadId}</td>
                <td>{m.channel}</td>
                <td>
                  <span className={`chip ${m.state === "blocked" ? "failed" : m.state === "sent" ? "ok" : "unresolved"}`}>
                    {m.state}
                  </span>
                </td>
                <td className="muted">{m.subject ?? "—"}</td>
                <td className="muted">{m.sentAt ? new Date(m.sentAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
