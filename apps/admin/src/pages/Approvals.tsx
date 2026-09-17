import { useCallback, useEffect, useState } from "react";
import { PageInfo, PageHeader } from "../components.js";
import { toastError } from "../toast.js";
import { api, type Me, type MessageRow } from "../api.js";

// Plain-language names for the message states.
const TABS: Array<[string, string]> = [
  ["linted", "To review"],
  ["approved", "Ready to send"],
  ["sent", "Sent"],
  ["blocked", "Blocked"],
];

// Map a lead's platform to the exact DM channel we log.
function channelFor(platform: string | null): string {
  const p = (platform ?? "").toLowerCase();
  if (p.includes("instagram")) return "Instagram DM";
  if (p.includes("tiktok")) return "TikTok DM";
  if (p.includes("reddit")) return "Reddit DM";
  if (p.includes("facebook")) return "Facebook DM";
  return "Other";
}

export function Approvals({ me }: { me: Me }) {
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [tab, setTab] = useState("linted");
  const [chan, setChan] = useState<"all" | "dm" | "email">("all");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.messages(tab));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const canAct = me.role === "admin" || me.role === "ops" || me.role === "operator";
  const shown = rows.filter((m) => (chan === "all" ? true : chan === "email" ? m.channel === "email" : m.channel !== "email"));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (m: MessageRow) => {
    void navigator.clipboard?.writeText(edits[m.id] ?? m.body ?? "");
    setCopied(m.id);
    setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
  };

  return (
    <>
      <PageInfo title="Approvals — send messages">
        This is where you send outreach. Read each message, tweak it if you want, then <strong>Approve</strong>. Emails
        send themselves. For DMs, you copy the message and send it from the @biolinx account, then tap <strong>I sent
        it</strong>. Nothing goes out without you here.
      </PageInfo>

      <PageHeader title="Send messages" />

      <div className="toolbar">
        {TABS.map(([t, label]) => (
          <button key={t} className={`bigtab ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        <div className="grow" />
        <span className="muted" style={{ fontSize: 13 }}>Show:</span>
        {(["all", "dm", "email"] as const).map((c) => (
          <button key={c} className={chan === c ? "primary" : ""} onClick={() => setChan(c)}>
            {c === "all" ? "All" : c === "dm" ? "💬 DMs" : "✉️ Email"}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {shown.length === 0 && (
        <div className="empty">
          <div className="empty-emoji">{tab === "blocked" ? "🛡️" : "📭"}</div>
          <p>
            {tab === "linted" && "No messages waiting for review. Prepare drafts from the Leads or Email page."}
            {tab === "approved" && "Nothing waiting to be sent by hand right now."}
            {tab === "sent" && "No messages sent yet."}
            {tab === "blocked" && "Nothing blocked — every draft passed the compliance check."}
          </p>
        </div>
      )}

      {shown.map((m) => {
        const isEmail = m.channel === "email";
        const bodyVal = edits[m.id] ?? m.body ?? "";
        return (
          <div className="msg" key={m.id}>
            <div className="msg-head">
              <span className="who">{m.leadName}</span>
              <span className={`chip ${isEmail ? "internal" : "unresolved"}`}>{isEmail ? "✉️ Email" : `💬 ${m.platform ?? "DM"}`}</span>
              <span className="muted small">message #{m.touchNumber}</span>
            </div>

            {isEmail && m.subject && tab === "linted" && (
              <input
                className="subject"
                defaultValue={m.subject}
                onChange={(e) => void api.editMessage(m.id, { subject: e.target.value }).catch(() => {})}
              />
            )}
            {isEmail && m.subject && tab !== "linted" && <div className="subject-ro">Subject: {m.subject}</div>}

            {tab === "linted" ? (
              <textarea className="editor" value={bodyVal} onChange={(e) => setEdits((p) => ({ ...p, [m.id]: e.target.value }))} rows={5} />
            ) : (
              <div className="msg-body">{m.body}</div>
            )}

            {tab === "blocked" && Array.isArray(m.lintReport) && m.lintReport.length > 0 && (
              <div className="blocknote">
                🛡️ Blocked by the compliance check: {(m.lintReport as Array<{ rule: string; detail: string }>).map((v) => v.detail).join("; ")}
              </div>
            )}

            {/* ACTIONS */}
            {canAct && tab === "linted" && (
              <div className="actions">
                {isEmail ? (
                  <button
                    className="go"
                    disabled={busy}
                    onClick={() => void act(() => api.approveMessage(m.id, m.subject ? { body: bodyVal, subject: m.subject } : { body: bodyVal }))}
                  >
                    ✓ Approve &amp; send email
                  </button>
                ) : (
                  <button className="go" disabled={busy} onClick={() => void act(() => api.approveMessage(m.id, { body: bodyVal }))}>
                    ✓ Approve — I'll send this DM
                  </button>
                )}
              </div>
            )}

            {canAct && tab === "approved" && !isEmail && (
              <div className="steps">
                <div className="step">
                  <span className="step-n">1</span>
                  <button onClick={() => copy(m)}>📋 {copied === m.id ? "Copied!" : "Copy message"}</button>
                </div>
                <div className="step">
                  <span className="step-n">2</span>
                  {m.profileUrl && /^https?:\/\//i.test(m.profileUrl) ? (
                    <a href={m.profileUrl} target="_blank" rel="noreferrer"><button>↗ Open {m.platform ?? "profile"} &amp; paste</button></a>
                  ) : (
                    <span className="muted small">no profile link — find them on {m.platform ?? "the platform"}</span>
                  )}
                </div>
                <div className="step">
                  <span className="step-n">3</span>
                  <button className="go" disabled={busy} onClick={() => void act(() => api.markSent(m.id, channelFor(m.platform)))}>
                    ✓ I sent it
                  </button>
                </div>
              </div>
            )}

            {tab === "sent" && <div className="sent-note">✓ Sent</div>}
          </div>
        );
      })}
    </>
  );
}
