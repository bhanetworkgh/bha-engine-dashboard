import type { ReactNode } from 'react';
import type { VfarmDevice, VfarmLiveData } from '../../data';
import { Card, CardHeader, EmptyState, FigureCell, Pagination, Pill, RecordId, StatStrip, TableFrame, Th, relativeTime, usePaged } from '../../components/ui';

/**
 * vFarm's own state, as vFarm pushes it (2026-09-29, Destiny — D3).
 *
 * Two feeds, both pushed, neither polled:
 *   - `vfarm.snapshot.v1` to `/api/engine/vfarm-snapshot` every few minutes —
 *     every farm, its devices and where they sit, and the open alerts;
 *   - `vfarm.alert.v1` to `/api/engine/vfarm-alerts` — the envelope vFarm
 *     already sends to any alert webhook, one post per fire.
 *
 * **Reporting is worked out from `last_reading_at`, never from vFarm's own
 * `status` column**, which nothing in vFarm keeps up to date (its user-ui says
 * so). A device is reporting if it sent a reading in the last fifteen minutes;
 * the window is printed wherever the figure is.
 *
 * **Before the first snapshot every tab says so**, names who wires it, and
 * draws nothing: a device list of nought and "nobody has sent one" look the
 * same from outside, and only one of them is true.
 */

export const REPORTING_MINUTES = 15;
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
export const reporting = (d: VfarmDevice, now = Date.now()) => !d.gone_at && !!d.last_reading_at && now - Date.parse(d.last_reading_at) < REPORTING_MINUTES * 60_000;

function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="px-6 pb-8 md:px-8">
      <EmptyState>{children}</EmptyState>
    </div>
  );
}

const NO_SNAPSHOT = (
  <>
    No vFarm snapshot has arrived yet. vFarm posts its farms, devices and open alerts to <code>/api/engine/vfarm-snapshot</code> every few minutes once Jegan and
    Kavin add the job (the contract is docs/contracts/vfarm.md in this repo). It appears here the moment it lands — there is nothing to press.
  </>
);

/** How old the state on screen is. Amber past ten minutes: the snapshot job runs every three. */
function SnapshotLine({ data }: { data: VfarmLiveData }) {
  const s = data.last_snapshot;
  if (!s) return null;
  const stale = Date.now() - Date.parse(s.taken_at) > 10 * 60_000;
  return (
    <p className={`text-[12px] ${stale ? 'text-degraded' : 'text-dim'}`}>
      State as of {when(s.taken_at)} UTC ({relativeTime(s.taken_at) ?? '—'}) · {data.snapshots} snapshot{data.snapshots === 1 ? '' : 's'} received
      {stale ? ' · vFarm has not sent one for over ten minutes, so everything below may be out of date' : ''}
    </p>
  );
}

function SeverityPill({ severity }: { severity: string | null }) {
  if (severity === 'critical') return <Pill tone="failing">critical</Pill>;
  if (severity === 'warning') return <Pill tone="degraded">warning</Pill>;
  return <Pill>{severity ?? 'no severity'}</Pill>;
}

/** A device's latest readings on one line, as vFarm sent them: `{ value, unit, status }` or a bare number. */
function readings(latest: Record<string, unknown> | null): string {
  if (!latest) return '—';
  const parts = Object.entries(latest).map(([k, v]) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const val = o.value ?? '—';
      return `${k} ${String(val)}${o.unit ? ` ${String(o.unit)}` : ''}`;
    }
    return `${k} ${String(v)}`;
  });
  return parts.length ? parts.join(' · ') : '—';
}

export function Overview({ data }: { data: VfarmLiveData }) {
  if (!data.last_snapshot) return <Waiting>{NO_SNAPSHOT}</Waiting>;
  const now = Date.now();
  const live = data.devices.filter((d) => !d.gone_at);
  const on = live.filter((d) => reporting(d, now));
  const quiet = live.length - on.length;
  const pipe = data.last_snapshot.pipeline;
  const pipeStatus = pipe && typeof pipe.status === 'string' ? pipe.status : null;
  const openByFarm = (id: string) => data.open_alerts.filter((a) => a.farm_id === id).length;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <SnapshotLine data={data} />
      <StatStrip cols={5} flush>
        <FigureCell label="Farms" value={data.farms.length} caption="as the last snapshot listed them" note="Every farm vFarm's snapshot covers." />
        <FigureCell
          label="Devices reporting"
          value={on.length}
          caption={`of ${live.length}, a reading in the last ${REPORTING_MINUTES} min`}
          note="Worked out from each device's last reading, not from vFarm's status column, which nothing in vFarm keeps up to date."
        />
        <FigureCell label="Gone quiet" value={quiet} tone={quiet ? 'degraded' : undefined} caption={`no reading for ${REPORTING_MINUTES} min or more`} note="Placed devices that have stopped sending readings. A device vFarm no longer lists is counted apart, as gone." />
        <FigureCell label="Open alerts" value={data.open_alerts.length} tone={data.open_alerts.length ? 'degraded' : undefined} caption={`${data.alerts_fired_24h} fired in the last 24 h`} note="Alerts vFarm says are open now, from the last snapshot. Fires arrive live on the Alerts tab." />
        <FigureCell
          label="Alert pipeline"
          value={null}
          missing={pipeStatus ?? 'Not sent'}
          caption={pipe && typeof pipe.last_processed_age_s === 'number' ? `last processed ${Math.round(pipe.last_processed_age_s)} s before the snapshot` : 'vFarm\'s own alert worker health'}
          note="vFarm's /alerts/threshold/health, sent with each snapshot: ok or degraded, and how far behind the worker is."
        />
      </StatStrip>
      <Card className="pb-3">
        <CardHeader title="Farms" />
        <TableFrame flat grow={false} label="vFarm farms">
          <thead>
            <tr>
              <Th>farm</Th>
              <Th>vFarm's health</Th>
              <Th>devices</Th>
              <Th>reporting</Th>
              <Th>open alerts</Th>
            </tr>
          </thead>
          <tbody>
            {data.farms.map((f) => {
              const mine = live.filter((d) => d.farm_id === f.farm_id);
              const mineOn = mine.filter((d) => reporting(d, now)).length;
              const open = openByFarm(f.farm_id);
              return (
                <tr key={f.farm_id}>
                  <td className="td">
                    {f.name ?? f.code ?? f.farm_id}
                    {f.code && <span className="ml-2 text-[11px] text-faint">{f.code}</span>}
                  </td>
                  <td className="td">{f.status === 'critical' ? <Pill tone="failing">critical</Pill> : f.status === 'warning' ? <Pill tone="degraded">warning</Pill> : <Pill>{f.status ?? 'not sent'}</Pill>}</td>
                  <td className="td tabular">{mine.length}</td>
                  <td className={`td tabular ${mineOn < mine.length ? 'text-degraded' : ''}`}>{mine.length ? `${mineOn} of ${mine.length}` : '—'}</td>
                  <td className={`td tabular ${open ? 'text-degraded' : ''}`}>{open}</td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      </Card>
    </div>
  );
}

export function Devices({ data }: { data: VfarmLiveData }) {
  const paged = usePaged(data.devices, 'all');
  if (!data.last_snapshot) return <Waiting>{NO_SNAPSHOT}</Waiting>;
  const now = Date.now();
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <SnapshotLine data={data} />
      <Card className="pb-3">
        <CardHeader title="Devices" right={<span className="tabular text-[11.5px] text-faint">most recent reading first · gone last</span>} />
        {data.devices.length === 0 ? (
          <EmptyState compact>The snapshot lists no devices in any farm it covers.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label="vFarm devices">
            <thead>
              <tr>
                <Th>device</Th>
                <Th>farm</Th>
                <Th>where</Th>
                <Th>type</Th>
                <Th>last reading</Th>
                <Th>latest</Th>
                <Th>health</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((d) => {
                const on = reporting(d, now);
                return (
                  <tr key={d.device_id}>
                    <td className="td whitespace-nowrap">
                      <RecordId>{d.device_id}</RecordId>
                    </td>
                    <td className="td text-dim">{d.farm_name ?? d.farm_id ?? '—'}</td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '28ch' }} title={d.place ?? undefined}>
                      {d.place ?? <span className="text-faint">not placed</span>}
                    </td>
                    <td className="td text-dim">{[d.device_type, d.model].filter(Boolean).join(' · ') || '—'}</td>
                    <td className={`td tabular whitespace-nowrap ${d.gone_at ? 'text-faint' : on ? 'text-dim' : 'text-degraded'}`}>
                      {d.gone_at ? `gone ${relativeTime(d.gone_at) ?? ''}` : relativeTime(d.last_reading_at) ?? 'never'}
                    </td>
                    <td className="td td-clip text-dim" style={{ maxWidth: '40ch' }} title={readings(d.latest)}>
                      {readings(d.latest)}
                    </td>
                    <td className="td tabular text-dim">{d.health_score ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        )}
      </Card>
      <Pagination paged={paged} unit="devices" />
    </div>
  );
}

export function Alerts({ data }: { data: VfarmLiveData }) {
  const paged = usePaged(data.alert_events, 'all');
  const waitingForBoth = !data.last_snapshot && data.alerts_fired_all === 0;
  if (waitingForBoth) {
    return (
      <Waiting>
        No vFarm alert has arrived yet. Fires come in live once vFarm adds <code>/api/engine/vfarm-alerts</code> as an alert channel — no code change on their side —
        and open alerts come with each snapshot. The contract is docs/contracts/vfarm.md in this repo.
      </Waiting>
    );
  }
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
      <SnapshotLine data={data} />
      <Card className="pb-3">
        <CardHeader title="Open now" right={<span className="tabular text-[11.5px] text-faint">{data.last_snapshot ? 'from the last snapshot' : 'no snapshot yet'}</span>} />
        {!data.last_snapshot ? (
          <EmptyState compact>Open alerts come with vFarm's snapshot, and none has arrived yet. Fires are below.</EmptyState>
        ) : data.open_alerts.length === 0 ? (
          <EmptyState compact>Nothing is open in any farm the last snapshot covers.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label="Open vFarm alerts">
            <thead>
              <tr>
                <Th>severity</Th>
                <Th>alert</Th>
                <Th>device</Th>
                <Th>where</Th>
                <Th>value</Th>
                <Th>open since</Th>
              </tr>
            </thead>
            <tbody>
              {data.open_alerts.map((a) => (
                <tr key={a.alert_id}>
                  <td className="td">
                    <SeverityPill severity={a.severity} />
                  </td>
                  <td className="td td-clip" style={{ maxWidth: '40ch' }} title={a.detail ?? undefined}>
                    {a.title ?? a.detail ?? a.rule_id ?? '—'}
                  </td>
                  <td className="td whitespace-nowrap">{a.device_id ? <RecordId>{a.device_id}</RecordId> : '—'}</td>
                  <td className="td text-dim">{[a.farm_name, a.place].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="td tabular text-dim">{a.last_value ?? '—'}</td>
                  <td className="td tabular whitespace-nowrap text-dim">{relativeTime(a.opened_at) ?? when(a.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </Card>
      <Card className="pb-3">
        <CardHeader title="Fired" right={<span className="tabular text-[11.5px] text-faint">{data.alerts_fired_24h} in 24 h · {data.alerts_fired_all} held · newest first</span>} />
        {data.alert_events.length === 0 ? (
          <EmptyState compact>No fire has arrived. vFarm sends each one live once our URL is added as an alert channel.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label="vFarm alert fires">
            <thead>
              <tr>
                <Th>fired (UTC)</Th>
                <Th>rule</Th>
                <Th>severity</Th>
                <Th>device</Th>
                <Th>value</Th>
                <Th>where</Th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((e) => (
                <tr key={e.event_id}>
                  <td className="td tabular whitespace-nowrap text-faint">{when(e.fired_at)}</td>
                  <td className="td td-clip" style={{ maxWidth: '34ch' }} title={e.rule_name ?? undefined}>
                    {e.rule_name ?? e.rule_id ?? '—'}
                    {e.metric && <span className="ml-2 text-[11px] text-faint">{e.metric}</span>}
                    {e.kind === 'digest' && <span className="ml-2 text-[11px] text-faint">digest</span>}
                  </td>
                  <td className="td">
                    <SeverityPill severity={e.severity} />
                  </td>
                  <td className="td whitespace-nowrap">{e.device_id ? <RecordId>{e.device_id}</RecordId> : '—'}</td>
                  <td className="td tabular text-dim">{e.value ?? '—'}</td>
                  <td className="td td-clip text-dim" style={{ maxWidth: '34ch' }} title={e.place_path ?? undefined}>
                    {e.place_path ?? e.farm ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </Card>
      {data.alert_events.length > 0 && <Pagination paged={paged} unit="fires" />}
      {data.recently_closed.length > 0 && (
        <Card className="pb-3">
          <CardHeader title="Cleared recently" right={<span className="tabular text-[11.5px] text-faint">an open alert a later snapshot no longer listed</span>} />
          <TableFrame flat grow={false} label="Cleared vFarm alerts">
            <thead>
              <tr>
                <Th>cleared</Th>
                <Th>alert</Th>
                <Th>device</Th>
                <Th>farm</Th>
                <Th>was open</Th>
              </tr>
            </thead>
            <tbody>
              {data.recently_closed.slice(0, 20).map((c) => (
                <tr key={c.alert_id}>
                  <td className="td tabular whitespace-nowrap text-faint">{relativeTime(c.closed_at) ?? when(c.closed_at)}</td>
                  <td className="td td-clip" style={{ maxWidth: '40ch' }}>
                    {c.title ?? c.alert_id}
                  </td>
                  <td className="td">{c.device_id ? <RecordId>{c.device_id}</RecordId> : '—'}</td>
                  <td className="td text-dim">{c.farm_name ?? '—'}</td>
                  <td className="td tabular text-dim">{c.opened_at ? `since ${when(c.opened_at)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        </Card>
      )}
    </div>
  );
}
