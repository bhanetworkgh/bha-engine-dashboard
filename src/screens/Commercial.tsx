import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getCommercial, getRecordMetrics, resync, setRecordStatus, type CommercialMetrics, type MetricSeries, type Opportunity, type ReadinessState } from '../data';
import { Band, CountCell, EmptyState, LoadFailed, Loading, MetricCell, PageHeader, Pill, RowAction, RowActions, SearchBox, Segmented, SeriesBlock, Sparkline, SourceLink, StatCell, StatStrip, SyncLine, Toast, useToast } from '../components/ui';

const READINESS: ReadinessState[] = ['INCUBATE', 'Research-First', 'Media-Ready'];
type Filter = 'all' | ReadinessState;

function ReadinessPill({ state }: { state: ReadinessState | null }) {
  if (state === 'Media-Ready') return <Pill tone="accent">media-ready</Pill>;
  if (state === 'Research-First') return <Pill>research-first</Pill>;
  if (state === 'INCUBATE') return <Pill tone="degraded">incubate</Pill>;
  return <Pill>readiness unset</Pill>;
}

function matches(o: Opportunity, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [o.card_id, o.title, o.lane_id, o.pain_point, o.offer, o.target, o.who_pays, o.next_action, ...o.missing_research_questions].some((v) => v && v.toLowerCase().includes(n));
}

/* ---------------------------------------------------------------- metrics */

function CommercialMetricsPanel({ metrics, loading, error }: { metrics: CommercialMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={3} className="opacity-60">
        {['Cards', 'Lanes', 'Unresolved research questions'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const tones: ('degraded' | 'ink' | 'accent' | 'dim')[] = ['degraded', 'ink', 'accent', 'dim'];
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={3}>
        <CountCell label="Cards" value={m.cards} />
        <CountCell label="Lanes" value={m.by_lane.length} tone="dim" hint={`${m.by_lane.filter((l) => l.blocked).length} with a card blocked on research`} />
        <MetricCell label="Unresolved research questions" metric={m.unresolved_questions} />
      </StatStrip>
      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-2">
        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Readiness state</div>
          <Band parts={m.by_readiness.map((r, i) => ({ value: r.n, tone: tones[i % tones.length], label: r.readiness_state }))} height={8} />
          <div className="mt-2 space-y-0.5 text-[12px]">
            {m.by_readiness.map((r) => (
              <div key={r.readiness_state} className="flex justify-between gap-3">
                <span className="text-dim">{r.readiness_state}</span>
                <span className="tabular text-ink">{r.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Unresolved research questions over time" series={m.unresolved_trend} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ card */

function CardTrend({ trend, now }: { trend: MetricSeries | undefined; now: number | null }) {
  if (!trend) return null;
  return (
    <div className="flex items-center gap-2" title={trend.note ?? ''}>
      {trend.points ? <Sparkline values={trend.points.map((p) => p.value)} width={72} height={22} tone="ink" /> : <span className="text-[10.5px] text-faint">no trend yet</span>}
      {now !== null && <span className="tabular text-[11px] text-dim">{now}</span>}
    </div>
  );
}

function OpportunityCard({ o, trend, busy, writable, onReadiness }: { o: Opportunity; trend: MetricSeries | undefined; busy: boolean; writable: boolean; onReadiness: (o: Opportunity, r: ReadinessState) => void }) {
  const [showQ, setShowQ] = useState(false);
  const listed = o.missing_research_questions.length;
  const disagree = o.missing_research_count !== null && o.missing_research_count !== listed;
  return (
    <div className={`card flex flex-col gap-2 px-4 py-3.5 ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="kicker tabular truncate">{o.card_id ?? o.id}</div>
          <div className="mt-0.5 text-[13.5px] leading-snug font-medium text-ink">{o.title}</div>
        </div>
        <ReadinessPill state={o.readiness_state} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
        {o.confidence && <span>confidence {o.confidence.toLowerCase()}</span>}
        {o.pilot_state && <span>{o.pilot_state.replace(/_/g, ' ')}</span>}
        {o.routing_state && <span>{o.routing_state.replace(/_/g, ' ')}</span>}
        {o.created_at && <span className="tabular">{o.created_at.slice(0, 10)}</span>}
      </div>
      {o.lane_state_blocked_reason && <div className="text-[12px] leading-snug text-degraded">{o.lane_state_blocked_reason}</div>}
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <button type="button" onClick={() => setShowQ((v) => !v)} className="text-left text-dim hover:text-accent-ink" disabled={!listed}>
          {o.missing_research_count === null ? (
            <span className="text-faint">missing_research_count not set</span>
          ) : (
            <>
              <span className="tabular text-ink">{o.missing_research_count}</span> unresolved research {o.missing_research_count === 1 ? 'question' : 'questions'}
            </>
          )}
          {listed > 0 && (
            <span className="text-faint">
              {' '}
              · {listed} listed{disagree ? ' (count and list differ)' : ''} {showQ ? '▾' : '▸'}
            </span>
          )}
        </button>
        <CardTrend trend={trend} now={o.missing_research_count} />
      </div>
      {showQ && listed > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-snug text-dim">
          {o.missing_research_questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      )}
      {o.next_action && (
        <div className="text-[12px] leading-snug text-dim">
          <span className="text-faint">Next: </span>
          {o.next_action}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-2">
        <SourceLink source={o.source} />
        <RowActions>
          {writable &&
            READINESS.filter((r) => r !== o.readiness_state).map((r) => (
              <RowAction key={r} label={`Set ${r.toLowerCase()}`} tone={r === 'Media-Ready' ? 'accent' : 'default'} disabled={busy} onClick={() => onReadiness(o, r)} />
            ))}
          <RowAction label="Open in Airtable" onClick={() => window.open(o.airtable.url, '_blank', 'noreferrer')} />
        </RowActions>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function Commercial() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getCommercial, [reload]);
  const [cards, setCards] = useState<Opportunity[]>([]);
  const [lane, setLane] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('commercial', query), [tick, reload]);

  useEffect(() => {
    if (loaded) setCards(loaded.opportunities);
  }, [loaded]);

  const scoped = useMemo(() => cards.filter((o) => lane === 'all' || (o.lane_id ?? '(no lane_id)') === lane), [cards, lane]);
  const rows = scoped.filter((o) => filter === 'all' || o.readiness_state === filter).filter((o) => matches(o, q.trim()));
  const byLane = useMemo(() => {
    const groups: { lane_id: string; cards: Opportunity[] }[] = [];
    for (const o of rows) {
      const l = o.lane_id ?? '(no lane_id)';
      let g = groups.find((x) => x.lane_id === l);
      if (!g) groups.push((g = { lane_id: l, cards: [] }));
      g.cards.push(o);
    }
    return groups;
  }, [rows]);

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

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="Commercial" subtitle="Opportunity cards per lane, and what each still needs answered" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <CommercialMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <div className="scroll-thin overflow-x-auto">
            <Segmented
              ariaLabel="Filter by lane"
              value={lane}
              onChange={setLane}
              options={[{ value: 'all', label: 'All lanes', count: cards.length }, ...loaded.lanes.map((l) => ({ value: l.lane_id, label: l.lane_id.replace(/^LANE-/, '').toLowerCase().replace(/_/g, ' '), count: l.n }))]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Filter>
              ariaLabel="Filter by readiness"
              value={filter}
              onChange={setFilter}
              options={[{ value: 'all', label: 'All', count: scoped.length }, ...READINESS.map((r) => ({ value: r, label: r, count: scoped.filter((o) => o.readiness_state === r).length }))]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search cards and research questions" />
              <span className="tabular whitespace-nowrap text-[11.5px] text-faint">{rows.length} shown</span>
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>{loaded.sync.source === 'none' ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.') : 'No commercial cards match the selected lane, readiness and search.'}</EmptyState>
        ) : (
          <div className="space-y-6 px-6 pb-6 md:px-8">
            {byLane.map((g) => {
              const laneInfo = loaded.lanes.find((l) => l.lane_id === g.lane_id);
              return (
                <section key={g.lane_id}>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h2 className="text-[13px] font-medium text-ink">{g.lane_id}</h2>
                    <span className="tabular text-[11.5px] text-faint">
                      {g.cards.length} {g.cards.length === 1 ? 'card' : 'cards'}
                      {laneInfo && (laneInfo.unresolved_questions === null ? ' · unresolved count not set' : ` · ${laneInfo.unresolved_questions} unresolved research ${laneInfo.unresolved_questions === 1 ? 'question' : 'questions'}`)}
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {g.cards.map((o) => (
                      <OpportunityCard key={o.id} o={o} trend={loaded.trends[o.id]} busy={busyId === o.id} writable={writable} onReadiness={change} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <Toast toast={toast} />
    </div>
  );
}
