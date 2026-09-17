import { useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { getRetryMetrics, retryIncident, type HealthData, type RetryAttempt, type RetryMetrics } from '../../data';
import type { RecordColumn } from '../../components/ui';
import {
  DistTile,
  EmptyState,
  FigureCell,
  Loading,
  MetricCard,
  Pagination,
  PercentCell,
  RecordId,
  RecordTable,
  SearchBox,
  Segmented,
  SourceLink,
  StatStrip,
  TileFigure,
  usePaged,
} from '../../components/ui';
import { ClassPill, RetryStatusPill, when } from './parts';

/**
 * The self-healing loop's own record, entirely from `retry_attempts`.
 *
 * Two things this tab must not overstate, and both shape how it is drawn:
 *
 * **A retry that ran is not a retry that worked.** `Retrying` is genuinely
 * undecided — the status comes from the retried execution's own outcome — so it
 * is drawn as undecided rather than as optimistic, and it is excluded from the
 * recovery rate rather than counted as a failure or a success.
 *
 * **`Exhausted` is not always a failure of the system.** A pruned execution —
 * one n8n no longer holds the data for — lands there immediately and correctly.
 * `last_result` says which happened, so it is shown in full on every row rather
 * than summarised into a status anybody would have to guess behind.
 */

type Filter = 'all' | 'Retrying' | 'Recovered' | 'Exhausted' | 'manual';

function matches(r: RetryAttempt, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.incident_id, r.workflow, r.failed_node, r.error_class, r.execution_id, r.last_result, r.lane_label].some((v) => v && v.toLowerCase().includes(n));
}

export default function Retries({ data, tick, onChanged }: { data: HealthData; tick: number; onChanged: () => void }) {
  const { status, data: m, error } = useData(getRetryMetrics, [tick]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  const rows = useMemo(
    () => data.retries.filter((r) => (filter === 'all' ? true : filter === 'manual' ? r.triggered_by === 'Dashboard' : r.status === filter)).filter((r) => matches(r, q.trim())),
    [data.retries, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}`);

  const counts = {
    all: data.retries.length,
    Retrying: data.retries.filter((r) => r.status === 'Retrying').length,
    Recovered: data.retries.filter((r) => r.status === 'Recovered').length,
    Exhausted: data.retries.filter((r) => r.status === 'Exhausted').length,
    manual: data.retries.filter((r) => r.triggered_by === 'Dashboard').length,
  };

  const run = (r: RetryAttempt) => {
    if (busy) return;
    setBusy(r.incident_id);
    setSaid(null);
    void (async () => {
      try {
        const res = await retryIncident(r.incident_id);
        setSaid({ id: r.incident_id, ok: res.ok, message: res.message });
        if (res.ok) onChanged();
      } catch (e) {
        setSaid({ id: r.incident_id, ok: false, message: e instanceof Error ? e.message : 'The retry could not be sent.' });
      } finally {
        setBusy(null);
      }
    })();
  };

  const columns: RecordColumn<RetryAttempt>[] = [
    { key: 'incident', header: 'incident', width: '26ch', clip: true, title: (r) => r.incident_id, cell: (r) => <RecordId>{r.incident_id}</RecordId> },
    { key: 'lane', header: 'lane', width: '14ch', clip: true, className: 'text-dim', cell: (r) => r.lane_label },
    { key: 'workflow', header: 'workflow', width: '24ch', clip: true, className: 'text-dim', title: (r) => r.workflow ?? undefined, cell: (r) => r.workflow ?? <span className="text-faint">not named</span> },
    {
      key: 'node',
      header: 'failed node',
      card: 'title',
      width: '24ch',
      clip: true,
      title: (r) => r.failed_node ?? undefined,
      cell: (r) => r.failed_node ?? <span className="text-faint">not named</span>,
    },
    { key: 'class', header: 'class', card: 'meta', className: 'card-meta', cell: (r) => <ClassPill cls={r.error_class} retryable known /> },
    {
      key: 'attempts',
      header: 'attempts',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (r) => ((r.attempts ?? 0) >= 3 ? 'text-degraded' : 'text-dim'),
      cell: (r) => (r.attempts === null ? <span className="text-faint">—</span> : `${r.attempts}/3`),
    },
    { key: 'status', header: 'status', card: 'meta', className: 'card-meta', cell: (r) => <RetryStatusPill status={r.status} /> },
    { key: 'last', header: 'last attempt', className: 'tabular text-faint', cell: (r) => when(r.last_attempt_at) },
    {
      key: 'result',
      header: 'what happened',
      width: '48ch',
      clip: true,
      className: 'text-dim',
      // In full in the tooltip; the column clips only because a table must.
      title: (r) => r.last_result ?? undefined,
      cell: (r) => r.last_result ?? <span className="text-faint">nothing recorded</span>,
    },
    { key: 'source', header: 'source', cell: (r) => <SourceLink source={r.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          {/*
            The same mechanism as the schedule's, so it is a plain button with
            a plain label — not styled as something more powerful. Disabled at
            the cap, and the tooltip says why rather than leaving it dead.
          */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!r.can_retry || busy !== null || !data.heal_configured}
            title={
              !data.heal_configured
                ? 'ENGINE_HEAL_URL is not set on this server, so there is nothing to ask for a retry.'
                : (r.blocked_reason ?? 'Asks the healer to retry this incident — the same call the 5-minute schedule makes.')
            }
            onClick={(e) => {
              e.stopPropagation();
              run(r);
            }}
          >
            {busy === r.incident_id ? 'Asking…' : 'Retry now'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {error ? (
        <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>
      ) : !m ? (
        status === 'loading' ? (
          <Loading />
        ) : null
      ) : (
        <>
          <Strip m={m} />

          {said && (
            <div className={`card mx-6 mb-4 px-5 py-3 text-[12.5px] md:mx-8 ${said.ok ? 'text-ink' : 'text-failing'}`} role="status">
              <span className="tabular text-faint">{said.id}</span> — {said.message}
            </div>
          )}

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Filter>
                ariaLabel="Filter retries"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All', count: counts.all },
                  { value: 'Retrying', label: 'Retrying', count: counts.Retrying },
                  { value: 'Recovered', label: 'Recovered', count: counts.Recovered },
                  { value: 'Exhausted', label: 'Exhausted', count: counts.Exhausted },
                  { value: 'manual', label: 'Started here', count: counts.manual },
                ]}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <SearchBox value={q} onChange={setQ} placeholder="Search incidents, nodes and outcomes" />
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState>
              {data.retries_freshness.source === 'none'
                ? (data.retries_freshness.note ??
                  'No retry is held. The healer writes a row the first time it touches an incident, and Resync from Airtable brings them across.')
                : q.trim()
                  ? 'No retry matches that search in this filter.'
                  : filter === 'Exhausted'
                    ? 'Nothing has used all three attempts. Nothing has been escalated for want of a retry.'
                    : filter === 'manual'
                      ? 'No retry here was started from this page — every one was picked up by the 5-minute schedule.'
                      : `No retry is ${filter.toLowerCase()}.`}
            </EmptyState>
          ) : (
            <>
              <RecordTable columns={columns} rows={paged.rows} rowKey={(r) => r.id} label="Retry attempts" />
              <Pagination paged={paged} unit="retries" />
            </>
          )}

          <Cards m={m} />
        </>
      )}
    </div>
  );
}

function Strip({ m }: { m: RetryMetrics }) {
  const atCap = m.attempts_mix.find((a) => a.key === '3')?.n ?? 0;
  const manual = m.triggered_by.find((t) => t.key === 'Dashboard')?.n ?? 0;
  return (
    <StatStrip cols={5}>
      <PercentCell label="Recovery rate" share={m.recovery_rate} />
      <FigureCell label="Currently retrying" value={m.retrying} note={m.retrying_note} />
      {/* The one coloured cell here: each of these has already been escalated. */}
      <FigureCell label="Exhausted" value={m.exhausted} tone={m.exhausted ? 'degraded' : undefined} note={m.exhausted_note} />
      <FigureCell
        label="At the third attempt"
        value={atCap}
        note={
          <>
            <span className="mb-1 block text-dim">{m.attempts_mix.map((a) => `${a.label}: ${a.n}`).join(' · ')}</span>
            {m.attempts_note}
          </>
        }
      />
      <FigureCell
        label="Started from this page"
        value={manual}
        note={
          <>
            <span className="mb-1 block text-dim">of {m.scope.rows} retries held</span>
            {m.triggered_note}
          </>
        }
      />
    </StatStrip>
  );
}

function Cards({ m }: { m: RetryMetrics }) {
  const rows = m.scope.rows;
  const one = m.attempts_mix.find((a) => a.key === '1')?.n ?? 0;
  const topClass = [...m.by_class].sort((a, b) => b.n - a.n)[0];
  const classTotal = m.by_class.reduce((n, c) => n + c.n, 0);

  return (
    <div className="grid gap-4 px-6 pb-6 md:grid-cols-2 md:px-8">
      <DistTile
        title="Attempts used"
        field="attempts"
        note={m.attempts_note}
        slices={m.attempts_mix}
        headline={rows ? (one / rows) * 100 : null}
        missing="No retry is held."
        sub={`${one} of ${rows} are on their first attempt`}
        toneOf={(s) => (s.key === '3' ? 'degraded' : 'ink')}
      />

      <DistTile
        title="Manual against automatic"
        field="triggered_by"
        note={m.triggered_note}
        slices={m.triggered_by}
        headline={rows ? ((m.triggered_by.find((t) => t.key === 'Schedule')?.n ?? 0) / rows) * 100 : null}
        missing="No retry is held."
        sub={`of ${rows} retries were picked up by the schedule rather than started by hand`}
      />

      <DistTile
        title="What is being retried"
        field="error_class"
        note={m.class_note}
        slices={m.by_class}
        headline={classTotal && topClass ? (topClass.n / classTotal) * 100 : null}
        missing="No retry is held."
        sub={topClass ? `${topClass.n} of ${classTotal} are ${topClass.label.toLowerCase().replace(/_/g, ' ')}, the largest group` : undefined}
      />

      <MetricCard
        title="How the retrying works"
        right="the healer"
        note="Written here rather than left implicit, because every figure on this tab depends on it and none of it is visible from the rows alone."
        noteMinLines={5}
        align="top"
      >
        <TileFigure value={null} format={() => ''} missing="" sub={undefined}>
          <div className="space-y-2 text-[12px] leading-relaxed text-dim">
            <p>
              The healer runs every 5 minutes and calls n8n's own retry endpoint with <span className="text-ink">loadWorkflow: true</span>, which resumes the run
              <span className="text-ink"> from the failed node</span> rather than replaying it from the start. That is why a retry does not re-post Slack messages or
              re-write rows it already wrote.
            </p>
            <p>
              Backoff is <span className="text-ink">1 minute, then 4, then 15</span>, each randomised by a fifth either way. Three attempts is the cap, and reaching it
              breaks the circuit on purpose.
            </p>
            <p>
              <span className="text-ink">Retry now</span> posts to the same webhook the schedule posts to and is recorded the same way against the same cap. The only
              thing that differs is who is recorded as having started it.
            </p>
          </div>
        </TileFigure>
      </MetricCard>
    </div>
  );
}
