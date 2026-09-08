import { Fragment } from 'react';
import type { EngineHealthData } from '../../data';
import {
  Dot,
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
import { act, errorClassLabel, healthText } from '../../lib';
import { StateTrack } from './StateTrack';

/**
 * Incidents, duplicates collapsed by fingerprint so one flapping error is one
 * row. Clicking a row reveals its action footprint.
 */
export function IncidentTable({
  data,
  expanded,
  setExpanded,
}: {
  data: EngineHealthData;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
}) {
  return (
    data.incidents.length === 0 ? (
        <EmptyState>No incidents recorded for the selected lane.</EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th />
              <Th>incident</Th>
              <Th>summary</Th>
              <Th>tags</Th>
              <Th>error class</Th>
              <Th>state</Th>
              <Th className="text-right">retries</Th>
              <Th className="text-right">seen</Th>
              {SPINE_HEADERS.map((h) => (
                <Th key={h}>{h}</Th>
              ))}
              <Th>opened</Th>
              <Th>source</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.incidents.map((i) => (
              <Fragment key={i.id}>
                <tr
                  onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                  className="cursor-pointer"
                >
                  <td className="td">
                    <Dot health={i.health} />
                  </td>
                  <td className="td card-meta tabular">{i.id}</td>
                  <td className="td card-title td-clip" style={{ maxWidth: '34ch' }} title={i.summary}>
                    {i.summary}
                  </td>
                  <td className="td"><TagRow tags={i.tags} /></td>
                  <td className={`td card-meta ${healthText(i.health)}`}>{errorClassLabel(i.error_class)}</td>
                  <td className="td card-meta">
                    <span className="flex items-center gap-2">
                      <StateTrack state={i.state} />
                      <span className={i.state === 'resolved' ? 'text-dim' : healthText(i.health)}>
                        {i.state}
                      </span>
                    </span>
                  </td>
                  <td className="td tabular text-right text-dim">
                    {i.retries_attempted}/{i.max_retries}
                  </td>
                  {/* Duplicates collapsed by fingerprint, so one flapping error is one row. */}
                  <td
                    className="td tabular text-right text-faint"
                    title={`Collapsed by fingerprint ${i.fingerprint}`}
                  >
                    ×{i.occurrences}
                  </td>
                  <SpineCells spine={i.spine} />
                  <td className="td tabular text-faint">{i.opened_at}</td>
                  <td className="td">
                    <SourceLink source={i.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      <RowAction label="Retry" onClick={() => act('incident.retry', i.id)} />
                      <RowAction label="Escalate" onClick={() => act('incident.escalate', i.id)} />
                      <RowAction
                        label="Open in Slack"
                        onClick={() => act('incident.open-slack', i.id)}
                      />
                    </RowActions>
                  </td>
                </tr>
                {expanded === i.id && (
                  <tr>
                    <td className="td" />
                    <td className="td card-full td-wrap bg-raised" colSpan={15}>
                      <div className="py-1">
                        <div className="kicker mb-1">Action footprint</div>
                        <table className="text-[12px]">
                          <tbody>
                            {i.actions.map((a, n) => (
                              <tr key={n}>
                                <td className="td border-0 pr-4">{a.action_type}</td>
                                <td className="td border-0 pr-4 text-dim">{a.actor}</td>
                                <td
                                  className={`td border-0 pr-4 ${
                                    a.outcome === 'failed'
                                      ? 'text-failing'
                                      : a.outcome === 'skipped'
                                        ? 'text-degraded'
                                        : 'text-dim'
                                  }`}
                                >
                                  {a.outcome}
                                </td>
                                <td className="td td-wrap border-0 pr-4 text-faint">{a.reason}</td>
                                <td className="td tabular border-0 text-faint">{a.at}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </TableFrame>
      )
  );
}
