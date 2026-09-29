/**
 * Genie and vFarm, pushed as it happens (2026-09-29, Destiny — D3 / HMJV).
 *
 * Neither system is polled. Each posts to this server when something happens,
 * with the same `x-dashboard-key` every engine write carries, and the pages
 * re-read the moment a row lands (events.changed). There is no resync button:
 * a push nobody sent is a gap the page states, not one a button papers over.
 *
 * **Each payload is taken in its own shape.** Genie already sends a signed
 * service-callback envelope (`docs/genie-service-api-integration-guide.md` in
 * genie-v3-migration) and vFarm already sends a `vfarm.alert.v1` envelope to
 * any alert webhook (`alerts_pipeline/envelope.py` in bhavfarm), so the two
 * contracts are "send what you already send, to one more place". Only the
 * vFarm state snapshot is new on their side. What a page reads is promoted to
 * columns; the payload is kept whole beside them, so a field either system adds
 * before this dashboard reads it is kept rather than dropped.
 *
 * **Every write is an upsert on the sender's own id** — Genie's `eventId`,
 * vFarm's per-device `event_id`, a farm's, device's and open alert's own id —
 * so a retry, or the same event posted twice, updates one row.
 *
 * Three routes, all under /api/engine (index.ts):
 *   POST /api/engine/genie-events     one envelope, or { events: [...] } (≤200)
 *   POST /api/engine/vfarm-alerts     one vfarm.alert.v1 envelope
 *   POST /api/engine/vfarm-snapshot   one vfarm.snapshot.v1
 */
import { query, withTransaction } from './pg';
import * as events from './events';

export class FeedError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A string, trimmed; numbers become their text; anything else null. */
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
/** An ISO 8601 time, or null. A value that is present and not a time is refused by the caller, never guessed. */
function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
/** The first of several spellings a sender may use (Genie's envelope is camelCase; the spine fields are snake_case). */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}


/**
 * `dry_run: true` on any of the three routes runs every check and every write
 * against the real tables, then rolls the transaction back (2026-09-29). It is
 * how a sender — or this dashboard's own owner — proves a payload end to end
 * without leaving a test row on a live page, which the no-invented-data rule
 * forbids. A rolled-back write announces nothing to the open pages.
 */
class DryRunDone<T> extends Error {
  constructor(public result: T) {
    super('dry run');
  }
}
async function tx<T>(dry: boolean, fn: (db: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<T>): Promise<T & { dry_run: boolean }> {
  try {
    const r = await withTransaction(async (db) => {
      const out = await fn(db);
      if (dry) throw new DryRunDone(out);
      return out;
    });
    return { ...r, dry_run: false };
  } catch (e) {
    if (e instanceof DryRunDone) return { ...(e.result as T), dry_run: true };
    throw e;
  }
}

/* ------------------------------------------------------------------ Genie */

export interface GenieStoreResult {
  received: number;
  inserted: number;
  updated: number;
  event_ids: string[];
}

/** One envelope, validated into a row. Throws FeedError(422) naming the field. */
function genieRow(e: unknown, at: string) {
  if (!isObj(e)) throw new FeedError(422, `${at} is not a JSON object.`);
  const eventId = str(pick(e, 'eventId', 'event_id'));
  const eventType = str(pick(e, 'eventType', 'event_type'));
  if (!eventId) throw new FeedError(422, `${at}: eventId is required — it is what makes a retry update one row instead of adding a second.`);
  if (!eventType) throw new FeedError(422, `${at}: eventType is required, e.g. genie.message.completed.`);
  if (!eventType.startsWith('genie.')) throw new FeedError(422, `${at}: eventType "${eventType}" does not start with "genie." — this route takes Genie's own events only.`);
  const rawOccurred = pick(e, 'occurredAt', 'occurred_at');
  const occurred = iso(rawOccurred);
  if (rawOccurred !== undefined && !occurred) throw new FeedError(422, `${at}: occurredAt "${String(rawOccurred)}" is not an ISO 8601 time.`);
  const response = isObj(e.response) ? e.response : {};
  const failed = eventType.endsWith('.failed');
  const status = str(response.status) ?? (failed ? 'failed' : null);
  const duration = num(pick(e, 'durationMs', 'duration_ms'));
  return {
    event_id: eventId,
    event_type: eventType,
    request_id: str(pick(e, 'requestId', 'request_id')),
    run_id: str(pick(e, 'runId', 'run_id')),
    session_id: str(e.session_id),
    builder_id: str(e.builder_id),
    correlation_id: str(e.correlation_id),
    thread_id: str(e.thread_id),
    lane: str(e.lane),
    status,
    source: str(e.source),
    question: str(e.question),
    duration_ms: duration === null ? null : Math.max(0, Math.round(duration)),
    handoff: str(e.handoff),
    // Stamped now where the envelope carries no time, and said so on the log line.
    occurred_at: occurred ?? new Date().toISOString(),
    payload: e,
  };
}

export async function storeGenie(body: Obj): Promise<GenieStoreResult & { dry_run: boolean }> {
  const list = Array.isArray(body.events) ? body.events : [body];
  if (list.length === 0) throw new FeedError(422, 'events is empty — nothing to store.');
  if (list.length > 200) throw new FeedError(413, `${list.length} events in one call; send at most 200.`);
  // Every event is validated before any is written, so a bad one in a batch writes nothing.
  const rows = list.map((e, i) => genieRow(e, Array.isArray(body.events) ? `events[${i}]` : 'The event'));
  return tx(body.dry_run === true, async (db) => {
    let inserted = 0;
    for (const r of rows) {
      const q = await db.query<{ inserted: boolean }>(
        `INSERT INTO engine_genie_events (event_id, event_type, request_id, run_id, session_id, builder_id, correlation_id, thread_id, lane, status, source, question, duration_ms, handoff, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (event_id) DO UPDATE SET event_type = EXCLUDED.event_type, request_id = EXCLUDED.request_id, run_id = EXCLUDED.run_id,
           session_id = EXCLUDED.session_id, builder_id = EXCLUDED.builder_id, correlation_id = EXCLUDED.correlation_id, thread_id = EXCLUDED.thread_id,
           lane = EXCLUDED.lane, status = EXCLUDED.status, source = EXCLUDED.source, question = EXCLUDED.question, duration_ms = EXCLUDED.duration_ms,
           handoff = EXCLUDED.handoff, occurred_at = EXCLUDED.occurred_at, payload = EXCLUDED.payload, received_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [r.event_id, r.event_type, r.request_id, r.run_id, r.session_id, r.builder_id, r.correlation_id, r.thread_id, r.lane, r.status, r.source, r.question, r.duration_ms, r.handoff, r.occurred_at, JSON.stringify(r.payload)],
      );
      if (q.rows[0]?.inserted) inserted++;
    }
    events.changed('genie_events', null, db);
    return { received: rows.length, inserted, updated: rows.length - inserted, event_ids: rows.map((r) => r.event_id) };
  });
}

/* ------------------------------------------------------------ vFarm alerts */

export interface AlertStoreResult {
  received: number;
  inserted: number;
  updated: number;
  event_ids: string[];
}

/**
 * One `vfarm.alert.v1` envelope: `kind` single or digest, one `rule`, one
 * `place`, and `devices[]` — one row here per device entry, keyed on its own
 * `event_id` (vFarm's `alerts.alert_events.id`). An entry with no event_id is
 * keyed on rule, device and fire time, which is what makes it unique upstream.
 */
export async function storeVfarmAlert(body: Obj): Promise<AlertStoreResult & { dry_run: boolean }> {
  const schema = str(body.schema);
  if (schema && schema !== 'vfarm.alert.v1') throw new FeedError(422, `schema "${schema}" is not vfarm.alert.v1 — this route takes vFarm's alert webhook envelope.`);
  if (!Array.isArray(body.devices) || body.devices.length === 0) throw new FeedError(422, 'devices is missing or empty — an alert envelope names at least one device.');
  if (body.devices.length > 500) throw new FeedError(413, `${body.devices.length} device entries in one envelope; at most 500.`);
  const rule = isObj(body.rule) ? body.rule : {};
  const place = isObj(body.place) ? body.place : {};
  const envelopeFired = iso(body.fired_at);
  const rows = body.devices.map((d, i) => {
    if (!isObj(d)) throw new FeedError(422, `devices[${i}] is not an object.`);
    const deviceId = str(d.device_id);
    if (!deviceId) throw new FeedError(422, `devices[${i}].device_id is required.`);
    const fired = iso(d.fired_at) ?? iso(d.ts) ?? envelopeFired;
    if (!fired) throw new FeedError(422, `devices[${i}] has no fired_at, and neither has the envelope.`);
    const dPlace = isObj(d.place) ? d.place : place;
    const eventId = str(d.event_id) ?? `${str(rule.id) ?? 'rule?'}:${deviceId}:${fired}`;
    return {
      event_id: eventId,
      kind: str(body.kind),
      rule_id: str(rule.id),
      rule_name: str(rule.name),
      severity: str(rule.severity),
      metric: str(rule.metric),
      device_id: deviceId,
      value: num(d.value),
      farm_id: str(dPlace.farm_id) ?? str(place.farm_id),
      farm: str(dPlace.farm) ?? str(place.farm),
      place_path: str(dPlace.path) ?? str(place.path),
      fired_at: fired,
      payload: { ...body, devices: [d], dry_run: undefined },
    };
  });
  return tx(body.dry_run === true, async (db) => {
    let inserted = 0;
    for (const r of rows) {
      const q = await db.query<{ inserted: boolean }>(
        `INSERT INTO engine_vfarm_alert_events (event_id, kind, rule_id, rule_name, severity, metric, device_id, value, farm_id, farm, place_path, fired_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (event_id) DO UPDATE SET kind = EXCLUDED.kind, rule_id = EXCLUDED.rule_id, rule_name = EXCLUDED.rule_name, severity = EXCLUDED.severity,
           metric = EXCLUDED.metric, device_id = EXCLUDED.device_id, value = EXCLUDED.value, farm_id = EXCLUDED.farm_id, farm = EXCLUDED.farm,
           place_path = EXCLUDED.place_path, fired_at = EXCLUDED.fired_at, payload = EXCLUDED.payload, received_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [r.event_id, r.kind, r.rule_id, r.rule_name, r.severity, r.metric, r.device_id, r.value, r.farm_id, r.farm, r.place_path, r.fired_at, JSON.stringify(r.payload)],
      );
      if (q.rows[0]?.inserted) inserted++;
    }
    events.changed('vfarm_alerts', null, db);
    return { received: rows.length, inserted, updated: rows.length - inserted, event_ids: rows.map((r) => r.event_id) };
  });
}

/* ---------------------------------------------------------- vFarm snapshot */

export interface SnapshotStoreResult {
  taken_at: string;
  farms: number;
  devices: number;
  open_alerts: number;
  devices_gone: number;
  alerts_closed: number;
}

/**
 * The state of every farm vFarm sends, every few minutes: farms with their
 * health, devices with where they sit and when they last reported, the open
 * alerts, and the alert pipeline's own health.
 *
 * **Absence is only read inside the farms the snapshot covers.** A device of a
 * listed farm that is not in the device list is marked gone; an open alert not
 * in the list is marked closed. A farm the snapshot does not list is left
 * exactly as it was — a partial snapshot must never read as a farm emptying.
 * An older snapshot arriving after a newer one changes nothing.
 */
export async function storeVfarmSnapshot(body: Obj): Promise<SnapshotStoreResult & { dry_run: boolean }> {
  const schema = str(body.schema);
  if (schema !== 'vfarm.snapshot.v1') throw new FeedError(422, `schema must be "vfarm.snapshot.v1"${schema ? `, not "${schema}"` : ''}.`);
  const takenAt = iso(body.taken_at);
  if (!takenAt) throw new FeedError(422, 'taken_at is required, as an ISO 8601 time.');
  if (!Array.isArray(body.farms) || body.farms.length === 0) throw new FeedError(422, 'farms is missing or empty — a snapshot covers at least one farm.');
  const devices = Array.isArray(body.devices) ? body.devices : null;
  const alerts = Array.isArray(body.open_alerts) ? body.open_alerts : null;
  if (!devices) throw new FeedError(422, 'devices is required (an empty list is allowed, and means the listed farms have none).');
  if (!alerts) throw new FeedError(422, 'open_alerts is required (an empty list means nothing is open in the listed farms).');
  if (devices.length > 5000 || alerts.length > 5000) throw new FeedError(413, 'At most 5,000 devices and 5,000 open alerts in one snapshot.');

  const farms = body.farms.map((f, i) => {
    if (!isObj(f)) throw new FeedError(422, `farms[${i}] is not an object.`);
    const id = str(f.id);
    if (!id) throw new FeedError(422, `farms[${i}].id is required.`);
    return { id, f };
  });
  const farmIds = farms.map((x) => x.id);
  const devs = devices.map((d, i) => {
    if (!isObj(d)) throw new FeedError(422, `devices[${i}] is not an object.`);
    const id = str(d.id);
    if (!id) throw new FeedError(422, `devices[${i}].id is required.`);
    const farmId = str(d.farm_id);
    if (!farmId || !farmIds.includes(farmId)) throw new FeedError(422, `devices[${i}] (${id}) names farm_id "${farmId ?? ''}", which is not in this snapshot's farms.`);
    for (const k of ['last_seen_at', 'last_reading_at'] as const) {
      if (d[k] !== undefined && d[k] !== null && !iso(d[k])) throw new FeedError(422, `devices[${i}].${k} "${String(d[k])}" is not an ISO 8601 time.`);
    }
    return { id, farmId, d };
  });
  const opens = alerts.map((a, i) => {
    if (!isObj(a)) throw new FeedError(422, `open_alerts[${i}] is not an object.`);
    const id = str(a.id);
    if (!id) throw new FeedError(422, `open_alerts[${i}].id is required.`);
    return { id, a };
  });

  return tx(body.dry_run === true, async (db) => {
    // An older snapshot than the newest held changes nothing: posts can arrive out of order on a retry.
    const newest = await db.query<{ t: string | null }>(`SELECT (extract(epoch FROM max(taken_at)) * 1000)::bigint::text AS t FROM engine_vfarm_snapshots`);
    const newestMs = newest.rows[0]?.t ? Number(newest.rows[0].t) : null;
    if (newestMs !== null && newestMs > Date.parse(takenAt)) {
      throw new FeedError(409, `A newer snapshot (${new Date(newestMs).toISOString()}) is already held; this one (${takenAt}) was not applied.`);
    }
    for (const { id, f } of farms) {
      await db.query(
        `INSERT INTO engine_vfarm_farms (farm_id, code, name, status, device_count, online_count, offline_count, unhealthy_count, fields, snapshot_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (farm_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, status = EXCLUDED.status, device_count = EXCLUDED.device_count,
           online_count = EXCLUDED.online_count, offline_count = EXCLUDED.offline_count, unhealthy_count = EXCLUDED.unhealthy_count,
           fields = EXCLUDED.fields, snapshot_at = EXCLUDED.snapshot_at, updated_at = now()`,
        [id, str(f.code), str(f.name), str(f.status), num(f.device_count), num(f.online_count), num(f.offline_count), num(f.unhealthy_count), JSON.stringify(f), takenAt],
      );
    }
    for (const { id, farmId, d } of devs) {
      await db.query(
        `INSERT INTO engine_vfarm_devices (device_id, farm_id, place, device_type, model, status, health_score, last_seen_at, last_reading_at, latest, fields, snapshot_at, gone_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NULL, now())
         ON CONFLICT (device_id) DO UPDATE SET farm_id = EXCLUDED.farm_id, place = EXCLUDED.place, device_type = EXCLUDED.device_type, model = EXCLUDED.model,
           status = EXCLUDED.status, health_score = EXCLUDED.health_score, last_seen_at = EXCLUDED.last_seen_at, last_reading_at = EXCLUDED.last_reading_at,
           latest = EXCLUDED.latest, fields = EXCLUDED.fields, snapshot_at = EXCLUDED.snapshot_at, gone_at = NULL, updated_at = now()`,
        [
          id,
          farmId,
          str(d.place),
          str(d.device_type),
          str(d.model),
          str(d.status),
          num(d.health_score),
          iso(d.last_seen_at),
          iso(d.last_reading_at),
          isObj(d.latest) ? JSON.stringify(d.latest) : null,
          JSON.stringify(d),
          takenAt,
        ],
      );
    }
    const gone = await db.query(
      `UPDATE engine_vfarm_devices SET gone_at = $3, updated_at = now()
        WHERE farm_id = ANY($1::text[]) AND gone_at IS NULL AND NOT (device_id = ANY($2::text[]))`,
      [farmIds, devs.map((x) => x.id), takenAt],
    );
    for (const { id, a } of opens) {
      await db.query(
        `INSERT INTO engine_vfarm_open_alerts (alert_id, rule_id, device_id, farm_id, farm_name, place, severity, title, detail, last_value, opened_at, fields, last_seen_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NULL)
         ON CONFLICT (alert_id) DO UPDATE SET rule_id = EXCLUDED.rule_id, device_id = EXCLUDED.device_id, farm_id = EXCLUDED.farm_id, farm_name = EXCLUDED.farm_name,
           place = EXCLUDED.place, severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail, last_value = EXCLUDED.last_value,
           opened_at = EXCLUDED.opened_at, fields = EXCLUDED.fields, last_seen_at = EXCLUDED.last_seen_at, closed_at = NULL`,
        [id, str(a.rule_id), str(a.device_id), str(a.farm_id), str(a.farm_name), str(a.place), str(a.severity), str(a.title), str(a.detail), num(a.last_value), iso(a.opened_at), JSON.stringify(a), takenAt],
      );
    }
    // An open alert of a listed farm that the snapshot no longer lists has cleared. One whose farm_id is blank is judged with the rest of the snapshot.
    const closed = await db.query(
      `UPDATE engine_vfarm_open_alerts SET closed_at = $3
        WHERE closed_at IS NULL AND (farm_id = ANY($1::text[]) OR farm_id IS NULL) AND NOT (alert_id = ANY($2::text[]))`,
      [farmIds, opens.map((x) => x.id), takenAt],
    );
    await db.query(`INSERT INTO engine_vfarm_snapshots (taken_at, farms, devices, open_alerts, pipeline) VALUES ($1,$2,$3,$4,$5)`, [
      takenAt,
      farms.length,
      devs.length,
      opens.length,
      isObj(body.alert_pipeline) ? JSON.stringify(body.alert_pipeline) : null,
    ]);
    events.changed('vfarm_state', null, db);
    return { taken_at: takenAt, farms: farms.length, devices: devs.length, open_alerts: opens.length, devices_gone: gone.rowCount ?? 0, alerts_closed: closed.rowCount ?? 0 };
  });
}

/* ------------------------------------------------------------------ reads */

interface Share {
  n: number;
  of: number;
  pct: number | null;
  note: string;
}
interface Percentiles {
  p50: number | null;
  p95: number | null;
  n: number;
  of: number;
  note: string;
}
const share = (n: number, of: number, note: string): Share => ({ n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note });
/** Nearest-rank p50 and p95, as store.ts computes them: a real observation, never an interpolation. */
function percentiles(values: number[], of: number, note: string): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note };
}
function tally(values: Array<string | null>, blank: string): Array<{ key: string; label: string; n: number }> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v ?? blank, (m.get(v ?? blank) ?? 0) + 1);
  return [...m.entries()].map(([key, n]) => ({ key, label: key, n })).sort((a, b) => b.n - a.n);
}
/** Monday of the ISO week, UTC, as YYYY-MM-DD. */
function weekOf(t: string): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/**
 * An ask's outcome, from the words Genie itself sends. `satisfied` is
 * Answered; `max_iterations_reached` is Incomplete (it stopped before its judge
 * was satisfied, which is not the same as failing); a `.failed` event or an
 * `error` status is Failed. Anything else is kept under its own name rather
 * than folded into one of those three.
 */
export function genieOutcome(eventType: string, status: string | null): string {
  if (eventType.endsWith('.failed') || status === 'error' || status === 'failed') return 'Failed';
  if (status === 'satisfied') return 'Answered';
  if (status === 'max_iterations_reached') return 'Incomplete';
  return status ?? 'No status';
}

interface GenieRow {
  event_id: string;
  event_type: string;
  request_id: string | null;
  run_id: string | null;
  builder_id: string | null;
  lane: string | null;
  status: string | null;
  source: string | null;
  question: string | null;
  duration_ms: number | null;
  handoff: string | null;
  occurred_at: string;
  received_at: string;
  answer: string | null;
  error: string | null;
}

export async function genieData() {
  const r = await query<GenieRow>(
    `SELECT DISTINCT ON (coalesce(request_id, event_id))
            event_id, event_type, request_id, run_id, builder_id, lane, status, source, question, duration_ms, handoff,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
            to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
            left(payload->'response'->>'finalOutput', 600) AS answer,
            left(coalesce(payload->'error'->>'message', payload->'response'->>'judgeSummary'), 400) AS error
       FROM engine_genie_events
      WHERE event_type NOT LIKE 'genie.subagent.%'
      ORDER BY coalesce(request_id, event_id), occurred_at DESC`,
  );
  const meta = await query<{ events: number; subagent: number; first: string | null; last: string | null; last_received: string | null }>(
    `SELECT count(*)::int AS events,
            count(*) FILTER (WHERE event_type LIKE 'genie.subagent.%')::int AS subagent,
            to_char(min(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first,
            to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last,
            to_char(max(received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_received
       FROM engine_genie_events`,
  );
  const asks = r.rows
    .map((a) => ({ ...a, outcome: genieOutcome(a.event_type, a.status) }))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  const n = asks.length;
  const answered = asks.filter((a) => a.outcome === 'Answered').length;
  const failed = asks.filter((a) => a.outcome === 'Failed').length;
  const handed = asks.filter((a) => a.handoff).length;
  const now = Date.now();
  const last7 = asks.filter((a) => now - Date.parse(a.occurred_at) < 7 * 86_400_000).length;
  const durations = asks.filter((a) => a.duration_ms !== null).map((a) => (a.duration_ms as number) / 1000);

  // The last eight weeks, oldest first, a week with nothing held drawn as nothing held.
  const weeks: Array<{ week: string; label: string; total: number; counts: Record<string, number> }> = [];
  for (let i = 7; i >= 0; i--) {
    const w = weekOf(new Date(now - i * 7 * 86_400_000).toISOString());
    weeks.push({ week: w, label: new Date(`${w}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), total: 0, counts: {} });
  }
  for (const a of asks) {
    const w = weeks.find((x) => x.week === weekOf(a.occurred_at));
    if (!w) continue;
    w.total++;
    w.counts[a.outcome] = (w.counts[a.outcome] ?? 0) + 1;
  }
  const cohort = (key: (a: (typeof asks)[number]) => string | null, blank: string) =>
    tally(asks.map(key), blank).map((s) => {
      const mine = asks.filter((a) => (key(a) ?? blank) === s.key);
      return { key: s.key, label: s.label, asks: mine.length, answered: mine.filter((a) => a.outcome === 'Answered').length, delivered: mine.filter((a) => a.outcome !== 'Failed').length, external: null };
    });

  const m = meta.rows[0];
  return {
    asks,
    meta: {
      events: m?.events ?? 0,
      subagent_events: m?.subagent ?? 0,
      first_event_at: m?.first ?? null,
      last_event_at: m?.last ?? null,
      last_received_at: m?.last_received ?? null,
    },
    summary: {
      asks: n,
      last_7_days: last7,
      answered: share(answered, n, 'Asks whose last event says satisfied — Genie\'s own judge accepted the answer. An ask that stopped at its iteration limit is Incomplete, not Answered and not Failed.'),
      failed: share(failed, n, 'Asks whose last event is genie.*.failed or carries status error. Genie also opens a BHARAG incident for these.'),
      handed_off: share(handed, n, 'Asks Genie sent on to Research Twin or North Star, where the event names the hand-off. Counted only where Genie says so.'),
      duration: percentiles(durations, n, durations.length === n ? `Over all ${n} asks.` : `Over the ${durations.length} of ${n} asks that sent duration_ms. An ask without it is left out, never counted as instant.`),
      outcome_mix: tally(asks.map((a) => a.outcome), 'No status'),
      outcome_per_week: weeks,
      by_lane: cohort((a) => a.lane, '(no lane)'),
      by_source: cohort((a) => a.source, '(not sent)'),
    },
  };
}

export async function vfarmData() {
  const [farms, devices, open, closed, fired, snaps] = await Promise.all([
    query(`SELECT farm_id, code, name, status, device_count, online_count, offline_count, unhealthy_count,
                  to_char(snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS snapshot_at
             FROM engine_vfarm_farms ORDER BY name NULLS LAST, farm_id`),
    query(`SELECT d.device_id, d.farm_id, f.name AS farm_name, d.place, d.device_type, d.model, d.status, d.health_score, d.latest,
                  to_char(d.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen_at,
                  to_char(d.last_reading_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_reading_at,
                  to_char(d.gone_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS gone_at
             FROM engine_vfarm_devices d LEFT JOIN engine_vfarm_farms f ON f.farm_id = d.farm_id
            ORDER BY d.gone_at NULLS FIRST, d.last_reading_at DESC NULLS LAST, d.device_id`),
    query(`SELECT alert_id, rule_id, device_id, farm_id, farm_name, place, severity, title, detail, last_value,
                  to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opened_at
             FROM engine_vfarm_open_alerts WHERE closed_at IS NULL ORDER BY opened_at DESC NULLS LAST`),
    query(`SELECT alert_id, device_id, farm_name, severity, title,
                  to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opened_at,
                  to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at
             FROM engine_vfarm_open_alerts WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 100`),
    query(`SELECT event_id, kind, rule_id, rule_name, severity, metric, device_id, value, farm_id, farm, place_path,
                  to_char(fired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fired_at
             FROM engine_vfarm_alert_events ORDER BY fired_at DESC LIMIT 200`),
    query<{ taken_at: string; received_at: string; farms: number; devices: number; open_alerts: number; pipeline: unknown }>(
      `SELECT to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at,
              to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at, farms, devices, open_alerts, pipeline
         FROM engine_vfarm_snapshots ORDER BY taken_at DESC LIMIT 1`,
    ),
  ]);
  const counts = await query<{ fired_24h: number; fired_all: number; snapshots: number }>(
    `SELECT (SELECT count(*) FROM engine_vfarm_alert_events WHERE fired_at > now() - interval '24 hours')::int AS fired_24h,
            (SELECT count(*) FROM engine_vfarm_alert_events)::int AS fired_all,
            (SELECT count(*) FROM engine_vfarm_snapshots)::int AS snapshots`,
  );
  return {
    last_snapshot: snaps.rows[0] ?? null,
    snapshots: counts.rows[0]?.snapshots ?? 0,
    farms: farms.rows,
    devices: devices.rows,
    open_alerts: open.rows,
    recently_closed: closed.rows,
    alert_events: fired.rows,
    alerts_fired_24h: counts.rows[0]?.fired_24h ?? 0,
    alerts_fired_all: counts.rows[0]?.fired_all ?? 0,
  };
}
