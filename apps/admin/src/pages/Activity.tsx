import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type ActivityLog } from "../api.js";
import { describeRun, jobLabel } from "../labels.js";

export function Activity() {
  const [data, setData] = useState<ActivityLog | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.activity());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  return (
    <>
      <PageInfo title="Activity & logs — everything the system did">Every scheduled job run (with status and timing) and every human action (the audit trail). If you want to know what happened and when, it is here. Failed runs show in red.</PageInfo>
      <h1>Activity &amp; logs</h1>

      <h2>Job runs</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Job</th>
              <th>Status</th>
              <th>Detail</th>
              <th>Started</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td title={r.job}>{jobLabel(r.job)}</td>
                <td>
                  <span className={`chip ${r.status === "ok" ? "ok" : r.status === "failed" ? "failed" : "unresolved"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="muted" style={{ maxWidth: 380 }}>
                  {describeRun(r.job, r.detail)}
                </td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="muted">
                  {r.finishedAt
                    ? `${Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Audit trail</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Detail</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data.audit.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.actor}</td>
                <td>{a.action}</td>
                <td className="muted">{a.subject ?? "—"}</td>
                <td className="muted" style={{ maxWidth: 320 }}>
                  {a.detail ? JSON.stringify(a.detail) : ""}
                </td>
                <td className="muted">{new Date(a.at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
