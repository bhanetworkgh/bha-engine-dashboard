import type { ReactNode } from 'react';
import type { Cohort, DurationWeek, OutcomeWeek, Percentiles, Share, Slice } from '../../data';
import { CountUp, TileFigure } from './CountUp';
import { HBar } from './Charts';
import { EmptyPanel } from './EmptyState';
import { MetricCard, StatCell } from './Card';
import { StatCaption, StatLabel } from './InfoTip';

/**
 * The figures the twins' pages are built out of.
 *
 * They exist because the same four rules have to hold on every card on both
 * pages, and four rules repeated across forty call sites is four rules that
 * drift:
 *
 *   - **A percentage always carries its denominator.** `Share` holds `n` and
 *     `of`, and `PercentCell` and `DistTile` both print "25 of 59" beside the
 *     rate. A rate over nought rows is not nought — it is unknown, and says so.
 *   - **No duration is ever a mean.** `Percentiles` is p50 and p95 and there is
 *     no component here that would draw an average.
 *   - **Zero is a real answer**, rendered as `0`. An empty state is the
 *     different statement "nothing recorded", and reads differently.
 *   - **Every card names what it excludes**, in the footnote the server writes.
 *
 * The anatomy is the one the Research Twin statistics page already had and
 * which was the best thing about it: title top-left, source field top-right, one
 * large figure, one plain-English line under it, the breakdown, then the
 * footnote on the floor of the card.
 */

/** A percentage with the count it came from, in the shape "42% · 25 of 59". */
export function Denominator({ share, unit = '' }: { share: Share; unit?: string }) {
  return (
    <span>
      {share.n} of {share.of}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

/**
 * A rate on the headline strip.
 *
 * `tone` is passed only where one direction is genuinely bad news — delivery
 * below 100%, a capped job above nought. Everything else stays neutral: a
 * column of colour on a page where almost everything succeeds is decoration,
 * and decoration that looks like a warning is worse than none.
 */
export function PercentCell({
  label,
  share,
  bad,
  hintMinLines = 4,
  caption,
}: {
  label: string;
  share: Share;
  /** Returns true where this value is the genuinely bad direction. */
  bad?: (share: Share) => boolean;
  hintMinLines?: number;
  /**
   * One line of at most 55 characters (2026-09-22). Given, the server's note
   * moves behind the label's info mark rather than sitting under the figure.
   */
  caption?: string;
}) {
  const isBad = share.pct !== null && bad?.(share);
  return (
    <StatCell>
      <div className="min-w-0">
        {caption ? <StatLabel label={label} detail={share.note} /> : <div className="kicker truncate">{label}</div>}
        {share.pct === null ? (
          <div className="mt-1 text-[15px] leading-tight text-faint">Not recorded</div>
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className={`font-display tabular text-[28px] leading-none ${isBad ? 'text-degraded' : 'text-ink'}`}>
              <CountUp value={share.pct} />
              <span className="ml-0.5 text-[13px] text-faint">%</span>
            </span>
            <span className="tabular text-[11.5px] text-dim">
              <Denominator share={share} />
            </span>
          </div>
        )}
        {caption ? (
          <StatCaption>{caption}</StatCaption>
        ) : (
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" style={{ minHeight: `${hintMinLines * 1.375}em` }}>
            {share.note}
          </div>
        )}
      </div>
    </StatCell>
  );
}

/** p50 with p95 beside it. Never a mean — the headline is the median and says so. */
export function PercentileCell({ label, p, unit, hintMinLines = 4, caption }: { label: string; p: Percentiles; unit: string; hintMinLines?: number; caption?: string }) {
  return (
    <StatCell>
      <div className="min-w-0">
        {caption ? <StatLabel label={label} detail={p.note} /> : <div className="kicker truncate">{label}</div>}
        {p.p50 === null ? (
          <div className="mt-1 text-[15px] leading-tight text-faint">Not recorded</div>
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display tabular text-[28px] leading-none text-ink">
              <CountUp value={p.p50} />
              <span className="ml-0.5 text-[13px] text-faint">{unit}</span>
            </span>
            <span className="tabular text-[11.5px] text-dim" title="The 95th percentile: the slow tail, which is what people actually feel">
              p95 {p.p95 === null ? '—' : `${p.p95}${unit}`}
            </span>
          </div>
        )}
        {caption ? (
          <StatCaption>{caption}</StatCaption>
        ) : (
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" style={{ minHeight: `${hintMinLines * 1.375}em` }}>
            {p.note}
          </div>
        )}
      </div>
    </StatCell>
  );
}

/** A plain count on the strip, with its own footnote held to the row's depth. */
export function FigureCell({ label, value, unit, note, tone, hintMinLines = 4, caption, missing }: { label: string; value: number | null; unit?: string; note: ReactNode; tone?: 'degraded' | 'dim'; hintMinLines?: number; caption?: string; /** What a null prints instead of "Not recorded". */ missing?: string }) {
  const toneClass = tone === 'degraded' ? 'text-degraded' : tone === 'dim' ? 'text-dim' : 'text-ink';
  return (
    <StatCell>
      <div className="min-w-0">
        {caption ? <StatLabel label={label} detail={note} /> : <div className="kicker truncate">{label}</div>}
        {value === null ? (
          <div className="mt-1 text-[15px] leading-tight text-faint">{missing ?? 'Not recorded'}</div>
        ) : (
          <div className={`font-display tabular mt-1 text-[28px] leading-none ${toneClass}`}>
            <CountUp value={value} />
            {unit && <span className="ml-0.5 text-[13px] text-faint">{unit}</span>}
          </div>
        )}
        {caption ? (
          <StatCaption>{caption}</StatCaption>
        ) : (
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint" style={{ minHeight: `${hintMinLines * 1.375}em` }}>
            {note}
          </div>
        )}
      </div>
    </StatCell>
  );
}

/**
 * A statistics card: one figure, the line under it, the bars it summarises, and
 * the footnote naming what it excludes.
 *
 * **The headline is derived from the bars underneath it**, never from anything
 * else, so a reader can check one against the other. Where there is no single
 * obvious figure the caller passes the largest share and names which — never a
 * value picked out by name in this code, because the vocabulary is Airtable's
 * to change.
 */
export function DistTile({
  title,
  field,
  note,
  slices,
  headline,
  format,
  sub,
  tone,
  missing,
  toneOf,
  limit = 8,
  children,
}: {
  title: string;
  field: string;
  note: ReactNode;
  slices: Slice[];
  /** The figure at the top. Null prints `missing` where the number would be. */
  headline: number | null;
  /**
   * How to render it. A share by default, because most of these headlines are
   * one; a card whose headline is a **count** passes a count formatter, because
   * a per-cent sign on a count is a wrong number rather than a stylistic slip.
   */
  format?: (n: number) => string;
  sub?: ReactNode;
  tone?: 'accent' | 'degraded' | 'failing';
  missing: string;
  /** Which bars read as a bad state. Only where one genuinely is. */
  toneOf?: (s: Slice) => 'accent' | 'degraded' | 'failing' | 'ink' | undefined;
  limit?: number;
  children?: ReactNode;
}) {
  const total = slices.reduce((n, s) => n + s.n, 0);
  const max = Math.max(1, ...slices.map((s) => s.n));
  return (
    <MetricCard title={title} right={field} note={note} noteMinLines={5} align="top">
      <TileFigure value={headline} format={format ?? ((n) => `${Math.round(n)}%`)} tone={tone} missing={missing} sub={sub} replayKey={`${title}|${total}`}>
        {slices.length === 0 ? null : (
          <div className="space-y-2">
            {slices.slice(0, limit).map((s) => (
              <HBar
                key={s.key}
                label={s.label}
                value={s.n}
                max={max}
                tone={toneOf?.(s) ?? 'ink'}
                valueNode={<CountUp value={s.n} />}
                right={<span className="text-faint">{total ? Math.round((s.n / total) * 100) : 0}%</span>}
              />
            ))}
          </div>
        )}
        {children}
      </TileFigure>
    </MetricCard>
  );
}

/**
 * A stacked column per week, one segment per outcome.
 *
 * A week with no asks is drawn as no bar rather than as a bar at nought: the
 * ledgers opened on 17 Sep 2026 and every week before that was not quiet, it
 * was not recorded.
 */
export function OutcomeColumns({ weeks, order, colour }: { weeks: OutcomeWeek[]; order: string[]; colour: (key: string) => string }) {
  const max = Math.max(1, ...weeks.map((w) => w.total));
  if (weeks.every((w) => w.total === 0)) return <EmptyPanel>No ask in the last eight weeks.</EmptyPanel>;
  return (
    <div>
      <div className="flex w-full items-end gap-[3px]" style={{ height: 72 }} role="img" aria-label="Outcome by week">
        {weeks.map((w) => (
          <div
            key={w.week}
            className="flex min-w-0 flex-1 flex-col justify-end self-stretch"
            title={w.total ? `${w.label}: ${order.map((o) => `${w.counts[o] ?? 0} ${o.toLowerCase()}`).join(', ')}` : `${w.label}: no ask recorded`}
          >
            <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${w.total ? Math.max((w.total / max) * 100, 6) : 0}%` }}>
              {order.map((o) => (
                <div key={o} style={{ height: `${w.total ? ((w.counts[o] ?? 0) / w.total) * 100 : 0}%`, background: colour(o), opacity: 0.88 }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-faint">
        <span>{weeks[0]?.label}</span>
        <span>{weeks[weeks.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/**
 * A duration trend: p50 as the bar, p95 as a tick above it. Never a mean.
 *
 * A week that recorded no duration has no bar and no tick — it is not a week of
 * nought seconds.
 */
export function DurationTrend({ weeks, unit }: { weeks: DurationWeek[]; unit: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.p95 ?? w.p50 ?? 0));
  if (weeks.every((w) => w.n === 0)) return <EmptyPanel>No run in the last eight weeks recorded a duration.</EmptyPanel>;
  return (
    <div>
      <div className="flex w-full items-end gap-[3px]" style={{ height: 64 }} role="img" aria-label="Response time by week">
        {weeks.map((w) => (
          <div
            key={w.week}
            className="relative flex min-w-0 flex-1 flex-col justify-end self-stretch"
            title={w.n ? `${w.label}: p50 ${w.p50}${unit}, p95 ${w.p95}${unit}, over ${w.n} ${w.n === 1 ? 'run' : 'runs'}` : `${w.label}: nothing recorded`}
          >
            {w.p95 !== null && (
              <div className="absolute inset-x-0" style={{ bottom: `${(w.p95 / max) * 100}%` }}>
                <div className="h-[2px] w-full rounded-full" style={{ background: 'var(--degraded)', opacity: 0.7 }} />
              </div>
            )}
            <div className="w-full rounded-[3px]" style={{ height: `${w.p50 !== null ? Math.max((w.p50 / max) * 100, 4) : 0}%`, background: 'var(--accent)', opacity: 0.8 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-faint">
        <span>{weeks[0]?.label}</span>
        <span>
          bar = p50 · rule = p95 · {weeks[weeks.length - 1]?.label}
        </span>
      </div>
    </div>
  );
}

/**
 * A cohort table: each caller or lane with its own rates rather than the
 * aggregate's.
 *
 * This is the card that catches a quietly failing path. An aggregate that mixes
 * an automated sweep with people asking in Slack will hide a failure in either,
 * and it hides it in the direction that looks healthy.
 */
export function CohortTable({ rows, externalLabel }: { rows: Cohort[]; externalLabel?: string }) {
  if (rows.length === 0) return <EmptyPanel>No ask is held, so no caller has one.</EmptyPanel>;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[10.5px] text-faint">
        <span>caller</span>
        <span className="text-right">asks</span>
        <span className="text-right">answered</span>
        <span className="text-right">{externalLabel ?? 'delivered'}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 text-[12.5px]">
          <span className="truncate text-ink" title={r.label}>
            {r.label}
          </span>
          <span className="tabular text-right text-dim">{r.asks}</span>
          <span className="tabular text-right text-dim" title={`${r.answered} of ${r.asks}`}>
            {pct(r.answered, r.asks)}
          </span>
          <span
            className={`tabular text-right ${externalLabel ? 'text-dim' : r.delivered < r.asks ? 'text-degraded' : 'text-dim'}`}
            title={externalLabel ? `${r.external ?? 0} of ${r.asks} went outside BHA` : `${r.delivered} of ${r.asks} reached someone`}
          >
            {externalLabel ? pct(r.external ?? 0, r.asks) : pct(r.delivered, r.asks)}
          </span>
        </div>
      ))}
    </div>
  );
}
