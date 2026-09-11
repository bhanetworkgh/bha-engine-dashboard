import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getCommercial, getRecordMetrics, resync, setRecordStatus, type CommercialMetrics, type MetricSeries, type Opportunity, type ReadinessState } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CountCell,
  CountUp,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MetricCell,
  PageHeader,
  Pagination,
  Pill,
  RecordId,
  RecordTable,
  Ring,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  Sparkline,
  StatCell,
  StatStrip,
  SyncLine,
  Toast,
  TwoLine,
  usePaged,
  useToast,
} from '../components/ui';

/**
 * Commercial cards.
 *
 * This is the Build patterns page with different content, and deliberately so:
 * the same filter bars, the same truncated list rows with the full record one
 * click away, the same chart treatment and the same spacing. They were square
 * expanding tiles, which was a layout chosen because the records are called
 * "cards" — not because a grid of tiles is a better way to read twenty-one
 * records than a list is.
 */

const READINESS: ReadinessState[] = ['INCUBATE', 'Research-First', 'Media-Ready'];
type Filter = 'all' | ReadinessState | 'unset';

function ReadinessPill({ state }: { state: ReadinessState | null }) {
  if (state === 'Media-Ready') return <Pill tone="accent">media-ready</Pill>;
  if (state === 'Research-First') return <Pill>research-first</Pill>;
  if (state === 'INCUBATE') return <Pill>incubate</Pill>;
  return <Pill>no readiness</Pill>;
}

function matches(o: Opportunity, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [o.card_id, o.title, o.lane_id, o.pain_point, o.offer, o.target, o.who_pays, o.next_action, o.bha_system, ...o.missing_research_questions].some((v) => v && v.toLowerCase().includes(n));
}

function laneLabel(lane: string): string {
  return lane.replace(/^LANE-/, '').toLowerCase().replace(/_/g, ' ');
}

/* ---------------------------------------------------------------- metrics */

function CommercialMetricsPanel({ metrics, loading, error }: { metrics: CommercialMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Cards', 'Media-ready', 'Lanes', 'Unresolved research questions'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const mediaReady = m.by_readiness.find((r) => r.readiness_state === 'Media-Ready')?.n ?? 0;
  const maxReadiness = Math.max(1, ...m.by_readiness.map((r) => r.n));
  const maxConfidence = Math.max(1, ...m.confidence_mix.map((c) => c.n));
  const maxLane = Math.max(1, ...m.by_lane.map((l) => l.n));
  const blocked = m.by_lane.reduce((n, l) => n + l.blocked, 0);

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={4}>
        <CountCell label="Cards" value={m.cards} hint="rows in the table" />
        <CountCell label="Media-ready" value={mediaReady} tone="accent" hint="readiness_state = Media-Ready" />
        <CountCell label="Lanes" value={m.by_lane.length} tone="dim" hint={blocked ? `${blocked} ${blocked === 1 ? 'card is' : 'cards are'} blocked on research` : 'no card is blocked on research'} />
        <MetricCell label="Unresolved research questions" metric={m.unresolved_questions} />
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="card flex h-full flex-col justify-between px-5 py-4">
          <div className="flex items-center gap-5">
            <Ring value={mediaReady} total={m.cards} size={88} tone="accent" label="media-ready" />
            <div className="min-w-0">
              <div className="kicker">Media-ready share</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display tabular text-[32px] leading-none text-ink">{m.cards ? <CountUp value={Math.round((mediaReady / m.cards) * 100)} /> : '—'}</span>
                {m.cards > 0 && <span className="text-[14px] text-faint">%</span>}
              </div>
              <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
                {mediaReady} of {m.cards} cards are marked media-ready today. readiness_state records the state, not the date it was reached, so this is the share now, not a rate over time.
              </div>
            </div>
          </div>
          {/* How much of the table is answerable at all: the cards blocked on research. */}
          <div className="mt-4 border-t border-line pt-3">
            <HBar
              label="Not blocked on research"
              value={m.cards - blocked}
              max={Math.max(1, m.cards)}
              tone={blocked ? 'ink' : 'accent'}
              valueNode={<CountUp value={m.cards - blocked} />}
              right={<span className="text-faint">of {m.cards}</span>}
            />
            <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
              {blocked === 0 ? 'No card carries a lane_state_blocked_reason.' : `${blocked} ${blocked === 1 ? 'card names' : 'cards name'} a lane_state_blocked_reason and cannot move until the research lands.`}
            </div>
          </div>
        </div>

        <MetricCard title="Readiness state" note="readiness_state as the Commercial Opportunities table defines it. A card with the field empty is counted on its own rather than folded into incubate.">
          {m.by_readiness.length === 0 ? (
            <EmptyPanel>No card records a readiness state.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.by_readiness.map((r) => (
                <HBar
                  key={r.readiness_state}
                  label={r.readiness_state === '(unset)' ? 'no readiness set' : r.readiness_state}
                  value={r.n}
                  max={maxReadiness}
                  tone={r.readiness_state === 'Media-Ready' ? 'accent' : 'ink'}
                  valueNode={<CountUp value={r.n} />}
                  right={<span className="text-faint">{m.cards ? Math.round((r.n / m.cards) * 100) : 0}%</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="card mx-6 mb-4 px-5 py-4 md:mx-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <div className="text-[13px] font-medium text-ink">By lane</div>
          <div className="text-[11px] text-faint">bar = all cards · number = unresolved questions</div>
        </div>
        <div className="grid gap-x-8 gap-y-1.5 md:grid-cols-3 xl:grid-cols-4">
          {m.by_lane.map((l) => (
            <HBar
              key={l.lane_id}
              label={laneLabel(l.lane_id)}
              value={l.n}
              max={maxLane}
              tone={l.blocked ? 'degraded' : 'ink'}
              valueNode={
                <span>
                  {l.n} <span className="text-faint">· {l.unresolved === null ? 'count not set' : `${l.unresolved} open`}</span>
                </span>
              }
            />
          ))}
        </div>
        <div className="mt-2 text-[11.5px] leading-snug text-faint">
          Cards grouped by lane_id. A lane is amber when one of its cards carries a lane_state_blocked_reason; “count not set” is a lane where no card records a missing_research_count.
        </div>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Unresolved research questions over time">
          <SeriesBlock title="" series={m.unresolved_trend} tone="accent" bare />
        </MetricCard>
        <MetricCard title="Confidence" note={`From the confidence field as set on each card. ${m.demand_evidence_note}`}>
          {m.confidence_mix.length === 0 ? (
            <EmptyPanel>No card records a confidence.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.confidence_mix.map((c) => (
                <HBar key={c.confidence} label={c.confidence === '(unset)' ? 'no confidence set' : c.confidence.toLowerCase()} value={c.n} max={maxConfidence} valueNode={<CountUp value={c.n} />} />
              ))}
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- card view */

function CardTrend({ trend, now }: { trend: MetricSeries | undefined; now: number | null }) {
  if (!trend) return null;
  return (
    <span className="inline-flex items-center gap-1.5" title={trend.note ?? ''}>
      {trend.points ? <Sparkline values={trend.points.map((p) => p.value)} width={56} height={16} tone="ink" /> : <span className="text-[10.5px] text-faint">no trend yet</span>}
      {now !== null && <span className="tabular text-[11px] text-dim">{now}</span>}
    </span>
  );
}

/** The whole card, on click — the same shape as a build pattern's detail view. */
function CardView({ o, trend, busy, writable, onReadiness, onClose }: { o: Opportunity; trend: MetricSeries | undefined; busy: boolean; writable: boolean; onReadiness: (o: Opportunity, r: ReadinessState) => void; onClose: () => void }) {
  const listed = o.missing_research_questions.length;
  const disagree = o.missing_research_count !== null && o.missing_research_count !== listed;
  const detail: { label: string; value: string | null }[] = [
    { label: 'Pain point', value: o.pain_point },
    { label: 'Offer', value: o.offer },
    { label: 'Target', value: o.target },
    { label: 'Who pays', value: o.who_pays },
    { label: 'BHA system', value: o.bha_system },
    { label: 'Next action', value: o.next_action },
  ];
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Commercial card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{o.card_id ?? o.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{o.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <ReadinessPill state={o.readiness_state} />
              {o.lane_id && <span>{laneLabel(o.lane_id)}</span>}
              {o.confidence && <span>confidence {o.confidence.toLowerCase()}</span>}
              {o.created_at && <span className="tabular">{o.created_at.slice(0, 10)}</span>}
              <CardTrend trend={trend} now={o.missing_research_count} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={o.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {o.lane_state_blocked_reason && <p className="mt-3 text-[12.5px] leading-snug text-degraded">{o.lane_state_blocked_reason}</p>}

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {listed > 0 ? (
            <div>
              <div className="mb-1 text-[11px] text-faint">
                Unresolved research questions
                {o.missing_research_count !== null && (
                  <span className="ml-2">
                    missing_research_count says {o.missing_research_count}; {listed} {listed === 1 ? 'is' : 'are'} listed{disagree ? ' — the two disagree, and both are shown as written' : ''}
                  </span>
                )}
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-snug text-dim">
                {o.missing_research_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-[12.5px] text-faint">
              {o.missing_research_count === null ? 'This card records no missing_research_count and lists no questions.' : `missing_research_count says ${o.missing_research_count}, but the card lists no questions.`}
            </p>
          )}

          {detail
            .filter((d) => d.value)
            .map((d) => (
              <div key={d.label}>
                <div className="mb-0.5 text-[11px] text-faint">{d.label}</div>
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{d.value}</p>
              </div>
            ))}

          <div className="grid gap-x-6 gap-y-1 text-[11.5px] md:grid-cols-2">
            {(
              [
                ['pilot_state', o.pilot_state],
                ['routing_state', o.routing_state],
                ['lane_state', o.lane_state],
                ['engine_movement_state', o.engine_movement_state],
                ['infra_readiness', o.infra_readiness],
                ['data_readiness', o.data_readiness],
                ['media_readiness', o.media_readiness],
                ['media_gate', o.media_gate],
                ['demand_evidence', o.demand_evidence],
              ] as [string, string | null][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-faint">{k}</span>
                <span className="truncate text-dim" title={v ?? ''}>
                  {v ?? '—'}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <SourceLink source={o.source} />
            <div className="flex flex-wrap gap-2">
              {writable &&
                READINESS.filter((r) => r !== o.readiness_state).map((r) => (
                  <button key={r} type="button" className={`btn btn-sm ${r === 'Media-Ready' ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => onReadiness(o, r)}>
                    {busy ? 'Writing…' : `Set ${r.toLowerCase()}`}
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

/**
 * The card list, as columns — the same shape as Build patterns, because it is
 * the same page with different content. Open questions is the table's own
 * missing_research_count, red while any are unresolved, and says so plainly
 * when the card carries no count at all.
 */
function commercialColumns(open: (o: Opportunity) => void, change: (o: Opportunity, next: ReadinessState) => void, writable: boolean, busyId: string | null): RecordColumn<Opportunity>[] {
  const unresolved = (o: Opportunity) => o.missing_research_count ?? o.missing_research_questions.length;
  return [
    {
      key: 'card_id',
      header: 'card id',
      width: '28ch',
      clip: true,
      title: (o) => o.card_id ?? o.id,
      cell: (o) => <RecordId missing="no card id">{o.card_id}</RecordId>,
    },
    {
      key: 'title',
      header: 'card',
      card: 'title',
      width: '62ch',
      title: (o) => o.title,
      cell: (o) => <TwoLine title={o.title} description={o.lane_state_blocked_reason ?? o.pain_point ?? o.offer} empty="No pain point or offer written on this card." />,
    },
    { key: 'readiness', header: 'readiness', card: 'meta', className: 'card-meta', cell: (o) => <ReadinessPill state={o.readiness_state} /> },
    {
      key: 'lane',
      header: 'lane',
      card: 'meta',
      width: '22ch',
      clip: true,
      className: 'card-meta text-dim',
      title: (o) => o.lane_id ?? undefined,
      cell: (o) => (o.lane_id ? laneLabel(o.lane_id) : <span className="text-faint">no lane</span>),
    },
    {
      key: 'questions',
      header: 'open questions',
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (o) => (unresolved(o) > 0 ? 'text-degraded' : 'text-dim'),
      title: (o) => (o.missing_research_questions.length ? o.missing_research_questions.join('\n') : undefined),
      cell: (o) => (o.missing_research_count === null && o.missing_research_questions.length === 0 ? <span className="text-faint">no count</span> : unresolved(o)),
    },
    { key: 'source', header: 'source', cell: (o) => <SourceLink source={o.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (o) => {
        const busy = busyId === o.id;
        return (
          <RowActions>
            <RowAction label="View" tone="accent" onClick={() => open(o)} />
            {writable && o.readiness_state !== 'Media-Ready' && <RowAction label="Set media-ready" tone="accent" disabled={busy} onClick={() => change(o, 'Media-Ready')} />}
            <RowAction label="Open in Airtable" onClick={() => window.open(o.airtable.url, '_blank', 'noreferrer')} />
          </RowActions>
        );
      },
    },
  ];
}

export default function Commercial() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getCommercial, [reload]);
  const [cards, setCards] = useState<Opportunity[]>([]);
  const [lane, setLane] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('commercial', query), [tick, reload]);

  useEffect(() => {
    if (loaded) setCards(loaded.opportunities);
  }, [loaded]);

  const scoped = useMemo(() => cards.filter((o) => lane === 'all' || (o.lane_id ?? '(no lane_id)') === lane), [cards, lane]);
  const counts = {
    all: scoped.length,
    ...Object.fromEntries(READINESS.map((r) => [r, scoped.filter((o) => o.readiness_state === r).length])),
    unset: scoped.filter((o) => !o.readiness_state).length,
  } as Record<string, number>;
  const rows = useMemo(
    () => scoped.filter((o) => (filter === 'all' ? true : filter === 'unset' ? !o.readiness_state : o.readiness_state === filter)).filter((o) => matches(o, q.trim())),
    [scoped, filter, q],
  );
  const paged = usePaged(rows, `${lane}|${filter}|${q.trim()}`);

  async function change(o: Opportunity, next: ReadinessState) {
    setBusyId(o.id);
    try {
      const updated = await setRecordStatus('commercial', o.id, next);
      setCards((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: `readiness_state set to ${next} in Airtable.`, tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('commercial');
      const t = r.results[0]?.tables[0];
      setToast(t?.error ? { text: `Resync failed: ${t.error}`, tone: 'failing' } : { text: `Resync read ${t?.n ?? 0} cards.`, tone: 'ok' });
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const writable = loaded.sync.write_through;
  const current = open ? cards.find((o) => o.id === open) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Commercial" subtitle="Opportunity cards per lane, and what each still needs answered" />

      {/* overflow-x-hidden: nothing on this page may scroll the body sideways. */}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <CommercialMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          {/* Same filter bar behaviour as Build patterns: it wraps inside its own width. */}
          <Segmented
            ariaLabel="Filter by lane"
            value={lane}
            onChange={setLane}
            options={[{ value: 'all', label: 'All lanes', count: cards.length }, ...loaded.lanes.map((l) => ({ value: l.lane_id, label: laneLabel(l.lane_id), count: l.n }))]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Filter>
              ariaLabel="Filter by readiness"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: counts.all },
                ...READINESS.map((r) => ({ value: r, label: r.toLowerCase(), count: counts[r] })),
                ...(counts.unset ? [{ value: 'unset' as Filter, label: 'No readiness', count: counts.unset }] : []),
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search cards and research questions" />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No commercial card matches that search in the selected lane and readiness.'
                : 'No commercial cards match the selected lane and readiness.'}
          </EmptyState>
        ) : (
          <>
            <RecordTable
              columns={commercialColumns((o) => setOpen(o.id), change, writable, busyId)}
              rows={paged.rows}
              rowKey={(o) => o.id}
              onOpen={(o) => setOpen(o.id)}
              busyKey={busyId}
              lines={2}
              label="Commercial cards"
            />
            <Pagination paged={paged} unit="cards" />
          </>
        )}
      </div>

      {current && <CardView o={current} trend={loaded.trends[current.id]} busy={busyId === current.id} writable={writable} onReadiness={change} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
