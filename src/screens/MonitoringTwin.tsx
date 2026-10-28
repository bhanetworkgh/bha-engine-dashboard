import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../app/useData';
import { getMonitoringTwin, type MonitoringFarm, type MonitoringIncident, type MonitoringRover, type MonitoringRoverPass, type MonitoringState, type MonitoringTwinData } from '../data';
import {
  Card,
  CardHeader,
  EmptyState,
  FarmPicker,
  FigureCell,
  LoadFailed,
  Loading,
  PageHeader,
  Pill,
  RecordId,
  StatStrip,
  TableFrame,
  Tabs,
  Th,
  relativeTime,
  useReplayKey,
} from '../components/ui';

/**
 * Monitoring Twin (2026-10-01, Destiny — Jason's tomato-first memo in
 * #bha-coordination, and UN9D's runtime half).
 *
 * vFarm pushes its state every three minutes; this page shows what the twin
 * makes of it — the one judgement every other screen and agent reads, so the
 * twin and every interface show the same truth. Per farm: whether the feed is
 * arriving, the crop cycle and stage with that stage's target ranges, uptime as
 * Jason defined it, every device's state, and the incidents the twin raised.
 *
 * **A simulated farm is labelled on every line it appears.** It takes the same
 * path as the real rack (that is what makes it a test), and it is never shown on
 * the vFarm page as vFarm's own.
 */

const TABS = ['Farms', 'Incidents', 'Crop profiles'] as const;
type Tab = (typeof TABS)[number];

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const ago = (s: number | null) => (s === null ? '—' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

function StatePill({ state }: { state: MonitoringState | null }) {
  if (state === 'LIVE') return <Pill tone="ok">live</Pill>;
  if (state === 'STALE') return <Pill tone="degraded">stale</Pill>;
  if (state === 'OFFLINE') return <Pill tone="failing">offline</Pill>;
  if (state === 'NO_FEED') return <Pill tone="degraded">no feed</Pill>;
  if (state === 'NOT_WIRED') return <Pill>not wired</Pill>;
  if (state === 'GONE') return <Pill>gone</Pill>;
  return <Pill>not judged yet</Pill>;
}

function SimTag() {
  return <Pill tone="accent">simulated</Pill>;
}

export default function MonitoringTwin() {
  const [tab, setTab] = useState<Tab>('Farms');
  useReplayKey(tab);
  const { status, data: all, error } = useData(getMonitoringTwin, [], { kinds: ['monitoring_twin', 'vfarm_state'] });
  // One farm at a time when asked (24 Oct 2026, D5, Jegan's multi-farm filter), kept in the URL.
  const [params, setParams] = useSearchParams();
  const farm = params.get('farm');
  const setFarm = (v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set('farm', v);
    else next.delete('farm');
    setParams(next, { replace: true });
  };
  const data = useMemo(() => (all && farm ? { ...all, farms: all.farms.filter((f) => f.farm_id === farm) } : all), [all, farm]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Monitoring Twin"
        subtitle="What the twin sees on every vFarm farm: sensor state, crop stage, uptime and incidents"
        below={
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Tabs tabs={TABS} value={tab} onChange={setTab} counts={{ Incidents: data?.counts.open_incidents ? { n: data.counts.open_incidents } : undefined }} />
            {tab !== 'Crop profiles' && all && <FarmPicker value={farm} farms={all.farms} onChange={setFarm} />}
          </div>
        }
      />
      {status === 'loading' && !data ? (
        <Loading />
      ) : status === 'error' && !data ? (
        <LoadFailed error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pb-6 md:px-8">
          <Rules data={data} />
          {tab === 'Farms' ? <Farms data={data} /> : tab === 'Incidents' ? <Incidents data={data} /> : <Profiles data={data} />}
        </div>
      )}
    </div>
  );
}

function Rules({ data }: { data: MonitoringTwinData }) {
  const t = data.thresholds;
  return (
    <p className="text-[12px] text-dim">
      Judged on every vFarm snapshot and once a minute · live ≤ {t.stale_s} s, stale ≤ {t.offline_s} s, offline beyond (measured when vFarm looked) · no snapshot for {t.feed_silent_s / 60} min means no feed ·{' '}
      {data.counts.farms} real farm{data.counts.farms === 1 ? '' : 's'}, {data.counts.simulated_farms} simulated
    </p>
  );
}

function Farms({ data }: { data: MonitoringTwinData }) {
  if (data.farms.length === 0) {
    return (
      <EmptyState>
        No farm has been judged yet. The twin reads what vFarm posts to <code>/api/engine/vfarm-snapshot</code>; Jegan's first real snapshot is due Tue 6 Oct, once the rack is
        sensored. A simulated test rack can run through the same path before then.
      </EmptyState>
    );
  }
  const real = data.farms.filter((f) => !f.synthetic);
  return (
    <>
      {real.length === 0 && (
        <p className="text-[12.5px] text-dim">No real farm has sent a snapshot yet (Jegan's first is due Tue 6 Oct). Everything below is the simulated test rack.</p>
      )}
      {data.farms.map((f) => (
        <FarmCard key={f.farm_id} f={f} />
      ))}
      <ul className="list-disc pl-5 text-[11.5px] text-faint">
        {data.not_yet.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * The twin envelope in one line (3FP4): the cabinet, its config, burn-in, the
 * alert worker and where the incidents stand. A value vFarm has not sent says
 * so; it is never drawn as a dash that could read as a value. Colour only on
 * an unhealthy worker and on incidents needing a person.
 */
function EnvelopeLine({ e }: { e: NonNullable<MonitoringFarm['envelope']> }) {
  const burn = { not_started: 'not started', burn_in: 'in burn-in', passed: 'passed' } as const;
  const missing = <span className="text-faint">not sent by vFarm yet</span>;
  const r = e.retry_envelope;
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-dim">
      <span>Cabinet {e.cabinet_id ? <RecordId>{e.cabinet_id}</RecordId> : missing}</span>
      <span>Config {e.config_hash ? <RecordId>{e.config_hash}</RecordId> : missing}</span>
      <span>Burn-in {e.burn_in_state ? burn[e.burn_in_state] : missing}</span>
      <span title={e.worker_health.note}>
        Alert worker{' '}
        {e.worker_health.state === null ? missing : <span className={e.worker_health.state === 'unhealthy' ? 'text-degraded' : undefined}>{e.worker_health.state}</span>}
      </span>
      <span title={r.window}>
        Incidents: {r.self_healed} self-healed, {r.retrying} retrying, <span className={r.needs_human ? 'text-degraded' : undefined}>{r.needs_human} needing a person</span>
      </span>
    </p>
  );
}

function FarmCard({ f }: { f: MonitoringFarm }) {
  const live = f.state_counts.LIVE ?? 0;
  const judged = f.devices.filter((d) => d.state !== 'GONE').length;
  const offline = f.state_counts.OFFLINE ?? 0;
  const c = f.cycle;
  const targets = c?.stage?.targets ?? null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[16px] font-semibold text-ink">{f.name}</h2>
        {f.synthetic && <SimTag />}
        <span className="text-[11.5px] text-faint">
          <RecordId>{f.farm_id}</RecordId>
        </span>
        <span className={`text-[12px] ${f.feed.silent ? 'text-degraded' : 'text-dim'}`}>
          last snapshot {when(f.feed.last_snapshot_at)} UTC ({relativeTime(f.feed.last_snapshot_at) ?? '—'}){f.feed.silent ? (f.synthetic ? ' · the test is not running' : ' · the feed has stopped') : ''}
        </span>
      </div>
      {f.envelope && <EnvelopeLine e={f.envelope} />}
      <StatStrip cols={5} flush>
        <FigureCell label="Devices live" value={live} caption={`of ${judged} listed`} note="A reading at most 90 s old when vFarm last looked." />
        <FigureCell label="Offline" value={offline} tone={offline ? 'degraded' : undefined} caption="no reading for over 15 min" note="Each one is an INC-VFARM.SENSOR incident until it reads again." />
        <FigureCell label="Uptime" value={f.uptime.pct} unit="%" missing="Not enough observed time" caption={`over ${ago(f.uptime.observed_s)} observed`} note={f.uptime.note} />
        <FigureCell
          label="Crop day"
          value={c?.crop_day ?? null}
          missing={c ? (c.before_start ? 'Before transplant' : c.after_end ? 'Cycle complete' : 'No stage') : 'No cycle set'}
          caption={c?.stage ? `${c.stage.label ?? c.stage.stage} · days ${c.stage.from_day}–${c.stage.to_day}` : c ? `${c.crop}` : 'no crop cycle set'}
          note={c ? `${c.profile_id} v${c.profile_version}${c.time_scale !== 1 ? ` · clock ×${c.time_scale}` : ''}` : 'Set one with POST /api/engine/monitoring-cycle.'}
        />
        <FigureCell label="Open incidents" value={f.open_incidents.length} tone={f.open_incidents.length ? 'degraded' : undefined} caption={`${f.recent_incidents.length} closed in 7 days`} note="Opened once per fault, closed when it clears." />
      </StatStrip>
      {f.rover && 'runs_24h' in f.rover && f.rover.rover_devices.length > 0 && <RoverStrip r={f.rover} />}
      {f.rover && 'runs_24h' in f.rover && f.rover.passes?.value && f.rover.passes.value.length > 0 && <RoverPasses passes={f.rover.passes.value} note={f.rover.passes.note} />}
      {f.ledger_writes && <LedgerWrites w={f.ledger_writes} />}
      {f.feed_history && <FeedHistory h={f.feed_history} />}
      <Card className="pb-3">
        <CardHeader title="Devices" right={<span className="tabular text-[11.5px] text-faint">readings checked against the {c?.stage?.label ?? c?.stage?.stage ?? 'current'} stage</span>} />
        {f.devices.length === 0 ? (
          <EmptyState compact>vFarm lists no devices for this farm.</EmptyState>
        ) : (
          <TableFrame flat grow={false} label={`${f.name} devices`}>
            <thead>
              <tr>
                <Th>device</Th>
                <Th>where</Th>
                <Th>type</Th>
                <Th>state</Th>
                <Th>reading age</Th>
                <Th>last report</Th>
                <Th>readings against target</Th>
              </tr>
            </thead>
            <tbody>
              {f.devices.map((d) => (
                <tr key={d.device_id}>
                  <td className="td whitespace-nowrap">
                    <RecordId>{d.device_id}</RecordId>
                  </td>
                  <td className="td td-clip text-dim" style={{ maxWidth: '24ch' }} title={d.place ?? undefined}>
                    {d.place ?? <span className="text-faint">not placed</span>}
                  </td>
                  <td className="td text-dim">{[d.device_type, d.model].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="td whitespace-nowrap">
                    <StatePill state={d.state} />
                    {d.since && <span className="ml-1.5 text-[11px] text-faint">since {relativeTime(d.since) ?? '—'}</span>}
                  </td>
                  <td className="td tabular text-dim">{ago(d.age_s)}</td>
                  <td className="td tabular text-dim" title={d.last_seen_at ?? undefined}>
                    {d.last_seen_at ? (relativeTime(d.last_seen_at) ?? d.last_seen_at) : <span className="text-faint">not sent</span>}
                  </td>
                  <td className="td text-[12px]">
                    {d.checks.length === 0 ? (
                      <span className="text-faint">{d.state === 'LIVE' || d.state === 'STALE' ? (targets ? 'no reading with a target' : 'no stage targets') : 'not judged'}</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {d.checks.map((k) => (
                          <span key={k.metric} className={k.ok ? 'text-dim' : 'text-failing'} title={`${k.min ?? '−∞'} to ${k.max ?? '∞'}${k.unit ? ` ${k.unit}` : ''}`}>
                            {k.metric} {k.value}
                            {k.unit ? ` ${k.unit}` : ''} <span className="text-faint">({k.min ?? '−∞'}–{k.max ?? '∞'})</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </Card>
      {f.open_incidents.length > 0 && <IncidentTable rows={f.open_incidents} title="Open incidents" showFarm={false} />}
    </section>
  );
}

function IncidentTable({ rows, title, showFarm }: { rows: MonitoringIncident[]; title: string; showFarm: boolean }) {
  return (
    <Card className="pb-3">
      <CardHeader title={title} right={<span className="tabular text-[11.5px] text-faint">newest first</span>} />
      {rows.length === 0 ? (
        <EmptyState compact>None.</EmptyState>
      ) : (
        <TableFrame flat grow={false} label={title}>
          <thead>
            <tr>
              <Th>incident</Th>
              {showFarm && <Th>farm</Th>}
              <Th>device</Th>
              <Th>what</Th>
              <Th>stage</Th>
              <Th>opened (UTC)</Th>
              <Th>closed</Th>
              <Th>BHARAG ledger</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.incident_id}>
                <td className="td whitespace-nowrap">
                  <RecordId>{i.incident_id}</RecordId>
                  {i.synthetic && <span className="ml-1.5"><SimTag /></span>}
                </td>
                {showFarm && <td className="td text-dim">{i.farm_id}</td>}
                <td className="td text-dim">{i.device_id ?? '—'}</td>
                <td className="td td-clip" style={{ maxWidth: '52ch' }} title={i.detail}>
                  {i.detail}
                </td>
                <td className="td text-dim">{i.stage ?? '—'}</td>
                <td className="td tabular whitespace-nowrap text-dim">{when(i.opened_at)}</td>
                <td className="td whitespace-nowrap text-dim">{i.closed_at ? `${when(i.closed_at)} · ${i.close_reason ?? ''}` : <Pill tone="degraded">open</Pill>}</td>
                <td className="td whitespace-nowrap text-dim" title={i.ledger_error ?? undefined}>
                  <LedgerCell i={i} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </Card>
  );
}

/** Where the incident stands in BHARAG. A send that failed says so in red, with BHARAG's reason on hover. */
function LedgerCell({ i }: { i: MonitoringIncident }) {
  if (i.ledger_state === 'not_sent') return <span>not sent (before 3 Oct)</span>;
  if (i.ledger_state === 'pending')
    return i.ledger_error ? <span className="text-failing">not accepted yet · {i.ledger_error}</span> : <span>sending…</span>;
  return (
    <span>
      {i.ledger_id ? <RecordId>{i.ledger_id}</RecordId> : '—'} · {i.ledger_state}
      {i.ledger_error && <span className="ml-1 text-failing">· {i.ledger_error}</span>}
    </span>
  );
}

function Incidents({ data }: { data: MonitoringTwinData }) {
  const open = data.farms.flatMap((f) => f.open_incidents);
  const closed = data.farms.flatMap((f) => f.recent_incidents).sort((a, b) => (b.opened_at > a.opened_at ? 1 : -1));
  return (
    <>
      <IncidentTable rows={open} title="Open" showFarm />
      <IncidentTable rows={closed} title="Closed in the last 7 days" showFarm />
      <p className="px-1 text-[12px] text-faint">{data.ledger?.note}</p>
    </>
  );
}

function Profiles({ data }: { data: MonitoringTwinData }) {
  if (data.profiles.length === 0) return <EmptyState>No crop profile is held yet. Post one to /api/engine/monitoring-profile.</EmptyState>;
  return (
    <>
      {data.profiles.map((p) => {
        const cur = p.versions[0];
        const metrics = [...new Set(cur.stages.flatMap((s) => Object.keys(s.targets)))];
        return (
          <section key={p.profile_id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-[16px] font-semibold text-ink">{p.profile_id}</h2>
              <span className="text-[12px] text-dim">
                {p.crop} · v{p.current_version} in force
              </span>
            </div>
            <Card className="pb-3">
              <CardHeader title={`Stage targets, v${cur.version}`} right={<span className="text-[11.5px] text-faint">days after transplant</span>} />
              <TableFrame flat grow={false} label="Stage targets">
                <thead>
                  <tr>
                    <Th>stage</Th>
                    <Th>days</Th>
                    {metrics.map((m) => (
                      <Th key={m}>{m.replace('_', ' ')}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cur.stages.map((s) => (
                    <tr key={s.stage}>
                      <td className="td">{s.label ?? s.stage}</td>
                      <td className="td tabular text-dim">
                        {s.from_day}–{s.to_day}
                      </td>
                      {metrics.map((m) => {
                        const r = s.targets[m];
                        return (
                          <td key={m} className="td tabular text-dim" title={[r?.source, r?.note].filter(Boolean).join(' · ') || undefined}>
                            {!r ? '—' : r.min === null && r.max === null ? <span className="text-faint">not set</span> : `${r.min ?? '−∞'}–${r.max ?? '∞'}${r.unit ? ` ${r.unit}` : ''}`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </TableFrame>
            </Card>
            <Card className="pb-3">
              <CardHeader title="Every version" right={<span className="text-[11.5px] text-faint">a change is a new version with its reason; none is edited in place</span>} />
              <TableFrame flat grow={false} label="Profile versions">
                <thead>
                  <tr>
                    <Th>version</Th>
                    <Th>reason</Th>
                    <Th>by</Th>
                    <Th>when (UTC)</Th>
                  </tr>
                </thead>
                <tbody>
                  {p.versions.map((v) => (
                    <tr key={v.version}>
                      <td className="td tabular">v{v.version}</td>
                      <td className="td">{v.reason}</td>
                      <td className="td text-dim">{v.changed_by ?? '—'}</td>
                      <td className="td tabular text-dim">{when(v.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableFrame>
              {cur.sources.length > 0 && (
                <ul className="list-disc px-6 pt-3 pl-9 text-[11.5px] text-faint">
                  {cur.sources.map((s, i) => (
                    <li key={i}>{typeof s === 'string' ? s : JSON.stringify(s)}</li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        );
      })}
    </>
  );
}

/**
 * The six rover signals (24 Oct 2026, D5). Readings, not verdicts: no limits are agreed yet, so
 * nothing is coloured as a fault. A signal vFarm does not send yet says so instead of a number.
 */
function RoverStrip({ r }: { r: MonitoringRover }) {
  const hb = r.heartbeat_age_s.value ?? [];
  const worst = hb.reduce<number | null>((m, x) => (x.age_s === null ? m : m === null ? x.age_s : Math.max(m, x.age_s)), null);
  const runs = r.runs_24h.value;
  const dur = r.run_duration_vs_expected.value;
  const stops = r.stops_without_frame_24h.value;
  const up = r.upload_backlog.value;
  return (
    <StatStrip cols={6} flush>
      <FigureCell label="Rover heartbeat" value={worst} unit="s ago" missing="Never seen" caption={`${hb.length} rover${hb.length === 1 ? '' : 's'}`} note={r.heartbeat_age_s.note} />
      <FigureCell label="Runs, 24 h" value={runs ? runs.completed : null} caption={runs ? `${runs.started} started · ${runs.failed} failed · ${runs.expected ?? '?'} expected` : ''} note={r.runs_24h.note} />
      <FigureCell label="Run time" value={dur?.median_s != null ? Math.round(dur.median_s / 60) : null} unit="min" missing="No complete run" caption={dur?.expected_s != null ? `budget ${ago(dur.expected_s)} · ${dur.over_expected ?? 0} over` : 'budget not sent yet'} note={r.run_duration_vs_expected.note} />
      <FigureCell label="Limit hits, 24 h" value={r.limit_hit_24h.value} missing="Not sent yet" note={r.limit_hit_24h.note} />
      <FigureCell label="Stops with no frame" value={stops ? stops.without_frame : null} caption={stops ? `of ${stops.stops} stops` : ''} note={r.stops_without_frame_24h.note} />
      <FigureCell label={r.run_source === 'passes' ? 'Photos not sent' : 'Upload backlog'} value={up ? up.waiting : null} caption={up?.oldest_age_s != null ? `oldest ${ago(up.oldest_age_s)}${up.failed ? ` · ${up.failed} failed` : ''}` : up?.failed ? `${up.failed} failed` : 'nothing waiting'} note={r.upload_backlog.note} />
    </StatStrip>
  );
}

/**
 * vFarm's ledger lanes (28 Oct 2026, D3 — Kavin's rover log of 26 Oct, NAFB). BHARAG can answer
 * "accepted" and write nothing; the lane counts what was really written and the snapshot says so.
 * A refused entry is the one coloured cell, and it has an incident beside it. Until vFarm sends the
 * report the card says so in words rather than drawing an empty table that reads as all clear.
 */
function LedgerWrites({ w }: { w: NonNullable<MonitoringFarm['ledger_writes']> }) {
  return (
    <Card className="pb-3">
      <CardHeader title="Ledger writes" right={<span className="tabular text-[11.5px] text-faint">{w.taken_at ? `newest report ${relativeTime(w.taken_at) ?? ''}` : 'no report yet'}</span>} />
      {w.lanes.length === 0 ? (
        <EmptyState compact>{w.note}</EmptyState>
      ) : (
        <>
          <TableFrame flat grow={false} label="Ledger writes by lane">
            <thead>
              <tr>
                <Th>lane</Th>
                <Th>sent</Th>
                <Th>written</Th>
                <Th>refused</Th>
                <Th>why</Th>
                <Th>last pass</Th>
              </tr>
            </thead>
            <tbody>
              {w.lanes.map((l) => (
                <tr key={l.lane}>
                  <td className="td">
                    {l.lane}
                    {l.corpus && <span className="ml-1.5 text-[11px] text-faint">{l.corpus}</span>}
                  </td>
                  <td className="td tabular">{l.sent}</td>
                  <td className="td tabular">{l.written}</td>
                  <td className="td tabular">{l.refused > 0 ? <Pill tone="failing">{l.refused}</Pill> : 0}</td>
                  <td className="td text-[12px] text-dim">{l.reasons.length ? l.reasons.map((r) => `${r.code} ×${r.count}`).join(', ') : '—'}</td>
                  <td className="td tabular text-dim">{relativeTime(l.last_pass_at) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <p className="px-4 pt-2 text-[11.5px] text-faint">{w.note}</p>
        </>
      )}
    </Card>
  );
}

const metres = (mm: number | null) => (mm === null ? '—' : `${(mm / 1000).toFixed(mm % 1000 === 0 ? 1 : 2)} m`);
const STOP_REASON: Record<string, string> = {
  snapshot_failed: 'camera failed',
  move_failed: 'could not reach',
  pass_aborted: 'not driven to',
  no_movement: 'motor stalled',
};

/**
 * The rover's passes (28 Oct 2026, D3 — Kavin's rover log of 26 Oct, H1VM): each scheduled pass as
 * vFarm summarises it, the same facts its own ledger lane writes, so the dashboard and the ledger
 * cannot tell a farmer two different distances. A failed pass and one needing a manual check are
 * the only coloured rows; a complete pass is the normal state and carries no colour.
 */
function RoverPasses({ passes, note }: { passes: MonitoringRoverPass[]; note: string }) {
  return (
    <Card className="pb-3">
      <CardHeader title="Rover passes" right={<span className="tabular text-[11.5px] text-faint">newest first · last 8 days</span>} />
      <TableFrame flat grow={false} label="Rover passes">
        <thead>
          <tr>
            <Th>ended</Th>
            <Th>rover</Th>
            <Th>result</Th>
            <Th>stops</Th>
            <Th>distance</Th>
            <Th>photos sent</Th>
            <Th>ended at</Th>
            <Th>took</Th>
            <Th>failed stops</Th>
          </tr>
        </thead>
        <tbody>
          {passes.map((p) => {
            const failed = p.status === 'failed';
            return (
              <tr key={p.id}>
                <td className="td tabular">
                  {when(p.ended_at ?? p.started_at)}
                  <span className="ml-1.5 text-[11px] text-faint">{relativeTime(p.ended_at ?? p.started_at) ?? ''}</span>
                </td>
                <td className="td">
                  {p.device_id ?? '—'}
                  {p.place && <span className="ml-1.5 text-[11px] text-faint">{p.place}</span>}
                </td>
                <td className="td">
                  {failed ? <Pill tone="failing">failed</Pill> : <span>{p.status ?? '—'}</span>}
                  {p.needs_manual_check && <span className="ml-1.5"><Pill tone="degraded">needs a check</Pill></span>}
                </td>
                <td className="td tabular">{p.stops_done ?? '—'} / {p.stops_planned ?? '—'}</td>
                <td className="td tabular">{metres(p.distance_mm)}</td>
                <td className="td tabular">
                  {p.images_sent ?? '—'} / {p.images_taken ?? '—'}
                  {p.images_not_sent > 0 && <span className="ml-1.5 text-[11px] text-degraded">{p.images_not_sent} not sent</span>}
                </td>
                <td className="td tabular">
                  {p.returned_home ? 'home' : p.position_known === false ? <span className="text-degraded">unknown</span> : metres(p.position_mm)}
                </td>
                <td className="td tabular">{ago(p.duration_s)}</td>
                <td className="td text-[12px]">
                  {p.failed_stops.length === 0
                    ? <span className="text-faint">none</span>
                    : p.failed_stops.map((f) => `stop ${String(f.seq)}: ${f.reason ? (STOP_REASON[f.reason] ?? f.reason) : 'failed'}`).join(' · ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableFrame>
      <p className="px-4 pt-2 text-[11.5px] text-faint">{note}</p>
    </Card>
  );
}

const SECTION_LABEL: Record<string, string> = {
  readings: 'Readings',
  rover_runs: 'Rover runs',
  rover_passes: 'Rover passes',
  rover_stops: 'Rover stops',
  rover_detections: 'Flower detections',
  rover_videos: 'Run videos',
  vision_frames: 'Camera frames',
  automation_events: 'Automation (relay, drain)',
  device_commands: 'Commands',
  device_events: 'Device events',
  alert_changes: 'Alerts opened and cleared',
  alert_firings: 'Alert firings',
  layout_zones: 'Rooms',
  layout_locations: 'Cabinets',
  layout_sublocations: 'Trays, rails, reservoirs',
  rover_schedules: 'Rover schedules',
  rover_settings: 'Rover settings',
  rover_rail_map: 'Rail map',
};

/** What else vFarm sent for this farm, by section, and anything its newest snapshot marked truncated or failed. */
function FeedHistory({ h }: { h: NonNullable<MonitoringFarm['feed_history']> }) {
  const rep = h.last_report;
  const problems = rep ? [...rep.truncated.map((s) => `${SECTION_LABEL[s] ?? s} cut short, continues next tick`), ...Object.entries(rep.errors).map(([s, e]) => `${SECTION_LABEL[s] ?? s} not read: ${e}`), ...Object.entries(rep.refused).map(([s, n]) => `${n} ${SECTION_LABEL[s] ?? s} row${n === 1 ? '' : 's'} refused`)] : [];
  return (
    <Card className="pb-3">
      <CardHeader title="What vFarm sends" right={<span className="tabular text-[11.5px] text-faint">{rep ? `newest report ${relativeTime(rep.taken_at) ?? ''}` : 'held from 24 Oct 2026'}</span>} />
      {!h.sections || h.sections.length === 0 ? (
        <EmptyState compact>{h.sections ? 'vFarm has not sent any history for this farm yet. Only its current state arrives.' : h.note}</EmptyState>
      ) : (
        <TableFrame flat grow={false} label="vFarm history by section">
          <thead>
            <tr>
              <Th>section</Th>
              <Th>last 24 h</Th>
              <Th>held</Th>
              <Th>newest</Th>
            </tr>
          </thead>
          <tbody>
            {h.sections.map((x) => (
              <tr key={x.section}>
                <td className="td">{SECTION_LABEL[x.section] ?? x.section}</td>
                <td className="td tabular">{x.last_24h}</td>
                <td className="td tabular text-dim">{x.rows}</td>
                <td className="td tabular text-dim">{relativeTime(x.latest_at) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
      {problems.length > 0 && <p className="px-4 pt-2 text-[12px] text-degraded">{problems.join(' · ')}</p>}
    </Card>
  );
}
