// Lead dialog: the outreach conversation for this lead, the same steps as the Outreach page
// (copy the message, open their DMs, I sent it, paste their reply), for admins working from the table.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Conversation, type LeadRow } from "./api.js";
import { PATH_LABEL } from "./labels.js";
import { REPLY_LABEL, channelFor, copyText, splitName, suggestCode } from "./outreachShared.js";
import { ReplyBox } from "./pages/Outreach.js";

export function OutreachPanel({ row, canSend, onChanged }: { row: LeadRow; canSend: boolean; onChanged: () => void }) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState(channelFor(row.platform));
  const [problems, setProblems] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const name = splitName(row.name);
  const [signup, setSignup] = useState({ firstName: name.firstName, lastName: name.lastName, email: row.email ?? "", code: suggestCode(name.firstName, name.lastName) });
  const textRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      setConv(await api.outreach(row.id, gap));
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
  }, [current?.templateId, current?.text]);
  useEffect(() => {
    if (!current) return;
    let stale = false;
    const t = window.setTimeout(() => {
      void api.outreachCheck(row.id, text, current.templateId).then((r) => {
        if (stale) return;
        setBlocked(r.blocked);
        setProblems([...r.placeholders.map((p) => `Fill in [${p}] (Message templates, or type it in).`), ...r.violations.map((v) => v.detail)]);
      }).catch(() => {});
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [text, row.id, current]);

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
  const step = conv.step;
  const awaitingReply = conv.history.at(-1)?.type === "sent";
  const handleLabel = row.details?.handle ? `@${row.details.handle}` : row.name;

  return (
    <div className="card outreach-panel">
      <div className="outreach-head">
        <div className="k">Outreach</div>
        {pathInfo && <span className={`chip ${pathInfo.tone === "ok" ? "ok" : pathInfo.tone === "bad" ? "failed" : "unresolved"}`} title={pathInfo.help}>{pathInfo.short}</span>}
        {conv.brand && <span className="muted">promotes {conv.brand}</span>}
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
      {step.kind === "wait" && <div className="notice">Waiting for their reply. A check-in is due {new Date(step.dueAt).toLocaleDateString()}.</div>}

      {step.kind === "send" && current && (
        <div className="outreach-next">
          <div className="k">Your next message</div>
          <ol className="outreach-steps">
            <li><strong>Copy message</strong></li>
            <li>{row.dmUrl ? <>Open <strong>{handleLabel}</strong> and paste it in a DM</> : <>Send it where you can reach them{row.email ? ` (${row.email})` : ""}</>}</li>
            <li>Press <strong>I sent it</strong></li>
          </ol>
          {(conv.messages.length > 1 || isOpener) && (
            <details className="outreach-change">
              <summary className="muted">Use a different version (optional)</summary>
              {conv.messages.length > 1 && (
                <div className="chips" style={{ margin: "6px 0" }}>
                  {conv.messages.map((m, i) => (
                    <button key={m.templateId} type="button" className={`chip-button ${i === pick ? "active" : ""}`} onClick={() => setPick(i)}>{m.label}</button>
                  ))}
                </div>
              )}
              {isOpener && (
                <label className="settings-field" style={{ margin: "6px 0" }}>
                  <span className="fl">Opening line</span>
                  <select value={gap ?? conv.gapIndex} onChange={(e) => setGap(Number(e.target.value))}>
                    {conv.gaps.map((g, i) => <option key={i} value={i}>{g.text}</option>)}
                  </select>
                </label>
              )}
            </details>
          )}
          <textarea ref={textRef} rows={Math.min(16, Math.max(5, text.split("\n").length + 1))} value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} style={{ width: "100%" }} aria-label="Message to send" />
          {current.source === "drafted" && <div className="muted" style={{ fontSize: 12 }}>Draft wording: marketing can rewrite it on Message templates.</div>}
          {problems.map((p, i) => <div key={i} className="error">{p}</div>)}
          <div className="modal-actions" style={{ flexWrap: "wrap" }}>
            <button type="button" disabled={blocked} onClick={() => void copyText(text, textRef.current).then((ok) => { setCopied(ok); if (!ok) setErr("Couldn't copy automatically: the text is selected, press Ctrl+C."); })}>
              {copied ? "✓ Copied" : "📋 Copy message"}
            </button>
            {row.dmUrl && <a className="btn-link" href={row.dmUrl} target="_blank" rel="noreferrer">{row.dmKind === "search" ? `Search "${row.name}" ↗` : `Open ${handleLabel} ↗`}</a>}
            <div className="grow" />
            <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: 150 }} title="Where you sent it">
              {conv.channels.map((c) => <option key={c} value={c}>{c}</option>)}
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
          <div className="form-grid">
            {(["firstName", "lastName", "email", "code"] as const).map((k) => (
              <label key={k} className="settings-field">
                <span className="fl">{{ firstName: "First name", lastName: "Last name", email: "Email", code: "Their code (like JOHND10)" }[k]}</span>
                <input value={signup[k]} onChange={(e) => setSignup({ ...signup, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <div className="grow" />
            <button className="primary" disabled={!canSend || busy} onClick={() => void act(async () => `Sign-up #${(await api.outreachSignup(row.id, signup)).signupId} saved. It's on the Signups page.`)}>
              Save sign-up
            </button>
          </div>
        </div>
      )}

      {awaitingReply && step.kind !== "done" && canSend && (
        <div className="outreach-next">
          <div className="k">When they reply</div>
          <ReplyBox
            leadId={row.id}
            lastLabel={conv.history.filter((h) => h.type === "sent").at(-1)?.label ?? null}
            onSaved={async (_kind, d) => {
              if (d) setSignup((s) => ({ firstName: d.firstName ?? s.firstName, lastName: d.lastName ?? s.lastName, email: d.email ?? s.email, code: d.code ?? s.code }));
              setMsg("Reply saved. The next message is above.");
              await load();
              onChanged();
            }}
          />
        </div>
      )}

      {msg && <div className="notice">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
