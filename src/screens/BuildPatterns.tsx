import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { getBuildPatterns, getPatternDetail, getRecordMetrics, resync, searchPatterns, setRecordStatus, type BuildPattern, type BuildPatternDetail, type PatternMetrics, type PatternStatus, type WritablePatternStatus } from '../data';
import {
  CountCell,
  CountUp,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
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
  usePaged,
  useToast,
} from '../components/ui';

type StatusFilter = 'all' | PatternStatus;

/** The status pill, in one place, so the list and the detail view never disagree. */
export function StatusPill({ status }: { status: PatternStatus }) {
  if (status === 'canonical') return <Pill tone="accent">canonical</Pill>;
  if (status === 'draft') return <Pill>draft</Pill>;
  return <Pill>no status</Pill>;
}

/* ---------------------------------------------------------------- metrics */

function PatternMetricsPanel({ metrics, loading, error }: { metrics: PatternMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Patterns', 'Canonical', 'Draft', 'No status'].map((l) => (
          <StatCell key={l}>
            <div className="kicker">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxSys = Math.max(1, ...m.by_system.map((sy) => sy.draft + sy.canonical + sy.unset));
  const maxReuse = Math.max(1, ...m.reusability_mix.map((r) => r.n));
  const triaged = m.draft + m.canonical;
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {/*
        Four counts that visibly add up. The three states are counted
        separately and the reconciliation line under them prints the sum
        against the row total, so a reader can check the arithmetic on the
        page rather than wonder why draft and canonical did not meet the total.
      */}
      <StatStrip cols={4}>
        <CountCell label="Patterns" value={m.scope.rows} hint="rows in the table" />
        <CountCell label="Canonical" value={m.canonical} tone="accent" hint="pattern_status = canonical" />
        <CountCell label="Draft" value={m.draft} hint="pattern_status = draft" />
        <CountCell label="No status" value={m.unset} tone="dim" hint="pattern_status is empty" />
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="card flex h-full flex-col justify-between px-5 py-4">
          <div className="flex items-center gap-5">
            <Ring value={m.canonical} total={m.scope.rows} size={88} tone="accent" label="canonical" />
            <div className="min-w-0">
              <div className="kicker">Canonical share</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display tabular text-[32px] leading-none text-ink">{m.promotion_rate.value === null ? '—' : <CountUp value={m.promotion_rate.value} />}</span>
                {m.promotion_rate.value !== null && <span className="text-[14px] text-faint">%</span>}
              </div>
              <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.promotion_rate.note}</div>
            </div>
          </div>
          {/*
            Triage rate: how much of the table has been given a status at all.
            It is the measure the empty pattern_status rows make necessary, and
            it is not stated anywhere else on the page.
          */}
          <div className="mt-4 border-t border-line pt-3">
            <HBar
              label="Given a status"
              value={triaged}
              max={Math.max(1, m.scope.rows)}
              tone={triaged === m.scope.rows ? 'accent' : 'ink'}
              valueNode={<CountUp value={triaged} />}
              right={<span className="text-faint">of {m.scope.rows}</span>}
            />
            <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
              {m.unset === 0 ? 'Every row carries a pattern_status.' : `${m.unset} ${m.unset === 1 ? 'row has' : 'rows have'} never been triaged, so they are neither draft nor canonical.`}
            </div>
          </div>
        </div>

        {/* What each state means, and why the figures move. */}
        <MetricCard title="What draft and canonical mean" note={`${m.reconciliation.note} ${m.duplicates.note}`}>
          <div className="space-y-2">
            {m.status_legend.map((l) => (
              <div key={l.status} className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-3 text-[12.5px]">
                <span className="pt-0.5">
                  <StatusPill status={l.status} />
                </span>
                <span className="leading-snug text-dim">{l.meaning}</span>
              </div>
            ))}
          </div>
        </MetricCard>
      </div>

      <div className="card mx-6 mb-4 px-5 py-4 md:mx-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <div className="text-[13px] font-medium text-ink">By system, from pattern ids</div>
          <div className="text-[11px] text-faint">bar = all rows · canonical / draft / no status</div>
        </div>
        <div className="grid gap-x-8 gap-y-1.5 md:grid-cols-3 xl:grid-cols-4">
          {m.by_system.map((sy) => (
            <HBar
              key={sy.system}
              label={sy.system.toLowerCase()}
              value={sy.draft + sy.canonical + sy.unset}
              max={maxSys}
              tone={sy.canonical ? 'accent' : 'ink'}
              valueNode={
                <span>
                  <span className={sy.canonical ? 'text-accent-ink' : 'text-faint'}>{sy.canonical}</span> <span className="text-faint">/</span> {sy.draft} <span className="text-faint">/ {sy.unset}</span>
                </span>
              }
            />
          ))}
        </div>
        <div className="mt-2 text-[11.5px] leading-snug text-faint">
          The system is the second segment of each pattern_id (BP-SLACK-001-… → slack); “(no system in id)” is the count whose id does not follow that shape.
        </div>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Created per week">
          <SeriesBlock title="" series={m.created_per_week} tone="accent" total bare />
        </MetricCard>
        <MetricCard title="Reusability" note={m.reusability_note}>
          {m.reusability_mix.length === 0 ? (
            <EmptyPanel>No pattern records a reusability.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.reusability_mix.map((r) => (
                <HBar key={r.reusability} label={r.reusability.startsWith('(') ? r.reusability : r.reusability.toLowerCase()} value={r.n} max={maxReuse} valueNode={<CountUp value={r.n} />} />
              ))}
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- detail view */

const DETAIL: { key: keyof BuildPatternDetail; label: string }[] = [
  { key: 'problem', label: 'Problem' },
  { key: 'solution', label: 'Solution' },
  { key: 'context', label: 'Context' },
  { key: 'reusability', label: 'Reusability' },
  { key: 'learnings_gotchas', label: 'Learnings and gotchas' },
  { key: 'anti_pattern', label: 'Anti-pattern' },
  { key: 'readiness_gates', label: 'Readiness gates' },
  { key: 'implementation_checklist', label: 'Implementation checklist' },
  { key: 'integration_points', label: 'Integration points' },
  { key: 'test_coverage', label: 'Test coverage' },
  { key: 'routing_logic', label: 'Routing logic' },
  { key: 'next_use_case', label: 'Next use case' },
  { key: 'commercial_impact', label: 'Commercial impact' },
  { key: 'research_production_impact', label: 'Research and production impact' },
  { key: 'naming_note', label: 'Naming note' },
  { key: 'roadmap_context', label: 'Roadmap context' },
];

function PatternView({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<BuildPatternDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getPatternDetail(id)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : 'Could not load the pattern.'));
    return () => {
      live = false;
    };
  }, [id]);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Build pattern">
        {err ? (
          <div className="text-[13px] text-failing">{err}</div>
        ) : !detail ? (
          <div className="text-[13px] text-faint">Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="kicker tabular">{detail.pattern_id ?? detail.id}</div>
                <h2 className="mt-1 text-[18px] leading-tight">{detail.title}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                  <StatusPill status={detail.status} />
                  {detail.system && <span>{detail.system}</span>}
                  {detail.bha_system && <span>{detail.bha_system}</span>}
                  {detail.created_at && <span className="tabular">{detail.created_at.slice(0, 10)}</span>}
                </div>
                {detail.keywords.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {detail.keywords.map((k) => (
                      <span key={k} className="tag">
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <a href={detail.airtable.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                  Open in Airtable
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
            <div className="mt-4 space-y-4">
              {DETAIL.map((f) =>
                detail[f.key] ? (
                  <div key={f.key}>
                    <div className="mb-1 text-[11px] text-faint">{f.label}</div>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{String(detail[f.key])}</p>
                  </div>
                ) : null,
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ page */

export default function BuildPatterns() {
  const [reload, setReload] = useState(0);
  const { status, data: loaded, error } = useData(getBuildPatterns, [reload]);
  const [patterns, setPatterns] = useState<BuildPattern[]>([]);
  const [system, setSystem] = useState('all');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('patterns', query), [tick, reload]);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (loaded) setPatterns(loaded.patterns);
  }, [loaded]);

  // Search runs on the server across every text field, including the long ones the list does not carry.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits(null);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      searchPatterns(term)
        .then((r) => {
          if (seq === searchSeq.current) setHits(new Set(r.patterns.map((p) => p.id)));
        })
        .catch(() => {
          if (seq === searchSeq.current) setHits(new Set());
        });
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const keywordCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of patterns) for (const k of p.keywords) c.set(k, (c.get(k) ?? 0) + 1);
    return [...c.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [patterns]);

  const scoped = useMemo(() => patterns.filter((p) => system === 'all' || (p.system ?? '(no system in id)') === system), [patterns, system]);
  const counts = {
    all: scoped.length,
    canonical: scoped.filter((p) => p.status === 'canonical').length,
    draft: scoped.filter((p) => p.status === 'draft').length,
    unset: scoped.filter((p) => p.status === 'unset').length,
  };
  const rows = useMemo(() => scoped.filter((p) => filter === 'all' || p.status === filter).filter((p) => (hits ? hits.has(p.id) : true)), [scoped, filter, hits]);
  const paged = usePaged(rows, `${system}|${filter}|${q.trim()}`);

  async function change(p: BuildPattern, next: WritablePatternStatus) {
    setBusyId(p.id);
    try {
      const updated = await setRecordStatus('patterns', p.id, next);
      setPatterns((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: next === 'canonical' ? 'Promoted to canonical in Airtable.' : 'Returned to draft in Airtable.', tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  async function pull() {
    setSyncing(true);
    try {
      const r = await resync('patterns');
      const t = r.results[0]?.tables[0];
      setToast(t?.error ? { text: `Resync failed: ${t.error}`, tone: 'failing' } : { text: `Resync read ${t?.n ?? 0} patterns.`, tone: 'ok' });
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
      <PageHeader title="Build patterns" subtitle="Classified by the system in each pattern id, searchable across every field" />

      {/* overflow-x-hidden: nothing on this page may scroll the body sideways. */}
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <PatternMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          {/*
            The system filter used to force the whole page to scroll sideways:
            twenty-odd systems in one nowrap row. `.seg` wraps now, so it
            becomes two or three lines inside its own width and the page body
            never moves.
          */}
          <Segmented
            ariaLabel="Filter by system"
            value={system}
            onChange={setSystem}
            options={[{ value: 'all', label: 'All systems', count: patterns.length }, ...loaded.systems.map((sy) => ({ value: sy.system, label: sy.system.toLowerCase(), count: sy.n }))]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<StatusFilter>
              ariaLabel="Filter by status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: counts.all },
                { value: 'canonical', label: 'Canonical', count: counts.canonical },
                { value: 'draft', label: 'Draft', count: counts.draft },
                { value: 'unset', label: 'No status', count: counts.unset },
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search problem, solution, context, name" />
              {q.trim() && hits === null && <span className="tabular whitespace-nowrap text-[11.5px] text-faint">Searching…</span>}
            </div>
          </div>
          {keywordCounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] text-faint">Keywords</span>
              {keywordCounts.map(([k, n]) => (
                <button key={k} type="button" onClick={() => setQ(k)} className={`tag hover:text-accent-ink ${q.trim() === k ? 'tag-accent' : ''}`} title={`${n} patterns`}>
                  {k} <span className="text-faint">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            {loaded.sync.source === 'none'
              ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.')
              : q.trim()
                ? 'No pattern matches that search in the selected system and status.'
                : 'No build patterns match the selected system and status.'}
          </EmptyState>
        ) : (
          <>
            {/*
              One row per pattern: id, name, system, reusability, and the first
              lines of the problem. The rest of the record — solution, context,
              gotchas, checklists — opens on click rather than being poured into
              the list, which is what made the page unreadable.
            */}
            <RecordList>
              {paged.rows.map((p) => {
                const busy = busyId === p.id;
                return (
                  <RecordRow
                    key={p.id}
                    busy={busy}
                    id={p.pattern_id ?? <span className="text-degraded">no pattern_id</span>}
                    title={p.title}
                    summary={p.excerpt}
                    summaryEmpty="No problem statement written on this pattern."
                    meta={
                      <>
                        <StatusPill status={p.status} />
                        {p.system && <span>{p.system.toLowerCase()}</span>}
                        {p.reusability && <span className="max-w-[22ch] truncate" title={p.reusability}>{p.reusability.toLowerCase()}</span>}
                        <SourceLink source={p.source} />
                      </>
                    }
                    actions={
                      <RowActions>
                        <RowAction label="View" tone="accent" onClick={() => setOpen(p.id)} />
                        {writable && p.status !== 'canonical' && <RowAction label="Promote to canonical" tone="accent" disabled={busy} onClick={() => change(p, 'canonical')} />}
                        {writable && p.status !== 'draft' && <RowAction label="Mark draft" disabled={busy} onClick={() => change(p, 'draft')} />}
                        <RowAction label="Open in Airtable" onClick={() => window.open(p.airtable.url, '_blank', 'noreferrer')} />
                      </RowActions>
                    }
                    onOpen={() => setOpen(p.id)}
                  />
                );
              })}
            </RecordList>
            <Pagination paged={paged} unit="patterns" />
          </>
        )}
      </div>

      {open && <PatternView id={open} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
