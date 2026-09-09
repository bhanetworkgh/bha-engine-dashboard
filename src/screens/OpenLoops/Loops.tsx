import type { Loop, LoopStatus, OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { EmptyState, Pill, RowAction, RowActions, SourceLink, TableFrame, Th } from '../../components/ui';
import { ageTone, laneLabel } from '../../lib';

export type StatusFilter = 'all' | LoopStatus;

/** Owner picker: one tile per builder table with its open count and oldest loop. Picking one is that builder's table view. */
export function OwnerPicker({ data, owner, setOwner }: { data: OpenLoopsData; owner: string; setOwner: (o: string) => void }) {
  const total = data.by_owner.reduce((n, o) => n + o.open + o.in_progress, 0);
  const oldest = Math.max(0, ...data.by_owner.map((o) => o.oldest_days));
  const cell = (active: boolean) =>
    `flex min-w-[124px] shrink-0 flex-col rounded-[12px] px-3.5 py-2.5 text-left transition-colors md:min-w-0 md:flex-1 ${active ? 'bg-panel shadow-[var(--shadow-card)]' : 'hover:bg-hover'}`;
  return (
    <div className="scroll-thin flex gap-1 overflow-x-auto rounded-[14px] bg-raised p-1 md:overflow-visible" role="group" aria-label="Builder table">
      <button type="button" onClick={() => setOwner('all')} className={cell(owner === 'all')} aria-pressed={owner === 'all'}>
        <span className="text-[11.5px] text-faint">All tables</span>
        <span className="mt-0.5 flex items-baseline gap-2">
          <span className="font-display tabular text-[20px] leading-none">{total}</span>
          <span className={`tabular text-[11px] ${ageTone(oldest)}`}>{oldest}d</span>
        </span>
      </button>
      {data.by_owner.map((o) => (
        <button key={o.owner} type="button" onClick={() => setOwner(o.owner)} className={cell(owner === o.owner)} aria-pressed={owner === o.owner} title={`${o.open} open, ${o.in_progress} in progress, ${o.closed} closed`}>
          <span className="truncate text-[11.5px] text-faint">{BUILDER_NAMES[o.owner] ?? o.owner}</span>
          <span className="mt-0.5 flex items-baseline gap-2">
            <span className="font-display tabular text-[20px] leading-none">{o.open + o.in_progress}</span>
            <span className={`tabular text-[11px] ${ageTone(o.oldest_days)}`}>{o.oldest_days}d</span>
          </span>
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

/** The loop list, oldest first. Row actions change status in place — Airtable first, then here. */
export function Loops({ data, loops, busyId, onStatus, searching, writable }: { data: OpenLoopsData; loops: Loop[]; busyId: string | null; onStatus: (loop: Loop, status: LoopStatus) => void; searching: boolean; writable: boolean }) {
  return (
    <div className="shrink-0">
      <p className="px-6 pb-3 text-[11.5px] text-faint md:px-8">{data.status_history_note}</p>

      {loops.length === 0 ? (
        <EmptyState>
          {data.sync.source === 'none'
            ? (data.sync.error ?? 'Nothing has been read from Airtable yet.')
            : searching
              ? 'No loop matches that search in the selected table and status.'
              : 'No loops match the selected table and status.'}
        </EmptyState>
      ) : (
        <TableFrame grow={false}>
          <thead>
            <tr>
              <Th className="text-right">age</Th>
              <Th>loop</Th>
              <Th>what</Th>
              <Th>status</Th>
              <Th>table</Th>
              <Th>lane</Th>
              <Th>raised by</Th>
              <Th>raised in</Th>
              <Th>raised</Th>
              <Th>closed</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {loops.map((l) => {
              const busy = busyId === l.id;
              return (
                <tr key={l.id} className={busy ? 'opacity-60' : ''}>
                  <td className={`td card-meta tabular text-right ${l.status === 'closed' ? 'text-faint' : ageTone(l.age_days)}`} title={l.raised_at ? 'Days since raised' : 'No Date Raised on this row'}>
                    {l.raised_at ? `${l.age_days}d` : '—'}
                  </td>
                  <td className="td tabular text-faint" title={l.id}>
                    {l.loop_id ?? <span className="text-degraded">no loop_id</span>}
                  </td>
                  <td className="td card-title" style={{ maxWidth: '56ch' }}>
                    <div className="td-clip" title={l.title}>
                      {l.title}
                    </div>
                    {l.note && (
                      <div className="mt-0.5 truncate text-[11px] text-faint" title={l.note ?? ''}>
                        {l.note}
                      </div>
                    )}
                  </td>
                  <td className="td card-meta">
                    <StatusPill status={l.status} />
                  </td>
                  <td className="td card-meta text-dim">{BUILDER_NAMES[l.owner] ?? l.owner}</td>
                  <td className="td text-faint">{l.lane_tag ? laneLabel(l.lane_tag) : '—'}</td>
                  <td className="td text-faint td-clip" style={{ maxWidth: '18ch' }}>
                    {l.raised_by ?? '—'}
                  </td>
                  <td className="td text-faint td-clip" style={{ maxWidth: '18ch' }}>
                    {l.raised_in ?? '—'}
                  </td>
                  <td className="td tabular text-faint">{l.raised_at ?? '—'}</td>
                  <td className="td tabular text-faint" title={l.closed_at ? 'Closed through this dashboard or pushed by n8n' : 'Airtable records no close date'}>
                    {l.closed_at ?? '—'}
                  </td>
                  <td className="td">
                    <SourceLink source={l.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      {writable && l.status !== 'closed' && <RowAction label="Close" tone="accent" disabled={busy} onClick={() => onStatus(l, 'closed')} />}
                      {writable && l.status === 'open' && <RowAction label="Start" disabled={busy} onClick={() => onStatus(l, 'in progress')} />}
                      {writable && l.status === 'in progress' && <RowAction label="Back to open" disabled={busy} onClick={() => onStatus(l, 'open')} />}
                      {writable && l.status === 'closed' && <RowAction label="Reopen" disabled={busy} onClick={() => onStatus(l, 'open')} />}
                      <RowAction label="Open in Airtable" onClick={() => window.open(l.airtable.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
    </div>
  );
}
