/**
 * A monitoring incident that keeps coming back becomes one Research Twin job
 * (2026-10-04, Destiny — the "when a result goes to Research Twin" line of the
 * 3 Oct Twin alignment note, built before the first real snapshot on 6 Oct).
 *
 * The rule, as Destiny wrote it: an incident that opens and clears on its own
 * is routine and is only logged. When **the same class recurs 3 or more times
 * in 7 days on the same device or farm**, that is a pattern, and it gets **one
 * job for the pattern, never one per incident**. Until today that job was
 * opened by hand.
 *
 * "The same" is the Monitoring Twin's own fault key: farm, device, kind and
 * metric. A pattern is detected once per 7 days; while its row is younger than
 * that, further incidents only raise its count.
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
const LOCK = 8134207613;

interface Pattern {
  farm_id: string;
  farm_name: string | null;
  device_id: string | null;
  kind: string;
  metric: string | null;
  synthetic: boolean;
  n: number;
  incidents: { incident_id: string; opened_at: string; closed_at: string | null; detail: string; ledger_id: string | null }[];
  first_at: string;
  last_at: string;
}

export interface RecurrenceRow {
  id: string;
  pattern_key: string;
  farm_id: string;
  device_id: string | null;
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

export const patternKey = (p: { farm_id: string; device_id: string | null; kind: string; metric: string | null }): string => `${p.farm_id}|${p.device_id ?? ''}|${p.kind}|${p.metric ?? ''}`;

const KIND_WORDS: Record<string, string> = {
  offline: 'a sensor going offline (no reading for 15 minutes)',
  out_of_range: 'a reading outside its target range',
  feed_silent: 'the farm feed going silent (no snapshot for 10 minutes)',
};

/** The job's question and context, in words Research Twin can act on. Pure, so it can be tested. */
export function jobText(p: Pattern): { question: string; context: string } {
  const where = `${p.device_id ? `device ${p.device_id}` : 'the whole farm feed'} on ${p.farm_name ? `${p.farm_name} (${p.farm_id})` : p.farm_id}`;
  const what = `${KIND_WORDS[p.kind] ?? p.kind}${p.metric ? `, metric ${p.metric}` : ''}`;
  const question = `A monitoring fault keeps coming back: ${what}, ${p.n} times in the last ${RULE.window_days} days on ${where}. What is the most likely cause of a fault that repeats like this, and what should change: the hardware, the sensor placement, the threshold, or the crop profile?`;
  const lines = p.incidents.map((i) => `- ${i.incident_id}${i.ledger_id ? ` (ledger ${i.ledger_id})` : ''}: opened ${i.opened_at}, ${i.closed_at ? `closed ${i.closed_at}` : 'still open'}. ${i.detail}`);
  const context = [
    `Opened by the Monitoring Twin's recurrence rule: the same incident class ${RULE.min_incidents} or more times in ${RULE.window_days} days on the same device or farm is a pattern, and gets one job for the pattern, never one per incident.`,
    `Fault: ${what}. Where: ${where}.`,
    'The incidents:',
    ...lines,
    'Each one opened and cleared on its own. The question is why it keeps happening, not any single incident.',
  ].join('\n');
  return { question, context: context.slice(0, 6000) };
}

async function patterns(): Promise<Pattern[]> {
  const r = await query<Pattern>(
    `SELECT i.farm_id, max(f.name) AS farm_name, i.device_id, i.kind, i.metric, bool_or(i.synthetic) AS synthetic, count(*)::int AS n,
            json_agg(json_build_object(
              'incident_id', i.incident_id,
              'opened_at', to_char(i.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'closed_at', to_char(i.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'detail', i.detail, 'ledger_id', i.ledger_id) ORDER BY i.opened_at) AS incidents,
            to_char(min(i.opened_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
            to_char(max(i.opened_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at
       FROM engine_monitoring_incidents i LEFT JOIN engine_vfarm_farms f ON f.farm_id = i.farm_id
      WHERE i.opened_at > now() - ($1 || ' days')::interval
      GROUP BY i.farm_id, i.device_id, i.kind, i.metric
     HAVING count(*) >= $2`,
    [String(RULE.window_days), RULE.min_incidents],
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
          const held = await db.query<{ id: string }>(`SELECT id::text FROM engine_monitoring_recurrences WHERE pattern_key = $1 AND detected_at > now() - ($2 || ' days')::interval ORDER BY id DESC LIMIT 1`, [key, String(RULE.window_days)]);
          if (held.rows[0]) {
            await db.query(`UPDATE engine_monitoring_recurrences SET incidents = $2, incident_ids = $3::jsonb, last_at = $4 WHERE id = $1`, [held.rows[0].id, p.n, ids, p.last_at]);
            continue;
          }
          const ins = await db.query<{ id: string }>(
            `INSERT INTO engine_monitoring_recurrences (pattern_key, farm_id, device_id, kind, metric, synthetic, incidents, incident_ids, first_at, last_at, job_state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) RETURNING id::text`,
            [key, p.farm_id, p.device_id, p.kind, p.metric, p.synthetic, p.n, ids, p.first_at, p.last_at, p.synthetic ? 'not_opened_simulated' : 'pending'],
          );
          fresh.push(ins.rows[0].id);
          out.detected++;
        }
      });
    }
    for (const id of fresh) {
      const row = (await query<RecurrenceRow>(`SELECT id::text, pattern_key, farm_id, device_id, kind, metric, synthetic, incidents, incident_ids, job_state FROM engine_monitoring_recurrences WHERE id = $1`, [id])).rows[0];
      if (!row) continue;
      try {
        await engineEvents.record({
          event_type: 'monitoring_recurrence_detected',
          subject_id: row.pattern_key,
          lane: 'bays',
          actor: 'Monitoring Twin',
          detail: { farm_id: row.farm_id, device_id: row.device_id, kind: row.kind, metric: row.metric, incidents: row.incidents, incident_ids: row.incident_ids, synthetic: row.synthetic, window_days: RULE.window_days, job: row.synthetic ? 'not opened: simulated farm' : 'to be opened' },
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
    `SELECT id::text, pattern_key, farm_id, device_id, kind, metric, synthetic, incidents, incident_ids,
            to_char(first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
            to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
            to_char(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at,
            job_state, job_id, job_error, job_attempts
       FROM engine_monitoring_recurrences WHERE detected_at > now() - interval '30 days' ORDER BY id DESC LIMIT 50`,
  );
  return {
    rule: `The same incident class ${RULE.min_incidents} or more times in ${RULE.window_days} days on the same device or farm opens one Research Twin job for the pattern, never one per incident. A simulated farm's pattern is recorded and opens no job.`,
    not_built: 'A reading out of a range whose source is not yet confirmed (pH, EC, CO2 in tomato profile v1) does not open a job automatically: the profile has no confirmed flag to decide that from.',
    patterns: r.rows,
  };
}
