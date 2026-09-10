import { useEffect, useMemo, useState } from 'react';

/**
 * Long lists are paged rather than rendered whole: twenty rows, next and
 * previous. Six hundred rows in one scroll is not a list anyone reads, and it
 * costs a frame every time a filter changes.
 *
 * The page index is held here and clamped as the row count moves, so a filter
 * that shrinks the list never leaves the table on a page that no longer
 * exists. `resetKey` is whatever the caller considers a new list — the builder
 * tab, the status filter, the search term — and returns the reader to page one.
 */

export const PAGE_SIZE = 20;

export interface Paged<T> {
  /** The rows on the current page. */
  rows: T[];
  /** Zero-based, already clamped into range. */
  page: number;
  pages: number;
  /** One-based index of the first row shown, for "1–20 of 360". */
  from: number;
  to: number;
  total: number;
  setPage: (n: number) => void;
}

export function usePaged<T>(rows: T[], resetKey: string, size = PAGE_SIZE): Paged<T> {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [resetKey]);
  return useMemo(() => {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const current = Math.min(Math.max(0, page), pages - 1);
    const start = current * size;
    const slice = rows.slice(start, start + size);
    return {
      rows: slice,
      page: current,
      pages,
      from: rows.length ? start + 1 : 0,
      to: start + slice.length,
      total: rows.length,
      setPage,
    };
  }, [rows, page, size]);
}

/**
 * The control itself. It renders even on a single page so the row count is
 * always stated — a reader should never have to guess whether they are looking
 * at everything or at the first twenty of six hundred.
 */
export function Pagination({ paged, unit }: { paged: Paged<unknown>; unit: string }) {
  const { page, pages, from, to, total, setPage } = paged;
  if (total === 0) return null;
  const single = pages === 1;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-6 md:px-8">
      <span className="tabular text-[11.5px] text-faint">
        {single ? (
          <>
            {total} {unit}
          </>
        ) : (
          <>
            {from}–{to} of {total} {unit}
          </>
        )}
      </span>
      {!single && (
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage(page - 1)} disabled={page === 0}>
            Previous
          </button>
          <span className="tabular px-1 text-[11.5px] text-faint">
            Page {page + 1} of {pages}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage(page + 1)} disabled={page >= pages - 1}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
