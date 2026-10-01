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
 *   POST /api/engine/cst-events       one cst.event.v1, or { events: [...] } (≤200)
 *                                     — the Customer Service Twin, added the same day
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
  retention_cleared_at: string | null;
}

export async function genieData() {
  const r = await query<GenieRow>(
    `SELECT DISTINCT ON (coalesce(request_id, event_id))
            event_id, event_type, request_id, run_id, builder_id, lane, status, source, question, duration_ms, handoff,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
            to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
            left(payload->'response'->>'finalOutput', 600) AS answer,
            left(coalesce(payload->'error'->>'message', payload->'response'->>'judgeSummary'), 400) AS error,
            to_char(retention_cleared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS retention_cleared_at
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

/* ------------------------------------------------- Customer Service Twin */

/**
 * The Customer Service Twin, pushed as it happens (2026-09-29, Destiny).
 * `POST /api/engine/cst-events`, one `cst.event.v1` event or `{ events: [...] }`
 * (≤200). Two event types, both keyed on CST's own `turn_id` — the
 * `correlation_id` its MessageEnvelope already carries:
 *
 *   cst.turn      one customer message and CST's reply, after processEnvelope
 *   cst.delivery  what became of that reply (queued, sent, delivered,
 *                 undelivered, failed), from CST's outbound queue and Twilio's
 *                 delivery callback
 *
 * **They land on one row and each touches only its own columns**, so they can
 * arrive in either order. A delivery never moves backwards: Twilio's callbacks
 * arrive out of order, and a late "sent" must not undo a "delivered".
 * The dashboard keeps the whole record — the message, the reply and the
 * customer's number (Destiny, 2026-09-29) — because the page is the record.
 */
export const CST_CHANNELS = ['sms', 'voice', 'web', 'whatsapp', 'email'];
export const CST_STATUSES = ['ok', 'refused', 'step_up_required', 'onboarding', 'error'];
export const CST_DELIVERY = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'];
const DELIVERY_RANK: Record<string, number> = { queued: 1, sending: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3 };

export interface CstStoreResult {
  received: number;
  turns: number;
  deliveries: number;
  inserted: number;
  updated: number;
  unchanged: number;
  turn_ids: string[];
}

type CstEvent =
  | { type: 'turn'; turn_id: string; row: Record<string, unknown>; payload: Obj }
  | { type: 'delivery'; turn_id: string; status: string; error: string | null; attempts: number | null; at: string; payload: Obj };

function cstEvent(e: unknown, at: string): CstEvent {
  if (!isObj(e)) throw new FeedError(422, `${at} is not a JSON object.`);
  const schema = str(e.schema);
  if (schema && schema !== 'cst.event.v1') throw new FeedError(422, `${at}: schema "${schema}" is not cst.event.v1.`);
  const type = str(pick(e, 'event_type', 'eventType'));
  const turnId = str(pick(e, 'turn_id', 'turnId', 'correlation_id'));
  if (!turnId) throw new FeedError(422, `${at}: turn_id is required — the envelope's correlation_id. It is what puts a turn and its delivery on one row, and a retry on the same row.`);
  if (type === 'cst.delivery') {
    const status = str(e.status)?.toLowerCase() ?? null;
    if (!status || !CST_DELIVERY.includes(status)) throw new FeedError(422, `${at}: a cst.delivery needs status, one of ${CST_DELIVERY.join(', ')}; got "${String(e.status)}".`);
    const rawAt = pick(e, 'occurred_at', 'at');
    const when = iso(rawAt);
    if (rawAt !== undefined && !when) throw new FeedError(422, `${at}: occurred_at "${String(rawAt)}" is not an ISO 8601 time.`);
    const attempts = num(e.attempts);
    return { type: 'delivery', turn_id: turnId, status, error: str(e.error), attempts: attempts === null ? null : Math.round(attempts), at: when ?? new Date().toISOString(), payload: e };
  }
  if (type !== 'cst.turn') throw new FeedError(422, `${at}: event_type must be cst.turn or cst.delivery; got "${String(type)}".`);
  const channel = str(e.channel)?.toLowerCase() ?? null;
  if (!channel || !CST_CHANNELS.includes(channel)) throw new FeedError(422, `${at}: channel is required, one of ${CST_CHANNELS.join(', ')}; got "${String(e.channel)}".`);
  const status = str(e.status)?.toLowerCase() ?? null;
  if (!status || !CST_STATUSES.includes(status)) throw new FeedError(422, `${at}: status is required, one of ${CST_STATUSES.join(', ')}; got "${String(e.status)}". An unknown caller's onboarding reply is "onboarding".`);
  const rawOccurred = pick(e, 'occurred_at', 'occurredAt');
  const occurred = iso(rawOccurred);
  if (rawOccurred !== undefined && !occurred) throw new FeedError(422, `${at}: occurred_at "${String(rawOccurred)}" is not an ISO 8601 time.`);
  const c = isObj(e.customer) ? e.customer : {};
  const known = c.is_known;
  const duration = num(e.duration_ms);
  return {
    type: 'turn',
    turn_id: turnId,
    payload: e,
    row: {
      conversation_id: str(e.conversation_id),
      tenant_id: str(e.tenant_id),
      project_id: str(e.project_id),
      channel,
      customer_ref: str(c.customer_ref),
      person_id: str(c.person_id),
      phone_e164: str(c.phone_e164),
      customer_name: str(c.name),
      role: str(c.role),
      is_known: typeof known === 'boolean' ? known : null,
      message: str(e.message),
      reply: str(e.reply),
      intent: str(e.intent),
      status,
      reason: str(e.reason),
      incident_id: str(e.incident_id),
      duration_ms: duration === null ? null : Math.max(0, Math.round(duration)),
      occurred_at: occurred ?? new Date().toISOString(),
    },
  };
}

const TURN_COLS = [
  'conversation_id', 'tenant_id', 'project_id', 'channel', 'customer_ref', 'person_id', 'phone_e164', 'customer_name', 'role', 'is_known',
  'message', 'reply', 'intent', 'status', 'reason', 'incident_id', 'duration_ms', 'occurred_at',
];

export async function storeCst(body: Obj): Promise<CstStoreResult & { dry_run: boolean }> {
  const batch = Array.isArray(body.events);
  const list = batch ? (body.events as unknown[]) : [body];
  if (list.length === 0) throw new FeedError(422, 'events is empty — nothing to store.');
  if (list.length > 200) throw new FeedError(413, `${list.length} events in one call; send at most 200.`);
  // Every event is checked before any is written, so one bad event in a batch writes nothing.
  const evs = list.map((e, i) => cstEvent(e, batch ? `events[${i}]` : 'The event'));
  return tx(body.dry_run === true, async (db) => {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const ev of evs) {
      if (ev.type === 'turn') {
        const vals = TURN_COLS.map((k) => ev.row[k]);
        const set = TURN_COLS.map((k) => `${k} = EXCLUDED.${k}`).join(', ');
        const changedCheck = TURN_COLS.map((k) => `engine_cst_turns.${k} IS DISTINCT FROM EXCLUDED.${k}`).join(' OR ');
        const r = await db.query<{ inserted: boolean }>(
          `INSERT INTO engine_cst_turns (turn_id, ${TURN_COLS.join(', ')}, turn_payload)
           VALUES ($1, ${TURN_COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${TURN_COLS.length + 2})
           ON CONFLICT (turn_id) DO UPDATE SET ${set}, turn_payload = EXCLUDED.turn_payload, received_at = now()
             WHERE ${changedCheck} OR engine_cst_turns.turn_payload IS NULL
           RETURNING (xmax = 0) AS inserted`,
          [ev.turn_id, ...vals, JSON.stringify(ev.payload)],
        );
        if (!r.rows.length) unchanged++;
        else if (r.rows[0].inserted) inserted++;
        else updated++;
      } else {
        const rank = DELIVERY_RANK[ev.status] ?? 0;
        const r = await db.query<{ inserted: boolean }>(
          `INSERT INTO engine_cst_turns (turn_id, delivery_status, delivery_error, delivery_attempts, delivery_at, delivery_payload)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (turn_id) DO UPDATE SET delivery_status = EXCLUDED.delivery_status, delivery_error = EXCLUDED.delivery_error,
             delivery_attempts = coalesce(EXCLUDED.delivery_attempts, engine_cst_turns.delivery_attempts),
             delivery_at = EXCLUDED.delivery_at, delivery_payload = EXCLUDED.delivery_payload
             WHERE (CASE engine_cst_turns.delivery_status WHEN 'queued' THEN 1 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2
                      WHEN 'delivered' THEN 3 WHEN 'undelivered' THEN 3 WHEN 'failed' THEN 3 ELSE 0 END) <= $7
               AND (engine_cst_turns.delivery_status IS DISTINCT FROM EXCLUDED.delivery_status
                    OR engine_cst_turns.delivery_error IS DISTINCT FROM EXCLUDED.delivery_error
                    OR engine_cst_turns.delivery_attempts IS DISTINCT FROM EXCLUDED.delivery_attempts)
           RETURNING (xmax = 0) AS inserted`,
          [ev.turn_id, ev.status, ev.error, ev.attempts, ev.at, JSON.stringify(ev.payload), rank],
        );
        if (!r.rows.length) unchanged++;
        else if (r.rows[0].inserted) inserted++;
        else updated++;
      }
    }
    if (inserted || updated) events.changed('cst_turns', null, db);
    return {
      received: evs.length,
      turns: evs.filter((e) => e.type === 'turn').length,
      deliveries: evs.filter((e) => e.type === 'delivery').length,
      inserted,
      updated,
      unchanged,
      turn_ids: evs.map((e) => e.turn_id),
    };
  });
}

/**
 * A turn's outcome, from the words CST itself sends. `ok` is Answered, or
 * Escalated where the intent was escalate (a person was asked for and an
 * incident filed — the reply is CST's acknowledgement, not the answer);
 * `refused` is Refused (a guard did its job); `step_up_required` is Needs
 * verification; `onboarding` is Unknown caller (a number vFarm does not know,
 * served the onboarding reply and nothing else); `error` is Failed.
 */
export function cstOutcome(status: string | null, intent: string | null): string {
  if (status === null) return 'Turn not received';
  if (status === 'ok') return intent === 'escalate' ? 'Escalated' : 'Answered';
  if (status === 'refused') return 'Refused';
  if (status === 'step_up_required') return 'Needs verification';
  if (status === 'onboarding') return 'Unknown caller';
  if (status === 'error') return 'Failed';
  return status;
}

interface CstRow {
  turn_id: string;
  conversation_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  channel: string | null;
  customer_ref: string | null;
  person_id: string | null;
  phone_e164: string | null;
  customer_name: string | null;
  role: string | null;
  is_known: boolean | null;
  message: string | null;
  reply: string | null;
  intent: string | null;
  status: string | null;
  reason: string | null;
  incident_id: string | null;
  duration_ms: number | null;
  occurred_at: string | null;
  received_at: string;
  delivery_status: string | null;
  delivery_error: string | null;
  delivery_attempts: number | null;
  delivery_at: string | null;
  retention_cleared_at: string | null;
}

export async function cstData() {
  const t = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ${c.replace(/.*\./, '')}`;
  const r = await query<CstRow>(
    `SELECT turn_id, conversation_id, tenant_id, project_id, channel, customer_ref, person_id, phone_e164, customer_name, role, is_known,
            message, reply, intent, status, reason, incident_id, duration_ms, ${t('occurred_at')}, ${t('received_at')},
            delivery_status, delivery_error, delivery_attempts, ${t('delivery_at')}, ${t('retention_cleared_at')}
       FROM engine_cst_turns
      ORDER BY coalesce(occurred_at, received_at) DESC`,
  );
  const turns = r.rows.map((x) => ({ ...x, outcome: cstOutcome(x.status, x.intent) }));
  const real = turns.filter((x) => x.status !== null);
  const n = real.length;
  const now = Date.now();
  const at = (x: CstRow) => Date.parse(x.occurred_at ?? x.received_at);
  const count = (o: string) => real.filter((x) => x.outcome === o).length;
  const withDelivery = real.filter((x) => x.delivery_status);
  const deliveredN = withDelivery.filter((x) => x.delivery_status === 'delivered').length;
  const lostN = withDelivery.filter((x) => x.delivery_status === 'failed' || x.delivery_status === 'undelivered').length;
  const durations = real.filter((x) => x.duration_ms !== null).map((x) => (x.duration_ms as number) / 1000);
  const conversations = new Set(real.map((x) => x.conversation_id ?? `turn:${x.turn_id}`)).size;
  const customers = new Set(real.map((x) => x.phone_e164 ?? x.customer_ref ?? `turn:${x.turn_id}`)).size;

  const weeks: Array<{ week: string; label: string; total: number; counts: Record<string, number> }> = [];
  for (let i = 7; i >= 0; i--) {
    const w = weekOf(new Date(now - i * 7 * 86_400_000).toISOString());
    weeks.push({ week: w, label: new Date(`${w}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), total: 0, counts: {} });
  }
  for (const x of real) {
    const w = weeks.find((k) => k.week === weekOf(new Date(at(x)).toISOString()));
    if (!w) continue;
    w.total++;
    w.counts[x.outcome] = (w.counts[x.outcome] ?? 0) + 1;
  }
  const cohort = (key: (x: (typeof real)[number]) => string | null, blank: string) =>
    tally(real.map(key), blank).map((s) => {
      const mine = real.filter((x) => (key(x) ?? blank) === s.key);
      const md = mine.filter((x) => x.delivery_status);
      return {
        key: s.key,
        label: s.label,
        turns: mine.length,
        answered: mine.filter((x) => x.outcome === 'Answered').length,
        escalated: mine.filter((x) => x.outcome === 'Escalated').length,
        with_delivery: md.length,
        lost: md.filter((x) => x.delivery_status === 'failed' || x.delivery_status === 'undelivered').length,
      };
    });
  const m = await query<{ first: string | null; last_received: string | null; orphans: number }>(
    `SELECT to_char(min(coalesce(occurred_at, received_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first,
            to_char(max(greatest(received_at, coalesce(delivery_at, received_at))) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_received,
            count(*) FILTER (WHERE status IS NULL)::int AS orphans
       FROM engine_cst_turns`,
  );
  return {
    turns,
    meta: {
      rows: turns.length,
      first_at: m.rows[0]?.first ?? null,
      last_received_at: m.rows[0]?.last_received ?? null,
      deliveries_without_turn: m.rows[0]?.orphans ?? 0,
    },
    summary: {
      turns: n,
      conversations,
      customers,
      last_7_days: real.filter((x) => now - at(x) < 7 * 86_400_000).length,
      answered: share(count('Answered'), n, 'Turns CST answered itself: status ok, from vFarm status or BHARAG knowledge.'),
      escalated: share(count('Escalated'), n, 'Turns where the customer asked for a person: CST filed an incident and acknowledged.'),
      refused: share(count('Refused') + count('Needs verification'), n, 'Turns a guard stopped: no farm access, a control or role change asked for, or step-up verification needed. A guard doing its job, not a fault.'),
      unknown: share(count('Unknown caller'), n, 'Turns from a number vFarm does not know. They get the onboarding reply and no farm data.'),
      failed: share(count('Failed'), n, 'Turns where CST errored before it could reply.'),
      delivered: share(
        deliveredN,
        withDelivery.length,
        withDelivery.length === n
          ? `Over all ${n} turns.`
          : `Over the ${withDelivery.length} of ${n} turns CST has sent a delivery status for. Voice and web replies have no Twilio delivery, and a turn still waiting on one is left out rather than counted either way.`,
      ),
      lost: share(lostN, withDelivery.length, 'Replies Twilio reports as failed or undelivered: the customer never got an answer.'),
      duration: percentiles(durations, n, durations.length === n ? `Over all ${n} turns.` : `Over the ${durations.length} of ${n} turns that sent duration_ms. A turn without it is left out, never counted as instant.`),
      outcome_mix: tally(real.map((x) => x.outcome), 'No status'),
      outcome_per_week: weeks,
      by_intent: cohort((x) => x.intent, '(not sent)'),
      by_channel: cohort((x) => x.channel, '(not sent)'),
      by_project: cohort((x) => x.project_id, '(not sent)'),
    },
  };
}

/* --------------------------------------------------------- Media doctrine */

/**
 * Media Twin doctrine (2026-09-30, Destiny — HMJV's third section). Hardik owns
 * the rules for what vFarm's public surfaces may claim — B93H (buyer capability
 * list), TSNR (commercial vocabulary), OWLG (mechanical → media handoff) and any
 * that follow. Every time one of them changes, Hardik posts one
 * `media.doctrine.v1` record: which doctrine, its new version, what changed,
 * the contracts it binds, the default patterns it applies, and the claim-level
 * maturity states it sets. The agents and this page then read the version in
 * force rather than a copy someone remembered.
 *
 * **No silent edits.** A change_id posted again with identical content is
 * unchanged; with different content it is refused, and so is a second change_id
 * for a (doctrine_id, version) already held. A correction is a new version that
 * supersedes the old one — OWLG's own rule, enforced here rather than trusted.
 */
export const DOCTRINE_CHANGE_TYPES = ['created', 'amended', 'superseded', 'retired'];
/** The maturity states B93H and OWLG already use. Anything else in the same UPPER_SNAKE shape is kept under its own name. */
export const DOCTRINE_MATURITIES = [
  'PROVEN_NOW',
  'PROVEN_BUT_GATED',
  'CONTRACT_DEFINED_NOT_RUNTIME_PROVEN',
  'IN_BUILD',
  'NEEDS_EVIDENCE',
  'NOT_SAFE_TO_CLAIM',
];

export interface DoctrineStoreResult {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  change_ids: string[];
}

const strList = (v: unknown, at: string, field: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new FeedError(422, `${at}: ${field} must be a list of strings.`);
  return v.map((x, i) => {
    const s = str(x);
    if (!s) throw new FeedError(422, `${at}: ${field}[${i}] is empty or not a string.`);
    return s;
  });
};

function doctrineRow(e: unknown, at: string) {
  if (!isObj(e)) throw new FeedError(422, `${at} is not a JSON object.`);
  const schema = str(e.schema);
  if (schema && schema !== 'media.doctrine.v1') throw new FeedError(422, `${at}: schema "${schema}" is not media.doctrine.v1.`);
  const need = (k: string, why: string) => {
    const v = str(e[k]);
    if (!v) throw new FeedError(422, `${at}: ${k} is required — ${why}`);
    return v;
  };
  const change_id = need('change_id', 'it is what makes a retry update one row instead of adding a second.');
  const doctrine_id = need('doctrine_id', 'the short id of the doctrine or contract, e.g. B93H.').toUpperCase();
  const version = need('version', 'the version this change puts in force, e.g. v0.1.');
  const change_type = need('change_type', `one of ${DOCTRINE_CHANGE_TYPES.join(', ')}.`).toLowerCase();
  if (!DOCTRINE_CHANGE_TYPES.includes(change_type)) throw new FeedError(422, `${at}: change_type "${change_type}" is not one of ${DOCTRINE_CHANGE_TYPES.join(', ')}.`);
  const summary = need('summary', 'what changed, in plain words.');
  const rawChanged = e.changed_at;
  const changed_at = iso(rawChanged);
  if (!changed_at) throw new FeedError(422, `${at}: changed_at is required as an ISO 8601 time${rawChanged !== undefined ? ` (got "${String(rawChanged)}")` : ''}.`);
  const rawApproved = e.approved_at;
  const approved_at = iso(rawApproved);
  if (rawApproved !== undefined && rawApproved !== null && !approved_at) throw new FeedError(422, `${at}: approved_at "${String(rawApproved)}" is not an ISO 8601 time.`);
  const previous_version = str(e.previous_version);
  if (change_type !== 'created' && !previous_version) throw new FeedError(422, `${at}: previous_version is required for a change of type ${change_type} — it is what makes the supersession visible.`);
  if (previous_version && previous_version === version) throw new FeedError(422, `${at}: previous_version and version are both "${version}". A change must put a new version in force.`);
  let claims: Obj[] = [];
  if (e.claims !== undefined && e.claims !== null) {
    if (!Array.isArray(e.claims)) throw new FeedError(422, `${at}: claims must be a list.`);
    claims = e.claims.map((c, i) => {
      if (!isObj(c)) throw new FeedError(422, `${at}: claims[${i}] is not an object.`);
      const label = str(c.label);
      // Checked as sent, not upper-cased first: "maybe" is not a maturity state, and folding it to MAYBE would store one.
      const maturity = str(c.maturity);
      if (!label) throw new FeedError(422, `${at}: claims[${i}].label is required.`);
      if (!maturity || !/^[A-Z][A-Z_]*$/.test(maturity)) throw new FeedError(422, `${at}: claims[${i}].maturity is required, in UPPER_SNAKE form, e.g. ${DOCTRINE_MATURITIES.join(', ')}.`);
      return {
        claim_id: str(c.claim_id),
        label,
        maturity,
        allowed_wording: str(c.allowed_wording),
        prohibited_wording: str(c.prohibited_wording),
      };
    });
  }
  return {
    change_id,
    doctrine_id,
    doctrine_name: str(e.doctrine_name),
    version,
    previous_version,
    change_type,
    summary,
    contract_ids: strList(e.contract_ids, at, 'contract_ids'),
    default_patterns: strList(e.default_patterns, at, 'default_patterns'),
    claims,
    approved_by: str(e.approved_by),
    approved_at,
    changed_at,
    loop_id: str(e.loop_id),
    doc_url: str(e.doc_url),
    posted_by: str(e.posted_by),
    payload: { ...e, dry_run: undefined },
  };
}

export async function storeDoctrine(body: Obj): Promise<DoctrineStoreResult & { dry_run: boolean }> {
  const list = Array.isArray(body.changes) ? body.changes : [body];
  if (list.length === 0) throw new FeedError(422, 'changes is empty — nothing to store.');
  if (list.length > 100) throw new FeedError(413, `${list.length} changes in one call; send at most 100.`);
  const rows = list.map((e, i) => doctrineRow(e, Array.isArray(body.changes) ? `changes[${i}]` : 'The change'));
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.doctrine_id} ${r.version}`;
    if (seen.has(k)) throw new FeedError(422, `${r.doctrine_id} ${r.version} appears twice in one call.`);
    seen.add(k);
  }
  return tx(body.dry_run === true, async (db) => {
    let inserted = 0;
    let unchanged = 0;
    for (const r of rows) {
      const held = await db.query<{ change_id: string; same: boolean }>(
        `SELECT change_id,
                (doctrine_id, version, coalesce(previous_version,''), change_type, summary, contract_ids, default_patterns, claims, changed_at)
                  IS NOT DISTINCT FROM ($2, $3, coalesce($4,''), $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz) AS same
           FROM engine_media_doctrine WHERE change_id = $1 OR (doctrine_id = $2 AND version = $3)`,
        [r.change_id, r.doctrine_id, r.version, r.previous_version, r.change_type, r.summary, JSON.stringify(r.contract_ids), JSON.stringify(r.default_patterns), JSON.stringify(r.claims), r.changed_at],
      );
      const other = held.rows.find((h) => h.change_id !== r.change_id);
      if (other) throw new FeedError(409, `${r.doctrine_id} ${r.version} is already held as change ${other.change_id}. A version is not restated — post the correction as a new version that supersedes it.`);
      const mine = held.rows.find((h) => h.change_id === r.change_id);
      if (mine && !mine.same) throw new FeedError(409, `Change ${r.change_id} is already held with different content. Doctrine is never edited in place — post a new change_id with a new version and previous_version "${r.version}".`);
      if (mine) {
        unchanged++;
        continue;
      }
      await db.query(
        `INSERT INTO engine_media_doctrine (change_id, doctrine_id, doctrine_name, version, previous_version, change_type, summary, contract_ids, default_patterns, claims, approved_by, approved_at, changed_at, loop_id, doc_url, posted_by, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
        [r.change_id, r.doctrine_id, r.doctrine_name, r.version, r.previous_version, r.change_type, r.summary, JSON.stringify(r.contract_ids), JSON.stringify(r.default_patterns), JSON.stringify(r.claims), r.approved_by, r.approved_at, r.changed_at, r.loop_id, r.doc_url, r.posted_by, JSON.stringify(r.payload)],
      );
      inserted++;
    }
    if (inserted) events.changed('media_doctrine', null, db);
    return { received: rows.length, inserted, updated: 0, unchanged, change_ids: rows.map((r) => r.change_id) };
  });
}

interface DoctrineRow {
  change_id: string;
  doctrine_id: string;
  doctrine_name: string | null;
  version: string;
  previous_version: string | null;
  change_type: string;
  summary: string;
  contract_ids: string[];
  default_patterns: string[];
  claims: Array<{ claim_id: string | null; label: string; maturity: string; allowed_wording: string | null; prohibited_wording: string | null }>;
  approved_by: string | null;
  approved_at: string | null;
  changed_at: string;
  loop_id: string | null;
  doc_url: string | null;
  posted_by: string | null;
  received_at: string;
}

/**
 * The doctrine, read by software (2026-10-01, Destiny — T0NO's read door).
 *
 * Media Twin, /vfarm and Genie/North Star must all read the same claims, from
 * here, rather than each keep its own idea of what may be said (Jason: no
 * sidecar, no second truth store). This is that read. The key-protected
 * `GET /api/engine/media-doctrine` and the `read_media_doctrine` MCP tool both
 * call it, so the two can never answer differently, and both go through
 * doctrineData() — the same function the Media Twin page renders from.
 *
 * It returns what is held and nothing more: the version in force of each
 * doctrine, flattened to one row per claim. It does not compute T0NO's seven
 * fields. Those it does not hold are named in `not_held`, so a reader treats
 * them as unknown and fails closed instead of assuming a default.
 *
 * A filter that matches nothing says so, and names what is in force, rather
 * than coming back as an empty list that reads like "no rules".
 */
export const DOCTRINE_READ_SCHEMA = 'media.doctrine.read.v1';

/** T0NO's mandatory core (Jason, 2026-10-01) that the doctrine table does not carry yet. */
export const T0NO_FIELDS_NOT_HELD = ['claim_state', 'config_hash', 'cad_provenance', 'evidence_publication_status', 'fail_closed', 'allowed_use'] as const;

export interface DoctrineReadFilter {
  doctrine_id?: string | null;
  claim_id?: string | null;
  maturity?: string | null;
}

export async function doctrineClaims(f: DoctrineReadFilter = {}) {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const want = { doctrine_id: clean(f.doctrine_id), claim_id: clean(f.claim_id), maturity: clean(f.maturity) };
  const same = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

  const d = await doctrineData();
  const inForce = d.doctrines.filter((x) => !x.retired);
  const all = inForce.flatMap((doc) =>
    doc.claims.map((c) => ({
      doctrine_id: doc.doctrine_id,
      doctrine_version: doc.version,
      change_id: doc.change_id,
      claim_id: c.claim_id ?? null,
      label: c.label,
      maturity: c.maturity,
      allowed_wording: c.allowed_wording ?? null,
      prohibited_wording: c.prohibited_wording ?? null,
    })),
  );
  const claims = all.filter(
    (c) =>
      (!want.doctrine_id || same(c.doctrine_id, want.doctrine_id)) &&
      (!want.claim_id || same(c.claim_id, want.claim_id)) &&
      (!want.maturity || same(c.maturity, want.maturity)),
  );

  const warnings: string[] = [];
  const ids = inForce.map((x) => x.doctrine_id);
  if (!d.doctrines.length) warnings.push('No doctrine has been posted yet. Treat every claim as not safe to make.');
  if (want.doctrine_id && !ids.some((x) => same(x, want.doctrine_id)))
    warnings.push(`No doctrine "${want.doctrine_id}" is in force. In force: ${ids.join(', ') || 'none'}.`);
  if (want.claim_id && !all.some((c) => same(c.claim_id, want.claim_id)))
    warnings.push(`No claim "${want.claim_id}" is held in any doctrine in force, so it has no approved wording. Treat it as not safe to make.`);
  if (want.maturity && !all.some((c) => same(c.maturity, want.maturity)))
    warnings.push(`No claim in force has maturity "${want.maturity}". Held: ${[...new Set(all.map((c) => c.maturity))].sort().join(', ') || 'none'}.`);

  return {
    schema: DOCTRINE_READ_SCHEMA,
    read_at: new Date().toISOString(),
    source: 'engine_media_doctrine: the newest change of each doctrine in force, as Hardik posted it through media.doctrine.v1',
    filters: { doctrine_id: want.doctrine_id || null, claim_id: want.claim_id || null, maturity: want.maturity || null },
    doctrines: inForce.map((x) => ({
      doctrine_id: x.doctrine_id,
      doctrine_name: x.doctrine_name,
      version: x.version,
      change_id: x.change_id,
      changed_at: x.changed_at,
      approved_by: x.approved_by,
      approved_at: x.approved_at,
      loop_id: x.loop_id,
      doc_url: x.doc_url,
      contract_ids: x.contract_ids,
      claims: x.claims.length,
    })),
    retired: d.doctrines.filter((x) => x.retired).map((x) => x.doctrine_id),
    claims,
    counts: { doctrines_in_force: inForce.length, claims_in_force: all.length, claims_returned: claims.length, by_maturity: tally(claims.map((c) => c.maturity), '(none)') },
    not_held: {
      fields: [...T0NO_FIELDS_NOT_HELD],
      note: 'T0NO’s core fields this table does not carry yet. A reader must treat them as unknown and fail closed, never assume a default.',
    },
    warnings,
  };
}

export async function doctrineData() {
  const r = await query<DoctrineRow>(
    `SELECT change_id, doctrine_id, doctrine_name, version, previous_version, change_type, summary, contract_ids, default_patterns, claims,
            approved_by, loop_id, doc_url, posted_by,
            to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at,
            to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at,
            to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at
       FROM engine_media_doctrine
      ORDER BY changed_at DESC, received_at DESC`,
  );
  const changes = r.rows;
  // The version in force per doctrine is its newest change; a retired one is kept and said to be retired.
  const current = new Map<string, DoctrineRow>();
  for (const c of changes) if (!current.has(c.doctrine_id)) current.set(c.doctrine_id, c);
  const doctrines = [...current.values()].map((c) => ({
    ...c,
    changes: changes.filter((x) => x.doctrine_id === c.doctrine_id).length,
    retired: c.change_type === 'retired',
  }));
  const inForce = doctrines.filter((d) => !d.retired);
  const claims = inForce.flatMap((d) => d.claims.map((c) => c.maturity));
  const now = Date.now();
  return {
    doctrines,
    changes,
    meta: {
      changes: changes.length,
      first_change_at: changes.length ? changes[changes.length - 1].changed_at : null,
      last_change_at: changes[0]?.changed_at ?? null,
      last_received_at: changes.reduce<string | null>((m, c) => (!m || c.received_at > m ? c.received_at : m), null),
    },
    summary: {
      doctrines_in_force: inForce.length,
      retired: doctrines.length - inForce.length,
      changes_last_30_days: changes.filter((c) => now - Date.parse(c.changed_at) < 30 * 86_400_000).length,
      claims_in_force: claims.length,
      claims_by_maturity: tally(claims, '(none)'),
      contracts_bound: [...new Set(inForce.flatMap((d) => d.contract_ids))].sort(),
      default_patterns: [...new Set(inForce.flatMap((d) => d.default_patterns))].sort(),
    },
  };
}
