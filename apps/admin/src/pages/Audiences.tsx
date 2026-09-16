import { useCallback, useEffect, useState } from "react";
import { api, type AudienceProfile, type AudiencesPayload, type Competitor } from "../api.js";
import { PageInfo } from "../components.js";
import { BRAND_LABEL, NICHE_BRAND, PLATFORM_LABEL, TERM_HELP } from "../labels.js";

export function Audiences() {
  const [data, setData] = useState<AudiencesPayload | null>(null);
  const [editing, setEditing] = useState<AudienceProfile | "new" | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.audiences());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (p: AudienceProfile) => {
    setBusy(p.id);
    setMsg("");
    try {
      const r = await api.runAudience(p.id);
      setMsg(`${p.name}: ${r.result.inserted} new leads waiting for review, about $${r.result.estimatedCostUsd}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageInfo title="Audiences — who the engine looks for">
        Each audience is one niche and the search terms that find its creators. The engine runs every active audience
        once a day, finds new people, scores them, and puts them in the <strong>Sourced</strong> view on the Leads page
        for a human to accept or reject. Nobody is contacted from here. Each run stops at the spend cap you set.
      </PageInfo>
      {error && <div className="error">{error}</div>}
      {msg && <div className="notice">{msg}</div>}
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Audiences</h1>
        <div className="grow" />
        <button className="primary" onClick={() => setEditing("new")}>
          New audience
        </button>
      </div>
      {!data && !error && <div className="muted">Loading…</div>}
      {data && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Niche</th>
                <th>Brand</th>
                <th>Platforms</th>
                <th>Daily cap</th>
                <th>Last run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No audiences yet. Create one to start finding leads.
                  </td>
                </tr>
              )}
              {data.profiles.map((p) => (
                <tr key={p.id} className={p.active ? "" : "muted"}>
                  <td>
                    {p.name} {!p.active && <span className="chip unresolved">paused</span>}
                  </td>
                  <td>{p.niche}</td>
                  <td>{BRAND_LABEL[p.brandFit] ?? p.brandFit}</td>
                  <td>{p.platforms.map((x) => PLATFORM_LABEL[x] ?? x).join(", ")}</td>
                  <td>{p.dailyCap}</td>
                  <td className="muted">{lastRunText(p)}</td>
                  <td>
                    <button onClick={() => setEditing(p)}>Edit</button>{" "}
                    <button disabled={busy === p.id} onClick={() => void run(p)} title="Spends Apify credit up to the spend cap">
                      {busy === p.id ? "Running…" : "Run now"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && data && (
        <AudienceForm
          initial={editing === "new" ? null : editing}
          niches={data.niches}
          platforms={data.platforms}
          defaults={data.defaults}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      <h2 style={{ marginTop: 32 }}>Competitor programs</h2>
      <p className="muted">
        Creators who post a competitor's code are the only leads the outreach flow contacts. Each active competitor is searched
        on TikTok three ways ("name code", "name discount", its domain), and its names and domains are how the engine spots
        an affiliate.
      </p>
      <CompetitorSuggestions onChanged={load} />
      {data && <CompetitorTable rows={data.competitors} onChanged={load} />}
    </>
  );
}

function lastRunText(p: AudienceProfile): string {
  if (!p.lastRunAt) return "never";
  const s = p.lastRunSummary as { inserted?: number; estimatedCostUsd?: number; stoppedBy?: string; termsSkipped?: string[]; termsResting?: string[] } | null;
  const parts = [new Date(p.lastRunAt).toLocaleDateString(), `${s?.inserted ?? 0} added`];
  if (s?.estimatedCostUsd != null) parts.push(`≈ $${s.estimatedCostUsd}`);
  if (s?.stoppedBy === "spend") parts.push("stopped at spend cap");
  if (s?.stoppedBy === "daily_limit") parts.push("stopped at the daily limit for all audiences");
  if (s?.stoppedBy === "review_full") parts.push("stopped: review queue is full");
  if (s?.termsResting?.length) parts.push(`${s.termsResting.length} search${s.termsResting.length === 1 ? "" : "es"} resting (no new people lately)`);
  if (s?.termsSkipped?.length) parts.push(`${s.termsSkipped.length} search${s.termsSkipped.length === 1 ? "" : "es"} skipped to stay under the cap`);
  return parts.join(" · ");
}

const joinLines = (v: string[] | null | undefined) => (v ?? []).join("\n");

interface AudienceFormProps {
  initial: AudienceProfile | null;
  niches: string[];
  platforms: string[];
  defaults: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function AudienceForm({ initial, niches, platforms, defaults, onClose, onSaved }: AudienceFormProps) {
  const dMin = (defaults.followerMin as Record<string, number>) ?? {};
  const dMax = (defaults.followerMax as Record<string, number>) ?? {};
  const [name, setName] = useState(initial?.name ?? "");
  const [niche, setNiche] = useState(initial?.niche ?? niches[0] ?? "");
  const [brandFit, setBrandFit] = useState(initial?.brandFit ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [chosen, setChosen] = useState<string[]>(initial?.platforms ?? []);
  const [terms, setTerms] = useState<Record<string, string>>(
    Object.fromEntries(platforms.map((p) => [p, joinLines(initial?.terms?.[p])])),
  );
  const [fmin, setFmin] = useState<Record<string, string>>(
    Object.fromEntries(platforms.map((p) => [p, String(initial?.followerMin?.[p] ?? dMin[p] ?? "")])),
  );
  const [fmax, setFmax] = useState<Record<string, string>>(
    Object.fromEntries(platforms.map((p) => [p, String(initial?.followerMax?.[p] ?? dMax[p] ?? "")])),
  );
  const [activityDays, setActivityDays] = useState(String(initial?.activityDays ?? defaults.activityDays ?? 30));
  const [countries, setCountries] = useState((initial?.countries ?? (defaults.countries as string[]) ?? []).join(", "));
  const [language, setLanguage] = useState(initial?.language ?? String(defaults.language ?? "en"));
  const [matchTerms, setMatchTerms] = useState(joinLines(initial?.matchTerms));
  const [excludeTerms, setExcludeTerms] = useState(joinLines(initial?.excludeTerms ?? (defaults.excludeTerms as string[])));
  const [excludeHandles, setExcludeHandles] = useState(joinLines(initial?.excludeHandles));
  const [dailyCap, setDailyCap] = useState(String(initial?.dailyCap ?? defaults.dailyCap ?? 50));
  const [spendCap, setSpendCap] = useState(String(initial?.spendCapUsd ?? defaults.spendCapUsd ?? "2.00"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const togglePlatform = (p: string) => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.saveAudience(initial?.id ?? null, {
        name,
        niche,
        brandFit: brandFit || undefined,
        active,
        platforms: chosen,
        terms: Object.fromEntries(chosen.map((p) => [p, terms[p] ?? ""])),
        followerMin: Object.fromEntries(chosen.map((p) => [p, fmin[p]])),
        followerMax: Object.fromEntries(chosen.map((p) => [p, fmax[p]])),
        activityDays,
        countries,
        language,
        matchTerms,
        excludeTerms,
        excludeHandles,
        dailyCap,
        spendCapUsd: spendCap,
      });
      await onSaved();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteAudience(initial.id);
      await onSaved();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-card" onSubmit={submit} style={{ marginTop: 16 }}>
      <div className="settings-head">
        <h2>{initial ? `Edit “${initial.name}”` : "New audience"}</h2>
        <p className="muted">One niche, the platforms to search, and the words that find the right creators.</p>
      </div>
      <div className="settings-grid">
        <label className="settings-field">
          <span className="fl">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weight-loss TikTok" />
        </label>
        <label className="settings-field">
          <span className="fl">Niche</span>
          <select value={niche} onChange={(e) => setNiche(e.target.value)}>
            {niches.map((n) => (
              <option key={n} value={n}>
                {n} · {BRAND_LABEL[NICHE_BRAND[n] ?? "biolinx"]}
              </option>
            ))}
          </select>
          <span className="fh">Tier order is the ranking tiebreaker. The brand is set by the niche unless you override it.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Brand override (optional)</span>
          <select value={brandFit} onChange={(e) => setBrandFit(e.target.value)}>
            <option value="">Use the niche default</option>
            {Object.entries(BRAND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field bool">
          <span className="fl">Active</span>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="fh">Paused audiences never run, not even from “Run now”.</span>
        </label>
      </div>

      <h3 style={{ fontSize: 14, margin: "8px 0" }}>Platforms, in the order they run</h3>
      <div className="toolbar">
        {platforms.map((p) => (
          <label key={p} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={chosen.includes(p)} onChange={() => togglePlatform(p)} style={{ width: "auto" }} />
            {PLATFORM_LABEL[p] ?? p}
            {chosen.includes(p) && <span className="muted">#{chosen.indexOf(p) + 1}</span>}
          </label>
        ))}
      </div>
      {chosen.length === 0 && <div className="muted">Pick at least one platform.</div>}
      <div className="settings-grid">
        {chosen.map((p) => (
          <div key={p} className="settings-field">
            <span className="fl">Search terms — {PLATFORM_LABEL[p] ?? p}</span>
            <textarea rows={4} value={terms[p] ?? ""} onChange={(e) => setTerms((t) => ({ ...t, [p]: e.target.value }))} />
            <span className="fh">{TERM_HELP[p]}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                placeholder="min followers"
                value={fmin[p] ?? ""}
                onChange={(e) => setFmin((m) => ({ ...m, [p]: e.target.value }))}
                inputMode="numeric"
              />
              <input
                placeholder="max followers"
                value={fmax[p] ?? ""}
                onChange={(e) => setFmax((m) => ({ ...m, [p]: e.target.value }))}
                inputMode="numeric"
              />
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 14, margin: "8px 0" }}>Fit and limits</h3>
      <div className="settings-grid">
        <label className="settings-field">
          <span className="fl">On-niche words (score +10)</span>
          <textarea rows={3} value={matchTerms} onChange={(e) => setMatchTerms(e.target.value)} placeholder={"menopause\nrecomp\nlongevity"} />
          <span className="fh">One per line. Seen in a bio or post, these mark the creator as on-topic.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Reject words</span>
          <textarea rows={3} value={excludeTerms} onChange={(e) => setExcludeTerms(e.target.value)} />
          <span className="fh">One per line. In a bio the creator is skipped; in posts only, the score drops by 30. Starts with the GLP-1 names.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Never add these handles</span>
          <textarea rows={3} value={excludeHandles} onChange={(e) => setExcludeHandles(e.target.value)} placeholder="one per line, no @" />
        </label>
        <label className="settings-field">
          <span className="fl">Active within (days)</span>
          <input value={activityDays} onChange={(e) => setActivityDays(e.target.value)} inputMode="numeric" />
          <span className="fh">A last post older than this counts as dormant and loses 20 points.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Countries</span>
          <input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="US, CA, GB, AU" />
          <span className="fh">Two-letter codes. Only applied when the platform tells us the country.</span>
        </label>
        <label className="settings-field">
          <span className="fl">Language</span>
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
        </label>
        <label className="settings-field">
          <span className="fl">New leads per run (1–200)</span>
          <input value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="numeric" />
        </label>
        <label className="settings-field">
          <span className="fl">Spend cap per run, USD (0.50–10)</span>
          <input value={spendCap} onChange={(e) => setSpendCap(e.target.value)} inputMode="decimal" />
          <span className="fh">The run stops verifying profiles once the estimated Apify cost reaches this.</span>
        </label>
      </div>
      <div className="settings-foot">
        {err && (
          <span className="error" style={{ marginRight: "auto" }}>
            {err}
          </span>
        )}
        {initial && (
          <button type="button" disabled={busy} onClick={() => void remove()}>
            {confirmDelete ? "Click again to delete" : "Delete"}
          </button>
        )}
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save audience"}
        </button>
      </div>
    </form>
  );
}

const EMPTY_COMPETITOR = { name: "", domains: "", codePrefix: "", codePattern: "", commissionPct: "", recurring: "", notes: "" };

function CompetitorTable({ rows, onChanged }: { rows: Competitor[]; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>(EMPTY_COMPETITOR);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const startEdit = (c: Competitor) => {
    setEditingId(c.id);
    setDraft({
      name: c.name,
      domains: (c.domains ?? []).join(", "),
      codePrefix: c.codePrefix ?? "",
      codePattern: c.codePattern ?? "",
      commissionPct: c.commissionPct == null ? "" : String(c.commissionPct),
      recurring: c.recurring == null ? "" : c.recurring ? "yes" : "no",
      notes: c.notes ?? "",
    });
  };

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.saveCompetitor(editingId, {
        name: draft.name,
        domains: draft.domains,
        codePrefix: draft.codePrefix,
        codePattern: draft.codePattern,
        commissionPct: draft.commissionPct,
        recurring: draft.recurring === "" ? null : draft.recurring === "yes",
        notes: draft.notes,
      });
      setDraft(EMPTY_COMPETITOR);
      setEditingId(null);
      await onChanged();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    try {
      await api.deleteCompetitor(id);
      await onChanged();
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Link domains</th>
              <th>Code prefix</th>
              <th>Code pattern</th>
              <th>Commission</th>
              <th>Recurring</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No competitors yet. Add the programs from Matt's list.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className={c.active ? "" : "muted"}>
                <td>{c.name}</td>
                <td className="muted">{(c.domains ?? []).join(", ") || "—"}</td>
                <td>{c.codePrefix ?? "—"}</td>
                <td className="muted">{c.codePattern ?? "—"}</td>
                <td>{c.commissionPct != null ? `${c.commissionPct}%` : "unknown"}</td>
                <td>{c.recurring == null ? "unknown" : c.recurring ? "yes" : "no"}</td>
                <td>
                  <button onClick={() => startEdit(c)}>Edit</button>{" "}
                  <button onClick={() => void remove(c.id)}>{confirmDelete === c.id ? "Click again to delete" : "Delete"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="settings-card" style={{ marginTop: 12 }}>
        <div className="settings-head">
          <h2>{editingId ? "Edit competitor" : "Add competitor"}</h2>
          <p className="muted">A prefix like PS matches PS20 and PSJANE. Use a pattern only if the codes have no common prefix.</p>
        </div>
        <div className="settings-grid">
          <label className="settings-field">
            <span className="fl">Name</span>
            <input value={draft.name} onChange={set("name")} placeholder="Peptide Sciences" />
          </label>
          <label className="settings-field">
            <span className="fl">Link domains (comma separated)</span>
            <input value={draft.domains} onChange={set("domains")} placeholder="peptidesciences.com" />
          </label>
          <label className="settings-field">
            <span className="fl">Code prefix</span>
            <input value={draft.codePrefix} onChange={set("codePrefix")} placeholder="PS" />
          </label>
          <label className="settings-field">
            <span className="fl">Code pattern (regex, optional)</span>
            <input value={draft.codePattern} onChange={set("codePattern")} placeholder="^ABC[0-9]{2}$" />
          </label>
          <label className="settings-field">
            <span className="fl">Their commission %</span>
            <input value={draft.commissionPct} onChange={set("commissionPct")} inputMode="numeric" placeholder="unknown" />
            <span className="fh">Below 25 is an easy pitch (+15). Same or higher is a counter-offer (+5).</span>
          </label>
          <label className="settings-field">
            <span className="fl">Recurring commission?</span>
            <select value={draft.recurring} onChange={set("recurring")}>
              <option value="">unknown</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </label>
          <label className="settings-field">
            <span className="fl">Notes</span>
            <input value={draft.notes} onChange={set("notes")} />
          </label>
        </div>
        <div className="settings-foot">
          {err && (
            <span className="error" style={{ marginRight: "auto" }}>
              {err}
            </span>
          )}
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_COMPETITOR);
              }}
            >
              Cancel
            </button>
          )}
          <button className="primary" disabled={busy || !(draft.name ?? "").trim()} onClick={() => void save()}>
            {busy ? "Saving…" : editingId ? "Save changes" : "Add competitor"}
          </button>
        </div>
      </div>
    </>
  );
}

function CompetitorSuggestions({ onChanged }: { onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.competitorSuggestions>>["suggestions"]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      setRows((await api.competitorSuggestions()).suggestions);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (rows.length === 0 && !err) return null;
  const act = async (key: string, action: "add" | "dismiss") => {
    setBusy(key);
    setErr("");
    try {
      await api.actOnSuggestion(key, action, names[key]);
      await load();
      if (action === "add") await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="settings-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Suggested competitors ({rows.length})</h3>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Vendors creators named next to a code or as a store link during sourcing. Add the real peptide vendors (they're searched
        from the next run); dismiss the rest.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Seen</th>
              <th>Examples</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <input value={names[r.key] ?? r.name} onChange={(e) => setNames({ ...names, [r.key]: e.target.value })} style={{ maxWidth: 220 }} />
                  {r.domain && <div className="muted" style={{ fontSize: 11 }}>{r.domain}</div>}
                </td>
                <td>{r.count}×</td>
                <td>
                  {r.examples.map((u, i) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                      post {i + 1} ↗
                    </a>
                  ))}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="primary" disabled={busy === r.key} onClick={() => void act(r.key, "add")}>Add as competitor</button>{" "}
                  <button disabled={busy === r.key} onClick={() => void act(r.key, "dismiss")}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
