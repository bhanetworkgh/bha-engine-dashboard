import { Fragment, useState } from 'react';
import { useData } from '../app/useData';
import { getEngineHealth, type Incident } from '../data';
import {
  Dot,
  EmptyState,
  Loading,
  LoadFailed,
  PageHeader,
  RowAction,
  RowActions,
  SPINE_HEADERS,
  SourceLink,
  SpineCells,
  TableFrame,
  TagRow,
  Th,
  act,
  healthText,
} from '../components/ui';

/** The state machine, drawn in order so a row's position in it is visible. */
const STATES: Incident['state'][] = [
  'new',
  'triage',
  'auto-retry pending',
  'resolved',
  'failed',
  'escalated to RT',
  'escalated to human',
];

function StateTrack({ state }: { state: Incident['state'] }) {
  const idx = STATES.indexOf(state);
  return (
    <span className="inline-flex items-center gap-[3px]" title={STATES.join(' → ')}>
      {STATES.map((s, i) => (
        <span
          key={s}
          className={`h-[3px] w-[9px] ${
            i === idx
              ? state === 'failed' || state === 'escalated to human'
                ? 'bg-failing'
                : state === 'resolved'
                  ? 'bg-dim'
                  : 'bg-degraded'
              : i < idx
                ? 'bg-line-strong'
                : 'bg-line'
          }`}
        />
      ))}
    </span>
  );
}

export default function EngineHealth() {
  const { status, data, error } = useData(getEngineHealth);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const m = data.metrics;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Engine health" subtitle="Incidents and self-healing" />

      <div className="grid shrink-0 grid-cols-6 border-b border-line">
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
                  {l.lane.toLowerCase()} {l.incidents}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {data.incidents.length === 0 ? (
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
                  <td className="td tabular">{i.id}</td>
                  <td className="td td-clip" style={{ maxWidth: '34ch' }} title={i.summary}>
                    {i.summary}
                  </td>
                  <td className="td"><TagRow tags={i.tags} /></td>
                  <td className={`td ${healthText(i.health)}`}>{i.error_class.toLowerCase()}</td>
                  <td className="td">
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
                  <td className="td">
                    <RowActions>
                      <RowAction label="retry" onClick={() => act('incident.retry', i.id)} />
                      <RowAction label="escalate" onClick={() => act('incident.escalate', i.id)} />
                      <RowAction
                        label="open in Slack"
                        onClick={() => act('incident.open-slack', i.id)}
                      />
                    </RowActions>
                  </td>
                </tr>
                {expanded === i.id && (
                  <tr>
                    <td className="td" />
                    <td className="td td-wrap" colSpan={15}>
                      <div className="py-1">
                        <div className="mb-1 text-[11px] tracking-[0.08em] text-faint uppercase">
                          Action footprint
                        </div>
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
      )}
    </div>
  );
}
