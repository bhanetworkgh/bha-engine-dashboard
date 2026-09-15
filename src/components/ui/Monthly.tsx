import type { ReactNode } from 'react';
import type { MonthCoverage, MonthPoint, MonthlySeries } from '../../data';
import { MetricCard } from './Card';
import { EmptyPanel } from './EmptyState';
import { downloadCsv, csvName, toCsv, type CsvColumn } from '../../lib/csv';

/**
 * The monthly tracking panel: this month's summary, the month-over-month
 * chart, and the CSV export. The same three components in the same order on
 * every record page.
 *
 * **The chart is the component at risk of lying by omission, and everything
 * about its shape is that risk.** Several of the date fields behind these
 * figures only started being written recently, and a month that renders as a
 * low bar because the data did not exist yet reads as a quiet month rather than
 * as a gap in instrumentation. So the server gives every month its own
 * coverage, separately for what was created and for what advanced, and this
 * draws them differently:
 *
 *   full     a solid bar
 *   partial  a hatched bar, and a caret under the label
 *   none     **no bar at all** — the column is left empty behind a dashed
 *            boundary rule, and the sentence under the chart says what began
 *            when. A bar of nought and a month nothing was recording must never
 *            look the same.
 *
 * Clicking a month selects it and the page's own list filters to it; clicking
 * it again clears the selection. The CSV export then exports exactly what is on
 * screen, that selection and every other filter included.
 */

const BAR = 26;
const GAP = 12;
const H = 116;

function pct(n: number | null): string {
  return n === null ? '—' : `${n}%`;
}

/** The hatch a partial month is drawn with, defined once per chart instance. */
function Hatch({ id, color }: { id: string; color: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill={color} opacity="0.18" />
      <line x1="0" y1="0" x2="0" y2="5" stroke={color} strokeWidth="2.4" />
    </pattern>
  );
}

function MonthChart({
  series,
  selected,
  onSelect,
}: {
  series: MonthlySeries;
  selected: string | null;
  onSelect: (month: string | null) => void;
}) {
  const months = series.months;
  const max = Math.max(1, ...months.map((m) => Math.max(m.created, m.advanced)));
  const showAdvanced = series.advanced_label !== null;
  const width = months.length * (BAR + GAP);
  // The first month with anything recorded, so the boundary rule sits on its edge.
  const firstCovered = months.findIndex((m) => m.coverage !== 'none');
  const uid = `m-${series.kind}`;

  const barH = (v: number, coverage: MonthCoverage) => (coverage === 'none' ? 0 : Math.round((v / max) * (H - 18)));

  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg width={Math.max(width, Number(120))} height={H + 30} role="img" aria-label={`${series.created_label} by month`} className="block">
        <defs>
          <Hatch id={`${uid}-ink`} color="var(--ink)" />
          <Hatch id={`${uid}-accent`} color="var(--accent)" />
        </defs>
        {/* The baseline. A month with no bar still has a floor, so the gap reads as a gap. */}
        <line x1="0" y1={H} x2={width - GAP} y2={H} stroke="var(--line)" strokeWidth="1" />
        {firstCovered > 0 && (
          <g>
            <line
              x1={firstCovered * (BAR + GAP) - GAP / 2}
              y1="2"
              x2={firstCovered * (BAR + GAP) - GAP / 2}
              y2={H}
              stroke="var(--degraded)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text x={firstCovered * (BAR + GAP) - GAP / 2 + 4} y="11" fontSize="9.5" fill="var(--degraded)">
              recording starts
            </text>
          </g>
        )}
        {months.map((m, i) => {
          const x = i * (BAR + GAP);
          const on = selected === m.month;
          const half = showAdvanced ? Math.round(BAR / 2) - 1 : BAR;
          const createdH = barH(m.created, m.coverage);
          const advancedH = barH(m.advanced, m.advanced_coverage);
          return (
            <g key={m.month} className="cursor-pointer" onClick={() => onSelect(on ? null : m.month)}>
              {/* The whole column is the hit area, so an empty month is still selectable. */}
              <rect x={x - GAP / 2} y="0" width={BAR + GAP} height={H + 30} fill={on ? 'var(--hover)' : 'transparent'} />
              {m.coverage === 'none' ? (
                <line x1={x} y1={H - 1} x2={x + BAR} y2={H - 1} stroke="var(--faint)" strokeWidth="2" strokeDasharray="2 2" />
              ) : (
                <rect
                  x={x}
                  y={H - createdH}
                  width={half}
                  height={createdH}
                  rx="2"
                  fill={m.coverage === 'partial' ? `url(#${uid}-ink)` : 'var(--ink)'}
                  opacity={m.coverage === 'partial' ? 0.85 : 1}
                />
              )}
              {showAdvanced && m.advanced_coverage !== 'none' && (
                <rect
                  x={x + half + 2}
                  y={H - advancedH}
                  width={half}
                  height={advancedH}
                  rx="2"
                  fill={m.advanced_coverage === 'partial' ? `url(#${uid}-accent)` : 'var(--accent)'}
                  opacity={m.advanced_coverage === 'partial' ? 0.85 : 1}
                />
              )}
              <text x={x + BAR / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={on ? 'var(--ink)' : 'var(--faint)'}>
                {m.label}
              </text>
              {/* A caret marks a month the figures are known not to cover fully. */}
              {m.coverage !== 'full' && (
                <text x={x + BAR / 2} y={H + 25} textAnchor="middle" fontSize="9" fill="var(--degraded)">
                  {m.coverage === 'none' ? 'none' : 'part'}
                </text>
              )}
              <title>
                {m.coverage === 'none'
                  ? `${m.label}: nothing was recording. ${m.note ?? ''}`
                  : `${m.label}: ${m.created} ${series.created_label.toLowerCase()}${showAdvanced && m.advanced_coverage !== 'none' ? `, ${m.advanced} ${series.advanced_label?.toLowerCase()}` : ''}${m.note ? ` — ${m.note}` : ''}`}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Legend({ series }: { series: MonthlySeries }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-ink" /> {series.created_label.toLowerCase()}
      </span>
      {series.advanced_label && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-accent" /> {series.advanced_label.toLowerCase()}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-degraded bg-transparent" /> hatched = the month is only partly covered
      </span>
    </div>
  );
}

/** The month currently in view, as three figures. */
function Summary({ series, point }: { series: MonthlySeries; point: MonthPoint | undefined }) {
  if (!point) return null;
  const cells: { label: string; value: ReactNode; note: string | null }[] = [
    {
      label: series.created_label,
      value: point.coverage === 'none' ? '—' : point.created,
      note: point.coverage === 'none' ? 'nothing was recording this month' : `from ${series.created_field}`,
    },
  ];
  if (series.advanced_label) {
    cells.push({
      label: series.advanced_label,
      value: point.advanced_coverage === 'none' ? '—' : point.advanced,
      note: point.advanced_coverage === 'none' ? 'not dated this far back' : series.advanced_field,
    });
  }
  if (series.rate_label) {
    cells.push({
      label: series.rate_label,
      value: pct(point.rate),
      note: point.rate === null ? 'the rows cannot support a rate for this month' : null,
    });
  }
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0">
          <div className="kicker truncate">{c.label}</div>
          <div className="font-display tabular mt-1 text-[24px] leading-none text-ink">{c.value}</div>
          {c.note && <div className="mt-1 text-[11px] leading-snug text-faint">{c.note}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * The tracking panel.
 *
 * `rows` and `columns` are what the CSV writes: the page hands over the rows it
 * is actually showing, so the export and the screen cannot disagree.
 */
export function MonthlyPanel<T>({
  series,
  selected,
  onSelect,
  rows,
  columns,
  csvLabel,
}: {
  series: MonthlySeries;
  selected: string | null;
  onSelect: (month: string | null) => void;
  rows: T[];
  columns: CsvColumn<T>[];
  csvLabel?: string;
}) {
  const shown = selected ?? series.current;
  const point = series.months.find((m) => m.month === shown);
  const boundary = series.boundary;
  const gaps = series.months.filter((m) => m.coverage === 'none' || m.advanced_coverage === 'none');
  const partials = series.months.filter((m) => m.coverage === 'partial' && m.note);

  return (
    <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <MetricCard
        title={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{shown === series.current && !selected ? 'This month' : 'Selected month'}</span>
            <span className="tabular text-[11.5px] font-normal text-faint">{shown}</span>
          </span>
        }
        right={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => downloadCsv(csvName(csvLabel ?? series.kind, selected), toCsv(rows, columns))}
            title="Exports the rows this page is showing, with every filter and the month selection applied"
          >
            Export CSV
          </button>
        }
        note={
          selected
            ? `The list below is filtered to ${shown}. ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} in view, and the export carries exactly those.`
            : `The list below is not filtered by month. ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} in view, and the export carries exactly those.`
        }
      >
        {point ? <Summary series={series} point={point} /> : <EmptyPanel>No month holds anything yet.</EmptyPanel>}
        {point?.note && <p className="mt-3 text-[11.5px] leading-snug text-degraded">{point.note}</p>}
      </MetricCard>

      <MetricCard
        title="Month over month"
        right={selected ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(null)}>Clear month</button> : undefined}
        note={
          <span className="space-y-1 block">
            <Legend series={series} />
            {boundary && <span className="block text-[11px] leading-snug text-degraded">{boundary.note}</span>}
            {!boundary && partials.length > 0 && <span className="block text-[11px] leading-snug text-degraded">{partials[partials.length - 1].note}</span>}
            {series.undated.n > 0 && <span className="block text-[11px] leading-snug text-faint">{series.undated.note}</span>}
          </span>
        }
      >
        {series.months.length === 0 ? (
          <EmptyPanel>Nothing is dated yet, so there is no month to draw.</EmptyPanel>
        ) : (
          <MonthChart series={series} selected={selected} onSelect={onSelect} />
        )}
        {gaps.length > 0 && (
          <p className="mt-2 text-[11px] leading-snug text-faint">
            {gaps.length} {gaps.length === 1 ? 'month is' : 'months are'} drawn without a bar because nothing was recording then. That is a gap in instrumentation, not a month in which nothing
            happened.
          </p>
        )}
      </MetricCard>
    </div>
  );
}

/**
 * The second metric where a page has one with its own, later boundary — Codex's
 * median days to approval. Months before its boundary draw nothing at all.
 */
export function SecondaryMonthly({ series }: { series: MonthlySeries }) {
  const s = series.secondary;
  if (!s) return null;
  const drawn = s.points.filter((p) => p.coverage !== 'none');
  const max = Math.max(1, ...drawn.map((p) => p.value ?? 0));
  const any = drawn.some((p) => p.value !== null);
  return (
    <div className="mx-6 mb-4 md:mx-8">
      <MetricCard title={s.label} note={<span className="block text-[11px] leading-snug text-degraded">{s.boundary.note}</span>}>
        {!any ? (
          <EmptyPanel>{s.note}</EmptyPanel>
        ) : (
          <div className="space-y-2">
            {drawn.map((p) => (
              <div key={p.month} className="flex items-center gap-3 text-[12px]">
                <span className="w-12 shrink-0 text-faint">{p.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                  <span
                    className={`block h-full rounded-full ${p.coverage === 'partial' ? 'bg-degraded' : 'bg-accent'}`}
                    style={{ width: `${Math.round(((p.value ?? 0) / max) * 100)}%` }}
                  />
                </span>
                <span className="tabular w-20 shrink-0 text-right text-dim">
                  {p.value === null ? 'not recorded' : `${p.value} ${s.unit}`}
                </span>
                <span className="tabular w-16 shrink-0 text-right text-faint">{p.n ? `${p.n} logs` : ''}</span>
              </div>
            ))}
          </div>
        )}
        {any && <p className="mt-2 text-[11px] leading-snug text-faint">{s.note}</p>}
      </MetricCard>
    </div>
  );
}
