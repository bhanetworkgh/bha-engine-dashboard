import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getBuildPatterns, getPatternCandidates, getPatternDetail, getRecordMetrics, resyncRecords, searchPatterns, type BuildPattern, type BuildPatternDetail, type PatternCandidate, type PatternCandidatesData, type PatternMetrics } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CountCell,
  Definition,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MonthPicker,
  monthLabel,
  monthsFrom,
  PageHeader,
  Pill,
  relativeTime,
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
import { REUSE_DEFS } from './recordDefinitions';

/** The record kinds this page is built from: a change to one re-reads it (live since 2026-09-23). */
const PATTERN_KINDS = ['patterns', 'pattern_candidates'] as const;

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

/**
 * The systems caption: the names themselves where they fit on one line, and
 * otherwise as many as fit with the rest counted. The whole list, and the rows
 * filed under none, are behind the mark.
 */
function systemsCaption(names: string[], unfiled: number): string {
  if (!names.length) return 'no pattern_id names a system';
  const all = names.join(', ');
  const tail = unfiled ? `; ${unfiled} unfiled` : '';
  if ((all + tail).length <= 55) return all + tail;
  const shown: string[] = [];
  for (const n of names) {
    const next = [...shown, n].join(', ') + ` +${names.length - shown.length - 1} more`;
    if (next.length > 55) break;
    shown.push(n);
  }
  return `${shown.join(', ')} +${names.length - shown.length} more`;
}

/** A reusability bucket as the filter and the definition line word it. */
function reuseLabel(key: string): string {
  return key.startsWith('(') ? key.slice(1, -1) : key.toLowerCase();
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
        {/*
          Caption rule (2026-09-22): one line under each figure, the full
          explanation behind the mark beside the label. The caption says which
          rows, because the strip follows the month picker.
        */}
        <CountCell
          label="Patterns"
          value={m.scope.rows}
          caption={m.scope.month ? `created in ${monthLabel(m.scope.month)}` : 'every row in the table'}
          hint="Rows whose created_at falls in the month chosen beside the search box; All time counts every row in the table. A count of rows, not of distinct pattern ids."
        />
        <CountCell
          label="Distinct pattern ids"
          value={m.duplicates.distinct_ids}
          tone={m.duplicates.duplicate_rows ? 'degraded' : 'dim'}
          caption={m.duplicates.duplicate_rows ? `${m.duplicates.duplicate_rows} more ${m.duplicates.duplicate_rows === 1 ? 'row' : 'rows'} than patterns` : 'one row per pattern'}
          hint={m.duplicates.note}
        />
        {/*
          A fourth figure (2026-09-16, Destiny): three wide cells read sparse
          beside the four and five the other record pages carry. It is the
          system segment of each pattern's own id, which the rows already print.
        */}
        <CountCell label="Systems covered" value={m.systems.n} tone={m.systems.n ? 'default' : 'dim'} caption={systemsCaption(m.systems.names, m.systems.unfiled)} hint={m.systems.note} />
        <CountCell label="Broadly reusable" value={broad} tone={broad ? 'accent' : 'dim'} caption={`${broad} of ${m.scope.rows} rows, reusability = Broad`} hint={REUSE_DEFS.Broad} />
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
                  label={<span title={REUSE_DEFS[r.reusability]}>{r.reusability.startsWith('(') ? r.reusability : r.reusability.toLowerCase()}</span>}
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
      // A sentence shows itself on hover; a single word shows what it means.
      title: (p) => (reuseKey(p) === '(written out in prose)' ? (p.reusability ?? undefined) : REUSE_DEFS[reuseKey(p)]),
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
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (p) => (
        <RowActions>
          <RowAction label="View" tone="accent" onClick={() => open(p)} />
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
const VIEWS = ['Patterns', 'Candidates', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

/**
 * The tab is in the address (2026-09-23): /build-patterns?view=candidates is
 * the link Bays' instructions give people in place of the retired Airtable
 * view. Patterns, the default, carries no parameter.
 */
const VIEW_PARAM: Record<View, string | null> = { Patterns: null, Candidates: 'candidates', Statistics: 'statistics' };
function viewFrom(param: string | null): View {
  return (VIEWS.find((v) => VIEW_PARAM[v] === param) ?? 'Patterns') as View;
}

export default function BuildPatterns() {
  const { status, data: loaded, error } = useData(getBuildPatterns, [], { kinds: PATTERN_KINDS });
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
  const [params, setParams] = useSearchParams();
  const view = viewFrom(params.get('view'));
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (VIEW_PARAM[v]) next.set('view', VIEW_PARAM[v]!);
    else next.delete('view');
    setParams(next, { replace: true });
  };
  /**
   * The candidates: 45 rows, read with the page so the month picker knows
   * their months. A failed read is shown on their tab as a failure, never as
   * an empty list.
   */
  const candidates = useData(getPatternCandidates, [], { kinds: PATTERN_KINDS });
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  // `?open=<id>` opens a pattern on arrival — Home's "What moved" links here (2026-09-23).
  const [open, setOpen] = useState<string | null>(() => (view === 'Candidates' ? null : params.get('open')));
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('patterns', query, null, month), [month, tick], { kinds: PATTERN_KINDS });
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

  // Every month a pattern was created in — or a candidate flagged in — newest first, with no gaps.
  const months = useMemo(
    () => monthsFrom([...patterns.map((p) => p.created_at), ...(candidates.data?.candidates ?? []).map((c) => c.date_flagged)]),
    [patterns, candidates.data],
  );
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
      {view === 'Candidates' ? (
        <CandidatesTab
          state={candidates}
          month={month}
          months={months}
          onMonth={setMonth}
          q={q}
          onQ={setQ}
          patterns={patterns}
          initialOpen={params.get('open')}
          onOpenPattern={(id) => {
            setView('Patterns');
            setOpen(id);
          }}
        />
      ) : view === 'Statistics' ? (
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
              { header: 'record_id', value: (p) => p.id },
              { header: 'pattern_name', value: (p) => p.title },
              { header: 'bha_system', value: (p) => p.bha_system },
              { header: 'reusability', value: (p) => p.reusability },
              { header: 'created_at', value: (p) => p.created_at },
              { header: 'problem', value: (p) => p.excerpt },
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
              options={[
                { value: 'all', label: 'All', count: inMonth.length, title: 'Every pattern in the month in view, whatever its reusability.' },
                ...reuseOptions.map(([r, n]) => ({ value: r, label: reuseLabel(r), count: n, title: REUSE_DEFS[r] })),
              ]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              {/* The month in view, to the left of the search box, on every record page. */}
              <MonthPicker months={months} value={month} onChange={setMonth} />
              <SearchBox value={q} onChange={setQ} placeholder="Search problem, solution, context, name" />
              {q.trim() && hits === null && <span className="tabular whitespace-nowrap text-[11.5px] text-faint">Searching…</span>}
            </div>
          </div>
          {/* The selected bucket, defined from the code that files a row there — see recordDefinitions.ts. */}
          {reuse !== 'all' && REUSE_DEFS[reuse] && <Definition term={reuseLabel(reuse)}>{REUSE_DEFS[reuse]}</Definition>}
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

/* --------------------------------------------------------- candidates tab */

/**
 * Pattern candidates (2026-09-23, Destiny): ideas Bays flags from real work
 * before an architect registers them as build patterns. Read only — a
 * candidate is registered through the Bays Tools Router's log_build_pattern,
 * never from here.
 *
 * It shares the page's search box and month picker, so one selection answers
 * both tabs; the month is the month a candidate was flagged.
 */
const CANDIDATE_STATUSES = ['Proposed', 'Approved', 'Registered'] as const;

/** What each status means, from the table's own vocabulary and the registration path. */
const CANDIDATE_DEFS: Record<string, string> = {
  Proposed: 'Flagged by Bays from real work; no architect has approved it yet.',
  Approved: 'An architect has agreed it should become a pattern; not yet written up and registered.',
  Registered: 'Written up as a build pattern through log_build_pattern. Pattern ID and Registered At are set only on these rows.',
};

function candidateTone(status: string | null): 'default' | 'accent' {
  return status === 'Registered' ? 'accent' : 'default';
}

function candidateColumns(): RecordColumn<PatternCandidate>[] {
  return [
    {
      key: 'candidate',
      header: 'candidate',
      card: 'title',
      width: '46ch',
      title: (c) => c.summary ?? c.candidate ?? c.id,
      cell: (c) => <TwoLine title={c.candidate ?? c.id} description={c.summary} empty="No summary written on this candidate." />,
    },
    { key: 'lane', header: 'lane', card: 'meta', width: '12ch', clip: true, className: 'text-dim', cell: (c) => c.lane ?? <span className="text-faint">—</span> },
    { key: 'builder', header: 'builder', card: 'meta', width: '14ch', clip: true, className: 'text-dim', cell: (c) => c.builder ?? <span className="text-faint">—</span> },
    {
      key: 'architect',
      header: 'suggested architect',
      card: 'meta',
      width: '16ch',
      clip: true,
      className: 'text-dim',
      title: (c) => c.why_this_architect ?? undefined,
      cell: (c) => c.suggested_architect ?? <span className="text-faint">—</span>,
    },
    {
      key: 'status',
      header: 'status',
      card: 'meta',
      width: '12ch',
      title: (c) => (c.status ? CANDIDATE_DEFS[c.status] ?? `"${c.status}" is not one of Proposed, Approved or Registered.` : 'No status on this row.'),
      cell: (c) => (c.status ? <Pill tone={candidateTone(c.status)}>{c.status.toLowerCase()}</Pill> : <span className="text-faint">—</span>),
    },
    { key: 'flagged', header: 'flagged', card: 'meta', width: '11ch', className: 'tabular text-faint', cell: (c) => c.date_flagged ?? <span className="text-faint">undated</span> },
  ];
}

function CandidatesTab({
  state,
  month,
  months,
  onMonth,
  q,
  onQ,
  patterns,
  initialOpen = null,
  onOpenPattern,
}: {
  state: { status: 'loading' | 'ready' | 'error'; data: PatternCandidatesData | null; error: string | null };
  month: string | null;
  months: string[];
  onMonth: (m: string | null) => void;
  q: string;
  onQ: (q: string) => void;
  patterns: BuildPattern[];
  /** `?open=<id>` on arrival. */
  initialOpen?: string | null;
  onOpenPattern: (id: string) => void;
}) {
  const [status, setStatus] = useState('all');
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const all = state.data?.candidates ?? [];
  const inMonth = useMemo(() => all.filter((c) => !month || c.date_flagged?.slice(0, 7) === month), [all, month]);
  const needle = q.trim().toLowerCase();
  const searched = useMemo(
    () =>
      !needle
        ? inMonth
        : inMonth.filter((c) =>
            [c.id, c.candidate, c.summary, c.lane, c.builder, c.suggested_architect, c.why_this_architect, c.flagged_by, c.pattern_id].some((v) => v?.toLowerCase().includes(needle)),
          ),
    [inMonth, needle],
  );
  const counts = (st: string) => searched.filter((c) => c.status === st).length;
  const others = searched.filter((c) => !(CANDIDATE_STATUSES as readonly string[]).includes(c.status ?? '')).length;
  const rows = status === 'all' ? searched : status === 'other' ? searched.filter((c) => !(CANDIDATE_STATUSES as readonly string[]).includes(c.status ?? '')) : searched.filter((c) => c.status === status);
  const paged = usePaged(rows, `${status}|${needle}|${month ?? 'all'}`);
  const open = openId ? all.find((c) => c.id === openId) ?? null : null;

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error' || !state.data) {
    return (
      <div className="card mx-6 mt-2 px-5 py-4 text-[12.5px] text-failing md:mx-8">
        Could not read the pattern candidates: {state.error ?? 'no answer'}. This is a failed read, not an empty list.
      </div>
    );
  }

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div className="shrink-0 px-6 pb-3 text-[12px] text-faint md:px-8">
        {state.data.held} {state.data.held === 1 ? 'candidate' : 'candidates'} held
        {state.data.updated_at ? ` · newest change ${relativeTime(state.data.updated_at) ?? state.data.updated_at}` : ''} · registered through Bays, never from here
      </div>
      <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* The status strip: each count is the filter. */}
          <Segmented
            ariaLabel="Filter by status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: searched.length, title: 'Every candidate in the month in view.' },
              ...CANDIDATE_STATUSES.map((st) => ({ value: st, label: st, count: counts(st), title: CANDIDATE_DEFS[st] })),
              ...(others ? [{ value: 'other', label: 'Other status', count: others, title: 'A status that is not Proposed, Approved or Registered, or none at all.' }] : []),
            ]}
          />
          <div className="flex flex-1 items-center justify-end gap-3">
            <MonthPicker months={months} value={month} onChange={onMonth} />
            <SearchBox value={q} onChange={onQ} placeholder="Search candidate, summary, lane, people" />
          </div>
        </div>
        {status !== 'all' && CANDIDATE_DEFS[status] && <Definition term={status}>{CANDIDATE_DEFS[status]}</Definition>}
      </div>
      {state.data.held === 0 ? (
        <EmptyState>No pattern candidate is held. Bays writes them to engine_pattern_candidates as it flags them; none has arrived.</EmptyState>
      ) : (
        <>
          <RecordTable
            columns={candidateColumns()}
            rows={paged.rows}
            rowKey={(c) => c.id}
            onOpen={(c) => setOpenId(c.id)}
            lines={2}
            label="Pattern candidates"
            empty={needle ? 'No candidate matches that search in this month at this status.' : month ? 'No candidate was flagged in this month at this status.' : 'No candidate has this status.'}
          />
          <Pagination paged={paged} unit="candidates" />
        </>
      )}
      {open && (
        <CandidateView
          c={open}
          onClose={() => setOpenId(null)}
          patternRecord={open.pattern_id ? patterns.find((p) => p.pattern_id === open.pattern_id)?.id ?? null : null}
          onOpenPattern={(id) => {
            setOpenId(null);
            onOpenPattern(id);
          }}
        />
      )}
    </div>
  );
}

/** The whole candidate, in the same dialog shape the pattern view uses. */
function CandidateView({ c, onClose, patternRecord, onOpenPattern }: { c: PatternCandidate; onClose: () => void; patternRecord: string | null; onOpenPattern: (id: string) => void }) {
  const rows: [string, string | null][] = [
    ['Lane', c.lane],
    ['Builder', c.builder],
    ['Suggested architect', c.suggested_architect],
    ['Flagged by', c.flagged_by],
    ['Date flagged', c.date_flagged],
  ];
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Pattern candidate">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{c.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{c.candidate ?? c.id}</h2>
            <div className="mt-2">{c.status ? <Pill tone={candidateTone(c.status)}>{c.status.toLowerCase()}</Pill> : <span className="text-[12px] text-faint">no status</span>}</div>
          </div>
          <div className="flex items-center gap-2">
            {c.source_link && (
              <a href={c.source_link} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Open the Slack thread
              </a>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="mt-4 space-y-4">
          {c.status === 'Registered' && (
            <div>
              <div className="mb-1 text-[11px] text-faint">Registered as</div>
              {c.pattern_id ? (
                patternRecord ? (
                  <button type="button" className="link tabular text-[13px]" onClick={() => onOpenPattern(patternRecord)}>
                    {c.pattern_id}
                  </button>
                ) : (
                  <span className="tabular text-[13px] text-ink">
                    {c.pattern_id} <span className="text-faint">— no pattern with this id is held on the Patterns tab</span>
                  </span>
                )
              ) : (
                <span className="text-[13px] text-faint">Registered, but the row carries no Pattern ID.</span>
              )}
              {c.registered_at && <span className="tabular ml-3 text-[12px] text-faint">{c.registered_at.slice(0, 16).replace('T', ' ')}</span>}
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] text-faint">Summary</div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{c.summary ?? <span className="text-faint">No summary written.</span>}</p>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-faint">Why this architect</div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{c.why_this_architect ?? <span className="text-faint">Not written.</span>}</p>
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[auto_minmax(0,1fr)]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className={v ? 'text-dim' : 'text-faint'}>{v ?? '—'}</dd>
              </div>
            ))}
          </dl>
          {!c.source_link && <p className="text-[12px] text-faint">No Source Link on this row, so there is no thread to open.</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
