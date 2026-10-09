/**
 * engine_events — the engine's own structured events (2026-10-03, Destiny —
 * LOOP-1791015066302-MG0X, spec SOP-ENGINE-GUARDS-EVENTS-001).
 *
 * One append-only table in the shape engine.event.v1:
 *   { event_type, at, subject_id, lane, actor, source_ref, detail }
 *
 * It exists for the two things the 2 Oct hardening pass found were not
 * queryable: whether a digest was dispatched (`digest_dispatch_succeeded` /
 * `digest_dispatch_failed`, posted by n8n's Bays — Slack Send from Slack's own
 * answer) and when a lane's blocker cleared (`lane_blocker_cleared`, written
 * here). Everything else the SOP lists already has a home and is not copied.
 *
 * **Append-only.** Nothing updates or deletes a row. A `dedupe_key` makes a
 * repeat a no-op rather than a second event: n8n retries a failed HTTP node,
 * and the blocker sweep sees the same closed loop every time it runs.
 */
import { query, type Queryable } from './pg';
import * as timers from './timers';

export const EVENT_SHAPE = 'engine.event.v1';
/**
 * Lower case for the events this dashboard named itself; upper case is allowed
 * from 9 Oct 2026 because Jason named the vFarm gate events that way
 * (`VFARM_STAGE1_STATE_CHANGED`, …) and a consumer should find the name he wrote.
 */
const TYPE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

export interface EngineEvent {
  event_type: string;
  at?: string | null;
  subject_id: string;
  lane?: string | null;
  actor?: string | null;
  source_ref?: string | null;
  detail?: Record<string, unknown> | null;
  dedupe_key?: string | null;
}

export class EventError extends Error {}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Stores one event. `recorded: false` means its dedupe_key was already held.
 * Pass `db` to write it inside a transaction, so the event and the change it
 * describes land together or not at all.
 */
export async function record(e: EngineEvent, db?: Queryable): Promise<{ recorded: boolean; id: number | null }> {
  const type = str(e.event_type, 64);
  if (!type || !TYPE.test(type)) throw new EventError('event_type is required: letters, digits and underscores, 3 to 64 characters, starting with a letter.');
  const subject = str(e.subject_id, 300);
  if (!subject) throw new EventError('subject_id is required: the id of the thing the event is about.');
  let at: string | null = null;
  if (e.at != null && e.at !== '') {
    const d = new Date(String(e.at));
    if (Number.isNaN(d.getTime())) throw new EventError('at must be an ISO 8601 time, or left out for now.');
    at = d.toISOString();
  }
  if (e.detail != null && (typeof e.detail !== 'object' || Array.isArray(e.detail))) throw new EventError('detail must be an object.');
  const run = db ? (text: string, values: unknown[]) => db.query<{ id: string }>(text, values) : (text: string, values: unknown[]) => query<{ id: string }>(text, values);
  const r = await run(
    `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key)
     VALUES ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [type, at, subject, str(e.lane, 80), str(e.actor, 200), str(e.source_ref, 1000), JSON.stringify(e.detail ?? {}), str(e.dedupe_key, 300)],
  );
  return r.rows.length ? { recorded: true, id: Number(r.rows[0].id) } : { recorded: false, id: null };
}

/**
 * Writes `lane_blocker_cleared` once for every loop a lane names in
 * blocked_by that is now Closed. Dated by the loop's own last write, which is
 * its close; `detail.observed_at` is when this sweep first saw it. Lane health
 * stays a read: this runs on its own timer, and after a lane_health call only
 * so the event is there by the time somebody asks.
 */
export async function sweepClearedBlockers(): Promise<number> {
  const rows = (
    await query<{ lane_id: string; loop_id: string; owner: string | null; what: string; closed_at: string }>(
      `WITH named AS (
         SELECT lane_id, unnest(blocked_by) AS loop_id FROM engine_lane_profiles WHERE cardinality(blocked_by) > 0
       ), latest AS (
         SELECT DISTINCT ON (fields->>'loop_id') fields->>'loop_id' AS loop_id, coalesce(fields->>'Status', '') AS status,
                builder_id AS owner, left(coalesce(fields->>'What', ''), 160) AS what, updated_at
           FROM engine_loops WHERE fields->>'loop_id' IN (SELECT loop_id FROM named)
          ORDER BY fields->>'loop_id', updated_at DESC
       )
       SELECT n.lane_id, n.loop_id, l.owner, l.what, l.updated_at AS closed_at
         FROM named n JOIN latest l USING (loop_id)
        WHERE lower(l.status) = 'closed'
          AND NOT EXISTS (SELECT 1 FROM engine_events e WHERE e.dedupe_key = 'lane_blocker_cleared:' || n.lane_id || ':' || n.loop_id)`,
    )
  ).rows;
  let n = 0;
  for (const b of rows) {
    const r = await record({
      event_type: 'lane_blocker_cleared',
      at: new Date(b.closed_at).toISOString(),
      subject_id: `${b.lane_id}:${b.loop_id}`,
      lane: b.lane_id,
      actor: 'the dashboard (blocker sweep)',
      source_ref: `https://dashboard.bhanetwork.org/open-loops/${b.loop_id}`,
      detail: { loop_id: b.loop_id, owner: b.owner, what: b.what, observed_at: new Date().toISOString() },
      dedupe_key: `lane_blocker_cleared:${b.lane_id}:${b.loop_id}`,
    });
    if (r.recorded) n++;
  }
  return n;
}

const SWEEP_MS = 5 * 60_000;

export function startSweeping(): void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    sweepClearedBlockers()
      .then((n) => {
        if (n) console.log(`[engine-events] ${n} lane_blocker_cleared written`);
      })
      .catch((e) => console.error(`[engine-events] blocker sweep failed: ${(e as Error).message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 90_000).unref();
  setInterval(() => (timers.beat('lane blocker sweep'), tick()), SWEEP_MS).unref();
}
