import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type Me, type SignupRow } from "../api.js";

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
      <PageInfo title="Signups — the provisioning saga">Prospects who said yes. Each one runs through validation, dedupe, and attribution checks, then holds for Diana to confirm (the 21+ and quality gate) before the iDev affiliate account and coupon are created. Saga state shows exactly where each one is.</PageInfo>
      <h1>Signups</h1>
      {error && <div className="error">{error}</div>}
      {rows.length === 0 && <p className="muted">No signups yet.</p>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Recruited by</th>
              <th>Saga state</th>
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
                  <span
                    className={`chip ${
                      s.sagaState.includes("error") || s.sagaState === "duplicate" || s.sagaState === "invalid"
                        ? "failed"
                        : s.sagaState.includes("pending")
                          ? "unresolved"
                          : "ok"
                    }`}
                  >
                    {s.sagaState}
                  </span>
                </td>
                <td>
                  <span className={`chip ${s.status === "confirmed" ? "ok" : "unresolved"}`}>{s.status}</span>
                </td>
                {canAct && (
                  <td>
                    <button disabled={busy} onClick={() => void act(() => api.provisionSignup(s.id))}>
                      Provision
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
    </>
  );
}
