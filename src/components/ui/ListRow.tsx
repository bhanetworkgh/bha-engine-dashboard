import type { ReactNode } from 'react';

/**
 * The shared list shape for Build patterns and Commercial cards: one row per
 * record, a fixed height whatever the record carries, and the full detail one
 * click away rather than inline.
 *
 * Both pages are the same page with different content, so they share this
 * rather than each inventing a layout. Rows keep a uniform height because the
 * summary is clamped to two lines and reserves those two lines even when the
 * record has one — a list whose rows jump about is harder to scan than a list
 * with a little air in it.
 */

export function RecordList({ children }: { children: ReactNode }) {
  // shrink-0 matters: these pages are a flex column, and a flex child that
  // clips its own overflow is shrunk to nothing by the default flex-shrink.
  // Without it the rows are in the DOM and the card is zero pixels tall.
  return <div className="card mx-6 mb-4 shrink-0 overflow-hidden md:mx-8">{children}</div>;
}

export function RecordRow({
  id,
  title,
  meta,
  summary,
  summaryEmpty,
  actions,
  onOpen,
  busy,
}: {
  /** The human identifier — a pattern_id or a card_id. Shown quiet and tabular above the title. */
  id: ReactNode;
  title: ReactNode;
  /** Small facts on the right: status, system, reusability. Kept to a handful. */
  meta?: ReactNode;
  /** One or two lines of the record's own text. */
  summary?: string | null;
  /** What to say when the record carries no summary. */
  summaryEmpty?: string;
  actions?: ReactNode;
  onOpen: () => void;
  busy?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`rowlike grid cursor-pointer grid-cols-1 items-start gap-x-5 gap-y-2 border-b border-line px-5 py-3.5 transition-colors last:border-b-0 hover:bg-hover md:grid-cols-[minmax(0,1fr)_auto] ${busy ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0">
        <div className="tabular truncate text-[11px] text-faint">{id}</div>
        <div className="mt-0.5 truncate text-[13px] font-medium text-ink">{title}</div>
        <p className="mt-1 line-clamp-2 min-h-[2.4em] text-[12px] leading-[1.2em] text-dim">
          {summary ? summary : <span className="text-faint">{summaryEmpty ?? 'No summary on this record.'}</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
        {meta && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint md:justify-end">{meta}</div>}
        {actions && <div className="row-actions flex flex-wrap items-center gap-1 md:justify-end">{actions}</div>}
      </div>
    </div>
  );
}
