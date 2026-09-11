import type { ReactNode } from 'react';
import { TableFrame, Th } from './Table';

/**
 * The one table every record list is drawn with — Open loops, Codex entries,
 * North Star, Research Twin, Build patterns and Commercial.
 *
 * Before this, Open loops was a real table and the other five were stacks of
 * cards, each anchoring its content to a different corner, so nothing lined up
 * from one row to the next or from one page to the next. The rules the loops
 * table already followed are the rules here, in one place, so a change to row
 * styling reaches every page instead of drifting again:
 *
 *   · a header row naming every column
 *   · one row height for the whole page, set by `lines` (see .rows-1/.rows-2
 *     in index.css) — the row is exactly that tall, never taller
 *   · text clipped with an ellipsis, never wrapped
 *   · status is a single pill in its own column, never floating in a corner
 *   · ids in the quiet tabular treatment loop ids already use
 *   · every action in one right-aligned actions column, revealed on hover
 *
 * Under 768px the table becomes stacked cards (`.table-cards` in index.css).
 * A column joins that layout by naming a `card` role; a column without one is
 * not shown on a small screen, which is the behaviour the loops table had.
 */

/** Where a column goes when the table stacks into cards on a small screen. */
export type CardRole = 'title' | 'meta' | 'full' | 'actions';

export interface RecordColumn<T> {
  /** React key and nothing else; the header is what a reader sees. */
  key: string;
  /** Column name. Sentence case, and lower case reads quieter in a dense table. */
  header?: ReactNode;
  cell: (row: T) => ReactNode;
  /** Cap the column's width so long text clips rather than stretching the table. */
  width?: string;
  align?: 'right';
  /** Clip this cell's content to one line with an ellipsis. */
  clip?: boolean;
  /** Static classes for every cell in the column. */
  className?: string;
  /** Per-row classes — an age that goes amber, a count that goes red. */
  cellClass?: (row: T) => string;
  /** The full text, as a tooltip, when the cell is clipped. */
  title?: (row: T) => string | undefined;
  card?: CardRole;
}

export function RecordTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  busyKey,
  lines = 1,
  label,
}: {
  columns: RecordColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Opening the record. Omit where a row has no detail view. */
  onOpen?: (row: T) => void;
  /** The row whose write is in flight, dimmed until it settles. */
  busyKey?: string | null;
  /** 1 for a single line of text per row, 2 where rows carry a title and a description. */
  lines?: 1 | 2;
  label?: string;
}) {
  return (
    <TableFrame grow={false} tableClass={lines === 2 ? 'rows-2' : 'rows-1'} label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <Th key={c.key} className={c.align === 'right' ? 'text-right' : ''}>
              {c.header}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          const busy = busyKey === key;
          return (
            <tr
              key={key}
              className={`${busy ? 'opacity-60' : ''} ${onOpen ? 'cursor-pointer' : ''}`}
              {...(onOpen
                ? {
                    tabIndex: 0,
                    onClick: () => onOpen(row),
                    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(row);
                      }
                    },
                  }
                : {})}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`td ${c.card ? `card-${c.card}` : ''} ${c.card === 'actions' ? 'td-actions' : ''} ${c.align === 'right' ? 'text-right' : ''} ${
                    c.className ?? ''
                  } ${c.cellClass?.(row) ?? ''}`}
                  style={c.width ? { maxWidth: c.width } : undefined}
                  title={c.title?.(row)}
                >
                  {c.clip ? <div className="td-clip">{c.cell(row)}</div> : c.cell(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </TableFrame>
  );
}

/**
 * A row that carries both a name and a sentence about it: the title on top,
 * the record's own description clipped underneath. Both lines are always
 * drawn, so a record with no description keeps the row the same height as its
 * neighbours rather than making the list jump about.
 */
export function TwoLine({ title, description, empty }: { title: ReactNode; description?: string | null; empty?: string }) {
  return (
    <>
      <div className="td-clip font-medium text-ink">{title}</div>
      <div className="td-clip mt-0.5 text-[11px] text-faint">{description || (empty ?? 'Nothing written on this record.')}</div>
    </>
  );
}

/** The quiet tabular id treatment, the same on every list. */
export function RecordId({ children, missing }: { children: ReactNode; missing?: string }) {
  if (children === null || children === undefined || children === '') {
    return <span className="text-degraded">{missing ?? 'no id'}</span>;
  }
  return <span className="tabular text-faint">{children}</span>;
}
