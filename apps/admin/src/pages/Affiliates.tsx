import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Affiliate, type AffiliateAssets, type Me } from "../api.js";
import { CLASS_HELP, CLASS_LABEL, ClassChip, Modal, PageInfo } from "../components.js";
import { copyText } from "../outreachShared.js";
import { toast, toastError } from "../toast.js";

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
  // The posts-ready pack for one affiliate: bio line, stories, caption, ad break.
  const [assetsFor, setAssetsFor] = useState<Affiliate | null>(null);

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
              {canEdit && <th>What they post</th>}
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
                {canEdit && (
                  <td>
                    <button onClick={() => setAssetsFor(a)} title="Their bio line, story text, caption and YouTube ad break, with their code filled in">
                      Assets
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {assetsFor && (
        <AssetPack
          affiliate={assetsFor}
          onClose={() => setAssetsFor(null)}
        />
      )}
    </>
  );
}

/** Everything one affiliate needs to post, filled in with their code and checked by the compliance
 *  linter. Without a code the copy still shows, with [code] left in and a box to set it. */
function AssetPack({ affiliate, onClose }: { affiliate: Affiliate; onClose: () => void }) {
  const [data, setData] = useState<AffiliateAssets | null>(null);
  const [err, setErr] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.affiliateAssets(affiliate.id);
      setData(d);
      setCode(d.code ?? d.suggestedCode ?? "");
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [affiliate.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const name = [affiliate.firstName, affiliate.lastName].filter(Boolean).join(" ") || affiliate.username || `#${affiliate.idevId}`;
  const saveCode = async () => {
    setSaving(true);
    try {
      await api.affiliateUpdate(affiliate.id, { couponCode: code });
      toast(`Code saved for ${name}.`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
      toastError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`What ${name} posts`} subtitle="Copy each one and send it to them. Their code is filled in." onClose={onClose}>
      {err && <div className="error">{err}</div>}
      {!data ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="toolbar" style={{ alignItems: "flex-end" }}>
            <label className="settings-field" style={{ maxWidth: 220 }}>
              <span className="fl">Their code</span>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="JOHND10" />
            </label>
            <button className="primary" disabled={saving || code.trim() === (data.code ?? "")} onClick={() => void saveCode()}>
              {saving ? "Saving…" : "Save code"}
            </button>
            <div className="grow" />
            <span className="muted" style={{ fontSize: 12.5 }}>
              {data.settings.discountPct}% off at {data.settings.storeUrl}
            </span>
          </div>
          {!data.code && data.suggestedCode && (
            <div className="notice">
              They asked for <strong>{data.suggestedCode}</strong> at sign-up. Check it exists in iDev, then save it here.
            </div>
          )}
          {!data.code && !data.suggestedCode && (
            <div className="notice">
              No code on file. iDev's API doesn't give us codes, so paste theirs above and every template below fills itself in.
            </div>
          )}
          {data.assets.map((a) => (
            <div key={a.id} className="card" style={{ marginTop: 10 }}>
              <div className="toolbar" style={{ margin: 0 }}>
                <div>
                  <strong>{a.label}</strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>{a.where}</div>
                </div>
                <div className="grow" />
                {a.maxChars != null && (
                  <span className={`chip ${a.tooLong ? "failed" : "ok"}`} title={a.tooLong ? "Too long for this surface" : "Fits"}>
                    {a.chars}/{a.maxChars}
                  </span>
                )}
                <button
                  disabled={a.blocked || a.missing.length > 0}
                  title={a.blocked ? "Compliance blocks this wording" : a.missing.length > 0 ? `Fill in ${a.missing.join(", ")} first` : "Copy this"}
                  onClick={() => void copyText(a.text).then((ok) => (ok ? (setCopied(a.id), toast(`${a.label} copied.`)) : toastError("Couldn't copy.")))}
                >
                  {copied === a.id ? "✓ Copied" : "📋 Copy"}
                </button>
              </div>
              <div className="outreach-body" style={{ marginTop: 8 }}>{a.text}</div>
              {a.note && <div className="muted" style={{ fontSize: 12 }}>{a.note}</div>}
              {a.missing.length > 0 && <div className="error">Fill in: {a.missing.join(", ")}</div>}
              {a.violations.map((v, i) => (
                <div key={i} className={v.severity === "block" ? "error" : "notice"}>{v.detail}</div>
              ))}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
