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
    'Logstream: the engine’s own record of faults that keep coming back. A fault is a signature: the workflow plus the step that failed, never a lane. Without arguments it returns the locked rule in words; summary counts; holding_now (what is over a threshold this minute); crossings (each threshold crossed in the last 30 days, with what was done: the Research Twin job it opened and that job’s status, the alert it posted, whether North Star was asked for guidance, or why it was withdrawn or suppressed); faults (signatures with their 7-day and 30-day counts, the ones nearest the line first); pattern adherence (S757 closure protocol and BW9S guarded retry only); and empty_reads (a count only, for the 9 Nov re-tune). With signature (exact, "Workflow :: step") or workflow, it returns that fault’s incidents: incident id, when, state, how it closed and time to recovery where trusted. Research Twin: use it on a job whose Opened By is Logstream, to read the fault’s history before writing the finding. North Star: use it for guidance on a resolved Logstream job, and for "what keeps breaking". Read only. It never shows pay: nothing in Logstream pays anybody. Excluded rows (tests, the simulator, a guard’s refusals) are named as excluded and are counted in nothing.',
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
      const out = fit({ ok: true, asked_for: signature ? { signature } : { workflow }, total_incidents: incidents.length, counted: incidents.filter((i) => !i.excluded_reason).length, incidents, notes: ['Time to recovery is trusted only for an incident closed on or after 2 Oct 2026; each closed row says which.', 'An excluded incident is written down and counted in nothing.'] }, ['incidents'], maxChars);
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

export const LOGSTREAM_READ_TOOLS: ToolDefinition[] = [readLogstream];
