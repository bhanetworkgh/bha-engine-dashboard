import type { VFarmData } from '../../data';
import { EmptyState, SourceLink, TableFrame, Th } from '../../components/ui';

/**
 * Burn-in and growth cycle events. Nothing emits these yet, so this is an
 * empty state that says so rather than a timeline of nothing.
 */
export function Lifecycle({ data }: { data: VFarmData }) {
  return (
    <div className="min-h-0 flex-1">
      {data.lifecycle.length === 0 ? (
        <EmptyState>{data.lifecycle_note}</EmptyState>
      ) : (
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
            {data.lifecycle.map((e) => (
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
      )}
    </div>
  );
}
