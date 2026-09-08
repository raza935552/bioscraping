import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Affiliate, type Me } from "../api.js";
import { CLASS_HELP, CLASS_LABEL, ClassChip, PageInfo } from "../components.js";

const SUGGESTION_LABEL: Record<string, string> = {
  team: "looks like a team member",
  house: "looks like a house account",
  test: "looks like a test account",
};

const FILTERS: Array<[string, string]> = [
  ["all", "All"],
  ["unresolved", CLASS_LABEL.unresolved],
  ["external", "Real partners"],
  ["internal", "Team & house"],
];

export function Affiliates({ me }: { me: Me }) {
  const [rows, setRows] = useState<Affiliate[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
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

  const visible = useMemo(() => {
    const byClass = filter === "all" ? rows : rows.filter((r) => r.classification === filter);
    const q = search.trim().toLowerCase();
    if (!q) return byClass;
    return byClass.filter((r) =>
      [r.firstName, r.lastName, r.username, r.email, String(r.idevId)]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    );
  }, [rows, filter, search]);

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
      <PageInfo title="Affiliates — everyone approved in iDev">
        Every approved affiliate account, pulled from iDev every 30 minutes. Your job here is one question per
        account: does this person count toward the 100 goal? The engine flags accounts that look like one of us.
        The Dashboard's partner count comes straight from these answers.
        <ul className="legend">
          {(Object.keys(CLASS_LABEL) as Array<keyof typeof CLASS_LABEL>).map((k) => (
            <li key={k}>
              <ClassChip value={k} /> {CLASS_HELP[k]}
            </li>
          ))}
        </ul>
      </PageInfo>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Affiliates</h1>
        <input
          placeholder="Search name, username, email, iDev id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <div className="grow" />
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? "primary" : ""} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {canEdit && (
        <div className="toolbar">
          <span className="muted">{selected.size} selected</span>
          <button disabled={busy || selected.size === 0} onClick={() => void classify([...selected], "external")}>
            Counts toward goal
          </button>
          <button disabled={busy || selected.size === 0} onClick={() => void classify([...selected], "internal")}>
            Team or house account
          </button>
          <div className="grow" />
          {suggestedIds.length > 0 && (
            <button disabled={busy} onClick={() => setSelected(new Set(suggestedIds))}>
              Select {suggestedIds.length} that look like us
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
              <th>Counts?</th>
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
                  <ClassChip value={a.classification} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
