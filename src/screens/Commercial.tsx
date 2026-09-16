import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import { getCommercial, getRecordMetrics, resyncRecords, setRecordStatus, type CommercialMetrics, type MetricSeries, type Opportunity, type ReadinessState } from '../data';
import type { RecordColumn } from '../components/ui';
import {
  CountCell,
  EmptyPanel,
  EmptyState,
  HBar,
  LoadFailed,
  Loading,
  MetricCard,
  MetricCell,
  MonthPicker,
  monthsFrom,
  PageHeader,
  Tabs,
  Pagination,
  Pill,
  RecordId,
  RecordTable,
  ResyncButton,
  RowAction,
  RowActions,
  SearchBox,
  Segmented,
  SeriesBlock,
  SourceLink,
  Sparkline,
  StatCell,
  StatStrip,
  RowsLine,
  thisMonth,
  Toast,
  TwoLine,
  usePaged,
  useResync,
  useToast,
} from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';

/**
 * Commercial opportunity cards. 21 of them.
 *
 * **Nothing on this page groups the corpus** (2026-09-15, Destiny). Every
 * candidate axis was checked against all 21 records and every one of them
 * failed, in one of two ways:
 *
 *   lane_id          21 distinct values across 21 cards — 1:1 with the card
 *   readiness_state  19 Research-First, 1 Media-Ready, 1 blank; INCUBATE is a
 *                    valid option that has never once been used
 *   pilot_state      research_only on all 21
 *   routing_state    research_loop on all 21
 *   media_gate       CLOSED on all 21
 *   lane_state       research_first wherever present
 *
 * The last four are hardcoded by the extractor workflow and Process Twin is the
 * only system that would ever advance them, which it never has. So the lane
 * tab, the readiness tab, the card-name tab and the per-lane strip are gone,
 * and what replaces them is one sortable table.
 *
 * The strip read "1.3 open", "1.5 open", "1.8 open" per lane and looked like an
 * average of something. It was not: it was `{n} · {unresolved} open` with a
 * middot between two integers, and because every lane holds exactly one card
 * the first number was always 1. "1.5 open" meant one card with five open
 * research questions. Nothing computed a decimal; the separator read as one.
 *
 * Default sort is missing_research_count ascending then media_readiness
 * descending — closest-to-ready at the top, which is the question the page
 * answers.
 */

const READINESS: ReadinessState[] = ['INCUBATE', 'Research-First', 'Media-Ready'];

/** High before Medium before Low, and an absent value last. Used for the sort and the filter. */
const LEVELS = ['High', 'Medium', 'Low'];
function level(v: string | null): number {
  const i = LEVELS.findIndex((l) => l.toLowerCase() === (v ?? '').trim().toLowerCase());
  return i === -1 ? LEVELS.length : i;
}

function ReadinessPill({ state }: { state: ReadinessState | null }) {
  if (state === 'Media-Ready') return <Pill tone="accent">media-ready</Pill>;
  if (state === 'Research-First') return <Pill>research-first</Pill>;
  if (state === 'INCUBATE') return <Pill>incubate</Pill>;
  return <Pill>no readiness</Pill>;
}

/** Open research questions on a card: the table's own count, or the listed questions, or genuinely nothing. */
function openQuestions(o: Opportunity): number | null {
  if (o.missing_research_count !== null) return o.missing_research_count;
  return o.missing_research_questions.length ? o.missing_research_questions.length : null;
}

function matches(o: Opportunity, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return [o.card_id, o.title, o.lane_id, o.pain_point, o.offer, o.target, o.who_pays, o.next_action, o.bha_system, ...o.missing_research_questions].some((v) => v && v.toLowerCase().includes(n));
}

/* ------------------------------------------------------------------ sort */

type SortKey = 'open' | 'confidence' | 'media' | 'created' | 'title';

/** Where a value that is absent goes: last, whichever way the column is sorted. */
function nullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compare(key: SortKey, dir: 1 | -1, a: Opportunity, b: Opportunity): number {
  switch (key) {
    case 'open':
      return dir * nullsLast(openQuestions(a), openQuestions(b));
    case 'confidence':
      return dir * (level(a.confidence) - level(b.confidence));
    case 'media':
      return dir * (level(a.media_readiness) - level(b.media_readiness));
    case 'created':
      return dir * (a.created_at ?? '').localeCompare(b.created_at ?? '');
    case 'title':
      return dir * a.title.localeCompare(b.title);
  }
}

/**
 * What settles a tie, whichever column is sorted: the most media-ready first,
 * then the card id so the order is stable between renders.
 *
 * It is also the second half of the page's own default — open questions
 * ascending, then media readiness descending — which is why the page opens with
 * the arrow on "open questions" rather than on an order no column names.
 */
function tiebreak(a: Opportunity, b: Opportunity): number {
  return level(a.media_readiness) - level(b.media_readiness) || (a.card_id ?? '').localeCompare(b.card_id ?? '');
}

/**
 * A column header that sorts.
 *
 * Every sortable header carries an arrow, faint until it is the one in force,
 * so a reader can see which columns sort without having to click one to find
 * out. Clicking the active column reverses it.
 */
function SortHeader({ label, k, sort, onSort }: { label: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void }) {
  const on = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={`Sort by ${label}`}
      aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={`inline-flex items-center gap-1 hover:text-ink ${on ? 'text-ink' : ''}`}
    >
      {label}
      <span className={`text-[8px] ${on ? 'text-accent-ink' : 'text-faint opacity-40'}`}>{on && sort.dir === -1 ? '▲' : '▼'}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- metrics */

function CommercialMetricsPanel({ metrics, loading, error }: { metrics: CommercialMetrics | null; loading: boolean; error: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Cards', 'Nothing left to answer', 'Media-ready', 'Open research questions'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxConfidence = Math.max(1, ...m.confidence_mix.map((c) => c.n));

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={4}>
        {/* The hint says which rows, because the strip follows the month picker. */}
        <CountCell label="Cards" value={m.cards} hint={m.scope.month ? 'created in this month' : 'rows in the table'} hintMinLines={2} />
        <CountCell label="Nothing left to answer" value={m.clear} tone={m.clear ? 'accent' : 'dim'} hint="no open research question on the card" hintMinLines={2} />
        <CountCell label="Media-ready" value={m.media_ready} tone={m.media_ready ? 'accent' : 'dim'} hint="readiness_state = Media-Ready" hintMinLines={2} />
        <MetricCell label="Open research questions" metric={m.unresolved_questions} />
      </StatStrip>

      {/* One malformed record, named. Not a fourth readiness and not a bucket. */}
      {m.incomplete.n > 0 && (
        <div className="mx-6 mb-4 md:mx-8">
          <MetricCard title="Cards a complete extractor run did not finish" note={m.incomplete.note}>
            <div className="space-y-1.5 text-[12.5px]">
              {m.incomplete.cards.map((c) => (
                <div key={c.id} className="text-dim">
                  <span className="tabular text-ink">{c.card_id ?? c.id}</span> — no {c.missing.join(', no ')}
                </div>
              ))}
            </div>
          </MetricCard>
        </div>
      )}

      {/*
        Two cards, the same two Build patterns carries (2026-09-16, Destiny):
        the one field that genuinely groups the corpus, and what was created
        per week. Media readiness and the open-question trend moved to the
        statistics tab — both are month-against-month questions, and three
        cards across a page whose sibling has two is the shape the two pages
        were meant to share.
      */}
      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        <MetricCard title="Confidence" note="The confidence field as set on each card, strongest first.">
          {m.confidence_mix.length === 0 ? (
            <EmptyPanel>No card records a confidence.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.confidence_mix.map((c) => (
                <HBar
                  key={c.confidence}
                  label={c.confidence === '(unset)' ? 'no confidence set' : c.confidence.toLowerCase()}
                  value={c.n}
                  max={maxConfidence}
                  tone={c.confidence === 'High' ? 'accent' : 'ink'}
                  valueNode={<span>{c.n}</span>}
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

/**
 * The two cards that moved off the working tab (2026-09-16, Destiny) — media
 * readiness and the open-question trend. Both are month-against-month
 * questions, so they belong beside the month-against-month figures, and they
 * are `MetricCard`s for the same reason the loops series are: the grid has to
 * read as one set of tiles rather than as a row of figures with a
 * different-looking row bolted underneath.
 *
 * The trend is deliberately not scoped to the month. It is this dashboard's own
 * observation of the whole corpus at each resync — Airtable keeps no history
 * of the field — and cutting a record of when something was written down to
 * the month the cards were created in would be two different questions in one
 * chart.
 */
function CommercialStatTiles({ m }: { m: CommercialMetrics | null }) {
  if (!m) return null;
  const maxMedia = Math.max(1, ...m.media_readiness_mix.map((c) => c.n));
  return (
    <>
      <MetricCard title="Media readiness" note="media_readiness per card, strongest first. The second half of the list's default order, after the open research count.">
        {m.media_readiness_mix.length === 0 ? (
          <EmptyPanel>No card in this month records a media readiness.</EmptyPanel>
        ) : (
          <div className="space-y-2">
            {m.media_readiness_mix.map((c) => (
              <HBar
                key={c.media_readiness}
                label={c.media_readiness === '(unset)' ? 'no media readiness set' : c.media_readiness.toLowerCase()}
                value={c.n}
                max={maxMedia}
                tone={c.media_readiness === 'High' ? 'accent' : 'ink'}
                valueNode={<span>{c.n}</span>}
              />
            ))}
          </div>
        )}
      </MetricCard>
      <MetricCard title="Open research questions over time" note={m.unresolved_trend.points ? 'Every card held, at each resync — not only this month\u2019s.' : null}>
        <SeriesBlock title="" series={m.unresolved_trend} tone="accent" bare />
      </MetricCard>
    </>
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

/**
 * The prose the table carries beyond the headline fields. Every one of these is
 * absent on roughly half the corpus — the schema grew over months — so each is
 * drawn where it exists and simply left out where it does not, rather than the
 * page narrowing itself to the fields every row happens to have.
 */
const PROSE: { key: keyof Opportunity; label: string }[] = [
  { key: 'pain_point', label: 'Pain point' },
  { key: 'offer', label: 'Offer' },
  { key: 'target', label: 'Target' },
  { key: 'who_pays', label: 'Who pays' },
  { key: 'bha_system', label: 'BHA system' },
  { key: 'next_action', label: 'Next action' },
  { key: 'metrics_hypothesis', label: 'Metrics hypothesis' },
  { key: 'demand_strength_hypothesis', label: 'Demand strength hypothesis' },
  { key: 'competing_offers_snapshot', label: 'Competing offers' },
  { key: 'offer_shapes_gates', label: 'Offer shapes and gates' },
  { key: 'missing_proof', label: 'Missing proof' },
  { key: 'implementation_constraints', label: 'Implementation constraints' },
  { key: 'infra_gaps', label: 'Infrastructure gaps' },
  { key: 'reuse_patterns', label: 'Reuse patterns' },
  { key: 'next_experiments', label: 'Next experiments' },
  { key: 'experiment_results', label: 'Experiment results' },
  { key: 'research_gleanings', label: 'Research gleanings' },
  { key: 'commercial_impact', label: 'Commercial impact' },
  { key: 'commercial_ready_v1_checklist', label: 'Commercial-ready v1 checklist' },
  { key: 'hypothesis_rejection_note', label: 'Hypothesis rejection note' },
  { key: 'source_logs', label: 'Source logs' },
];

/** The whole card, on click — the same shape as a build pattern's detail view. */
function CardView({ o, trend, busy, onReadiness, onClose }: { o: Opportunity; trend: MetricSeries | undefined; busy: boolean; onReadiness: (o: Opportunity, r: ReadinessState) => void; onClose: () => void }) {
  const listed = o.missing_research_questions.length;
  const disagree = o.missing_research_count !== null && o.missing_research_count !== listed;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 md:p-10" onClick={onClose}>
      <div className="card fade-up w-full max-w-[880px] px-6 py-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Commercial card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker tabular">{o.card_id ?? o.id}</div>
            <h2 className="mt-1 text-[18px] leading-tight">{o.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <ReadinessPill state={o.readiness_state} />
              {o.confidence && <span>confidence {o.confidence.toLowerCase()}</span>}
              {o.media_readiness && <span>media {o.media_readiness.toLowerCase()}</span>}
              {o.created_at ? <span className="tabular">{o.created_at.slice(0, 10)}</span> : <span className="text-degraded">no created_at</span>}
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

        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {listed > 0 ? (
            <div>
              <div className="mb-1 text-[11px] text-faint">
                Open research questions
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

          {PROSE.filter((d) => o[d.key]).map((d) => (
            <div key={d.key}>
              <div className="mb-0.5 text-[11px] text-faint">{d.label}</div>
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{String(o[d.key])}</p>
            </div>
          ))}

          {/*
            The four the extractor hardcodes, plus the two other readiness
            selects. They are on the card because they are what the row says;
            they are never a tab or a chart, because all four are the same value
            on all 21 records and a bucket holding everything sorts nothing.
          */}
          <div>
            <div className="mb-1 text-[11px] text-faint">Pipeline state — written once by the extractor; Process Twin is the only thing that would advance it</div>
            <div className="grid gap-x-6 gap-y-1 text-[11.5px] md:grid-cols-2">
              {(
                [
                  ['pilot_state', o.pilot_state],
                  ['routing_state', o.routing_state],
                  ['lane_state', o.lane_state],
                  ['media_gate', o.media_gate],
                  ['infra_readiness', o.infra_readiness],
                  ['data_readiness', o.data_readiness],
                  ['lane_id', o.lane_id],
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
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <SourceLink source={o.source} />
            <div className="flex flex-wrap gap-2">
              {READINESS.filter((r) => r !== o.readiness_state).map((r) => (
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
 * The card list, as one sortable table. Every column here is a field with real
 * variation across the 21 records; the ones that do not vary are on the card,
 * not in the list.
 */
function commercialColumns(open: (o: Opportunity) => void, change: (o: Opportunity, next: ReadinessState) => void, busyId: string | null, sort: { key: SortKey; dir: 1 | -1 }, onSort: (k: SortKey) => void): RecordColumn<Opportunity>[] {
  return [
    {
      key: 'card_id',
      header: 'card id',
      width: '24ch',
      clip: true,
      title: (o) => o.card_id ?? o.id,
      cell: (o) => <RecordId missing="no card id">{o.card_id}</RecordId>,
    },
    {
      key: 'title',
      header: <SortHeader label="card" k="title" sort={sort} onSort={onSort} />,
      card: 'title',
      width: '48ch',
      title: (o) => o.title,
      cell: (o) => <TwoLine title={o.title} description={o.pain_point ?? o.offer} empty="No pain point or offer written on this card." />,
    },
    {
      key: 'confidence',
      header: <SortHeader label="confidence" k="confidence" sort={sort} onSort={onSort} />,
      card: 'meta',
      width: '16ch',
      className: 'card-meta',
      cellClass: (o) => (o.confidence === 'High' ? 'text-accent-ink' : 'text-dim'),
      cell: (o) => o.confidence?.toLowerCase() ?? <span className="text-faint">not set</span>,
    },
    {
      key: 'media',
      header: <SortHeader label="media" k="media" sort={sort} onSort={onSort} />,
      card: 'meta',
      width: '16ch',
      className: 'card-meta',
      cellClass: (o) => (o.media_readiness === 'High' ? 'text-accent-ink' : 'text-dim'),
      cell: (o) => o.media_readiness?.toLowerCase() ?? <span className="text-faint">not set</span>,
    },
    {
      key: 'questions',
      header: <SortHeader label="questions" k="open" sort={sort} onSort={onSort} />,
      align: 'right',
      card: 'meta',
      className: 'card-meta tabular',
      cellClass: (o) => ((openQuestions(o) ?? 0) > 0 ? 'text-degraded' : 'text-dim'),
      title: (o) => (o.missing_research_questions.length ? o.missing_research_questions.join('\n') : undefined),
      cell: (o) => {
        const n = openQuestions(o);
        return n === null ? <span className="text-faint">no count</span> : n;
      },
    },
    {
      key: 'created',
      header: <SortHeader label="created" k="created" sort={sort} onSort={onSort} />,
      width: '14ch',
      className: 'tabular text-faint',
      // No date is rendered as no date. A card that never got one is not dated today.
      cell: (o) => o.created_at?.slice(0, 10) ?? <span className="text-degraded">no date</span>,
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
            {o.readiness_state !== 'Media-Ready' && <RowAction label="Set media-ready" tone="accent" disabled={busy} onClick={() => change(o, 'Media-Ready')} />}
            <RowAction label="Open in Airtable" onClick={() => window.open(o.airtable.url, '_blank', 'noreferrer')} />
          </RowActions>
        );
      },
    },
  ];
}

/**
 * Two views of the same records (2026-09-16, Destiny), tabbed at the top the
 * way the System Registry tabs its four registries.
 *
 * **Cards** is the working surface: the list and its filters. **Statistics**
 * answers the other question — is this getting better or worse — which needs
 * month-against-month figures rather than rows. Everything month-shaped lives
 * there: the chart, the month in view and the export.
 */
const VIEWS = ['Cards', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

export default function Commercial() {
  const { status, data: loaded, error } = useData(getCommercial, []);
  const [cards, setCards] = useState<Opportunity[]>([]);
  const [confidence, setConfidence] = useState('all');
  const [q, setQ] = useState('');
  /**
   * The month the page is showing, and the month the statistics tab compares
   * (2026-09-16, Destiny). One selection, chosen beside the search box, the
   * same as Build patterns — the two pages are one shape.
   */
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [view, setView] = useState<View>('Cards');
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // missing_research_count ascending, then media_readiness descending: the
  // closest to ready at the top, which is the question this page answers.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'open', dir: 1 });
  const { toast, setToast } = useToast();
  const metrics = useData((query) => getRecordMetrics('commercial', query, null, month), [month, tick]);

  useEffect(() => {
    if (loaded) setCards(loaded.opportunities);
  }, [loaded]);

  const resync = useResync({
    run: () => resyncRecords('commercial'),
    reload: async () => {
      setTick((n) => n + 1);
      setCards((await getCommercial({ lane: 'all' })).opportunities);
    },
    setToast,
  });

  function onSort(k: SortKey) {
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: k === 'created' ? -1 : 1 }));
  }

  // Every month a card was created in, newest first, with no gaps.
  const months = useMemo(() => monthsFrom(cards.map((o) => o.created_at)), [cards]);
  // The month in view, before the confidence filter and the search: what the
  // keyword bar and the confidence filter are counting.
  const inMonth = useMemo(() => cards.filter((o) => !month || o.created_at?.slice(0, 7) === month), [cards, month]);
  const confidenceOptions = useMemo(() => {
    const c = new Map<string, number>();
    for (const o of inMonth) {
      const v = o.confidence ?? '(not set)';
      c.set(v, (c.get(v) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => level(a[0]) - level(b[0]) || a[0].localeCompare(b[0]));
  }, [inMonth]);

  /**
   * The same keyword bar Build patterns carries, read off each card's own
   * `lane_id` (2026-09-16, Destiny). A word one card uses is the card's name,
   * not a keyword, so the bar starts at two — Build patterns uses three
   * because it holds 152 rows to this page's 21.
   */
  const keywordCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const o of inMonth) for (const k of o.keywords) c.set(k, (c.get(k) ?? 0) + 1);
    return [...c.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [inMonth]);

  const rows = useMemo(
    () =>
      inMonth
        .filter((o) => confidence === 'all' || (o.confidence ?? '(not set)') === confidence)
        .filter((o) => matches(o, q.trim()))
        .slice()
        .sort((a, b) => compare(sort.key, sort.dir, a, b) || tiebreak(a, b)),
    [inMonth, confidence, q, sort],
  );
  const paged = usePaged(rows, `${confidence}|${q.trim()}|${sort.key}|${sort.dir}|${month ?? 'all'}`);

  async function change(o: Opportunity, next: ReadinessState) {
    setBusyId(o.id);
    try {
      const updated = await setRecordStatus('commercial', o.id, next);
      setCards((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      setTick((n) => n + 1);
      setToast({ text: `readiness_state set to ${next}. It is held here; a resync takes Airtable's value back.`, tone: 'ok' });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : 'The change did not save.', tone: 'failing' });
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const current = open ? cards.find((o) => o.id === open) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Commercial"
        subtitle="Every opportunity card, closest to ready first"
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
          <RecordStatistics<Opportunity>
            kind="commercial"
            noun="Cards"
            monthlyKind="commercial"
            month={month}
            onMonth={setMonth}
            rows={cards}
            dateOf={(o) => o.created_at}
            extraTiles={<CommercialStatTiles m={metrics.data} />}
            columns={[
              { header: 'card_id', value: (o) => o.card_id },
              { header: 'airtable_record_id', value: (o) => o.id },
              { header: 'opportunity_title', value: (o) => o.title },
              { header: 'lane_id', value: (o) => o.lane_id },
              { header: 'confidence', value: (o) => o.confidence },
              { header: 'media_readiness', value: (o) => o.media_readiness },
              { header: 'readiness_state', value: (o) => o.readiness_state },
              { header: 'missing_research_count', value: (o) => o.missing_research_count },
              { header: 'missing_research_questions', value: (o) => o.missing_research_questions.join(' | ') },
              { header: 'created_at', value: (o) => o.created_at },
              { header: 'airtable_url', value: (o) => o.airtable.url },
            ]}
          />
        </div>
      ) : (
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <RowsLine freshness={loaded.freshness} writes={false} />
        </div>

        <CommercialMetricsPanel metrics={metrics.data} loading={metrics.status === 'loading'} error={metrics.error} />



        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          {/*
            One filter (2026-09-16, Destiny). The media-readiness bar came off:
            it read All / high / medium / low / not set beside a confidence bar
            that reads the same words, and two segmented controls saying the
            same five things is two ways to ask one question. Media readiness is
            still a sortable column and still a card on the statistics tab.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by confidence"
              value={confidence}
              onChange={setConfidence}
              options={[{ value: 'all', label: 'All confidence', count: inMonth.length }, ...confidenceOptions.map(([v, n]) => ({ value: v, label: v === '(not set)' ? 'not set' : v.toLowerCase(), count: n }))]}
            />
            <div className="flex flex-1 items-center justify-end gap-3">
              {/* The month in view, to the left of the search box, on every record page. */}
              <MonthPicker months={months} value={month} onChange={setMonth} />
              <SearchBox value={q} onChange={setQ} placeholder="Search cards and research questions" />
            </div>
          </div>
          {keywordCounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] text-faint">Keywords</span>
              {keywordCounts.map(([k, n]) => (
                <button key={k} type="button" onClick={() => setQ(k)} className={`tag hover:text-accent-ink ${q.trim() === k ? 'tag-accent' : ''}`} title={`${n} cards`}>
                  {k} <span className="text-faint">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {cards.length === 0 ? (
          <EmptyState>{loaded.freshness.source === 'none' ? (loaded.freshness.note ?? 'No commercial cards are held.') : 'No commercial cards are held.'}</EmptyState>
        ) : (
          <>
            <RecordTable
              columns={commercialColumns((o) => setOpen(o.id), change, busyId, sort, onSort)}
              rows={paged.rows}
              rowKey={(o) => o.id}
              onOpen={(o) => setOpen(o.id)}
              busyKey={busyId}
              lines={2}
              label="Commercial cards"
              empty={q.trim() ? 'No card matches that search in this month at the selected confidence.' : month ? 'No card was created in this month at the selected confidence.' : 'No card records that confidence.'}
            />
            <Pagination paged={paged} unit="cards" />
          </>
        )}
      </div>
      )}

      {current && <CardView o={current} trend={loaded.trends[current.id]} busy={busyId === current.id} onReadiness={change} onClose={() => setOpen(null)} />}
      <Toast toast={toast} />
    </div>
  );
}
