import { Link } from 'react-router-dom';
import { useData } from '../../app/useData';
import { getBuilders } from '../../data';
import {
  Dot,
  EmptyState,
  LoadFailed,
  Loading,
  PageHeader,
  RowAction,
  RowActions,
  SourceLink,
  TableFrame,
  Th,
} from '../../components/ui';
import { act, ageTone, laneLabel } from '../../lib';

export function Builders() {
  const { status, data, error } = useData(getBuilders);
  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Builders" subtitle="One row per person" />
      {data.builders.length === 0 ? (
        <EmptyState>No builders work in the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th />
              <Th>name</Th>
              <Th>lane</Th>
              <Th className="text-right">open loops</Th>
              <Th className="text-right">oldest loop</Th>
              <Th>last activity</Th>
              <Th>contract</Th>
              <Th className="text-right">entries this week</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.builders.map((b) => (
              <tr key={b.id}>
                <td className="td"><Dot health={b.health} /></td>
                <td className="td card-title">
                  <Link to={`/builders/${b.id}`} className="font-medium hover:text-accent-ink">{b.name}</Link>
                </td>
                <td className="td card-meta text-faint">{laneLabel(b.lane)}</td>
                <td className="td card-meta tabular text-right">{b.open_loops}</td>
                <td className={`td card-meta tabular text-right ${ageTone(b.oldest_loop_days)}`}>
                  {b.oldest_loop_days}d
                </td>
                <td className="td tabular text-faint">{b.last_activity}</td>
                <td className={`td ${b.contract_status === 'signed' ? 'text-faint' : 'text-degraded'}`}>
                  {b.contract_status}
                </td>
                <td className="td tabular text-right text-dim">{b.entries_this_week}</td>
                <td className="td"><SourceLink source={b.source} /></td>
                <td className="td card-actions td-actions">
                  <RowActions>
                    <RowAction label="Open in Slack" onClick={() => act('builder.open-slack', b.id)} />
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </div>
  );
}
