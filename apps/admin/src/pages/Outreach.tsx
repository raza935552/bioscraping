// The outreach person's page: one lead at a time, the message ready to copy, one button to move on.
// The system decides the order (replies to answer, check-ins due, new leads) and the wording. Each
// lead gets its own card (keyed by lead id), so nothing typed for one lead can carry over to the next.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Me, type OutreachWork, type ReplySuggestion } from "../api.js";
import { REPLY_OPTIONS, channelFor, compact, copyText, splitName, suggestCode, type ReplyKind } from "../outreachShared.js";

const BUCKET_LABEL: Record<string, string> = {
  answer: "They replied: send the next message",
  checkin: "No reply yet: send a check-in",
  new: "New lead: send the first message",
};

type SignupDetails = ReplySuggestion["details"];

export function Outreach({ me }: { me: Me }) {
  const [work, setWork] = useState<OutreachWork | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [tab, setTab] = useState<"next" | "waiting">("next");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  // Sign-up details read from a reply, handed to the next card for that lead.
  const [details, setDetails] = useState<{ leadId: number; d: SignupDetails } | null>(null);
  const current = useRef<number | null>(null);

  const load = useCallback(async (skip: number[], lead?: number | null) => {
    setLoading(true);
    setErr("");
    try {
      const w = await api.outreachWork(skip, lead);
      setWork(w);
      current.current = w.lead?.id ?? null;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load([]);
    // Let go of the lead this person was holding when they leave the page.
    return () => {
      if (current.current) void api.outreachRelease(current.current).catch(() => {});
    };
  }, [load]);

  const next = async (opts: { skip?: number; message?: string } = {}) => {
    const skip = opts.skip != null ? [...skipped, opts.skip] : skipped;
    if (opts.skip != null) setSkipped(skip);
    setNote(opts.message ?? "");
    await load(skip);
    window.scrollTo({ top: 0 });
  };

  const c = work?.counts;
  const lead = work?.lead ?? null;

  return (
    <div className="outreach-page">
      <div className="outreach-counts">
        <div><strong>{c?.sentTodayByMe ?? 0}</strong> sent by you today</div>
        <div><strong>{c?.answer ?? 0}</strong> replies to answer</div>
        <div><strong>{c?.checkin ?? 0}</strong> check-ins due</div>
        <div><strong>{c?.new ?? 0}</strong> new leads</div>
      </div>

      <div className="toolbar" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className={tab === "next" ? "primary" : ""} onClick={() => setTab("next")}>Next up</button>
        <button className={tab === "waiting" ? "primary" : ""} onClick={() => setTab("waiting")}>Waiting for reply ({c?.waiting ?? 0})</button>
        {skipped.length > 0 && (
          <button onClick={() => { setSkipped([]); void load([]); }} title="Bring back the leads you skipped">Show skipped again ({skipped.length})</button>
        )}
      </div>

      {err && <div className="error">{err}</div>}
      {note && !err && <div className="notice">{note}</div>}

      {tab === "waiting" && work && (
        <div className="outreach-card">
          <p className="muted" style={{ marginTop: 0 }}>Got a reply in your DMs? Find the person here and paste what they said. The next message is ready straight away.</p>
          {work.waiting.length === 0 && <div className="muted">Nobody is waiting for a reply.</div>}
          {work.waiting.map((w) => (
            <WaitingRow
              key={w.leadId}
              w={w}
              onSaved={async (kind, d) => {
                if (d && (d.email || d.code || d.firstName)) setDetails({ leadId: w.leadId, d });
                setTab("next");
                setNote(`Reply saved (${REPLY_OPTIONS.find(([k]) => k === kind)?.[1]}). Here's what to send next.`);
                await load(skipped.filter((id) => id !== w.leadId), w.leadId);
              }}
            />
          ))}
        </div>
      )}

      {tab === "next" && work && !lead && (
        <div className="outreach-card">
          <h2 style={{ marginTop: 0 }}>All done 🎉</h2>
          <p className="muted">
            Nothing to send right now.{skipped.length > 0 ? ` You skipped ${skipped.length}: use "Show skipped again" to see them.` : ""} When replies come in, open "Waiting for reply".
          </p>
        </div>
      )}

      {tab === "next" && lead && work?.conversation && work.next && (
        <LeadCard
          key={`${lead.id}:${work.conversation.history.length}`}
          me={me}
          work={work}
          busyLoading={loading}
          presetDetails={details?.leadId === lead.id ? details.d : null}
          onNext={(message) => void next({ message })}
          onSkip={() => void next({ skip: lead.id, message: "Skipped for now." })}
          onDetails={(d) => setDetails({ leadId: lead.id, d })}
          onReloadSame={async () => load(skipped, lead.id)}
        />
      )}
    </div>
  );
}

function LeadCard({
  me,
  work,
  busyLoading,
  presetDetails,
  onNext,
  onSkip,
  onDetails,
  onReloadSame,
}: {
  me: Me;
  work: OutreachWork;
  busyLoading: boolean;
  presetDetails: SignupDetails | null;
  onNext: (message: string) => void;
  onSkip: () => void;
  onDetails: (d: SignupDetails) => void;
  onReloadSame: () => Promise<void>;
}) {
  const lead = work.lead!;
  const conv = work.conversation!;
  const [pick, setPick] = useState(0);
  const message = conv.messages[pick] ?? conv.messages[0] ?? null;
  const [text, setText] = useState(message?.text ?? "");
  const [check, setCheck] = useState<{ blocked: boolean; problems: string[] }>({ blocked: !!message?.blocked, problems: [] });
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<"gone" | "not_fit" | null>(null);
  const name = splitName(lead.name);
  const [signup, setSignup] = useState({
    firstName: presetDetails?.firstName ?? name.firstName,
    lastName: presetDetails?.lastName ?? name.lastName,
    email: presetDetails?.email ?? lead.email ?? "",
    code: presetDetails?.code ?? suggestCode(name.firstName, name.lastName),
  });
  const textRef = useRef<HTMLTextAreaElement>(null);

  // A different version resets the text.
  useEffect(() => {
    setText(message?.text ?? "");
    setCopied("no");
  }, [message?.templateId, message?.text]);

  // Check the text as edited (placeholders, compliance) before it can be copied.
  useEffect(() => {
    if (!message) return;
    let stale = false;
    const t = window.setTimeout(() => {
      void api.outreachCheck(lead.id, text, message.templateId).then((r) => {
        if (stale) return;
        setCheck({ blocked: r.blocked, problems: [...r.placeholders.map((p) => `Fill in [${p}] (ask an admin to set it on Message templates, or type it in).`), ...r.violations.map((v) => v.detail), ...(text.trim().length < 5 ? ["The message is empty."] : [])] });
      }).catch(() => {});
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [text, lead.id, message]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const noDm = !lead.dmUrl;
  const handleLabel = lead.handle ? `@${lead.handle}` : lead.name;
  const lastSentLabel = conv.history.filter((h) => h.type === "sent").at(-1)?.label ?? null;

  return (
    <div className="outreach-card">
      <div className="muted" style={{ fontSize: 12.5 }}>{BUCKET_LABEL[work.next!.bucket]}</div>
      <h2 style={{ margin: "4px 0" }}>
        {handleLabel}{" "}
        <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>
          · {lead.platform ?? ""}{lead.followers != null ? ` · ${compact(lead.followers)} followers` : ""}
        </span>
      </h2>
      {lead.competitor && (
        <div className="muted" style={{ fontSize: 13 }}>
          Promotes <strong>{lead.competitor}</strong>
          {lead.code ? <> (code <code>{lead.code}</code>)</> : null}
          {lead.evidence && <div className="bubble-quote">“{lead.evidence.quote}”</div>}
        </div>
      )}

      {conv.history.length > 0 && (
        <details className="outreach-change" open={work.next!.bucket === "answer"}>
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
          <ol className="outreach-steps">
            <li><strong>Copy the message</strong></li>
            <li>
              {noDm ? (
                <>Send it where you can reach them{lead.email ? <> (email: <strong>{lead.email}</strong>)</> : null}</>
              ) : lead.dmKind === "search" ? (
                <>We don't have their handle: search <strong>{lead.name}</strong> on {lead.platform}, check it's them, and paste it in a DM</>
              ) : (
                <>Open <strong>{handleLabel}</strong> on {lead.platform} and paste it in a DM</>
              )}
            </li>
            <li>Come back and press <strong>I sent it</strong></li>
          </ol>
          <textarea ref={textRef} className="outreach-message" rows={Math.min(14, Math.max(5, text.split("\n").length + 1))} value={text} onChange={(e) => { setText(e.target.value); setCopied("no"); }} aria-label="Message to send" />
          {check.problems.map((p, i) => <div key={i} className="error">{p}</div>)}
          <div className="outreach-actions">
            <button
              className="big"
              disabled={check.blocked}
              onClick={() => void copyText(text, textRef.current).then((ok) => setCopied(ok ? "yes" : "failed"))}
            >
              {copied === "yes" ? "✓ Copied" : "📋 Copy message"}
            </button>
            {lead.dmUrl ? (
              <a className="btn-link big" href={lead.dmUrl} target="_blank" rel="noreferrer">
                {lead.dmKind === "search" ? `Search "${lead.name}" on ${lead.platform} ↗` : `Open ${handleLabel} on ${lead.platform} ↗`}
              </a>
            ) : (
              <span className="muted" style={{ alignSelf: "center" }}>{lead.platform ?? "This platform"} has no DMs{lead.email ? ": email them instead" : ""}.</span>
            )}
          </div>
          {copied === "failed" && <div className="error">Couldn't copy automatically. The text is selected: press Ctrl+C (or long-press → Copy on a phone).</div>}
          <div className="outreach-actions">
            <button
              className="primary big"
              disabled={busy || busyLoading || check.blocked}
              onClick={() =>
                void run(async () => {
                  await api.outreachSent(lead.id, { templateId: message.templateId, body: text, channel: noDm && lead.email ? "Email" : channelFor(lead.platform), gapIndex: message.templateId.startsWith("offer") ? conv.gapIndex : null });
                  onNext(`Recorded: sent to ${handleLabel}. Next lead loaded.`);
                })
              }
            >
              ✅ I sent it → next lead
            </button>
          </div>
          {conv.messages.length > 1 && (
            <details className="outreach-change">
              <summary className="muted">Use a different version</summary>
              <div className="chips">
                {conv.messages.map((m, i) => (
                  <button key={m.templateId} className={`chip-button ${i === pick ? "active" : ""}`} onClick={() => setPick(i)}>{m.label.replace(/^Offer 1 · |^Offer 2 · /, "")}</button>
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
                <span className="fl">{{ firstName: "First name", lastName: "Last name", email: "Email", code: "Their code (like JOHND10)" }[k]}</span>
                <input value={signup[k]} onChange={(e) => setSignup({ ...signup, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="outreach-actions">
            <button
              className="primary big"
              disabled={busy || busyLoading}
              onClick={() =>
                void run(async () => {
                  await api.outreachSignup(lead.id, signup);
                  onNext(`Sign-up saved for ${signup.firstName}. Next lead loaded.`);
                })
              }
            >
              ✅ Save sign-up → next lead
            </button>
          </div>
        </>
      )}

      {conv.step.kind === "wait" && <div className="notice">Waiting for their reply. A check-in is due {new Date(conv.step.dueAt).toLocaleDateString()}.</div>}
      {conv.step.kind === "done" && <div className="notice">{conv.step.why}</div>}

      {conv.history.at(-1)?.type === "sent" && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>Already replied in your DMs?</div>
          <ReplyBox
            leadId={lead.id}
            lastLabel={lastSentLabel}
            onSaved={async (kind, d) => {
              if (d && (d.email || d.code || d.firstName)) onDetails(d);
              await onReloadSame();
            }}
          />
        </div>
      )}

      {err && <div className="error">{err}</div>}

      <div className="outreach-skip">
        <button disabled={busy} onClick={() => { void api.outreachRelease(lead.id).catch(() => {}); onSkip(); }}>Skip for now</button>
        {confirm ? (
          <>
            <span className="muted">{confirm === "gone" ? "Mark the account as gone? It leaves the list for good." : "Mark as not a fit? It leaves the list for good."}</span>
            <button className="primary" disabled={busy} onClick={() => void run(async () => { await api.outreachSkip(lead.id, confirm); onNext(confirm === "gone" ? "Marked as account gone." : "Marked as not a fit."); })}>Yes</button>
            <button onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => setConfirm("gone")}>Account gone</button>
            <button disabled={busy} onClick={() => setConfirm("not_fit")}>Not a fit</button>
          </>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Signed in as {me.name}. Your first name goes into the message automatically.</div>
    </div>
  );
}

function WaitingRow({ w, onSaved }: { w: OutreachWork["waiting"][number]; onSaved: (kind: ReplyKind, d: SignupDetails | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="waiting-row">
      <div>
        <strong>{w.handle ? `@${w.handle}` : w.name}</strong> <span className="muted">· {w.platform ?? ""}</span>
        {w.dmUrl && <> · <a href={w.dmUrl} target="_blank" rel="noreferrer">open ↗</a></>}
        <div className="muted" style={{ fontSize: 12 }}>
          Sent {w.lastLabel} on {new Date(w.sentAt).toLocaleDateString()} · check-in {new Date(w.dueAt).toLocaleDateString()}
        </div>
      </div>
      {open ? <ReplyBox leadId={w.leadId} lastLabel={w.lastLabel} onSaved={onSaved} /> : <button onClick={() => setOpen(true)}>They replied</button>}
    </div>
  );
}

export function ReplyBox({ leadId, lastLabel, onSaved }: { leadId: number; lastLabel: string | null; onSaved: (kind: ReplyKind, d: SignupDetails | null) => Promise<void> }) {
  const [text, setText] = useState("");
  const [suggestion, setSuggestion] = useState<ReplySuggestion | null>(null);
  const [kind, setKind] = useState<ReplyKind | null>(null);
  const [picked, setPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Suggest the button as they paste; ignore answers for older text, and never override a manual pick.
  useEffect(() => {
    if (!text.trim()) {
      setSuggestion(null);
      if (!picked) setKind(null);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      void api.outreachClassify(text, lastLabel).then((s) => {
        if (stale) return;
        setSuggestion(s);
        if (!picked) setKind(s.kind);
      }).catch(() => {});
    }, 400);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [text, lastLabel, picked]);

  return (
    <div className="reply-box">
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste their reply here" style={{ width: "100%" }} aria-label="Their reply" />
      {suggestion && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Looks like <strong>{REPLY_OPTIONS.find(([k]) => k === suggestion.kind)?.[1]}</strong> ({suggestion.reason}). Change it if that's wrong.
        </div>
      )}
      <div className="chips" style={{ margin: "6px 0" }}>
        {REPLY_OPTIONS.map(([k, label, help]) => (
          <button key={k} type="button" title={help} className={`chip-button ${kind === k ? "active" : ""}`} onClick={() => { setKind(k); setPicked(true); }}>{label}</button>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      <button
        className="primary"
        disabled={busy || !kind || !text.trim()}
        title={!text.trim() ? "Paste their reply first" : !kind ? "Pick what they replied" : ""}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await api.outreachReply(leadId, { kind: kind!, body: text, channel: "dm" });
            await onSaved(kind!, suggestion?.details ?? null);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save reply → show next message
      </button>
    </div>
  );
}
