import { createPortal } from 'react-dom';
import { useMemo, useState } from 'react';
import type { PayData, PayMetrics, PayStatement } from '../../data';
import type { RecordColumn } from '../../components/ui';
import {
  EmptyState,
  FigureCell,
  Pagination,
  PercentileCell,
  Pill,
  RecordId,
  RecordTable,
  SearchBox,
  Segmented,
  Segmented as Seg,
  StatStrip,
  usePaged,
} from '../../components/ui';

/**
 * Every monthly statement, newest first.
 *
 * **Payment Sent is not a success to celebrate, it is the normal state**, so it
 * carries no colour. Only two things do: `Disputed`, and a statement that has
 * been sent and unanswered for more than a fortnight.
 *
 * A statement closes itself to Payment Sent once every session behind it is
 * ticked. If a payment goes out and the sessions are never ticked, it stays
 * open and reappears here — a forgotten payment surfaces rather than vanishing,
 * which is why an old open statement is worth colouring at all.
 */

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

function StatusPill({ s }: { s: PayStatement }) {
  if (s.status === 'Disputed') return <Pill tone="failing">disputed</Pill>;
  if (s.status === 'Sent') return (s.days_open ?? 0) > 14 ? <Pill tone="degraded">sent · {s.days_open} d</Pill> : <Pill>sent</Pill>;
  // Deliberately uncoloured: this is what is supposed to happen.
  if (s.status === 'Payment Sent') return <Pill>payment sent</Pill>;
  if (!s.status) return <Pill>no status</Pill>;
  return <Pill>{s.status.toLowerCase()}</Pill>;
}

function columns(open: (s: PayStatement) => void): RecordColumn<PayStatement>[] {
  return [
    { key: 'id', header: 'statement', width: '30ch', clip: true, title: (s) => s.statement_id, cell: (s) => <RecordId>{s.statement_id}</RecordId> },
    { key: 'builder', header: 'builder', card: 'title', width: '22ch', clip: true, cell: (s) => s.builder },
    { key: 'month', header: 'month', className: 'tabular text-dim', cell: (s) => s.month ?? <span className="text-faint">—</span> },
    {
      key: 'days',
      header: 'working days',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular text-dim',
      // Never the session count, and never derived from it.
      title: () => 'Distinct days with at least one approved session — not the same as the session count',
      cell: (s) => (s.working_days === null ? <span className="text-faint">—</span> : s.working_days),
    },
    {
      key: 'sessions',
      header: 'sessions',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular text-dim',
      title: () => 'Approved sessions in this statement. Two in one day is one working day and two sessions',
      cell: (s) => (s.session_count === null ? <span className="text-faint">—</span> : s.session_count),
    },
    { key: 'status', header: 'status', card: 'meta', className: 'card-meta', cell: (s) => <StatusPill s={s} /> },
    { key: 'sent', header: 'sent', className: 'tabular text-faint', cell: (s) => when(s.sent_at) },
    { key: 'paid', header: 'payment sent', className: 'tabular text-faint', cell: (s) => when(s.payment_sent_at) },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (s) => (
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); open(s); }}>
            Evidence
          </button>
        </div>
      ),
    },
  ];
}

export default function Statements({ data, m }: { data: PayData; m: PayMetrics }) {
  const [filter, setFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      data.statements
        .filter((s) => (filter === 'all' ? true : filter === 'open' ? s.open : s.status === filter))
        .filter((s) => !q.trim() || [s.statement_id, s.builder, s.month, s.evidence].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase()))),
    [data.statements, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}`);
  const current = open ? data.statements.find((s) => s.id === open) : null;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <StatStrip cols={4}>
        <FigureCell
          label="Open statements"
          value={m.open_statements.n}
          tone={m.open_statements.chasing ? 'degraded' : undefined}
          note={
            <>
              {m.open_statements.chasing > 0 && <span className="mb-1 block text-degraded">{m.open_statements.chasing} open longer than 14 days</span>}
              {m.open_statements.note}
            </>
          }
        />
        <FigureCell label={`Settled in ${m.settled_this_year.year}`} value={m.settled_this_year.n} note={m.settled_this_year.note} />
        <PercentileCell label="Sent to payment" p={m.statement_time_to_pay} unit="d" />
        <FigureCell
          label="Oldest open statement"
          value={m.oldest_open_statement.days}
          unit="d"
          tone={(m.oldest_open_statement.days ?? 0) > 14 ? 'degraded' : undefined}
          note={
            <>
              {m.oldest_open_statement.statement_id && <span className="tabular mb-1 block truncate text-dim">{m.oldest_open_statement.statement_id}</span>}
              {m.oldest_open_statement.note}
            </>
          }
        />
      </StatStrip>

      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Seg<string>
            ariaLabel="Filter statements"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: data.statements.length },
              { value: 'open', label: 'Open', count: m.open_statements.n },
              // In the base's own order, so a status added upstream appears
              // rather than being silently dropped.
              ...m.statement_status_mix.map((s) => ({ value: s.key, label: s.label, count: s.n })),
            ]}
          />
          <div className="flex flex-1 items-center justify-end gap-3">
            <SearchBox value={q} onChange={setQ} placeholder="Search statements, builders and evidence" />
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {data.statements_freshness.source === 'none' ? (
            /*
              Said in full (2026-09-22): which system writes statements, where
              to, when, and that none has ever arrived. An empty list with no
              explanation is the failure this page keeps being fixed for.
            */
            <span className="block max-w-[640px] text-left">
              <span className="block font-medium text-ink">No monthly statement has ever been posted to this dashboard.</span>
              <span className="mt-1 block">
                Statements are written by the n8n workflow <span className="text-ink">Bays — Pay Tracking</span>, on the 1st of each month at 09:00: one per
                monthly builder, for the month just ended, posted to <span className="tabular text-ink">/api/engine/pay_statements</span> and to the pay-reviews
                channel in Slack. It was created on 17 Sep 2026, so its first run is 1 Oct 2026 — until then an empty list is expected, not a fault.
                {data.statements_last_write
                  ? ` The engine last wrote a statement on ${data.statements_last_write.slice(0, 10)}.`
                  : ' The write log holds no statement from the engine at all.'}
              </span>
            </span>
          )
            : q.trim()
              ? 'No statement matches that search in this filter.'
              : filter === 'open'
                ? 'No statement is open. Every one held is a draft, paid, or disputed.'
                : `No statement is ${filter.toLowerCase()}.`}
        </EmptyState>
      ) : (
        <>
          <RecordTable columns={columns((s) => setOpen(s.id))} rows={paged.rows} rowKey={(s) => s.id} onOpen={(s) => setOpen(s.id)} label="Monthly statements" />
          <Pagination paged={paged} unit="statements" />
        </>
      )}

      {current && <EvidencePanel s={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * The statement opened up.
 *
 * **The evidence block is shown whole.** It is the proof Jason asked for — every
 * session with its date, id and link — and a one-line summary of it would defeat
 * the point of writing it down.
 */
function EvidencePanel({ s, onClose }: { s: PayStatement; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Statement">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{s.statement_id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">
              {s.builder} · {s.month ?? 'no month'}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <StatusPill s={s} />
              {/* Both, side by side, so neither can be read as the other. */}
              <span className="tabular">
                {s.working_days ?? '—'} working {s.working_days === 1 ? 'day' : 'days'}
              </span>
              <span className="tabular">
                {s.session_count ?? '—'} {s.session_count === 1 ? 'session' : 'sessions'}
              </span>
              {s.sent_at && <span className="tabular">sent {when(s.sent_at)}</span>}
              {s.payment_sent_at && <span className="tabular">paid {when(s.payment_sent_at)}</span>}
              {s.confirmed_by && <span>confirmed by {s.confirmed_by}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {s.slack_link && (
              <a href={s.slack_link} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Open in Slack
              </a>
            )}
            <a href={s.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {s.working_days !== null && s.session_count !== null && s.working_days !== s.session_count && (
          <p className="mt-3 text-[11.5px] leading-snug text-faint">
            {s.session_count} sessions across {s.working_days} working days — some days carried more than one. They are different numbers on purpose and neither is derived
            from the other.
          </p>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Evidence</div>
          {s.evidence ? (
            // Whole, scrollable, never clamped.
            <pre className="max-h-[52vh] overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{s.evidence}</pre>
          ) : (
            <p className="text-[12.5px] text-degraded">
              This statement carries no evidence block. It is the proof the statement exists to carry, so an empty one is worth asking about rather than reading as a month
              with no work.
            </p>
          )}
        </div>

        {s.notes && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">Notes</div>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">{s.notes}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export { Segmented };
