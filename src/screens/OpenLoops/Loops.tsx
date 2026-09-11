import type { Loop, LoopStatus, OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { EmptyState, Pill, RecordId, RecordTable, RowAction, RowActions, SourceLink, TwoLine } from '../../components/ui';
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
export function OwnerPicker({ data, owner, setOwner }: { data: OpenLoopsData; owner: string; setOwner: (o: string) => void }) {
  const total = data.by_owner.reduce((n, o) => n + o.open + o.in_progress, 0);
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
          <span className="font-display tabular mt-0.5 block text-[20px] leading-none">{o.open + o.in_progress}</span>
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

/**
 * The loop list, newest first, twenty to a page. Row actions change status in
 * place — Airtable first, then here.
 *
 * The columns are the ones this page has always had; they are declared through
 * the shared RecordTable now so that the other five record lists are drawn the
 * same way and row styling only has to change in one place.
 */
export function Loops({ data, loops, total, busyId, onStatus, searching, writable }: { data: OpenLoopsData; loops: Loop[]; total: number; busyId: string | null; onStatus: (loop: Loop, status: LoopStatus) => void; searching: boolean; writable: boolean }) {
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
      title: (l) => l.title,
      cell: (l) => <TwoLine title={l.title} description={l.note} empty="No note on this loop." />,
    },
    { key: 'status', header: 'status', card: 'meta', className: 'card-meta', cell: (l) => <StatusPill status={l.status} /> },
    { key: 'table', header: 'table', card: 'meta', className: 'card-meta text-dim', cell: (l) => BUILDER_NAMES[l.owner] ?? l.owner },
    { key: 'lane', header: 'lane', className: 'text-faint', cell: (l) => (l.lane_tag ? laneLabel(l.lane_tag) : '—') },
    { key: 'raised_by', header: 'raised by', className: 'text-faint', width: '18ch', clip: true, title: (l) => l.raised_by ?? undefined, cell: (l) => l.raised_by ?? '—' },
    { key: 'raised_in', header: 'raised in', className: 'text-faint', width: '18ch', clip: true, title: (l) => l.raised_in ?? undefined, cell: (l) => l.raised_in ?? '—' },
    { key: 'raised', header: 'raised', className: 'tabular text-faint', cell: (l) => l.raised_at ?? '—' },
    {
      key: 'closed',
      header: 'closed',
      className: 'tabular text-faint',
      title: (l) => (l.closed_at ? 'Closed through this dashboard or pushed by n8n' : 'Airtable records no close date'),
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
            {writable && l.status !== 'closed' && <RowAction label="Close" tone="accent" disabled={busy} onClick={() => onStatus(l, 'closed')} />}
            {writable && l.status === 'open' && <RowAction label="Start" disabled={busy} onClick={() => onStatus(l, 'in progress')} />}
            {writable && l.status === 'in progress' && <RowAction label="Back to open" disabled={busy} onClick={() => onStatus(l, 'open')} />}
            {writable && l.status === 'closed' && <RowAction label="Reopen" disabled={busy} onClick={() => onStatus(l, 'open')} />}
            <RowAction label="Open in Airtable" onClick={() => window.open(l.airtable.url, '_blank', 'noreferrer')} />
          </RowActions>
        );
      },
    },
  ];

  return (
    <div className="shrink-0">
      <p className="px-6 pb-3 text-[11.5px] text-faint md:px-8">{data.status_history_note}</p>

      {total === 0 ? (
        <EmptyState>
          {data.sync.source === 'none'
            ? (data.sync.error ?? 'Nothing has been read from Airtable yet.')
            : searching
              ? 'No loop matches that search in the selected table and status.'
              : 'No loops match the selected table and status.'}
        </EmptyState>
      ) : (
        <RecordTable columns={columns} rows={loops} rowKey={(l) => l.id} busyKey={busyId} lines={2} label="Open loops" />
      )}
    </div>
  );
}
