import { useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../../app/useData';
import { closeIncidents, getHealthMetrics, type HealthData, type HealthMetrics, type HealthWeek, type Incident, type IncidentCloseResult } from '../../data';
import type { RecordColumn } from '../../components/ui';
import {
  CountUp,
  Definition,
  DistTile,
  EmptyPanel,
  EmptyState,
  FigureCell,
  HBar,
  Loading,
  MetricCard,
  Pagination,
  PercentCell,
  Pill,
  RecordId,
  RecordTable,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  StatCaption,
  StatCell,
  StatLabel,
  StatStrip,
  TileFigure,
  relativeTime,
  usePaged,
} from '../../components/ui';
import { ClassPill, IncidentPanel, LaneReads, SeverityPill, when } from './parts';
import { HEALTH_KINDS } from './kinds';

/**
 * One lane, or all three.
 *
 * **The three lane tabs are the same component with a different `lane`.** The
 * handlers are deliberately identical — same classes, same severities, same
 * ledger shape — and the page reflects that rather than triplicating it; a
 * per-lane copy would drift the moment one of them changed.
 *
 * All systems is the same component with `lane = null`, plus the per-lane split
 * on each card. The two things it does *not* show are the workflow breakdown
 * and the advice, because those are per-lane by nature: the failing node is the
 * useful unit and it means nothing pooled across three engines.
 */

type Filter = 'open' | 'needs-person' | 'retryable' | 'closed' | 'all';

/**
 * What each filter word means, read off the code that sets it (2026-09-22).
 *
 * `retryable` is the incident's own `retry_policy.retryable`, which every error
 * handler computes as `!(MANUAL_ONLY_CLASSES.includes(errorClass) ||
 * isCancellation)` with `MANUAL_ONLY_CLASSES = ['billing_quota',
 * 'config_auth', 'schema_validation']`; the class map here is only the
 * fallback. `BHA — Self Healer` then routes by class: `network_timeout`,
 * `upstream_5xx` and `model_output_invalid` to a retry (1, 4, 15 minutes, three
 * attempts), `schema_validation` and `unknown` to the repair bridge, and
 * `billing_quota` and `config_auth` to a person. "No longer open" is this
 * dashboard's own word: the ledger is read with `status=open`, so a row it
 * stops returning has moved on, and the read does not say where to.
 */
const FILTER_DEFS: Record<Filter, { term: string; def: string }> = {
  open: {
    term: 'Open',
    def: 'The ledger still returned it as open at the last read, and nobody has closed it from here.',
  },
  'needs-person': {
    term: 'Needs a person',
    def: 'Open, and its error handler marked it not retryable: billing or quota, credentials or access, a malformed request, or a run a user cancelled. No automatic retry will touch it.',
  },
  retryable: {
    term: 'Retryable',
    def: 'Open, and its error handler marked it retryable: a timeout or rate limit, unparseable model output, an upstream 5xx, or an error it could not classify. The self-healer retries the first three up to three times and sends unclassified ones to the repair bridge.',
  },
  closed: {
    term: 'No longer open',
    def: 'A later read of the ledger stopped returning it as open, or it was closed from this page. It may have been healed, moved to retrying, or resolved by hand — the open-only read does not say which unless the row was closed here.',
  },
  all: { term: 'All', def: 'Every incident this dashboard has held, open or not.' },
};

function matches(i: Incident, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [i.entity_id, i.summary, i.workflow, i.failed_node, i.error_class, i.subsystem, i.error_message, i.self_healing_strategy, i.execution_id].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

/** Whether a row can be closed from here: open, and not already closed by a close that landed. */
const closable = (i: Incident) => i.open_now && i.close_attempt?.state !== 'ok';

function StateCell({ i }: { i: Incident }) {
  const c = i.close_attempt;
  // A refused close is shown on the row, in red, with BHARAG's reason — never
  // greyed out as though it had worked.
  if (c?.state === 'failed' && i.open_now) {
    return (
      <span title={`Close refused by the BHARAG ledger at ${when(c.at)}${c.http ? ` (HTTP ${c.http})` : ''}: ${c.reason ?? 'no reason given'}`}>
        <Pill tone="failing">close refused</Pill>
      </span>
    );
  }
  if (i.open_now) return <Pill tone="degraded">open</Pill>;
  if (c?.state === 'ok') {
    return (
      <span className="text-faint" title={`Closed from this dashboard by ${c.actor ?? 'the dashboard login'} at ${when(c.at)}. The BHARAG ledger records it as manually resolved by the lane, not by a person.`}>
        resolved by hand
      </span>
    );
  }
  return <span className="text-faint">no longer open</span>;
}

function columns(open: (i: Incident) => void, sel: Set<string>, toggle: (id: string) => void, allOn: boolean, someOn: boolean, toggleAll: () => void, anyClosable: boolean): RecordColumn<Incident>[] {
  return [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select every open incident in this filter"
          title="Select every open incident in this filter, on every page"
          checked={allOn}
          disabled={!anyClosable}
          ref={(el) => {
            if (el) el.indeterminate = someOn && !allOn;
          }}
          onChange={toggleAll}
        />
      ),
      cell: (i) =>
        closable(i) ? (
          <input
            type="checkbox"
            aria-label={`Select ${i.entity_id}`}
            checked={sel.has(i.entity_id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggle(i.entity_id)}
          />
        ) : null,
    },
    { key: 'seen', header: 'occurred', className: 'tabular text-faint', cell: (i) => when(i.first_seen_at) },
    { key: 'id', header: 'incident', width: '26ch', clip: true, title: (i) => i.entity_id, cell: (i) => <RecordId>{i.entity_id}</RecordId> },
    { key: 'lane', header: 'lane', width: '14ch', clip: true, className: 'text-dim', cell: (i) => i.lane_label },
    {
      key: 'summary',
      header: 'what broke',
      card: 'title',
      width: '52ch',
      clip: true,
      title: (i) => i.summary ?? undefined,
      cell: (i) => i.summary ?? <span className="text-faint">No summary was recorded.</span>,
    },
    { key: 'node', header: 'failed node', width: '22ch', clip: true, className: 'text-dim', title: (i) => i.failed_node ?? undefined, cell: (i) => i.failed_node ?? <span className="text-faint">not named</span> },
    {
      key: 'class',
      header: 'class',
      card: 'meta',
      className: 'card-meta',
      title: (i) => `${CLASS_DEFS[i.error_class] ?? 'A class this page has not heard of; it keeps its own name.'} ${i.retryable ? 'Marked retryable' : 'Marked not retryable'} by ${i.retryable_from}.`,
      cell: (i) => <ClassPill cls={i.error_class} retryable={i.retryable} known={i.error_class_known} />,
    },
    { key: 'severity', header: 'severity', card: 'meta', className: 'card-meta', cell: (i) => <SeverityPill severity={i.severity} /> },
    {
      key: 'state',
      header: 'state',
      card: 'meta',
      className: 'card-meta',
      cell: (i) => <StateCell i={i} />,
    },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (i) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(i)} />
          {i.execution_url && <RowAction label="Open in n8n" onClick={() => window.open(i.execution_url!, '_blank', 'noreferrer')} />}
        </RowActions>
      ),
    },
  ];
}

export default function LaneView({ data, lane, tick, onChanged }: { data: HealthData; lane: string | null; tick: number; onChanged: () => Promise<void> }) {
  const { status, data: m, error } = useData(() => getHealthMetrics(lane), [lane, tick], { kinds: HEALTH_KINDS });
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IncidentCloseResult | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const mine = useMemo(() => (lane ? data.incidents.filter((i) => i.lane === lane) : data.incidents), [data.incidents, lane]);
  const rows = useMemo(
    () =>
      mine
        .filter((i) =>
          filter === 'all'
            ? true
            : filter === 'open'
              ? i.open_now
              : filter === 'closed'
                ? !i.open_now
                : filter === 'retryable'
                  ? i.open_now && i.retryable
                  : i.open_now && !i.retryable,
        )
        .filter((i) => matches(i, q.trim())),
    [mine, filter, q],
  );
  const paged = usePaged(rows, `${lane ?? 'all'}|${filter}|${q.trim()}`);
  const current = open ? mine.find((i) => i.entity_id === open) : null;

  // The selection is kept to rows that are still closable and still in view,
  // so the count the dialog names is exactly what is sent.
  const closableRows = rows.filter(closable);
  const selected = closableRows.filter((i) => sel.has(i.entity_id));
  const allOn = closableRows.length > 0 && selected.length === closableRows.length;
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSel(allOn ? new Set() : new Set(closableRows.map((i) => i.entity_id)));

  const runClose = async () => {
    const ids = selected.map((i) => i.entity_id);
    setBusy(true);
    setCloseError(null);
    try {
      const r = await closeIncidents(ids);
      setResult(r);
      setSel(new Set(r.results.filter((x) => x.outcome === 'failed').map((x) => x.id)));
      await onChanged();
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : 'The request did not reach the server, so nothing was closed.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const counts = {
    open: mine.filter((i) => i.open_now).length,
    'needs-person': mine.filter((i) => i.open_now && !i.retryable).length,
    retryable: mine.filter((i) => i.open_now && i.retryable).length,
    closed: mine.filter((i) => !i.open_now).length,
    all: mine.length,
  };

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {/* Above everything: which lanes actually answered. */}
      <div className="shrink-0 px-6 pb-3 md:px-8">
        <LaneReads lanes={data.lanes} only={lane} />
      </div>

      {error ? (
        <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>
      ) : !m ? (
        status === 'loading' ? (
          <Loading />
        ) : null
      ) : (
        <>
          <Strip m={m} />
          <Charts m={m} />

          <div className="shrink-0 space-y-2 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Filter>
                ariaLabel="Filter incidents"
                value={filter}
                onChange={setFilter}
                options={(['open', 'needs-person', 'retryable', 'closed', 'all'] as Filter[]).map((f) => ({ value: f, label: FILTER_DEFS[f].term, count: counts[f], title: FILTER_DEFS[f].def }))}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <SearchBox value={q} onChange={setQ} placeholder="Search incidents, nodes and advice" />
              </div>
            </div>
            <Definition term={FILTER_DEFS[filter].term}>{FILTER_DEFS[filter].def}</Definition>

            {(selected.length > 0 || result || closeError) && (
              <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[12.5px]">
                {closeError ? (
                  <span className="text-failing">Nothing was closed: {closeError}</span>
                ) : result && selected.length === 0 ? (
                  <span className={result.failed ? 'text-failing' : 'text-dim'}>{result.note}</span>
                ) : (
                  <span className="text-dim">
                    {selected.length} open incident{selected.length === 1 ? '' : 's'} selected
                    {result?.failed ? <span className="text-failing"> · {result.failed} refused by the ledger last time — hover the red rows for why</span> : null}
                  </span>
                )}
                <div className="flex items-center gap-2">
                  {selected.length > 0 && (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSel(new Set())} disabled={busy}>
                        Clear
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming(true)} disabled={busy}>
                        Mark resolved…
                      </button>
                    </>
                  )}
                  {selected.length === 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResult(null); setCloseError(null); }}>
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {rows.length === 0 ? (
            <EmptyState>
              {data.lanes.filter((l) => !lane || l.lane === lane).every((l) => !l.read)
                ? 'No lane here has been read, so this is not an empty engine — it is no answer at all. Press Resync above, and check the lane credentials named in the panel.'
                : q.trim()
                  ? 'No incident matches that search in this filter.'
                  : filter === 'open'
                    ? 'Nothing is open. The read succeeded and returned no open incident, which is a nought rather than an absence.'
                    : filter === 'needs-person'
                      ? 'Every open incident is in a class a retry can act on, so nothing here is waiting on a person.'
                      : filter === 'closed'
                        ? 'No incident held here has left the open list yet.'
                        : 'No incident is held here.'}
            </EmptyState>
          ) : (
            <>
              <RecordTable
                columns={columns((i) => setOpen(i.entity_id), sel, toggle, allOn, selected.length > 0, toggleAll, closableRows.length > 0)}
                rows={paged.rows}
                rowKey={(i) => i.entity_id}
                onOpen={(i) => setOpen(i.entity_id)}
                label="Incidents"
              />
              <Pagination paged={paged} unit="incidents" />
            </>
          )}

          {/*
            All systems ends at the table (2026-09-22, Destiny): the table is
            the page. The cards stay on the lane tabs, where the failing node
            and the advice are the useful units.
          */}
          {lane && <Cards m={m} lane={lane} onOpen={(id) => setOpen(id)} />}
        </>
      )}

      {confirming && (
        <CloseConfirm
          incidents={selected}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void runClose()}
        />
      )}
      {current && <IncidentPanel incident={current} retry={data.retries.find((r) => r.incident_id === current.entity_id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * The confirm step. It names the count, the lanes and exactly what will be
 * written, and that it cannot be undone: in the ledger a terminal state has no
 * transition out of it, so reopening means a new incident.
 */
function CloseConfirm({ incidents, busy, onCancel, onConfirm }: { incidents: Incident[]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const byLane = [...new Set(incidents.map((i) => i.lane_label))].map((l) => `${incidents.filter((i) => i.lane_label === l).length} ${l}`).join(' · ');
  const n = incidents.length;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={busy ? undefined : onCancel}>
      <div className="card fade-up w-full max-w-[560px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Close incidents">
        <h2 className="text-[18px] leading-tight">
          Close {n} incident{n === 1 ? '' : 's'} as resolved?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">
          {byLane}. Each is written to the BHARAG incident ledger with its own lane’s key, as <span className="font-medium text-ink">manually_resolved</span>. Who clicked and when is recorded here; the ledger itself records the lane as the resolver, not a person. The ledger has no way back from a closed state — an incident that recurs will open as a new one.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-faint">
          A row is marked closed only once the ledger accepts it. Any the ledger refuses stay open, in red, with its reason.
        </p>
        <div className="mt-3 max-h-[28vh] overflow-y-auto rounded-[10px] bg-raised px-3 py-2 text-[12px]">
          {incidents.map((i) => (
            <div key={i.entity_id} className="flex items-baseline justify-between gap-3">
              <span className="tabular truncate text-ink">{i.entity_id}</span>
              <span className="truncate text-faint">{i.summary ?? i.failed_node ?? ''}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? `Closing ${n}…` : `Close ${n} in the ledger`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- the strip */

/**
 * Five figures, one caption line each (2026-09-22). The server's notes are
 * kept whole behind each label's info mark.
 */
function Strip({ m }: { m: HealthMetrics }) {
  const age = relativeTime(m.most_recent.at);
  const daysQuiet = m.most_recent.at ? Math.floor((Date.now() - Date.parse(m.most_recent.at)) / 86_400_000) : null;
  return (
    <StatStrip cols={5}>
      {/*
        The failure metric, and the only cell coloured by its own value: above
        nought means something is broken now.
      */}
      <FigureCell
        label="Open incidents"
        value={m.open_incidents.n}
        tone={m.open_incidents.n ? 'degraded' : undefined}
        caption={m.open_incidents.by_lane.filter((s) => s.n).map((s) => `${s.label} ${s.n}`).join(' · ') || (m.lanes.some((l) => l.read) ? 'none open in the lanes read' : 'no lane read')}
        note={m.open_incidents.note}
      />
      <PercentCell label="Healed, no person" share={m.healed} caption="recovered retries ÷ retries that finished" />
      <FigureCell
        label="Needing a person"
        value={m.needing_person.n}
        tone={m.needing_person.n ? 'degraded' : undefined}
        caption={`${m.needing_person.non_retryable} not retryable · ${m.needing_person.exhausted} out of retries`}
        note={m.needing_person.note}
      />
      <StatCell>
        <div className="min-w-0">
          <StatLabel label="Latest incident" detail={m.most_recent.note} />
          <div className={`mt-1 text-[15px] leading-tight ${daysQuiet !== null && daysQuiet >= 3 ? 'text-degraded' : 'text-ink'}`}>{age ?? 'none held'}</div>
          <StatCaption>{m.most_recent.at ? `occurred ${when(m.most_recent.at)} UTC` : 'nothing held to date'}</StatCaption>
        </div>
      </StatCell>
      <FigureCell
        label="Retries, 24h"
        value={m.retries_24h.n}
        caption={`${m.retries_24h.recovered} recovered · ${m.retries_24h.retrying} retrying · ${m.retries_24h.exhausted} exhausted`}
        note={m.retries_24h.note}
      />
    </StatStrip>
  );
}

/* ------------------------------------------------------------- the charts */

/**
 * The two weekly charts, rebuilt (2026-09-22, Destiny).
 *
 * The stacked columns carried no numbers, no axis and no dates between the
 * first and last week, so a reader could not get a count out of them — and
 * every incident was dated by its import, so the one column that had anything
 * in it was the week somebody pressed Resync. Now: one column per week with its
 * count printed on it and its dates under it, the lane split as numbers in a
 * grid below, and class over time as a grid of counts — a stack of seven
 * colours over eight weeks is the wrong shape for "what kind of thing is
 * breaking", and a table of numbers is the right one.
 */
function Charts({ m }: { m: HealthMetrics }) {
  const noRead = !m.lanes.some((l) => l.read);
  const total = m.per_week_lane.reduce((n, w) => n + w.total, 0);
  const window = `${m.per_week_lane[0]?.label ?? ''} to ${m.per_week_lane[m.per_week_lane.length - 1]?.label ?? ''}`;
  const laneRows = m.lanes.map((l) => l.label);
  const classRows = [...new Set(m.per_week_class.flatMap((w) => Object.keys(w.counts)))].filter((c) => m.per_week_class.some((w) => (w.counts[c] ?? 0) > 0));
  return (
    <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
      <MetricCard title="Incidents per week" right={`${total} in 8 weeks`} note={m.week_note} align="top">
        {noRead ? (
          <EmptyPanel>No lane has been read, so there is no count for any week — not a count of nought.</EmptyPanel>
        ) : total === 0 ? (
          <EmptyPanel>No incident occurred in the eight weeks {window}, in the lanes that were read.</EmptyPanel>
        ) : (
          <>
            <WeekBars weeks={m.per_week_lane} unit="incidents" />
            <WeekGrid weeks={m.per_week_lane} rows={laneRows} rowLabel={(r) => r} tone={() => 'ink'} />
          </>
        )}
      </MetricCard>
      <MetricCard
        title="Incidents by class, per week"
        right="error_class"
        note={`Each cell is how many incidents of that class occurred that week, ${window}. Blue classes are retried by the self-healer; amber ones are not. Hover a class for what it means. A class with no incident in the window is left out.`}
        align="top"
      >
        {noRead ? (
          <EmptyPanel>No lane has been read, so no class has a count.</EmptyPanel>
        ) : classRows.length === 0 ? (
          <EmptyPanel>No incident occurred in the eight weeks {window}, so no class has one.</EmptyPanel>
        ) : (
          <WeekGrid
            weeks={m.per_week_class}
            rows={classRows}
            rowLabel={(c) => <span title={CLASS_DEFS[c] ?? 'A class this page has not heard of.'}>{c.toLowerCase().replace(/_/g, ' ')}</span>}
            tone={(c) => (RETRIED.has(c) ? 'accent' : 'degraded')}
            shaded
            header
          />
        )}
      </MetricCard>
    </div>
  );
}

/** "3 Aug" from a week's Monday, so every column carries its own month. */
function weekStartLabel(week: string): string {
  const d = new Date(`${week}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/** The grid both charts share: a label column, one column per week, a total. */
const gridCols = (n: number) => `minmax(0,8.5rem) repeat(${n}, minmax(0,1fr)) 2.5rem`;

/**
 * One column per week, its count printed on it and its week under it. A nought
 * is drawn as a nought — every lane was read, so a quiet week is a real 0.
 */
function WeekBars({ weeks, unit }: { weeks: HealthWeek[]; unit: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.total));
  const cols = gridCols(weeks.length);
  return (
    <div role="img" aria-label={`${unit} per week: ${weeks.map((w) => `${w.label} ${w.total}`).join(', ')}`}>
      <div className="grid items-end gap-x-1" style={{ gridTemplateColumns: cols, height: 96 }}>
        <span className="self-end pb-0.5 text-[10px] text-faint">{unit}</span>
        {weeks.map((w) => (
          <div key={w.week} className="flex min-w-0 flex-col items-center justify-end self-stretch" title={`${w.label}: ${w.total} ${unit}`}>
            <span className={`tabular mb-1 text-[11.5px] ${w.total ? 'text-ink' : 'text-faint'}`}>{w.total}</span>
            <div className="w-full rounded-[4px]" style={{ height: w.total ? `${Math.max((w.total / max) * 72, 4)}px` : '1px', background: w.total ? 'var(--accent)' : 'var(--line-strong)', opacity: 0.85 }} />
          </div>
        ))}
        <span className="tabular self-end pb-0.5 text-right text-[11.5px] font-medium text-ink">{weeks.reduce((n, w) => n + w.total, 0)}</span>
      </div>
      <WeekHeader weeks={weeks} />
    </div>
  );
}

function WeekHeader({ weeks }: { weeks: HealthWeek[] }) {
  return (
    <div className="grid items-baseline gap-x-1 border-t border-line pt-1 text-[10px] text-faint" style={{ gridTemplateColumns: gridCols(weeks.length) }}>
      <span>week of (Mon, UTC)</span>
      {weeks.map((w) => (
        <span key={w.week} className="truncate text-center" title={w.label}>
          {weekStartLabel(w.week)}
        </span>
      ))}
      <span className="text-right">total</span>
    </div>
  );
}

/** A grid of counts: one row per lane or class, one column per week, a total at the end. */
function WeekGrid({ weeks, rows, rowLabel, tone, shaded, header }: { weeks: HealthWeek[]; rows: string[]; rowLabel: (r: string) => ReactNode; tone: (r: string) => 'ink' | 'accent' | 'degraded'; shaded?: boolean; header?: boolean }) {
  const max = Math.max(1, ...weeks.flatMap((w) => rows.map((r) => w.counts[r] ?? 0)));
  const cols = gridCols(weeks.length);
  return (
    <div className="mt-1 text-[11.5px]">
      {header && <WeekHeader weeks={weeks} />}
      {rows.map((r) => {
        const sum = weeks.reduce((n, w) => n + (w.counts[r] ?? 0), 0);
        return (
          <div key={r} className="grid items-center gap-x-1 border-t border-line py-[3px]" style={{ gridTemplateColumns: cols }}>
            <span className="truncate text-dim">{rowLabel(r)}</span>
            {weeks.map((w) => {
              const n = w.counts[r] ?? 0;
              const colour = tone(r) === 'accent' ? 'var(--accent)' : tone(r) === 'degraded' ? 'var(--degraded)' : 'var(--ink)';
              return (
                <span
                  key={w.week}
                  className={`tabular rounded-[4px] text-center ${n ? 'text-ink' : 'text-faint'}`}
                  style={shaded && n ? { background: `color-mix(in srgb, ${colour} ${Math.round(12 + (n / max) * 38)}%, transparent)` } : undefined}
                  title={`${w.label}: ${n}`}
                >
                  {n}
                </span>
              );
            })}
            <span className="tabular text-right font-medium text-ink">{sum}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The classes the self-healer retries, from `Decide Lane` in `BHA — Self Healer`. */
const RETRIED = new Set(['NETWORK_TIMEOUT', 'UPSTREAM_5XX', 'MODEL_OUTPUT_INVALID']);

/**
 * One line per error class, read off the three error handlers' own rules
 * ("Build AI Payload", "Parse Classification", "Compute Incident Payload") and
 * the self-healer's routing (2026-09-22).
 */
export const CLASS_DEFS: Record<string, string> = {
  NETWORK_TIMEOUT: 'A timeout, a dropped connection, a 429 rate limit, or a run that crashed or ran out of memory. Retried by the self-healer.',
  MODEL_OUTPUT_INVALID: 'A model answered in a shape its own parser rejected. Retried, because a model answers differently each run.',
  UPSTREAM_5XX: 'Another service answered 500, 502, 503 or 504. Retried.',
  BILLING_QUOTA: 'A 402, payment required, or credits or quota exhausted. Not retried; goes to a person.',
  CONFIG_AUTH: 'A credential or access failure, such as a Google permission denied. Not retried; goes to a person.',
  SCHEMA_VALIDATION: 'A request that cannot work as sent: a 404, a missing or forbidden field, or a 400. Not retried; sent to the repair bridge.',
  UNKNOWN: 'Neither the handler’s rules nor its model classifier could place it. Sent to the repair bridge.',
};

/* -------------------------------------------------------------- the cards */

function Cards({ m, lane, onOpen }: { m: HealthMetrics; lane: string | null; onOpen: (id: string) => void }) {
  const pct = (n: number) => `${Math.round(n)}%`;
  const totalOpen = m.by_lane.reduce((n, l) => n + l.open, 0);
  const retryableOpen = m.by_lane.reduce((n, l) => n + l.retryable, 0);
  const classTotal = m.by_class.reduce((n, c) => n + c.n, 0);
  const retryableClasses = m.by_class.filter((c) => c.retryable).reduce((n, c) => n + c.n, 0);
  const critical = m.by_severity.find((s) => s.key === 'critical')?.n ?? 0;
  const severityTotal = m.by_severity.reduce((n, s) => n + s.n, 0);
  const topSubsystem = [...m.by_subsystem].sort((a, b) => b.n - a.n)[0];
  const subsystemTotal = m.by_subsystem.reduce((n, s) => n + s.n, 0);

  return (
    <div className="grid gap-4 px-6 pb-6 md:grid-cols-2 md:px-8">
      {/*
        All systems only. On a lane tab this answers a question the tab is not
        asking — the other two lanes' counts are not context, they are noise —
        and the tab header already carries the one figure that matters here.

        The lane with most incidents is not the unhealthiest, which is why the
        headline is the retryable share rather than the count.
      */}
      {!lane && (
      <MetricCard title="By lane" right="source" note={m.by_lane_note} noteMinLines={5} align="top">
        <TileFigure
          value={totalOpen ? (retryableOpen / totalOpen) * 100 : null}
          format={pct}
          missing={m.lanes.some((l) => l.read) ? 'Nothing is open in any lane that was read.' : 'No lane was read, so there is nothing to divide.'}
          sub={`${retryableOpen} of ${totalOpen} open incidents are in a class a retry can act on${m.by_lane.some((l) => l.note) ? ', over the lanes that answered and whatever is still held for the ones that did not' : ''}`}
          replayKey={`lanes|${totalOpen}`}
        >
          <div className="space-y-2">
            {m.by_lane.map((l) =>
              /*
                **A lane that was not read gets no bar.** It used to get one —
                and because the bar is scaled to the largest lane, a lane nobody
                asked was drawn full width, reading as the worst lane on the
                page. Whatever count is held for it is what happened to be
                stored, not an answer, and a bar is a measured value.
              */
              l.note ? (
                <div key={l.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[12.5px]">
                  <span className="truncate text-dim">{l.label}</span>
                  <span className="truncate text-right text-[11.5px] text-degraded" title={l.note}>
                    not read
                  </span>
                  <span className="col-span-2 truncate text-[11px] text-faint" title={l.note}>
                    {l.note}
                  </span>
                </div>
              ) : (
                <HBar
                  key={l.key}
                  label={l.label}
                  value={l.open}
                  max={Math.max(1, ...m.by_lane.filter((x) => !x.note).map((x) => x.open))}
                  tone={l.open ? 'degraded' : 'ink'}
                  valueNode={<CountUp value={l.open} />}
                  right={<span className="text-faint">{l.retryable} retryable</span>}
                />
              ),
            )}
          </div>
        </TileFigure>
      </MetricCard>
      )}

      <MetricCard title="By class" right="error_class" note={m.class_note} noteMinLines={5} align="top">
        <TileFigure
          value={classTotal ? (retryableClasses / classTotal) * 100 : null}
          format={pct}
          missing="No incident is held, so there is nothing to classify."
          sub={`${retryableClasses} of ${classTotal} are in a retryable class`}
          replayKey={`class|${classTotal}`}
        >
          <div className="space-y-2">
            {m.by_class.map((c) => (
              <HBar
                key={c.key}
                label={
                  <span title={c.what ?? (c.known ? undefined : 'A class this page has not heard of. It keeps its own name rather than being folded into UNKNOWN.')}>
                    {c.label.toLowerCase().replace(/_/g, ' ')}
                    {!c.known && <span className="ml-1 text-faint">· new</span>}
                  </span>
                }
                value={c.n}
                max={Math.max(1, ...m.by_class.map((x) => x.n))}
                tone={c.retryable ? 'accent' : 'degraded'}
                valueNode={<CountUp value={c.n} />}
                right={<span className="text-faint">{c.retryable ? 'retryable' : 'needs a person'}</span>}
              />
            ))}
          </div>
        </TileFigure>
      </MetricCard>

      <DistTile
        title="By severity"
        field="severity"
        note={m.severity_note}
        slices={m.by_severity}
        headline={severityTotal ? critical : null}
        format={(n) => String(Math.round(n))}
        tone={critical ? 'failing' : undefined}
        missing="No incident is held."
        sub={`critical, of ${severityTotal} incidents held`}
        toneOf={(s) => (s.key === 'critical' ? 'failing' : s.key === 'high' ? 'degraded' : 'ink')}
      />

      <DistTile
        title="By subsystem"
        field="subsystem"
        note={m.subsystem_note}
        slices={m.by_subsystem}
        headline={subsystemTotal && topSubsystem ? (topSubsystem.n / subsystemTotal) * 100 : null}
        missing="No incident is held."
        sub={topSubsystem ? `${topSubsystem.n} of ${subsystemTotal} are ${topSubsystem.label}, the largest group` : undefined}
      />

      <MetricCard title="Top recurring faults" right="error_counts" note={m.faults_note} noteMinLines={5} align="top">
        <TileFigure
          value={m.top_faults.length || null}
          format={(n) => String(Math.round(n))}
          missing="No fault signature is held. The error_counts table reaches this dashboard through the resync above."
          sub="signatures held, newest first"
          replayKey={`faults|${m.top_faults.length}`}
        >
          {m.top_faults.length === 0 ? null : (
            <div className="space-y-1.5">
              {m.top_faults.map((f) => (
                <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[12px]">
                  <span className="truncate text-ink" title={f.signature}>
                    {f.failed_node ?? f.signature}
                  </span>
                  <span className="tabular shrink-0 text-faint">{f.last_seen ? f.last_seen.slice(0, 16).replace('T', ' ') : 'undated'}</span>
                  <span className="col-span-2 truncate text-[11px] text-faint">
                    {f.workflow ?? 'no workflow'} · {f.error_class.toLowerCase().replace(/_/g, ' ')} ·{' '}
                    {/* A countdown, so it is labelled as one rather than as a total. */}
                    {f.error_count === null ? 'count not recorded' : `${f.error_count} since the window opened`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </TileFigure>
      </MetricCard>

      <MetricCard title="Time to resolve" right="resolved_at" note={m.time_to_resolve.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.time_to_resolve.p50}
          format={(n) => `${Math.round(n * 10) / 10}h`}
          missing="No incident held carries a resolution time."
          sub={m.time_to_resolve.p95 === null ? undefined : `p50, with p95 at ${m.time_to_resolve.p95}h — never a mean`}
          replayKey={`ttr|${m.time_to_resolve.n}`}
        >
          <HBar
            label="resolved"
            value={m.time_to_resolve.n}
            max={Math.max(1, m.time_to_resolve.of)}
            tone="accent"
            valueNode={<CountUp value={m.time_to_resolve.n} />}
            right={<span className="text-faint">of {m.time_to_resolve.of} held</span>}
          />
        </TileFigure>
      </MetricCard>

      <MetricCard title="Reclassified" right="reclassified_from" note={m.reclassified.note} noteMinLines={5} align="top">
        <TileFigure
          value={m.reclassified.of ? m.reclassified.n : null}
          format={(n) => String(Math.round(n))}
          missing="No incident is held, so no handler could have reclassified one."
          sub={`of ${m.reclassified.of} incidents held`}
          replayKey={`recl|${m.reclassified.of}`}
        >
          {m.reclassified.pairs.length === 0 ? null : (
            <div className="space-y-2">
              {m.reclassified.pairs.map((p) => (
                <HBar
                  key={`${p.from}|${p.to}`}
                  label={`${p.from.toLowerCase().replace(/_/g, ' ')} → ${p.to.toLowerCase().replace(/_/g, ' ')}`}
                  value={p.n}
                  max={Math.max(1, ...m.reclassified.pairs.map((x) => x.n))}
                  valueNode={<CountUp value={p.n} />}
                />
              ))}
            </div>
          )}
        </TileFigure>
      </MetricCard>

      {/*
        Per-lane only. The failing node is the useful unit and it means nothing
        pooled across three engines, so All systems does not draw it.
      */}
      {lane && (
        <MetricCard
          title="This lane's workflows"
          right="workflow_or_scenario"
          note="Open incidents by the workflow they came from, then by the node that actually failed. The failing node is the useful unit — one workflow can break in three unrelated places, and fixing the workflow is not a thing anybody can do."
          noteMinLines={5}
          align="top"
        >
          <TileFigure
            value={m.workflows.length || null}
            format={(n) => String(Math.round(n))}
            missing="Nothing is open in this lane, so no workflow is failing."
            sub="workflows with an open incident"
            replayKey={`wf|${m.workflows.length}`}
          >
            <div className="space-y-2.5">
              {m.workflows.map((w) => (
                <div key={w.workflow}>
                  <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                    <span className="truncate text-ink" title={w.workflow}>
                      {w.workflow}
                    </span>
                    <span className="tabular shrink-0 text-faint">{w.open} open</span>
                  </div>
                  {w.nodes.map((n) => (
                    <button
                      key={n.node}
                      type="button"
                      onClick={() => n.incidents[0] && onOpen(n.incidents[0].entity_id)}
                      className="rowlike -mx-1 flex w-full items-baseline justify-between gap-2 rounded-[8px] px-1 py-0.5 text-left text-[11.5px]"
                    >
                      <span className="truncate text-dim">{n.node}</span>
                      <span className="tabular shrink-0 text-faint">{n.open}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </TileFigure>
        </MetricCard>
      )}

      {/*
        Also per-lane, and deliberately the tallest card: the advice is the most
        useful text on this page and is never truncated.
      */}
      {lane && (
        <MetricCard title="The advice given" right="self_healing_strategy" note={m.advice_note} noteMinLines={5} align="top">
          {m.advice.length === 0 ? (
            <EmptyPanel>
              {m.open_incidents.n ? 'No open incident in this lane carries self-healing advice.' : 'Nothing is open in this lane, so there is no advice outstanding.'}
            </EmptyPanel>
          ) : (
            <div className="space-y-3">
              {m.advice.map((i) => (
                <div key={i.entity_id} className="rounded-[10px] bg-raised px-3 py-2.5">
                  <button type="button" onClick={() => onOpen(i.entity_id)} className="flex w-full items-baseline justify-between gap-2 text-left">
                    <span className="truncate text-[12px] font-medium text-ink" title={i.summary ?? i.entity_id}>
                      {i.failed_node ?? i.entity_id}
                    </span>
                    <span className="tabular shrink-0 text-[11px] text-faint">{i.entity_id}</span>
                  </button>
                  {/* In full. Never clamped, never a single line. */}
                  <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{i.self_healing_strategy}</p>
                </div>
              ))}
            </div>
          )}
        </MetricCard>
      )}
    </div>
  );
}
