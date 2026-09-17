import { useMemo, useState } from 'react';
import type { PayData, PaySession } from '../../data';
import type { RecordColumn } from '../../components/ui';
import { EmptyState, MonthPicker, monthsFrom, Pagination, Pill, RecordId, RecordTable, SearchBox, Segmented, SourceLink, usePaged } from '../../components/ui';

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

type Filter = 'all' | 'unpaid' | 'paid' | 'Monthly' | 'Daily';

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
      cell: (s) => (s.paid ? <Pill tone="ok">paid</Pill> : <Pill tone="degraded">owed</Pill>),
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
  const [month, setMonth] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const months = useMemo(() => monthsFrom(data.sessions.map((s) => (s.month ? `${s.month}-01` : null))), [data.sessions]);
  const builders = useMemo(() => [...new Set(data.sessions.map((s) => s.builder))].sort(), [data.sessions]);

  const rows = useMemo(
    () =>
      data.sessions
        .filter((s) => (filter === 'all' ? true : filter === 'unpaid' ? !s.paid : filter === 'paid' ? s.paid : s.pay_mode === filter))
        .filter((s) => builder === 'all' || s.builder === builder)
        .filter((s) => !month || s.month === month)
        .filter((s) => !q.trim() || [s.codex_entry_id, s.builder, s.statement_id].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase()))),
    [data.sessions, filter, builder, month, q],
  );
  const paged = usePaged(rows, `${filter}|${builder}|${month ?? 'all'}|${q.trim()}`);

  const counts = {
    all: data.sessions.length,
    unpaid: data.sessions.filter((s) => !s.paid).length,
    paid: data.sessions.filter((s) => s.paid).length,
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
              { value: 'unpaid', label: 'Unpaid', count: counts.unpaid },
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
            <MonthPicker months={months} value={month} onChange={setMonth} />
            <SearchBox value={q} onChange={setQ} placeholder="Search Codex ids and builders" />
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {data.freshness.source === 'none'
            ? (data.freshness.note ??
              'No session is held. A row appears here the moment a session is approved — so an empty ledger means either nothing has been approved or nobody has read it. The age above says which.')
            : q.trim() || builder !== 'all' || month
              ? 'No session matches those filters.'
              : filter === 'unpaid'
                ? 'Every approved session held is paid. Nothing is owed.'
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
