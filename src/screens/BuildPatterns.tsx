import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { getBuildPatterns, getPatternDetail, getRecordMetrics, resync, searchPatterns, setRecordStatus, type BuildPattern, type BuildPatternDetail, type PatternMetrics, type PatternStatus } from '../data';
import {
  CountCell,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  PageHeader,
  Pill,
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
  TableFrame,
  Th,
  Toast,
  useToast,
} from '../components/ui';

type StatusFilter = 'all' | PatternStatus;

/* ---------------------------------------------------------------- metrics */

function PatternMetricsPanel({ metrics, loading, error }: { metrics: PatternMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={3} className="opacity-60">
        {['Draft', 'Canonical', 'Promotion rate'].map((l) => (
          <StatCell key={l}>
            <div className="kicker">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxSys = Math.max(1, ...m.by_system.map((s) => s.draft + s.canonical));
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
        {/* The promotion rate is the operational signal on this page, so it leads. */}
        <div className="card flex items-center gap-5 px-5 py-4">
          <Ring value={m.canonical} total={m.scope.rows} size={88} tone="accent" label="canonical" />
          <div className="min-w-0">
            <div className="kicker">Draft to canonical</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-display tabular text-[32px] leading-none text-ink">{m.promotion_rate.value === null ? '—' : m.promotion_rate.value}</span>
              {m.promotion_rate.value !== null && <span className="text-[14px] text-faint">%</span>}
            </div>
            <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.promotion_rate.note}</div>
          </div>
        </div>
        <StatStrip cols={3} className="!mx-0 !mb-0">
          <CountCell label="Draft" value={m.draft} tone="degraded" />
          <CountCell label="Canonical" value={m.canonical} tone="accent" />
          <CountCell label="Patterns" value={m.scope.rows} tone="dim" />
        </StatStrip>
      </div>
      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-3">
        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">By system, from pattern ids</div>
          <div className="space-y-1.5">
            {m.by_system.map((s) => (
              <HBar key={s.system} label={s.system} value={s.draft + s.canonical} max={maxSys} right={<span className="text-faint">{s.canonical} canonical</span>} />
            ))}
          </div>
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Created per week" series={m.created_per_week} tone="accent" total />
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Promotion over time" series={m.promotion_over_time} />
        </div>
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
                  {detail.status === 'canonical' ? <Pill tone="accent">canonical</Pill> : <Pill tone="degraded">draft</Pill>}
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
  const counts = { all: scoped.length, draft: scoped.filter((p) => p.status === 'draft').length, canonical: scoped.filter((p) => p.status === 'canonical').length };
  const rows = scoped.filter((p) => filter === 'all' || p.status === filter).filter((p) => (hits ? hits.has(p.id) : true));

  async function change(p: BuildPattern, next: PatternStatus) {
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

      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <SyncLine sync={loaded.sync} onResync={pull} busy={syncing} />
        </div>

        <PatternMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <Segmented ariaLabel="Filter by system" value={system} onChange={setSystem} options={[{ value: 'all', label: 'All systems', count: patterns.length }, ...loaded.systems.map((s) => ({ value: s.system, label: s.system.toLowerCase(), count: s.n }))]} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<StatusFilter>
              ariaLabel="Filter by status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: counts.all },
                { value: 'draft', label: 'Draft', count: counts.draft },
                { value: 'canonical', label: 'Canonical', count: counts.canonical },
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search problem, solution, context, name" />
              <span className="tabular whitespace-nowrap text-[11.5px] text-faint">{q.trim() && hits === null ? 'Searching…' : `${rows.length} shown`}</span>
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
          <EmptyState>{loaded.sync.source === 'none' ? (loaded.sync.error ?? 'Nothing has been read from Airtable yet.') : q.trim() ? 'No pattern matches that search in the selected system and status.' : 'No build patterns match the selected system and status.'}</EmptyState>
        ) : (
          <TableFrame grow={false}>
            <thead>
              <tr>
                <Th>pattern</Th>
                <Th>name</Th>
                <Th>status</Th>
                <Th>system</Th>
                <Th>bha system</Th>
                <Th>reusability</Th>
                <Th>created</Th>
                <Th>problem</Th>
                <Th>source</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const busy = busyId === p.id;
                return (
                  <tr key={p.id} className={`cursor-pointer ${busy ? 'opacity-60' : ''}`} onClick={() => setOpen(p.id)}>
                    <td className="td tabular text-faint td-clip" style={{ maxWidth: '26ch' }} title={p.pattern_id ?? p.id}>
                      {p.pattern_id ?? <span className="text-degraded">no pattern_id</span>}
                    </td>
                    <td className="td card-title td-clip" style={{ maxWidth: '40ch' }} title={p.title}>
                      {p.title}
                    </td>
                    <td className="td card-meta">{p.status === 'canonical' ? <Pill tone="accent">canonical</Pill> : <Pill tone="degraded">draft</Pill>}</td>
                    <td className="td card-meta text-faint">{p.system?.toLowerCase() ?? '—'}</td>
                    <td className="td text-faint td-clip" style={{ maxWidth: '22ch' }}>
                      {p.bha_system ?? '—'}
                    </td>
                    <td className="td text-faint">{p.reusability ?? '—'}</td>
                    <td className="td tabular text-faint">{p.created_at?.slice(0, 10) ?? '—'}</td>
                    <td className="td text-faint td-clip" style={{ maxWidth: '48ch' }} title={p.excerpt ?? ''}>
                      {p.excerpt ?? '—'}
                    </td>
                    <td className="td">
                      <SourceLink source={p.source} />
                    </td>
                    <td className="td card-actions td-actions">
                      <RowActions>
                        <RowAction label="View" tone="accent" onClick={() => setOpen(p.id)} />
                        {writable && p.status === 'draft' && <RowAction label="Promote to canonical" tone="accent" disabled={busy} onClick={() => change(p, 'canonical')} />}
                        {writable && p.status === 'canonical' && <RowAction label="Back to draft" disabled={busy} onClick={() => change(p, 'draft')} />}
                        <RowAction label="Open in Airtable" onClick={() => window.open(p.airtable.url, '_blank', 'noreferrer')} />
                      </RowActions>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        )}
      </div>

      {open && <PatternView id={open} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
