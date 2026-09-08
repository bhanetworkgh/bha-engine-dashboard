import type { TwinData } from '../../data';
import { Band, Card, CardHeader, HBar, Stat, StatCell, StatStrip, Th } from '../../components/ui';
import { laneLabel } from '../../lib';

export function Summary({ d }: { d: TwinData }) {
  const s = d.summary;
  const maxAsker = Math.max(1, ...s.top_askers.map((a) => a.asks));
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-6">
      <StatStrip cols={5}>
        <StatCell>
          <Stat label="Asks" value={s.asks} tone="accent" />
        </StatCell>
        <StatCell>
          <Stat label="Answered" value={s.answered} />
        </StatCell>
        <StatCell>
          <Stat label="Thin" value={s.thin} tone={s.thin ? 'degraded' : 'default'} />
        </StatCell>
        <StatCell>
          <Stat label="Failed" value={s.failed} tone={s.failed ? 'failing' : 'default'} />
        </StatCell>
        <StatCell>
          <Stat
            label="Median time to answer"
            value={s.median_time_to_answer ?? <span className="text-[16px] text-faint">not recorded</span>}
            tone="dim"
          />
        </StatCell>
      </StatStrip>

      <div className="mx-6 mb-4 md:mx-8">
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-faint">
          <span>Outcomes this period</span>
          <span className="tabular">{s.asks} asks</span>
        </div>
        <Band
          parts={[
            { value: s.answered, tone: 'ink', label: 'answered' },
            { value: s.thin, tone: 'degraded', label: 'thin' },
            { value: s.failed, tone: 'failing', label: 'failed' },
          ]}
        />
        {s.median_unavailable_reason && (
          <p className="mt-3 max-w-[68ch] text-[11.5px] leading-relaxed text-faint">{s.median_unavailable_reason}</p>
        )}
      </div>

      <div className="mx-6 grid gap-3 md:mx-8 md:grid-cols-2">
        <Card>
          <CardHeader title="Top askers" />
          <div className="space-y-2.5 px-5 pb-5">
            {s.top_askers.length === 0 ? (
              <p className="text-[12.5px] text-dim">No asks in the selected lane.</p>
            ) : (
              s.top_askers.map((a) => <HBar key={a.builder_id} label={a.builder_id} value={a.asks} max={maxAsker} />)
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="By lane" />
          <table className="w-full text-[12.5px]">
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
        </Card>
      </div>
    </div>
  );
}
