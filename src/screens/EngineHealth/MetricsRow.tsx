import type { EngineHealthData } from '../../data';
import { Stat, StatCell, StatStrip } from '../../components/ui';
import { laneLabel } from '../../lib';

/** Self-healing metrics. Self-heal rate is the one value that matters here. */
export function MetricsRow({ data }: { data: EngineHealthData }) {
  const m = data.metrics;
  return (
    <StatStrip cols={6}>
      <StatCell>
        <Stat label="Self-heal rate" value={m.self_heal_rate} tone="accent" />
      </StatCell>
      <StatCell>
        <Stat label="Retries attempted" value={m.retries_attempted} />
      </StatCell>
      <StatCell>
        <Stat label="Retries succeeded" value={m.retries_succeeded} />
      </StatCell>
      <StatCell>
        <Stat label="Mean time to resolve" value={m.mean_time_to_resolve} />
      </StatCell>
      <StatCell>
        <Stat label="Escalations" value={m.escalations} tone={m.escalations ? 'degraded' : 'default'} />
      </StatCell>
      <StatCell>
        <div className="kicker">Lanes at retry ceiling</div>
        <div className="mt-2 text-[12.5px]">
          {data.lanes_at_retry_ceiling.length === 0 ? (
            <span className="text-dim">none</span>
          ) : (
            data.lanes_at_retry_ceiling.map((l) => (
              <span key={l.lane} className="tag tag-failing mr-1.5">
                {laneLabel(l.lane)} {l.incidents}
              </span>
            ))
          )}
        </div>
      </StatCell>
    </StatStrip>
  );
}
