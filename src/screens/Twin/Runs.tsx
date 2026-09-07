import type { TwinData } from '../../data';
import {
  EmptyState,
  RowAction,
  RowActions,
  SourceLink,
  TableFrame,
  Th,
} from '../../components/ui';
import { act, healthText } from '../../lib';
import { ENDED_HEALTH } from './shared';

export function Runs({ d }: { d: TwinData }) {
  if (!d.runs.length)
    return <EmptyState>No runs recorded for the selected lane in this period.</EmptyState>;
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>question</Th>
          <Th>searches fired</Th>
          <Th>ended</Th>
          <Th>how it ended</Th>
          <Th>started</Th>
          <Th>source</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {d.runs.map((r) => (
          <tr key={r.id}>
            <td className="td td-clip" style={{ maxWidth: '34ch' }}>{r.question}</td>
            <td className="td">
              <span className="inline-flex flex-wrap gap-1.5">
                {r.searches.map((s) => (
                  <span
                    key={s.tool}
                    className={`border px-1 text-[11px] leading-[16px] ${
                      s.empty ? 'border-line text-degraded' : 'border-line text-dim'
                    }`}
                    title={s.empty ? 'returned nothing' : `${s.returned} results`}
                  >
                    {s.tool} {s.empty ? 'empty' : s.returned}
                  </span>
                ))}
              </span>
            </td>
            <td className={`td ${healthText(ENDED_HEALTH[r.ended])}`}>{r.ended}</td>
            <td className="td td-clip text-faint" style={{ maxWidth: '44ch' }}>{r.end_detail}</td>
            <td className="td tabular text-faint">{r.started_at}</td>
            <td className="td">
              <SourceLink source={r.source} />
            </td>
            <td className="td">
              <RowActions>
                <RowAction label="re-run" onClick={() => act('twin.rerun', r.id)} />
              </RowActions>
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
