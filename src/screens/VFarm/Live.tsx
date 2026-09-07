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
  );
}
