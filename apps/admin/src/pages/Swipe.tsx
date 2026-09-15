import { useCallback, useEffect, useState } from "react";
import { api, type Me, type SwipePayload, type SwipePost } from "../api.js";
import { Modal, PageInfo } from "../components.js";

const TABS: Array<[string, string]> = [
  ["draft", "Drafts"],
  ["approved", "Approved"],
  ["sent", "Sent"],
  ["rejected", "Rejected"],
  ["failed", "Failed"],
  ["declined", "Declined"],
  ["all", "All"],
];

const DECLINE_CHIPS = [
  "The hook doesn't stop the scroll. Make the first line sharper and more specific.",
  "Too salesy. Make it sound like a real person talking to a friend.",
  "Wrong angle for this niche. Focus on COA testing and supplier trust.",
  "Too long. Cut it to 3 short lines plus the code.",
  "The image idea doesn't fit. Use a clean Biolinx vial with a COA, no people.",
];

const isHttps = (u: string | null | undefined): u is string => !!u && /^https:\/\//i.test(u);
const fmt = (n: number | null | undefined) => (n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

const STATUS_CHIP: Record<string, string> = {
  draft: "unresolved",
  approved: "internal",
  sending: "internal",
  sent: "ok",
  duplicate: "unresolved",
  rejected: "failed",
  failed: "failed",
  declined: "failed",
};

export function Swipe({ me }: { me: Me }) {
  const [tab, setTab] = useState("draft");
  const [data, setData] = useState<SwipePayload | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [editing, setEditing] = useState<SwipePost | null>(null);
  const [declining, setDeclining] = useState<SwipePost | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.swipe(tab));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setMsg("");
    try {
      const m = await fn();
      if (m) setMsg(m);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const c = data?.connection;
  const counts = data?.counts ?? {};

  return (
    <>
      <PageInfo title="Swipe file — posts for the affiliate content library">
        The engine studies posts that beat their creator's usual views, writes original Biolinx posts from them, and checks
        every word against Biolinx's rules. <strong>Biolinx checks compliance, not quality</strong>, so the quality call
        happens here: approve the posts worth sending, or decline and say what should change to get a new version.
        Nothing is sent without Approve. Sent posts arrive at Biolinx as drafts and reach affiliates only after Publish on
        its Assets tab.
      </PageInfo>

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ margin: 0, flexWrap: "wrap", gap: 10 }}>
          <strong>Biolinx connection:</strong>
          {c?.configured ? <span className="chip ok">secret saved</span> : <span className="chip failed">no secret yet</span>}
          <span className={`chip ${c?.autoSend ? "ok" : "unresolved"}`}>{c?.autoSend ? "auto-send every 10 min" : "send manually"}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            Callback URL for Biolinx: <code className="inline">{c?.callbackUrl ?? "…"}</code>
          </span>
          <div className="grow" />
          {me.role === "admin" && (
            <button disabled={!c?.configured || busy === "test"} onClick={() => void run("test", async () => (await api.swipeTestConnection()).message)}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
          )}
          <button
            disabled={!c?.configured || busy === "send" || !((counts.approved ?? 0) > 0)}
            onClick={() =>
              void run("send", async () => {
                const r = (await api.swipeSend()).result;
                return r.error ? `Send stopped: ${r.error}` : `Sent ${r.sent}: ${r.accepted} accepted, ${r.duplicates} duplicates, ${r.rejected} rejected. ${r.remainingToday ?? "?"} left today.`;
              })
            }
          >
            {busy === "send" ? "Sending…" : `Send approved now (${counts.approved ?? 0})`}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="notice">{msg}</div>}

      <div className="toolbar">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "primary" : ""} onClick={() => setTab(k)}>
            {label}
            {k !== "all" && counts[k] ? ` (${counts[k]})` : ""}
          </button>
        ))}
        <div className="grow" />
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 80 }}>
          {[1, 3, 5, 10].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={busy === "gen"}
          title="Writes new drafts from the best unused outperforming posts (uses Claude credit, a few cents each)"
          onClick={() =>
            void run("gen", async () => {
              const r = (await api.swipeGenerate(count)).result;
              setTab("draft");
              return `Wrote ${r.created} new draft${r.created === 1 ? "" : "s"} from ${r.considered} outperforming posts.${r.failed.length ? ` ${r.failed.length} couldn't pass the rules and were skipped.` : ""}`;
            })
          }
        >
          {busy === "gen" ? "Writing posts…" : "Generate posts"}
        </button>
      </div>

      {!data && !error && <div className="muted">Loading…</div>}
      {data && data.posts.length === 0 && (
        <div className="empty">
          <p>Nothing here yet. Press Generate posts to write drafts from the best outperforming posts the engine has read.</p>
        </div>
      )}

      <div className="swipe-grid">
        {data?.posts.map((p) => (
          <SwipeCard
            key={p.id}
            p={p}
            busy={busy}
            onApprove={() => void run(`a${p.id}`, async () => (await api.swipeApprove(p.id), "Approved. It will go out on the next send."))}
            onEdit={() => setEditing(p)}
            onDecline={() => setDeclining(p)}
            onRefresh={() => void run(`r${p.id}`, async () => (await api.swipeRefresh(p.id), "Status refreshed from Biolinx."))}
          />
        ))}
      </div>

      {editing && (
        <EditDialog
          post={editing}
          onClose={() => setEditing(null)}
          onSaved={async (m) => {
            setEditing(null);
            setMsg(m);
            await load();
          }}
        />
      )}
      {declining && (
        <DeclineDialog
          post={declining}
          onClose={() => setDeclining(null)}
          onDone={async () => {
            setDeclining(null);
            setMsg("Declined. A new version was written from your notes and is in Drafts.");
            setTab("draft");
            await load();
          }}
        />
      )}
    </>
  );
}

function SwipeCard({ p, busy, onApprove, onEdit, onDecline, onRefresh }: { p: SwipePost; busy: string | null; onApprove: () => void; onEdit: () => void; onDecline: () => void; onRefresh: () => void }) {
  const s = p.sourceStats ?? {};
  const problems = p.preflight ?? [];
  const img = p.mediaUrl ?? p.imageUrl;
  const editable = ["draft", "approved", "rejected", "failed"].includes(p.status);
  return (
    <div className="swipe-card">
      <div className={`swipe-img ${p.format}`}>
        {isHttps(img) ? (
          <img src={img} alt="" loading="lazy" />
        ) : (
          <div className="swipe-img-empty">
            <div className="k">Image needed</div>
            {p.imageText && <div className="v">“{p.imageText}”</div>}
            {p.imageBrief && <div className="s">{p.imageBrief}</div>}
          </div>
        )}
      </div>
      <div className="swipe-body">
        <div className="chips">
          <span className={`chip ${STATUS_CHIP[p.status] ?? "unresolved"}`}>{p.status}</span>
          {p.biolinxStatus && <span className={`chip ${p.biolinxStatus === "published" ? "ok" : p.biolinxStatus === "failed" ? "failed" : "internal"}`}>Biolinx: {p.biolinxStatus.replace("_", " ")}</span>}
          {p.imageCheck && <span className={`chip ${p.imageCheck === "passed" ? "ok" : "failed"}`}>image text: {p.imageCheck}</span>}
          <span className="chip internal">{p.platform}</span>
          <span className="chip internal">{p.format}</span>
          <span className="chip internal">{p.biolinxNiche}</span>
          {p.hookType && <span className="chip suggest">{p.hookType}</span>}
          {p.version > 1 && <span className="chip unresolved">v{p.version}</span>}
        </div>
        <div className="swipe-hook">{p.hook}</div>
        <div className="swipe-caption">
          {p.caption.split("{CODE}").map((part, i, arr) => (
            <span key={i}>
              {part}
              {i < arr.length - 1 && <mark>{"{CODE}"}</mark>}
            </span>
          ))}
        </div>
        {p.hashtags?.length ? <div className="muted" style={{ fontSize: 12 }}>{p.hashtags.map((h) => `#${h}`).join(" ")}</div> : null}
        {p.angle && <div className="muted" style={{ fontSize: 12 }}>Angle: {p.angle}</div>}
        <div className="muted" style={{ fontSize: 12 }}>
          Inspired by{" "}
          {p.sourcePostUrl ? (
            <a href={p.sourcePostUrl} target="_blank" rel="noreferrer">
              a {p.sourcePlatform ?? ""} post ↗
            </a>
          ) : (
            "a post"
          )}{" "}
          · {fmt(s.views)} views · {s.outlierRatio ?? "?"}× the creator's average
        </div>
        {p.reviewerFeedback && <div className="muted" style={{ fontSize: 12 }}>Declined with: “{p.reviewerFeedback}”</div>}
        {problems.length > 0 && (
          <ul className="swipe-problems">
            {problems.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {p.reasons?.length ? (
          <ul className="swipe-problems">
            {p.reasons.map((r, i) => (
              <li key={i}>Biolinx: {r}</li>
            ))}
          </ul>
        ) : null}
        {p.issues?.length ? (
          <ul className="swipe-problems">
            {p.issues.map((r, i) => (
              <li key={i}>Image text: {r}</li>
            ))}
          </ul>
        ) : null}
        {p.error && <div className="error" style={{ fontSize: 12 }}>{p.error}</div>}
        <div className="modal-actions">
          {p.status === "draft" && (
            <button className="primary" disabled={busy === `a${p.id}` || !p.imageUrl || problems.length > 0} title={!p.imageUrl ? "Add the image first" : problems.length ? "Fix the problems first" : "Send on the next run"} onClick={onApprove}>
              Approve
            </button>
          )}
          {editable && <button onClick={onEdit}>Edit</button>}
          {editable && <button onClick={onDecline}>Decline…</button>}
          {p.status === "sent" && (
            <button disabled={busy === `r${p.id}`} onClick={onRefresh}>
              Refresh status
            </button>
          )}
          {isHttps(p.mediaUrl) && (
            <a className="btn-link" href={p.mediaUrl} target="_blank" rel="noreferrer">
              Biolinx image ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function EditDialog({ post, onClose, onSaved }: { post: SwipePost; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [hook, setHook] = useState(post.hook);
  const [caption, setCaption] = useState(post.caption);
  const [hashtags, setHashtags] = useState((post.hashtags ?? []).join(" "));
  const [imageText, setImageText] = useState(post.imageText ?? "");
  const [imageUrl, setImageUrl] = useState(post.imageUrl ?? "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const r = await api.swipeEdit(post.id, { hook, caption, hashtags, imageText, imageUrl: imageUrl.trim() || null });
      await onSaved(r.preflight.length ? `Saved, but it still breaks ${r.preflight.length} rule${r.preflight.length === 1 ? "" : "s"}.` : "Saved. It passes every rule.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Edit post" subtitle={`${post.platform} · ${post.format} · ${post.biolinxNiche}`} onClose={onClose} wide={false}>
      <label className="settings-field">
        <span className="fl">Hook ({hook.length}/120)</span>
        <input value={hook} maxLength={120} onChange={(e) => setHook(e.target.value)} />
      </label>
      <label className="settings-field">
        <span className="fl">Caption ({caption.length}/2200, must contain {"{CODE}"} once)</span>
        <textarea rows={9} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </label>
      <label className="settings-field">
        <span className="fl">Hashtags</span>
        <input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="researchpeptides coa" />
      </label>
      <label className="settings-field">
        <span className="fl">Words on the image</span>
        <input value={imageText} maxLength={120} onChange={(e) => setImageText(e.target.value)} />
      </label>
      <label className="settings-field">
        <span className="fl">Image link (https, JPG/PNG/WebP, at least 300×300)</span>
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        {post.imageBrief && <span className="fh">Brief: {post.imageBrief}</span>}
      </label>
      {err && <div className="error">{err}</div>}
      <div className="modal-actions">
        <div className="grow" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Checking…" : "Save and check"}
        </button>
      </div>
    </Modal>
  );
}

function DeclineDialog({ post, onClose, onDone }: { post: SwipePost; onClose: () => void; onDone: () => Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    setWorking(true);
    setErr("");
    try {
      await api.swipeDecline(post.id, feedback);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <Modal title="What more do you need?" subtitle="Say what's wrong and what you want instead. A new version is written from your notes." onClose={onClose} wide={false}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Declining: “{post.hook}”
      </div>
      <div className="chips" style={{ marginBottom: 8 }}>
        {DECLINE_CHIPS.map((c) => (
          <button key={c} type="button" className="chip-button" onClick={() => setFeedback((f) => (f ? `${f} ${c}` : c))}>
            {c.split(".")[0]}
          </button>
        ))}
      </div>
      <textarea rows={6} value={feedback} autoFocus onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Hook is weak. Open with the mistake people make when they buy from a supplier with no COA. Keep it under 3 lines." style={{ width: "100%" }} />
      {err && <div className="error">{err}</div>}
      <div className="modal-actions">
        <div className="grow" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={working || feedback.trim().length < 3} onClick={() => void submit()}>
          {working ? "Writing a new version…" : "Decline and write a new version"}
        </button>
      </div>
    </Modal>
  );
}
