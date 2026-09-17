import { useMemo, useState } from 'react';
import { useData } from '../../app/useData';
import { getHealthMetrics, type HealthData, type HealthMetrics, type Incident } from '../../data';
import type { RecordColumn } from '../../components/ui';
import {
  CountUp,
  DistTile,
  EmptyPanel,
  EmptyState,
  FigureCell,
  HBar,
  Loading,
  MetricCard,
  OutcomeColumns,
  Pagination,
  PercentCell,
  Pill,
  RecordId,
  RecordTable,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  StatCell,
  StatStrip,
  TileFigure,
  relativeTime,
  usePaged,
} from '../../components/ui';
import { ClassPill, IncidentPanel, LaneReads, SeverityPill, when } from './parts';

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

const LANE_COLOUR = (label: string) =>
  label === 'Bays' ? 'var(--accent)' : label === 'North Star' ? 'var(--ok)' : label === 'Research Twin' ? 'var(--degraded)' : 'var(--dim)';

/** Retryable classes read as the accent; the rest as the colour of a thing nobody will fix on its own. */
const CLASS_COLOUR = (cls: string) =>
  cls === 'NETWORK_TIMEOUT' || cls === 'MODEL_OUTPUT_INVALID' || cls === 'UPSTREAM_5XX'
    ? 'var(--accent)'
    : cls === 'BILLING_QUOTA' || cls === 'CONFIG_AUTH'
      ? 'var(--failing)'
      : cls === 'SCHEMA_VALIDATION'
        ? 'var(--degraded)'
        : 'var(--dim)';

type Filter = 'open' | 'needs-person' | 'retryable' | 'closed' | 'all';

function matches(i: Incident, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [i.entity_id, i.summary, i.workflow, i.failed_node, i.error_class, i.subsystem, i.error_message, i.self_healing_strategy, i.execution_id].some(
    (v) => v && v.toLowerCase().includes(n),
  );
}

function columns(open: (i: Incident) => void): RecordColumn<Incident>[] {
  return [
    { key: 'seen', header: 'first seen', className: 'tabular text-faint', cell: (i) => when(i.first_seen_at) },
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
    { key: 'class', header: 'class', card: 'meta', className: 'card-meta', cell: (i) => <ClassPill cls={i.error_class} retryable={i.retryable} known={i.error_class_known} /> },
    { key: 'severity', header: 'severity', card: 'meta', className: 'card-meta', cell: (i) => <SeverityPill severity={i.severity} /> },
    {
      key: 'state',
      header: 'state',
      card: 'meta',
      className: 'card-meta',
      title: (i) => (i.open_now ? undefined : `The ledger's open query stopped returning this${i.last_seen_open ? ` after ${when(i.last_seen_open)}` : ''}`),
      cell: (i) => (i.open_now ? <Pill tone="degraded">open</Pill> : <span className="text-faint">closed</span>),
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

export default function LaneView({ data, lane, tick }: { data: HealthData; lane: string | null; tick: number }) {
  const { status, data: m, error } = useData(() => getHealthMetrics(lane), [lane, tick]);
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

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

          <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<Filter>
                ariaLabel="Filter incidents"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'open', label: 'Open', count: counts.open },
                  { value: 'needs-person', label: 'Needs a person', count: counts['needs-person'] },
                  { value: 'retryable', label: 'Retryable', count: counts.retryable },
                  { value: 'closed', label: 'No longer open', count: counts.closed },
                  { value: 'all', label: 'All', count: counts.all },
                ]}
              />
              <div className="flex flex-1 items-center justify-end gap-3">
                <SearchBox value={q} onChange={setQ} placeholder="Search incidents, nodes and advice" />
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState>
              {data.lanes.filter((l) => !lane || l.lane === lane).every((l) => !l.read)
                ? 'No lane here has been read, so this is not an empty engine — it is no answer at all. Press Resync from Airtable above, and check the lane credentials named in the panel.'
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
              <RecordTable columns={columns((i) => setOpen(i.entity_id))} rows={paged.rows} rowKey={(i) => i.entity_id} onOpen={(i) => setOpen(i.entity_id)} label="Incidents" />
              <Pagination paged={paged} unit="incidents" />
            </>
          )}

          <Cards m={m} lane={lane} onOpen={(id) => setOpen(id)} />
        </>
      )}

      {current && <IncidentPanel incident={current} retry={data.retries.find((r) => r.incident_id === current.entity_id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------- the strip */

function Strip({ m }: { m: HealthMetrics }) {
  const age = relativeTime(m.most_recent.at);
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
        note={
          <>
            {m.open_incidents.by_lane.length > 0 && (
              <span className="mb-1 block text-dim">{m.open_incidents.by_lane.map((s) => `${s.label} ${s.n}`).join(' · ')}</span>
            )}
            {m.open_incidents.note}
          </>
        }
      />
      <PercentCell label="Healed without a person" share={m.healed} />
      <FigureCell
        label="Needing a person"
        value={m.needing_person.n}
        tone={m.needing_person.n ? 'degraded' : undefined}
        note={m.needing_person.note}
      />
      <StatCell>
        <div className="min-w-0">
          <div className="kicker truncate">Most recent incident</div>
          <div className="mt-1 text-[15px] leading-tight text-ink">{age ?? 'none held'}</div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" style={{ minHeight: '5.5em' }}>
            {m.most_recent.note}
          </div>
        </div>
      </StatCell>
      <FigureCell
        label="Retries in the last 24h"
        value={m.retries_24h.n}
        note={
          <>
            <span className="mb-1 block text-dim">
              {m.retries_24h.recovered} recovered · {m.retries_24h.retrying} retrying · {m.retries_24h.exhausted} exhausted
            </span>
            {m.retries_24h.note}
          </>
        }
      />
    </StatStrip>
  );
}

/* ------------------------------------------------------------- the charts */

function Charts({ m }: { m: HealthMetrics }) {
  const laneKeys = m.per_week_lane[0] ? Object.keys(m.per_week_lane[0].counts) : [];
  const classKeys = m.per_week_class[0] ? Object.keys(m.per_week_class[0].counts) : [];
  return (
    <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
      <MetricCard title="Incidents over time" right="created_at" note={m.week_note}>
        <OutcomeColumns weeks={m.per_week_lane} order={laneKeys} colour={LANE_COLOUR} />
      </MetricCard>
      <MetricCard
        title="Incidents by class, over time"
        right="error_class"
        note="The same eight weeks split by what kind of thing broke, so a shift in the kind of failure is visible rather than only the amount. Retryable classes are drawn in the accent; the ones a retry cannot fix are not."
      >
        <OutcomeColumns weeks={m.per_week_class} order={classKeys} colour={CLASS_COLOUR} />
      </MetricCard>
    </div>
  );
}

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
