/**
 * The Monitoring Twin (2026-10-01, Destiny — Jason's tomato-first memo,
 * #bha-coordination 1790871181.672289, and UN9D's runtime half).
 *
 * vFarm already pushes its state here every three minutes (`vfarm.snapshot.v1`,
 * systemFeeds.ts): every device, where it sits, when it last read, and its
 * latest values. This module is the layer on top that **judges** that state —
 * the part Hardik's reconciliation marks RUNTIME_WIRING_PENDING_DESTINY — and is
 * the one place everything else reads the judgement from: this page, North Star
 * and Genie (`read_monitoring_twin`), and later the kiosk and app, so the twin
 * and every screen show the same truth (Jason, point 4 of the memo).
 *
 * What it decides, per device, on every snapshot and once a minute:
 *   - **freshness**, with Jason's locked thresholds (IMFX, 2026-10-01): a reading
 *     at most 90 s old when vFarm looked is LIVE, at most 900 s STALE, older
 *     OFFLINE; a device that has never read is NOT_WIRED; a device vFarm stopped
 *     listing is GONE. The age is measured at the snapshot, not now, because a
 *     snapshot only comes every three minutes — measuring against now would call
 *     every sensor stale between snapshots.
 *   - **the feed itself**: no snapshot for 600 s means nothing about the farm is
 *     known, so its devices read NO_FEED rather than keeping the last verdict.
 *   - **readings against the crop profile** for the stage the cycle is in now: a
 *     versioned table of textbook targets per growth stage, every change kept with
 *     its reason (Jason: "version the agronomy profiles").
 *
 * What it raises: one incident per fault, `INC-VFARM.<SUBSYSTEM>-…` — SENSOR for
 * a device gone OFFLINE, ENVIRONMENT for a reading outside its stage's range,
 * FEED for a real farm whose snapshots stopped — opened once and closed when the
 * fault clears, never re-opened every minute. Uptime is Jason's definition: the
 * share of observed time with no enrolled device OFFLINE, over the last 24 h,
 * with time when the feed was silent left out of the denominator rather than
 * counted as up or down.
 *
 * **Simulated farms** (`synthetic: true` on the farm in the snapshot) take the
 * same path as real ones, which is the point of testing with them, but are
 * labelled everywhere, hidden from the vFarm page, and never raise a FEED
 * incident — a test farm going quiet when the test stops is expected.
 *
 * **Every incident is also a BHARAG ledger record** (2026-10-03, Destiny —
 * Jason's UN9D close-out ask of 1 Oct: "incidents are durable Engine records,
 * not just dashboard UI state"). `syncLedger` below opens each one in the
 * ledger after the judging transaction commits, and closes it there when it
 * clears here. The row keeps the ledger's id, where it stands there, and the
 * last refusal word for word; a send that fails is retried on the next pass
 * and is never folded into success.
 */
import { query, withTransaction, type Queryable } from './pg';
import * as events from './events';
import * as bharag from './bharag';
import * as recurrence from './monitoringRecurrence';
import * as mirror from './mirror';
import * as timers from './timers';

export class TwinError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const THRESHOLDS = { stale_s: 90, offline_s: 900, feed_silent_s: 600 } as const;
export const UPTIME_WINDOW_H = 24;
const TICK_MS = 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** JSON with object keys sorted, so a jsonb read back from Postgres (which
 *  reorders keys) compares equal to the same content as it was posted. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (isObj(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val));

export interface Range {
  min: number | null;
  max: number | null;
  unit?: string | null;
  source?: string | null;
  note?: string | null;
}
export interface Stage {
  stage: string;
  label: string | null;
  from_day: number;
  to_day: number;
  targets: Record<string, Range>;
}

/* ------------------------------------------------------------- profiles */

/**
 * A crop profile, versioned. `(profile_id, version)` is unique; the same
 * version posted again with identical content is unchanged, and with different
 * content is a 409 — a correction is the next version, carrying the reason, and
 * the old one stays readable. Versions go up by one, so none is skipped.
 */
export async function storeProfile(body: Obj) {
  const profileId = str(body.profile_id);
  if (!profileId || !/^[A-Za-z0-9_.-]{2,60}$/.test(profileId)) throw new TwinError(422, 'profile_id is required: letters, digits, _ . - (2 to 60), e.g. "tomato-dwarf-determinate".');
  const version = num(body.version);
  if (version === null || !Number.isInteger(version) || version < 1) throw new TwinError(422, 'version is required, a whole number from 1.');
  const crop = str(body.crop);
  if (!crop) throw new TwinError(422, 'crop is required, e.g. "tomato".');
  const reason = str(body.reason);
  if (!reason) throw new TwinError(422, 'reason is required: why this version exists. Every change keeps its reason (versioned agronomy profiles).');
  const previous = body.previous_version === undefined || body.previous_version === null ? null : num(body.previous_version);
  if (version > 1 && previous !== version - 1) throw new TwinError(422, `version ${version} must name previous_version ${version - 1}: a profile changes one version at a time, so the reason for each change stays attached to it.`);
  if (version === 1 && previous !== null) throw new TwinError(422, 'version 1 has no previous_version.');
  if (!Array.isArray(body.stages) || body.stages.length === 0) throw new TwinError(422, 'stages is required: at least one { stage, from_day, to_day, targets }.');
  const stages: Stage[] = body.stages.map((s, i) => {
    if (!isObj(s)) throw new TwinError(422, `stages[${i}] is not an object.`);
    const stage = str(s.stage);
    const from = num(s.from_day);
    const to = num(s.to_day);
    if (!stage) throw new TwinError(422, `stages[${i}].stage is required.`);
    if (from === null || to === null || from < 0 || to < from) throw new TwinError(422, `stages[${i}] (${stage}): from_day and to_day are days after transplant, with to_day ≥ from_day ≥ 0.`);
    if (!isObj(s.targets)) throw new TwinError(422, `stages[${i}] (${stage}).targets is required: { metric: { min, max, unit, source } }.`);
    const targets: Record<string, Range> = {};
    for (const [metric, r] of Object.entries(s.targets)) {
      if (!isObj(r)) throw new TwinError(422, `stages[${i}].targets.${metric} is not an object.`);
      const min = r.min === null || r.min === undefined ? null : num(r.min);
      const max = r.max === null || r.max === undefined ? null : num(r.max);
      if ((r.min !== null && r.min !== undefined && min === null) || (r.max !== null && r.max !== undefined && max === null)) throw new TwinError(422, `stages[${i}].targets.${metric}: min and max are numbers or null.`);
      if (min !== null && max !== null && min > max) throw new TwinError(422, `stages[${i}].targets.${metric}: min ${min} is above max ${max}.`);
      targets[metric] = { min, max, unit: str(r.unit), source: str(r.source), note: str(r.note) };
    }
    return { stage, label: str(s.label), from_day: from, to_day: to, targets };
  });
  for (let i = 1; i < stages.length; i++) {
    if (stages[i].from_day <= stages[i - 1].to_day) throw new TwinError(422, `stages[${i}] (${stages[i].stage}) starts on day ${stages[i].from_day}, inside ${stages[i - 1].stage} (to day ${stages[i - 1].to_day}). Stages run in order and do not overlap.`);
  }
  const content = { crop, stages, sources: Array.isArray(body.sources) ? body.sources : [] };
  const dry = body.dry_run === true;
  return withTransaction(async (db) => {
    const held = await db.query<{ content: unknown; reason: string }>(`SELECT content, reason FROM engine_monitoring_profiles WHERE profile_id = $1 AND version = $2`, [profileId, version]);
    if (held.rows[0]) {
      if (canonical(held.rows[0].content) === canonical(content)) return { stored: 'unchanged' as const, profile_id: profileId, version, dry_run: dry };
      throw new TwinError(409, `${profileId} v${version} is already held with different content. Post v${version + 1} with previous_version ${version} and the reason for the change.`);
    }
    const newest = await db.query<{ v: number | null }>(`SELECT max(version)::int AS v FROM engine_monitoring_profiles WHERE profile_id = $1`, [profileId]);
    const top = newest.rows[0]?.v ?? 0;
    if (version !== top + 1) throw new TwinError(409, `${profileId} is at v${top}; the next version is v${top + 1}, not v${version}.`);
    if (!dry) {
      await db.query(
        `INSERT INTO engine_monitoring_profiles (profile_id, version, previous_version, crop, reason, changed_by, content) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [profileId, version, previous, crop, reason, str(body.changed_by), JSON.stringify(content)],
      );
      events.changed('monitoring_twin', null, db);
    }
    return { stored: dry ? ('dry_run' as const) : ('inserted' as const), profile_id: profileId, version, stages: stages.length, dry_run: dry };
  });
}

/* --------------------------------------------------------------- cycles */

/**
 * Which crop cycle a farm is running: the profile and version it is judged
 * against, when it was transplanted, and how fast its clock runs. `time_scale`
 * is 1 for a real farm; a simulated farm can run a whole cycle in minutes.
 */
export async function storeCycle(body: Obj) {
  const farmId = str(body.farm_id);
  if (!farmId) throw new TwinError(422, 'farm_id is required: the id vFarm sends for the farm in its snapshot.');
  const profileId = str(body.profile_id);
  if (!profileId) throw new TwinError(422, 'profile_id is required.');
  const at = str(body.transplanted_at);
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) throw new TwinError(422, 'transplanted_at is required, as an ISO 8601 time: day 0 of the cycle.');
  const scale = body.time_scale === undefined ? 1 : num(body.time_scale);
  if (scale === null || scale <= 0 || scale > 100_000) throw new TwinError(422, 'time_scale is a number above 0 and at most 100,000 (1 = real time).');
  const synthetic = body.synthetic === true;
  if (!synthetic && scale !== 1) throw new TwinError(422, 'Only a simulated farm (synthetic: true) can run a fast clock. A real farm runs at time_scale 1.');
  return withTransaction(async (db) => {
    const p = await db.query<{ v: number | null }>(
      `SELECT max(version)::int AS v FROM engine_monitoring_profiles WHERE profile_id = $1`,
      [profileId],
    );
    const newest = p.rows[0]?.v ?? null;
    if (newest === null) throw new TwinError(422, `No profile "${profileId}" is held. Post it to /api/engine/monitoring-profile first.`);
    const version = body.profile_version === undefined || body.profile_version === null ? newest : num(body.profile_version);
    if (version === null || version < 1 || version > newest) throw new TwinError(422, `profile_version must be one of ${profileId}'s held versions, 1 to ${newest}.`);
    await db.query(
      `INSERT INTO engine_monitoring_cycles (farm_id, profile_id, profile_version, transplanted_at, time_scale, synthetic, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (farm_id) DO UPDATE SET profile_id = EXCLUDED.profile_id, profile_version = EXCLUDED.profile_version, transplanted_at = EXCLUDED.transplanted_at,
         time_scale = EXCLUDED.time_scale, synthetic = EXCLUDED.synthetic, note = EXCLUDED.note, updated_at = now()`,
      [farmId, profileId, version, new Date(t).toISOString(), scale, synthetic, str(body.note)],
    );
    events.changed('monitoring_twin', null, db);
    return { farm_id: farmId, profile_id: profileId, profile_version: version, transplanted_at: new Date(t).toISOString(), time_scale: scale, synthetic };
  });
}

/* ------------------------------------------------------------- judgement */

export type DeviceState = 'LIVE' | 'STALE' | 'OFFLINE' | 'NOT_WIRED' | 'NO_FEED' | 'GONE';

/** Freshness at the moment vFarm looked. Pure, so it can be tested without a database. */
export function freshness(lastReadingAt: string | null, snapshotAt: string): { state: DeviceState; age_s: number | null } {
  if (!lastReadingAt) return { state: 'NOT_WIRED', age_s: null };
  const age = Math.max(0, Math.round((Date.parse(snapshotAt) - Date.parse(lastReadingAt)) / 1000));
  if (age <= THRESHOLDS.stale_s) return { state: 'LIVE', age_s: age };
  if (age <= THRESHOLDS.offline_s) return { state: 'STALE', age_s: age };
  return { state: 'OFFLINE', age_s: age };
}

/** The crop day and stage now, from the cycle. Null stage before day 0 or after the last stage. */
export function stageAt(stages: Stage[], transplantedAt: string, timeScale: number, now = Date.now()) {
  const day = ((now - Date.parse(transplantedAt)) * timeScale) / 86_400_000;
  const stage = stages.find((s) => day >= s.from_day && day < s.to_day + 1) ?? null;
  const last = stages[stages.length - 1];
  return { crop_day: Math.round(day * 10) / 10, stage, before_start: day < 0, after_end: !!last && day >= last.to_day + 1 };
}

/** A reading's value as vFarm sends it: `{ value, unit, status }` or a bare number. */
export function readingValue(v: unknown): number | null {
  if (isObj(v)) return num(v.value);
  return num(v);
}

export interface Check {
  metric: string;
  value: number;
  min: number | null;
  max: number | null;
  unit: string | null;
  ok: boolean;
}
export function checkReadings(latest: unknown, targets: Record<string, Range> | null): Check[] {
  if (!isObj(latest) || !targets) return [];
  const out: Check[] = [];
  for (const [metric, raw] of Object.entries(latest)) {
    const t = targets[metric];
    const value = readingValue(raw);
    if (!t || value === null || (t.min === null && t.max === null)) continue;
    const ok = (t.min === null || value >= t.min) && (t.max === null || value <= t.max);
    out.push({ metric, value, min: t.min, max: t.max, unit: t.unit ?? null, ok });
  }
  return out;
}

const SUBSYSTEM: Record<string, string> = { offline: 'SENSOR', out_of_range: 'ENVIRONMENT', feed_silent: 'FEED' };
const newIncidentId = (kind: string) => `INC-VFARM.${SUBSYSTEM[kind] ?? 'MONITORING'}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

interface Fault {
  farm_id: string;
  device_id: string | null;
  kind: 'offline' | 'out_of_range' | 'feed_silent';
  metric: string | null;
  severity: 'warning' | 'critical';
  detail: string;
  value: number | null;
  min: number | null;
  max: number | null;
  stage: string | null;
  synthetic: boolean;
}
const faultKey = (f: { farm_id: string; device_id: string | null; kind: string; metric: string | null }) => `${f.farm_id}|${f.device_id ?? ''}|${f.kind}|${f.metric ?? ''}`;

let running = false;

/**
 * One pass over every farm vFarm has sent: judge each device, write its state,
 * open an incident for each new fault and close each cleared one. Safe to call
 * from the snapshot route and the minute tick at once: the second caller waits
 * on the same advisory lock rather than judging twice.
 */
export async function evaluate(trigger: 'snapshot' | 'tick' | 'manual' = 'manual') {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  return withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(8134207612)`);
    const farms = await db.query<{ farm_id: string; name: string | null; snapshot_at: string; synthetic: boolean }>(
      `SELECT farm_id, name, to_char(snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snapshot_at,
              coalesce((fields->>'synthetic')::boolean, false) AS synthetic
         FROM engine_vfarm_farms`,
    );
    const devices = await db.query<{ device_id: string; farm_id: string; last_reading_at: string | null; latest: unknown; gone: boolean }>(
      `SELECT device_id, farm_id, to_char(last_reading_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_reading_at, latest, gone_at IS NOT NULL AS gone
         FROM engine_vfarm_devices`,
    );
    const cycles = await db.query<{ farm_id: string; transplanted_at: string; time_scale: number; content: { stages: Stage[] } }>(
      `SELECT c.farm_id, to_char(c.transplanted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transplanted_at, c.time_scale::float8 AS time_scale, p.content
         FROM engine_monitoring_cycles c JOIN engine_monitoring_profiles p ON p.profile_id = c.profile_id AND p.version = c.profile_version`,
    );
    const cycleOf = new Map(cycles.rows.map((c) => [c.farm_id, c]));
    const faults: Fault[] = [];
    let judged = 0;
    for (const f of farms.rows) {
      await db.query(
        `INSERT INTO engine_monitoring_watch (farm_id, first_watched_at, last_evaluated_at) VALUES ($1, now(), now())
         ON CONFLICT (farm_id) DO UPDATE SET last_evaluated_at = now()`,
        [f.farm_id],
      );
      const feedAge = Math.round((now - Date.parse(f.snapshot_at)) / 1000);
      const feedSilent = feedAge > THRESHOLDS.feed_silent_s;
      if (feedSilent && !f.synthetic) {
        faults.push({ farm_id: f.farm_id, device_id: null, kind: 'feed_silent', metric: null, severity: 'critical', detail: `No snapshot from vFarm for ${Math.round(feedAge / 60)} min (the job runs every 3). Nothing about this farm is known until one arrives.`, value: feedAge, min: null, max: THRESHOLDS.feed_silent_s, stage: null, synthetic: false });
      }
      const cyc = cycleOf.get(f.farm_id);
      const st = cyc ? stageAt(cyc.content.stages, cyc.transplanted_at, cyc.time_scale, now) : null;
      for (const d of devices.rows.filter((x) => x.farm_id === f.farm_id)) {
        judged++;
        let state: DeviceState;
        let age: number | null = null;
        if (d.gone) state = 'GONE';
        else if (feedSilent) state = 'NO_FEED';
        else {
          const fr = freshness(d.last_reading_at, f.snapshot_at);
          state = fr.state;
          age = fr.age_s;
        }
        const checks = state === 'LIVE' || state === 'STALE' ? checkReadings(d.latest, st?.stage?.targets ?? null) : [];
        if (state === 'OFFLINE') {
          faults.push({ farm_id: f.farm_id, device_id: d.device_id, kind: 'offline', metric: null, severity: 'warning', detail: `No reading for ${Math.round((age ?? 0) / 60)} min when vFarm last looked (offline after ${THRESHOLDS.offline_s / 60} min).`, value: age, min: null, max: THRESHOLDS.offline_s, stage: st?.stage?.stage ?? null, synthetic: f.synthetic });
        }
        for (const c of checks.filter((x) => !x.ok)) {
          faults.push({ farm_id: f.farm_id, device_id: d.device_id, kind: 'out_of_range', metric: c.metric, severity: 'warning', detail: `${c.metric} ${c.value}${c.unit ? ` ${c.unit}` : ''} is outside ${c.min ?? '−∞'}–${c.max ?? '∞'} for the ${st?.stage?.stage ?? '?'} stage.`, value: c.value, min: c.min, max: c.max, stage: st?.stage?.stage ?? null, synthetic: f.synthetic });
        }
        await db.query(
          `INSERT INTO engine_monitoring_device_state (device_id, farm_id, state, since, age_s, checks, evaluated_at)
           VALUES ($1,$2,$3, now(), $4, $5, now())
           ON CONFLICT (device_id) DO UPDATE SET farm_id = EXCLUDED.farm_id,
             since = CASE WHEN engine_monitoring_device_state.state = EXCLUDED.state THEN engine_monitoring_device_state.since ELSE now() END,
             state = EXCLUDED.state, age_s = EXCLUDED.age_s, checks = EXCLUDED.checks, evaluated_at = now()`,
          [d.device_id, f.farm_id, state, age, JSON.stringify(checks)],
        );
      }
    }
    // Open what is new, keep what is still true, close what has cleared.
    const open = await db.query<{ incident_id: string; farm_id: string; device_id: string | null; kind: string; metric: string | null }>(
      `SELECT incident_id, farm_id, device_id, kind, metric FROM engine_monitoring_incidents WHERE closed_at IS NULL`,
    );
    const openKeys = new Map(open.rows.map((o) => [faultKey(o), o.incident_id]));
    const nowKeys = new Set(faults.map(faultKey));
    let opened = 0;
    let closed = 0;
    for (const f of faults) {
      const k = faultKey(f);
      if (openKeys.has(k)) {
        await db.query(`UPDATE engine_monitoring_incidents SET last_value = $2, last_seen_at = now() WHERE incident_id = $1`, [openKeys.get(k), f.value]);
        continue;
      }
      await db.query(
        `INSERT INTO engine_monitoring_incidents (incident_id, farm_id, device_id, kind, metric, severity, detail, first_value, last_value, range_min, range_max, stage, synthetic, opened_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12, now(), now())`,
        [newIncidentId(f.kind), f.farm_id, f.device_id, f.kind, f.metric, f.severity, f.detail, f.value, f.min, f.max, f.stage, f.synthetic],
      );
      opened++;
    }
    for (const o of open.rows) {
      if (nowKeys.has(faultKey(o))) continue;
      await db.query(`UPDATE engine_monitoring_incidents SET closed_at = now(), close_reason = $2 WHERE incident_id = $1`, [o.incident_id, `cleared on the ${trigger === 'snapshot' ? 'next snapshot' : 'next check'}`]);
      closed++;
    }
    if (opened || closed) events.changed('monitoring_twin', null, db);
    return { evaluated_at: nowIso, trigger, farms: farms.rows.length, devices: judged, faults: faults.length, opened, closed };
  });
}

/* ------------------------------------------------- the BHARAG ledger copy */

/**
 * The lane whose key writes these incidents. The Monitoring Twin is Destiny's
 * engine runtime (UN9D: RUNTIME_WIRING_PENDING_DESTINY), so they go in on the
 * Bays (engine) lane, the same key the Bays error handler opens with, under a
 * subsystem of their own so they never read as an agent failure. The dashboard
 * holds no vFarm key, and a guessed one would be a 401.
 */
export const LEDGER_LANE = 'bays';
export const LEDGER_SUBSYSTEM = 'MONITORING';
const LEDGER_CLASS: Record<string, string> = { offline: 'SENSOR_OFFLINE', out_of_range: 'ENVIRONMENT_OUT_OF_RANGE', feed_silent: 'FEED_SILENT' };
const LEDGER_SEVERITY: Record<string, string> = { warning: 'warning', critical: 'critical' };

type LedgerRow = {
  incident_id: string;
  farm_id: string;
  device_id: string | null;
  kind: string;
  metric: string | null;
  severity: string;
  detail: string;
  stage: string | null;
  synthetic: boolean;
  closed_at: string | null;
  close_reason: string | null;
  ledger_id: string | null;
  ledger_state: string;
};

/**
 * The body the ledger is sent. `payload` carries **only** the keys the error
 * handlers send (`Compute Incident Payload`), because the ledger's payload
 * schema refuses any other: farm, device, metric, stage and our own incident id
 * travel in `failed_node_or_component`, `error_message` and `execution_id`
 * rather than as new keys.
 */
export function ledgerBody(r: LedgerRow) {
  const where = r.device_id ? `${r.farm_id} / ${r.device_id}` : r.farm_id;
  const what = r.kind === 'offline' ? 'sensor offline' : r.kind === 'out_of_range' ? `${r.metric ?? 'reading'} out of range` : 'vFarm feed silent';
  const sim = r.synthetic ? '[SIMULATED] ' : '';
  return {
    type: 'INC' as const,
    subsystem: LEDGER_SUBSYSTEM,
    source: LEDGER_LANE,
    severity: LEDGER_SEVERITY[r.severity] ?? 'warning',
    summary: `${sim}Monitoring Twin / ${where}: ${what}`.slice(0, 200),
    payload: {
      lane: LEDGER_LANE,
      workflow_or_scenario: r.synthetic ? 'Monitoring Twin (simulated farm)' : 'Monitoring Twin',
      failed_node_or_component: where + (r.metric ? ` · ${r.metric}` : ''),
      error_class: LEDGER_CLASS[r.kind] ?? 'MONITORING',
      error_message: `${sim}${r.detail}${r.stage ? ` Stage: ${r.stage}.` : ''} Dashboard incident ${r.incident_id}.`,
      error_message_original_bytes: null,
      execution_id: r.incident_id,
      impact_tags: r.synthetic ? ['vfarm', 'monitoring', 'simulated'] : ['vfarm', 'monitoring'],
      retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
      self_healing_strategy: 'Raised by the Monitoring Twin on the BHA Engine Dashboard. It closes itself in the ledger when the fault clears on the next snapshot or minute check; nothing here is retried.',
      research_needed: false,
      research_id: null,
      commercial_hint: null,
      resolved_at: null,
      resolved_by: null,
    },
  };
}

/**
 * Engine health's copy of a monitoring incident (2026-10-04, Destiny — the
 * downstream reader for UN9D path 2). Engine health reads the ledger every
 * three minutes and only what is live at that moment, so an incident that
 * opened and cleared between two reads never reached it: on the 4 Oct dry run
 * a 15-second incident was in the ledger and on no page but this twin's. So
 * the row is written into `engine_incidents` here, at the moment the ledger
 * takes it, through the same `mirror.upsert` the ledger poll uses, and marked
 * closed here when the ledger closes it. Same ledger id on both pages.
 * Never throws: a copy that fails is logged, and the poll still catches any
 * incident open long enough to be read.
 */
async function copyToHealth(r: LedgerRow, ledgerId: string, raw: unknown): Promise<void> {
  try {
    const res = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const inc = (res.incident && typeof res.incident === 'object' ? res.incident : res) as Record<string, unknown>;
    const fields = { ...ledgerBody(r), resolution_status: 'open', created_at: new Date().toISOString(), ...inc, entity_id: ledgerId };
    await mirror.upsert('incidents', { fields, lane_id: LEDGER_LANE }, 'engine');
    await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $2 WHERE natural_id = $1`, [ledgerId, new Date().toISOString()]);
    events.changed('incidents');
  } catch (e) {
    console.error(`[monitoring-twin] Engine health copy of ${ledgerId} (${r.incident_id}) was not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function closeOnHealth(r: LedgerRow, ledgerId: string): Promise<void> {
  try {
    await query(
      `UPDATE engine_incidents SET open_now = false, resolved_at = COALESCE(resolved_at, $2), resolved_by = COALESCE(resolved_by, $3) WHERE natural_id = $1`,
      [ledgerId, r.closed_at, `monitoring-twin (${r.close_reason ?? 'the fault cleared'})`],
    );
    events.changed('incidents');
  } catch (e) {
    console.error(`[monitoring-twin] Engine health copy of ${ledgerId} (${r.incident_id}) was not marked closed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let syncing = false;

/**
 * Send every incident the ledger does not yet have, and close there every one
 * that has cleared here. Runs outside the judging transaction, after it
 * commits, so a slow or refusing ledger never holds the lock or fails a
 * snapshot. Never throws. A send that fails keeps `pending` (or `open`) with
 * BHARAG's reason in `ledger_error` and is tried again on the next pass;
 * `ledger_attempts` counts every try.
 */
export async function syncLedger(): Promise<{ opened: number; closed: number; failed: number; skipped: string | null }> {
  if (syncing) return { opened: 0, closed: 0, failed: 0, skipped: 'a sync is already running' };
  if (!bharag.laneConfigured(LEDGER_LANE)) return { opened: 0, closed: 0, failed: 0, skipped: `${bharag.LANE_KEY_VARS[LEDGER_LANE]} is not set` };
  syncing = true;
  let opened = 0;
  let closed = 0;
  let failed = 0;
  try {
    const rows = await query<LedgerRow>(
      `SELECT incident_id, farm_id, device_id, kind, metric, severity, detail, stage, synthetic,
              to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at, close_reason, ledger_id, ledger_state
         FROM engine_monitoring_incidents
        WHERE ledger_state = 'pending' OR (ledger_state = 'open' AND closed_at IS NOT NULL)
        ORDER BY opened_at
        LIMIT 50`,
    );
    for (const r of rows.rows) {
      let ledgerId = r.ledger_id;
      let state = r.ledger_state;
      try {
        if (state === 'pending') {
          const res = await bharag.openIncident(LEDGER_LANE, ledgerBody(r));
          ledgerId = res.id;
          state = 'open';
          opened++;
          await query(
            `UPDATE engine_monitoring_incidents SET ledger_id = $2, ledger_state = 'open', ledger_error = NULL, ledger_attempts = ledger_attempts + 1, ledger_synced_at = now() WHERE incident_id = $1`,
            [r.incident_id, ledgerId],
          );
          await copyToHealth(r, ledgerId, res.raw);
        }
        if (state === 'open' && r.closed_at && ledgerId) {
          // The ledger's lifecycle reaches self_healed only through retrying,
          // the path Self Healer Reports and the recovery watcher take.
          try {
            await bharag.markRetrying(LEDGER_LANE, ledgerId);
          } catch (e) {
            if (!(e instanceof bharag.BharagError) || !/retrying|transition/i.test(e.message)) throw e;
          }
          await bharag.closeIncident(LEDGER_LANE, ledgerId, 'monitoring-twin', r.closed_at, 'self_healed');
          closed++;
          await query(
            `UPDATE engine_monitoring_incidents SET ledger_state = 'closed', ledger_error = NULL, ledger_attempts = ledger_attempts + 1, ledger_synced_at = now() WHERE incident_id = $1`,
            [r.incident_id],
          );
          await closeOnHealth(r, ledgerId);
        }
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[monitoring-twin] BHARAG ${state === 'pending' ? 'open' : 'close'} of ${r.incident_id} failed: ${msg}`);
        await query(`UPDATE engine_monitoring_incidents SET ledger_error = $2, ledger_attempts = ledger_attempts + 1, ledger_synced_at = now() WHERE incident_id = $1`, [r.incident_id, msg.slice(0, 500)]);
      }
    }
    if (opened || closed || failed) events.changed('monitoring_twin');
    return { opened, closed, failed, skipped: null };
  } catch (e) {
    console.error(`[monitoring-twin] BHARAG sync failed: ${(e as Error).message}`);
    return { opened, closed, failed: failed + 1, skipped: null };
  } finally {
    syncing = false;
  }
}

/** After a snapshot lands. Never throws: a judgement that fails must not fail vFarm's post. */
export async function afterSnapshot() {
  try {
    const judged = await evaluate('snapshot');
    const ledger = await syncLedger();
    // After the ledger, so a job's context can carry each incident's ledger id.
    const recurring = await recurrence.sweep();
    return { ...judged, ledger, recurring };
  } catch (e) {
    console.error(`[monitoring-twin] evaluation after a snapshot failed: ${(e as Error).message}`);
    return null;
  }
}

/** Once a minute, so a farm whose snapshots stop is noticed without waiting for one. */
export function startWatching() {
  setInterval(() => {
    timers.beat('monitoring twin');
    if (running) return;
    running = true;
    evaluate('tick')
      .then(() => syncLedger())
      .then(() => recurrence.sweep())
      .catch((e) => console.error(`[monitoring-twin] minute check failed: ${(e as Error).message}`))
      .finally(() => {
        running = false;
      });
  }, TICK_MS).unref();
}

/* ---------------------------------------------------------------- reads */

interface Interval {
  from: number;
  to: number;
}
/** Total length of the union of intervals, clipped to [lo, hi]. */
export function unionMs(intervals: Interval[], lo: number, hi: number): number {
  const xs = intervals.map((i) => ({ from: Math.max(lo, i.from), to: Math.min(hi, i.to) })).filter((i) => i.to > i.from).sort((a, b) => a.from - b.from);
  let total = 0;
  let cur: Interval | null = null;
  for (const i of xs) {
    if (!cur || i.from > cur.to) {
      if (cur) total += cur.to - cur.from;
      cur = { ...i };
    } else cur.to = Math.max(cur.to, i.to);
  }
  if (cur) total += cur.to - cur.from;
  return total;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function monitoringData(db: Queryable = { query }) {
  const now = Date.now();
  const [farms, devices, cycles, profiles, incidents, watch] = await Promise.all([
    db.query<{ farm_id: string; name: string | null; code: string | null; snapshot_at: string; synthetic: boolean }>(
      `SELECT farm_id, name, code, ${ISO('snapshot_at')} AS snapshot_at, coalesce((fields->>'synthetic')::boolean, false) AS synthetic FROM engine_vfarm_farms ORDER BY synthetic, name NULLS LAST`,
    ),
    db.query<{ device_id: string; farm_id: string; place: string | null; device_type: string | null; model: string | null; latest: unknown; last_reading_at: string | null; last_seen_at: string | null; state: string | null; since: string | null; age_s: number | null; checks: Check[] | null; evaluated_at: string | null }>(
      `SELECT d.device_id, d.farm_id, d.place, d.device_type, d.model, d.latest, ${ISO('d.last_reading_at')} AS last_reading_at, ${ISO('d.last_seen_at')} AS last_seen_at,
              s.state, ${ISO('s.since')} AS since, s.age_s, s.checks, ${ISO('s.evaluated_at')} AS evaluated_at
         FROM engine_vfarm_devices d LEFT JOIN engine_monitoring_device_state s ON s.device_id = d.device_id
        ORDER BY d.farm_id, d.device_id`,
    ),
    db.query<{ farm_id: string; profile_id: string; profile_version: number; transplanted_at: string; time_scale: number; synthetic: boolean; note: string | null; content: { crop: string; stages: Stage[] } }>(
      `SELECT c.farm_id, c.profile_id, c.profile_version, ${ISO('c.transplanted_at')} AS transplanted_at, c.time_scale::float8 AS time_scale, c.synthetic, c.note, p.content
         FROM engine_monitoring_cycles c JOIN engine_monitoring_profiles p ON p.profile_id = c.profile_id AND p.version = c.profile_version`,
    ),
    db.query<{ profile_id: string; version: number; previous_version: number | null; crop: string; reason: string; changed_by: string | null; created_at: string; content: { stages: Stage[]; sources?: unknown[] } }>(
      `SELECT profile_id, version, previous_version, crop, reason, changed_by, ${ISO('created_at')} AS created_at, content FROM engine_monitoring_profiles ORDER BY profile_id, version DESC`,
    ),
    db.query<{ incident_id: string; farm_id: string; device_id: string | null; kind: string; metric: string | null; severity: string; detail: string; first_value: number | null; last_value: number | null; range_min: number | null; range_max: number | null; stage: string | null; synthetic: boolean; opened_at: string; closed_at: string | null; close_reason: string | null; ledger_id: string | null; ledger_state: string; ledger_error: string | null; ledger_attempts: number; ledger_synced_at: string | null; opened_ms: string; closed_ms: string | null }>(
      `SELECT incident_id, farm_id, device_id, kind, metric, severity, detail, first_value, last_value, range_min, range_max, stage, synthetic,
              ${ISO('opened_at')} AS opened_at, ${ISO('closed_at')} AS closed_at, close_reason,
              ledger_id, ledger_state, ledger_error, ledger_attempts, ${ISO('ledger_synced_at')} AS ledger_synced_at,
              (extract(epoch FROM opened_at) * 1000)::bigint::text AS opened_ms, (extract(epoch FROM closed_at) * 1000)::bigint::text AS closed_ms
         FROM engine_monitoring_incidents
        WHERE closed_at IS NULL OR closed_at > now() - interval '7 days'
        ORDER BY opened_at DESC LIMIT 500`,
    ),
    db.query<{ farm_id: string; first_watched_ms: string; last_evaluated_at: string }>(
      `SELECT farm_id, (extract(epoch FROM first_watched_at) * 1000)::bigint::text AS first_watched_ms, ${ISO('last_evaluated_at')} AS last_evaluated_at FROM engine_monitoring_watch`,
    ),
  ]);
  const cycleOf = new Map(cycles.rows.map((c) => [c.farm_id, c]));
  const watchOf = new Map(watch.rows.map((w) => [w.farm_id, w]));
  const windowMs = UPTIME_WINDOW_H * 3_600_000;

  const farmsOut = farms.rows.map((f) => {
    const feedAge = Math.round((now - Date.parse(f.snapshot_at)) / 1000);
    const cyc = cycleOf.get(f.farm_id) ?? null;
    const st = cyc ? stageAt(cyc.content.stages, cyc.transplanted_at, cyc.time_scale, now) : null;
    const devs = devices.rows.filter((d) => d.farm_id === f.farm_id);
    const inc = incidents.rows.filter((i) => i.farm_id === f.farm_id);
    const w = watchOf.get(f.farm_id);
    const lo = Math.max(now - windowMs, w ? Number(w.first_watched_ms) : now);
    const offline = inc.filter((i) => i.kind === 'offline').map((i) => ({ from: Number(i.opened_ms), to: i.closed_ms ? Number(i.closed_ms) : now }));
    const silent = inc.filter((i) => i.kind === 'feed_silent').map((i) => ({ from: Number(i.opened_ms), to: i.closed_ms ? Number(i.closed_ms) : now }));
    const observed = now - lo - unionMs(silent, lo, now);
    const down = unionMs(offline, lo, now);
    const counts: Record<string, number> = {};
    for (const d of devs) counts[d.state ?? 'NOT_JUDGED'] = (counts[d.state ?? 'NOT_JUDGED'] ?? 0) + 1;
    return {
      farm_id: f.farm_id,
      name: f.name ?? f.code ?? f.farm_id,
      synthetic: f.synthetic,
      feed: { last_snapshot_at: f.snapshot_at, age_s: feedAge, silent: feedAge > THRESHOLDS.feed_silent_s },
      cycle: cyc
        ? {
            profile_id: cyc.profile_id,
            profile_version: cyc.profile_version,
            crop: cyc.content.crop,
            transplanted_at: cyc.transplanted_at,
            time_scale: cyc.time_scale,
            note: cyc.note,
            crop_day: st?.crop_day ?? null,
            stage: st?.stage ? { stage: st.stage.stage, label: st.stage.label, from_day: st.stage.from_day, to_day: st.stage.to_day, targets: st.stage.targets } : null,
            before_start: st?.before_start ?? false,
            after_end: st?.after_end ?? false,
          }
        : null,
      uptime: {
        window_h: UPTIME_WINDOW_H,
        observed_s: Math.max(0, Math.round(observed / 1000)),
        offline_s: Math.round(down / 1000),
        pct: observed > 0 ? Math.round((1 - Math.min(down, observed) / observed) * 1000) / 10 : null,
        note: `Share of the observed time (the last ${UPTIME_WINDOW_H} h, or since the twin started watching this farm if later, less any time the feed was silent) with no device OFFLINE.`,
      },
      state_counts: counts,
      devices: devs.map((d) => ({
        device_id: d.device_id,
        place: d.place,
        device_type: d.device_type,
        model: d.model,
        latest: d.latest,
        last_reading_at: d.last_reading_at,
        last_seen_at: d.last_seen_at,
        state: d.state,
        since: d.since,
        age_s: d.age_s,
        checks: d.checks ?? [],
        evaluated_at: d.evaluated_at,
      })),
      open_incidents: inc.filter((i) => !i.closed_at).map(({ opened_ms, closed_ms, ...i }) => ({ ...i, canonical_id: i.ledger_id })),
      recent_incidents: inc.filter((i) => i.closed_at).slice(0, 50).map(({ opened_ms, closed_ms, ...i }) => ({ ...i, canonical_id: i.ledger_id })),
      last_evaluated_at: w?.last_evaluated_at ?? null,
    };
  });
  const byId = new Map<string, typeof profiles.rows>();
  for (const p of profiles.rows) byId.set(p.profile_id, [...(byId.get(p.profile_id) ?? []), p]);
  return {
    schema: 'monitoring.twin.v1',
    as_of: new Date(now).toISOString(),
    thresholds: THRESHOLDS,
    states: {
      LIVE: `a reading at most ${THRESHOLDS.stale_s} s old when vFarm last looked`,
      STALE: `older than ${THRESHOLDS.stale_s} s, at most ${THRESHOLDS.offline_s} s`,
      OFFLINE: `no reading for over ${THRESHOLDS.offline_s} s — opens an INC-VFARM.SENSOR incident`,
      NOT_WIRED: 'listed by vFarm but has never sent a reading',
      NO_FEED: `the farm's snapshots stopped over ${THRESHOLDS.feed_silent_s} s ago, so nothing is judged`,
      GONE: 'vFarm no longer lists the device',
    },
    farms: farmsOut,
    profiles: [...byId.entries()].map(([profile_id, versions]) => ({
      profile_id,
      crop: versions[0].crop,
      current_version: versions[0].version,
      versions: versions.map((v) => ({ version: v.version, previous_version: v.previous_version, reason: v.reason, changed_by: v.changed_by, created_at: v.created_at, stages: v.content.stages, sources: v.content.sources ?? [] })),
    })),
    ledger: {
      lane: LEDGER_LANE,
      subsystem: LEDGER_SUBSYSTEM,
      configured: bharag.laneConfigured(LEDGER_LANE),
      note: `Every incident is also opened in the BHARAG incident ledger on the ${LEDGER_LANE} (engine) lane, subsystem ${LEDGER_SUBSYSTEM}, and closed there as self_healed when it clears here. Simulated farms' incidents go too, marked [SIMULATED]. Incidents closed before 3 Oct 2026 were never sent and say so.`,
      identity: 'One incident, one canonical id: the ledger id (INC-BAYS.MONITORING-nnn), given here as canonical_id and ledger_id, and the id Engine health shows. incident_id (INC-VFARM…) is this twin\'s own reference for the same incident; the ledger carries it as execution_id. canonical_id is null only until the ledger has taken the incident.',
      downstream: 'Engine health holds every incident the ledger took, written at the moment it was opened and marked closed when it clears, under the same ledger id.',
    },
    recurrence: await recurrence.recent(),
    counts: {
      farms: farmsOut.filter((f) => !f.synthetic).length,
      simulated_farms: farmsOut.filter((f) => f.synthetic).length,
      open_incidents: farmsOut.reduce((n, f) => n + f.open_incidents.length, 0),
    },
    not_yet: [
      'Thresholds for launch (uptime X%, incident envelope Y, yield N) are Jegan’s to propose from the first real snapshots (IMFX); nothing here is gated on them yet.',
    ],
  };
}
