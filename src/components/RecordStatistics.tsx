import { useData } from '../app/useData';
import {
  getMonthly,
  getRecordStats,
  type Delta,
  type MonthlySeries,
  type RecordKind,
  type RecordStatMetric,
  type RecordStats,
  type StatKind,
} from '../data';
import { EmptyPanel, Legend, LoadFailed, Loading, MetricCard, MonthChart } from './ui';
import { csvRow, downloadCsv, toCsv, type CsvColumn } from '../lib/csv';

/**
 * The statistics tab behind six record pages: one month set against the month
 * before it.
 *
 * A record page's own tab answers "what is there"; this one answers "is it
 * getting better or worse", which is a different question and needs a different
 * screen. Built for Codex on 16 Sep 2026 and generalised the same day
 * (Destiny) to Open loops, Build patterns, Commercial, Clients, North Star and
 * Research Twin — one component, so six pages cannot draw the same comparison
 * six ways.
 *
 * **Everything that makes a comparison honest is computed on the server** (see
 * `server/src/stats.ts`): which month is compared against which, whether a
 * running month was cut to a like-for-like window, what each figure is over,
 * and the sentence at the top. This file draws it. The one rule it owns is
 * colour: a change is coloured only where the direction is news, so more
 * records is uncoloured and a rising completeness-flag rate is red.
 */

/** "18 min", "4.2 hours", "2.1 days" — the unit a person would use out loud. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${Math.round((ms / 3_600_000) * 10) / 10} hours`;
  return `${Math.round((ms / 86_400_000) * 10) / 10} days`;
}

function fmt(value: number | null, unit: RecordStatMetric['unit']): string {
  if (value === null) return '—';
  if (unit === 'percent') return `${value}%`;
  if (unit === 'duration') return duration(value);
  return String(value);
}

/**
 * A change against the month before.
 *
 * A rate is shown as the difference between the two rates with a per-cent sign
 * — 79.3% → 76.4% reads "down 2.9%" (2026-09-16, Destiny). That is only safe
 * because both figures are printed beside it, so the number can always be
 * checked against what it came from; the tile never shows a change without
 * showing "vs 79.3% in Aug 2026" under it.
 *
 * A change from nought prints both figures rather than an infinity dressed up
 * as a percentage.
 */
function Change({ d, unit }: { d: Delta | null; unit: RecordStatMetric['unit'] }) {
  if (!d) return null;
  if (d.direction === 'flat') return <span className="text-[11.5px] text-faint">no change</span>;
  const arrow = d.direction === 'up' ? '↑' : '↓';
  const tone = d.better === null ? 'text-dim' : d.better ? 'text-ok' : 'text-failing';
  const words =
    unit === 'percent'
      ? `${Math.abs(Math.round((d.to - d.from) * 10) / 10)}%`
      : d.pct === null
        ? `${fmt(d.from, unit)} → ${fmt(d.to, unit)}`
        : `${Math.abs(d.pct)}%`;
  return (
    <span className={`tabular text-[11.5px] ${tone}`} title={`${fmt(d.from, unit)} last month, ${fmt(d.to, unit)} this one`}>
      {arrow} {words}
    </span>
  );
}

/**
 * One figure.
 *
 * A metric nothing records prints the reason where the number would be, rather
 * than a dash that reads like a quiet month or a nought that reads like a fact.
 */
function StatTile({ m, previousLabel, covered }: { m: RecordStatMetric; previousLabel: string; covered: boolean }) {
  return (
    <MetricCard title={m.label} right={m.field} note={m.note} noteMinLines={4} align="top">
      {m.unavailable ? (
        <div className="text-[13px] leading-snug text-degraded">Not recorded anywhere.</div>
      ) : (
        <div className="space-y-1.5">
          {/*
            A figure the month cannot support says so in words. A dash set in
            the display face at 30px reads like a redaction, and worse, it reads
            like a value — the one thing a missing figure must never do.
          */}
          {m.value === null ? (
            <div className="text-[13px] leading-snug text-degraded">Not recorded this month.</div>
          ) : (
            <div className="font-display tabular text-[30px] leading-none text-ink">{fmt(m.value, m.unit)}</div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Change d={m.change} unit={m.unit} />
            {m.change ? (
              <span className="text-[11px] text-faint">
                vs {fmt(m.previous, m.unit)} in {previousLabel}
              </span>
            ) : (
              <span className="text-[11px] text-faint">
                {!covered ? `nothing held for ${previousLabel}` : m.value === null ? 'no figure to compare' : `no figure for ${previousLabel}`}
              </span>
            )}
          </div>
        </div>
      )}
    </MetricCard>
  );
}

/**
 * The month in view, as a file.
 *
 * A report rather than a flat table, the same shape the Executions report
 * takes: the figures first — each with what it is a figure of, the month
 * before, the change and the caveat — then the logs the figures are about.
 * **Every caveat the screen makes is inside the file**, because a file outlives
 * the screen and a number without its boundary is how a partial month gets
 * quoted as a whole one.
 */
function report<T>(stats: RecordStats, rows: T[], columns: CsvColumn<T>[], noun: string, rowsNoun: string): string {
  const shown = (m: RecordStatMetric, v: number | null) =>
    m.unavailable || v === null ? '' : m.unit === 'duration' ? duration(v) : m.unit === 'percent' ? `${v}%` : v;
  return [
    csvRow([`BHA ${noun} statistics`]),
    csvRow(['Month in view', stats.selected_label]),
    csvRow(['Compared against', stats.previous_label]),
    csvRow(['Window', stats.window ?? 'no comparison']),
    csvRow([
      'Like for like',
      !stats.covered
        ? 'no comparison was made'
        : stats.like_for_like
          ? 'yes, both months cut to the same elapsed days'
          : 'yes, both months complete',
    ]),
    csvRow(['In words', stats.prose]),
    csvRow(['Note', stats.note]),
    '',
    csvRow(['metric', 'source field', 'value', stats.previous_label, 'change', 'note']),
    ...stats.metrics.map((m) =>
      csvRow([
        m.label,
        m.field,
        // Blank, never a zero, where the month cannot support the figure.
        shown(m, m.value),
        shown(m, m.previous),
        !m.change || m.change.direction === 'flat'
          ? ''
          : `${m.change.direction} ${
              m.unit === 'percent'
                ? `${Math.abs(Math.round((m.change.to - m.change.from) * 10) / 10)}%`
                : m.change.pct === null
                  ? `${m.change.from} to ${m.change.to}`
                  : `${Math.abs(m.change.pct)}%`
            }`,
        m.note ?? '',
      ]),
    ),
    '',
    csvRow([`${rowsNoun} in ${stats.selected_label}`, `${rows.length}`]),
    toCsv(rows, columns),
  ].join('\r\n');
}

/**
 * A chart for a kind with no monthly rollup of its own.
 *
 * North Star and Research Twin have no `MonthlySeries` — that file encodes
 * per-kind instrumentation boundaries and neither kind has one recorded — so
 * their chart is built from the counts the statistics already returned, drawn
 * by the **same** component rather than a second one. The month in progress is
 * marked partial because it is; nothing else claims a coverage it cannot back.
 */
function seriesFrom(stats: RecordStats, label: string): MonthlySeries {
  const current = stats.months[stats.months.length - 1]?.month;
  return {
    kind: 'codex',
    created_label: label,
    created_field: '',
    advanced_label: null,
    advanced_field: null,
    rate_label: null,
    months: stats.months.map((m) => ({
      month: m.month,
      label: m.label.split(' ')[0],
      created: m.logs,
      advanced: 0,
      rate: null,
      coverage: m.month === current ? 'partial' : 'full',
      advanced_coverage: 'none',
      note: null,
      backfilled: 0,
      segments: null,
    })),
    boundary: null,
    undated: { n: 0, ids: [], note: '' },
    secondary: null,
    segment_keys: null,
    current: stats.selected,
  };
}

export default function RecordStatistics<T>({
  kind,
  month,
  onMonth,
  rows,
  columns,
  noun,
  rowsNoun,
  dateOf,
  monthlyKind,
}: {
  kind: StatKind;
  month: string | null;
  onMonth: (m: string) => void;
  /** Every record of the kind. The export narrows these to the month in view. */
  rows: T[];
  columns: CsvColumn<T>[];
  /** What a record of this kind is called, for the chart and the file. */
  noun: string;
  /**
   * What the exported rows are, where that is not the same thing. Research Twin
   * counts attempts and exports cards — one card can be four attempts — so the
   * file names what it actually carries rather than what the figures count.
   */
  rowsNoun?: string;
  /** The date that puts a record in a month — the same one the server groups by. */
  dateOf: (r: T) => string | null;
  /** The monthly rollup to draw, where the kind has one. Omitted builds the chart from the counts. */
  monthlyKind?: RecordKind;
}) {
  const { status, data, error } = useData(() => getRecordStats(kind, month), [kind, month]);
  const monthly = useData(() => (monthlyKind ? getMonthly(monthlyKind) : Promise.resolve(null)), [monthlyKind]);

  if (status === 'error') return <LoadFailed error={error} />;
  if (!data) return <Loading />;
  if (data.months.length === 0) {
    return (
      <div className="px-6 pb-6 md:px-8">
        <EmptyPanel>No {noun.toLowerCase()} carries a date, so there is no month to compare.</EmptyPanel>
      </div>
    );
  }

  // The records the figures are about — the whole month, unfiltered, which is
  // what the figures above are computed over. Narrowing this by anything the
  // other tab is doing would make the file disagree with the numbers printed
  // beside the button.
  const inMonth = rows.filter((r) => dateOf(r)?.slice(0, 7) === data.selected);
  const series = monthly.data ?? seriesFrom(data, noun);

  return (
    <div className="space-y-4 px-6 pb-6 md:px-8">
      {/*
        The chart leads (2026-09-16, Destiny): every month held, at the top,
        where the shape of the year is the first thing a reader sees. Clicking a
        month is the same act as choosing it in the picker, so there is one
        selection and two ways to make it.
      */}
      {series.months.length > 0 && (
        <MetricCard title="Every month held" note={<Legend series={series} />} align="top">
          {/*
            Read-only (2026-09-16, Destiny). It was clickable and it is not any
            more: the month is chosen in the picker below, and a chart that
            also changed it gave the page two controls for one selection with
            nothing saying which you had used. It is here to show the shape of
            the year.
          */}
          <MonthChart series={series} selected={data.selected} onSelect={() => {}} fill readOnly />
        </MetricCard>
      )}

      {/*
        The month picker, the comparison in words, and the export. The sentence
        is written on the server so this tab and the downloaded report cannot
        word the same change differently.
      */}
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="kicker">Month in view</div>
            <div className="mt-1 text-[15px] text-ink">{data.selected_label}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[11.5px] text-faint">
              <span>Compare</span>
              <select
                className="input h-[30px] w-auto py-0 text-[12px]"
                value={data.selected}
                onChange={(e) => onMonth(e.target.value)}
                aria-label="Month to compare"
              >
                {/* Newest first, like every other list on every page. */}
                {[...data.months].reverse().map((m) => (
                  <option key={m.month} value={m.month}>
                    {m.label} · {m.logs}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => downloadCsv(`${kind}-${data.selected}.csv`, report(data, inMonth, columns, noun, rowsNoun ?? noun))}
              title={`The figures above with every caveat, then the ${(rowsNoun ?? noun).toLowerCase()} in this month`}
            >
              Export CSV
            </button>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink">{data.prose}</p>
        {/*
          Why the comparison is cut, or why it is refused. Amber where there is
          nothing honest to compare against, because that is a gap rather than
          a caveat.
        */}
        <p className={`mt-1.5 text-[11.5px] leading-snug ${data.covered ? 'text-faint' : 'text-degraded'}`}>{data.note}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.metrics.map((m) => (
          <StatTile key={m.key} m={m} previousLabel={data.previous_label} covered={data.covered} />
        ))}
      </div>
    </div>
  );
}
