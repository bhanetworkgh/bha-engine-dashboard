/**
 * Logstream v0: the read and analysis spine for engine faults
 * (2026-10-10, Destiny. Jason's go-ahead of 9 Oct, #bha-north-star-twin:
 * "implement Logstream v0 (table, writer, trigger) against the locked
 * thresholds, with no autopay, no pay wiring, and no destructive automated
 * actions attached"). The contract is `docs/design/logstream-v0.md` section 10.
 *
 * Three parts, and nothing else:
 *
 *   **The table.** `engine_logstream`, append-only, one row per state an
 *   incident reaches: `observed` when this dashboard first holds it, `closed`
 *   when it stops being open, `research_opened` when a pattern it belongs to
 *   gets a Research Twin job. Research Twin's field list, plus
 *   `person_confirmed` and `autopay_enabled`, both false. Nothing here sets
 *   either to true and nothing reads them: pay is not wired.
 *
 *   **The writer.** `writeRows()` reads `engine_incidents`, which the ledger
 *   poll already fills, so no workflow is changed and no reporting node added.
 *
 *   **The trigger.** `sweep()` applies Jason's locked numbers to the last
 *   seven days and records each crossing once in `engine_logstream_triggers`:
 *
 *     - the same fault (workflow + the step that failed) 3 times in 7 days
 *       opens **one** Research Twin job for the pattern, never one per incident;
 *     - 5 times in 7 days tells a person, in the engine alerts channel;
 *     - 20% or more of a workflow's production runs failing in 7 days, with at
 *       least 10 runs and 3 failures, opens one job for that workflow;
 *     - 5 or more workflows crossing in the same 7 days is one shared-cause
 *       outage: one alert, and no per-workflow research while it holds.
 *
 *   Test, simulator and "refused ask" incidents are counted in nothing.
 *
 * What it can do is open a research job and post a Slack message. It never
 * closes, retries, edits or deletes anything, and never touches pay.
 *
 * Honest limits, all carried on the rows themselves:
 *   - `pattern_ids_applied` is empty: nothing in the engine tags an incident
 *     with a build pattern yet, and this does not guess one.
 *   - `time_to_recovery` is only marked trusted for a close on or after
 *     2 Oct 2026, when closes started being dated and signed.
 *   - No runtime decision depends on GNER; empty reads are not recorded.
 *
 * No silent failures: a job or an alert that does not land keeps its trigger
 * at `failed` with the reason and is tried again on every pass.
 */
import { query, withTransaction } from './pg';
import * as engineWrite from './engineWrite';
import * as engineEvents from './engineEvents';
import * as slack from './slack';
import * as quota from './quota';
import * as timers from './timers';

export const RULE = {
  window_days: 7,
  research_at: 3,
  escalate_at: 5,
  rate: 0.2,
  rate_min_runs: 10,
  rate_min_failures: 3,
  outage_workflows: 5,
  recovery_trusted_from: '2026-10-02T00:00:00.000Z',
} as const;
const LOCK = 8134207619;
const SWEEP_MS = 5 * 60_000;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

export type Excluded = 'test' | 'simulator' | 'refused_ask' | null;

/** A fault signature: the workflow plus the step that failed. */
export const signatureOf = (workflow: string | null, node: string | null): string => `${(workflow ?? '').trim() || '(no workflow)'} :: ${(node ?? '').trim() || '(no step)'}`;

/** Why an incident is counted in nothing, or null when it counts. */
export function excludedReason(i: { workflow: string | null; node: string | null; tags?: string[] | null }): Excluded {
  const wf = i.workflow ?? '';
  const tags = (i.tags ?? []).map((t) => String(t).toLowerCase());
  if (tags.includes('simulated') || /simulat/i.test(wf)) return 'simulator';
  if (/^\s*test\b/i.test(wf) || tags.includes('test')) return 'test';
  if (/refused ask/i.test(i.node ?? '')) return 'refused_ask';
  return null;
}

export interface Incident {
  incident_id: string;
  lane_id: string | null;
  workflow: string | null;
  node: string | null;
  tags?: string[] | null;
  occurred_at: string;
}
export interface WorkflowRuns {
  workflow_id: string;
  workflow: string;
  runs: number;
  failures: number;
}
export interface Crossing {
  kind: 'signature_research' | 'signature_escalation' | 'workflow_rate' | 'shared_outage';
  key: string;
  workflow: string | null;
  node: string | null;
  lane_id: string | null;
  n: number;
  runs: number | null;
  failures: number | null;
  incident_ids: string[];
  workflows: string[];
  first_at: string | null;
  last_at: string | null;
}

/**
 * The locked rules, as a pure function of what happened in the window, so the
 * numbers can be replayed against history and checked. `incidents` are every
 * incident in the window; excluded ones are dropped here, not by the caller.
 */
export function evaluate(incidents: Incident[], runs: WorkflowRuns[]): Crossing[] {
  const out: Crossing[] = [];
  const bySig = new Map<string, Incident[]>();
  for (const i of incidents) {
    if (excludedReason(i)) continue;
    const k = signatureOf(i.workflow, i.node);
    bySig.set(k, [...(bySig.get(k) ?? []), i]);
  }
  for (const [key, list] of bySig) {
    if (list.length < RULE.research_at) continue;
    const sorted = [...list].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const base = { key, workflow: sorted[0].workflow, node: sorted[0].node, lane_id: sorted[0].lane_id, n: sorted.length, runs: null, failures: null, incident_ids: sorted.map((i) => i.incident_id), workflows: [], first_at: sorted[0].occurred_at, last_at: sorted[sorted.length - 1].occurred_at };
    out.push({ kind: 'signature_research', ...base });
    if (sorted.length >= RULE.escalate_at) out.push({ kind: 'signature_escalation', ...base });
  }
  for (const w of runs) {
    if (excludedReason({ workflow: w.workflow, node: null })) continue;
    if (w.runs < RULE.rate_min_runs || w.failures < RULE.rate_min_failures || w.failures / w.runs < RULE.rate) continue;
    out.push({ kind: 'workflow_rate', key: w.workflow_id, workflow: w.workflow, node: null, lane_id: null, n: w.failures, runs: w.runs, failures: w.failures, incident_ids: [], workflows: [], first_at: null, last_at: null });
  }
  const crossed = [...new Set(out.map((c) => c.workflow ?? c.key))].sort();
  if (crossed.length >= RULE.outage_workflows) {
    out.push({ kind: 'shared_outage', key: 'shared-cause outage', workflow: null, node: null, lane_id: null, n: crossed.length, runs: null, failures: null, incident_ids: [...new Set(out.flatMap((c) => c.incident_ids))], workflows: crossed, first_at: null, last_at: null });
  }
  return out;
}

const WORK_LANE: Record<string, string> = { bays: 'BAYS', north_star: 'NS', research_twin: 'RT', genie: 'GENIE' };
const mint = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X')}`;

async function linkedLanes(): Promise<Map<string, string[]>> {
  const r = await query<{ lane_id: string; linked_lanes: string[] }>(`SELECT lane_id, linked_lanes FROM engine_lane_profiles WHERE kind = 'work'`);
  return new Map(r.rows.map((x) => [x.lane_id, x.linked_lanes ?? []]));
}

/* ------------------------------------------------------------ the writer */

interface Source {
  incident_id: string;
  lane_id: string | null;
  workflow: string | null;
  node: string | null;
  error_class: string | null;
  tags: string[] | null;
  occurred_at: string;
  open_now: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  f7: number;
  f30: number;
  retry_count: number | null;
  retry_status: string | null;
  has_observed: boolean;
  has_closed: boolean;
}

/**
 * One `observed` row per incident held, and one `closed` row once it is no
 * longer open. Append-only: a row is never edited, and the unique index on
 * (incident, state) is what makes a repeat pass write nothing.
 */
export async function writeRows(): Promise<{ observed: number; closed: number }> {
  const out = { observed: 0, closed: 0 };
  const src = await query<Source>(
    `WITH inc AS (
       SELECT natural_id AS incident_id, lane_id, fields->'payload'->>'workflow_or_scenario' AS workflow, fields->'payload'->>'failed_node_or_component' AS node,
              fields->'payload'->>'error_class' AS error_class,
              CASE WHEN jsonb_typeof(fields->'payload'->'impact_tags') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(fields->'payload'->'impact_tags')) END AS tags,
              coalesce(nullif(fields->>'occurred_at', ''), first_seen_at)::timestamptz AS at, open_now, resolved_at, resolved_by
         FROM engine_incidents WHERE natural_id IS NOT NULL)
     SELECT i.incident_id, i.lane_id, i.workflow, i.node, i.error_class, i.tags, to_char(i.at AT TIME ZONE 'UTC', ${ISO}) AS occurred_at, i.open_now, i.resolved_at, i.resolved_by,
            (SELECT count(*)::int FROM inc o WHERE o.workflow IS NOT DISTINCT FROM i.workflow AND o.node IS NOT DISTINCT FROM i.node AND o.at <= i.at AND o.at > i.at - interval '7 days') AS f7,
            (SELECT count(*)::int FROM inc o WHERE o.workflow IS NOT DISTINCT FROM i.workflow AND o.node IS NOT DISTINCT FROM i.node AND o.at <= i.at AND o.at > i.at - interval '30 days') AS f30,
            (SELECT max(nullif(ra.fields->>'attempts', '')::numeric)::int FROM engine_retry_attempts ra WHERE ra.natural_id = i.incident_id) AS retry_count,
            (SELECT max(ra.fields->>'status') FROM engine_retry_attempts ra WHERE ra.natural_id = i.incident_id AND ra.fields->>'status' IN ('Exhausted')) AS retry_status,
            EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'observed') AS has_observed,
            EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'closed') AS has_closed
       FROM inc i
      WHERE NOT EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'observed')
         OR (i.open_now = false AND NOT EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'closed'))
      ORDER BY i.at`,
  );
  if (!src.rows.length) return out;
  const links = await linkedLanes();
  for (const s of src.rows) {
    const excluded = excludedReason(s);
    const lane = s.lane_id ? (WORK_LANE[s.lane_id] ?? s.lane_id) : null;
    const linked = lane ? (links.get(lane) ?? []) : [];
    const states: ('observed' | 'closed')[] = [];
    if (!s.has_observed) states.push('observed');
    if (!s.open_now && !s.has_closed) states.push('closed');
    for (const state of states) {
      const closedAt = state === 'closed' && s.resolved_at ? new Date(s.resolved_at) : null;
      const seconds = closedAt && !Number.isNaN(closedAt.getTime()) ? Math.max(0, Math.round((closedAt.getTime() - new Date(s.occurred_at).getTime()) / 1000)) : null;
      const outcomes = {
        incident_frequency_7d: s.f7,
        incident_frequency_30d: s.f30,
        time_to_recovery_seconds: seconds,
        time_to_recovery_trusted: seconds !== null && closedAt !== null && closedAt.toISOString() >= RULE.recovery_trusted_from,
        retry_count: s.retry_count ?? 0,
        retries_within_cap: (s.retry_count ?? 0) <= 3,
        escalation_occurred: s.retry_status === 'Exhausted',
        closed_by: state === 'closed' ? s.resolved_by : null,
      };
      const r = await query(
        `INSERT INTO engine_logstream (logstream_row_id, incident_id, state, lane_id, linked_lanes, signature, workflow, failed_node, error_class, excluded_reason, occurred_at,
                                       objective_outcomes, research_trigger, commercial_relevance, audit)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb)
         ON CONFLICT (incident_id, state) DO NOTHING`,
        [
          mint('LS'),
          s.incident_id,
          state,
          lane,
          JSON.stringify(linked),
          signatureOf(s.workflow, s.node),
          s.workflow,
          s.node,
          s.error_class,
          excluded,
          s.occurred_at,
          JSON.stringify(outcomes),
          JSON.stringify({ threshold_crossed: !excluded && s.f7 >= RULE.research_at, rt_job_id: null, cause_distribution: null }),
          JSON.stringify({ linked_card_ids: [], relevance_note: null, pay_band_recommendation: null }),
          JSON.stringify({ written_by: 'logstream writer (dashboard)', approval_gate_status: 'not_reviewed' }),
        ],
      );
      if (r.rowCount) out[state]++;
    }
  }
  return out;
}

/* ----------------------------------------------------------- the trigger */

interface TriggerRow {
  id: string;
  trigger_id: string;
  kind: Crossing['kind'];
  key: string;
  action_state: string;
  attempts: number;
}

function jobText(c: Crossing): { question: string; context: string } {
  if (c.kind === 'workflow_rate') {
    const pct = Math.round(((c.failures ?? 0) / Math.max(1, c.runs ?? 1)) * 100);
    return {
      question: `The workflow "${c.workflow}" failed ${c.failures} of its ${c.runs} production runs in the last ${RULE.window_days} days (${pct}%). What is the most likely cause of a workflow failing this often, and what should change?`,
      context: `Opened by Logstream v0 (rules locked by Jason Bays, 9 Oct 2026): 20% or more of a workflow's production runs failing in 7 days, with at least ${RULE.rate_min_runs} runs and ${RULE.rate_min_failures} failures, opens one research job for the workflow. Workflow id ${c.key}. The failures may be in different steps; the question is why the workflow as a whole keeps failing.`,
    };
  }
  return {
    question: `An engine fault keeps coming back: the step "${c.node}" in "${c.workflow}" failed ${c.n} times in the last ${RULE.window_days} days. What is the most likely cause of a fault that repeats like this, and what should change?`,
    context: [
      `Opened by Logstream v0 (rules locked by Jason Bays, 9 Oct 2026): the same fault (workflow plus the step that failed) ${RULE.research_at} or more times in ${RULE.window_days} days is a pattern and gets one job for the pattern, never one per incident. Test, simulator and refused-ask incidents are not counted.`,
      `Lane: ${c.lane_id ?? 'not recorded'}. First ${c.first_at}, latest ${c.last_at}.`,
      `Incidents: ${c.incident_ids.join(', ')}.`,
      'The question is why it keeps happening, not any single incident.',
    ].join('\n'),
  };
}

function alertText(c: Crossing, triggerId: string): string {
  if (c.kind === 'shared_outage') {
    return `:rotating_light: *Logstream: one shared-cause outage* (\`${triggerId}\`)\n${c.n} workflows crossed a fault threshold in the last ${RULE.window_days} days: ${c.workflows.join(', ')}.\nThis is treated as one event. No per-workflow research is opened while it holds. A person needs to look for the shared cause.`;
  }
  return `:warning: *Logstream: a fault needs a person* (\`${triggerId}\`)\nThe step *${c.node}* in *${c.workflow}* failed ${c.n} times in the last ${RULE.window_days} days (${RULE.escalate_at} or more escalates to a person).\nIncidents: ${c.incident_ids.join(', ')}.\nNothing was retried, closed or changed by this.`;
}

async function alert(text: string): Promise<{ ok: true; channel: string; ts: string } | { ok: false; error: string }> {
  const channel = quota.channelId();
  if (!channel) return { ok: false, error: `${quota.CHANNEL_VAR} is not set, so there is nowhere to post the alert` };
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set, so nothing can be posted` };
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  if (r.ok && typeof r.ts === 'string') return { ok: true, channel: typeof r.channel === 'string' ? r.channel : channel, ts: r.ts };
  return { ok: false, error: `Slack refused the alert: ${String(r.error ?? 'unknown error')}` };
}

async function windowIncidents(): Promise<Incident[]> {
  const r = await query<Incident>(
    `SELECT natural_id AS incident_id, lane_id, fields->'payload'->>'workflow_or_scenario' AS workflow, fields->'payload'->>'failed_node_or_component' AS node,
            CASE WHEN jsonb_typeof(fields->'payload'->'impact_tags') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(fields->'payload'->'impact_tags')) END AS tags,
            to_char(coalesce(nullif(fields->>'occurred_at', ''), first_seen_at)::timestamptz AT TIME ZONE 'UTC', ${ISO}) AS occurred_at
       FROM engine_incidents
      WHERE natural_id IS NOT NULL AND coalesce(nullif(fields->>'occurred_at', ''), first_seen_at)::timestamptz > now() - ($1 || ' days')::interval`,
    [String(RULE.window_days)],
  );
  return r.rows;
}

async function windowRuns(): Promise<WorkflowRuns[]> {
  const r = await query<{ workflow_id: string; workflow: string | null; runs: string; failures: string }>(
    `SELECT workflow_id, max(workflow_name) AS workflow, count(*)::text AS runs, count(*) FILTER (WHERE status IN ('error', 'crashed'))::text AS failures
       FROM engine_execution_runs
      WHERE mode = ANY($1) AND status IN ('success', 'error', 'crashed') AND started_at::timestamptz > now() - ($2 || ' days')::interval
      GROUP BY workflow_id`,
    [[...quota.COUNTED_MODES], String(RULE.window_days)],
  );
  return r.rows.map((x) => ({ workflow_id: x.workflow_id, workflow: x.workflow ?? x.workflow_id, runs: Number(x.runs), failures: Number(x.failures) }));
}

let sweeping = false;

/** One pass: write the rows, find what crosses, record each crossing once, act on what is waiting. Never throws. */
export async function sweep(): Promise<{ rows_written: number; crossings: number; detected: number; jobs_opened: number; alerts_posted: number; failed: number }> {
  const out = { rows_written: 0, crossings: 0, detected: 0, jobs_opened: 0, alerts_posted: 0, failed: 0 };
  if (sweeping) return out;
  sweeping = true;
  try {
    const w = await writeRows();
    out.rows_written = w.observed + w.closed;
    const found = evaluate(await windowIncidents(), await windowRuns());
    out.crossings = found.length;
    const outage = found.some((c) => c.kind === 'shared_outage');
    const byKey = new Map(found.map((c) => [`${c.kind}|${c.key}`, c]));

    if (found.length) {
      await withTransaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
        for (const c of found) {
          const held = await db.query<{ id: string }>(`SELECT id::text FROM engine_logstream_triggers WHERE kind = $1 AND key = $2 AND detected_at > now() - ($3 || ' days')::interval ORDER BY id DESC LIMIT 1`, [c.kind, c.key, String(RULE.window_days)]);
          if (held.rows[0]) {
            await db.query(`UPDATE engine_logstream_triggers SET n = $2, runs = $3, failures = $4, incident_ids = $5::jsonb, workflows = $6::jsonb, last_at = $7 WHERE id = $1`, [held.rows[0].id, c.n, c.runs, c.failures, JSON.stringify(c.incident_ids), JSON.stringify(c.workflows), c.last_at]);
            continue;
          }
          const research = c.kind === 'signature_research' || c.kind === 'workflow_rate';
          const state = research && outage ? 'suppressed_shared_outage' : 'pending';
          const id = mint('LST');
          await db.query(
            `INSERT INTO engine_logstream_triggers (trigger_id, kind, key, workflow, failed_node, lane_id, n, runs, failures, incident_ids, workflows, first_at, last_at, action, action_state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15)`,
            [id, c.kind, c.key, c.workflow, c.node, c.lane_id ? (WORK_LANE[c.lane_id] ?? c.lane_id) : null, c.n, c.runs, c.failures, JSON.stringify(c.incident_ids), JSON.stringify(c.workflows), c.first_at, c.last_at, research ? 'research_job' : 'alert_person', state],
          );
          out.detected++;
          await engineEvents.record(
            { event_type: 'logstream_threshold_crossed', subject_id: id, lane: c.lane_id, actor: 'Logstream', detail: { kind: c.kind, key: c.key, n: c.n, runs: c.runs, failures: c.failures, incident_ids: c.incident_ids, workflows: c.workflows, window_days: RULE.window_days, action: state === 'pending' ? (research ? 'research job to be opened' : 'a person to be told') : 'no research: shared-cause outage' }, dedupe_key: `logstream_trigger:${id}` },
            db,
          );
        }
      });
    }

    const due = await query<TriggerRow>(`SELECT id::text, trigger_id, kind, key, action_state, attempts FROM engine_logstream_triggers WHERE action_state IN ('pending', 'failed') AND detected_at > now() - ($1 || ' days')::interval ORDER BY id`, [String(RULE.window_days)]);
    const links = due.rows.length ? await linkedLanes() : new Map<string, string[]>();
    for (const row of due.rows) {
      const c = byKey.get(`${row.kind}|${row.key}`);
      if (!c) continue; // it no longer holds; the row keeps its state and says so
      try {
        if (row.kind === 'signature_research' || row.kind === 'workflow_rate') {
          const { question, context } = jobText(c);
          const now = new Date().toISOString();
          const jobId = mint('JOB');
          const lane = c.lane_id ? (links.get(WORK_LANE[c.lane_id] ?? c.lane_id) ?? [])[0] ?? '' : '';
          const res = await engineWrite.postRecord(
            'rt-jobs',
            { created_time: now, fields: { 'Job ID': jobId, Question: question, Context: context.slice(0, 6000), 'Card ID': '', Lane: lane, Status: 'Pending', Attempts: 0, 'Opened By': 'Logstream', 'Opened At': now } },
            { endpoint: 'logstream:trigger', method: 'INTERNAL', key_label: 'server', t0: Date.now(), note: `${row.trigger_id}: ${row.kind} ${row.key}` },
          );
          const job = res.natural_id ?? jobId;
          await query(`UPDATE engine_logstream_triggers SET action_state = 'job_opened', job_id = $2, error = NULL, attempts = attempts + 1, acted_at = now() WHERE id = $1`, [row.id, job]);
          // The pattern's incidents each get a row saying research was opened for them. Append-only.
          for (const incidentId of c.incident_ids) {
            await query(
              `INSERT INTO engine_logstream (logstream_row_id, incident_id, state, lane_id, linked_lanes, signature, workflow, failed_node, error_class, excluded_reason, occurred_at, objective_outcomes, research_trigger, commercial_relevance, audit)
               SELECT $1, incident_id, 'research_opened', lane_id, linked_lanes, signature, workflow, failed_node, error_class, excluded_reason, occurred_at, objective_outcomes, $3::jsonb, commercial_relevance, $4::jsonb
                 FROM engine_logstream WHERE incident_id = $2 AND state = 'observed'
               ON CONFLICT (incident_id, state) DO NOTHING`,
              [mint('LS'), incidentId, JSON.stringify({ threshold_crossed: true, rt_job_id: job, trigger_id: row.trigger_id, cause_distribution: null }), JSON.stringify({ written_by: 'logstream trigger (dashboard)', approval_gate_status: 'not_reviewed' })],
            );
          }
          out.jobs_opened++;
        } else {
          const a = await alert(alertText(c, row.trigger_id));
          if (!a.ok) throw new Error(a.error);
          await query(`UPDATE engine_logstream_triggers SET action_state = 'alerted', alert_channel = $2, alert_ts = $3, error = NULL, attempts = attempts + 1, acted_at = now() WHERE id = $1`, [row.id, a.channel, a.ts]);
          out.alerts_posted++;
        }
      } catch (e) {
        out.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[logstream] ${row.trigger_id} (${row.kind} ${row.key}): the action did not land: ${msg}`);
        await query(`UPDATE engine_logstream_triggers SET action_state = 'failed', error = $2, attempts = attempts + 1 WHERE id = $1`, [row.id, msg.slice(0, 500)]);
      }
    }
    return out;
  } catch (e) {
    console.error(`[logstream] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...out, failed: out.failed + 1 };
  } finally {
    sweeping = false;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => void sweep();
  timer = setInterval(() => (timers.beat('logstream sweep'), tick()), SWEEP_MS);
  timer.unref();
  setTimeout(tick, 120_000).unref();
}
