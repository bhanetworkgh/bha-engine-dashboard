import type { TwinData } from '../../data';
import { Th } from '../../components/ui';
import { laneLabel } from '../../lib';

export function Summary({ d }: { d: TwinData }) {
  const s = d.summary;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-2 border-b border-line md:grid-cols-5">
        {[
          { label: 'Asks', value: String(s.asks), tone: 'text-gold' },
          { label: 'Answered', value: String(s.answered), tone: 'text-ink' },
          { label: 'Thin', value: String(s.thin), tone: s.thin ? 'text-degraded' : 'text-ink' },
          { label: 'Failed', value: String(s.failed), tone: s.failed ? 'text-failing' : 'text-ink' },
          { label: 'Median time to answer', value: s.median_time_to_answer ?? 'not recorded', tone: 'text-dim' },
        ].map((m) => (
          <div key={m.label} className="border-r border-line px-4 py-2 last:border-r-0">
            <div className="text-[11px] text-faint">{m.label}</div>
            <div className={`tabular text-[17px] leading-tight ${m.tone}`}>{m.value}</div>
          </div>
        ))}
      </div>

      {s.median_unavailable_reason && (
        <p className="max-w-[68ch] border-b border-line px-4 py-2 text-[11px] leading-relaxed text-faint">
          {s.median_unavailable_reason}
        </p>
      )}

      <div className="flex flex-wrap">
        <section className="min-w-[280px] flex-1 border-r border-line">
          <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            Top askers
          </h3>
          <table className="w-full text-[12px]">
            <tbody>
              {s.top_askers.map((a) => (
                <tr key={a.builder_id}>
                  <td className="td">{a.builder_id}</td>
                  <td className="td tabular w-16 text-right text-dim">{a.asks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="min-w-[360px] flex-1">
          <h3 className="border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            By lane
          </h3>
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <Th>lane</Th>
                <Th className="text-right">asks</Th>
                <Th className="text-right">thin</Th>
                <Th className="text-right">failed</Th>
              </tr>
            </thead>
            <tbody>
              {s.by_lane.map((l) => (
                <tr key={l.lane}>
                  <td className="td">{laneLabel(l.lane)}</td>
                  <td className="td tabular text-right text-dim">{l.asks}</td>
                  <td className={`td tabular text-right ${l.thin ? 'text-degraded' : 'text-faint'}`}>{l.thin}</td>
                  <td className={`td tabular text-right ${l.failed ? 'text-failing' : 'text-faint'}`}>{l.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
