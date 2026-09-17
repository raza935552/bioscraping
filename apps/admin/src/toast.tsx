// Short confirmations that don't hide at the bottom of a card: "Recorded: Offer 1 sent" belongs where
// the eye already is. One host lives in App; any page calls toast()/toastError() from anywhere.

import { useEffect, useState } from "react";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function publish() {
  for (const l of listeners) l([...toasts]);
}

function push(text: string, kind: Toast["kind"]): void {
  const t = { id: nextId++, text: text.trim(), kind };
  if (!t.text) return;
  toasts = [...toasts.filter((x) => x.text !== t.text), t].slice(-4);
  publish();
  // Errors stay up long enough to read twice; confirmations get out of the way.
  window.setTimeout(() => dismiss(t.id), kind === "error" ? 9000 : 4500);
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

/** Something worked. */
export function toast(text: string): void {
  push(text, "ok");
}

/** Something didn't. Errors are still shown in place too; this makes sure they're noticed. */
export function toastError(text: string): void {
  push(text, "error");
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setItems);
    setItems([...toasts]);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <button key={t.id} type="button" className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} title="Dismiss">
          <span className="toast-icon">{t.kind === "ok" ? "✓" : "⚠"}</span>
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
