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
}: {
  series: MonthlySeries;
  selected: string | null;
  onSelect: (month: string | null) => void;
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
          const x = i * (bar + GAP);
          const on = selected === m.month;
          const half = showAdvanced ? Math.round(bar / 2) - 1 : bar;
          const createdH = barH(m.created, m.coverage);
          const advancedH = barH(m.advanced, m.advanced_coverage);
          return (
            <g key={m.month} className="cursor-pointer" onClick={() => onSelect(on ? null : m.month)}>
              {/* The whole column is the hit area, so an empty month is still selectable. */}
              <rect x={x - GAP / 2} y="0" width={bar + GAP} height={H + 30} fill={on ? 'var(--hover)' : 'transparent'} />
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
              {/* A caret marks a month the figures are known not to cover fully. */}
              {m.coverage !== 'full' && (
                <text x={x + bar / 2} y={H + 25} textAnchor="middle" fontSize="9" fill="var(--degraded)">
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
        <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-degraded bg-transparent" /> hatched = the month is only partly covered
      </span>
    </div>
  );
}

/*
 * `MonthlyPanel` and `SecondaryMonthly` stood here until 16 Sep 2026, when the
 * month in view, the month-over-month chart and the export moved onto each
 * page's statistics tab (Destiny). Nothing referenced them afterwards and dead
 * components drift, so they are deleted rather than left unread — they are in
 * git history. `MonthChart` and `Legend` above are what the statistics tab
 * draws with, which is why they are exported.
 */
