import type { LoopMetrics } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { Bars, CountCell, CountUp, HBar, SeriesBlock, StatCell, StatStrip } from '../../components/ui';
import { laneLabel } from '../../lib';

/**
 * The figures across the top of Open loops. Three counts, then the derived
 * measures. Every number here is either something the rows support or a
 * sentence saying why they do not; the two measures that read last_modified
 * carry the field's caveat, because it was added on 9 Sept 2026 and every
 * loop stamps from that day. Everything re-animates when `view` changes.
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
  const dist = m.age_distribution;
  const maxLane = Math.max(1, ...m.open_by_lane_tag.map((l) => l.n));
  const maxRaiser = Math.max(1, ...m.top_raisers.map((r) => r.n));
  const notYet = m.stale.count !== null && new Date().toISOString().slice(0, 10) < m.stale.meaningful_from;

  return (
    <div className={dim ? 'opacity-50 transition-opacity duration-200' : 'transition-opacity duration-200'} aria-busy={dim}>
      <StatStrip cols={3}>
        <CountCell label="Open" value={m.open} tone="accent" replayKey={view} hint={m.scope.builder ? `In ${BUILDER_NAMES[m.scope.builder] ?? m.scope.builder}’s table` : `Across ${m.scope.rows} loops in seven tables`} />
        <CountCell label="In progress" value={m.in_progress} replayKey={view} />
        <CountCell label="Closed" value={m.closed} tone="dim" replayKey={view} />
      </StatStrip>

      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-3">
        <div className="card px-5 py-4">
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <div className="text-[13px] font-medium text-ink">Age of what is open</div>
            <div className="text-[10.5px] text-faint">newest → oldest</div>
          </div>
          <Bars values={dist.map((d) => d.n)} labels={dist.map((d) => d.bucket)} height={52} tone="ink" highlightLast={false} replayKey={view} showLabels />
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Close rate by builder</div>
          {m.close_rate_by_builder.length === 0 ? (
            <div className="text-[12px] text-faint">No loops.</div>
          ) : (
            <div className="space-y-1.5">
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
          <div className="mt-2 text-[11.5px] leading-snug text-faint">{m.close_rate_note}</div>
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Open loops by lane tag</div>
          {m.open_by_lane_tag.length === 0 ? (
            <div className="text-[12px] text-faint">No open loops.</div>
          ) : (
            <div className="space-y-1.5">
              {m.open_by_lane_tag.map((l) => (
                <HBar key={l.lane_tag} label={l.lane_tag.startsWith('(') ? l.lane_tag : laneLabel(l.lane_tag)} value={l.n} max={maxLane} replayKey={view} valueNode={<CountUp value={l.n} replayKey={view} />} />
              ))}
            </div>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">From each loop’s lane_tag as set in its table; “(no lane_tag)” is the count with none.</div>
        </div>

        <div className="card px-5 py-4">
          <SeriesBlock title="Raised per week" series={m.raised_per_week} tone="accent" total replayKey={view} />
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Closed per week" series={m.closed_per_week} tone="ink" total replayKey={view} />
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Net raised vs closed per week" series={m.net_per_week} tone="ink" replayKey={view} />
        </div>

        <div className="card px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className="text-[13px] font-medium text-ink">Stale — no change in fourteen days</div>
            {m.stale.count === null ? (
              <span className="text-[13px] text-faint">Not recorded</span>
            ) : (
              <span className={`font-display tabular text-[22px] leading-none ${notYet ? 'text-faint' : m.stale.count ? 'text-degraded' : 'text-ink'}`}>
                <CountUp value={m.stale.count} replayKey={view} />
              </span>
            )}
            {notYet && <span className="text-[11.5px] text-faint">not yet meaningful — from {m.stale.meaningful_from}</span>}
          </div>
          <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{m.stale.note}</div>
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Who raises loops</div>
          {m.top_raisers.length === 0 ? (
            <div className="text-[12px] text-faint">No Raised By recorded.</div>
          ) : (
            <div className="space-y-1.5">
              {m.top_raisers.map((r) => (
                <HBar key={r.raised_by} label={r.raised_by} value={r.n} max={maxRaiser} replayKey={view} valueNode={<CountUp value={r.n} replayKey={view} />} />
              ))}
            </div>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">Raised By as written on each loop, so “Jason” and “Jason Bays” count separately.</div>
        </div>

        <div className="card px-5 py-4">
          <SeriesBlock title="Closed per day" series={m.closed_per_day} tone="ink" total replayKey={view} />
        </div>
      </div>
    </div>
  );
}
