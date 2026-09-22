import type { LoopMetrics } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { LOOP_STATUS_DEFS } from './definitions';
import { CountCell, CountUp, EmptyPanel, HBar, MetricCard, StatCell, StatStrip } from '../../components/ui';

/**
 * The figures across the top of Open loops. Three counts, then close rate and
 * age side by side, then the four time series as one set. Every number here is
 * either something the rows support or a sentence saying why they do not; the
 * two measures that read last_modified carry the field's caveat, because it
 * was added on 9 Sept 2026 and every loop stamps from that day. Everything
 * re-animates when `view` changes.
 *
 * The cards are laid out so each one fills its own height rather than holding
 * a line of text in the middle of a tall empty box: MetricCard grows its body
 * and pins its footnote to the floor, so a row of cards lines up.
 */
/**
 * Where the loops in view stand: open, in progress, closed.
 *
 * **It follows the month and the builder, like everything else on the page**
 * (2026-09-16, Destiny — replacing the all-time strip of earlier the same day).
 * All-time was defensible on its own but it did not reconcile with anything
 * around it: 602 open above a statistics tab reporting 627 raised in August
 * reads as two answers to one question, and a reader cannot tell which is
 * wrong. Three figures that sum to the month's own total can be checked against
 * the tabs beside them.
 *
 * **The all-time view did not go away** — it is "All time" in the month picker,
 * which scopes the whole page at once rather than one strip.
 */
export function LoopStatusStrip({ metrics, view, loading }: { metrics: LoopMetrics | null; view: string; loading?: boolean }) {
  if (!metrics) {
    return (
      <StatStrip cols={3} className="opacity-60">
        {['Open', 'In progress', 'Closed'].map((l) => (
          <StatCell key={l}>
            <div className="kicker">{l}</div>
            <div className="mt-1 text-[15px] text-faint">{loading ? 'Counting' : 'No figures for this table'}</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const total = metrics.open + metrics.in_progress + metrics.closed;
  /**
   * One caption line per figure (2026-09-22, the caption rule): the share of
   * the loops in view, which the three sum to. The explanation that used to sit
   * under Open is behind the mark, word for word, with each word's definition
   * from definitions.ts beside it.
   */
  const of = metrics.scope.builder ? `of ${total} in ${BUILDER_NAMES[metrics.scope.builder] ?? metrics.scope.builder}’s table` : `of ${total} in view`;
  return (
    <StatStrip cols={3}>
      <CountCell
        label="Open"
        value={metrics.open}
        tone="accent"
        replayKey={view}
        caption={of}
        hint={
          <>
            {metrics.scope.builder
              ? `Of the ${total} in ${BUILDER_NAMES[metrics.scope.builder] ?? metrics.scope.builder}’s table`
              : `Of the ${total} in view. Open + in progress + closed = ${total}.`}{' '}
            {LOOP_STATUS_DEFS.open}
          </>
        }
      />
      <CountCell label="In progress" value={metrics.in_progress} replayKey={view} caption={of} hint={LOOP_STATUS_DEFS['in progress']} />
      <CountCell label="Closed" value={metrics.closed} tone="dim" replayKey={view} caption={of} hint={LOOP_STATUS_DEFS.closed} />
    </StatStrip>
  );
}

/*
 * `LoopSeriesTiles` — raised per week, closed per week, net raised vs closed
 * and closed per day — stood here until 16 Sep 2026, when Destiny cut the
 * statistics tab to the five figures that answer the month: raised, closed,
 * close rate, average time to close and average age still open. Four weekly
 * charts among them were a second question in the same grid. Deleted rather
 * than left unread; they are in git history, and the series they drew are
 * still computed in `loopMetricsFor`.
 */

export function LoopMetricsPanel({ metrics, loading, switching, error, view }: { metrics: LoopMetrics | null; loading: boolean; switching: boolean; error: string | null; view: string }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) return null;
  const m = metrics;
  const dim = loading || switching;
  const maxRate = Math.max(1, ...m.close_rate_by_builder.map((o) => o.rate ?? 0));
  // The age card is a share of the open loops, so it reads in the same language
  // as close rate beside it: count over total, then the percentage.
  const openTotal = m.age_distribution.reduce((n, d) => n + d.n, 0);

  return (
    <div className={dim ? 'opacity-50 transition-opacity duration-200' : 'transition-opacity duration-200'} aria-busy={dim}>
      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        {/* The reference design for this page. */}
        <MetricCard title="Close rate by builder" align="top" note={m.close_rate_note}>
          {m.close_rate_by_builder.length === 0 ? (
            <EmptyPanel>No loops in this table.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.close_rate_by_builder.map((o) => (
                <HBar
                  key={o.owner}
                  label={BUILDER_NAMES[o.owner] ?? o.owner}
                  value={o.rate ?? 0}
                  max={maxRate}
                  suffix="%"
                  replayKey={view}
                  valueNode={<CountUp value={o.rate ?? 0} replayKey={view} />}
                  right={
                    <span className="text-faint">
                      {o.closed}/{o.total}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </MetricCard>
        {/*
          The same visual language as Close rate by builder beside it: a
          labelled horizontal bar per bucket, its count over the total, then the
          percentage. It was a row of unlabelled vertical bars, which said
          nothing a reader could act on.
        */}
        <MetricCard
          title="How long these have been sitting"
          align="top"
          right="newest → oldest"
          note={`Open and in-progress loops by days since Date Raised, as a share of the ${openTotal} open in view. “No date raised” is the count with no Date Raised on the row.`}
        >
          {openTotal === 0 ? (
            <EmptyPanel>Nothing is open in this table, so there is no age to distribute.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.age_distribution.map((d) => (
                <HBar
                  key={d.bucket}
                  label={d.bucket}
                  value={openTotal ? Math.round((d.n / openTotal) * 100) : 0}
                  max={100}
                  suffix="%"
                  replayKey={view}
                  valueNode={<CountUp value={openTotal ? Math.round((d.n / openTotal) * 100) : 0} replayKey={view} />}
                  right={
                    <span className="text-faint">
                      {d.n}/{openTotal}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </MetricCard>

      </div>

    </div>
  );
}
