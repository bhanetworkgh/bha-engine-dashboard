import { useState } from 'react';
import { useData } from '../app/useData';
import { getVFarm } from '../data';
import {
  Dot,
  EmptyState,
  Loading,
  LoadFailed,
  PageHeader,
  RowAction,
  RowActions,
  SourceLink,
  TableFrame,
  Th,
  act,
  healthText,
} from '../components/ui';

const TABS = ['Live', 'Lifecycle', 'Readiness'] as const;
type Tab = (typeof TABS)[number];

export default function VFarm() {
  const [tab, setTab] = useState<Tab>('Live');
  const { status, data, error } = useData(getVFarm);

  if (status === 'loading') return <Loading />;
  if (status === 'error') return <LoadFailed error={error} />;

  const openAlerts = data.alerts.filter((a) => a.state === 'open');
  const latest = data.readings[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="vFarm"
        subtitle={`${data.days_to_halloween} days to Halloween`}
        right={
          <div className="flex gap-4">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`border-b-2 pb-1 text-[12px] ${
                  tab === t ? 'border-gold text-ink' : 'border-transparent text-faint hover:text-dim'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />

      {tab === 'Live' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Current rack state and last measurement. */}
          <div className="grid shrink-0 grid-cols-6 border-b border-line">
            {data.places.map((p) => (
              <div key={p.name} className="border-r border-line px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] text-faint">
                  <Dot health={p.health} />
                  {p.name}
                </div>
                <div className="tabular text-[12px] text-dim">{p.last_seen}</div>
              </div>
            ))}
            <div className="border-r border-line px-3 py-2">
              <div className="text-[11px] text-faint">Last measurement</div>
              <div className="tabular text-[12px] text-dim">
                {latest ? `${latest.ph ?? '—'} pH · ${latest.temp_c}°C` : 'none'}
              </div>
            </div>
            <div className="px-3 py-2">
              <div className="text-[11px] text-faint">Open anomalies</div>
              <div
                className={`tabular text-[17px] leading-tight ${
                  openAlerts.length ? 'text-degraded' : 'text-ink'
                }`}
              >
                {openAlerts.length}
              </div>
            </div>
          </div>

          <h3 className="shrink-0 border-b border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            Alerts and incident closes
          </h3>
          {data.alerts.length === 0 ? (
            <EmptyState>No alerts recorded for the selected lane.</EmptyState>
          ) : (
            <div className="shrink-0 overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr>
                    <Th>at</Th>
                    <Th>place</Th>
                    <Th>kind</Th>
                    <Th>detail</Th>
                    <Th>state</Th>
                    <Th>closed</Th>
                    <Th>source</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.map((a) => (
                    <tr key={a.id}>
                      <td className="td tabular text-faint">{a.at}</td>
                      <td className="td">{a.place}</td>
                      <td className={`td ${healthText(a.health)}`}>{a.kind}</td>
                      <td className="td td-clip text-dim" style={{ maxWidth: '52ch' }}>{a.detail}</td>
                      <td className={`td ${a.state === 'open' ? healthText(a.health) : 'text-faint'}`}>
                        {a.state}
                      </td>
                      <td className="td tabular text-faint">{a.closed_at ?? '—'}</td>
                      <td className="td">
                        <SourceLink source={a.source} />
                      </td>
                      <td className="td">
                        <RowActions>
                          {a.state === 'open' && (
                            <RowAction label="close" onClick={() => act('vfarm.close-alert', a.id)} />
                          )}
                          <RowAction
                            label="open in Slack"
                            onClick={() => act('vfarm.open-slack', a.id)}
                          />
                        </RowActions>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="shrink-0 border-y border-line px-4 py-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">
            Sensor rollups, three-minute cadence
          </h3>
          {data.readings.length === 0 ? (
            <EmptyState>
              No sensor rollups for the selected lane. vFarm readings are written under
              the vfarm core lane only.
            </EmptyState>
          ) : (
            <TableFrame>
              <thead>
                <tr>
                  <Th>at</Th>
                  <Th>place</Th>
                  <Th className="text-right">pH</Th>
                  <Th className="text-right">temp °C</Th>
                  <Th className="text-right">humidity %</Th>
                  <Th>source</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.readings.map((r) => (
                  <tr key={r.id}>
                    <td className="td tabular text-faint">{r.at}</td>
                    <td className="td">{r.place}</td>
                    <td className={`td tabular text-right ${r.health === 'ok' ? '' : healthText(r.health)}`}>
                      {r.ph ?? <span className="text-faint">no probe</span>}
                    </td>
                    <td className={`td tabular text-right ${r.health === 'ok' ? '' : healthText(r.health)}`}>
                      {r.temp_c}
                    </td>
                    <td className="td tabular text-right">{r.humidity_pct}</td>
                    <td className="td">
                      <SourceLink source={r.source} />
                    </td>
                    <td className="td">
                      <RowActions>
                        <RowAction label="open in n8n" onClick={() => act('vfarm.open-run', r.id)} />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          )}
        </div>
      )}

      {tab === 'Lifecycle' && (
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
      )}

      {tab === 'Readiness' && (
        <div className="min-h-0 flex-1">
          <EmptyState>{data.readiness_note}</EmptyState>
        </div>
      )}
    </div>
  );
}
