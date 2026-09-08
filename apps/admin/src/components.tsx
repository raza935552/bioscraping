// Shared UI: the per-page instruction banner (what this page is for), a
// pagination control, and the plain-language labels for affiliate
// classification (DB values stay internal/external/unresolved; people see
// these words instead).

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
