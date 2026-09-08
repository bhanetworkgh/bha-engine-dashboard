import type { OpenLoopsData } from '../../data';
import { BUILDER_NAMES } from '../../data';
import { EmptyState, RowAction, RowActions, SourceLink, TableFrame, Th } from '../../components/ui';
import { act } from '../../lib';

/** Loops the digest and the builder tables disagree about. */
export function Reconciliation({ data }: { data: OpenLoopsData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-6 pb-3 text-[11.5px] text-faint md:px-8">{data.reconciliation_note}</p>
      {data.reconciliation.length === 0 ? (
        <EmptyState>Every loop the digest names was found in exactly one builder table.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th>title</Th>
              <Th>expected owner</Th>
              <Th>found in</Th>
              <Th>discrepancy</Th>
              <Th>loop</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.reconciliation.map((r) => (
              <tr key={r.id}>
                <td className="td card-title td-clip" style={{ maxWidth: '46ch' }}>
                  {r.title}
                </td>
                <td className="td card-meta text-dim">{BUILDER_NAMES[r.expected_owner] ?? r.expected_owner}</td>
                <td className={`td card-meta ${r.found_in ? 'text-degraded' : 'text-failing'}`}>{r.found_in ?? 'no table'}</td>
                <td className="td card-full td-clip text-faint" style={{ maxWidth: '52ch' }}>
                  {r.discrepancy}
                </td>
                <td className="td tabular text-faint">{r.loop_id}</td>
                <td className="td">
                  <SourceLink source={r.source} />
                </td>
                <td className="td card-actions td-actions">
                  <RowActions>
                    <RowAction label="Reassign" onClick={() => act('reconcile.reassign', r.id)} />
                    <RowAction label="Ignore" onClick={() => act('reconcile.ignore', r.id)} />
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
