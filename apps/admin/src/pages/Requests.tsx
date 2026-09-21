// Everything people asked for in Telegram. The assistant answers them there and logs anything that
// needs a person here, with what it replied — including the times it argued back.

import { useCallback, useEffect, useState } from "react";
import { api, type Me, type TaskRow } from "../api.js";
import { Empty, PageHeader, PageInfo } from "../components.js";
import { toast, toastError } from "../toast.js";

const STATUS_LABEL: Record<string, string> = { open: "Open", doing: "In progress", done: "Done", declined: "Not doing" };
const STATUS_CHIP: Record<string, string> = { open: "unresolved", doing: "internal", done: "ok", declined: "failed" };
const KIND_LABEL: Record<string, string> = { change: "Change", bug: "Problem", idea: "Idea", question: "Question" };
const FILTERS: Array<[string, string]> = [["open", "Open"], ["doing", "In progress"], ["done", "Done"], ["declined", "Not doing"], ["all", "All"]];

export function Requests({ me }: { me: Me }) {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = me.role === "admin" || me.role === "ops";

  const load = useCallback(async () => {
    try {
      const d = await api.tasks(filter);
      setRows(d.rows);
      setCounts(d.counts);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (t: TaskRow, status: string) => {
    setBusy(true);
    try {
      await api.taskStatus(t.id, status);
      toast(`#${t.id} marked ${STATUS_LABEL[status]?.toLowerCase() ?? status}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
      toastError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageInfo title="Requests — what people asked for in Telegram">
        The assistant answers questions in the team chat from live data. Anything that asks for a change, reports a
        problem or proposes an idea lands here, with what the assistant replied. A <strong>pushed back</strong> tag means
        it told them the request would not work and offered something else, so read that reply before you build anything.
      </PageInfo>

      <PageHeader title="Requests">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? "primary" : ""} onClick={() => setFilter(f)}>
            {label}{counts[f] ? ` (${counts[f]})` : ""}
          </button>
        ))}
      </PageHeader>

      {error && <div className="error">{error}</div>}
      {rows.length === 0 && <Empty emoji="💬">Nothing here. Requests appear the moment somebody asks for something in the Telegram chat.</Empty>}

      {rows.map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: 10 }}>
          <div className="toolbar" style={{ margin: 0, alignItems: "baseline" }}>
            <span className={`chip ${STATUS_CHIP[t.status] ?? "unresolved"}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
            <strong>#{t.id} {t.title}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{KIND_LABEL[t.kind] ?? t.kind}</span>
            {t.pushedBack && <span className="chip suggest" title="The assistant explained why this would not work and offered an alternative">pushed back</span>}
            <div className="grow" />
            <span className="muted" style={{ fontSize: 12 }}>
              {t.askedBy ?? "someone"}{t.chatTitle ? ` · ${t.chatTitle}` : ""} · {new Date(t.createdAt).toLocaleString()}
            </span>
          </div>
          {t.detail && t.detail !== t.title && <div className="outreach-body" style={{ marginTop: 8 }}>{t.detail}</div>}
          {t.reply && (
            <>
              <div className="k" style={{ marginTop: 10 }}>What the assistant replied</div>
              <div className="outreach-body">{t.reply}</div>
            </>
          )}
          {canEdit && (
            <div className="modal-actions" style={{ marginTop: 10 }}>
              <div className="grow" />
              {t.status !== "doing" && <button disabled={busy} onClick={() => void setStatus(t, "doing")}>Working on it</button>}
              {t.status !== "done" && <button className="primary" disabled={busy} onClick={() => void setStatus(t, "done")}>Done</button>}
              {t.status !== "declined" && <button disabled={busy} onClick={() => void setStatus(t, "declined")}>Not doing</button>}
              {t.status !== "open" && <button disabled={busy} onClick={() => void setStatus(t, "open")}>Reopen</button>}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
