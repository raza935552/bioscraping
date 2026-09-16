// Lead dialog: the outreach conversation. Shows the next message from the flow chart, filled in
// for this lead, ready to copy. The outreach person sends it by hand, marks it sent, and logs the
// creator's reply; the next message appears.

import { useCallback, useEffect, useState } from "react";
import { api, type Conversation, type LeadRow } from "./api.js";
import { PATH_LABEL } from "./labels.js";

const REPLY_BUTTONS: Array<[string, string, string]> = [
  ["yes", "Yes", "They're in (or they sent their details)"],
  ["tell_me_more", "Tell me more", "They asked for more information"],
  ["no", "No", "They said no"],
  ["no_info", "Replied but no info", "They answered without saying yes or no, or without their details"],
];

const REPLY_LABEL: Record<string, string> = { yes: "Yes", tell_me_more: "Tell me more", no: "No", no_info: "Replied but no info" };

function defaultChannel(platform: string | null, channels: string[]): string {
  const p = (platform ?? "").toLowerCase();
  const pick = p.includes("tiktok") ? "TikTok DM" : p.includes("instagram") ? "Instagram DM" : p.includes("reddit") ? "Reddit DM" : p.includes("facebook") ? "Facebook DM" : "Other";
  return channels.includes(pick) ? pick : channels[0] ?? "Other";
}

function suggestCode(first: string, last: string): string {
  const f = first.trim().split(/\s+/)[0]?.replace(/[^a-z0-9]/gi, "") ?? "";
  const l = last.trim().replace(/[^a-z]/gi, "").slice(0, 1);
  return f ? `${f}${l}10`.toUpperCase() : "";
}

export function OutreachPanel({ row, canSend, onChanged }: { row: LeadRow; canSend: boolean; onChanged: () => void }) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("");
  const [replyText, setReplyText] = useState("");
  const [suggested, setSuggested] = useState<{ kind: string; reason: string; source: string } | null>(null);
  useEffect(() => {
    if (!replyText.trim()) return setSuggested(null);
    const t = window.setTimeout(() => {
      void api.outreachClassify(replyText, null).then((r) => setSuggested(r)).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [replyText]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [signup, setSignup] = useState({ firstName: "", lastName: "", email: "", code: "" });

  const load = useCallback(async () => {
    try {
      const c = await api.outreach(row.id, gap);
      setConv(c);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [row.id, gap]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = conv?.messages[pick] ?? conv?.messages[0] ?? null;
  useEffect(() => {
    setText(current?.text ?? "");
    setCopied(false);
  }, [current?.text]);
  useEffect(() => {
    if (conv && !channel) setChannel(defaultChannel(row.platform, conv.channels));
  }, [conv, channel, row.platform]);
  useEffect(() => {
    const [first = "", ...rest] = (row.name ?? "").split(" ");
    setSignup((s) => (s.firstName || s.lastName ? s : { firstName: first, lastName: rest.join(" "), email: row.email ?? "", code: suggestCode(first, rest.join(" ")) }));
  }, [row.name, row.email]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      setMsg(await fn());
      setPick(0);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!conv) return <div className="card outreach-panel">{err ? <div className="error">{err}</div> : <div className="muted">Loading the conversation…</div>}</div>;

  const pathInfo = PATH_LABEL[conv.path];
  const isOpener = current?.templateId.startsWith("offer");
  // Placeholders still in the text as edited (someone may have filled them by hand).
  const stillMissing = current ? current.missing.filter((m) => text.includes(`[${m}]`)) : [];
  const blocked = !!current && (stillMissing.length > 0 || current.violations.some((v) => v.severity === "block"));
  const awaitingReply = conv.history.length > 0 && conv.history[conv.history.length - 1]!.type === "sent";
  const step = conv.step;

  return (
    <div className="card outreach-panel">
      <div className="outreach-head">
        <div className="k">Outreach</div>
        {pathInfo && <span className={`chip ${pathInfo.tone === "ok" ? "ok" : pathInfo.tone === "bad" ? "failed" : "unresolved"}`}>{pathInfo.short}</span>}
        {conv.brand && <span className="muted">competitor: {conv.brand}</span>}
      </div>

      {conv.history.length > 0 && (
        <div className="outreach-history">
          {conv.history.map((h, i) => (
            <div key={i} className={`outreach-item ${h.type}`}>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {new Date(h.at).toLocaleString()} · {h.type === "sent" ? `You sent: ${h.label}` : `They replied: ${REPLY_LABEL[h.label] ?? h.label}`}
              </div>
              {h.body && <div className="outreach-body">{h.body}</div>}
            </div>
          ))}
        </div>
      )}

      {step.kind === "done" && <div className="notice">{step.outcome === "not_qualified" ? `Don't message: ${pathInfo?.help ?? step.why}` : step.why}</div>}

      {step.kind === "wait" && (
        <div className="notice">
          Waiting for their reply. If they don't answer, a check-in is due on <strong>{new Date(step.dueAt).toLocaleDateString()}</strong>.
        </div>
      )}

      {step.kind === "send" && current && (
        <div className="outreach-next">
          <div className="k">Your next message</div>
          <ol className="outreach-steps">
            <li><strong>Copy message</strong> (button below)</li>
            <li><strong>Open their profile</strong> and paste it in a DM</li>
            <li>Come back and press <strong>I sent it</strong></li>
          </ol>
          {(conv.messages.length > 1 || isOpener) && (
          <details className="outreach-change">
            <summary className="muted">Use a different version (optional)</summary>
          {conv.messages.length > 1 && (
            <div className="chips" style={{ margin: "6px 0" }}>
              {conv.messages.map((m, i) => (
                <button key={m.templateId} type="button" className={`chip-button ${i === pick ? "active" : ""}`} onClick={() => setPick(i)}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {isOpener && (
            <label className="settings-field" style={{ margin: "6px 0" }}>
              <span className="fl">Opening line</span>
              <select value={gap ?? conv.gapIndex} onChange={(e) => setGap(Number(e.target.value))}>
                {conv.gaps.map((g, i) => (
                  <option key={i} value={i}>
                    {g.kind}: {g.text}
                  </option>
                ))}
              </select>
            </label>
          )}
          </details>
          )}
          <textarea rows={Math.min(16, Math.max(5, text.split("\n").length + 1))} value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%" }} />
          {current.source === "drafted" && <div className="muted" style={{ fontSize: 12 }}>Draft wording: marketing can rewrite it on Message templates.</div>}
          {stillMissing.length > 0 && <div className="error">Fill in first: {stillMissing.map((m) => `[${m}]`).join(", ")} (set them once on Message templates, or type them in here).</div>}
          {current.violations.filter((v) => v.severity === "block").map((v, i) => (
            <div key={i} className="error">Compliance: {v.detail}</div>
          ))}
          <div className="modal-actions" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(text).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied ✓" : "Copy message"}
            </button>
            {row.profileUrl && /^https?:\/\//.test(row.profileUrl) && (
              <a className="btn-link" href={row.profileUrl} target="_blank" rel="noreferrer">
                Open their profile ↗
              </a>
            )}
            <div className="grow" />
            <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: 150 }} title="Where you sent it">
              {conv.channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!canSend || busy || blocked}
              title={!canSend ? "Your role can't record outreach" : blocked ? "Fix the problems above first" : "Record that you sent this message"}
              onClick={() =>
                void act(async () => {
                  await api.outreachSent(row.id, { templateId: current.templateId, body: text, channel, gapIndex: isOpener ? gap ?? conv.gapIndex : null });
                  return `Recorded: ${current.label} sent by ${channel}.`;
                })
              }
            >
              {busy ? "Saving…" : "I sent it"}
            </button>
          </div>
        </div>
      )}

      {step.kind === "signup" && (
        <div className="outreach-next">
          <div className="k">Record their sign-up</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Enter what they sent. This creates the sign-up for Diana to set up.</div>
          <div className="form-grid">
            {(["firstName", "lastName", "email", "code"] as const).map((k) => (
              <label key={k} className="settings-field">
                <span className="fl">{{ firstName: "First name", lastName: "Last name", email: "Email", code: "Their code (e.g. JOHND10)" }[k]}</span>
                <input
                  value={signup[k]}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSignup((s) => {
                      const next = { ...s, [k]: v };
                      if ((k === "firstName" || k === "lastName") && (!s.code || s.code === suggestCode(s.firstName, s.lastName))) next.code = suggestCode(next.firstName, next.lastName);
                      return next;
                    });
                  }}
                />
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <div className="grow" />
            <button
              className="primary"
              disabled={!canSend || busy}
              onClick={() =>
                void act(async () => {
                  const r = await api.outreachSignup(row.id, signup);
                  return `Sign-up #${r.signupId} recorded. It's on the Signups page.`;
                })
              }
            >
              Record sign-up
            </button>
          </div>
        </div>
      )}

      {awaitingReply && step.kind !== "done" && (
        <div className="outreach-next">
          <div className="k">When they reply</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Paste their reply, then press the button that matches. The next message appears above.</div>
          <textarea rows={3} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Paste their reply here" style={{ width: "100%" }} />
          {suggested && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Looks like <strong>{REPLY_LABEL[suggested.kind]}</strong> ({suggested.reason}{suggested.source === "ai" ? ", read by AI" : ""}). Press it, or pick another.
            </div>
          )}
          <div className="modal-actions" style={{ flexWrap: "wrap" }}>
            {REPLY_BUTTONS.map(([kind, label, help]) => (
              <button
                key={kind}
                className={suggested?.kind === kind ? "primary" : ""}
                title={help}
                disabled={!canSend || busy}
                onClick={() =>
                  void act(async () => {
                    await api.outreachReply(row.id, { kind, body: replyText, channel });
                    setReplyText("");
                    return `Logged their reply: ${label}.`;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {msg && <div className="notice">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
