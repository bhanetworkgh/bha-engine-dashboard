import { useEffect, useMemo, useState } from 'react';
import { useData } from '../app/useData';
import {
  getCodexEntries,
  getRecordMetrics,
  resyncCodex as resyncCodexFromAirtable,
  type CodexEntry,
  type CodexData,
  type CodexMetrics,
  type CodexTab,
} from '../data';
import type { RecordColumn } from '../components/ui';
import RecordStatistics from '../components/RecordStatistics';
import {
  Bars,
  CountCell,
  CountUp,
  EmptyPanel,
  HBar,
  NotLanded,
  LoadFailed,
  Loading,
  MetricCard,
  Pagination,
  PageHeader,
  Pill,
  RecordId,
  RecordTable,
  RowAction,
  RowActions,
  MonthPicker,
  monthLabel,
  monthsFrom,
  thisMonth,
  SearchBox,
  Segmented,
  SourceLink,
  StatCell,
  Tabs,
  StatStrip,
  ResyncButton,
  RowsLine,
  Toast,
  unlanded,
  usePaged,
  useResync,
  useRecordLink,
  useToast,
  writeWarning,
} from '../components/ui';
import { COMPLETENESS_DEFS, PAID_DEFS, QUALITY_DEF, STAGE_DEFS } from './codexDefinitions';
import { CodexEntryDialog, InputAddedPill, StagePill, when } from './CodexEntryDialog';

/**
 * What a stage says when it holds nothing.
 *
 * One sentence per stage, because the three mean different things: nobody is
 * waiting on Jason, nobody owes an answer, nothing has been approved. A search
 * that matched nothing gets its own line — the stage is not empty, the filter
 * is — and a kind nothing has ever written to says that instead of either.
 */
function emptyLine({
  freshness,
  q,
  tab,
  builder,
  holds,
}: {
  freshness: CodexData['freshness'];
  q: string;
  tab: Tab;
  builder: string;
  holds: number;
}): string {
  if (freshness.source === 'none') return freshness.note ?? 'No Codex submissions are held.';
  if (q) return 'No submission matches that search in the selected builder and stage.';
  const here = builder === 'all' ? '' : ' in this builder\u2019s table';
  if (tab === 'needs_input') {
    const parked = holds ? ` ${holds} ${holds === 1 ? 'is' : 'are'} still parked at the completeness check with no row here yet.` : '';
    return `No logs need input${here}.${parked}`;
  }
  if (tab === 'awaiting') return `No logs are waiting on Jason${here}.`;
  return `Nothing approved yet${here}.`;
}

/**
 * Codex entries, read from BHA Submissions & Logs — one table per builder.
 *
 * The finished Codex entry is the Orchestrator Layer2 Review field. It already
 * exists in Airtable for most rows and was not being shown anywhere; it is now
 * the substance of every row and of the entry view.
 *
 * A log moves through three stages, one per step, and is in exactly one:
 *
 *   Approved           builder codex       through and approved
 *   Awaiting approval  pending review      codex written, Jason has not approved
 *   Needs input        completeness check  parked, still owed an answer
 *
 * The steps are named rather than numbered (2026-09-14, Destiny): "Layer 0"
 * told a reader nothing. The Airtable fields keep their own names — Layer0
 * Flagged, Layer1 Review, Orchestrator Layer2 Review — and the page still
 * quotes those where it states a rule, so the rule stays checkable.
 *
 * A Layer 0 row at `pending_builder_input` wins — that log needs input whatever
 * Jason Status says. Otherwise Jason Status decides. Not `Layer0 Flagged`
 * (2026-09-14, Destiny): that box means "was flagged once, ever" and nothing
 * clears it, so it held eight answered logs in a queue of work owed. It is
 * still shown on the entry, it just no longer places one. The server computes
 * `stage` on the row and the page reads it, so the tabs and the list cannot
 * answer differently.
 *
 * Approved sits first and there is no All tab (2026-09-14, Destiny): almost
 * every log ends up approved, so that is where a reader starts, and a fourth
 * tab that is the sum of the other three earns nothing.
 */

/**
 * Two views of the same rows (2026-09-16, Destiny), tabbed at the top the way
 * the System Registry tabs its four registries.
 *
 * **Entries** is the working surface: the list, its filters, the month in view
 * and the export. **Statistics** answers the other question — is this getting
 * better or worse — which needs month-against-month figures rather than rows,
 * and would have crowded the list off the screen if it sat above it.
 */
const VIEWS = ['Entries', 'Statistics'] as const;
type View = (typeof VIEWS)[number];

const TABS: { value: CodexTab; label: string }[] = [
  { value: 'approved', label: 'Approved' },
  { value: 'awaiting', label: 'Awaiting approval' },
  { value: 'needs_input', label: 'Needs input' },
];

type Tab = CodexTab;

function inTab(e: CodexEntry, tab: Tab): boolean {
  return e.stage === tab;
}

function matches(e: CodexEntry, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  // `paid` is searchable by the word the column prints, so "unpaid" finds the
  // rows the column calls unpaid rather than nothing.
  const paid = e.paid === null ? null : e.paid ? 'paid' : 'unpaid';
  return [
    e.codex_entry_id,
    e.submission_id,
    e.session_type,
    e.jason_status,
    e.narration_quality,
    e.description_excerpt,
    e.entry_excerpt,
    e.week,
    e.session_url,
    paid,
    ...e.layer0_missing,
  ].some((v) => v && v.toLowerCase().includes(n));
}


/* ---------------------------------------------------------------- metrics */

function CodexMetricsPanel({ metrics, loading, error, view, month }: { metrics: CodexMetrics | null; loading: boolean; error: string | null; view: string; month: string | null }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={4} className="opacity-60">
        {['Submissions', 'Codex generated', 'Approved', 'Completeness flagged'].map((l) => (
          <StatCell key={l}>
            <div className="kicker truncate">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const tab = (t: CodexTab) => m.tabs.find((x) => x.tab === t)?.n ?? 0;
  const maxWeek = Math.max(1, ...m.per_builder_per_week.flatMap((b) => b.weeks.map((w) => w.n)));
  const maxStage = Math.max(1, ...m.tabs.map((t) => t.n));
  const maxMissing = Math.max(1, ...m.missing_mix.map((x) => x.n));
  const maxQuality = Math.max(1, ...m.narration_quality_mix.map((x) => x.n));
  const weekAxis = m.per_builder_per_week[0]?.weeks ?? [];

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {/*
        One caption line per figure (2026-09-22, Destiny); the full explanation
        each used to print is word for word behind the mark beside its label.
      */}
      <StatStrip cols={4}>
        <CountCell
          label="Submissions"
          value={m.entries}
          replayKey={view}
          caption={`${m.scope.builder ? 'this builder’s table' : 'the six builder tables'} · ${month ? monthLabel(month) : 'all time'}`}
          hint={m.scope.builder ? 'One builder’s table. The table a row sits in is what makes it theirs.' : 'The six builder tables. The table a row sits in is its builder.'}
        />
        {/* The builder codex is what Layer 2 writes. The note behind the mark
            is the count that has none, which is the figure worth acting on. */}
        <CountCell
          label="Codex generated"
          value={m.with_entry.n}
          tone="accent"
          replayKey={view}
          caption={`of ${m.entries} · ${m.entries - m.with_entry.n} with Layer2 Review empty`}
          hint={m.with_entry.note}
        />
        <CountCell
          label="Approved"
          value={tab('approved')}
          replayKey={view}
          caption={`of ${m.entries} · Jason Status Approved or Input Added`}
          hint="Jason Status is Approved or Input Added, and nothing is parked waiting on the builder."
        />
        <CountCell
          label="Completeness flagged"
          value={m.layer0.flagged}
          tone={m.layer0.flagged ? 'degraded' : 'dim'}
          replayKey={view}
          caption={`of ${m.entries} · Layer0 Flagged ticked, ever`}
          hint="Layer0 Flagged is ticked: something was missing on the way in. It no longer places a log at Needs input."
        />
      </StatStrip>

      {/*
        Three cards, one treatment: the same HBar at the same scale, the count
        and the share on every row, the footnote in the same place. They read as
        one set rather than three cards that happened to be built on different
        days.

        "Review status" is gone from here — it was Jason Status as its own
        breakdown, which is now the stage row above the list. Keeping both would
        have meant two places answering the same question with counts that could
        disagree.
      */}
      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Where logs are" align="top" noteMinLines={2} note={m.stage_reconciliation.note}>
          <div className="space-y-2">
            {m.tabs.map((t) => (
              <HBar
                key={t.tab}
                label={
                  <span title={STAGE_DEFS[t.tab]}>
                    {t.label} <span className="text-faint">{t.layer}</span>
                  </span>
                }
                value={t.n}
                max={maxStage}
                tone={t.tab === 'approved' ? 'accent' : t.tab === 'needs_input' ? 'degraded' : 'ink'}
                replayKey={view}
                valueNode={<CountUp value={t.n} replayKey={view} />}
                right={<span className="text-faint">{m.entries ? Math.round((t.n / m.entries) * 100) : 0}%</span>}
              />
            ))}
          </div>
        </MetricCard>

        <MetricCard title="Completeness check" align="top" noteMinLines={2} note={`${m.layer0.definition} ${m.holds.note}`}>
          {/* Nothing flagged means no bars to draw, whatever is parked — the
              parked count is in the footnote. Drawing one bar at zero left the
              card mostly empty beside two full ones. */}
          {m.layer0.flagged === 0 ? (
            <EmptyPanel>Every submission read here passed the completeness check clean.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              <HBar
                label={<span title={COMPLETENESS_DEFS.flagged}>Flagged incomplete</span>}
                value={m.layer0.flagged}
                max={Math.max(1, m.entries)}
                tone="degraded"
                replayKey={view}
                valueNode={<CountUp value={m.layer0.flagged} replayKey={view} />}
                right={<span className="text-faint">{m.entries ? Math.round((m.layer0.flagged / m.entries) * 100) : 0}%</span>}
              />
              {/* The sub-heading that stood here is gone (2026-09-14,
                  Destiny). Two bars with their own labels and counts say it;
                  a line above them restating what the card is already called
                  is furniture. */}
              {m.missing_mix.map((x) => (
                <HBar
                  key={x.element}
                  label={<span title={COMPLETENESS_DEFS.missing}>{x.element}</span>}
                  value={x.n}
                  max={maxMissing}
                  replayKey={view}
                  valueNode={<CountUp value={x.n} replayKey={view} />}
                  right={<span className="text-faint">{m.layer0.flagged ? Math.round((x.n / m.layer0.flagged) * 100) : 0}%</span>}
                />
              ))}
              {/* "Parked at the gate" was a fourth bar here and is gone
                  (2026-09-14, Destiny): everything in that table is parked by
                  definition, so the bar restated its own table's name. The
                  count still shows — in this card's footnote, and under the
                  Needs input tab where somebody can act on it. */}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Narration quality" align="top" noteMinLines={2} note={m.narration_quality_note}>
          {m.narration_quality_mix.length === 0 ? (
            <EmptyPanel>No submission carries a narration quality.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {/* Highest tier first, as the pipeline defines them: Excellent,
                  Great, Good. The server orders them; sorting gave Excellent,
                  Good, Great, which reads as Good outranking Great. */}
              {m.narration_quality_mix.map((qq, i) => (
                <HBar
                  key={qq.quality}
                  label={<span title={QUALITY_DEF}>{qq.quality}</span>}
                  value={qq.n}
                  max={maxQuality}
                  tone={i === 0 ? 'accent' : 'ink'}
                  replayKey={view}
                  valueNode={<CountUp value={qq.n} replayKey={view} />}
                  right={<span className="text-faint">{m.entries ? Math.round((qq.n / m.entries) * 100) : 0}%</span>}
                />
              ))}
            </div>
          )}
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 md:mx-8">
        <MetricCard
          title="Entries per builder per week"
          right="last eight weeks"
          note="By the week of each submission’s timestamp. The builder is the table the row lives in, so every submission is attributed."
        >
          {m.per_builder_per_week.length === 0 ? (
            <EmptyPanel>No submission has been read from any builder table.</EmptyPanel>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11.5px]">
                <thead>
                  <tr className="text-faint">
                    <th className="pb-1 text-left font-medium">builder</th>
                    {/* The week start alone. Full ranges crowded the axis to the point of being unreadable. */}
                    {weekAxis.map((w) => (
                      <th key={w.week} className="whitespace-nowrap pb-1 text-right font-medium" title={w.label}>
                        {w.short}
                      </th>
                    ))}
                    <th className="pb-1 text-right font-medium">all</th>
                  </tr>
                </thead>
                <tbody>
                  {m.per_builder_per_week.map((b) => {
                    const total = b.weeks.reduce((n, w) => n + w.n, 0);
                    return (
                      <tr key={b.owner} className="border-t border-line">
                        <td className="py-1 text-dim capitalize">{b.owner}</td>
                        {b.weeks.map((w) => (
                          <td key={w.week} className="tabular py-1 text-right" title={`${w.label}: ${w.n}`}>
                            <span className={w.n === 0 ? 'text-faint' : 'text-ink'} style={{ opacity: w.n === 0 ? 0.5 : 0.55 + (0.45 * w.n) / maxWeek }}>
                              {w.n}
                            </span>
                          </td>
                        ))}
                        <td className="tabular py-1 text-right text-dim">{total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2">
                <Bars
                  values={weekAxis.map((w) => m.per_builder_per_week.reduce((n, b) => n + (b.weeks.find((x) => x.week === w.week)?.n ?? 0), 0))}
                  labels={weekAxis.map((w) => w.short)}
                  height={44}
                  tone="accent"
                  highlightLast={false}
                  replayKey={view}
                />
              </div>
            </div>
          )}
        </MetricCard>
      </div>
    </div>
  );
}

/**
 * The list, as columns. Date, builder and the Codex id read first; the session
 * description takes the wide column; flags carry the review decision, the pay
 * state and the completeness verdict, three axes and all shown.
 *
 * The wide column used to hold the Breakthroughs section of the generated
 * codex (changed 2026-09-16, Destiny). Every Layer 2 entry is written to the
 * same template, so 220 characters of one read much like 220 characters of the
 * next and scanning down the page told you nothing. Session Description is the
 * builder's own title for the session, which is what a reader scanning
 * builders and dates is actually looking for. The full codex is unchanged and
 * still opens on click.
 */
function codexColumns(open: (e: CodexEntry) => void): RecordColumn<CodexEntry>[] {
  return [
    { key: 'date', header: 'date', className: 'tabular text-faint', cell: (e) => when(e.logged_at) },
    { key: 'builder', header: 'builder', card: 'meta', className: 'card-meta capitalize text-dim', cell: (e) => e.builder_id },
    {
      key: 'codex_id',
      header: 'codex id',
      width: '22ch',
      clip: true,
      title: (e) => e.codex_entry_id ?? e.submission_id ?? e.id,
      cell: (e) => <RecordId missing="no codex id">{e.codex_entry_id ?? e.submission_id}</RecordId>,
    },
    {
      key: 'session_type',
      header: 'session type',
      width: '20ch',
      clip: true,
      className: 'text-dim',
      title: (e) => e.session_type ?? undefined,
      cell: (e) => e.session_type ?? <span className="text-faint">not stated</span>,
    },
    {
      key: 'description',
      header: 'description',
      card: 'title',
      width: '50ch',
      clip: true,
      title: (e) => e.description_excerpt ?? undefined,
      cell: (e) => e.description_excerpt ?? <span className="text-faint">No session description was submitted with this log.</span>,
    },
    {
      key: 'stage',
      header: 'stage',
      card: 'meta',
      className: 'card-meta',
      title: (e) =>
        unlanded(e.writeback)
          ? writeWarning(e.writeback!)
          : e.layer0_flagged && e.layer0_missing.length
            ? `The completeness check found no ${e.layer0_missing.join(', ')}`
            : undefined,
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5">
          <StagePill entry={e} />
          <InputAddedPill entry={e} />
          {unlanded(e.writeback) && <NotLanded write={e.writeback!} />}
        </span>
      ),
    },
    {
      key: 'paid',
      header: 'paid',
      card: 'meta',
      className: 'card-meta',
      title: (e) => (e.paid === null ? 'Paid carries no value on this row. The field was added to the builder tables after this log was written and nothing backfills it.' : e.paid ? PAID_DEFS.paid : PAID_DEFS.unpaid),
      // Not coloured either way. Paid is not a healthy state and unpaid is not
      // a failing one — they are two ordinary facts about a log — so the pill
      // is the quiet default and amber and red stay meaning what they mean.
      cell: (e) => (e.paid === null ? <span className="text-faint">not recorded</span> : <Pill>{e.paid ? 'paid' : 'unpaid'}</Pill>),
    },
    { key: 'quality', header: 'quality', className: 'text-faint', title: (e) => (e.narration_quality ? QUALITY_DEF : undefined), cell: (e) => e.narration_quality?.toLowerCase() ?? '—' },
    { key: 'source', header: 'source', cell: (e) => <SourceLink source={e.source} /> },
    {
      key: 'actions',
      align: 'right',
      card: 'actions',
      className: 'card-actions',
      cell: (e) => (
        <RowActions>
          <RowAction label="Read entry" tone="accent" onClick={() => open(e)} />
          <RowAction label="Open in Airtable" onClick={() => window.open(e.airtable.url, '_blank', 'noreferrer')} />
        </RowActions>
      ),
    },
  ];
}

/* ------------------------------------------------------------------ page */

export default function Codex() {
  const { status, data: loaded, error } = useData(getCodexEntries, []);
  const [entries, setEntries] = useState<CodexEntry[]>([]);
  const [builder, setBuilder] = useState('all');
  const [tab, setTab] = useState<Tab>('approved');
  const [q, setQ] = useState('');
  /**
   * The month the entries tab is showing, and the month the statistics tab is
   * comparing. They are deliberately the same selection: choosing September on
   * one and coming back to the other should not show you August.
   *
   * It opens on the current month (2026-09-16, Destiny). The page used to open
   * on every submission BHA had ever logged, so the headline figure never
   * moved and said nothing about how the month was going. `null` is still
   * reachable — it is the last option in the picker — it is just no longer
   * what the page assumes.
   */
  const [month, setMonth] = useState<string | null>(thisMonth());
  const [view, setView] = useState<View>('Entries');
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { toast, setToast } = useToast();
  /**
   * `/codex/<Codex Entry ID>` opens that entry, and opening one puts its
   * address in the bar (2026-09-22) — the same shape Open loops has, from the
   * same hook, so the two cannot drift.
   *
   * The Codex entry id where there is one and the submission id where there is
   * not: a log still at the completeness check has no Codex entry id yet, and a
   * link to it has to work anyway. That is the same pair the delete
   * confirmation already falls back through.
   */
  useRecordLink({
    base: '/codex',
    rows: entries,
    /*
      `entries` is copied out of `loaded` by an effect, so for one commit the
      fetch has come back and the list is still empty. Saying "ready" then would
      report every link as naming a record this dashboard does not hold — so
      ready means the rows are final, which is either some rows or a load that
      genuinely returned none.
    */
    ready: Boolean(loaded) && (entries.length > 0 || loaded!.entries.length === 0),
    keyOf: (e) => ({ natural: e.codex_entry_id ?? e.submission_id, id: e.id }),
    openId: open,
    setOpenId: setOpen,
    onMissing: (id) => setToast({ text: `No Codex entry here is called ${id}. It may have been deleted, or the link may be to a submission this dashboard never held.`, tone: 'failing' }),
  });
  const metrics = useData((query) => getRecordMetrics('codex', query, builder, month), [builder, month, tick]);

  useEffect(() => {
    if (loaded) setEntries(loaded.entries);
  }, [loaded]);

  /**
   * Pull from Airtable and make this database match it.
   *
   * The button, the toast and the refetch are shared with Build patterns,
   * Commercial and Clients (see components/ui/Resync.tsx), so the four pages
   * cannot word the same outcome differently. The per-table breakdown is still
   * written in full to the server log, which is where somebody goes when a
   * total looks wrong.
   */
  const resync = useResync({
    run: resyncCodexFromAirtable,
    reload: async () => {
      setTick((n) => n + 1);
      setEntries((await getCodexEntries({ lane: 'all' })).entries);
    },
    setToast,
  });

  // Every month there is a submission for, newest first, and how many each
  // holds — read off the rows the page already has rather than asked for.
  const months = useMemo(() => monthsFrom(entries.map((e) => e.logged_at)), [entries]);
  const inMonth = useMemo(() => entries.filter((e) => !month || e.logged_at?.slice(0, 7) === month), [entries, month]);
  const scoped = useMemo(
    () => entries.filter((e) => (builder === 'all' || e.builder_id === builder) && (!month || e.logged_at?.slice(0, 7) === month)),
    [entries, builder, month],
  );
  const rows = useMemo(
    () =>
      scoped
        .filter((e) => inTab(e, tab))
        .filter((e) => matches(e, q.trim())),
    [scoped, tab, q],
  );
  const paged = usePaged(rows, `${builder}|${tab}|${q.trim()}|${month ?? 'all'}`);

  if (status === 'loading' || !loaded) return status === 'error' ? <LoadFailed error={error} /> : <Loading />;
  const m = metrics.data;
  const holds = loaded.layer0_holds.filter((h) => (builder === 'all' ? true : h.builder_id === builder) && h.open);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PageHeader
        title="Codex entries"
        subtitle="Every session BHA has logged, as the orchestrator wrote it up"
        right={
          <ResyncButton busy={resync.busy} onClick={resync.start} />
        }
        below={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {/*
        Everything month-shaped lives on the statistics tab now: the chart, the
        month in view, the approval-time figure and the export. The entries tab
        is the list and its filters, and nothing else.
      */}
      {view === 'Statistics' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <RecordStatistics<CodexEntry>
            kind="codex"
            noun="Logs"
            monthlyKind="codex"
            month={month}
            onMonth={setMonth}
            rows={entries}
            dateOf={(e) => e.logged_at}
            columns={[
              { header: 'codex_entry_id', value: (e) => e.codex_entry_id },
              { header: 'submission_id', value: (e) => e.submission_id },
              { header: 'airtable_record_id', value: (e) => e.id },
              { header: 'builder', value: (e) => e.builder_id },
              { header: 'logged_at', value: (e) => e.logged_at },
              { header: 'jason_status', value: (e) => e.jason_status },
              { header: 'jason_reviewed_at', value: (e) => e.reviewed_at },
              { header: 'stage', value: (e) => e.stage },
              { header: 'paid', value: (e) => (e.paid === null ? null : e.paid ? 'Yes' : 'No') },
              { header: 'session_description', value: (e) => e.description_excerpt },
              { header: 'session_type', value: (e) => e.session_type },
              { header: 'layer0_flagged', value: (e) => e.layer0_flagged },
              { header: 'airtable_url', value: (e) => e.airtable.url },
            ]}
          />
        </div>
      ) : (
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <div className="shrink-0 px-6 pb-3 md:px-8">
          <RowsLine freshness={loaded.freshness} writes={false} />
          {/*
            The reconciliation that runs on load no longer says anything here.
            It only ever removes rows Airtable has lost, it keeps a full line in
            the server log including Airtable's own reason, and a standing
            yellow banner for a background check was furniture on a page whose
            rows were never in doubt (decision 2026-09-14, Destiny).
          */}
        </div>

        <CodexMetricsPanel metrics={m} loading={metrics.status === 'loading'} error={metrics.error} view={builder} month={month} />

        <div className="shrink-0 space-y-3 px-6 pb-3 md:px-8">
          {/* One tab per submissions table. There is no Jason tab — he reviews
              logs rather than submitting them — and no "no builder" tab, since
              the table a row lives in is its builder. */}
          {/*
            The builder tabs count what each builder logged in the month in
            view, not for all time (2026-09-16, Destiny) — the whole page is
            answering "how did this month go", and a tab whose number never
            moved would be answering a different question in the same row.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              ariaLabel="Filter by builder"
              value={builder}
              onChange={setBuilder}
              options={[
                { value: 'all', label: 'All builders', count: inMonth.length },
                ...loaded.builders.map((b) => ({ value: b.id, label: b.label, count: inMonth.filter((e) => e.builder_id === b.id).length })),
              ]}
            />
            <MonthPicker months={months} value={month} onChange={setMonth} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<Tab> ariaLabel="Stage" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label, title: STAGE_DEFS[t.value], count: scoped.filter((e) => inTab(e, t.value)).length }))} />
            <div className="flex flex-1 items-center justify-end gap-3">
              <SearchBox value={q} onChange={setQ} placeholder="Search entries" />
            </div>
          </div>
          {tab === 'needs_input' && holds.length > 0 && (
            <p className="text-[11.5px] leading-snug text-faint">
              {holds.length} further {holds.length === 1 ? 'submission is' : 'submissions are'} parked at the completeness check with no row in a builder table yet
              {holds.some((h) => h.missing.length) ? `, waiting on ${[...new Set(holds.flatMap((h) => h.missing))].join(', ')}` : ''}. They appear here once the builder resubmits.
            </p>
          )}
        </div>

        {/*
          An empty stage keeps the table (decision 2026-09-14, Destiny): the
          frame, the headers, the tabs and the search box stay where they were
          and one centred sentence sits where the rows would be, so the page
          holds its shape instead of collapsing under the reader. An empty stage
          and a search that matched nothing are different sentences, because
          they are different facts.
        */}
        <RecordTable
          columns={codexColumns((e) => setOpen(e.id))}
          rows={paged.rows}
          rowKey={(e) => e.id}
          onOpen={(e) => setOpen(e.id)}
          label="Codex entries"
          empty={emptyLine({ freshness: loaded.freshness, q: q.trim(), tab, builder, holds: holds.length })}
        />
        {rows.length > 0 && <Pagination paged={paged} unit="submissions" />}

      </div>
      )}

      {open && (
        <CodexEntryDialog
          id={open}
          onClose={() => setOpen(null)}
          onSaved={(u) => {
            setEntries((list) => list.map((x) => (x.id === u.id ? u : x)));
            setTick((n) => n + 1);
          }}
          onDeleted={(gone) => {
            setEntries((list) => list.filter((x) => x.id !== gone));
            setTick((n) => n + 1);
          }}
          setToast={setToast}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}
