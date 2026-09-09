import type { LoopMetrics } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { Bars, CountCell, HBar, SeriesBlock, StatCell, StatStrip } from '../../components/ui';
import { ageTone } from '../../lib';

/**
 * The figures across the top of Open loops. Three counts that run up on
 * load, then the derived measures. Each derived measure is either a number
 * the rows support or the sentence saying why they do not — the loop tables
 * carry no close date and no last-modified time, and that decides most of
 * them. Nothing here is estimated.
 */
export function LoopMetricsPanel({ metrics, loading, error, onPick }: { metrics: LoopMetrics | null; loading: boolean; error: string | null; onPick: (loopId: string) => void }) {
  if (error) return <div className="card mx-6 mb-4 px-5 py-4 text-[12.5px] text-failing md:mx-8">Figures unavailable: {error}</div>;
  if (!metrics) {
    return (
      <StatStrip cols={3} className="opacity-60">
        {['Open', 'In progress', 'Closed'].map((l) => (
          <StatCell key={l}>
            <div className="kicker">{l}</div>
            <div className="mt-1 text-[15px] text-faint">Counting</div>
          </StatCell>
        ))}
      </StatStrip>
    );
  }
  const m = metrics;
  const maxRate = Math.max(1, ...m.close_rate_by_builder.map((o) => o.rate ?? 0));
  const oldest = m.oldest_open;
  const dist = m.age_distribution;

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <StatStrip cols={3}>
        <CountCell label="Open" value={m.open} tone="accent" hint={m.scope.builder ? `In ${BUILDER_NAMES[m.scope.builder] ?? m.scope.builder}’s table` : `Across ${m.scope.rows} loops in seven tables`} />
        <CountCell label="In progress" value={m.in_progress} />
        <CountCell label="Closed" value={m.closed} tone="dim" />
      </StatStrip>

      <div className="mx-6 mb-4 grid gap-4 md:mx-8 md:grid-cols-3">
        {/* Oldest open loop and the age distribution: the two the data supports fully. */}
        <div className="card px-5 py-4">
          <div className="kicker">Oldest open loop</div>
          {oldest.age_days === null ? (
            <div className="mt-1 text-[15px] text-faint">{oldest.note}</div>
          ) : (
            <>
              <div className={`font-display tabular mt-1 text-[28px] leading-none ${ageTone(oldest.age_days)}`}>{oldest.age_days}d</div>
              <button type="button" onClick={() => oldest.loop_id && onPick(oldest.loop_id)} className="mt-1.5 block truncate text-left text-[12px] text-dim hover:text-accent-ink" title="Find it in the table">
                {oldest.loop_id ?? oldest.id} · {oldest.owner ? BUILDER_NAMES[oldest.owner] ?? oldest.owner : ''}
              </button>
              {oldest.note && <div className="mt-1.5 text-[11.5px] leading-snug text-faint">{oldest.note}</div>}
            </>
          )}
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Age of what is open</div>
          <Bars values={dist.map((d) => d.n)} labels={dist.map((d) => d.bucket)} height={44} tone="ink" highlightLast={false} />
          <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-0.5 text-[10.5px] text-faint">
            {dist.map((d) => (
              <span key={d.bucket} className="tabular truncate">
                {d.bucket} <span className="text-dim">{d.n}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="card px-5 py-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Close rate by builder</div>
          {m.close_rate_by_builder.length === 0 ? (
            <div className="text-[12px] text-faint">No loops.</div>
          ) : (
            <div className="space-y-1.5">
              {m.close_rate_by_builder.map((o) => (
                <HBar key={o.owner} label={BUILDER_NAMES[o.owner] ?? o.owner} value={o.rate ?? 0} max={maxRate} suffix="%" right={<span className="text-faint">{o.closed}/{o.total}</span>} />
              ))}
            </div>
          )}
          <div className="mt-2 text-[11.5px] leading-snug text-faint">{m.close_rate_note}</div>
        </div>

        <div className="card px-5 py-4">
          <SeriesBlock title="Raised per week" series={m.raised_per_week} tone="accent" total />
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Closed per day" series={m.closed_per_day} tone="ink" total />
        </div>
        <div className="card px-5 py-4">
          <SeriesBlock title="Net raised vs closed per week" series={m.net_per_week} />
        </div>

        <div className="card px-5 py-4 md:col-span-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div className="text-[13px] font-medium text-ink">Stale — no status change in fourteen days</div>
            {m.stale.count === null ? <span className="text-[13px] text-faint">Not recorded</span> : <span className="font-display tabular text-[20px] text-degraded">{m.stale.count}</span>}
          </div>
          <div className="mt-1 text-[11.5px] leading-snug text-faint">{m.stale.note}</div>
        </div>
      </div>
    </div>
  );
}
