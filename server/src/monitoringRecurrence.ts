/**
 * A monitoring incident that keeps coming back becomes one Research Twin job
 * (2026-10-04, Destiny — the "when a result goes to Research Twin" line of the
 * 3 Oct Twin alignment note, built before the first real snapshot on 6 Oct).
 *
 * The rule is Canon v1 as Jason approved it on 4 Oct (#workflow-logs-destiny,
 * 1791083235.618579):
 *
 *   - group by **subsystem + place + incident class**;
 *   - **ignore misses the healer or the recovery watcher already closed**;
 *   - when a pattern reaches **3 or more in 7 days**, open **one** Pending
 *     research job for the pattern, never one per miss, with the incident ids,
 *     subsystem, lane, place and product in its context.
 *
 * How each word is read here, so the rule can be checked against the code:
 *
 *   - **subsystem** is the device's own `subsystem` where vFarm's snapshot
 *     carries one, and `MONITORING` (the ledger subsystem) where it does not.
 *     No snapshot carries one yet, so every pattern today is `MONITORING`.
 *   - **place** is the farm. vFarm sends no cabinet id, so a cabinet cannot be
 *     told apart from its farm; the devices a pattern touched are kept on the
 *     row and in the job. Three different sensors each going offline once on
 *     one farm is therefore one pattern, which a per-device rule never saw.
 *   - **incident class** is the kind of fault, and for a reading out of range
 *     the metric too: humidity out of range and pH out of range are two
 *     questions, and one job asking both would answer neither.
 *   - **closed by the healer or the recovery watcher** is a `retry_attempts`
 *     row at `Recovered`, or an `engine_recovery` row at `recovered` or
 *     `already_done`, for the incident's ledger id. An incident that cleared
 *     on its own when the fault went away is **not** that: nothing fixed it,
 *     which is exactly the case a repeat is worth researching.
 *
 * A pattern is detected once per 7 days; while its row is younger than that,
 * further incidents only raise its count.
 *
 * **A simulated farm never opens a job.** Its pattern is detected and recorded
 * exactly the same way, so the rule can be proved on the simulator, but
 * Research Twin is not sent to research a fault somebody staged. The row says
 * `not_opened_simulated`.
 *
 * No silent failures: a job that cannot be written keeps the row at `failed`
 * with the reason, is tried again on every pass, and is shown on the read.
 *
 * Not built here, and said so on the read: the second half of the rule, a
 * research job when a reading is out of a range whose source is not yet
 * confirmed (pH, EC, CO2 in tomato profile v1). The profile carries no
 * `confirmed` flag to decide that from, and guessing it from the source text
 * would be a rule nobody can check.
 */
import { query, withTransaction } from './pg';
import * as engineWrite from './engineWrite';
import * as engineEvents from './engineEvents';

export const RULE = { min_incidents: 3, window_days: 7 } as const;
export const DEFAULT_SUBSYSTEM = 'MONITORING';
const LOCK = 8134207613;

interface Pattern {
  subsystem: string;
  farm_id: string;
  farm_name: string | null;
  kind: string;
  metric: string | null;
  device_ids: string[];
  synthetic: boolean;
  n: number;
  incidents: { incident_id: string; device_id: string | null; opened_at: string; closed_at: string | null; detail: string; ledger_id: string | null }[];
  first_at: string;
  last_at: string;
}

export interface RecurrenceRow {
  id: string;
  pattern_key: string;
  subsystem: string;
  farm_id: string;
  device_id: string | null;
  device_ids: string[];
  kind: string;
  metric: string | null;
  synthetic: boolean;
  incidents: number;
  incident_ids: string[];
  first_at: string;
  last_at: string;
  detected_at: string;
  job_state: 'pending' | 'opened' | 'not_opened_simulated' | 'failed';
  job_id: string | null;
  job_error: string | null;
  job_attempts: number;
}

/** subsystem | place | incident class. */
export const patternKey = (p: { subsystem: string; farm_id: string; kind: string; metric: string | null }): string => `${p.subsystem}|${p.farm_id}|${p.kind}${p.metric ? `:${p.metric}` : ''}`;

const KIND_WORDS: Record<string, string> = {
  offline: 'a sensor going offline (no reading for 15 minutes)',
  out_of_range: 'a reading outside its target range',
  feed_silent: 'the farm feed going silent (no snapshot for 10 minutes)',
};

/** The job's question and context, in words Research Twin can act on. Pure, so it can be tested. */
export function jobText(p: Pattern): { question: string; context: string } {
  const farm = p.farm_name ? `${p.farm_name} (${p.farm_id})` : p.farm_id;
  const devices = p.device_ids.length === 0 ? 'the whole farm feed' : p.device_ids.length === 1 ? `device ${p.device_ids[0]}` : `${p.device_ids.length} devices (${p.device_ids.join(', ')})`;
  const what = `${KIND_WORDS[p.kind] ?? p.kind}${p.metric ? `, metric ${p.metric}` : ''}`;
  const question = `A monitoring fault keeps coming back: ${what}, ${p.n} times in the last ${RULE.window_days} days on ${farm}, across ${devices}. What is the most likely cause of a fault that repeats like this, and what should change: the hardware, the sensor placement, the threshold, or the crop profile?`;
  const lines = p.incidents.map((i) => `- ${i.incident_id}${i.ledger_id ? ` (ledger ${i.ledger_id})` : ''}${i.device_id ? `, device ${i.device_id}` : ''}: opened ${i.opened_at}, ${i.closed_at ? `closed ${i.closed_at}` : 'still open'}. ${i.detail}`);
  const context = [
    `Opened by the Monitoring Twin's recurrence rule (Canon v1, 4 Oct 2026): the same subsystem, place and incident class ${RULE.min_incidents} or more times in ${RULE.window_days} days is a pattern, and gets one job for the pattern, never one per incident. Incidents the healer or the recovery watcher already closed are not counted.`,
    `Subsystem: ${p.subsystem}. Lane: VFARM_HARDWARE. Product: vFarm. Place: ${farm}. Devices: ${devices}.`,
    `Fault: ${what}.`,
    'The incidents:',
    ...lines,
    'Each one opened and cleared on its own. The question is why it keeps happening, not any single incident.',
  ].join('\n');
  return { question, context: context.slice(0, 6000) };
}

async function patterns(): Promise<Pattern[]> {
  const r = await query<Pattern>(
    `SELECT coalesce(nullif(d.fields->>'subsystem', ''), $3) AS subsystem, i.farm_id, max(f.name) AS farm_name, i.kind, i.metric,
            coalesce(json_agg(DISTINCT i.device_id) FILTER (WHERE i.device_id IS NOT NULL), '[]'::json) AS device_ids,
            bool_or(i.synthetic) AS synthetic, count(*)::int AS n,
            json_agg(json_build_object(
              'incident_id', i.incident_id, 'device_id', i.device_id,
              'opened_at', to_char(i.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'closed_at', to_char(i.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'detail', i.detail, 'ledger_id', i.ledger_id) ORDER BY i.opened_at) AS incidents,
            to_char(min(i.opened_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
            to_char(max(i.opened_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at
       FROM engine_monitoring_incidents i
       LEFT JOIN engine_vfarm_farms f ON f.farm_id = i.farm_id
       LEFT JOIN engine_vfarm_devices d ON d.device_id = i.device_id
      WHERE i.opened_at > now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM engine_retry_attempts ra WHERE i.ledger_id IS NOT NULL AND ra.natural_id = i.ledger_id AND ra.fields->>'status' = 'Recovered')
        AND NOT EXISTS (SELECT 1 FROM engine_recovery rc WHERE i.ledger_id IS NOT NULL AND rc.incident_id = i.ledger_id AND rc.status IN ('recovered', 'already_done'))
      GROUP BY 1, i.farm_id, i.kind, i.metric
     HAVING count(*) >= $2`,
    [String(RULE.window_days), RULE.min_incidents, DEFAULT_SUBSYSTEM],
  );
  return r.rows;
}

let sweeping = false;

/**
 * One pass. Detects every pattern that holds now, records each once per
 * window, and opens the Research Twin job for the real ones. Never throws.
 */
export async function sweep(): Promise<{ patterns: number; detected: number; jobs_opened: number; failed: number }> {
  const out = { patterns: 0, detected: 0, jobs_opened: 0, failed: 0 };
  if (sweeping) return out;
  sweeping = true;
  try {
    const found = await patterns();
    out.patterns = found.length;
    const byKey = new Map(found.map((p) => [patternKey(p), p]));

    // Detection: once per pattern per window, under a lock so two instances
    // overlapping on a deploy cannot both record it.
    const fresh: string[] = [];
    if (found.length) {
      await withTransaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
        for (const p of found) {
          const key = patternKey(p);
          const ids = JSON.stringify(p.incidents.map((i) => i.incident_id));
          const devs = JSON.stringify(p.device_ids);
          const one = p.device_ids.length === 1 ? p.device_ids[0] : null;
          const held = await db.query<{ id: string }>(`SELECT id::text FROM engine_monitoring_recurrences WHERE pattern_key = $1 AND detected_at > now() - ($2 || ' days')::interval ORDER BY id DESC LIMIT 1`, [key, String(RULE.window_days)]);
          if (held.rows[0]) {
            await db.query(`UPDATE engine_monitoring_recurrences SET incidents = $2, incident_ids = $3::jsonb, last_at = $4, device_ids = $5::jsonb, device_id = $6 WHERE id = $1`, [held.rows[0].id, p.n, ids, p.last_at, devs, one]);
            continue;
          }
          const ins = await db.query<{ id: string }>(
            `INSERT INTO engine_monitoring_recurrences (pattern_key, subsystem, farm_id, device_id, device_ids, kind, metric, synthetic, incidents, incident_ids, first_at, last_at, job_state)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13) RETURNING id::text`,
            [key, p.subsystem, p.farm_id, one, devs, p.kind, p.metric, p.synthetic, p.n, ids, p.first_at, p.last_at, p.synthetic ? 'not_opened_simulated' : 'pending'],
          );
          fresh.push(ins.rows[0].id);
          out.detected++;
        }
      });
    }
    for (const id of fresh) {
      const row = (await query<RecurrenceRow>(`SELECT id::text, pattern_key, subsystem, farm_id, device_ids, kind, metric, synthetic, incidents, incident_ids, job_state FROM engine_monitoring_recurrences WHERE id = $1`, [id])).rows[0];
      if (!row) continue;
      try {
        await engineEvents.record({
          event_type: 'monitoring_recurrence_detected',
          subject_id: row.pattern_key,
          lane: 'bays',
          actor: 'Monitoring Twin',
          detail: { subsystem: row.subsystem, farm_id: row.farm_id, device_ids: row.device_ids, kind: row.kind, metric: row.metric, incidents: row.incidents, incident_ids: row.incident_ids, synthetic: row.synthetic, window_days: RULE.window_days, job: row.synthetic ? 'not opened: simulated farm' : 'to be opened' },
          dedupe_key: `monitoring_recurrence:${row.id}`,
        });
      } catch (e) {
        console.error(`[monitoring-twin] recurrence ${row.id}: the event was not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // The job: for every real pattern still waiting on one, this pass or an earlier one.
    const due = await query<RecurrenceRow>(`SELECT id::text, pattern_key, job_attempts FROM engine_monitoring_recurrences WHERE job_state IN ('pending', 'failed') AND synthetic = false AND detected_at > now() - ($1 || ' days')::interval ORDER BY id`, [String(RULE.window_days)]);
    for (const row of due.rows) {
      const p = byKey.get(row.pattern_key);
      if (!p) continue; // the pattern no longer holds; the row stays as it is and says so by its state
      try {
        const { question, context } = jobText(p);
        const now = new Date().toISOString();
        const jobId = `JOB-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const res = await engineWrite.postRecord(
          'rt-jobs',
          { created_time: now, fields: { 'Job ID': jobId, Question: question, Context: context, 'Card ID': '', Lane: '', Status: 'Pending', Attempts: 0, 'Opened By': 'Monitoring Twin', 'Opened At': now } },
          { endpoint: 'monitoring-twin:recurrence', method: 'INTERNAL', key_label: 'server', t0: Date.now(), note: `recurrence ${row.id}: ${row.pattern_key}` },
        );
        await query(`UPDATE engine_monitoring_recurrences SET job_state = 'opened', job_id = $2, job_error = NULL, job_attempts = job_attempts + 1 WHERE id = $1`, [row.id, res.natural_id ?? jobId]);
        out.jobs_opened++;
      } catch (e) {
        out.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[monitoring-twin] recurrence ${row.id}: the Research Twin job was not opened: ${msg}`);
        await query(`UPDATE engine_monitoring_recurrences SET job_state = 'failed', job_error = $2, job_attempts = job_attempts + 1 WHERE id = $1`, [row.id, msg.slice(0, 500)]);
      }
    }
    return out;
  } catch (e) {
    console.error(`[monitoring-twin] recurrence sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...out, failed: out.failed + 1 };
  } finally {
    sweeping = false;
  }
}

/** What the read shows: the rule, and every pattern detected in the last 30 days. */
export async function recent(): Promise<{ rule: string; not_built: string; patterns: RecurrenceRow[] }> {
  const r = await query<RecurrenceRow>(
    `SELECT id::text, pattern_key, subsystem, farm_id, device_id, device_ids, kind, metric, synthetic, incidents, incident_ids,
            to_char(first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
            to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
            to_char(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at,
            job_state, job_id, job_error, job_attempts
       FROM engine_monitoring_recurrences WHERE detected_at > now() - interval '30 days' ORDER BY id DESC LIMIT 50`,
  );
  return {
    rule: `The same subsystem, place (farm) and incident class ${RULE.min_incidents} or more times in ${RULE.window_days} days opens one Research Twin job for the pattern, never one per incident (Canon v1, 4 Oct 2026). Incidents the healer or the recovery watcher already closed are not counted. No snapshot carries a subsystem per device yet, so every pattern is ${DEFAULT_SUBSYSTEM}. A simulated farm's pattern is recorded and opens no job.`,
    not_built: 'A reading out of a range whose source is not yet confirmed (pH, EC, CO2 in tomato profile v1) does not open a job automatically: the profile has no confirmed flag to decide that from.',
    patterns: r.rows,
  };
}
