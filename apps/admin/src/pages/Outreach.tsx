// The outreach person's page: one lead at a time, the message ready to copy, and one button to
// move on. The system decides the order (replies to answer, check-ins due, new leads) and the message.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Me, type OutreachWork, type ReplySuggestion } from "../api.js";

const REPLY_OPTIONS: Array<[ReplySuggestion["kind"], string]> = [
  ["yes", "Yes"],
  ["tell_me_more", "Tell me more"],
  ["no", "No"],
  ["no_info", "Replied but no info"],
];

const BUCKET_LABEL: Record<string, string> = {
  answer: "They replied: send the next message",
  checkin: "No reply yet: send a check-in",
  new: "New lead: send the first message",
};

function channelFor(platform: string | null): string {
  const p = (platform ?? "").toLowerCase();
  return p.includes("tiktok") ? "TikTok DM" : p.includes("instagram") ? "Instagram DM" : p.includes("reddit") ? "Reddit DM" : p.includes("facebook") ? "Facebook DM" : "Other";
}

const compact = (n: number | null) => (n == null ? "" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function Outreach({ me }: { me: Me }) {
  const [work, setWork] = useState<OutreachWork | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [pick, setPick] = useState(0);
  const [tab, setTab] = useState<"next" | "waiting">("next");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [signup, setSignup] = useState({ firstName: "", lastName: "", email: "", code: "" });
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [suggestion, setSuggestion] = useState<ReplySuggestion | null>(null);
  const [replyKind, setReplyKind] = useState<ReplySuggestion["kind"] | null>(null);
  const classifyTimer = useRef<number | null>(null);

  const load = useCallback(async (skip: number[], lead?: number | null) => {
    setErr("");
    try {
      const w = await api.outreachWork(skip, lead);
      setWork(w);
      setPick(0);
      setCopied(false);
      const l = w.lead;
      if (l) {
        const [first = "", ...rest] = l.name.split(" ");
        const last = rest.join(" ");
        setSignup({ firstName: first, lastName: last, email: l.email ?? "", code: first ? `${first.replace(/[^a-z0-9]/gi, "")}${last.replace(/[^a-z]/gi, "").slice(0, 1)}10`.toUpperCase() : "" });
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load([]);
  }, [load]);

  const conv = work?.conversation ?? null;
  const lead = work?.lead ?? null;
  const message = conv?.messages[pick] ?? conv?.messages[0] ?? null;
  useEffect(() => setText(message?.text ?? ""), [message?.text]);

  const next = async (extraSkip?: number) => {
    const skip = extraSkip != null ? [...skipped, extraSkip] : skipped;
    if (extraSkip != null) setSkipped(skip);
    await load(skip);
    window.scrollTo({ top: 0 });
  };

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const m = await fn();
      if (m) setNote(m);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Suggest the reply button as they paste.
  const onReplyText = (v: string, lastLabel: string | null) => {
    setReplyText(v);
    if (classifyTimer.current) window.clearTimeout(classifyTimer.current);
    if (!v.trim()) {
      setSuggestion(null);
      setReplyKind(null);
      return;
    }
    classifyTimer.current = window.setTimeout(() => {
      void api.outreachClassify(v, lastLabel).then((s) => {
        setSuggestion(s);
        setReplyKind(s.kind);
      }).catch(() => {});
    }, 400);
  };

  const logReply = (leadId: number) =>
    run(async () => {
      if (!replyKind) throw new Error("Paste their reply first");
      await api.outreachReply(leadId, { kind: replyKind, body: replyText, channel: "dm" });
      // Details they sent go straight into the sign-up form.
      if (suggestion?.details) {
        const d = suggestion.details;
        setSignup((s) => ({ firstName: d.firstName ?? s.firstName, lastName: d.lastName ?? s.lastName, email: d.email ?? s.email, code: d.code ?? s.code }));
      }
      setReplyText("");
      setSuggestion(null);
      setReplyKind(null);
      setReplyFor(null);
      setTab("next");
      await load(skipped.filter((id) => id !== leadId), leadId);
      return "Reply saved. Here's what to send next.";
    });

  const c = work?.counts;
  const lastSentLabel = conv?.history.filter((h) => h.type === "sent").at(-1)?.label ?? null;

  return (
    <div className="outreach-page">
      <div className="outreach-counts">
        <div><strong>{c?.sentTodayByMe ?? 0}</strong> sent by you today</div>
        <div><strong>{c?.answer ?? 0}</strong> replies to answer</div>
        <div><strong>{c?.checkin ?? 0}</strong> check-ins due</div>
        <div><strong>{c?.new ?? 0}</strong> new leads</div>
      </div>

      <div className="toolbar" style={{ gap: 6 }}>
        <button className={tab === "next" ? "primary" : ""} onClick={() => setTab("next")}>Next up</button>
        <button className={tab === "waiting" ? "primary" : ""} onClick={() => setTab("waiting")}>Waiting for reply ({c?.waiting ?? 0})</button>
      </div>

      {err && <div className="error">{err}</div>}
      {note && <div className="notice">{note}</div>}

      {tab === "waiting" && (
        <div className="outreach-card">
          <p className="muted" style={{ marginTop: 0 }}>Got a reply in your DMs? Find them here, paste what they said, and the next message is ready.</p>
          {work?.waiting.length === 0 && <div className="muted">Nobody is waiting for a reply.</div>}
          {work?.waiting.map((w) => (
            <div key={w.leadId} className="waiting-row">
              <div>
                <strong>{w.name}</strong> <span className="muted">· {w.platform ?? ""}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  Sent {w.lastLabel} on {new Date(w.sentAt).toLocaleDateString()} · check-in {new Date(w.dueAt).toLocaleDateString()}
                </div>
              </div>
              {replyFor === w.leadId ? (
                <ReplyBox text={replyText} onText={(v) => onReplyText(v, w.lastLabel)} suggestion={suggestion} kind={replyKind} onKind={setReplyKind} busy={busy} onSave={() => void logReply(w.leadId)} />
              ) : (
                <button onClick={() => { setReplyFor(w.leadId); setReplyText(""); setSuggestion(null); setReplyKind(null); }}>They replied</button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "next" && work && !lead && (
        <div className="outreach-card"><h2 style={{ marginTop: 0 }}>All done 🎉</h2><p className="muted">No messages to send right now. Check "Waiting for reply" when replies come in.</p></div>
      )}

      {tab === "next" && lead && conv && work?.next && (
        <div className="outreach-card">
          <div className="muted" style={{ fontSize: 12.5 }}>{BUCKET_LABEL[work.next.bucket]}</div>
          <h2 style={{ margin: "4px 0" }}>
            {lead.handle ? `@${lead.handle}` : lead.name} <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>· {lead.platform ?? ""}{lead.followers != null ? ` · ${compact(lead.followers)} followers` : ""}</span>
          </h2>
          {lead.competitor && (
            <div className="muted" style={{ fontSize: 13 }}>
              Promotes <strong>{lead.competitor}</strong>{lead.code ? <> (code <code>{lead.code}</code>)</> : null}
            </div>
          )}

          {conv.history.length > 0 && (
            <details className="outreach-change" open={work.next.bucket === "answer"}>
              <summary className="muted">Conversation so far ({conv.history.length})</summary>
              {conv.history.map((h, i) => (
                <div key={i} className={`outreach-item ${h.type}`}>
                  <div className="muted" style={{ fontSize: 11.5 }}>{h.type === "sent" ? `You sent: ${h.label}` : "They replied"} · {new Date(h.at).toLocaleDateString()}</div>
                  {h.body && <div className="outreach-body">{h.body}</div>}
                </div>
              ))}
            </details>
          )}

          {conv.step.kind === "send" && message && (
            <>
              <textarea className="outreach-message" rows={Math.min(14, Math.max(5, text.split("\n").length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
              {message.missing.filter((m) => text.includes(`[${m}]`)).length > 0 && (
                <div className="error">Missing: {message.missing.filter((m) => text.includes(`[${m}]`)).map((m) => `[${m}]`).join(", ")}. Ask an admin to fill it in on Message templates, or type it in.</div>
              )}
              {message.violations.filter((v) => v.severity === "block").map((v, i) => <div key={i} className="error">{v.detail}</div>)}
              <div className="outreach-actions">
                <button
                  className="big"
                  onClick={() => {
                    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
                    if (lead.profileUrl) window.open(lead.profileUrl, "_blank", "noopener");
                  }}
                >
                  {copied ? "📋 Copied: paste it in their DMs" : "📋 Copy & open their DMs"}
                </button>
                <button
                  className="primary big"
                  disabled={busy || !copied}
                  title={copied ? "Record it and load the next lead" : "Copy the message first"}
                  onClick={() =>
                    void run(async () => {
                      await api.outreachSent(lead.id, { templateId: message.templateId, body: text, channel: channelFor(lead.platform), gapIndex: message.templateId.startsWith("offer") ? conv.gapIndex : null });
                      await next();
                      return `Sent to ${lead.handle ? `@${lead.handle}` : lead.name}. Next lead loaded.`;
                    })
                  }
                >
                  ✅ Sent → next lead
                </button>
              </div>
              {conv.messages.length > 1 && (
                <details className="outreach-change">
                  <summary className="muted">Use a different version</summary>
                  <div className="chips">
                    {conv.messages.map((m, i) => (
                      <button key={m.templateId} className={`chip-button ${i === pick ? "active" : ""}`} onClick={() => setPick(i)}>{m.label}</button>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {conv.step.kind === "signup" && (
            <>
              <p style={{ margin: "8px 0" }}>They sent their details. Check them and save the sign-up:</p>
              <div className="form-grid">
                {(["firstName", "lastName", "email", "code"] as const).map((k) => (
                  <label key={k} className="settings-field">
                    <span className="fl">{{ firstName: "First name", lastName: "Last name", email: "Email", code: "Their code" }[k]}</span>
                    <input value={signup[k]} onChange={(e) => setSignup({ ...signup, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
              <div className="outreach-actions">
                <button
                  className="primary big"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.outreachSignup(lead.id, signup);
                      await next();
                      return `Sign-up saved for ${signup.firstName}. Next lead loaded.`;
                    })
                  }
                >
                  ✅ Save sign-up → next lead
                </button>
              </div>
            </>
          )}

          {conv.history.at(-1)?.type === "sent" && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12.5 }}>Already replied in your DMs?</div>
              <ReplyBox text={replyText} onText={(v) => onReplyText(v, lastSentLabel)} suggestion={suggestion} kind={replyKind} onKind={setReplyKind} busy={busy} onSave={() => void logReply(lead.id)} />
            </div>
          )}

          <div className="outreach-skip">
            <button disabled={busy} onClick={() => void next(lead.id)}>Skip for now</button>
            <button disabled={busy} onClick={() => void run(async () => { await api.outreachSkip(lead.id, "gone"); await next(); return "Marked as account gone."; })}>Account gone</button>
            <button disabled={busy} onClick={() => void run(async () => { await api.outreachSkip(lead.id, "not_fit"); await next(); return "Marked as not a fit."; })}>Not a fit</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Signed in as {me.name}. Your name goes into the message automatically.</div>
        </div>
      )}
    </div>
  );
}

function ReplyBox({ text, onText, suggestion, kind, onKind, busy, onSave }: { text: string; onText: (v: string) => void; suggestion: ReplySuggestion | null; kind: ReplySuggestion["kind"] | null; onKind: (k: ReplySuggestion["kind"]) => void; busy: boolean; onSave: () => void }) {
  return (
    <div className="reply-box">
      <textarea rows={3} value={text} onChange={(e) => onText(e.target.value)} placeholder="Paste their reply here" style={{ width: "100%" }} />
      {suggestion && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Looks like <strong>{REPLY_OPTIONS.find(([k]) => k === suggestion.kind)?.[1]}</strong> ({suggestion.reason}{suggestion.source === "ai" ? ", read by AI" : ""}). Change it if that's wrong.
        </div>
      )}
      <div className="chips" style={{ margin: "6px 0" }}>
        {REPLY_OPTIONS.map(([k, label]) => (
          <button key={k} type="button" className={`chip-button ${kind === k ? "active" : ""}`} onClick={() => onKind(k)}>{label}</button>
        ))}
      </div>
      <button className="primary" disabled={busy || !kind} onClick={onSave}>Save reply → show next message</button>
    </div>
  );
}
