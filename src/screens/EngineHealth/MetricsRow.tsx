import type { EngineHealthData } from '../../data';
import { laneLabel } from '../../lib';

/** Self-healing metrics. Self-heal rate is the one value that matters here. */
export function MetricsRow({ data }: { data: EngineHealthData }) {
  const m = data.metrics;
  return (
      <div className="grid shrink-0 grid-cols-2 border-b border-line md:grid-cols-6">
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Self-heal rate</div>
          <div className="tabular text-[17px] leading-tight text-gold">{m.self_heal_rate}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Retries attempted</div>
          <div className="tabular text-[17px] leading-tight">{m.retries_attempted}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Retries succeeded</div>
          <div className="tabular text-[17px] leading-tight">{m.retries_succeeded}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Mean time to resolve</div>
          <div className="tabular text-[17px] leading-tight">{m.mean_time_to_resolve}</div>
        </div>
        <div className="border-r border-line px-4 py-2">
          <div className="text-[11px] text-faint">Escalations</div>
          <div className={`tabular text-[17px] leading-tight ${m.escalations ? 'text-degraded' : ''}`}>
            {m.escalations}
          </div>
        </div>
        <div className="px-4 py-2">
          <div className="text-[11px] text-faint">Lanes at retry ceiling</div>
          <div className="text-[12px]">
            {data.lanes_at_retry_ceiling.length === 0 ? (
              <span className="text-dim">none</span>
            ) : (
              data.lanes_at_retry_ceiling.map((l) => (
                <span key={l.lane} className="mr-2 text-failing">
                  {laneLabel(l.lane)} {l.incidents}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
  );
}
