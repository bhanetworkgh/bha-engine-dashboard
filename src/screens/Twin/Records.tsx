import type { TwinData } from '../../data';
import {
  EmptyState,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
} from '../../components/ui';
import { act, healthText } from '../../lib';
import { OUTCOME_HEALTH } from './shared';

export function Records({ d }: { d: TwinData }) {
  if (!d.records.length)
    return <EmptyState>No asks recorded for the selected lane in this period.</EmptyState>;
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>question</Th>
          <Th>tags</Th>
          <Th>asked by</Th>
          <Th className="text-right">cycle</Th>
          <Th>outcome</Th>
          <Th>evidence shape</Th>
          {SPINE_HEADERS.map((h) => (
            <Th key={h}>{h}</Th>
          ))}
          <Th>at</Th>
          <Th>source</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {d.records.map((r) => (
          <tr key={r.id}>
            <td className="td card-title td-clip" style={{ maxWidth: '38ch' }} title={r.question}>
              {r.question}
            </td>
            <td className="td"><TagRow tags={r.tags} /></td>
            <td className="td text-dim">{r.asked_by}</td>
            <td className="td card-meta tabular text-right text-dim">{r.cycle}</td>
            <td className={`td card-meta ${healthText(OUTCOME_HEALTH[r.outcome])}`}>{r.outcome}</td>
            <td className="td">
              {r.evidence_shape_version ? (
                <span className="text-dim">{r.evidence_shape_version}</span>
              ) : (
                <span className="text-faint">not written</span>
              )}
            </td>
            <SpineCells spine={r.spine} />
            <td className="td tabular text-faint">{r.at}</td>
            <td className="td">
              <SourceLink source={r.source} />
            </td>
            <td className="td card-actions">
              <RowActions>
                <RowAction label="re-run" onClick={() => act('twin.rerun-ask', r.id)} />
                <RowAction label="open in Slack" onClick={() => act('twin.open-slack', r.id)} />
              </RowActions>
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
