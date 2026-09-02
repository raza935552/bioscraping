// Shared UI: the per-page instruction banner (what this page is for) and a
// pagination control.

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
