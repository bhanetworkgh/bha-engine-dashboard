import type { VFarmData } from '../../data';
import { ComingSoon, SourceLink, TableFrame, Th } from '../../components/ui';

/**
 * Burn-in and growth cycle events.
 *
 * Nothing emits these yet — no workflow writes a lifecycle event — so this is
 * not an empty table, it is a capability that has not been built. The rule for
 * this page is that real data is shown where the data is real, and where it is
 * not, the page says "coming soon" plainly rather than drawing an empty
 * timeline that implies the feed is live and quiet.
 */
export function Lifecycle({ data }: { data: VFarmData }) {
  if (data.lifecycle.length === 0) {
    return (
      <div className="min-h-0 flex-1 px-6 pb-6 md:px-8">
        <ComingSoon title="Lifecycle timeline" min={200}>
          {data.lifecycle_note} The four event types this timeline is specced for — burn_in_cycle_started, burn_in_anomaly, growth_cycle_started and
          growth_cycle_measurement_logged — appear here as soon as something writes one.
        </ComingSoon>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <TableFrame>
        <thead>
          <tr>
            <Th>at</Th>
            <Th>event</Th>
            <Th>detail</Th>
            <Th>source</Th>
          </tr>
        </thead>
        <tbody>
          {/* Newest first, oldest last. */}
          {[...data.lifecycle]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((e) => (
              <tr key={e.id}>
                <td className="td tabular text-faint">{e.at}</td>
                <td className="td">{e.type}</td>
                <td className="td td-wrap text-dim">{e.detail}</td>
                <td className="td">
                  <SourceLink source={e.source} />
                </td>
              </tr>
            ))}
        </tbody>
      </TableFrame>
    </div>
  );
}
