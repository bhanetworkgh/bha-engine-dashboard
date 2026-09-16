import type { Loop, LoopStatus, RecordWrite, OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { EmptyState, NotLanded, Pill, RecordId, RecordTable, RowAction, RowActions, SourceLink, unlanded, writeWarning } from '../../components/ui';
import { duplicateSource } from './LoopPanel';
import { ageTone, laneLabel } from '../../lib';

export type StatusFilter = 'all' | LoopStatus;

/**
 * Owner picker: one tile per builder table with its open count. Picking one is
 * that builder's table view.
 *
 * The oldest-loop age badge that used to sit beside each count is gone. It was
 * red on every tab, which is exactly what amber and red are not for — a colour
 * that is always on carries no signal, and it made every builder look like a
 * problem. Age is still on every row, and the age distribution card is still
 * the page's answer to "where is it piling up".
 */
/**
 * The builder tables, each with how many loops it holds.
 *
 * `counts` narrows those numbers to the month in view (2026-09-16, Destiny).
 * Without it the tabs count every loop still open in that table, which is a
 * different question from the one the rest of the page is answering once a
 * month is selected — and two questions in one row is how a reader stops
 * trusting either number.
 */
export function OwnerPicker({
  data,
  owner,
  setOwner,
  counts,
}: {
  data: OpenLoopsData;
  owner: string;
  setOwner: (o: string) => void;
  counts?: Record<string, number>;
}) {
  const countOf = (o: string) => {
    if (counts) return counts[o] ?? 0;
    const row = data.by_owner.find((x) => x.owner === o);
    return row ? row.open + row.in_progress : 0;
  };
  const total = counts
    ? data.by_owner.reduce((n, o) => n + countOf(o.owner), 0)
    : data.by_owner.reduce((n, o) => n + o.open + o.in_progress, 0);
  const cell = (active: boolean) =>
    `flex min-w-[112px] shrink-0 flex-col rounded-[12px] px-3.5 py-2.5 text-left transition-colors md:min-w-0 md:flex-1 ${active ? 'bg-panel shadow-[var(--shadow-card)]' : 'hover:bg-hover'}`;
  return (
    <div className="scroll-thin flex gap-1 overflow-x-auto rounded-[14px] bg-raised p-1 md:overflow-visible" role="group" aria-label="Builder table">
      <button type="button" onClick={() => setOwner('all')} className={cell(owner === 'all')} aria-pressed={owner === 'all'}>
        <span className="text-[11.5px] text-faint">All tables</span>
        <span className="font-display tabular mt-0.5 block text-[20px] leading-none">{total}</span>
      </button>
      {data.by_owner.map((o) => (
        <button key={o.owner} type="button" onClick={() => setOwner(o.owner)} className={cell(owner === o.owner)} aria-pressed={owner === o.owner} title={`${o.open} open, ${o.in_progress} in progress, ${o.closed} closed`}>
          <span className="truncate text-[11.5px] text-faint">{BUILDER_NAMES[o.owner] ?? o.owner}</span>
          <span className="font-display tabular mt-0.5 block text-[20px] leading-none">{countOf(o.owner)}</span>
        </button>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: LoopStatus }) {
  if (status === 'closed') return <Pill tone="ok">closed</Pill>;
  if (status === 'in progress') return <Pill tone="accent">in progress</Pill>;
  return <Pill>open</Pill>;
}

/** The loop-specific consequence, appended to the shared sentence. */
const DIGEST_NOTE = 'The 8am Open Loops digest reads Airtable, so this loop will be raised again tomorrow morning.';

export function writebackWarning(w: RecordWrite): string {
  return writeWarning(w, DIGEST_NOTE);
}

/**
 * The status of a loop whose last change did not reach Airtable.
 *
 * The dashboard's own status is still shown — it is what this database holds,
 * and it is true here — but never on its own, because on its own it says the
 * loop is dealt with and Airtable disagrees. The marker beside it is the whole
 * point of the write-back work: the person who closed it has to be able to see
 * that the close did not land, on the row, at the moment they look at it.
 */
function LoopStatusCell({ loop }: { loop: Loop }) {
  const w = loop.writeback;
  if (!unlanded(w)) return <StatusPill status={loop.status} />;
  return (
    <span className="inline-flex items-center gap-1.5" title={writebackWarning(w!)}>
      <StatusPill status={loop.status} />
      <NotLanded write={w!} />
    </span>
  );
}

/**
 * The loop list, newest first, twenty to a page. Row actions change status in
 * place.
 *
 * The columns are the ones this page has always had; they are declared through
 * the shared RecordTable now so that the other five record lists are drawn the
 * same way and row styling only has to change in one place.
 */
export function Loops({ data, loops, total, busyId, onStatus, onOpen, onRemoveDuplicate, searching }: { data: OpenLoopsData; loops: Loop[]; total: number; busyId: string | null; onStatus: (loop: Loop, status: LoopStatus) => void; onOpen: (loop: Loop) => void; onRemoveDuplicate: (loop: Loop) => void; searching: boolean }) {
  const columns: RecordColumn<Loop>[] = [
    {
      key: 'age',
      header: 'age',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (l) => (l.status === 'closed' ? 'text-faint' : ageTone(l.age_days)),
      title: (l) => (l.raised_at ? 'Days since raised' : 'No Date Raised on this row'),
      cell: (l) => (l.raised_at ? `${l.age_days}d` : '—'),
    },
    {
      key: 'loop',
      header: 'loop',
      title: (l) => l.id,
      cell: (l) => <RecordId missing="no loop_id">{l.loop_id}</RecordId>,
    },
    {
      key: 'what',
      header: 'what',
      card: 'title',
      width: '56ch',
      // `clip` rather than a class of our own: it is what wraps the cell in the
      // block element td-clip needs to actually ellipsis. A span stays inline
      // and the text runs straight through the next three columns.
      clip: true,
      className: 'font-medium text-ink',
      title: (l) => l.title,
      // The What is the note. A second line repeating "no note on this loop"
      // under every row was furniture, not information.
      cell: (l) => l.title,
    },
    { key: 'status', header: 'status', card: 'meta', className: 'card-meta', cell: (l) => <LoopStatusCell loop={l} /> },
    // Named for what it holds. It was "table" because the builder *is* the
    // table in Airtable, but the reader is looking at a person.
    { key: 'table', header: 'Builder', card: 'meta', className: 'card-meta text-dim', cell: (l) => BUILDER_NAMES[l.owner] ?? l.owner },
    { key: 'lane', header: 'lane', className: 'text-faint', cell: (l) => (l.lane_tag ? laneLabel(l.lane_tag) : '—') },
    { key: 'raised_by', header: 'raised by', className: 'text-faint', width: '18ch', clip: true, title: (l) => l.raised_by ?? undefined, cell: (l) => l.raised_by ?? '—' },
    { key: 'raised_in', header: 'raised in', className: 'text-faint', width: '18ch', clip: true, title: (l) => l.raised_in ?? undefined, cell: (l) => l.raised_in ?? '—' },
    { key: 'raised', header: 'raised', className: 'tabular text-faint', cell: (l) => l.raised_at ?? '—' },
    {
      key: 'closed',
      header: 'closed',
      // The colour lives in cellClass alone, so a failed write-back is not
      // fighting `text-faint` on the same element for which one wins.
      className: 'tabular',
      title: (l) =>
        unlanded(l.writeback)
          ? writebackWarning(l.writeback!)
          : l.closed_at
            ? 'Closed through this dashboard or pushed by the engine'
            : 'Nothing records when this loop was closed',
      cellClass: (l) => (unlanded(l.writeback) ? 'text-failing' : 'text-faint'),
      cell: (l) => l.closed_at ?? '—',
    },
    { key: 'source', header: 'source', cell: (l) => <SourceLink source={l.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (l) => {
        const busy = busyId === l.id;
        return (
          <RowActions>
            {l.status !== 'closed' && <RowAction label="Close" tone="accent" disabled={busy} onClick={() => onStatus(l, 'closed')} />}
            {l.status === 'open' && <RowAction label="Start" disabled={busy} onClick={() => onStatus(l, 'in progress')} />}
            {l.status === 'in progress' && <RowAction label="Back to open" disabled={busy} onClick={() => onStatus(l, 'open')} />}
            {l.status === 'closed' && <RowAction label="Reopen" disabled={busy} onClick={() => onStatus(l, 'open')} />}
            <RowAction label="Open in Airtable" onClick={() => window.open(l.airtable.url, '_blank', 'noreferrer')} />
          </RowActions>
        );
      },
    },
  ];

  // Every loop held, not the visible twenty: a close stranded on page four is
  // raised by tomorrow's digest exactly like one on page one.
  const stranded = data.loops.filter((l) => unlanded(l.writeback));

  return (
    <div className="shrink-0">
      {/*
        Said once at the top, not only on the row. A loop whose close did not
        reach Airtable is on page four as often as page one, and the digest that
        raises it again tomorrow does not care which. Red, because this is a
        genuinely bad state and not a label: the dashboard and Airtable disagree
        about work someone believes they have finished.
      */}
      {stranded.length > 0 && (
        <div className="px-6 pb-3 md:px-8">
          <div className="flex items-start gap-3 rounded-[14px] bg-failing-soft px-4 py-3">
            <span aria-hidden className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-failing" />
            <div className="text-[12.5px] leading-relaxed text-failing">
              <span className="font-medium">
                {stranded.length} {stranded.length === 1 ? 'loop did' : 'loops did'} not land in Airtable.
              </span>{' '}
              The 8am Open Loops digest reads Airtable, not this dashboard, so what is on screen here and what it sends
              tomorrow morning disagree. Marked in the status column; open the loop for the reason and what completed.
              {/*
                Three, with the repair on the ones that have one. A duplicate is
                the single case here this dashboard can fix by itself — the copy
                in the source table is deleted and nothing else is touched — so
                the action sits on the line that names it rather than only in
                the panel behind it.
              */}
              <div className="mt-1.5 space-y-1 text-[11.5px] text-failing/90">
                {stranded.slice(0, 3).map((l) => (
                  <div key={l.id}>
                    <span className="tabular">{l.loop_id ?? l.id}</span> — {l.writeback?.reason ?? 'no reason was given'}
                    {l.writeback?.state === 'duplicate' && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm ml-2 align-baseline"
                        disabled={busyId === l.id}
                        onClick={() => onRemoveDuplicate(l)}
                      >
                        {busyId === l.id ? 'Removing…' : `Remove the copy in ${duplicateSource(l.writeback.from_builder)}`}
                      </button>
                    )}
                  </div>
                ))}
                {stranded.length > 3 && <div>…and {stranded.length - 3} more.</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="px-6 pb-3 text-[11.5px] text-faint md:px-8">{data.status_history_note}</p>

      {total === 0 ? (
        <EmptyState>
          {data.freshness.source === 'none'
            ? (data.freshness.note ?? 'No loops are held.')
            : searching
              ? 'No loop matches that search in the selected table and status.'
              : 'No loops match the selected table and status.'}
        </EmptyState>
      ) : (
        <RecordTable columns={columns} rows={loops} rowKey={(l) => l.id} onOpen={onOpen} busyKey={busyId} lines={1} label="Open loops" />
      )}
    </div>
  );
}
