import { useCallback, useEffect, useState } from "react";
import { api, type Dashboard as Data, type Me } from "../api.js";
import { PageInfo } from "../components.js";
import { describeRun, jobLabel } from "../labels.js";

function ageMinutes(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

export function Dashboard({ me }: { me: Me }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
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

  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const syncAge = ageMinutes(data.lastSyncedAt);
  // iDev may report more approved accounts than the API can read (a record
  // whose data breaks its JSON encoder). Show both so the gap isn't a mystery.
  const lastOkSync = data.syncRuns.find((r) => r.job === "idev-sync" && r.status === "ok");
  const reported = typeof lastOkSync?.detail?.approved === "number" ? (lastOkSync.detail.approved as number) : null;
  const unreadable = reported != null ? reported - data.approvedTotal : 0;
  const canSync = me.role === "admin" || me.role === "ops";

  return (
    <>
      <PageInfo title="Dashboard — the whole operation at a glance">
        Live progress toward 100 real partners by Black Friday, plus the recruiting funnel (leads → contacted →
        replies → signups) and the email pipeline across every phase. The "Last iDev sync" card turns red past 45
        minutes so stale data is always visible. Use "Sync iDev now" to pull the affiliate roster on demand.
      </PageInfo>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <div className="grow" />
        {canSync && (
          <button
            className="primary"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              void api
                .runSync()
                .then(load)
                .catch((e) => setError((e as Error).message))
                .finally(() => setSyncing(false));
            }}
          >
            {syncing ? "Syncing…" : "Sync iDev now"}
          </button>
        )}
      </div>

      <div className="cards">
        <div className="card">
          <div className="k">Real partners</div>
          <div className="v">
            {data.counts.external}
            <span className="muted" style={{ fontSize: 15 }}> / {data.goal}</span>
          </div>
          <div className="sub">
            {data.counts.unresolved > 0
              ? `could be up to ${data.counts.external + data.counts.unresolved}: ${data.counts.unresolved} account${data.counts.unresolved === 1 ? "" : "s"} still need a decision`
              : "every account has been decided"}
          </div>
        </div>
        <div className="card">
          <div className="k">Days to Black Friday</div>
          <div className="v">{data.daysToBlackFriday}</div>
          <div className="sub">{data.blackFriday}</div>
        </div>
        <div className="card">
          <div className="k">Approved in iDev</div>
          <div className="v">
            {data.approvedTotal}
            {unreadable > 0 && <span className="muted" style={{ fontSize: 15 }}> of {reported}</span>}
          </div>
          <div className="sub">
            {data.counts.internal} team/house · {data.counts.unresolved} need a decision
            {unreadable > 0 && ` · ${unreadable} unreadable via API`}
          </div>
        </div>
        <div className="card">
          <div className="k">Last iDev sync</div>
          <div className="v" style={{ fontSize: 18 }}>
            {syncAge == null ? (
              <span className="stale">never</span>
            ) : syncAge > 45 ? (
              <span className="stale">{syncAge} min ago</span>
            ) : (
              `${syncAge} min ago`
            )}
          </div>
          <div className="sub">turns red after 45 minutes</div>
        </div>
      </div>

      <h2>Recruiting funnel</h2>
      <div className="cards">
        {(
          [
            ["Leads", data.funnel.leadsTotal, "in the database"],
            ["In queue", data.funnel.inQueue, "eligible for outreach"],
            ["Has talking points", data.funnel.withPersonalization, "ready to draft"],
            ["Do not contact", data.funnel.sp5Protected, "goodwill advocates, by rule"],
            ["Contacted", data.funnel.contacted, "at least one send"],
            ["Replies", data.funnel.replies, `${data.funnel.interested} interested`],
            ["Signups", data.funnel.signups, `${data.funnel.signupsPending} pending Diana`],
            ["Verified reach", data.funnel.verifiedReach, "real audience numbers on file"],
          ] as const
        ).map(([k, v, sub]) => (
          <div className="card" key={k}>
            <div className="k">{k}</div>
            <div className="v">{v.toLocaleString()}</div>
            <div className="sub">{sub}</div>
          </div>
        ))}
      </div>

      <h2>Email pipeline</h2>
      <div className="cards">
        <div className="card">
          <div className="k">Emails drafted</div>
          <div className="v">{data.email.dispatched}</div>
          <div className="sub">{data.email.sent} sent · {data.email.queued} awaiting approval</div>
        </div>
        <div className="card">
          <div className="k">Stopped by compliance</div>
          <div className="v">{data.email.blocked}</div>
          <div className="sub">drafts that failed the wording check</div>
        </div>
        <div className="card">
          <div className="k">Opted out</div>
          <div className="v">{data.email.suppressions}</div>
          <div className="sub">never emailed again</div>
        </div>
        <div className="card">
          <div className="k">Referral bonus ended</div>
          <div className="v">{data.expiredOverrides}</div>
          <div className="sub">past 12 months, for Diana's report</div>
        </div>
      </div>

      <h2>Recent job runs</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Job</th>
              <th>Status</th>
              <th>Detail</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {data.syncRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td title={r.job}>{jobLabel(r.job)}</td>
                <td>
                  <span className={`chip ${r.status === "ok" ? "ok" : r.status === "failed" ? "failed" : "unresolved"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="muted">{describeRun(r.job, r.detail)}</td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
