import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type LeadDetail, type LeadRow, type LeadsPage, type Me, type SamplePost, type SourcedFacets } from "../api.js";
import { Modal, PageInfo, Pagination } from "../components.js";
import { BAND_HELP, BAND_LABEL, BRAND_LABEL, ENRICH_LABEL, MESSAGE_STATE_LABEL, NICHE_BRAND, describeRun, subProfileLabel } from "../labels.js";

const VIEWS: Array<[string, string]> = [
  ["queue", "Queue"],
  ["sourced", "Sourced"],
  ["all", "All"],
  ["triage", "Needs triage"],
];

const SORTS: Array<[string, string, string?]> = [
  ["rank", "Rank"],
  ["name", "Name"],
  ["niche", "Niche"],
  ["platform", "Platform"],
  ["reach", "Reach"],
  ["avgViews", "Avg views", "Average views across recent posts, from the latest profile read"],
  ["engagement", "Engagement", "(likes + comments) ÷ views over recent posts, or per follower when posts have no views"],
  ["posts30", "Posts 30d", "Posts in the last 30 days, out of the posts read"],
  ["competitor", "Competitor"],
  ["status", "Status"],
  ["sp", "Sub-profile"],
  ["lastTouch", "Last touch"],
];

const NICHES = Object.keys(NICHE_BRAND);
const SOURCED_SORTS = new Set(["score", "name", "niche", "platform", "reach", "avgViews", "engagement", "posts30", "lastPost", "competitor"]);
const SOURCED_ONLY_SORTS = new Set(["score", "lastPost"]);
const compact = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

export function Leads({ me }: { me: Me }) {
  const [view, setView] = useState("queue");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    try {
      return localStorage.getItem("leads.pageSize") ?? "100";
    } catch {
      return "100";
    }
  });
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
  // Sourced view filters
  const [review, setReview] = useState("pending");
  const [niche, setNiche] = useState("");
  const [competitor, setCompetitor] = useState("");
  const [store, setStore] = useState("");
  const [active, setActive] = useState("");
  const [minReach, setMinReach] = useState("");
  const [minScore, setMinScore] = useState("");
  const [minEngagement, setMinEngagement] = useState("");
  const [country, setCountry] = useState("");
  const [audience, setAudience] = useState("");
  const [competitorName, setCompetitorName] = useState("");
  const sourcedFilters = { review, niche, competitor, store, active, minReach, minScore, minEngagement, country, audience, competitorName };
  const clearSourcedFilters = () => {
    setNiche(""); setCompetitor(""); setStore(""); setActive(""); setMinReach(""); setMinScore(""); setMinEngagement(""); setCountry(""); setAudience(""); setCompetitorName("");
  };

  const params = useMemo(() => {
    const p = new URLSearchParams({ view, page: String(page), pageSize, sort });
    if (dir) p.set("dir", dir);
    if (search) p.set("search", search);
    if (status) p.set("status", status);
    if (platform) p.set("platform", platform);
    if (sp) p.set("sp", sp);
    for (const [k, v] of Object.entries(sourcedFilters)) {
      if (!v) continue;
      if (view !== "sourced" && (k === "review" || k === "audience" || k === "minScore")) continue;
      p.set(k, v);
    }
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, page, sort, dir, search, status, platform, sp, review, niche, competitor, store, active, minReach, minScore, minEngagement, country, audience, competitorName, pageSize]);

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
  useEffect(() => setPage(1), [pageSize, view, sort, dir, search, status, platform, sp, review, niche, competitor, store, active, minReach, minScore, minEngagement, country, audience, competitorName]);
  // The Sourced view ranks by score; the other views by conversion rank.
  useEffect(() => {
    if (view === "sourced" && !SOURCED_SORTS.has(sort)) { setSort("score"); setDir(""); }
    if (view !== "sourced" && SOURCED_ONLY_SORTS.has(sort)) { setSort("rank"); setDir(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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
        <Modal title={`Accept ${reviewing.name}`} onClose={() => setReviewing(null)} wide={false}>
          <ReviewForm
            lead={reviewing}
            onClose={() => setReviewing(null)}
            onDone={async () => {
              setReviewing(null);
              await load();
            }}
          />
        </Modal>
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
        {view !== "sourced" && (
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All statuses</option>
          {filters?.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        )}
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All platforms</option>
          {filters?.platforms.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {view !== "sourced" && (
        <select value={sp} onChange={(e) => setSp(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All sub-profiles</option>
          {filters?.subProfiles.map((s) => <option key={s} value={s}>{s.slice(0, 24)}</option>)}
        </select>
        )}
        {view === "sourced" && canRun && (
          <>
            <div className="grow" />
            <a className="btn-link" href={`/api/leads/sourced.csv?review=${encodeURIComponent(review)}`} download title="Spreadsheet of the leads in this review status, with the marketing spec's fields">
              Download for marketing (CSV)
            </a>
            <a className="btn-link" href="/api/leads/sourced.csv?review=all" download title="Every sourced lead, including accepted and rejected, with reject reasons">
              All sourced (CSV)
            </a>
          </>
        )}
      </div>

      <SourcedFilterBar
        sourced={view === "sourced"}
        facets={data?.facets ?? null}
        values={sourcedFilters}
        set={{ setReview, setNiche, setCompetitor, setStore, setActive, setMinReach, setMinScore, setMinEngagement, setCountry, setAudience, setCompetitorName }}
        onClear={clearSourcedFilters}
        shown={data?.analytics.total ?? 0}
      />

      {error && <div className="error">{error}</div>}

      {view === "sourced" ? (
        <SourcedTable
          rows={data?.rows ?? []}
          sort={sort}
          dir={dir}
          onSort={clickSort}
          canRun={canRun && review === "pending"}
          open={open}
          onOpen={(id) => setOpen(open === id ? null : id)}
          onAccept={(l) => {
            setOpen(null);
            setReviewing(l);
          }}
          onReject={(l, reason) => void reject(l, reason)}
          confirmReject={confirmReject}
        />
      ) : (
      <div className="tablewrap">
        <table className="sourced">
          <thead>
            <tr>
              {SORTS.map(([col, label, help]) => (
                <th
                  key={col}
                  className={`sortable ${sort === col ? "active" : ""}`}
                  onClick={() => clickSort(col)}
                  title={help}
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
                <td className="creator">
                  <div>
                    {l.name}
                    {l.details?.handle && <span className="muted"> @{l.details.handle}</span>}{" "}
                    {l.needsTriage && <span className="chip suggest">needs triage</span>}
                    {l.isDead && <span className="chip failed">unreachable</span>}
                    {l.details?.isStore && <span className="chip failed" title="Handle or bio looks like a shop, not a creator">store</span>}
                  </div>
                  {l.details?.bio && <div className="bio" title={l.details.bio}>{l.details.bio}</div>}
                </td>
                <td>
                  {l.details?.niche ?? l.niche ?? "—"}
                  {l.brandFit && <div className="muted" style={{ fontSize: 11 }}>{BRAND_LABEL[l.brandFit] ?? l.brandFit}</div>}
                </td>
                <td className="muted">
                  {l.platform ?? "—"}
                  {l.country && <div style={{ fontSize: 11 }}>{l.country}</div>}
                </td>
                <td>{l.reach != null ? l.reach.toLocaleString() : <span className="muted">unverified</span>}</td>
                <td>{l.details?.avgViews != null ? compact(l.details.avgViews) : <span className="muted">—</span>}</td>
                <td title={l.details?.engagementBasis === "followers" ? "per follower (posts have no view count)" : "per view"}>
                  {l.details?.engagementRate != null ? `${(l.details.engagementRate * 100).toFixed(1)}%` : <span className="muted">—</span>}
                  {l.details?.engagementBasis === "followers" && <span className="muted" style={{ fontSize: 11 }}> /fol.</span>}
                </td>
                <td>
                  {l.details?.postsLast30 != null ? <>{l.details.postsLast30}<span className="muted" style={{ fontSize: 11 }}> /{l.details.postsRead}</span></> : <span className="muted">—</span>}
                </td>
                <td>
                  {l.competitor ? <span className="chip suggest">{l.competitor}</span> : <span className="muted">—</span>}
                  {(l.affiliateCode || l.currentOffer) && (
                    <div className="muted" style={{ fontSize: 11 }} title="Their code or offer with that competitor">
                      {l.affiliateCode ? <code>{l.affiliateCode}</code> : l.currentOffer}
                    </div>
                  )}
                </td>
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

      <div className="toolbar" style={{ marginTop: 12 }}>
        <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} onPage={setPage} />
        <div className="grow" />
        <label className="muted" style={{ fontSize: 12 }}>
          Rows per page{" "}
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(e.target.value);
              try {
                localStorage.setItem("leads.pageSize", e.target.value);
              } catch {
                /* private window: just don't remember it */
              }
            }}
          >
            {["25", "50", "100", "200"].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {detail && (() => {
        const row = data?.rows.find((r) => r.id === detail.lead.id) ?? null;
        const d = row?.details ?? null;
        const pendingSourced = row?.sourcingReview === "pending" && canRun;
        const cell = (k: string, v: React.ReactNode, sub?: React.ReactNode) => (
          <div className="cell"><div className="k">{k}</div><div className="v">{v}</div>{sub && <div className="s">{sub}</div>}</div>
        );
        return (
        <Modal
          onClose={() => setOpen(null)}
          title={<>{row?.name ?? `${String(detail.lead.firstName ?? "")} ${String(detail.lead.lastName ?? "")}`}{d?.handle && <span className="muted" style={{ fontWeight: 400 }}> @{d.handle}</span>}</>}
          subtitle={
            <>
              Lead #{detail.lead.id} · {row?.platform ?? "—"} · {d?.niche ?? row?.niche ?? "no niche"}
              {row?.brandFit ? ` · ${BRAND_LABEL[row.brandFit] ?? row.brandFit}` : ""}
              {d?.term ? ` · found via ${d.term}` : ""}
            </>
          }
        >
          {row && (
            <>
              <div className="modal-actions">
                {isHttp(row.profileUrl) && <a className="btn-link" href={row.profileUrl} target="_blank" rel="noreferrer">Open profile ↗</a>}
                {d?.surfaced && isHttp(d.surfaced.url) && <a className="btn-link" href={d.surfaced.url} target="_blank" rel="noreferrer">Post that found them ↗</a>}
                {row.sourcingScore != null && <span className="chip internal">score {row.sourcingScore}</span>}
                {row.competitor && <span className="chip suggest">promotes {row.competitor}{row.affiliateCode ? ` · code ${row.affiliateCode}` : ""}</span>}
                {d?.isStore && <span className="chip failed">store / business</span>}
                {row.country ? <span className={`chip ${row.country === "US" ? "ok" : "failed"}`}>{row.country === "US" ? "US ✓" : row.country}</span> : <span className="chip unresolved" title="No platform or bio evidence of where they are">location unknown</span>}
                {row.rejectedReason && <span className="chip failed">rejected: {row.rejectedReason}</span>}
                <div className="grow" />
                {pendingSourced && (
                  <>
                    <button className="primary" onClick={() => { setOpen(null); setReviewing(row); }}>Accept…</button>
                    <button
                      onClick={() => {
                        const confirming = confirmReject === row.id;
                        void reject(row).then(() => {
                          if (confirming) setOpen(null);
                        });
                      }}
                    >
                      {confirmReject === row.id ? "Click again to reject" : "Reject"}
                    </button>
                  </>
                )}
              </div>
              {d?.bio && <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 14px" }}>{d.bio}</p>}
              <div className="stat-grid">
                {cell("Reach", row.reach != null ? row.reach.toLocaleString() : "unverified")}
                {cell("Avg views", d?.avgViews != null ? compact(d.avgViews) : "—", "recent posts")}
                {cell("Engagement", d?.engagementRate != null ? `${(d.engagementRate * 100).toFixed(1)}%` : "—", d?.engagementBasis === "followers" ? "per follower" : d?.engagementBasis === "views" ? "per view" : "not reported")}
                {cell("Posts in 30 days", d?.postsLast30 != null ? `${d.postsLast30} / ${d.postsRead}` : "—")}
                {cell("Last post", row.lastPostAt?.slice(0, 10) ?? "—", d?.daysSinceLastPost != null ? `${d.daysSinceLastPost} days ago` : undefined)}
                {cell("Surfaced post", d?.surfaced?.views != null ? `${compact(d.surfaced.views)} views` : "—", d?.surfaced ? `${compact(d.surfaced.likes)} likes · ${compact(d.surfaced.comments)} comments` : undefined)}
                {cell("Competitor", row.competitor ?? "—", row.affiliateCode ? `code ${row.affiliateCode}` : row.currentOffer ?? undefined)}
                {cell("Status", row.status ?? "—", row.subProfile ? subProfileLabel(row.subProfile).text : undefined)}
              </div>
            </>
          )}
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
          <h3>Message history ({detail.messages.length})</h3>
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
        </Modal>
        );
      })()}
    </>
  );
}


interface SourcedFilterValues {
  review: string; niche: string; competitor: string; store: string; active: string;
  minReach: string; minScore: string; minEngagement: string; country: string; audience: string; competitorName: string;
}
interface SourcedFilterSetters {
  setReview: (v: string) => void; setNiche: (v: string) => void; setCompetitor: (v: string) => void; setStore: (v: string) => void;
  setActive: (v: string) => void; setMinReach: (v: string) => void; setMinScore: (v: string) => void; setMinEngagement: (v: string) => void;
  setCountry: (v: string) => void; setAudience: (v: string) => void; setCompetitorName: (v: string) => void;
}

function SourcedFilterBar({ sourced, facets, values: v, set, onClear, shown }: { sourced: boolean; facets: SourcedFacets | null; values: SourcedFilterValues; set: SourcedFilterSetters; onClear: () => void; shown: number }) {
  const any = [v.niche, v.competitor, v.store, v.active, v.minReach, v.minEngagement, v.country, v.competitorName, ...(sourced ? [v.minScore, v.audience] : [])].some(Boolean);
  const r = facets?.review;
  return (
    <div className="toolbar filterbar">
      {sourced && (
      <select value={v.review} onChange={(e) => set.setReview(e.target.value)} title="Review status">
        <option value="pending">Waiting for review{r ? ` (${r.pending})` : ""}</option>
        <option value="accepted">Accepted{r ? ` (${r.accepted})` : ""}</option>
        <option value="rejected">Rejected{r ? ` (${r.rejected})` : ""}</option>
        <option value="all">All sourced</option>
      </select>
      )}
      <select value={v.niche} onChange={(e) => set.setNiche(e.target.value)}>
        <option value="">All niches</option>
        {(facets?.niches ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      {sourced && (
      <select value={v.audience} onChange={(e) => set.setAudience(e.target.value)}>
        <option value="">All audiences</option>
        {(facets?.audiences ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      )}
      <select value={v.competitor} onChange={(e) => set.setCompetitor(e.target.value)}>
        <option value="">Competitor: any</option>
        <option value="yes">Promotes a competitor</option>
        <option value="no">No competitor seen</option>
      </select>
      <select value={v.competitorName} onChange={(e) => set.setCompetitorName(e.target.value)}>
        <option value="">Any competitor</option>
        {(facets?.competitors ?? []).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}
      </select>
      <select value={v.store} onChange={(e) => set.setStore(e.target.value)}>
        <option value="">Stores: show</option>
        <option value="hide">Hide stores / vendors</option>
        <option value="only">Only stores / vendors</option>
      </select>
      <select value={v.active} onChange={(e) => set.setActive(e.target.value)}>
        <option value="">Any activity</option>
        <option value="yes">Posted in last 30 days</option>
      </select>
      <select value={v.country} onChange={(e) => set.setCountry(e.target.value)}>
        <option value="">Any country</option>
        {(facets?.countries ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input type="number" min={0} placeholder="Min reach" value={v.minReach} onChange={(e) => set.setMinReach(e.target.value)} style={{ width: 110 }} />
      {sourced && <input type="number" min={0} max={100} placeholder="Min score" value={v.minScore} onChange={(e) => set.setMinScore(e.target.value)} style={{ width: 100 }} />}
      <input type="number" min={0} step={0.5} placeholder="Min eng. %" value={v.minEngagement} onChange={(e) => set.setMinEngagement(e.target.value)} style={{ width: 105 }} title="Minimum engagement rate, in percent" />
      {any && <button onClick={onClear}>Clear filters</button>}
      <span className="muted" style={{ fontSize: 12 }}>{shown} shown</span>
    </div>
  );
}

interface SourcedTableProps {
  rows: LeadRow[];
  sort: string;
  dir: string;
  onSort: (col: string) => void;
  canRun: boolean;
  open: number | null;
  onOpen: (id: number) => void;
  onAccept: (l: LeadRow) => void;
  onReject: (l: LeadRow, reason?: string) => void;
  confirmReject: number | null;
}

const SOURCED_COLUMNS: Array<[string | null, string, string?]> = [
  ["score", "Score"],
  ["name", "Creator"],
  ["niche", "Niche"],
  ["platform", "Platform"],
  ["reach", "Reach", "Followers from a real profile read"],
  ["avgViews", "Avg views", "Average views across their most recent posts"],
  ["engagement", "Engagement", "(likes + comments) ÷ views, averaged over recent posts. Per follower when posts have no view count"],
  ["posts30", "Posts 30d", "Posts in the last 30 days, out of the recent posts read"],
  ["lastPost", "Last post"],
  [null, "Surfaced post", "The post that found them: views · likes · comments"],
  ["competitor", "Competitor"],
  [null, "Code"],
  [null, "Flags"],
  [null, "Links"],
  [null, "Decision"],
];

function SourcedTable({ rows, sort, dir, onSort, canRun, open, onOpen, onAccept, onReject, confirmReject }: SourcedTableProps) {
  return (
    <div className="tablewrap">
      <table className="sourced">
        <thead>
          <tr>
            {SOURCED_COLUMNS.map(([col, label, help]) =>
              col ? (
                <th key={label} className={`sortable ${sort === col ? "active" : ""}`} onClick={() => onSort(col)} title={help}>
                  {label}
                  {sort === col ? (dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "") : ""}
                </th>
              ) : (
                <th key={label} title={help}>{label}</th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={SOURCED_COLUMNS.length} className="muted">
                Nothing matches. Clear the filters, or run an audience from the Audiences page to find new people.
              </td>
            </tr>
          )}
          {rows.map((l) => {
            const d = l.details;
            const s = d?.surfaced;
            return (
              <tr key={l.id} className={open === l.id ? "selected" : ""} style={{ cursor: "pointer" }} onClick={() => onOpen(l.id)}>
                <td>
                  <strong>{l.sourcingScore ?? 0}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>{l.scoreReasons.length} reasons</div>
                </td>
                <td className="creator">
                  <div><strong>{l.name}</strong>{d?.handle && <span className="muted"> @{d.handle}</span>}</div>
                  {d?.bio && <div className="bio" title={d.bio}>{d.bio}</div>}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {d?.term ? <>via <strong>{d.term}</strong>{d.audience ? ` · ${d.audience}` : ""}</> : l.sourcingReason}
                  </div>
                  {l.rejectedReason && <div className="chip failed" style={{ marginTop: 4 }}>rejected: {l.rejectedReason}</div>}
                </td>
                <td>
                  {d?.niche ?? l.niche ?? "—"}
                  <div className="muted" style={{ fontSize: 11 }}>{BRAND_LABEL[l.brandFit ?? ""] ?? l.brandFit ?? ""}</div>
                </td>
                <td className="muted">{l.platform ?? "—"}</td>
                <td>{l.reach != null ? l.reach.toLocaleString() : <span className="muted">unverified</span>}</td>
                <td>{d?.avgViews != null ? compact(d.avgViews) : <span className="muted">—</span>}</td>
                <td title={d?.engagementBasis === "followers" ? "per follower (posts have no view count)" : "per view"}>
                  {d?.engagementRate != null ? `${(d.engagementRate * 100).toFixed(1)}%` : <span className="muted">—</span>}
                  {d?.engagementBasis === "followers" && <span className="muted" style={{ fontSize: 11 }}> /fol.</span>}
                </td>
                <td>{d?.postsLast30 != null ? <>{d.postsLast30}<span className="muted" style={{ fontSize: 11 }}> /{d.postsRead}</span></> : <span className="muted">—</span>}</td>
                <td className="muted">
                  {l.lastPostAt?.slice(0, 10) ?? "—"}
                  {d?.daysSinceLastPost != null && <div style={{ fontSize: 11 }}>{d.daysSinceLastPost}d ago</div>}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {s ? (
                    <>
                      {isHttp(s.url) ? <a href={s.url} target="_blank" rel="noreferrer">post ↗</a> : null}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {compact(s.views)} views · {compact(s.likes)} likes · {compact(s.comments)} comm.
                      </div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{l.competitor ? <span className="chip suggest">{l.competitor}</span> : <span className="muted">—</span>}</td>
                <td>{l.affiliateCode ? <code>{l.affiliateCode}</code> : <span className="muted">—</span>}</td>
                <td>
                  <div className="flags">
                  {d?.isStore && <span className="chip failed" title="Handle or bio looks like a shop, not a creator">store</span>}
                  {l.promoTrackRecord && <span className="chip ok" title="Has run a code, discount link or #ad before">promo</span>}
                  {l.doesLive && <span className="chip ok">LIVE</span>}
                  {l.country ? (
                    <span className={`chip ${l.country === "US" ? "ok" : "failed"}`} title="Where they are, from the platform or their bio">{l.country === "US" ? "US ✓" : l.country}</span>
                  ) : (
                    <span className="chip unresolved" title="No platform or bio evidence of where they are">location ?</span>
                  )}
                  </div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {isHttp(l.profileUrl) && (
                    <a href={l.profileUrl} target="_blank" rel="noreferrer">profile ↗</a>
                  )}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {canRun ? (
                    <>
                      <button className="primary" onClick={() => onAccept(l)}>
                        Accept…
                      </button>{" "}
                      <button onClick={() => onReject(l)}>{confirmReject === l.id ? "Click again to reject" : "Reject"}</button>{" "}
                      <button onClick={() => onReject(l, "goodwill advocate")} title="SP5: never contacted, by rule">
                        Goodwill advocate
                      </button>
                    </>
                  ) : (
                    <span className="muted">{l.sourcingReview ?? ""}</span>
                  )}
                </td>
              </tr>
            );
          })}
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
