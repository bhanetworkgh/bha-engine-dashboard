import { createPortal } from 'react-dom';
import { useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getClients, resync, type ClientLaneRow, type ClientQuestion, type ClientsData } from '../data';
import {
  CountCell,
  EmptyPanel,
  EmptyState,
  LoadFailed,
  Loading,
  MetricCard,
  PageHeader,
  Pagination,
  Pill,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SourceLink,
  StatStrip,
  SyncLine,
  Toast,
  relativeTime,
  usePaged,
  useToast,
} from '../components/ui';

/**
 * Watched clients: one row per lane, grouped under the client that owns it.
 *
 * The grouping is the point of the page. Client 2 has two lanes — rare earths,
 * and CRE vFarm + Kiosk — and appears once with both beneath, because they are
 * one client with two lanes and not two clients. The grouping key is the index
 * row's own Client ID; nothing here infers a client from a lane's name.
 *
 * Each lane's questions live in a table the index row names in `Table ID`. The
 * server follows that field, so adding a lane is a row in the index and not a
 * change here — the same reason the pipeline dropped its hardcoded map.
 */

type Filter = 'all' | 'needs-human' | 'stale' | string;

function RunStatePill({ lane }: { lane: ClientLaneRow }) {
  if (lane.quarantined) return <Pill tone="failing">quarantined</Pill>;
  if (lane.warming_up) return <Pill>warming up</Pill>;
  if (lane.run_state === 'stuck') return <Pill tone="degraded">stuck</Pill>;
  if (lane.run_state === 'contradicted') return <Pill tone="degraded">contradicted</Pill>;
  if (lane.run_state === 'resolved') return <Pill tone="ok">resolved</Pill>;
  return <Pill>{lane.run_state ?? 'no run state'}</Pill>;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/* ------------------------------------------------------------ lane view */

function LaneView({ lane, questions, onClose }: { lane: ClientLaneRow; questions: ClientQuestion[]; onClose: () => void }) {
  const needsHuman = (q: ClientQuestion) => q.research_stuck || q.run_count >= 3 || lane.quarantined;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[960px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Client lane">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{lane.lane_id ?? lane.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{lane.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <RunStatePill lane={lane} />
              {lane.lane_status && <span>{lane.lane_status.replace(/_/g, ' ')}</span>}
              <span>last run {lane.last_run_at ? (relativeTime(lane.last_run_at) ?? day(lane.last_run_at)) : 'never'}</span>
              {lane.next_run_due && <span>next due {day(lane.next_run_due)}</span>}
              {lane.infra_fix_required && <Pill tone="degraded">infra fix required</Pill>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lane.latest_memo && (
              <a href={lane.latest_memo} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Latest report
              </a>
            )}
            <a href={lane.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {(lane.quarantined || lane.first_stuck_at || lane.consecutive_errors > 0) && (
          <p className="mt-3 text-[12.5px] leading-snug text-dim">
            {lane.quarantined
              ? `Quarantined after ${lane.stuck_cycles} consecutive stuck cycles. This is the explicit stop: the lane is excluded from further auto-escalation until a person clears it.`
              : lane.first_stuck_at
                ? `First went stuck ${day(lane.first_stuck_at)}${lane.stuck_cycles ? `, ${lane.stuck_cycles} cycle${lane.stuck_cycles === 1 ? '' : 's'} so far` : ''}. That stamp is not re-set each week it stays stuck.`
                : `${lane.consecutive_errors} consecutive runs ended in error or thin evidence.`}
          </p>
        )}

        {lane.commercial_hook && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-0.5 text-[11px] text-faint">Commercial hook</div>
            <p className="text-[12.5px] leading-relaxed text-ink">{lane.commercial_hook}</p>
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-[13px] font-medium text-ink">Standing questions</div>
            <div className="text-[11px] text-faint">{questions.length} in this lane</div>
          </div>
          {questions.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-faint">
              {lane.questions_table
                ? 'This lane’s questions table was read and holds no rows yet.'
                : 'The index row names no Table ID, so this lane’s questions could not be read.'}
            </p>
          ) : (
            <div className="space-y-3">
              {questions.map((q) => (
                <div key={q.id} className="border-b border-line pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1 text-[12.5px] font-medium text-ink">{q.question}</div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11.5px] text-faint">
                      {needsHuman(q) && <Pill tone="degraded">needs a human</Pill>}
                      {q.missing_research && <Pill>missing research</Pill>}
                      {q.movement_tag && <span>{q.movement_tag}</span>}
                      {q.confidence && <span>confidence {q.confidence.toLowerCase()}</span>}
                      <span title="Weekly research attempts on this question">{q.run_count} run{q.run_count === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  {(q.plain_summary || q.answer) && <p className="mt-1 text-[12px] leading-relaxed text-dim">{q.plain_summary ?? q.answer}</p>}
                  {q.research_stuck && q.next_experiments && (
                    <p className="mt-1 text-[11.5px] leading-snug text-faint">
                      <span className="text-degraded">Stuck.</span> Next: {q.next_experiments}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
                    <SourceLink source={q.source} />
                    <span>updated {q.last_updated ? (relativeTime(q.last_updated) ?? day(q.last_updated)) : 'never'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

export default function Clients() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getClients, [reload]);
  const [client, setClient] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { toast, setToast } = useToast();

  const d: ClientsData | null = loaded;
  const lanes = d?.lanes ?? [];
  const runStates = useMemo(() => [...new Set(lanes.map((l) => l.run_state).filter((v): v is string => Boolean(v)))].sort(), [lanes]);

  const rows = useMemo(
    () =>
      lanes
        .filter((l) => client === 'all' || l.client_id === client)
        .filter((l) => (filter === 'all' ? true : filter === 'needs-human' ? l.needs_human > 0 || l.quarantined : filter === 'stale' ? l.stale : l.run_state === filter))
        .filter((l) => !q.trim() || [l.name, l.lane_id, l.client_id, l.commercial_hook].some((v) => v && v.toLowerCase().includes(q.trim().toLowerCase()))),
    [lanes, client, filter, q],
  );
  const paged = usePaged(rows, `${client}|${filter}|${q.trim()}`);

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('clients');
      const t = r.results[0]?.tables ?? [];
      const failed = t.filter((x) => x.error);
      setToast(
        failed.length
          ? { text: `Resync failed on ${failed.map((x) => x.label).join(', ')}: ${failed[0].error}`, tone: 'failing' }
          : { text: `Resync read ${t.length} tables — the index and each lane's questions.`, tone: 'ok' },
      );
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !d) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? lanes.find((l) => l.id === open) : null;
  const totals = {
    lanes: lanes.length,
    clients: d.clients.length,
    needsHuman: lanes.reduce((n, l) => n + l.needs_human, 0),
    questions: lanes.reduce((n, l) => n + l.questions, 0),
    stale: lanes.filter((l) => l.stale).length,
    warming: lanes.filter((l) => l.warming_up).length,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Clients" subtitle="Every watched lane, grouped under the client it belongs to" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={d.sync} onResync={pull} busy={syncing} />
        </div>

        <StatStrip cols={5}>
          <CountCell label="Clients" value={totals.clients} hint={`${totals.lanes} lanes between them`} />
          <CountCell label="Needs a human" value={totals.needsHuman} tone={totals.needsHuman ? 'degraded' : 'dim'} hint="questions stuck, at three runs, or quarantined" />
          <CountCell label="Questions" value={totals.questions} hint="standing questions across every lane" />
          <CountCell label="Stale" value={totals.stale} tone={totals.stale ? 'degraded' : 'dim'} hint="no run in fourteen days" />
          <CountCell label="Warming up" value={totals.warming} hint="added, never run — not failing" />
        </StatStrip>

        {d.unreadable.length > 0 && (
          <div className="mx-6 mb-4 md:mx-8">
            <MetricCard title="Lanes that could not be read">
              <div className="space-y-1.5 text-[12.5px]">
                {d.unreadable.map((u) => (
                  <div key={u.name} className="text-dim">
                    <span className="text-ink">{u.name}</span> — {u.reason}
                  </div>
                ))}
              </div>
            </MetricCard>
          </div>
        )}

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <Segmented
            ariaLabel="Filter by client"
            value={client}
            onChange={setClient}
            options={[{ value: 'all', label: 'All clients', count: totals.lanes }, ...d.clients.map((c) => ({ value: c.client_id, label: c.label, count: c.lanes.length }))]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Filter>
              ariaLabel="Filter lanes"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: rows.length && filter === 'all' ? rows.length : lanes.filter((l) => client === 'all' || l.client_id === client).length },
                { value: 'needs-human', label: 'Needs a human', count: lanes.filter((l) => (client === 'all' || l.client_id === client) && (l.needs_human > 0 || l.quarantined)).length },
                { value: 'stale', label: 'Stale', count: lanes.filter((l) => (client === 'all' || l.client_id === client) && l.stale).length },
                ...runStates.map((st) => ({ value: st as Filter, label: st.replace(/_/g, ' '), count: lanes.filter((l) => (client === 'all' || l.client_id === client) && l.run_state === st).length })),
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search clients and lanes" />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {d.sync.source === 'none'
              ? (d.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No lane matches that search in the selected client and filter.'
                : filter === 'needs-human'
                  ? 'No lane has a question waiting on a person, and none is quarantined.'
                  : filter === 'stale'
                    ? 'Every lane has run in the last fourteen days.'
                    : 'No lane matches the selected client and filter.'}
          </EmptyState>
        ) : (
          <>
            {/*
              A table rather than a list: eleven columns of state per lane is
              what this page is for, and they read across far better in a grid
              than stacked into rows.
            */}
            <div className="card mx-6 mb-4 shrink-0 overflow-x-auto md:mx-8">
              <table className="table-cards w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {['client', 'lane', 'lane status', 'run state', 'last run', 'next run due', 'active', 'needs human', 'missing research', 'report', 'commercial hook', ''].map((h, i) => (
                      <th
                        key={i}
                        className={`sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-left text-[11.5px] font-medium whitespace-nowrap text-faint ${['active', 'needs human', 'missing research'].includes(h) ? 'text-right' : ''}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((l) => {
                    const group = d.clients.find((c) => c.client_id === l.client_id);
                    return (
                      <tr key={l.id} className="cursor-pointer" onClick={() => setOpen(l.id)}>
                        <td className="td card-meta text-dim td-clip" style={{ maxWidth: '16ch' }} title={l.client_id ?? ''}>
                          {group?.label ?? l.client_id ?? <span className="text-degraded">no client id</span>}
                          {group && group.lanes.length > 1 && <span className="ml-1.5 text-[10.5px] text-faint">{group.lanes.length} lanes</span>}
                        </td>
                        <td className="td card-title td-clip" style={{ maxWidth: '30ch' }} title={l.name}>
                          {l.name}
                        </td>
                        <td className="td text-faint">{l.lane_status?.replace(/_/g, ' ') ?? '—'}</td>
                        <td className="td card-meta">
                          <RunStatePill lane={l} />
                        </td>
                        <td className={`td tabular whitespace-nowrap ${l.stale ? 'text-degraded' : 'text-faint'}`} title={l.last_run_at ?? 'never run'}>
                          {l.last_run_at ? (relativeTime(l.last_run_at) ?? day(l.last_run_at)) : 'never'}
                        </td>
                        <td className="td tabular text-faint">{day(l.next_run_due)}</td>
                        <td className="td tabular text-right text-ink">{l.active_questions}</td>
                        <td className={`td tabular text-right ${l.needs_human ? 'text-degraded' : 'text-faint'}`}>{l.needs_human}</td>
                        <td className={`td tabular text-right ${l.missing_research ? 'text-dim' : 'text-faint'}`}>{l.missing_research}</td>
                        <td className="td">
                          {l.latest_memo ? (
                            <a href={l.latest_memo} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent-ink hover:underline">
                              latest
                            </a>
                          ) : (
                            <span className="text-faint">none</span>
                          )}
                        </td>
                        <td className="td text-faint td-clip" style={{ maxWidth: '34ch' }} title={l.commercial_hook ?? ''}>
                          {l.commercial_hook ?? '—'}
                        </td>
                        <td className="td card-actions td-actions">
                          <RowActions>
                            <RowAction label="View" tone="accent" onClick={() => setOpen(l.id)} />
                            <RowAction label="Open in Airtable" onClick={() => window.open(l.airtable.url, '_blank', 'noreferrer')} />
                          </RowActions>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination paged={paged} unit="lanes" />
          </>
        )}

        {/* Warming up is not failing, and the page says which is which. */}
        {totals.warming > 0 && (
          <div className="shrink-0 px-6 pb-6 md:px-8">
            <EmptyPanel min={0}>
              {totals.warming === 1 ? 'One lane has' : `${totals.warming} lanes have`} been added and not yet run. They are warming up, not failing: there is no run history to judge them by until the weekly loop reaches them.
            </EmptyPanel>
          </div>
        )}
      </div>

      {current && <LaneView lane={current} questions={d.questions.filter((qq) => qq.lane_id === (current.lane_id ?? current.id))} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
