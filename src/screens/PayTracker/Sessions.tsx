import { useMemo, useState } from 'react';
import type { PayData, PaySession } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { EmptyState, Pagination, Pill, RecordId, RecordTable, SearchBox, Segmented, SourceLink, usePaged } from '../../components/ui';

/**
 * Every session row, the full record.
 *
 * The other three tabs answer a question; this one is the ledger itself, for
 * when the answer needs checking. Nothing here is editable — paid status is set
 * by the Slack card or by a statement closing, and two places to change the
 * same fact is how records drift.
 */

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const whenFull = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

type Filter = 'all' | 'unpaid' | 'unknown' | 'paid' | 'Monthly' | 'Daily';

function columns(): RecordColumn<PaySession>[] {
  return [
    { key: 'date', header: 'session date', className: 'tabular text-faint', cell: (s) => when(s.session_date) },
    { key: 'builder', header: 'builder', width: '18ch', clip: true, cell: (s) => s.builder },
    {
      key: 'mode',
      header: 'pay mode',
      card: 'meta',
      className: 'card-meta text-dim',
      // Frozen at approval. A later change to someone's pay mode does not
      // rewrite this, and the page never joins to the roster to second-guess it.
      title: () => 'Frozen when the session was approved, so a later change to this builder’s pay mode does not rewrite it',
      cell: (s) => s.pay_mode ?? <span className="text-faint">not set</span>,
    },
    {
      key: 'month',
      header: 'month',
      className: 'tabular text-dim',
      title: (s) => (s.approved_at ? `Approved ${whenFull(s.approved_at)} — the month comes from the session date, not from this` : undefined),
      cell: (s) => s.month ?? <span className="text-faint">—</span>,
    },
    {
      key: 'paid',
      header: 'paid',
      card: 'meta',
      className: 'card-meta',
      title: (s) =>
        s.paid === null
          ? `No Paid value on this row, so it is not known whether it is paid.${s.held_via === 'resync' ? ' It came in on the Airtable resync, and Airtable leaves an unticked box out of the record — so it was most likely unticked then.' : ''}`
          : undefined,
      cell: (s) => (s.paid === true ? <Pill tone="ok">paid</Pill> : s.paid === false ? <Pill tone="degraded">owed</Pill> : <Pill>not recorded</Pill>),
    },
    { key: 'paid_at', header: 'paid at', className: 'tabular text-faint', cell: (s) => when(s.paid_at) },
    { key: 'paid_by', header: 'paid by', card: 'meta', className: 'card-meta text-dim', cell: (s) => s.paid_by ?? <span className="text-faint">—</span> },
    {
      key: 'codex',
      header: 'codex id',
      card: 'title',
      width: '28ch',
      clip: true,
      title: (s) => s.codex_entry_id,
      cell: (s) => <RecordId>{s.codex_entry_id}</RecordId>,
    },
    {
      key: 'links',
      header: 'links',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (s) => (
        <span className="flex items-center justify-end gap-2 text-[11.5px]">
          {s.codex_link && (
            <a href={s.codex_link} target="_blank" rel="noreferrer" className="link" onClick={(e) => e.stopPropagation()}>
              Codex
            </a>
          )}
          {s.slack_card_link && (
            <a href={s.slack_card_link} target="_blank" rel="noreferrer" className="link" onClick={(e) => e.stopPropagation()}>
              Slack card
            </a>
          )}
          <SourceLink source={s.source} />
        </span>
      ),
    },
  ];
}

export default function Sessions({ data }: { data: PayData }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [builder, setBuilder] = useState<string>('all');
  const [q, setQ] = useState('');
  // The month is the page's, chosen once above the tabs; `data` arrives cut to it.
  const builders = useMemo(() => [...new Set(data.sessions.map((s) => s.builder))].sort(), [data.sessions]);

  const rows = useMemo(
    () =>
      data.sessions
        .filter((s) => (filter === 'all' ? true : filter === 'unpaid' ? s.paid === false : filter === 'unknown' ? s.paid === null : filter === 'paid' ? s.paid === true : s.pay_mode === filter))
        .filter((s) => builder === 'all' || s.builder === builder)
        .filter((s) => !q.trim() || [s.codex_entry_id, s.builder, s.statement_id].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase()))),
    [data.sessions, filter, builder, q],
  );
  const paged = usePaged(rows, `${filter}|${builder}|${data.sessions.length}|${q.trim()}`);

  const counts = {
    all: data.sessions.length,
    unpaid: data.sessions.filter((s) => s.paid === false).length,
    unknown: data.sessions.filter((s) => s.paid === null).length,
    paid: data.sessions.filter((s) => s.paid === true).length,
    Monthly: data.sessions.filter((s) => s.pay_mode === 'Monthly').length,
    Daily: data.sessions.filter((s) => s.pay_mode === 'Daily').length,
  };

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 space-y-3 px-6 pt-1 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<Filter>
            ariaLabel="Filter sessions"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'unpaid', label: 'Unpaid', count: counts.unpaid, title: 'Paid is explicitly false on the row.' },
              { value: 'unknown', label: 'Paid not recorded', count: counts.unknown, title: 'The row carries no Paid value at all — not known either way, and never counted as owed.' },
              { value: 'paid', label: 'Paid', count: counts.paid },
              { value: 'Monthly', label: 'Monthly', count: counts.Monthly },
              { value: 'Daily', label: 'Daily', count: counts.Daily },
            ]}
          />
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3">
            <label className="flex items-center gap-2 text-[11.5px] text-faint">
              <span className="sr-only">Builder</span>
              <select className="input h-[30px] w-auto py-0 text-[12px]" value={builder} onChange={(e) => setBuilder(e.target.value)} aria-label="Builder">
                <option value="all">Every builder</option>
                {builders.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <SearchBox value={q} onChange={setQ} placeholder="Search Codex ids and builders" />
          </div>
        </div>
        {data.duplicates.merged > 0 && (
          <p className="text-[12px] text-dim">
            {data.duplicates.rows} rows are held for {data.duplicates.sessions} sessions: {data.duplicates.merged} sessions were held twice — once from the
            Airtable resync of 20 Sep and once as the engine posted them — and are counted once here, the engine’s copy kept.
            {data.duplicates.disagree ? ` ${data.duplicates.disagree} pair${data.duplicates.disagree === 1 ? ' disagrees' : 's disagree'} about Paid.` : ' Every pair agrees about Paid.'}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {data.freshness.source === 'none'
            ? (data.freshness.note ??
              'No session is held. A row appears here the moment a session is approved — so an empty ledger means either nothing has been approved or nobody has read it. The age above says which.')
            : data.sessions.length === 0
              ? 'No session held counts toward the month picked above. Pick another month, or All time.'
              : q.trim() || builder !== 'all'
              ? 'No session matches those filters.'
              : filter === 'unpaid'
                ? 'Every approved session held is paid. Nothing is owed.'
                : filter === 'unknown'
                  ? 'Every session carries a Paid value.'
                  : filter === 'paid'
                  ? 'No session held has been marked paid yet.'
                  : `No ${filter.toLowerCase()} session is held.`}
        </EmptyState>
      ) : (
        <>
          <RecordTable columns={columns()} rows={paged.rows} rowKey={(s) => s.id} label="Pay sessions" />
          <Pagination paged={paged} unit="sessions" />
        </>
      )}
    </div>
  );
}
