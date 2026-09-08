import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LeadDetail, type LeadsPage, type Me } from "../api.js";
import { PageInfo, Pagination } from "../components.js";
import { BAND_HELP, BAND_LABEL, ENRICH_LABEL, MESSAGE_STATE_LABEL, describeRun, subProfileLabel } from "../labels.js";

const VIEWS: Array<[string, string]> = [
  ["queue", "Queue"],
  ["all", "All"],
  ["triage", "Needs triage"],
];

const SORTS: Array<[string, string]> = [
  ["rank", "Rank"],
  ["name", "Name"],
  ["platform", "Platform"],
  ["reach", "Reach"],
  ["status", "Status"],
  ["sp", "Sub-profile"],
  ["lastTouch", "Last touch"],
];

export function Leads({ me }: { me: Me }) {
  const [view, setView] = useState("queue");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("rank");
  const [dir, setDir] = useState<"asc" | "desc" | "">("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [sp, setSp] = useState("");
  const [data, setData] = useState<LeadsPage | null>(null);
  const [filters, setFilters] = useState<{ statuses: string[]; platforms: string[]; subProfiles: string[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rankMsg, setRankMsg] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams({ view, page: String(page), pageSize: "50", sort });
    if (dir) p.set("dir", dir);
    if (search) p.set("search", search);
    if (status) p.set("status", status);
    if (platform) p.set("platform", platform);
    if (sp) p.set("sp", sp);
    return p;
  }, [view, page, sort, dir, search, status, platform, sp]);

  const load = useCallback(async () => {
    try {
      setData(await api.leadsPage(params));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api.leadFilters().then(setFilters).catch(() => {});
  }, []);
  useEffect(() => {
    if (open == null) return setDetail(null);
    void api.lead(open).then(setDetail).catch((err) => setError((err as Error).message));
  }, [open]);

  // Reset to page 1 when filters/sort change.
  useEffect(() => setPage(1), [view, sort, dir, search, status, platform, sp]);

  const clickSort = (col: string) => {
    if (sort === col) setDir((d) => (d === "desc" ? "asc" : d === "asc" ? "" : "desc"));
    else {
      setSort(col);
      setDir("desc");
    }
  };

  const canRun = me.role === "admin" || me.role === "ops";
  const a = data?.analytics;

  return (
    <>
      <PageInfo title="Leads — the recruiting pipeline">
        Every creator/brand we might recruit as an affiliate, ranked by conversion likelihood. The{" "}
        <strong>queue</strong> view is who to contact next (SP5, dead, and already-signed leads are excluded
        automatically). Click a row for the full history and personalization notes. Use the analytics row to see how
        many are contacted, in talks, or signed.
      </PageInfo>

      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Leads</h1>
        <div className="grow" />
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? "primary" : ""} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
        {canRun && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setRankMsg("");
              void api
                .runJob("rank-recompute")
                .then((r) => {
                  setRankMsg(describeRun("rank-recompute", r.result));
                  return load();
                })
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Ranking…" : "Recompute ranks"}
          </button>
        )}
        {canRun && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setRankMsg("");
              void api
                .runJob("enrich-personalize")
                .then((r) => {
                  setRankMsg(describeRun("enrich-personalize", r.result));
                  return load();
                })
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Working…" : "Research next batch"}
          </button>
        )}
      </div>
      {rankMsg && <div className="notice">Done: {rankMsg}</div>}

      {a && (
        <div className="analytics">
          <div className="stat"><div className="n">{a.total.toLocaleString()}</div><div className="l">Total</div></div>
          <div className="stat"><div className="n">{a.notContacted.toLocaleString()}</div><div className="l">Not contacted</div></div>
          <div className="stat"><div className="n">{a.contacted.toLocaleString()}</div><div className="l">Contacted</div></div>
          <div className="stat"><div className="n">{a.inTalks.toLocaleString()}</div><div className="l">In talks</div></div>
          <div className="stat"><div className="n">{a.signed.toLocaleString()}</div><div className="l">Signed</div></div>
          <div className="stat"><div className="n">{a.personalized.toLocaleString()}</div><div className="l">Has talking points</div></div>
          <div className="stat"><div className="n">{a.verifiedReach.toLocaleString()}</div><div className="l">Verified reach</div></div>
          <div className="stat"><div className="n">{a.dead.toLocaleString()}</div><div className="l">Unreachable</div></div>
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Search name, email, platform, niche…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All statuses</option>
          {filters?.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All platforms</option>
          {filters?.platforms.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={sp} onChange={(e) => setSp(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All sub-profiles</option>
          {filters?.subProfiles.map((s) => <option key={s} value={s}>{s.slice(0, 24)}</option>)}
        </select>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {SORTS.map(([col, label]) => (
                <th
                  key={col}
                  className={`sortable ${sort === col ? "active" : ""}`}
                  onClick={() => clickSort(col)}
                >
                  {label}
                  {sort === col ? (dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "") : ""}
                </th>
              ))}
              <th>Notes</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((l) => (
              <tr
                key={l.id}
                className={open === l.id ? "selected" : ""}
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(open === l.id ? null : l.id)}
              >
                <td>
                  {l.rank ?? "—"}
                  {l.band && (
                    <span className="muted" style={{ fontSize: 11 }} title={BAND_HELP[l.band]}>
                      {" "}
                      {BAND_LABEL[l.band] ?? l.band}
                    </span>
                  )}
                </td>
                <td>
                  {l.name} {l.needsTriage && <span className="chip suggest">needs triage</span>}
                  {l.isDead && <span className="chip failed">unreachable</span>}
                </td>
                <td className="muted">{l.platform ?? "—"}</td>
                <td>{l.reach != null ? l.reach.toLocaleString() : <span className="muted">unverified</span>}</td>
                <td className="muted">{l.status ?? "—"}</td>
                <td>
                  {(() => {
                    const sp = subProfileLabel(l.subProfile);
                    return sp.danger ? (
                      <span className="chip failed" title={sp.help}>{sp.text}</span>
                    ) : (
                      <span className="muted" title={sp.help}>{sp.text}</span>
                    );
                  })()}
                </td>
                <td className="muted">{l.lastReachedOut?.slice(0, 10) ?? "never"}</td>
                <td>
                  {(() => {
                    const key = l.hasNotes ? "enriched" : (l.enrichmentStatus ?? "pending");
                    const e = ENRICH_LABEL[key] ?? ENRICH_LABEL.pending!;
                    return (
                      <span className={`chip ${e.tone === "ok" ? "ok" : e.tone === "bad" ? "failed" : "unresolved"}`} title={e.help}>
                        {e.text}
                      </span>
                    );
                  })()}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {l.profileUrl && /^https?:\/\//i.test(l.profileUrl) ? (
                    <a href={l.profileUrl} target="_blank" rel="noreferrer" title={l.profileUrl}>
                      ↗ open
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={setPage} />

      {detail && (
        <>
          <h2>
            Lead #{detail.lead.id} — {String(detail.lead.firstName ?? "")} {String(detail.lead.lastName ?? "")}
          </h2>
          <div className="cards">
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <div className="k">Personalization notes</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{detail.lead.personalizationNotes ?? "(none yet — this lead has not been researched)"}</div>
            </div>
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <div className="k">Notes</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{detail.lead.notes ?? "—"}</div>
            </div>
            {detail.enrichments.length > 0 && (
              <div className="card" style={{ gridColumn: "1 / -1" }}>
                <div className="k">Research history</div>
                {detail.enrichments.map((e) => (
                  <div key={e.id} className="muted" style={{ fontSize: 12.5 }}>
                    {new Date(e.createdAt).toLocaleDateString()} · {e.platform} · {ENRICH_LABEL[e.status]?.text ?? e.status}
                    {e.sourceUrl && /^https?:\/\//.test(e.sourceUrl) && (
                      <>
                        {" · "}
                        <a href={e.sourceUrl} target="_blank" rel="noreferrer">
                          source
                        </a>
                      </>
                    )}
                    {e.error && <> · {e.error}</>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <h2>Message history ({detail.messages.length})</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Channel</th><th>State</th><th>Body</th><th>Sent</th></tr>
              </thead>
              <tbody>
                {detail.messages.length === 0 && (
                  <tr><td colSpan={4} className="muted">no messages yet</td></tr>
                )}
                {detail.messages.map((m) => (
                  <tr key={m.id}>
                    <td>{m.channel}</td>
                    <td>
                      <span className={`chip ${m.state === "blocked" ? "failed" : m.state === "sent" || m.state === "logged" ? "ok" : "unresolved"}`}>{MESSAGE_STATE_LABEL[m.state] ?? m.state}</span>
                    </td>
                    <td style={{ whiteSpace: "pre-wrap", maxWidth: 480 }}>{m.body ?? ""}</td>
                    <td className="muted">{m.sentAt ? new Date(m.sentAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
