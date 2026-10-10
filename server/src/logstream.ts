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
 * Second pass, the same day (Destiny: "finish everything"):
 *
 *   **Which pattern applied.** Once an incident is closed it gets one
 *   `patterns_evaluated` row. Two of the four patterns can be read from
 *   records the engine already keeps, and only those two are: S757 (the
 *   closure protocol) from how the incident was closed, and BW9S (the guarded
 *   retry) from the audit line `retry_incident` writes. GRM8 is a pattern-draft
 *   outcome and raises no incident, so it never applies to a row here. GNER is
 *   a candidate and is not evaluated at all.
 *
 *   **The guidance step.** When the Research Twin job a trigger opened is
 *   Resolved, North Star is asked once, through n8n, to turn the finding into
 *   a recommendation and post it in its channel. A recommendation, never an
 *   action: North Star sets no tag and edits no card.
 *
 *   **The read.** `read()` is what the Logstream page draws.
 *
 * Honest limits, all carried on the rows themselves:
 *   - S757 is judged only for a close on or after 7 Oct 2026, when the
 *     protocol was first used, and only where the record says how it was
 *     closed. Anything else is `not_applicable`, never a guess.
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
import * as n8n from './n8n';

export const RULE = {
  window_days: 7,
  research_at: 3,
  escalate_at: 5,
  rate: 0.2,
  rate_min_runs: 10,
  rate_min_failures: 3,
  outage_workflows: 5,
  recovery_trusted_from: '2026-10-02T00:00:00.000Z',
  /** The closure protocol was first used on 7 Oct 2026; a close before then is not judged against it. */
  s757_from: '2026-10-07T00:00:00.000Z',
} as const;
export const PATTERNS = { S757: 'BP-BAYS-1791460374050-S757', BW9S: 'BP-BAYS-1791460380502-BW9S', GRM8: 'BP-BAYS-1791460387306-GRM8' } as const;
const GUIDANCE_PATH = process.env.LOGSTREAM_GUIDANCE_PATH?.trim() || '/webhook/logstream-guidance';
/** Where North Star posts its guidance: #bha-north-star-twin. */
const GUIDANCE_CHANNEL = process.env.LOGSTREAM_GUIDANCE_CHANNEL?.trim() || 'C0B5JHVAXCM';

export type Adherence = 'followed' | 'not_followed' | 'not_applicable';

/**
 * Which registered pattern applied to a closed incident, read from what the
 * record says and nothing else. Pure, so it can be tested.
 */
export function evaluatePatterns(i: { excluded: Excluded; resolved_at: string | null; resolved_by: string | null; close_reasoned: boolean; guarded_retries: number }): { applied: string[]; adherence: Record<string, { result: Adherence; why: string }> } {
  const adherence: Record<string, { result: Adherence; why: string }> = {};
  const na = (why: string) => ({ result: 'not_applicable' as Adherence, why });
  const by = (i.resolved_by ?? '').toLowerCase();
  if (i.excluded) adherence[PATTERNS.S757] = na(`a ${i.excluded.replace('_', ' ')} incident is counted in nothing`);
  else if (!i.resolved_at || new Date(i.resolved_at).toISOString() < RULE.s757_from) adherence[PATTERNS.S757] = na('closed before the protocol was first used on 7 Oct 2026');
  else if (i.close_reasoned) adherence[PATTERNS.S757] = { result: 'followed', why: 'closed by a person with a written reason and an audit line' };
  else if (/ledger|healer|recovery/.test(by)) adherence[PATTERNS.S757] = { result: 'not_followed', why: `closed without an evidence line: ${i.resolved_by}` };
  else adherence[PATTERNS.S757] = na(`the record does not say enough about how it was closed (${i.resolved_by ?? 'no closer recorded'})`);
  adherence[PATTERNS.BW9S] = i.guarded_retries > 0 ? { result: 'followed', why: `${i.guarded_retries} retry through retry_incident, each with a written reason and an audit line` } : na('no manual retry through retry_incident is recorded');
  adherence[PATTERNS.GRM8] = na('a cut-off answer is a pattern-draft outcome and raises no incident');
  return { applied: Object.keys(adherence).filter((k) => adherence[k].result !== 'not_applicable'), adherence };
}
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
  /** The n8n run the incident was raised from, where the handler recorded one. */
  execution_id?: string | null;
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
  has_evaluated: boolean;
  close_reasoned: boolean;
  guarded_retries: number;
}

/**
 * One `observed` row per incident held, and one `closed` row once it is no
 * longer open. Append-only: a row is never edited, and the unique index on
 * (incident, state) is what makes a repeat pass write nothing.
 */
export async function writeRows(): Promise<{ observed: number; closed: number; patterns_evaluated: number }> {
  const out = { observed: 0, closed: 0, patterns_evaluated: 0 };
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
            EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'closed') AS has_closed,
            EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'patterns_evaluated') AS has_evaluated,
            EXISTS (SELECT 1 FROM engine_mcp_writes m WHERE m.tool = 'close_incidents' AND m.outcome = 'applied' AND jsonb_typeof(m.arguments->'ids') = 'array' AND m.arguments->'ids' ? i.incident_id AND length(coalesce(m.arguments->>'reason', '')) > 0) AS close_reasoned,
            (SELECT count(*)::int FROM engine_mcp_writes m WHERE m.tool = 'retry_incident' AND m.outcome IN ('applied', 'refused') AND m.arguments->>'incident_id' = i.incident_id AND length(coalesce(m.arguments->>'reason', '')) > 0) AS guarded_retries
       FROM inc i
      WHERE NOT EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'observed')
         OR (i.open_now = false AND NOT EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'closed'))
         OR (i.open_now = false AND NOT EXISTS (SELECT 1 FROM engine_logstream l WHERE l.incident_id = i.incident_id AND l.state = 'patterns_evaluated'))
      ORDER BY i.at`,
  );
  if (!src.rows.length) return out;
  const links = await linkedLanes();
  for (const s of src.rows) {
    const excluded = excludedReason(s);
    const lane = s.lane_id ? (WORK_LANE[s.lane_id] ?? s.lane_id) : null;
    const linked = lane ? (links.get(lane) ?? []) : [];
    const states: ('observed' | 'closed' | 'patterns_evaluated')[] = [];
    if (!s.has_observed) states.push('observed');
    if (!s.open_now && !s.has_closed) states.push('closed');
    if (!s.open_now && !s.has_evaluated) states.push('patterns_evaluated');
    const pat = evaluatePatterns({ excluded, resolved_at: s.resolved_at, resolved_by: s.resolved_by, close_reasoned: s.close_reasoned, guarded_retries: s.guarded_retries });
    for (const state of states) {
      const closedAt = state !== 'observed' && s.resolved_at ? new Date(s.resolved_at) : null;
      const seconds = closedAt && !Number.isNaN(closedAt.getTime()) ? Math.max(0, Math.round((closedAt.getTime() - new Date(s.occurred_at).getTime()) / 1000)) : null;
      const outcomes = {
        incident_frequency_7d: s.f7,
        incident_frequency_30d: s.f30,
        time_to_recovery_seconds: seconds,
        time_to_recovery_trusted: seconds !== null && closedAt !== null && closedAt.toISOString() >= RULE.recovery_trusted_from,
        retry_count: s.retry_count ?? 0,
        retries_within_cap: (s.retry_count ?? 0) <= 3,
        escalation_occurred: s.retry_status === 'Exhausted',
        closed_by: state !== 'observed' ? s.resolved_by : null,
      };
      const r = await query(
        `INSERT INTO engine_logstream (logstream_row_id, incident_id, state, lane_id, linked_lanes, signature, workflow, failed_node, error_class, excluded_reason, occurred_at,
                                       objective_outcomes, research_trigger, commercial_relevance, audit, pattern_ids_applied, pattern_adherence)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb)
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
          JSON.stringify(state === 'patterns_evaluated' ? pat.applied : []),
          JSON.stringify(state === 'patterns_evaluated' ? pat.adherence : {}),
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
      context: `Opened by Logstream v0 (rules locked by Jason Bays, 9 Oct 2026): 20% or more of a workflow's production runs failing in 7 days, with at least ${RULE.rate_min_runs} runs and ${RULE.rate_min_failures} failures, opens one research job for the workflow. Workflow id ${c.key}. The failures may be in different steps; the question is why the workflow as a whole keeps failing.\nBefore writing the finding, read this workflow's faults: call read_logstream (BHA_Dashboard_read_logstream) with workflow "${c.workflow ?? ''}". Cite it as a source by its tool name.`,
    };
  }
  return {
    question: `An engine fault keeps coming back: the step "${c.node}" in "${c.workflow}" failed ${c.n} times in the last ${RULE.window_days} days. What is the most likely cause of a fault that repeats like this, and what should change?`,
    context: [
      `Opened by Logstream v0 (rules locked by Jason Bays, 9 Oct 2026): the same fault (workflow plus the step that failed) ${RULE.research_at} or more times in ${RULE.window_days} days is a pattern and gets one job for the pattern, never one per incident. Test, simulator and refused-ask incidents are not counted.`,
      `Lane: ${c.lane_id ?? 'not recorded'}. First ${c.first_at}, latest ${c.last_at}.`,
      `Incidents: ${c.incident_ids.join(', ')}.`,
      'The question is why it keeps happening, not any single incident.',
      `Before writing the finding, read this fault's own history: call read_logstream (BHA_Dashboard_read_logstream) with signature "${signatureOf(c.workflow, c.node)}". It lists every incident of this fault with when it happened, how it closed and how long recovery took. Cite it as a source by its tool name.`,
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
            to_char(coalesce(nullif(fields->>'occurred_at', ''), first_seen_at)::timestamptz AT TIME ZONE 'UTC', ${ISO}) AS occurred_at,
            fields->'payload'->>'execution_id' AS execution_id
       FROM engine_incidents
      WHERE natural_id IS NOT NULL AND coalesce(nullif(fields->>'occurred_at', ''), first_seen_at)::timestamptz > now() - ($1 || ' days')::interval`,
    [String(RULE.window_days)],
  );
  return r.rows;
}

/**
 * Production runs per workflow in the window. A run that failed because a guard
 * refused something (a refused ask throws on purpose, so the refusal is raised)
 * or that belongs to a test or simulator incident is left out of both the runs
 * and the failures: Jason's exclusions hold for the rate rule as they do for
 * the counts. Found on 10 Oct, when a refused test ask tipped North Star's
 * Front Door over 20% and a research job was opened on a guard doing its job.
 */
async function windowRuns(incidents: Incident[]): Promise<WorkflowRuns[]> {
  const skip = incidents.filter((i) => excludedReason(i) && i.execution_id && /^\d+$/.test(i.execution_id)).map((i) => i.execution_id as string);
  const r = await query<{ workflow_id: string; workflow: string | null; runs: string; failures: string }>(
    `SELECT workflow_id, max(workflow_name) AS workflow, count(*)::text AS runs, count(*) FILTER (WHERE status IN ('error', 'crashed'))::text AS failures
       FROM engine_execution_runs
      WHERE mode = ANY($1) AND status IN ('success', 'error', 'crashed') AND started_at::timestamptz > now() - ($2 || ' days')::interval
        AND NOT (execution_id::text = ANY($3))
      GROUP BY workflow_id`,
    [[...quota.COUNTED_MODES], String(RULE.window_days), skip],
  );
  return r.rows.map((x) => ({ workflow_id: x.workflow_id, workflow: x.workflow ?? x.workflow_id, runs: Number(x.runs), failures: Number(x.failures) }));
}

let sweeping = false;

/** One pass: write the rows, find what crosses, record each crossing once, act on what is waiting. Never throws. */
export async function sweep(): Promise<{ rows_written: number; crossings: number; detected: number; jobs_opened: number; alerts_posted: number; guidance_asked: number; failed: number }> {
  const out = { rows_written: 0, crossings: 0, detected: 0, jobs_opened: 0, alerts_posted: 0, guidance_asked: 0, failed: 0 };
  if (sweeping) return out;
  sweeping = true;
  try {
    const w = await writeRows();
    out.rows_written = w.observed + w.closed + w.patterns_evaluated;
    const inWindow = await windowIncidents();
    const found = evaluate(inWindow, await windowRuns(inWindow));
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
    const g = await requestGuidance();
    out.guidance_asked = g.asked;
    out.failed += g.failed;
    return out;
  } catch (e) {
    console.error(`[logstream] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...out, failed: out.failed + 1 };
  } finally {
    sweeping = false;
  }
}

/* ---------------------------------------------------------- the guidance */

interface GuidanceDue {
  id: string;
  trigger_id: string;
  kind: string;
  key: string;
  workflow: string | null;
  failed_node: string | null;
  lane_id: string | null;
  n: number;
  job_id: string;
  status: string | null;
  finding: string | null;
  confidence: string | null;
}

/** What North Star is asked, in full. Pure, so it can be tested. */
export function guidancePrompt(t: { trigger_id: string; kind: string; workflow: string | null; failed_node: string | null; lane_id: string | null; n: number; job_id: string; finding: string; confidence: string | null }, linked: string[]): string {
  const what = t.kind === 'workflow_rate' ? `the workflow "${t.workflow}" failing a fifth or more of its runs` : `the step "${t.failed_node}" in "${t.workflow}" failing ${t.n} times in ${RULE.window_days} days`;
  return [
    `Logstream guidance request ${t.trigger_id}. Research Twin has finished the research job ${t.job_id} that Logstream opened on a repeating engine fault: ${what}. Work lane: ${t.lane_id ?? 'not recorded'}.${linked.length ? ` Linked commercial lane: ${linked.join(', ')}.` : ' No commercial lane is linked to this work lane.'}`,
    `Research Twin's finding (confidence ${t.confidence ?? 'not stated'}):`,
    t.finding.slice(0, 3500),
    `First read the record: call read_logstream (BHA_Dashboard_read_logstream)${t.kind === 'workflow_rate' ? ` with workflow "${t.workflow ?? ''}"` : ` with signature "${signatureOf(t.workflow, t.failed_node)}"`} for this fault's incidents and how each closed, and once with no arguments for what else has crossed a threshold. Cite it in Sources as read_logstream.`,
    'Turn this into guidance, as a recommendation only. You set no tag, edit no card and open no job. Answer in this order, briefly:',
    '1. Lane: whether any ranking tag on the work lane should change because of this (engine_leverage, blocks_others), the value you recommend and why. Read the lane with your own tools first. If nothing should change, say so.',
    '2. Commercial card: one sentence a person could put on the linked lane\'s card, or "none" if no lane is linked or the finding has no commercial bearing.',
    '3. Research: whether another pass is warranted, and what it should ask.',
    `Name the job ${t.job_id} and the request ${t.trigger_id} in your answer. If the finding is too thin to support guidance, say that instead of guessing.`,
  ].join('\n\n');
}

/**
 * For every trigger whose research job has resolved and North Star has not
 * been asked: ask once. A capped job has no finding to act on and is marked
 * so. A request that does not land is `failed` with the reason and retried.
 */
export async function requestGuidance(): Promise<{ asked: number; failed: number; no_finding: number }> {
  const out = { asked: 0, failed: 0, no_finding: 0 };
  const due = await query<GuidanceDue>(
    `SELECT t.id::text, t.trigger_id, t.kind, t.key, t.workflow, t.failed_node, t.lane_id, t.n, t.job_id,
            j.fields->>'Status' AS status, coalesce(nullif(j.fields->>'Finding', ''), nullif(j.fields->>'Answer', ''), nullif(j.fields->>'Latest Answer', '')) AS finding, j.fields->>'Confidence' AS confidence
       FROM engine_logstream_triggers t
       JOIN LATERAL (SELECT fields FROM engine_rt_jobs r WHERE r.natural_id = t.job_id ORDER BY r.id DESC LIMIT 1) j ON true
      WHERE t.action_state = 'job_opened' AND t.job_id IS NOT NULL AND (t.guidance_state IS NULL OR t.guidance_state = 'failed')
        AND j.fields->>'Status' IN ('Resolved', 'Capped (needs human)')
      ORDER BY t.id`,
  );
  if (!due.rows.length) return out;
  const links = await linkedLanes();
  for (const t of due.rows) {
    if (t.status !== 'Resolved' || !t.finding) {
      await query(`UPDATE engine_logstream_triggers SET guidance_state = 'no_finding', guidance_error = $2, guidance_at = now() WHERE id = $1`, [t.id, t.status === 'Resolved' ? 'the job is Resolved and carries no finding text' : 'the research job was capped and needs a person; there is no finding to turn into guidance']);
      out.no_finding++;
      continue;
    }
    try {
      const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
      if (!key) throw new Error('DASHBOARD_INBOUND_KEY is not set on this server, and the guidance webhook is authenticated by it.');
      const linked = t.lane_id ? (links.get(t.lane_id) ?? []) : [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let status = 0;
      let text = '';
      try {
        const res = await fetch(`${n8n.n8nHost()}${GUIDANCE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-dashboard-key': key },
          body: JSON.stringify({ trigger_id: t.trigger_id, job_id: t.job_id, lane_id: t.lane_id ?? '', channel_id: GUIDANCE_CHANNEL, prompt: guidancePrompt({ ...t, finding: t.finding }, linked) }),
          signal: controller.signal,
        });
        status = res.status;
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      let body: { ok?: boolean; error?: string } = {};
      try {
        body = JSON.parse(text) as { ok?: boolean; error?: string };
      } catch {
        /* not JSON: the status and the text say what happened */
      }
      if (status < 200 || status >= 300 || body.ok !== true) throw new Error(`n8n answered ${status} at ${GUIDANCE_PATH}: ${body.error ?? (text.slice(0, 200) || 'no body')}`);
      await query(`UPDATE engine_logstream_triggers SET guidance_state = 'asked', guidance_error = NULL, guidance_at = now() WHERE id = $1`, [t.id]);
      await engineEvents.record({ event_type: 'logstream_guidance_requested', subject_id: t.trigger_id, lane: t.lane_id, actor: 'Logstream', detail: { job_id: t.job_id, channel: GUIDANCE_CHANNEL, confidence: t.confidence }, dedupe_key: `logstream_guidance:${t.trigger_id}` });
      out.asked++;
    } catch (e) {
      out.failed++;
      const msg = e instanceof Error ? (e.name === 'AbortError' ? `n8n did not answer ${GUIDANCE_PATH} within 20 seconds` : e.message) : String(e);
      console.error(`[logstream] ${t.trigger_id}: North Star was not asked for guidance: ${msg}`);
      await query(`UPDATE engine_logstream_triggers SET guidance_state = 'failed', guidance_error = $2, guidance_at = now() WHERE id = $1`, [t.id, msg.slice(0, 500)]);
    }
  }
  return out;
}

/* --------------------------------------------------------------- the read */

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', ${ISO})`;

/** What the Logstream page draws. A read and nothing else. */
/**
 * Empty reads on record (10 Oct 2026). `Bays — Daily Doc Rotator` writes one
 * `empty_read_check` event per run: how many channel docs it read and how many
 * came back with no content. This only counts them, for the 9 Nov re-tune,
 * where Jason decides whether "No Filler on an Empty Read" (GNER) becomes a
 * real pattern. Nothing in Logstream, and nothing else, decides on this.
 */
export async function emptyReads(): Promise<Record<string, unknown>> {
  const r = await query<{ runs: number; reads: number; empty: number; runs_with_empty: number; first_at: string | null; last_at: string | null }>(
    `SELECT count(*)::int AS runs,
            coalesce(sum(nullif(detail->>'reads', '')::numeric), 0)::int AS reads,
            coalesce(sum(nullif(detail->>'empty', '')::numeric), 0)::int AS empty,
            count(*) FILTER (WHERE coalesce(nullif(detail->>'empty', '')::numeric, 0) > 0)::int AS runs_with_empty,
            ${TS('min(at)')} AS first_at, ${TS('max(at)')} AS last_at
       FROM engine_events WHERE event_type = 'empty_read_check'`,
  );
  const recent = await query<{ at: string; reader: string | null; reads: number | null; empty: number | null; empty_subjects: unknown; source_ref: string | null }>(
    `SELECT ${TS('at')} AS at, detail->>'reader' AS reader, nullif(detail->>'reads', '')::int AS reads, nullif(detail->>'empty', '')::int AS empty,
            detail->'empty_subjects' AS empty_subjects, source_ref
       FROM engine_events WHERE event_type = 'empty_read_check' ORDER BY at DESC LIMIT 14`,
  );
  return {
    ...r.rows[0],
    recent: recent.rows,
    note: 'Record only. One event per run of the reader, a clean run included, so a night with no event is a night that was not recorded, never a night with no empty reads. GNER (CAND-1791450711610-GNER) stays a candidate and no runtime decision depends on these counts; the decision is for the re-tune due about 9 Nov 2026 (LOOP-1791558515351-4DR6).',
  };
}

export async function read(): Promise<Record<string, unknown>> {
  const [summary, triggers, signatures, rows, adherence, watch] = await Promise.all([
    query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE state = 'observed')::int AS incidents,
              count(*) FILTER (WHERE state = 'observed' AND excluded_reason IS NULL)::int AS counted,
              count(*) FILTER (WHERE state = 'observed' AND excluded_reason IS NOT NULL)::int AS excluded,
              count(*) FILTER (WHERE state = 'closed')::int AS closed,
              count(*) FILTER (WHERE state = 'observed' AND occurred_at > now() - interval '7 days' AND excluded_reason IS NULL)::int AS last_7d,
              count(*) FILTER (WHERE person_confirmed)::int AS person_confirmed,
              count(*) FILTER (WHERE autopay_enabled)::int AS autopay_enabled,
              ${TS('min(occurred_at)')} AS first_at, ${TS('max(written_at)')} AS last_written_at
         FROM engine_logstream`,
    ),
    query(
      `SELECT trigger_id, kind, key, workflow, failed_node, lane_id, n, runs, failures, incident_ids, workflows, ${TS('first_at')} AS first_at, ${TS('last_at')} AS last_at, ${TS('detected_at')} AS detected_at,
              action, action_state, job_id, alert_channel, alert_ts, error, attempts, guidance_state, guidance_error, ${TS('guidance_at')} AS guidance_at,
              (SELECT r.fields->>'Status' FROM engine_rt_jobs r WHERE r.natural_id = t.job_id ORDER BY r.id DESC LIMIT 1) AS job_status
         FROM engine_logstream_triggers t ORDER BY id DESC LIMIT 100`,
    ),
    query(
      `SELECT signature, max(workflow) AS workflow, max(failed_node) AS failed_node, max(lane_id) AS lane_id, max(excluded_reason) AS excluded_reason,
              count(*)::int AS total, count(*) FILTER (WHERE occurred_at > now() - interval '7 days')::int AS last_7d,
              count(*) FILTER (WHERE occurred_at > now() - interval '30 days')::int AS last_30d, ${TS('max(occurred_at)')} AS last_at
         FROM engine_logstream WHERE state = 'observed' GROUP BY signature ORDER BY last_7d DESC, total DESC, max(occurred_at) DESC LIMIT 200`,
    ),
    query(
      `SELECT logstream_row_id, incident_id, state, lane_id, signature, excluded_reason, ${TS('occurred_at')} AS occurred_at, ${TS('written_at')} AS written_at,
              objective_outcomes, research_trigger, pattern_ids_applied, pattern_adherence, person_confirmed, autopay_enabled
         FROM engine_logstream ORDER BY id DESC LIMIT 300`,
    ),
    query<{ pattern: string; result: string; n: number }>(
      `SELECT a.key AS pattern, a.value->>'result' AS result, count(*)::int AS n
         FROM engine_logstream l, jsonb_each(l.pattern_adherence) a WHERE l.state = 'patterns_evaluated' GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    windowIncidents().then(async (i) => [i, await windowRuns(i)] as const),
  ]);
  const now = evaluate(watch[0], watch[1]);
  return {
    rule: {
      ...RULE,
      words: [
        `Counted per fault (the workflow plus the step that failed), never per lane, over the last ${RULE.window_days} days.`,
        `${RULE.research_at} of the same fault opens one Research Twin job for the pattern. ${RULE.escalate_at} tells a person in the engine alerts channel.`,
        `A workflow with ${Math.round(RULE.rate * 100)}% or more of its production runs failing, at least ${RULE.rate_min_runs} runs and ${RULE.rate_min_failures} failures, opens one job.`,
        `${RULE.outage_workflows} or more workflows crossing at once is one shared-cause outage: one alert, and no per-workflow research.`,
        'Test, simulator and refused-ask incidents are written down and counted in nothing.',
      ],
      locked_by: 'Jason Bays, 9 Oct 2026. Re-tune due about 9 Nov 2026 (LOOP-1791558515351-4DR6).',
    },
    summary: summary.rows[0],
    holding_now: now.map((c) => ({ kind: c.kind, key: c.key, n: c.n, runs: c.runs, failures: c.failures })),
    triggers: triggers.rows,
    signatures: signatures.rows,
    rows: rows.rows,
    rows_cap: 300,
    adherence: adherence.rows,
    patterns: PATTERNS,
    notes: [
      'A read and analysis record. Nothing here pays anybody: person_confirmed and autopay_enabled are false on every row, and nothing sets or reads them.',
      'All Logstream can do is open a research job, post an alert, and ask North Star for guidance once research resolves. It never closes, retries, edits or deletes.',
      'Which pattern applied is judged for two patterns only, from records the engine already keeps: the closure protocol (S757), for a close on or after 7 Oct 2026, and the guarded retry (BW9S). The cut-off answer signal (GRM8) raises no incident, and the empty-read pattern (GNER) is a candidate nothing depends on.',
      'Time to recovery is trusted only for an incident closed on or after 2 Oct 2026, when closes started being dated and signed.',
      'The newest 300 rows and 100 crossings are shown. The table holds them all.',
    ],
  };
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => void sweep();
  timer = setInterval(() => (timers.beat('logstream sweep'), tick()), SWEEP_MS);
  timer.unref();
  setTimeout(tick, 120_000).unref();
}
