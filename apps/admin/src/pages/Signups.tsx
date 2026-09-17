import { useCallback, useEffect, useState } from "react";
import { Empty, PageHeader, PageInfo } from "../components.js";
import { api, type Me, type SignupRow } from "../api.js";
import { SAGA_LABEL } from "../labels.js";

export function Signups({ me }: { me: Me }) {
  const [rows, setRows] = useState<SignupRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.signups());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canAct = me.role === "admin" || me.role === "ops";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageInfo title="Signups — people who said yes">Each signup is checked (required fields, not already an affiliate, recruiter name matches a real account), then waits for Diana to confirm the 21+ and quality gate before the iDev account and coupon are created. The "Where it is" column shows the exact step.</PageInfo>
      <PageHeader title="Signups" />
      {error && <div className="error">{error}</div>}
      {rows.length === 0 && <Empty emoji="✍️">No sign-ups yet. They appear here the moment someone sends their four details.</Empty>}
      {rows.length > 0 && (
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Recruited by</th>
              <th>Where it is</th>
              <th>Status</th>
              {canAct && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.firstName} {s.lastName}
                </td>
                <td className="muted">{s.email}</td>
                <td className="muted">{s.recruitedByName ?? "—"}</td>
                <td>
                  {(() => {
                    const l = SAGA_LABEL[s.sagaState] ?? { text: s.sagaState, tone: "warn" as const };
                    return (
                      <span className={`chip ${l.tone === "bad" ? "failed" : l.tone === "ok" ? "ok" : "unresolved"}`} title={s.sagaState}>
                        {l.text}
                      </span>
                    );
                  })()}
                </td>
                <td>
                  <span className={`chip ${s.status === "confirmed" ? "ok" : "unresolved"}`}>{s.status === "confirmed" ? "Confirmed" : s.status === "pending_diana" ? "Pending Diana" : s.status}</span>
                </td>
                {canAct && (
                  <td>
                    <button disabled={busy} onClick={() => void act(() => api.provisionSignup(s.id))}>
                      Check &amp; prepare
                    </button>{" "}
                    <button
                      className="primary"
                      disabled={busy || s.status === "confirmed"}
                      onClick={() => void act(() => api.confirmSignup(s.id))}
                    >
                      Confirm
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}
