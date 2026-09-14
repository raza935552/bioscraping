import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LeadDetail, type LeadRow, type LeadsPage, type Me, type SamplePost } from "../api.js";
import { PageInfo, Pagination } from "../components.js";
import { BAND_HELP, BAND_LABEL, BRAND_LABEL, ENRICH_LABEL, MESSAGE_STATE_LABEL, NICHE_BRAND, describeRun, subProfileLabel } from "../labels.js";

const VIEWS: Array<[string, string]> = [
  ["queue", "Queue"],
  ["sourced", "Sourced"],
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

const NICHES = Object.keys(NICHE_BRAND);
const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

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
  const [reviewing, setReviewing] = useState<LeadRow | null>(null);
  const [confirmReject, setConfirmReject] = useState<number | null>(null);

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

  const reject = async (l: LeadRow, reason = "") => {
    if (confirmReject !== l.id && !reason) {
      setConfirmReject(l.id);
      return;
    }
    setConfirmReject(null);
    try {
      await api.reviewLead(l.id, { decision: "reject", reason });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
        {me.role === "admin" && (
          <button
            disabled={busy}
            title="Mirror every lead that has an email into Customer.io"
            onClick={() => {
              setBusy(true);
              setRankMsg("");
              void api
                .runJob("customerio-sync")
                .then((r) => setRankMsg(describeRun("customerio-sync", r.result)))
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            Sync Customer.io
          </button>
        )}
      </div>
      {rankMsg && <div className="notice">Done: {rankMsg}</div>}
      {reviewing && (
        <ReviewForm
          lead={reviewing}
          onClose={() => setReviewing(null)}
          onDone={async () => {
            setReviewing(null);
            await load();
          }}
        />
      )}

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
          <div className="stat"><div className="n">{a.sourcedPending.toLocaleString()}</div><div className="l">Waiting for review</div></div>
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

      {view === "sourced" ? (
        <SourcedTable
          rows={data?.rows ?? []}
          canRun={canRun}
          open={open}
          onOpen={(id) => setOpen(open === id ? null : id)}
          onAccept={setReviewing}
          onReject={(l, reason) => void reject(l, reason)}
          confirmReject={confirmReject}
        />
      ) : (
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
      )}

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
              <div className="k">{detail.lead.sourcingReview ? "Why this score" : "Notes"}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{detail.lead.notes ?? "—"}</div>
            </div>
            {Array.isArray(detail.lead.sourcingSample) && (detail.lead.sourcingSample as SamplePost[]).length > 0 && (
              <div className="card" style={{ gridColumn: "1 / -1" }}>
                <div className="k">Recent posts</div>
                {(detail.lead.sourcingSample as SamplePost[]).map((p, i) => (
                  <div key={i} className="sample">
                    <span className="muted">{p.postedAt?.slice(0, 10) ?? "—"}</span>{" "}
                    {isHttp(p.url) ? (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.text || "(no text)"}
                      </a>
                    ) : (
                      p.text || "(no text)"
                    )}
                    {(p.likes != null || p.views != null || p.comments != null) && (
                      <span className="muted">
                        {" · "}
                        {[p.likes != null ? `${p.likes.toLocaleString()} likes` : null, p.views != null ? `${p.views.toLocaleString()} views` : null, p.comments != null ? `${p.comments.toLocaleString()} comments` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
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


interface SourcedTableProps {
  rows: LeadRow[];
  canRun: boolean;
  open: number | null;
  onOpen: (id: number) => void;
  onAccept: (l: LeadRow) => void;
  onReject: (l: LeadRow, reason?: string) => void;
  confirmReject: number | null;
}

function SourcedTable({ rows, canRun, open, onOpen, onAccept, onReject, confirmReject }: SourcedTableProps) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Score</th>
            <th>Who</th>
            <th>Platform</th>
            <th>Verified reach</th>
            <th>Last post</th>
            <th>Links</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nothing waiting for review. Run an audience from the Audiences page to find new people.
              </td>
            </tr>
          )}
          {rows.map((l) => (
            <tr key={l.id} className={open === l.id ? "selected" : ""} style={{ cursor: "pointer" }} onClick={() => onOpen(l.id)}>
              <td>
                <strong>{l.sourcingScore ?? 0}</strong>
                <div className="muted" style={{ fontSize: 11 }}>{l.scoreReasons.length} reasons</div>
              </td>
              <td>
                {l.name}
                {l.competitor && (
                  <>
                    {" "}
                    <span className="chip suggest" title={l.affiliateCode ? `code ${l.affiliateCode}` : "competitor link seen"}>
                      promotes {l.competitor}
                    </span>
                  </>
                )}
                <div className="muted" style={{ fontSize: 11 }}>
                  {l.sourcingReason} · {BRAND_LABEL[l.brandFit ?? ""] ?? l.brandFit ?? ""}
                </div>
              </td>
              <td className="muted">{l.platform ?? "—"}</td>
              <td>{l.reach != null ? l.reach.toLocaleString() : <span className="muted">unverified</span>}</td>
              <td className="muted">{l.lastPostAt?.slice(0, 10) ?? "—"}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {isHttp(l.sample[0]?.url) && (
                  <a href={l.sample[0]!.url} target="_blank" rel="noreferrer">
                    post ↗
                  </a>
                )}{" "}
                {isHttp(l.profileUrl) && (
                  <a href={l.profileUrl} target="_blank" rel="noreferrer">
                    profile ↗
                  </a>
                )}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                {canRun && (
                  <>
                    <button className="primary" onClick={() => onAccept(l)}>
                      Accept…
                    </button>{" "}
                    <button onClick={() => onReject(l)}>{confirmReject === l.id ? "Click again to reject" : "Reject"}</button>{" "}
                    <button onClick={() => onReject(l, "goodwill advocate")} title="SP5: never contacted, by rule">
                      Goodwill advocate
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewForm({ lead, onClose, onDone }: { lead: LeadRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [affiliation, setAffiliation] = useState(lead.competitor ? "Signed elsewhere" : "Unsigned");
  const [sp, setSp] = useState("SP2");
  const [niche, setNiche] = useState(lead.niche && NICHES.includes(lead.niche) ? lead.niche : NICHES[0] ?? "");
  const [brandFit, setBrandFit] = useState(lead.brandFit ?? NICHE_BRAND[niche] ?? "biolinx");
  const [doesLive, setDoesLive] = useState(false);
  const [promo, setPromo] = useState(false);
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.reviewLead(lead.id, {
        decision: "accept",
        affiliationStatus: affiliation,
        subProfile: sp,
        niche,
        brandFit,
        ...(doesLive ? { doesLive: true } : {}),
        ...(promo ? { promoTrackRecord: true } : {}),
        ...(original ? { contentOriginal: true } : {}),
      });
      await onDone();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-card" onSubmit={submit}>
      <div className="settings-head">
        <h2>Accept {lead.name}</h2>
        <p className="muted">
          Once accepted the lead is ranked and researched like any other. Boxes you leave unchecked stay “unknown”, not “no”.
        </p>
      </div>
      <div className="review-form">
        <label className="settings-field">
          <span className="fl">Affiliation</span>
          <select value={affiliation} onChange={(e) => setAffiliation(e.target.value)}>
            <option>Unsigned</option>
            <option>Signed elsewhere</option>
          </select>
          {lead.competitor && <span className="fh">Seen promoting {lead.competitor}.</span>}
        </label>
        <label className="settings-field">
          <span className="fl">Sub-profile</span>
          <select value={sp} onChange={(e) => setSp(e.target.value)}>
            {["SP1", "SP2", "SP3", "SP4"].map((code) => (
              <option key={code} value={code}>
                {code} · {subProfileLabel(code).text}
              </option>
            ))}
          </select>
          <span className="fh">Goodwill advocates are rejected, not accepted as SP5.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Niche</span>
          <select
            value={niche}
            onChange={(e) => {
              setNiche(e.target.value);
              setBrandFit(NICHE_BRAND[e.target.value] ?? "biolinx");
            }}
          >
            {NICHES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span className="fl">Brand</span>
          <select value={brandFit} onChange={(e) => setBrandFit(e.target.value)}>
            {Object.entries(BRAND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field bool">
          <span className="fl">Runs LIVE</span>
          <input type="checkbox" checked={doesLive} onChange={(e) => setDoesLive(e.target.checked)} />
        </label>
        <label className="settings-field bool">
          <span className="fl">Has run promos</span>
          <input type="checkbox" checked={promo} onChange={(e) => setPromo(e.target.checked)} />
        </label>
        <label className="settings-field bool">
          <span className="fl">Original content</span>
          <input type="checkbox" checked={original} onChange={(e) => setOriginal(e.target.checked)} />
        </label>
      </div>
      <div className="settings-foot">
        {err && (
          <span className="error" style={{ marginRight: "auto" }}>
            {err}
          </span>
        )}
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Accept lead"}
        </button>
      </div>
    </form>
  );
}
