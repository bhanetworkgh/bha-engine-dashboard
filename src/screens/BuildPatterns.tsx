import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../app/useData';
import { getBuildPatterns, getPatternDetail, getRecordMetrics, resyncRecords, searchPatterns, type BuildPattern, type BuildPatternDetail, type PatternMetrics } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CountCell,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MonthPicker,
  monthsFrom,
  PageHeader,
  Tabs,
  Pagination,
  RecordId,
  RecordTable,
  ResyncButton,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  StatCell,
  StatStrip,
  RowsLine,
  Toast,
  TwoLine,
  thisMonth,
  usePaged,
  useResync,
  useToast,
} from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';

/**
 * Build patterns.
 *
 * **There is no status on this page** (2026-09-15, Destiny). `pattern_status`
 * was deleted from the Build Patterns base and removed from every workflow that
 * wrote it, so the canonical / draft / no-status split, its tabs, its pill, its
 * filter and the two row actions that wrote it are all gone. A page that kept
 * reading that column would now read nothing on every row and draw twenty-odd
 * patterns into one bucket called "no status".
 *
 * **And no all-systems strip.** BP-BHARAG, BP-CAPACITY, BP-CST and the rest
 * were a grouping by the domain segment of each pattern's own id — a bucket
 * per prefix, carrying nothing the id does not already say on the row.
 *
 * What is left that genuinely varies is `reusability`: Narrow, Moderate, Broad,
 * and the rows that answer in a sentence instead. That is the one grouping on
 * the page, and it is a filter rather than a tab, because it does not partition
 * anything a reader is stepping through.
 */

/** `implementation_checklist` is a pipe-separated string, not an array. */
function checklist(text: string | null): string[] {
  if (!text) return [];
  return text
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The reusability buckets, exactly as the server counts them: one word where a
 * row gives one, and everything longer grouped as prose rather than drawn as a
 * bar per sentence. Kept in step with `reuseKey` in store.ts.
 */
function reuseKey(p: BuildPattern): string {
  const v = p.reusability?.trim();
  if (!v) return '(not set)';
  return v.length > 24 || /\s/.test(v) ? '(written out in prose)' : v;
}

/* ---------------------------------------------------------------- metrics */

function PatternMetricsPanel({ metrics, loading, error }: { metrics: PatternMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Patterns', 'Distinct pattern ids', 'Systems covered', 'Broadly reusable'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxReuse = Math.max(1, ...m.reusability_mix.map((r) => r.n));
  const broad = m.reusability_mix.find((r) => r.reusability.toLowerCase() === 'broad')?.n ?? 0;
  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={4}>
        {/* The hint says which rows, because the strip follows the month picker. */}
        <CountCell label="Patterns" value={m.scope.rows} hint={m.scope.month ? 'created in this month' : 'rows in the table'} hintMinLines={2} />
        <CountCell
          label="Distinct pattern ids"
          value={m.duplicates.distinct_ids}
          tone={m.duplicates.duplicate_rows ? 'degraded' : 'dim'}
          hint={m.duplicates.duplicate_rows ? `${m.duplicates.duplicate_rows} more ${m.duplicates.duplicate_rows === 1 ? 'row' : 'rows'} than patterns` : 'one row per pattern'}
          hintMinLines={2}
        />
        {/*
          A fourth figure (2026-09-16, Destiny): three wide cells read sparse
          beside the four and five the other record pages carry. It is the
          system segment of each pattern's own id, which the rows already print.
        */}
        <CountCell
          label="Systems covered"
          value={m.systems.n}
          tone={m.systems.n ? 'default' : 'dim'}
          hint={m.systems.names.length ? m.systems.names.join(', ') : 'no pattern_id names a system'}
          hintMinLines={2}
        />
        <CountCell label="Broadly reusable" value={broad} tone={broad ? 'accent' : 'dim'} hint="reusability = Broad" hintMinLines={2} />
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Reusability" note={m.reusability_note}>
          {m.reusability_mix.length === 0 ? (
            <EmptyPanel>No pattern records a reusability.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.reusability_mix.map((r) => (
                <HBar
                  key={r.reusability}
                  label={r.reusability.startsWith('(') ? r.reusability : r.reusability.toLowerCase()}
                  value={r.n}
                  max={maxReuse}
                  tone={r.reusability.toLowerCase() === 'broad' ? 'accent' : 'ink'}
                  valueNode={<span>{r.n}</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>
        <MetricCard title="Created per week">
          <SeriesBlock title="" series={m.created_per_week} tone="accent" total bare />
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
  const steps = checklist(detail?.implementation_checklist ?? null);
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
                  {detail.reusability && <span>{detail.reusability.length > 24 ? 'reusability written out below' : `reusability ${detail.reusability.toLowerCase()}`}</span>}
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
              {/* The checklist is one pipe-separated string in Airtable; it reads as a list. */}
              {steps.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] text-faint">Implementation checklist</div>
                  <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-ink">
                    {steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
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

/**
 * The pattern list, as columns. The title and the first lines of the problem
 * share one column — the name alone does not tell you what a pattern is for —
 * and everything else the record carries opens on click.
 */
function patternColumns(open: (p: BuildPattern) => void): RecordColumn<BuildPattern>[] {
  return [
    {
      key: 'pattern_id',
      header: 'pattern id',
      width: '26ch',
      clip: true,
      title: (p) => p.pattern_id ?? p.id,
      cell: (p) => <RecordId missing="no pattern_id">{p.pattern_id}</RecordId>,
    },
    {
      key: 'title',
      header: 'pattern',
      card: 'title',
      width: '48ch',
      title: (p) => p.title,
      cell: (p) => <TwoLine title={p.title} description={p.excerpt} empty="No problem statement written on this pattern." />,
    },
    {
      key: 'reusability',
      header: 'reusability',
      card: 'meta',
      width: '18ch',
      clip: true,
      className: 'card-meta',
      cellClass: (p) => (p.reusability?.trim().toLowerCase() === 'broad' ? 'text-accent-ink' : 'text-faint'),
      title: (p) => p.reusability ?? undefined,
      cell: (p) => (p.reusability ? (reuseKey(p) === '(written out in prose)' ? 'in prose' : p.reusability.toLowerCase()) : <span className="text-faint">—</span>),
    },
    {
      /*
        The system, from the pattern id's own second segment (2026-09-16,
        Destiny). Five columns left this table stretched where the other record
        tables are tight; this is a real field every row already carries, and
        it is the one the strip's new figure counts.
      */
      key: 'system',
      header: 'system',
      card: 'meta',
      width: '16ch',
      clip: true,
      className: 'card-meta text-dim',
      title: (p) => p.system ?? undefined,
      cell: (p) => p.system ?? <span className="text-faint">—</span>,
    },
    {
      key: 'created',
      header: 'created',
      width: '14ch',
      className: 'tabular text-faint',
      cell: (p) => p.created_at?.slice(0, 10) ?? <span className="text-faint">no date</span>,
    },
    { key: 'source', header: 'source', cell: (p) => <SourceLink source={p.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (p) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(p)} />
          <RowAction label="Open in Airtable" onClick={() => window.open(p.airtable.url, '_blank', 'noreferrer')} />
        </RowActions>
      ),
    },
  ];
}

/**
 * Two views of the same records (2026-09-16, Destiny), tabbed at the top the
 * way the System Registry tabs its four registries.
 *
 * **Patterns** is the working surface: the list and its filters. **Statistics**
 * answers the other question — is this getting better or worse — which needs
 * month-against-month figures rather than rows. Everything month-shaped lives
 * there: the chart, the month in view and the export.
 */
const VIEWS = ['Patterns', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function BuildPatterns() {
  const { status, data: loaded, error } = useData(getBuildPatterns, []);
  const [patterns, setPatterns] = useState<BuildPattern[]>([]);
  const [reuse, setReuse] = useState('all');
  /**
   * The month the page is showing, and the month the statistics tab compares
   * (2026-09-16, Destiny). One selection, chosen beside the search box, the
   * same as Codex and Open loops: a strip answering all time while the list
   * answers one month is two right numbers to two different questions.
   *
   * It opens on the current month. `null` is "All time", still the last option
   * in the picker — just no longer what the page assumes you wanted.
   */
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [view, setView] = useState<View>('Patterns');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('patterns', query, null, month), [month, tick]);
  // Re-read after a resync: the months change when the rows do.
  const searchSeq = useRef(0);

  useEffect(() => {
    if (loaded) setPatterns(loaded.patterns);
  }, [loaded]);

  const resync = useResync({
    run: () => resyncRecords('patterns'),
    reload: async () => {
      setTick((n) => n + 1);
      setPatterns((await getBuildPatterns({ lane: 'all' })).patterns);
    },
    setToast,
  });

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

  // Every month a pattern was created in, newest first, with no gaps.
  const months = useMemo(() => monthsFrom(patterns.map((p) => p.created_at)), [patterns]);
  // The month in view, before the reusability filter and the search: what the
  // keyword bar and the reusability filter are counting.
  const inMonth = useMemo(() => patterns.filter((p) => !month || p.created_at?.slice(0, 7) === month), [patterns, month]);

  const keywordCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of inMonth) for (const k of p.keywords) c.set(k, (c.get(k) ?? 0) + 1);
    return [...c.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [inMonth]);

  const reuseOptions = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of inMonth) c.set(reuseKey(p), (c.get(reuseKey(p)) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [inMonth]);

  const rows = useMemo(
    () =>
      inMonth
        .filter((p) => reuse === 'all' || reuseKey(p) === reuse)
        .filter((p) => (hits ? hits.has(p.id) : true)),
    [inMonth, reuse, hits],
  );
  const paged = usePaged(rows, `${reuse}|${q.trim()}|${month ?? 'all'}`);

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Build patterns"
        subtitle="Every reusable pattern the engine has written up, searchable across every field"
        right={<ResyncButton busy={resync.busy} onClick={resync.start} />}
        below={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {/* overflow-x-hidden: nothing on this page may scroll the body sideways. */}
      {/*
        Everything month-shaped lives on the statistics tab: the chart, the
        month in view and the export. This tab is the list and its filters.
      */}
      {view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<BuildPattern>
            kind="patterns"
            noun="Patterns"
            monthlyKind="patterns"
            month={month}
            onMonth={setMonth}
            rows={patterns}
            dateOf={(p) => p.created_at}
            columns={[
              { header: 'pattern_id', value: (p) => p.pattern_id },
              { header: 'airtable_record_id', value: (p) => p.id },
              { header: 'pattern_name', value: (p) => p.title },
              { header: 'bha_system', value: (p) => p.bha_system },
              { header: 'reusability', value: (p) => p.reusability },
              { header: 'created_at', value: (p) => p.created_at },
              { header: 'problem', value: (p) => p.excerpt },
              { header: 'airtable_url', value: (p) => p.airtable.url },
            ]}
          />
        </div>
      ) : (
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          {/*
            writes={false}, the same as Codex. The amber "none written since the
            migration backfill" line is a statement about n8n having gone quiet,
            and it stops meaning that on a page whose rows are kept current by a
            button somebody presses (decision 2026-09-15, Destiny).
          */}
          <RowsLine freshness={loaded.freshness} writes={false} />
        </div>

        <PatternMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />



        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by reusability"
              value={reuse}
              onChange={setReuse}
              options={[{ value: 'all', label: 'All', count: inMonth.length }, ...reuseOptions.map(([r, n]) => ({ value: r, label: r.startsWith('(') ? r.slice(1, -1) : r.toLowerCase(), count: n }))]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              {/* The month in view, to the left of the search box, on every record page. */}
              <MonthPicker months={months} value={month} onChange={setMonth} />
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

        {patterns.length === 0 ? (
          <EmptyState>{loaded.freshness.source === 'none' ? (loaded.freshness.note ?? 'No build patterns are held.') : 'No build patterns are held.'}</EmptyState>
        ) : (
          <>
            {/*
              One row per pattern: id, name, reusability, created, and the first
              lines of the problem. The rest of the record — solution, context,
              gotchas, checklists — opens on click rather than being poured into
              the list, which is what made the page unreadable.

              An empty result keeps the table: the frame, the headers and the
              filters stay and one centred sentence sits where the rows would
              be, so the page holds its shape.
            */}
            <RecordTable
              columns={patternColumns((p) => setOpen(p.id))}
              rows={paged.rows}
              rowKey={(p) => p.id}
              onOpen={(p) => setOpen(p.id)}
              lines={2}
              label="Build patterns"
              empty={q.trim() ? 'No pattern matches that search in this month at the selected reusability.' : month ? 'No pattern was created in this month at the selected reusability.' : 'No pattern records that reusability.'}
            />
            <Pagination paged={paged} unit="patterns" />
          </>
        )}
      </div>
      )}

      {open && <PatternView id={open} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
