import { useEffect, useRef, useState } from 'react';
import type { MonthCoverage, MonthlySeries } from '../../data';

/**
 * The month-over-month chart every statistics tab draws with.
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
 * Clicking a month puts it in view on the statistics tab it is drawn on, which
 * moves every figure and the export with it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BAR = 26;
const GAP = 12;
const H = 116;


/** The hatch a partial month is drawn with, defined once per chart instance. */
function Hatch({ id, color }: { id: string; color: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill={color} opacity="0.18" />
      <line x1="0" y1="0" x2="0" y2="5" stroke={color} strokeWidth="2.4" />
    </pattern>
  );
}

export function MonthChart({
  series,
  selected,
  onSelect,
  fill = false,
  readOnly = false,
}: {
  series: MonthlySeries;
  selected: string | null;
  onSelect: (month: string | null) => void;
  /**
   * Draw it, do not let anyone click it. The statistics tab chooses its month
   * in a picker; a chart that also set it would be a second control for one
   * selection with nothing saying which had been used.
   */
  readOnly?: boolean;
  /**
   * Widen the bars to fill the card, and print each month's figure above it.
   *
   * The statistics tab gives this chart a whole row to itself, and three months
   * of 26px bars in a 1500px card is ten pixels of content in a hundred-pixel
   * card — the thing section 5 calls a bug. Bars grow to fill the width and
   * stop at 90px, so a year of months still reads and still scrolls.
   */
  fill?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    if (!fill || !box.current) return;
    const el = box.current;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  const months = series.months;
  const max = Math.max(1, ...months.map((m) => Math.max(m.created, m.advanced)));
  const showAdvanced = series.advanced_label !== null;
  // Fill the card where asked, but never below the fixed size and never past
  // 90px — a bar wider than that stops reading as a bar.
  const bar = fill && avail > 0 ? Math.max(BAR, Math.min(90, Math.floor(avail / Math.max(1, months.length)) - GAP)) : BAR;
  const width = months.length * (bar + GAP);
  // The first month with anything recorded, so the boundary rule sits on its edge.
  const firstCovered = months.findIndex((m) => m.coverage !== 'none');
  const uid = `m-${series.kind}`;
  const TOP = fill ? 16 : 0;

  const barH = (v: number, coverage: MonthCoverage) => (coverage === 'none' ? 0 : Math.round((v / max) * (H - 18 - TOP)));

  return (
    <div ref={box} className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg width={Math.max(width, Number(120))} height={H + 30} role="img" aria-label={`${series.created_label} by month`} className="block">
        <defs>
          <Hatch id={`${uid}-ink`} color="var(--ink)" />
          <Hatch id={`${uid}-accent`} color="var(--accent)" />
        </defs>
        {/* The baseline. A month with no bar still has a floor, so the gap reads as a gap. */}
        <line x1="0" y1={H} x2={width - GAP} y2={H} stroke="var(--line)" strokeWidth="1" />
        {/*
          `bar`, not `BAR`: the bars widen to fill the card, and the boundary
          rule has to land on the same grid they do. It was drawn against the
          fixed width, so on a filled chart it pointed at the wrong month.
        */}
        {firstCovered > 0 && (
          <g>
            <line x1={firstCovered * (bar + GAP) - GAP / 2} y1="2" x2={firstCovered * (bar + GAP) - GAP / 2} y2={H} stroke="var(--degraded)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={firstCovered * (bar + GAP) - GAP / 2 + 4} y="11" fontSize="9.5" fill="var(--degraded)">
              recording starts
            </text>
          </g>
        )}
        {months.map((m, i) => {
          const x = i * (bar + GAP);
          const on = selected === m.month;
          const half = showAdvanced ? Math.round(bar / 2) - 1 : bar;
          const createdH = barH(m.created, m.coverage);
          const advancedH = barH(m.advanced, m.advanced_coverage);
          return (
            <g key={m.month} className={readOnly ? undefined : 'cursor-pointer'} onClick={readOnly ? undefined : () => onSelect(on ? null : m.month)}>
              {/* The whole column is the hit area, so an empty month is still selectable. */}
              <rect x={x - GAP / 2} y="0" width={bar + GAP} height={H + 30} fill={!readOnly && on ? 'var(--hover)' : 'transparent'} />
              {m.coverage === 'none' ? (
                <line x1={x} y1={H - 1} x2={x + bar} y2={H - 1} stroke="var(--faint)" strokeWidth="2" strokeDasharray="2 2" />
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
              {/* The figure above its own bar, so the chart can be read without hovering. */}
              {fill && m.coverage !== 'none' && (
                <text x={x + bar / 2} y={H - Math.max(createdH, advancedH) - 5} textAnchor="middle" fontSize="10.5" fill="var(--dim)" className="tabular">
                  {m.created}
                  {showAdvanced && m.advanced_coverage !== 'none' ? ` · ${m.advanced}` : ''}
                </text>
              )}
              <text x={x + bar / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={on ? 'var(--ink)' : 'var(--faint)'}>
                {m.label}
              </text>
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

/**
 * The same months as a line rather than bars (2026-09-16, Destiny).
 *
 * A year of twelve months is a shape — rising, falling, a quiet summer — and
 * bars state twelve separate facts where a line states one trend. Both read the
 * same `MonthlySeries`, so the two views can never disagree; the switch is
 * which question you are asking of it.
 *
 * **A month with nothing recorded breaks the line.** It is not joined through
 * as though the value were nought, because that is the same lie the bar chart
 * refuses to tell — the line stops and picks up again on the far side.
 */
export function LineChart({ series, height = 132 }: { series: MonthlySeries; height?: number }) {
  const months = series.months;
  const showAdvanced = series.advanced_label !== null;
  const max = Math.max(1, ...months.map((m) => Math.max(m.created, m.advanced)));
  // Wide enough that a calendar year fills the card it is given; more than
  // that and the row scrolls inside itself, like the bar chart.
  const W = 96;
  const width = Math.max(months.length * W, 120);
  const H = height;
  const x = (i: number) => i * W + W / 2;
  const y = (v: number) => H - 18 - Math.round((v / max) * (H - 34));

  // One path per unbroken run of covered months.
  const runs = (pick: (m: (typeof months)[number]) => number, covered: (m: (typeof months)[number]) => boolean) => {
    const out: { i: number; v: number }[][] = [];
    let run: { i: number; v: number }[] = [];
    months.forEach((m, i) => {
      if (covered(m)) run.push({ i, v: pick(m) });
      else if (run.length) {
        out.push(run);
        run = [];
      }
    });
    if (run.length) out.push(run);
    return out;
  };
  const path = (pts: { i: number; v: number }[]) => pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join(' ');

  const createdRuns = runs((m) => m.created, (m) => m.coverage !== 'none');
  const advancedRuns = showAdvanced ? runs((m) => m.advanced, (m) => m.advanced_coverage !== 'none') : [];

  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg width={width} height={H} role="img" aria-label={`${series.created_label} by month`} className="block">
        <line x1="0" y1={H - 18} x2={width} y2={H - 18} stroke="var(--line)" strokeWidth="1" />
        {advancedRuns.map((r, k) => (
          <path key={`a${k}`} d={path(r)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {createdRuns.map((r, k) => (
          <path key={`c${k}`} d={path(r)} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {months.map((m, i) => (
          <g key={m.month}>
            {m.coverage !== 'none' && <circle cx={x(i)} cy={y(m.created)} r="2.6" fill="var(--ink)" />}
            {showAdvanced && m.advanced_coverage !== 'none' && <circle cx={x(i)} cy={y(m.advanced)} r="2.6" fill="var(--accent)" />}
            <text x={x(i)} y={H - 5} textAnchor="middle" fontSize="10" fill="var(--faint)">
              {m.label}
            </text>
            <title>
              {m.coverage === 'none'
                ? `${m.label}: nothing recorded. ${m.note ?? ''}`
                : `${m.label}: ${m.created} ${series.created_label.toLowerCase()}${showAdvanced && m.advanced_coverage !== 'none' ? `, ${m.advanced} ${series.advanced_label?.toLowerCase()}` : ''}`}
            </title>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Legend({ series }: { series: MonthlySeries }) {
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
        <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-degraded bg-transparent" /> hatched = only partly covered · no bar = nothing recorded
      </span>
    </div>
  );
}

/**
 * A calendar year of a `MonthlySeries`: every month from January to December,
 * whether or not anything was recorded in it (2026-09-16, Destiny).
 *
 * The chart used to draw only the months held, so a year that started in August
 * was two columns wide and said nothing about the ten months before it. Twelve
 * columns say "this is the year, and this is the part of it we have" in one
 * look — which is the thing Destiny asked for a way to show.
 *
 * A month the series does not hold is given `coverage: 'none'`, so the bar
 * chart draws no bar and the line breaks. **An empty month and a month of
 * nought must not look the same**, and this is how they are kept apart without
 * a caption.
 */
export function yearOf(series: MonthlySeries, year: number): MonthlySeries {
  const held = new Map(series.months.map((m) => [m.month, m]));
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const there = held.get(key);
    if (there) return { ...there, label: MONTHS[i] };
    return {
      month: key,
      label: MONTHS[i],
      created: 0,
      advanced: 0,
      rate: null,
      coverage: 'none' as MonthCoverage,
      advanced_coverage: 'none' as MonthCoverage,
      note: 'Nothing is recorded for this month.',
      backfilled: 0,
      segments: null,
    };
  });
  return { ...series, months };
}

/** Every year the series holds a month for, plus the one after the last. */
export function yearsOf(series: MonthlySeries): number[] {
  const years = series.months.map((m) => Number(m.month.slice(0, 4))).filter((y) => Number.isFinite(y));
  const first = years.length ? Math.min(...years) : new Date().getFullYear();
  const last = Math.max(new Date().getFullYear(), ...(years.length ? years : [new Date().getFullYear()]));
  const out: number[] = [];
  // One year past the latest, so next January is selectable before it arrives.
  for (let y = first; y <= last + 1; y++) out.push(y);
  return out;
}

/*
 * `MonthlyPanel` and `SecondaryMonthly` stood here until 16 Sep 2026, when the
 * month in view, the month-over-month chart and the export moved onto each
 * page's statistics tab (Destiny). Nothing referenced them afterwards and dead
 * components drift, so they are deleted rather than left unread — they are in
 * git history. `MonthChart` and `Legend` above are what the statistics tab
 * draws with, which is why they are exported.
 */
