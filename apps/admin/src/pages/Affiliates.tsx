import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Affiliate, type Me } from "../api.js";
import { PageInfo } from "../components.js";

const SUGGESTION_LABEL: Record<string, string> = {
  team: "team member?",
  house: "house account?",
  test: "test account?",
};

export function Affiliates({ me }: { me: Me }) {
  const [rows, setRows] = useState<Affiliate[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.affiliates());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.classification === filter)),
    [rows, filter],
  );

  const canEdit = me.role === "admin" || me.role === "ops";

  const classify = async (ids: number[], classification: string) => {
    setBusy(true);
    try {
      await api.classify(ids, classification);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const suggestedIds = useMemo(
    () => visible.filter((r) => r.suggestion === "team" || r.suggestion === "house").map((r) => r.id),
    [visible],
  );

  return (
    <>
      <PageInfo title="Affiliates — the live iDev roster">
        Every approved affiliate pulled from iDev, synced every 30 minutes. Classify each as external (a real
        recruit, counts toward the 100 goal) or internal (team/house account, excluded from the count). The engine
        suggests likely team/house/test accounts. The external count you see on the Dashboard comes straight from
        these classifications.
      </PageInfo>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Affiliates</h1>
        <div className="grow" />
        {(["all", "unresolved", "external", "internal"] as const).map((f) => (
          <button key={f} className={filter === f ? "primary" : ""} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {canEdit && (
        <div className="toolbar">
          <span className="muted">{selected.size} selected</span>
          <button disabled={busy || selected.size === 0} onClick={() => void classify([...selected], "external")}>
            Mark external
          </button>
          <button disabled={busy || selected.size === 0} onClick={() => void classify([...selected], "internal")}>
            Mark internal
          </button>
          <div className="grow" />
          {suggestedIds.length > 0 && (
            <button disabled={busy} onClick={() => setSelected(new Set(suggestedIds))}>
              Select {suggestedIds.length} suggested internal
            </button>
          )}
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {canEdit && <th />}
              <th>iDev</th>
              <th>Name</th>
              <th>Username</th>
              <th>Email</th>
              <th>Signed up</th>
              <th>Class</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id} className={selected.has(a.id) ? "selected" : ""}>
                {canEdit && (
                  <td>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                  </td>
                )}
                <td>{a.idevId}</td>
                <td>
                  {[a.firstName, a.lastName].filter(Boolean).join(" ") || "—"}{" "}
                  {a.suggestion && <span className="chip suggest">{SUGGESTION_LABEL[a.suggestion]}</span>}
                </td>
                <td className="muted">{a.username ?? "—"}</td>
                <td className="muted">{a.email ?? "—"}</td>
                <td className="muted">{a.signedUpAt ? new Date(a.signedUpAt).toISOString().slice(0, 10) : "—"}</td>
                <td>
                  <span className={`chip ${a.classification}`}>{a.classification}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
