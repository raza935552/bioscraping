import { useEffect, useState } from "react";
import { api, type OutreachSettings, type RenderedMessage, type TemplateDef } from "../api.js";
import { PageInfo } from "../components.js";

const ORDER = [
  "offer1_soft", "offer1_direct", "offer2_soft", "offer2_direct", "reply1_signup", "reply2_details", "reply3_referral",
  "recruit_aro", "reply1b_aro_signup", "reply2b_aro_details", "reply3_aro_referral", "checkin_no_info", "checkin_no_reply",
];

export function Templates() {
  const [settings, setSettings] = useState<OutreachSettings | null>(null);
  const [defaults, setDefaults] = useState<Record<string, TemplateDef>>({});
  const [previews, setPreviews] = useState<Record<string, RenderedMessage>>({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .outreachSettings()
      .then((r) => {
        setSettings(r.settings);
        setDefaults(r.defaults);
        return api.previewOutreach(r.settings).then((p) => setPreviews(p.previews));
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  // Previews follow the edits (after a short pause), so "passes compliance" is never out of date.
  useEffect(() => {
    if (!settings) return;
    let stale = false;
    const t = window.setTimeout(() => {
      void api.previewOutreach(settings).then((p) => !stale && setPreviews(p.previews)).catch(() => {});
    }, 700);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [settings]);

  if (!settings) return err ? <div className="error">{err}</div> : <div className="muted">Loading…</div>;

  const set = (patch: Partial<OutreachSettings>) => setSettings({ ...settings, ...patch });
  const bodyOf = (id: string) => settings.templates[id] ?? defaults[id]?.body ?? "";
  const save = async () => {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      // Only store templates that differ from the default, so default improvements still reach the rest.
      const templates = Object.fromEntries(Object.entries(settings.templates).filter(([id, body]) => body.trim() && body !== defaults[id]?.body));
      const r = await api.saveOutreachSettings({ ...settings, templates });
      setSettings(r.settings);
      setPreviews((await api.previewOutreach(r.settings)).previews);
      setMsg("Saved. Every lead's next message uses the new wording.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageInfo title="Message templates — the outreach flow's wording">
        These are the messages outreach people copy from a lead. The flow chart decides which one comes next; this page decides
        the words. Placeholders filled in automatically: <code className="inline">[curiosity gap]</code> (the opening line),{" "}
        <code className="inline">[name]</code> (the person sending), <code className="inline">[brand]</code> (their competitor),{" "}
        <code className="inline">[first name]</code> (the creator), <code className="inline">[intro]</code>,{" "}
        <code className="inline">[details link]</code>, <code className="inline">[aro details link]</code>,{" "}
        <code className="inline">[aro commission]</code>, <code className="inline">[aro cookie]</code>. Anything else in brackets stays as
        written. Every message is checked by the compliance linter before it can be marked sent.
      </PageInfo>

      <div className="settings-card">
        <h3 style={{ marginTop: 0 }}>Links, Aro details and timing</h3>
        <div className="form-grid">
          <label className="settings-field"><span className="fl">Program details link ([details link])</span><input value={settings.detailsLink} onChange={(e) => set({ detailsLink: e.target.value })} placeholder="https://…" /></label>
          <label className="settings-field"><span className="fl">Aro details link ([aro details link])</span><input value={settings.aroDetailsLink} onChange={(e) => set({ aroDetailsLink: e.target.value })} placeholder="https://…" /></label>
          <label className="settings-field"><span className="fl">Aro commission ([aro commission])</span><input value={settings.aroCommission} onChange={(e) => set({ aroCommission: e.target.value })} placeholder="e.g. 25% on every order (4 life)" /></label>
          <label className="settings-field"><span className="fl">Aro cookie ([aro cookie])</span><input value={settings.aroCookie} onChange={(e) => set({ aroCookie: e.target.value })} placeholder="e.g. lifetime" /></label>
          <label className="settings-field"><span className="fl">Days without a reply before a check-in</span><input type="number" min={1} max={30} value={settings.checkinDays} onChange={(e) => set({ checkinDays: Number(e.target.value) })} /></label>
        </div>
      </div>

      <div className="settings-card">
        <h3 style={{ marginTop: 0 }}>Opening lines ([curiosity gap])</h3>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Each lead gets one in rotation; the outreach person can pick another.</div>
        {settings.gaps.map((g, i) => (
          <div key={i} className="toolbar" style={{ margin: "4px 0" }}>
            <select value={g.kind} style={{ width: 120 }} onChange={(e) => set({ gaps: settings.gaps.map((x, j) => (j === i ? { ...x, kind: e.target.value as typeof g.kind } : x)) })}>
              <option value="pleasure">pleasure</option>
              <option value="pain">pain</option>
              <option value="curiosity">curiosity</option>
            </select>
            <input value={g.text} onChange={(e) => set({ gaps: settings.gaps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
            <button onClick={() => set({ gaps: settings.gaps.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button onClick={() => set({ gaps: [...settings.gaps, { kind: "curiosity", text: "" }] })}>Add a line</button>
      </div>

      {ORDER.filter((id) => defaults[id]).map((id) => {
        const def = defaults[id]!;
        const p = previews[id];
        const edited = settings.templates[id] != null && settings.templates[id] !== def.body;
        return (
          <div key={id} className="settings-card">
            <div className="toolbar" style={{ margin: 0 }}>
              <h3 style={{ margin: 0 }}>{def.label}</h3>
              <span className={`chip ${def.source === "drafted" && !edited ? "unresolved" : "ok"}`}>{edited ? "edited" : def.source === "drafted" ? "draft wording" : "marketing"}</span>
              <div className="grow" />
              {edited && <button onClick={() => { const t = { ...settings.templates }; delete t[id]; set({ templates: t }); }}>Reset to default</button>}
            </div>
            <div className="muted" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>Used when: {def.when}</div>
            <textarea rows={Math.min(18, bodyOf(id).split("\n").length + 2)} style={{ width: "100%" }} value={bodyOf(id)} onChange={(e) => set({ templates: { ...settings.templates, [id]: e.target.value } })} />
            {p && (
              <details style={{ marginTop: 6 }}>
                <summary className="muted" style={{ cursor: "pointer" }}>
                  Preview for a sample lead (Jamie, Amino Club){p.blocked ? " · has problems" : " · passes compliance"}
                </summary>
                <div className="outreach-body" style={{ margin: "6px 0" }}>{p.text}</div>
                {p.missing.length > 0 && <div className="error">Not filled in yet: {p.missing.map((m) => `[${m}]`).join(", ")}</div>}
                {p.violations.map((v, i) => <div key={i} className="error">{v.detail}</div>)}
              </details>
            )}
          </div>
        );
      })}

      <div className="toolbar" style={{ position: "sticky", bottom: 0, background: "var(--ground)", padding: "10px 0" }}>
        {msg && <div className="notice" style={{ margin: 0 }}>{msg}</div>}
        {err && <div className="error" style={{ margin: 0 }}>{err}</div>}
        <div className="grow" />
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save templates"}</button>
      </div>
    </>
  );
}
