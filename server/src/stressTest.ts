/**
 * The engine side of the vFarm stress test (10 Nov 2026, Destiny — LOOP-1794168643405-SK22).
 *
 * Jason's stress test on Fri 13 Nov has two halves. Jegan owns the front half (every sensor
 * reads, the cabinet's computer stays connected, the farm stores and hands back the latest
 * reading: LOOP-1794168643166-RS77). This is the engine half, and the loop asks that it be run
 * "from a written checklist so every run is the same, and record the result". So it is one
 * function with four fixed checks, and its numbers live in `RULE` and nowhere else:
 *
 *   1. on_time         every snapshot and reading the farm sends lands here on time;
 *   2. state_correct   the Monitoring Twin marks each sensor live or stale as the stored feed says;
 *   3. one_alert       a sensor going quiet opens one incident and closes it when it comes back;
 *   4. nothing_old_live nothing old is ever shown as live.
 *
 * Checks 2 to 4 are the conditions of UN9D Tests 1 and 2 (un9d.ts), judged on the same rows, so
 * the stress test and UN9D can never disagree about the same farm. Check 1 is new: the gaps
 * between snapshots, the time a snapshot takes to arrive, and the lag of each stored reading,
 * over the run's window. Each check is pass, fail or not_yet_possible with its reason; the run
 * passes only when all four do. The result is one `stress_test_engine_checked` event.
 * It reads and records; it changes no farm, device or incident. `npm run test:stress-test`.
 */
import { query } from './db';
import * as engineEvents from './engineEvents';
import * as monitoringTwin from './monitoringTwin';
import * as un9d from './un9d';

export const RULE = {
  /** A gap between two snapshots longer than this means the feed went silent (the twin's own line). */
  snapshot_gap_max_s: monitoringTwin.THRESHOLDS.feed_silent_s,
  /** vFarm pushes a snapshot every 3 minutes. */
  snapshot_every_s: 180,
  /** 95% of snapshots arrive within this many seconds of being taken. */
  transit_p95_max_s: 60,
  /** 95% of stored readings arrive within this many seconds of being read. */
  reading_lag_p95_max_s: 300,
  /** No stored reading arrives later than this (the twin's offline line). */
  reading_lag_max_s: monitoringTwin.THRESHOLDS.offline_s,
  window_default_min: 60,
  window_max_min: 24 * 60,
} as const;

export interface Timing {
  window_min: number;
  snapshots: number;
  /** Seconds between consecutive snapshots in the window, oldest first. */
  gaps_s: number[];
  /** Seconds since the newest snapshot, at the time of the run. */
  last_snapshot_age_s: number | null;
  transit_p95_s: number | null;
  transit_max_s: number | null;
  readings: number;
  reading_devices: number;
  reading_lag_p95_s: number | null;
  reading_lag_max_s: number | null;
}

export type Verdict = un9d.Verdict;
export interface Check { id: string; check: string; verdict: Verdict; reason: string; from: string[] }

const C = (id: string, check: string, verdict: Verdict, reason: string, from: string[]): Check => ({ id, check, verdict, reason, from });
const r1 = (n: number | null) => (n == null ? 'none' : `${Math.round(n)} s`);

/** Check 1, from the timing over the window. Pure. */
export function onTime(t: Timing): Check {
  const label = 'Every reading the farm sends lands on the dashboard on time';
  if (!t.snapshots) return C('on_time', label, 'not_yet_possible', `No snapshot arrived in the last ${t.window_min} min, so there is nothing to time. If the farm is meant to be sending, that is a silent feed.`, ['snapshots']);
  const bad: string[] = [];
  const longGaps = t.gaps_s.filter((g) => g > RULE.snapshot_gap_max_s);
  if (longGaps.length) bad.push(`${longGaps.length} gap(s) between snapshots over ${RULE.snapshot_gap_max_s} s (longest ${Math.round(Math.max(...longGaps))} s)`);
  if (t.last_snapshot_age_s != null && t.last_snapshot_age_s > RULE.snapshot_gap_max_s) bad.push(`the newest snapshot is ${Math.round(t.last_snapshot_age_s)} s old`);
  if (t.transit_p95_s != null && t.transit_p95_s > RULE.transit_p95_max_s) bad.push(`95% of snapshots took up to ${Math.round(t.transit_p95_s)} s to arrive (limit ${RULE.transit_p95_max_s} s)`);
  if (t.reading_lag_p95_s != null && t.reading_lag_p95_s > RULE.reading_lag_p95_max_s) bad.push(`95% of readings landed up to ${Math.round(t.reading_lag_p95_s)} s after they were read (limit ${RULE.reading_lag_p95_max_s} s)`);
  if (t.reading_lag_max_s != null && t.reading_lag_max_s > RULE.reading_lag_max_s) bad.push(`one reading landed ${Math.round(t.reading_lag_max_s)} s after it was read (limit ${RULE.reading_lag_max_s} s)`);
  const longest = t.gaps_s.length ? Math.max(...t.gaps_s) : null;
  const facts = `${t.snapshots} snapshot(s) in ${t.window_min} min (one is expected every ${RULE.snapshot_every_s} s, so about ${Math.floor((t.window_min * 60) / RULE.snapshot_every_s)}), longest gap ${r1(longest)}, newest ${r1(t.last_snapshot_age_s)} old, arrival p95 ${r1(t.transit_p95_s)}; ${t.readings} reading(s) from ${t.reading_devices} device(s), lag p95 ${r1(t.reading_lag_p95_s)}, max ${r1(t.reading_lag_max_s)}.`;
  return C('on_time', label, bad.length ? 'fail' : 'pass', bad.length ? `${bad.join('; ')}. ${facts}` : facts, ['snapshots', 'readings']);
}

const pick = (tests: un9d.TestResult[], ids: string[]) => tests.flatMap((t) => t.conditions).filter((c) => ids.includes(c.id));

/** Checks 2 to 4, from UN9D's conditions on the same farm. Pure. */
export function fromUn9d(tests: un9d.TestResult[]): Check[] {
  const as = (id: string, label: string, ids: string[]): Check => {
    const conds = pick(tests, ids);
    if (!conds.length) return C(id, label, 'not_yet_possible', 'UN9D did not report these conditions.', ids);
    return C(id, label, un9d.rollUp(conds), conds.map((c) => `${c.condition}: ${c.verdict}. ${c.reason}`).join(' '), ids);
  };
  return [
    as('state_correct', 'The Monitoring Twin marks each sensor live or stale correctly', ['agreement', 'observed_time']),
    as('one_alert', 'A sensor going quiet opens one alert and closes it when it comes back', ['incident_opened', 'recovers_once', 'downstream_agrees']),
    as('nothing_old_live', 'Nothing old is ever shown as live', ['freshness']),
  ];
}

/** The four checks and the run's verdict. Pure. */
export function judge(t: Timing, tests: un9d.TestResult[]): { verdict: Verdict; checks: Check[] } {
  const checks = [onTime(t), ...fromUn9d(tests)];
  return { verdict: un9d.rollUp(checks.map((c) => ({ id: c.id, condition: c.check, verdict: c.verdict, reason: c.reason }))), checks };
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

/** Reads the window's timing for one farm. */
export async function timing(farmId: string, windowMin: number): Promise<Timing> {
  // vFarm sends one snapshot for all its farms, so snapshots are not per farm; the farm's own age is below.
  const snaps = await query<{ received_s: number; transit_s: number }>(
    `SELECT extract(epoch from s.received_at)::float8 AS received_s, extract(epoch from s.received_at - s.taken_at)::float8 AS transit_s
       FROM engine_vfarm_snapshots s
      WHERE s.received_at > now() - make_interval(mins => $1)
      ORDER BY s.received_at`,
    [windowMin],
  );
  const last = await query<{ age_s: number | null }>(
    `SELECT extract(epoch from now() - snapshot_at)::float8 AS age_s FROM engine_vfarm_farms WHERE farm_id = $1`,
    [farmId],
  );
  const rd = await query<{ n: number; devs: number; p95: number | null; mx: number | null }>(
    `SELECT count(*)::int AS n, count(DISTINCT device_id)::int AS devs,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from received_at - read_at))::float8 AS p95,
            max(extract(epoch from received_at - read_at))::float8 AS mx
       FROM engine_vfarm_readings WHERE farm_id = $1 AND received_at > now() - make_interval(mins => $2)`,
    [farmId, windowMin],
  );
  const rows = snaps.rows;
  const gaps = rows.slice(1).map((r, i) => r.received_s - rows[i].received_s);
  const transits = rows.map((r) => r.transit_s);
  return {
    window_min: windowMin,
    snapshots: rows.length,
    gaps_s: gaps,
    last_snapshot_age_s: last.rows[0]?.age_s ?? null,
    transit_p95_s: pct(transits, 0.95),
    transit_max_s: transits.length ? Math.max(...transits) : null,
    readings: rd.rows[0]?.n ?? 0,
    reading_devices: rd.rows[0]?.devs ?? 0,
    reading_lag_p95_s: rd.rows[0]?.p95 ?? null,
    reading_lag_max_s: rd.rows[0]?.mx ?? null,
  };
}

/** One run: the four checks against one farm over the last `windowMin` minutes, recorded unless record is false. */
export async function run(farmId: string, opts: { windowMin?: number; label?: string | null; record?: boolean; actor?: string } = {}) {
  const windowMin = Math.max(5, Math.min(RULE.window_max_min, Math.round(opts.windowMin ?? RULE.window_default_min)));
  const u = await un9d.check(farmId, { record: false }); // throws CheckError(404) for a farm not held
  const t = await timing(farmId, windowMin);
  const { verdict, checks } = judge(t, u.tests);
  const result = {
    farm_id: farmId,
    simulated: u.simulated,
    label: opts.label ?? null,
    checked_at: new Date().toISOString(),
    window_min: windowMin,
    verdict,
    checks,
    timing: { ...t, gaps_s: undefined, longest_gap_s: t.gaps_s.length ? Math.max(...t.gaps_s) : null },
    rule: RULE,
    scope: 'The engine half of the stress test only (LOOP-1794168643405-SK22). The front half (every sensor reads, the cabinet stays connected, the farm stores and returns the latest reading) is Jegan\'s (LOOP-1794168643166-RS77) and is not judged here. Checks 2 to 4 are UN9D\'s conditions on the same rows.',
    claim: u.simulated
      ? 'Simulated farm: proves the dashboard path, not the rack. NOT_SAFE_TO_CLAIM.'
      : verdict === 'pass'
        ? 'The engine side held for this window on this farm, as the dashboard holds it.'
        : 'Not all four checks pass: the engine side is not proven for this window.',
    recorded: false as boolean,
    event_id: null as number | null,
  };
  if (opts.record !== false) {
    const ev = await engineEvents.record({
      event_type: 'stress_test_engine_checked',
      subject_id: farmId,
      lane: 'VFARM_HARDWARE',
      actor: opts.actor ?? 'dashboard',
      source_ref: 'LOOP-1794168643405-SK22',
      detail: { label: result.label, simulated: u.simulated, window_min: windowMin, verdict, checks: checks.map((c) => ({ id: c.id, verdict: c.verdict, reason: c.reason.slice(0, 600) })), timing: result.timing },
    });
    result.recorded = ev.recorded;
    result.event_id = ev.id;
  }
  return result;
}
