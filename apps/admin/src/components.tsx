// Shared UI: the per-page instruction banner (what this page is for), a
// pagination control, and the plain-language labels for affiliate
// classification (DB values stay internal/external/unresolved; people see
// these words instead).

import { useEffect, useState, type ReactNode } from "react";

export type Classification = "internal" | "external" | "unresolved";

export const CLASS_LABEL: Record<Classification, string> = {
  external: "Real partner",
  internal: "Team / house",
  unresolved: "Needs a decision",
};

export const CLASS_HELP: Record<Classification, string> = {
  external: "A recruited affiliate. Counts toward the 100 goal.",
  internal: "One of us, a house account, or a test. Excluded from the count.",
  unresolved: "Nobody has confirmed which yet. The goal shows as a range until this is empty.",
};

export function ClassChip({ value }: { value: string }) {
  const c = (value in CLASS_LABEL ? value : "unresolved") as Classification;
  return (
    <span className={`chip ${c}`} title={CLASS_HELP[c]}>
      {CLASS_LABEL[c]}
    </span>
  );
}

/** The "what is this page for" banner. It folds away once you know the page, and stays folded
 *  (per page, in this browser) so the work is the first thing on screen. */
export function PageInfo({ title, children }: { title: string; children: React.ReactNode }) {
  const key = `pageinfo.${title.split(" —")[0]!.trim().toLowerCase().replace(/\s+/g, "-")}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "closed";
    } catch {
      return true; // private window: just show it
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        /* nothing to remember it with */
      }
      return !o;
    });
  };
  return (
    <div className={`pageinfo${open ? "" : " closed"}`}>
      <div className="pageinfo-icon">ⓘ</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button type="button" className="pageinfo-toggle" onClick={toggle} aria-expanded={open}>
          <strong>{title}</strong>
          <span className="muted">{open ? "Hide ▲" : "What is this page? ▼"}</span>
        </button>
        {open && (
          <div className="muted" style={{ marginTop: 2 }}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button disabled={page <= 1} onClick={() => onPage(1)}>
        « First
      </button>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      <span className="muted">
        Page {page} of {totalPages}
      </span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
      <button disabled={page >= totalPages} onClick={() => onPage(totalPages)}>
        Last »
      </button>
    </div>
  );
}

/** The window itself never scrolls (see .layout in styles.css): each page scrolls inside <main>. */
export function pageScroller(): HTMLElement | null {
  return document.querySelector("main.main");
}

/** Back to the top of the page — what window.scrollTo used to do. */
export function scrollPageTop(): void {
  pageScroller()?.scrollTo({ top: 0 });
}

/** The title row every page starts with: name of the page on the left, its buttons on the right. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="toolbar page-header">
      <h1 style={{ margin: 0 }}>{title}</h1>
      <div className="grow" />
      {children}
    </div>
  );
}

/** Nothing to show yet, said in a friendly way instead of a bare line of grey text. */
export function Empty({ emoji = "📭", children }: { emoji?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-emoji">{emoji}</div>
      <p>{children}</p>
    </div>
  );
}

/** A dialog over the page. Closes on Esc, the close button, or a click on the backdrop. */
export function Modal({ title, subtitle, onClose, children, wide = true }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // The page behind the dialog holds still while it's open.
    const page = pageScroller();
    const prev = page?.style.overflow ?? "";
    if (page) page.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      if (page) page.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {subtitle && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
