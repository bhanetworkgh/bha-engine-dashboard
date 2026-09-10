import { createPortal } from 'react-dom';
import { useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getNsTelemetry, getRecordMetrics, resync, type NsMetrics, type NsOutcome, type NsRecord } from '../data';
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
  RecordList,
  RecordRow,
  Ring,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  StatCell,
  StatStrip,
  SyncLine,
  Toast,
  relativeTime,
  usePaged,
  useToast,
} from '../components/ui';

/**
 * North Star telemetry, read from its own ask log (NS Records).
 *
 * The headline is the thin rate: answers that were produced, look real, and
 * cite nothing behind them. It is deliberately computed over the rows that
 * carry an `outcome` and no others — the field is the engine's own
 * classification, and a rate this dashboard derived from the answer text
 * would be indistinguishable on screen from one North Star stands behind.
 * Where nothing is classified the figure is absent and says why, rather than
 * reading 0% and looking like good news.
 */

type Filter = 'all' | NsOutcome | 'unclassified';

function OutcomePill({ outcome }: { outcome: NsOutcome | null }) {
  if (outcome === 'answered') return <Pill tone="ok">answered</Pill>;
  if (outcome === 'thin') return <Pill tone="degraded">thin</Pill>;
  if (outcome === 'failed') return <Pill tone="failing">failed</Pill>;
  return <Pill>unclassified</Pill>;
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

function matches(r: NsRecord, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [r.trace_id, r.lane_id, r.request, r.answer, r.reason, r.session_id, ...r.searches.map((s) => s.tool)].some((v) => v && v.toLowerCase().includes(n));
}

/* ---------------------------------------------------------------- metrics */

function NsMetricsPanel({ metrics, loading, error }: { metrics: NsMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={5} className="opacity-60">
        {['Thin rate', 'Asks', 'Classified', 'Research required', 'Last ask'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxTool = Math.max(1, ...m.tool_usage.map((t) => t.hits));
  const maxLane = Math.max(1, ...m.by_lane.map((l) => l.asks));
  const maxOutcome = Math.max(1, ...m.outcome_mix.map((o) => o.n));
  const stacked = m.outcome_per_week;
  const lastAge = relativeTime(m.last_ask.at);
  const silent = m.last_ask.at ? Date.now() - Date.parse(m.last_ask.at) > 2 * 86_400_000 : true;

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={5}>
        {/*
          The thin rate leads because it is the one number that says whether
          North Star's answers can be trusted. Null renders as "not recorded"
          with the reason, never as zero.
        */}
        <MetricCell label="Thin rate" metric={m.thin_rate} suffix="%" />
        <CountCell label="Asks" value={m.scope.rows} hint="rows in the ask log" />
        <CountCell
          label="Classified"
          value={m.classified}
          tone={m.classified === 0 ? 'degraded' : 'default'}
          hint={m.unclassified ? `${m.unclassified} carry no outcome` : 'every ask carries an outcome'}
        />
        <MetricCell label="Research required" metric={m.research_required_rate} suffix="%" />
        <StatCell>
          <div className="min-w-0">
            <div className="kicker truncate">Last ask</div>
            <div className={`mt-1 text-[15px] leading-tight ${silent ? 'text-degraded' : 'text-ink'}`}>{lastAge ?? 'never'}</div>
            <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.last_ask.note}</div>
          </div>
        </StatCell>
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="card flex h-full flex-col justify-between px-5 py-4">
          <div className="flex items-center gap-5">
            <Ring value={m.classified} total={m.scope.rows} size={88} tone={m.classified ? 'accent' : 'degraded'} label="classified" />
            <div className="min-w-0">
              <div className="kicker">Classified</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display tabular text-[32px] leading-none text-ink">
                  <CountUp value={m.classified} />
                </span>
                <span className="text-[14px] text-faint">of {m.scope.rows}</span>
              </div>
              <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.unclassified_note}</div>
            </div>
          </div>
        </div>

        <MetricCard title="Outcome mix" note="answered = an answer carrying at least one [S#] citation · thin = an answer with nothing cited behind it · failed = no answer text at all. These are North Star’s own definitions, read from its outcome field.">
          {m.outcome_mix.length === 0 ? (
            <EmptyPanel>No ask carries an outcome yet.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.outcome_mix.map((o) => (
                <HBar
                  key={o.outcome}
                  label={o.label}
                  value={o.n}
                  max={maxOutcome}
                  tone={o.outcome === 'thin' ? 'degraded' : o.outcome === 'failed' ? 'failing' : o.outcome === 'answered' ? 'accent' : 'ink'}
                  valueNode={<CountUp value={o.n} />}
                  right={<span className="text-faint">{m.scope.rows ? Math.round((o.n / m.scope.rows) * 100) : 0}%</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Asks per week">
          <SeriesBlock title="" series={m.asks_per_week} tone="accent" total bare />
        </MetricCard>
        <MetricCard
          title="Outcome over time"
          right="answered · thin · failed · unclassified"
          note="The same eight weeks, split by outcome. A column that is all unclassified is a week North Star answered without recording what kind of answer it gave."
        >
          {stacked.every((w) => w.answered + w.thin + w.failed + w.unclassified === 0) ? (
            <EmptyPanel>No ask in the last eight weeks.</EmptyPanel>
          ) : (
            <div>
              <div className="flex w-full items-end gap-[3px]" style={{ height: 72 }} role="img" aria-label="Outcome by week">
                {stacked.map((w) => {
                  const total = w.answered + w.thin + w.failed + w.unclassified;
                  const max = Math.max(1, ...stacked.map((x) => x.answered + x.thin + x.failed + x.unclassified));
                  const h = (total / max) * 100;
                  const seg = (n: number) => (total ? (n / total) * 100 : 0);
                  return (
                    <div key={w.week} className="flex min-w-0 flex-1 flex-col justify-end self-stretch" title={`${w.label}: ${w.answered} answered, ${w.thin} thin, ${w.failed} failed, ${w.unclassified} unclassified`}>
                      <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${Math.max(h, total ? 6 : 2)}%` }}>
                        <div style={{ height: `${seg(w.answered)}%`, background: 'var(--accent)', opacity: 0.85 }} />
                        <div style={{ height: `${seg(w.thin)}%`, background: 'var(--degraded)', opacity: 0.9 }} />
                        <div style={{ height: `${seg(w.failed)}%`, background: 'var(--failing)', opacity: 0.9 }} />
                        <div style={{ height: `${seg(w.unclassified)}%`, background: 'var(--dim)', opacity: 0.28 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10.5px] text-faint">
                <span>{stacked[0]?.label}</span>
                <span>{stacked[stacked.length - 1]?.label}</span>
              </div>
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Tool usage" right="hits · cited" note={m.tool_note}>
          {m.tool_usage.length === 0 ? (
            <EmptyPanel>No ask records a tool call.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.tool_usage.map((t) => (
                <HBar
                  key={t.tool}
                  label={t.tool}
                  value={t.hits}
                  max={maxTool}
                  tone={t.used === 0 && t.hits > 0 ? 'degraded' : 'ink'}
                  valueNode={
                    <span>
                      {t.hits} <span className="text-faint">· {t.used} cited</span>
                    </span>
                  }
                  right={<span className="text-faint">{t.cited_rate === null ? '—' : `${t.cited_rate}%`}</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Citation coverage" note={m.confidence_note}>
          {m.confidence_mix.length === 0 ? (
            <EmptyPanel>No ask records a coverage figure.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.confidence_mix.map((c) => (
                <HBar
                  key={c.bucket}
                  label={c.bucket}
                  value={c.n}
                  max={Math.max(1, ...m.confidence_mix.map((x) => x.n))}
                  tone={c.bucket.startsWith('nothing') ? 'degraded' : 'ink'}
                  valueNode={<CountUp value={c.n} />}
                />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="By lane" note="Asks by the lane_id on each row; “(no lane_id)” is the count with none.">
          {m.by_lane.length === 0 ? (
            <EmptyPanel>No asks.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.by_lane.slice(0, 8).map((l) => (
                <HBar
                  key={l.lane_id}
                  label={l.lane_id}
                  value={l.asks}
                  max={maxLane}
                  valueNode={<CountUp value={l.asks} />}
                  right={l.thin ? <span className="text-degraded">{l.thin} thin</span> : undefined}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- ask view */

function AskView({ r, onClose }: { r: NsRecord; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="North Star ask">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular truncate">{r.trace_id ?? r.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{r.lane_id ?? 'no lane'}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="tabular">{when(r.asked_at)}</span>
              <OutcomePill outcome={r.outcome} />
              {r.research_required !== null && <span>research {r.research_required ? 'required' : 'not required'}</span>}
              {r.confidence !== null && <span>coverage {r.confidence}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={r.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Open in Airtable
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {r.reason && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-[11px] text-faint">Why this outcome</div>
            <p className="text-[13px] leading-relaxed text-ink">{r.reason}</p>
          </div>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-[13px] font-medium text-ink">Tool calls</div>
            <div className="text-[11px] text-faint">hits returned · hits cited</div>
          </div>
          {r.searches.length === 0 ? (
            <p className="text-[12.5px] text-faint">This ask made no tool calls — it was answered from what the agent already had.</p>
          ) : (
            <div className="space-y-1.5">
              {r.searches.map((s, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="truncate text-ink">{s.tool}</span>
                  <span className="tabular shrink-0 text-dim">
                    {s.hits} hit{s.hits === 1 ? '' : 's'} · <span className={s.used === 0 ? 'text-degraded' : ''}>{s.used} cited</span>
                    {s.retrieved_at && <span className="text-faint"> · {s.retrieved_at}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {r.confidence_basis && <p className="mt-2 text-[11.5px] leading-snug text-faint">{r.confidence_basis}</p>}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-1 text-[11px] text-faint">Answer</div>
          {r.answer ? (
            <p className="max-h-[40vh] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{r.answer}</p>
          ) : (
            <p className="text-[12.5px] text-degraded">No answer text was recorded for this ask.</p>
          )}
        </div>

        {r.request && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-[12.5px] text-dim">The prompt as it was sent</summary>
            <p className="mt-2 max-h-[40vh] overflow-y-auto text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{r.request}</p>
          </details>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

export default function NorthStar() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getNsTelemetry, [reload]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { toast, setToast } = useToast();
  const metrics = useData(() => getRecordMetrics('ns', { lane: 'all' }), [reload]);

  const records = loaded?.records ?? [];
  const rows = useMemo(
    () => records.filter((r) => (filter === 'all' ? true : filter === 'unclassified' ? !r.outcome : r.outcome === filter)).filter((r) => matches(r, q.trim())),
    [records, filter, q],
  );
  const paged = usePaged(rows, `${filter}|${q.trim()}`);

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('ns');
      const t = r.results[0]?.tables[0];
      setToast(t?.error ? { text: `Resync failed: ${t.error}`, tone: 'failing' } : { text: `Resync read ${t?.n ?? 0} asks.`, tone: 'ok' });
      setReload((n) => n + 1);
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'The resync did not run.', tone: 'failing' });
    } finally {
      setSyncing(false);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? records.find((r) => r.id === open) : null;
  const counts = {
    all: records.length,
    answered: records.filter((r) => r.outcome === 'answered').length,
    thin: records.filter((r) => r.outcome === 'thin').length,
    failed: records.filter((r) => r.outcome === 'failed').length,
    unclassified: records.filter((r) => !r.outcome).length,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader title="North Star" subtitle="Every question routed through the agent, and what came back" />

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <NsMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Filter>
              ariaLabel="Filter by outcome"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: counts.all },
                { value: 'answered', label: 'Answered', count: counts.answered },
                { value: 'thin', label: 'Thin', count: counts.thin },
                { value: 'failed', label: 'Failed', count: counts.failed },
                ...(counts.unclassified ? [{ value: 'unclassified' as Filter, label: 'Unclassified', count: counts.unclassified }] : []),
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search asks, answers and tools" />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No ask matches that search in the selected outcome.'
                : filter === 'unclassified'
                  ? 'Every ask carries an outcome.'
                  : `No ask is recorded as ${filter}. ${counts.unclassified ? `${counts.unclassified} asks carry no outcome at all and are under Unclassified.` : ''}`}
          </EmptyState>
        ) : (
          <>
            <RecordList>
              {paged.rows.map((r) => (
                <RecordRow
                  key={r.id}
                  id={
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className="truncate">{r.trace_id ?? r.id}</span>
                      <span className="text-faint">{when(r.asked_at)}</span>
                    </span>
                  }
                  title={r.lane_id ?? 'no lane'}
                  summary={r.reason ?? r.answer}
                  summaryEmpty="No answer and no reason recorded for this ask."
                  meta={
                    <>
                      <OutcomePill outcome={r.outcome} />
                      {r.searches.length > 0 && (
                        <span title={r.searches.map((s) => `${s.tool}: ${s.hits} hits, ${s.used} cited`).join('\n')}>
                          {r.searches.length} tool call{r.searches.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {r.confidence !== null && <span className={r.confidence === 0 ? 'text-degraded' : ''}>coverage {r.confidence}</span>}
                      <SourceLink source={r.source} />
                    </>
                  }
                  actions={
                    <RowActions>
                      <RowAction label="View" tone="accent" onClick={() => setOpen(r.id)} />
                      <RowAction label="Open in Airtable" onClick={() => window.open(r.airtable.url, '_blank', 'noreferrer')} />
                    </RowActions>
                  }
                  onOpen={() => setOpen(r.id)}
                />
              ))}
            </RecordList>
            <Pagination paged={paged} unit="asks" />
          </>
        )}
      </div>

      {current && <AskView r={current} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
