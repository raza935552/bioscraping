// Shared UI: the per-page instruction banner (what this page is for), a
// pagination control, and the plain-language labels for affiliate
// classification (DB values stay internal/external/unresolved; people see
// these words instead).

import { useEffect, type ReactNode } from "react";

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

export function PageInfo({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pageinfo">
      <div className="pageinfo-icon">ⓘ</div>
      <div>
        <strong>{title}</strong>
        <div className="muted" style={{ marginTop: 2 }}>
          {children}
        </div>
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

/** A dialog over the page. Closes on Esc, the close button, or a click on the backdrop. */
export function Modal({ title, subtitle, onClose, children, wide = true }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
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
