import type { LoopMetrics } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { CountCell, CountUp, EmptyPanel, HBar, MetricCard, SeriesBlock, StatCell, StatStrip } from '../../components/ui';

/**
 * The figures across the top of Open loops. Three counts, then the derived
 * measures. Every number here is either something the rows support or a
 * sentence saying why they do not; the two measures that read last_modified
 * carry the field's caveat, because it was added on 9 Sept 2026 and every
 * loop stamps from that day. Everything re-animates when `view` changes.
 *
 * The cards are laid out so each one fills its own height rather than holding
 * a line of text in the middle of a tall empty box: MetricCard grows its body
 * and pins its footnote to the floor, so a row of cards lines up.
 */
export function LoopMetricsPanel({ metrics, loading, switching, error, view }: { metrics: LoopMetrics | null; loading: boolean; switching: boolean; error: string | null; view: string }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
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
  const m = metrics;
  const dim = loading || switching;
  const maxRate = Math.max(1, ...m.close_rate_by_builder.map((o) => o.rate ?? 0));
  const maxRaiser = Math.max(1, ...m.top_raisers.map((r) => r.n));
  // "Age of what is open" is a share of the open loops, so it reads in the same
  // language as close rate: count over total, then the percentage.
  const openTotal = m.age_distribution.reduce((n, d) => n + d.n, 0);
  const notYet = m.stale.count !== null && new Date().toISOString().slice(0, 10) < m.stale.meaningful_from;

  return (
    <div className={dim ? 'opacity-50 transition-opacity duration-200' : 'transition-opacity duration-200'} aria-busy={dim}>
      <StatStrip cols={3}>
        <CountCell label="Open" value={m.open} tone="accent" replayKey={view} hint={m.scope.builder ? `In ${BUILDER_NAMES[m.scope.builder] ?? m.scope.builder}’s table` : `Across ${m.scope.rows} loops in seven tables`} />
        <CountCell label="In progress" value={m.in_progress} replayKey={view} />
        <CountCell label="Closed" value={m.closed} tone="dim" replayKey={view} />
      </StatStrip>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-2">
        {/*
          Age of what is open, in the same visual language as Close rate by
          builder: a labelled horizontal bar per bucket, its count over the
          total, then the percentage. It was a row of unlabelled vertical bars,
          which said nothing a reader could act on.
        */}
        <MetricCard
          title="Age of what is open"
          right="newest → oldest"
          note={`Open and in-progress loops by days since Date Raised, as a share of the ${openTotal} currently open. “No date raised” is the count with no Date Raised on the row.`}
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

        {/* The reference design for this page. */}
        <MetricCard title="Close rate by builder" note={m.close_rate_note}>
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
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Raised per week">
          <SeriesBlock title="" series={m.raised_per_week} tone="accent" total replayKey={view} bare />
        </MetricCard>
        <MetricCard title="Closed per week">
          <SeriesBlock title="" series={m.closed_per_week} tone="ink" total replayKey={view} bare />
        </MetricCard>
        <MetricCard title="Net raised vs closed per week">
          <SeriesBlock title="" series={m.net_per_week} tone="ink" replayKey={view} bare />
        </MetricCard>
      </div>

      <div className="mx-6 mb-4 grid items-stretch gap-4 md:mx-8 md:grid-cols-3">
        <MetricCard title="Still no change in fourteen days" note={m.stale.note}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {m.stale.count === null ? (
              <span className="text-[13px] text-faint">Not recorded</span>
            ) : (
              <span className={`font-display tabular text-[34px] leading-none ${notYet ? 'text-faint' : m.stale.count ? 'text-degraded' : 'text-ink'}`}>
                <CountUp value={m.stale.count} replayKey={view} />
              </span>
            )}
            {notYet && <span className="text-[11.5px] text-faint">not yet meaningful — from {m.stale.meaningful_from}</span>}
          </div>
        </MetricCard>

        <MetricCard title="Who raises loops" note={m.top_raisers_note}>
          {m.top_raisers.length === 0 ? (
            <EmptyPanel>No loop records who raised it.</EmptyPanel>
          ) : (
            <div className="space-y-2">
              {m.top_raisers.map((r) => (
                <HBar
                  key={r.key}
                  label={
                    <span title={r.variants.length > 1 ? `Written as ${r.variants.join(', ')}` : undefined}>
                      {r.label}
                      {r.variants.length > 1 && <span className="ml-1.5 text-[10.5px] text-faint">{r.variants.length} spellings</span>}
                    </span>
                  }
                  value={r.n}
                  max={maxRaiser}
                  replayKey={view}
                  valueNode={<CountUp value={r.n} replayKey={view} />}
                />
              ))}
            </div>
          )}
        </MetricCard>

        <MetricCard title="Closed per day">
          <SeriesBlock title="" series={m.closed_per_day} tone="ink" total replayKey={view} bare />
        </MetricCard>
      </div>
    </div>
  );
}
