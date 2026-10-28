/**
 * Everything vFarm records, as the dashboard holds it (24 Oct 2026, Destiny — D5).
 *
 * The snapshot's `history`, `layout` and `rover_config` blocks land in engine_vfarm_history
 * (migration 91, systemFeeds.storeHistory). This file reads them back: a per-farm summary for
 * the Monitoring Twin read, the six rover signals Jegan and Kavin's rover plan needs watched,
 * and the rows themselves for `read_vfarm_history`.
 *
 * Nothing here judges or opens an incident. A signal whose input vFarm does not send yet says
 * "not sent by vFarm yet" and is null, never zero: a zero and an unknown must never look alike.
 */
import { query } from './pg';

type Obj = Record<string, unknown>;
type Queryable = { query: typeof query };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const NOT_SENT = 'not sent by vFarm yet';
export const DAY_MS = 24 * 3600 * 1000;

/** Which sections a farm holds, how many rows in the last 24 h and in all, and the newest. */
export interface SectionCount {
  section: string;
  rows: number;
  last_24h: number;
  latest_at: string | null;
}

export async function historyByFarm(db: Queryable = { query }): Promise<Map<string, SectionCount[]> | null> {
  try {
    const r = await db.query<{ farm_id: string; section: string; rows: string; last_24h: string; latest_at: string | null }>(
      `SELECT farm_id, section, count(*)::text AS rows,
              count(*) FILTER (WHERE at > now() - interval '24 hours')::text AS last_24h,
              to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS latest_at
         FROM engine_vfarm_history WHERE gone_at IS NULL AND farm_id IS NOT NULL
        GROUP BY farm_id, section ORDER BY farm_id, section`,
    );
    const m = new Map<string, SectionCount[]>();
    for (const x of r.rows) {
      const list = m.get(x.farm_id) ?? [];
      list.push({ section: x.section, rows: Number(x.rows), last_24h: Number(x.last_24h), latest_at: x.latest_at });
      m.set(x.farm_id, list);
    }
    return m;
  } catch {
    return null;
  }
}

/** What the newest real snapshot said about its history block: truncated or failed sections are shown, never hidden. */
export async function lastHistoryReport(db: Queryable = { query }): Promise<{ taken_at: string; truncated: string[]; errors: Record<string, string>; refused: Record<string, number> } | null> {
  try {
    const r = await db.query<{ taken_at: string; history: unknown }>(
      `SELECT to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at, history
         FROM engine_vfarm_snapshots WHERE synthetic = false AND history IS NOT NULL ORDER BY taken_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row || !isObj(row.history)) return null;
    const secs = isObj(row.history.sections) ? row.history.sections : {};
    const truncated: string[] = [];
    const refused: Record<string, number> = {};
    for (const [k, v] of Object.entries(secs)) {
      if (!isObj(v)) continue;
      if (v.truncated === true) truncated.push(k);
      if (Number(v.refused) > 0) refused[k] = Number(v.refused);
    }
    const errors: Record<string, string> = {};
    if (isObj(row.history.errors)) for (const [k, v] of Object.entries(row.history.errors)) errors[k] = String(v);
    return { taken_at: row.taken_at, truncated, errors, refused };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ rover signals */

export interface RoverInputs {
  now: number;
  /** Devices of the farm that are rovers (by type or id), with their stored presence. */
  rovers: Array<{ device_id: string; status: string | null; last_seen_at: string | null }>;
  runs: Obj[];
  stops: Obj[];
  videos: Obj[];
  schedules: Obj[];
  /**
   * The rover's scheduled passes (28 Oct 2026, D3): vFarm's `rover_passes` section, one row per
   * pass with rover_pass.summarize's facts (stops, distance, photos, where it ended), the same
   * function vFarm's own ledger lane uses. Optional: older callers send none.
   */
  passes?: Obj[];
}

/** One rover pass as the twin shows it: vFarm's own facts, nothing worked out here but the duration. */
export interface RoverPass {
  id: string;
  device_id: string | null;
  place: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  stops_done: number | null;
  stops_planned: number | null;
  distance_mm: number | null;
  images_taken: number | null;
  images_sent: number | null;
  images_not_sent: number;
  failed_stops: Array<{ seq: unknown; reason: string | null }>;
  position_mm: number | null;
  position_known: boolean | null;
  returned_home: boolean | null;
  needs_manual_check: boolean | null;
  edge_version: string | null;
}

export interface RoverSignal<T> {
  value: T | null;
  note: string;
}

export interface RoverSignals {
  rover_devices: string[];
  heartbeat_age_s: RoverSignal<Array<{ device_id: string; age_s: number | null; status: string | null }>>;
  runs_24h: RoverSignal<{ expected: number | null; started: number; completed: number; failed: number; in_progress: number }>;
  run_duration_vs_expected: RoverSignal<{ runs: number; median_s: number | null; max_s: number | null; expected_s: number | null; over_expected: number | null }>;
  limit_hit_24h: RoverSignal<number>;
  stops_without_frame_24h: RoverSignal<{ stops: number; without_frame: number }>;
  upload_backlog: RoverSignal<{ waiting: number; failed: number; oldest_age_s: number | null }>;
  /** The newest passes, newest first (at most 20 over the last 8 days). Null when vFarm sends none. */
  passes: RoverSignal<RoverPass[]>;
  /** Where the run figures came from: vFarm's run rows, its pass summaries, or nothing. */
  run_source: 'runs' | 'passes' | 'none';
  thresholds: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const metaOf = (r: Obj): Obj => (isObj(r.meta) ? r.meta : {});
/** A run's own time budget, where vFarm sends one (Kavin's per-run budget, Sun 25 Oct). */
const budgetOf = (r: Obj): number | null => {
  const m = metaOf(r);
  for (const k of ['time_budget_s', 'budget_s', 'max_duration_s', 'expected_duration_s']) {
    const v = Number((m as Obj)[k] ?? (r as Obj)[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
};
/** A run that ended on its limit or budget, where vFarm says so. Null when the run carries no such field. */
const limitHitOf = (r: Obj): boolean | null => {
  const m = metaOf(r);
  if (typeof m.limit_hit === 'boolean') return m.limit_hit;
  if (typeof r.limit_hit === 'boolean') return r.limit_hit as boolean;
  const reason = String(m.end_reason ?? m.stop_reason ?? r.end_reason ?? '').toLowerCase();
  if (!reason) return null;
  return /limit|timeout|budget/.test(reason);
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const failedStopsOf = (p: Obj): Array<{ seq: unknown; reason: string | null }> =>
  Array.isArray(p.failed_stops) ? p.failed_stops.filter(isObj).map((f) => ({ seq: f.seq ?? null, reason: str(f.reason) })) : [];

/** One pass row as vFarm sent it, in the twin's shape. */
export function passOf(p: Obj): RoverPass {
  const a = ms(p.started_at);
  const b = ms(p.ended_at);
  return {
    id: String(p.id ?? ''),
    device_id: str(p.device_id),
    place: str(p.place),
    status: str(p.status),
    started_at: str(p.started_at),
    ended_at: str(p.ended_at),
    duration_s: a !== null && b !== null && b >= a ? Math.round((b - a) / 1000) : null,
    stops_done: num(p.stops_done),
    stops_planned: num(p.stops_planned),
    distance_mm: num(p.distance_mm),
    images_taken: num(p.images_taken),
    images_sent: num(p.images_sent),
    images_not_sent: Array.isArray(p.images_not_sent) ? p.images_not_sent.length : 0,
    failed_stops: failedStopsOf(p),
    position_mm: num(p.position_mm),
    position_known: bool(p.position_known),
    returned_home: bool(p.returned_home),
    needs_manual_check: bool(p.needs_manual_check),
    edge_version: str(p.edge_version),
  };
}

/** The six rover signals, pure. Thresholds are not set: these are readings, not verdicts. */
export function roverSignals(x: RoverInputs): RoverSignals {
  const since = x.now - DAY_MS;
  const inDay = (v: unknown) => {
    const t = ms(v);
    return t !== null && t > since && t <= x.now + 60_000;
  };
  // vFarm's run rows win where it sends them; otherwise its pass summaries stand in (28 Oct 2026):
  // a pass is one scheduled run, with the same status, start and end. The note says which.
  const passes = x.passes ?? [];
  const runSource: RoverSignals['run_source'] = x.runs.length ? 'runs' : passes.length ? 'passes' : 'none';
  const runRows = runSource === 'passes' ? passes : x.runs;
  const fromPasses = runSource === 'passes' ? ' Counted from the rover\'s pass summaries (vFarm sends passes, not run rows).' : '';
  const runs = runRows.filter((r) => inDay(r.started_at) || inDay(r.ended_at) || inDay(r.updated_at));
  const started = runRows.filter((r) => inDay(r.started_at));
  const status = (r: Obj) => String(r.status ?? '').toLowerCase();

  const heartbeat = x.rovers.map((d) => {
    const t = ms(d.last_seen_at);
    return { device_id: d.device_id, age_s: t === null ? null : Math.max(0, Math.round((x.now - t) / 1000)), status: d.status };
  });

  const enabled = x.schedules.filter((s) => s.enabled !== false && Number(s.interval_minutes) > 0);
  const expected = enabled.length ? enabled.reduce((n, s) => n + Math.floor(1440 / Number(s.interval_minutes)), 0) : null;

  const done = runs.filter((r) => status(r) === 'complete' && ms(r.started_at) !== null && ms(r.ended_at) !== null);
  const durations = done.map((r) => Math.max(0, Math.round(((ms(r.ended_at) as number) - (ms(r.started_at) as number)) / 1000)));
  const budgets = done.map(budgetOf).filter((v): v is number => v !== null);
  const expectedS = budgets.length ? median(budgets) : null;
  const over = expectedS === null ? null : done.filter((r, i) => durations[i] > (budgetOf(r) ?? expectedS)).length;

  const limitFlags = runs.map(limitHitOf);
  const limitKnown = limitFlags.some((v) => v !== null);

  const stops = x.stops.filter((s) => inDay(s.arrived_at) && (s.left_at !== null && s.left_at !== undefined));
  const noFrame = stops.filter((s) => s.snapshot_key === null || s.snapshot_key === undefined || s.snapshot_key === '');
  // Without stop rows, a pass still says it: a stop is reached when it is done or failed only on
  // its camera (snapshot_failed), and that camera failure is the stop with no frame.
  const dayPasses = passes.filter((p) => inDay(p.started_at) || inDay(p.ended_at));
  const passStops = dayPasses.reduce((n, p) => n + (num(p.stops_done) ?? 0) + failedStopsOf(p).filter((f) => f.reason === 'snapshot_failed').length, 0);
  const passNoFrame = dayPasses.reduce((n, p) => n + failedStopsOf(p).filter((f) => f.reason === 'snapshot_failed').length, 0);
  const stopsFromPasses = !x.stops.length && dayPasses.length > 0;
  const unsent = dayPasses.filter((p) => Array.isArray(p.images_not_sent) && p.images_not_sent.length > 0);
  const backlogFromPasses = !x.videos.length && dayPasses.length > 0;
  const recent = [...passes]
    .filter((p) => { const t = ms(p.ended_at) ?? ms(p.started_at) ?? ms(p.at); return t !== null && t > x.now - 8 * DAY_MS; })
    .sort((p, q) => (ms(q.ended_at) ?? ms(q.started_at) ?? 0) - (ms(p.ended_at) ?? ms(p.started_at) ?? 0))
    .slice(0, 20)
    .map(passOf);

  const waiting = x.videos.filter((v) => String(v.upload_state ?? '') === 'pending');
  const failedVideos = x.videos.filter((v) => String(v.upload_state ?? '') === 'failed');
  const oldest = waiting.map((v) => ms(v.created_at) ?? ms(v.at)).filter((v): v is number => v !== null);

  return {
    rover_devices: x.rovers.map((d) => d.device_id),
    heartbeat_age_s: x.rovers.length
      ? { value: heartbeat, note: 'Seconds since vFarm last saw each rover (its stored last_seen_at), with its stored status. Presence is vFarm\'s rule, not worked out here.' }
      : { value: null, note: 'No rover device is listed for this farm.' },
    runs_24h: {
      value: {
        expected,
        started: started.length,
        completed: runs.filter((r) => status(r) === 'complete').length,
        failed: runs.filter((r) => status(r) === 'failed').length,
        in_progress: runs.filter((r) => ['recording', 'uploading'].includes(status(r))).length,
      },
      note: (expected === null
        ? 'Runs in the last 24 h by status. No enabled rover schedule is sent, so the expected count is unknown.'
        : 'Runs in the last 24 h by status; expected is 1,440 minutes over each enabled schedule\'s interval, summed.') + fromPasses,
    },
    run_duration_vs_expected: {
      value: { runs: done.length, median_s: median(durations), max_s: durations.length ? Math.max(...durations) : null, expected_s: expectedS, over_expected: over },
      note: (expectedS === null
        ? `Durations of complete runs in the last 24 h. The expected duration (a run's time budget) is ${NOT_SENT}, so nothing is compared.`
        : 'Durations of complete runs in the last 24 h against each run\'s own time budget.') + fromPasses,
    },
    limit_hit_24h: limitKnown
      ? { value: limitFlags.filter((v) => v === true).length, note: 'Runs in the last 24 h that ended on their limit or time budget, as vFarm marks them.' }
      : { value: null, note: `Whether a run ended on its limit is ${NOT_SENT} (no run carries limit_hit or an end reason).` },
    stops_without_frame_24h: stopsFromPasses
      ? { value: { stops: passStops, without_frame: passNoFrame }, note: 'Stops the rover reached in the last 24 h, from its pass summaries, and those where only the camera failed (snapshot_failed), so no photo was taken.' }
      : { value: { stops: stops.length, without_frame: noFrame.length }, note: 'Finished stops in the last 24 h, and those with no frame stored for them (no snapshot_key).' },
    upload_backlog: backlogFromPasses
      ? (() => {
          const t = unsent.map((p) => ms(p.ended_at) ?? ms(p.started_at)).filter((v): v is number => v !== null);
          return {
            value: { waiting: unsent.reduce((n, p) => n + (p.images_not_sent as unknown[]).length, 0), failed: 0, oldest_age_s: t.length ? Math.round((x.now - Math.min(...t)) / 1000) : null },
            note: 'Photos taken in the last 24 h that the pass reports as not sent yet, from its pass summaries, and how long ago the oldest such pass ended. vFarm sends no run videos, so none are counted.',
          };
        })()
      : {
          value: { waiting: waiting.length, failed: failedVideos.length, oldest_age_s: oldest.length ? Math.round((x.now - Math.min(...oldest)) / 1000) : null },
          note: 'Run videos vFarm still holds as pending upload, the oldest one\'s age, and those marked failed.',
        },
    passes: passes.length
      ? { value: recent, note: 'The rover\'s scheduled passes as vFarm summarises them (stops, distance, photos, where it ended), newest first, at most 20 over the last 8 days. The same facts vFarm writes to its own ledger.' }
      : { value: null, note: `Rover pass summaries are ${NOT_SENT} for this farm.` },
    run_source: runSource,
    thresholds: 'None set yet. These are readings for the twin to show; no incident opens on them until the limits are agreed.',
  };
}

/** The inputs for one farm, read from the history table and the devices table. */
export async function roverInputs(farmId: string, devices: Array<{ device_id: string; device_type: string | null; status: string | null; last_seen_at: string | null }>, db: Queryable = { query }): Promise<RoverInputs | null> {
  try {
    const r = await db.query<{ section: string; row: Obj }>(
      `SELECT section, row FROM engine_vfarm_history
        WHERE farm_id = $1 AND gone_at IS NULL
          AND (section IN ('rover_schedules') OR (section IN ('rover_runs', 'rover_stops', 'rover_videos', 'rover_passes') AND (at IS NULL OR at > now() - interval '8 days')))`,
      [farmId],
    );
    const by = (s: string) => r.rows.filter((x) => x.section === s).map((x) => x.row);
    const runs = by('rover_runs');
    const passes = by('rover_passes');
    const runDevices = new Set([...runs, ...passes].map((x) => String(x.device_id ?? '')).filter(Boolean));
    const rovers = devices.filter((d) => /rover/i.test(d.device_type ?? '') || /rover/i.test(d.device_id) || runDevices.has(d.device_id));
    return { now: Date.now(), rovers: rovers.map((d) => ({ device_id: d.device_id, status: d.status, last_seen_at: d.last_seen_at })), runs, stops: by('rover_stops'), videos: by('rover_videos'), schedules: by('rover_schedules'), passes };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ rows, for the read tool */

export async function readRows(opts: { farm_ids: string[]; section: string; since?: string | null; until?: string | null; device_id?: string | null; limit: number; include_gone?: boolean }, db: Queryable = { query }) {
  const params: unknown[] = [opts.farm_ids, opts.section];
  const where = [`farm_id = ANY($1::text[])`, `section = $2`];
  if (!opts.include_gone) where.push('gone_at IS NULL');
  if (opts.since) { params.push(opts.since); where.push(`at >= $${params.length}::timestamptz`); }
  if (opts.until) { params.push(opts.until); where.push(`at <= $${params.length}::timestamptz`); }
  if (opts.device_id) { params.push(opts.device_id); where.push(`device_id = $${params.length}`); }
  const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_vfarm_history WHERE ${where.join(' AND ')}`, params);
  params.push(opts.limit);
  const rows = await db.query<{ source_id: string; farm_id: string; device_id: string | null; at: string | null; row: Obj; gone_at: string | null }>(
    `SELECT source_id, farm_id, device_id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, row,
            to_char(gone_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS gone_at
       FROM engine_vfarm_history WHERE ${where.join(' AND ')} ORDER BY at DESC NULLS LAST, source_id LIMIT $${params.length}`,
    params,
  );
  return { matched: Number(count.rows[0]?.n ?? 0), rows: rows.rows };
}

export async function readReadings(opts: { farm_ids: string[]; since?: string | null; until?: string | null; device_id?: string | null; metric?: string | null; limit: number }, db: Queryable = { query }) {
  const params: unknown[] = [opts.farm_ids];
  const where = ['farm_id = ANY($1::text[])', 'synthetic = false'];
  if (opts.since) { params.push(opts.since); where.push(`read_at >= $${params.length}::timestamptz`); }
  if (opts.until) { params.push(opts.until); where.push(`read_at <= $${params.length}::timestamptz`); }
  if (opts.device_id) { params.push(opts.device_id); where.push(`device_id = $${params.length}`); }
  if (opts.metric) { params.push(opts.metric); where.push(`metric = $${params.length}`); }
  const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_vfarm_readings WHERE ${where.join(' AND ')}`, params);
  params.push(opts.limit);
  const rows = await db.query(
    `SELECT farm_id, device_id, metric, value, unit, status, to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at
       FROM engine_vfarm_readings WHERE ${where.join(' AND ')} ORDER BY read_at DESC LIMIT $${params.length}`,
    params,
  );
  return { matched: Number(count.rows[0]?.n ?? 0), rows: rows.rows };
}
