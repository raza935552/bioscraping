import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type ReplyRow } from "../api.js";

const CLASS_CHIP: Record<string, string> = {
  interested: "ok",
  signed_up: "ok",
  not_now: "unresolved",
  question: "unresolved",
  no_with_reason: "failed",
  opt_out: "failed",
  unclassifiable: "suggest",
};

export function Replies() {
  const [rows, setRows] = useState<ReplyRow[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await api.replies());
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

  return (
    <>
      <PageInfo title="Replies — every inbound, classified">Every reply from a prospect, auto-classified (interested, opt-out, question, etc). Opt-outs are suppressed instantly. Questions about money route to Diana, agencies to Jakob, product/dosing to support. Anything the classifier is unsure about is flagged for a human.</PageInfo>
      <h1>Replies</h1>
      {error && <div className="error">{error}</div>}
      {rows.length === 0 && (
        <p className="muted">No replies yet. Instantly posts inbound replies to /webhooks/instantly; social replies come in via the operator flow.</p>
      )}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Channel</th>
              <th>Reply</th>
              <th>Classified</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.leadName}</td>
                <td className="muted">{r.channel}</td>
                <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{r.body}</td>
                <td>
                  <span className={`chip ${CLASS_CHIP[r.classifiedAs ?? ""] ?? "unresolved"}`}>
                    {r.classifiedAs ?? "—"}
                  </span>
                </td>
                <td className="muted">{new Date(r.receivedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
