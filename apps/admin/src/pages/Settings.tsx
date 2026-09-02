import { useCallback, useEffect, useState } from "react";
import { PageInfo } from "../components.js";
import { api, type SettingsField, type SettingsSection } from "../api.js";

export function Settings() {
  const [sections, setSections] = useState<SettingsSection[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setSections((await api.settings()).sections);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageInfo title="Settings — keys &amp; configuration">
        Everything the engine needs to run. Secret keys are stored <strong>encrypted</strong> and never shown back to
        you — a field that already has a value shows "set"; leave it blank to keep it, or type a new value to replace
        it. Each section saves on its own. Changes apply live.
      </PageInfo>
      {error && <div className="error">{error}</div>}
      {sections.map((s) => (
        <SectionForm key={s.id} section={s} onSaved={load} />
      ))}
    </>
  );
}

function SectionForm({ section, onSaved }: { section: SettingsSection; onSaved: () => Promise<void> }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const set = (k: string, v: string) => {
    setVals((p) => ({ ...p, [k]: v }));
    setSaved(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      // Only send fields the admin actually touched.
      await api.saveSettings(section.id, vals);
      setVals({});
      setSaved(true);
      await onSaved();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-card" onSubmit={save}>
      <div className="settings-head">
        <h2>{section.title}</h2>
        <p className="muted">{section.blurb}</p>
      </div>
      <div className="settings-grid">
        {section.fields.map((f) => (
          <Field key={f.key} f={f} value={vals[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </div>
      <div className="settings-foot">
        {err && <span className="error" style={{ marginRight: "auto" }}>{err}</span>}
        {saved && <span className="ok-text">✓ Saved</span>}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : `Save ${section.title.split(" (")[0]}`}
        </button>
      </div>
    </form>
  );
}

function Field({ f, value, onChange }: { f: SettingsField; value: string | undefined; onChange: (v: string) => void }) {
  if (f.kind === "bool") {
    const on = value != null ? value === "true" : f.value === "true";
    return (
      <label className="settings-field bool">
        <span className="fl">{f.label}</span>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
        {f.help && <span className="fh">{f.help}</span>}
      </label>
    );
  }
  const isSecret = f.kind === "secret";
  return (
    <label className="settings-field">
      <span className="fl">
        {f.label}
        {isSecret && <span className={`badge ${f.configured ? "set" : "unset"}`}>{f.configured ? "set" : "not set"}</span>}
      </span>
      <input
        type={isSecret ? "password" : f.kind === "number" ? "number" : "text"}
        value={value ?? (isSecret ? "" : f.value ?? "")}
        placeholder={isSecret ? (f.configured ? "•••••••• (leave blank to keep)" : f.placeholder ?? "enter value") : f.placeholder}
        // Stop Chrome/Google password manager from autofilling and corrupting
        // the field: "new-password" + a non-login name + the manager ignore hints.
        name={`setting-${f.key.toLowerCase()}`}
        autoComplete={isSecret ? "new-password" : "off"}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {f.help && <span className="fh">{f.help}</span>}
    </label>
  );
}
