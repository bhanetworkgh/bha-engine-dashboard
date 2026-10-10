/**
 * Logstream over MCP (10 Oct 2026, Destiny — Jason's ask of 9 Oct: "Document
 * the schema and how RT and NS will read from it for incident routing and
 * guidance").
 *
 *   read_logstream — read, both connections, and in North Star's and Research
 *                    Twin's agent scope. The page's own read (logstream.read),
 *                    cut to what an agent needs and held to a size budget.
 *
 * How each twin uses it:
 *   Research Twin — when it works a job Logstream opened (Opened By:
 *     Logstream), it reads the fault's own history here: every incident of that
 *     signature with when it happened, how it closed and how long recovery took.
 *     That is the "cause distribution for that incident class" it was asked for.
 *   North Star — when Logstream asks it for guidance on a resolved job, or when
 *     a person asks what keeps breaking, it reads what has crossed a threshold,
 *     what was done about each crossing, and which faults are close to the line.
 *
 * It reads and nothing else. Pay is not here: person_confirmed and
 * autopay_enabled are false on every row and are not returned as anything to
 * act on.
 */
import { query } from '../pg';
import * as mirror from '../mirror';
import * as logstream from '../logstream';
import type { ToolDefinition } from './tools';

const DEFAULT_CHARS = 20_000;
const MAX_CHARS = 40_000;
const MIN_CHARS = 5_000;

type Dict = Record<string, unknown>;
const list = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : []);

/** Pop from the longest list until the JSON fits. Says what it cut. */
function fit(out: Dict, keys: string[], maxChars: number): Dict {
  let cut = false;
  for (let guard = 0; guard < 2000 && JSON.stringify(out).length > maxChars; guard++) {
    const longest = keys.map((k) => [k, list(out[k]).length] as const).sort((a, b) => b[1] - a[1])[0];
    if (!longest || longest[1] <= 1) break;
    (out[longest[0]] as Dict[]).pop();
    cut = true;
  }
  const chars = JSON.stringify(out).length;
  return cut
    ? { ...out, truncated: true, result_chars: chars, note: `Cut to fit ${maxChars} characters. Do not call again with the same arguments; narrow with signature or workflow, or raise max_chars (at most ${MAX_CHARS}).` }
    : { ...out, truncated: false, result_chars: chars };
}

export const readLogstream: ToolDefinition = {
  name: 'read_logstream',
  description:
    'Logstream: the engine’s own record of faults that keep coming back. A fault is a signature: the workflow plus the step that failed, never a lane. Without arguments it returns the locked rule in words; summary counts; holding_now (what is over a threshold this minute); crossings (each threshold crossed in the last 30 days, with what was done: the Research Twin job it opened and that job’s status, the alert it posted, whether North Star was asked for guidance, or why it was withdrawn or suppressed); faults (signatures with their 7-day and 30-day counts, the ones nearest the line first); pattern adherence (S757 closure protocol and BW9S guarded retry only); and empty_reads (a count only, for the 9 Nov re-tune). With signature (exact, "Workflow :: step") or workflow, it returns that fault’s crossings (the research job opened for it and its status, the alert posted) and its incidents: incident id, when, state, how it closed and time to recovery where trusted. Research Twin: use it on a job whose Opened By is Logstream, to read the fault’s history before writing the finding. North Star: use it for guidance on a resolved Logstream job, and for "what keeps breaking". Read only. It never shows pay: nothing in Logstream pays anybody. Excluded rows (tests, the simulator, a guard’s refusals) are named as excluded and are counted in nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      signature: { type: 'string', description: 'One fault, exactly as faults lists it, e.g. "post_response_incident_reporting :: agent-orchestrator".' },
      workflow: { type: 'string', description: 'Every fault of one workflow, by its exact name.' },
      max_chars: { type: 'number', description: `Size budget for the answer. Default ${DEFAULT_CHARS}, at most ${MAX_CHARS}.` },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Logstream: recurring faults and what was done' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const maxChars = Math.max(MIN_CHARS, Math.min(MAX_CHARS, Number(args.max_chars) || DEFAULT_CHARS));
    const signature = typeof args.signature === 'string' && args.signature.trim() ? args.signature.trim() : null;
    const workflow = typeof args.workflow === 'string' && args.workflow.trim() ? args.workflow.trim() : null;
    const log = (detail: string) =>
      mirror.logWrite({ endpoint: 'mcp:read_logstream', kind: 'logstream', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: detail.slice(0, 400), ms: Date.now() - t0 });

    if (signature || workflow) {
      const r = await query<Dict>(
        `SELECT incident_id, state, lane_id, signature, excluded_reason,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
                objective_outcomes, research_trigger, pattern_adherence
           FROM engine_logstream
          WHERE ($1::text IS NULL OR signature = $1) AND ($2::text IS NULL OR workflow = $2)
          ORDER BY occurred_at DESC, id DESC LIMIT 400`,
        [signature, workflow],
      );
      if (!r.rows.length) {
        await log(`${signature ?? workflow} → no rows`);
        return { ok: false, reason: 'no_such_fault', message: `Logstream holds no row for ${signature ? `signature "${signature}"` : `workflow "${workflow}"`}. Call read_logstream with no arguments and copy a signature from faults exactly as written.` };
      }
      const byIncident = new Map<string, Dict>();
      for (const row of r.rows) {
        const id = String(row.incident_id);
        const cur = byIncident.get(id) ?? { incident_id: id, signature: row.signature, lane_id: row.lane_id, occurred_at: row.occurred_at, excluded_reason: row.excluded_reason, states: [] as string[] };
        (cur.states as string[]).push(String(row.state));
        if (row.state === 'closed') cur.closed = row.objective_outcomes;
        if (row.state === 'patterns_evaluated') cur.pattern_adherence = row.pattern_adherence;
        if (row.state === 'observed') cur.at_observation = row.research_trigger;
        byIncident.set(id, cur);
      }
      const incidents = [...byIncident.values()];
      // What was done about this fault: without it a reader sees five closed incidents and
      // concludes no research was ever opened (the draft test of 10 Oct read it exactly so).
      const crossed = await query<Dict>(
        `SELECT t.trigger_id, t.kind, t.n, t.runs, t.failures, to_char(t.detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at,
                t.action, t.action_state, t.job_id, t.alert_ts, t.error, t.guidance_state,
                (SELECT r.fields->>'Status' FROM engine_rt_jobs r WHERE r.natural_id = t.job_id ORDER BY r.id DESC LIMIT 1) AS job_status
           FROM engine_logstream_triggers t
          WHERE ($1::text IS NOT NULL AND t.key = $1) OR ($2::text IS NOT NULL AND t.workflow = $2)
          ORDER BY t.id DESC LIMIT 20`,
        [signature, workflow],
      );
      const out = fit({ ok: true, asked_for: signature ? { signature } : { workflow }, total_incidents: incidents.length, counted: incidents.filter((i) => !i.excluded_reason).length, crossings: crossed.rows, incidents, notes: ['crossings is what was done about this fault: the research job it opened (job_id, job_status), the alert it posted, or why nothing was opened. An empty crossings list means it has never crossed a threshold.', 'Time to recovery is trusted only for an incident closed on or after 2 Oct 2026; each closed row says which.', 'An excluded incident is written down and counted in nothing.'] }, ['incidents'], maxChars);
      await log(`${signature ?? workflow} → ${incidents.length} incidents, ${out.result_chars} chars`);
      return out;
    }

    const page = await logstream.read();
    const since = Date.now() - 30 * 86_400_000;
    const crossings = list(page.triggers)
      .filter((t) => !t.detected_at || new Date(String(t.detected_at)).getTime() >= since)
      .map((t) => ({ trigger_id: t.trigger_id, kind: t.kind, key: t.key, lane_id: t.lane_id, n: t.n, runs: t.runs, failures: t.failures, first_at: t.first_at, last_at: t.last_at, detected_at: t.detected_at, action: t.action, action_state: t.action_state, job_id: t.job_id, job_status: t.job_status, alert_ts: t.alert_ts, error: t.error, guidance_state: t.guidance_state }));
    const faults = list(page.signatures)
      .filter((s) => Number(s.last_30d) > 0 || Number(s.total) >= 2)
      .map((s) => ({ signature: s.signature, lane_id: s.lane_id, last_7d: s.last_7d, last_30d: s.last_30d, total: s.total, last_at: s.last_at, excluded_reason: s.excluded_reason }));
    const out = fit(
      {
        ok: true,
        rule: (page.rule as Dict).words,
        locked_by: (page.rule as Dict).locked_by,
        summary: page.summary,
        holding_now: page.holding_now,
        crossings,
        faults,
        pattern_adherence: page.adherence,
        empty_reads: await logstream.emptyReads(),
        notes: page.notes,
        page_url: `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/$/, '')}/logstream`,
      },
      ['faults', 'crossings'],
      maxChars,
    );
    await log(`overview → ${crossings.length} crossings, ${faults.length} faults, ${out.result_chars} chars`);
    return out;
  },
};

/**
 * engine.event.v1 over MCP (10 Oct 2026, Destiny — Jason's go-time notice of the
 * same day: "finish the agent/twin consumption paths (Bays, NS, RT, Slack Genie)
 * off engine.event.v1 and Logstream").
 *
 *   read_engine_events — read, both connections, in Bays', North Star's and
 *                        Research Twin's scope. The append-only engine_events
 *                        table: counts by type over a window, and the newest
 *                        events that match. It reads and nothing else.
 */
const EVENT_HOURS = 168;
const EVENT_HOURS_MAX = 720;
const EVENT_LIMIT = 50;
const EVENT_LIMIT_MAX = 200;
const DETAIL_CHARS = 600;

export const readEngineEvents: ToolDefinition = {
  name: 'read_engine_events',
  description:
    'The engine’s own structured events, in the shape engine.event.v1: { event_type, at, subject_id, lane, actor, source_ref, detail }. Append-only; this tool reads and never writes. What is recorded today: digest_dispatch_succeeded / digest_dispatch_failed (was a digest actually posted), lane_blocker_cleared, the vFarm gate events (VFARM_STAGE1_STATE_CHANGED, VFARM_STAGE2_STATE_CHANGED, VFARM_CHECK_UPDATED, VFARM_OFFER_STATE_CHANGED), approval_requested / approval_decided / approval_expired, monitoring_recurrence_detected, logstream_threshold_crossed, openrouter_credit_out and empty_read_check. Without arguments it returns counts by event type over the last 7 days and the newest 50 events. Narrow with event_type (one name or a list, exact), subject_id (exact), lane (exact) and since_hours (at most 720). Use it to answer "did the digest go out", "what changed on the vFarm gates and when", "what was approved or denied", "when did this blocker clear". No event of a type in the window means none was recorded, which is not proof that nothing happened: say so. For recurring faults use read_logstream instead.',
  inputSchema: {
    type: 'object',
    properties: {
      event_type: { description: 'One event type, or a list of them, exactly as written.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      subject_id: { type: 'string', description: 'The id of the thing the event is about, exactly.' },
      lane: { type: 'string', description: 'The lane on the event, exactly.' },
      since_hours: { type: 'number', description: `How far back to read. Default ${EVENT_HOURS}, at most ${EVENT_HOURS_MAX}.` },
      limit: { type: 'number', description: `How many events to return, newest first. Default ${EVENT_LIMIT}, at most ${EVENT_LIMIT_MAX}.` },
      max_chars: { type: 'number', description: `Size budget for the answer. Default ${DEFAULT_CHARS}, at most ${MAX_CHARS}.` },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Engine events (engine.event.v1)' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const maxChars = Math.max(MIN_CHARS, Math.min(MAX_CHARS, Number(args.max_chars) || DEFAULT_CHARS));
    const hours = Math.max(1, Math.min(EVENT_HOURS_MAX, Number(args.since_hours) || EVENT_HOURS));
    const limit = Math.max(1, Math.min(EVENT_LIMIT_MAX, Math.floor(Number(args.limit)) || EVENT_LIMIT));
    const types = (Array.isArray(args.event_type) ? args.event_type : args.event_type == null ? [] : [args.event_type])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
    const subject = typeof args.subject_id === 'string' && args.subject_id.trim() ? args.subject_id.trim() : null;
    const lane = typeof args.lane === 'string' && args.lane.trim() ? args.lane.trim() : null;
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const where = `at > $1 AND ($2::text[] IS NULL OR event_type = ANY($2)) AND ($3::text IS NULL OR subject_id = $3) AND ($4::text IS NULL OR lane = $4)`;
    const values = [since, types.length ? types : null, subject, lane];
    const counts = await query<{ event_type: string; n: number; last_at: string }>(
      `SELECT event_type, count(*)::int AS n, to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at
         FROM engine_events WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`,
      values,
    );
    const rows = await query<Dict>(
      `SELECT id::int AS id, event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, subject_id, lane, actor, source_ref, detail
         FROM engine_events WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${limit}`,
      values,
    );
    const total = counts.rows.reduce((a, c) => a + c.n, 0);
    const events = rows.rows.map((r) => {
      const text = JSON.stringify(r.detail ?? {});
      return text.length > DETAIL_CHARS ? { ...r, detail: `${text.slice(0, DETAIL_CHARS)}…`, detail_cut: true, detail_chars: text.length } : r;
    });
    const out = fit(
      {
        ok: true,
        shape: 'engine.event.v1',
        window: { since, hours },
        asked_for: { event_type: types.length ? types : null, subject_id: subject, lane },
        total_in_window: total,
        returned: events.length,
        by_type: counts.rows,
        events,
        notes: [
          total > events.length ? `${total} events matched and the newest ${events.length} are returned. Narrow with event_type, subject_id or lane, or raise limit (at most ${EVENT_LIMIT_MAX}).` : 'Every matching event is returned.',
          'No event of a type in the window means none was recorded. It is not proof that nothing happened.',
        ],
      },
      ['events'],
      maxChars,
    );
    await mirror.logWrite({ endpoint: 'mcp:read_engine_events', kind: 'engine_events', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${hours}h ${types.join(',') || 'all types'}${subject ? ` subject ${subject}` : ''}${lane ? ` lane ${lane}` : ''} → ${events.length} of ${total}, ${out.result_chars} chars`.slice(0, 400), ms: Date.now() - t0 });
    return out;
  },
};

export const LOGSTREAM_READ_TOOLS: ToolDefinition[] = [readLogstream, readEngineEvents];
