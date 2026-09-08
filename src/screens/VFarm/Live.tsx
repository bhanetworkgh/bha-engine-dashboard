import type { VFarmData } from '../../data';
import {
  Dot,
  EmptyState,
  RowAction,
  RowActions,
  SourceLink,
  TableFrame,
  Th,
} from '../../components/ui';
import { act, healthText } from '../../lib';

/**
 * What vFarm actually emits today: three-minute sensor rollups by place, plus
 * threshold alerts and incident closes.
 */
export function Live({ data }: { data: VFarmData }) {
  const openAlerts = data.alerts.filter((a) => a.state === 'open');
  const latest = data.readings[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Current rack state and last measurement. */}
      <div className="mx-6 mb-4 grid shrink-0 grid-cols-2 gap-3 md:mx-8 md:grid-cols-3 lg:grid-cols-6">
        {data.places.map((p) => (
          <div key={p.name} className="card px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
              <Dot health={p.health} />
              <span className="truncate">{p.name}</span>
            </div>
            <div className="tabular mt-1 text-[12.5px] text-dim">{p.last_seen}</div>
          </div>
        ))}
        <div className="card px-4 py-3">
          <div className="kicker">Last measurement</div>
          <div className="tabular mt-1 text-[12.5px] text-dim">
            {latest ? `${latest.ph ?? '—'} pH · ${latest.temp_c}°C` : 'none'}
          </div>
        </div>
        <div className="card px-4 py-3">
          <div className="kicker">Open anomalies</div>
          <div className={`font-display tabular mt-1 text-[22px] leading-none ${openAlerts.length ? 'text-degraded' : 'text-ink'}`}>
            {openAlerts.length}
          </div>
        </div>
      </div>

      <h3 className="shrink-0 px-6 pb-2 text-[13px] font-medium md:px-8">Alerts and incident closes</h3>
      {data.alerts.length === 0 ? (
        <EmptyState>No alerts recorded for the selected lane.</EmptyState>
      ) : (
        <div className="card mx-6 mb-4 shrink-0 overflow-x-auto md:mx-8">
          <table className="table-cards w-full text-[12.5px]">
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
                  <td className="td card-meta tabular text-faint">{a.at}</td>
                  <td className="td card-meta">{a.place}</td>
                  <td className={`td card-title ${healthText(a.health)}`}>{a.kind}</td>
                  <td className="td card-full td-clip text-dim" style={{ maxWidth: '52ch' }}>{a.detail}</td>
                  <td className={`td card-meta ${a.state === 'open' ? healthText(a.health) : 'text-faint'}`}>
                    {a.state}
                  </td>
                  <td className="td tabular text-faint">{a.closed_at ?? '—'}</td>
                  <td className="td">
                    <SourceLink source={a.source} />
                  </td>
                  <td className="td card-actions td-actions">
                    <RowActions>
                      {a.state === 'open' && (
                        <RowAction label="Close" onClick={() => act('vfarm.close-alert', a.id)} />
                      )}
                      <RowAction
                        label="Open in Slack"
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

      <h3 className="shrink-0 px-6 pb-2 text-[13px] font-medium md:px-8">Sensor rollups, three-minute cadence</h3>
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
                <td className="td card-meta tabular text-faint">{r.at}</td>
                <td className="td card-title">{r.place}</td>
                <td className={`td card-meta tabular text-right ${r.health === 'ok' ? '' : healthText(r.health)}`}>
                  {r.ph ?? <span className="text-faint">no probe</span>}
                </td>
                <td className={`td card-meta tabular text-right ${r.health === 'ok' ? '' : healthText(r.health)}`}>
                  {r.temp_c}
                </td>
                <td className="td card-meta tabular text-right">{r.humidity_pct}</td>
                <td className="td">
                  <SourceLink source={r.source} />
                </td>
                <td className="td card-actions td-actions">
                  <RowActions>
                    <RowAction label="Open in n8n" onClick={() => act('vfarm.open-run', r.id)} />
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
