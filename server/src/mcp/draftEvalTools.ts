/**
 * The draft eval over MCP (13 Oct 2026, Destiny). Write connection only, in no
 * agent's scope: a person's tools, used before publishing an agent change.
 *
 *   run_draft_eval  — ask an agent's eval cases of its unpublished draft
 *                     (draftEval.start). Spends model credit, so it is on the
 *                     write connection and audited; `dry_run` reads the cases,
 *                     the draft's config hash and the balance, and asks nothing.
 *   read_draft_eval — one run, case by case, or the latest runs. A read.
 *
 * The publish check reads the same runs when the inventory records a new
 * version, and says in the alerts channel when one went live untested.
 */
import * as draftEval from '../draftEval';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const AGENT_KEYS = Object.keys(draftEval.AGENTS);

export const runDraftEvalTool: ToolDefinition = {
  name: 'run_draft_eval',
  description:
    `Test an agent's unpublished draft against its eval cases before publishing it. agent: ${AGENT_KEYS.join(', ')}, or an Anthropic backup's n8n agent id (${Object.keys(draftEval.BACKUPS).join(', ')}), which is tested with its primary's cases. Every active case in agent_eval_set for that agent is asked of the DRAFT through n8n's preview chat, every repeat, with the eval runner's own context block, and scored by the runner's own code checks; a case passes only if every repeat passes. A regression is a case that passed in the latest finished production eval run and fails on the draft. The draft's config hash is read before and after, so a draft edited mid-run is never a verdict. Returns at once with run_id; the run takes several minutes (read it with read_draft_eval). After publishing, record the agent inventory: the publish check matches the new version to this run by config hash and says in the alerts channel if it went live untested. **Falls back to the Anthropic backup by itself**: when a main agent's run cannot be paid on OpenRouter (balance under $${draftEval.RULE.credit_floor_usd} or unreadable, or the credit runs out mid-run), the whole run goes to that agent's Anthropic backup instead, provided the backup's draft matches the main draft in everything but the model route (instructions, tools, MCP permissions, skills by name, memory, config); the run then covers the main draft too, so a pass clears both for publishing. ran_on says which route answered, covers_agent_id which main draft it covers. A backup that differs is refused as backup_differs, naming what differs; this tool never edits an agent. Refused with nothing asked when n8n's MCP token is not set, a run is already going for that agent, or there are no active cases. requester_user_id: who asked. dry_run: read the cases, hash and balance and ask nothing. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: `Which agent's draft: ${AGENT_KEYS.join(', ')} (or its n8n agent id).` },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking.' },
      dry_run: { type: 'boolean', description: 'Read the cases, the draft config hash and the balance; ask nothing.' },
    },
    required: ['agent'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Test an agent draft before publishing' },
  handler: async (args, deps) => {
    const agent = typeof args.agent === 'string' ? args.agent.trim() : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'run_draft_eval', args, access: deps.access, kind: 'draft_eval', requester, dry_run: dry });
    try {
      const r = await draftEval.start({ agent, requested_by: requester ?? `mcp:${deps.access}`, dry_run: dry });
      if (dry) {
        await auditClose(audit, { outcome: 'dry_run', detail: `would ask ${r.results_expected} answers over ${r.cases} cases of ${r.agent}'s draft (config ${r.config_hash?.slice(0, 12) ?? 'unknown'})`, natural_id: r.agent_id, guard_result: r });
        return { ok: true, started: false, ...r, dry_run: true, message: `Dry run: nothing was asked. A run would ask ${r.cases} cases, ${r.results_expected} answers in all, of ${r.agent}'s draft (config ${r.config_hash?.slice(0, 12) ?? 'unknown'}). ${r.ran_on === 'Anthropic' ? `Would run on the Anthropic backup${r.fallback_reason ? ` because ${r.fallback_reason}` : ''}${r.covers_agent_id ? `, covering ${r.covers_agent_id}'s draft` : ''}.` : `OpenRouter balance $${r.credit_usd?.toFixed(2) ?? '?'}.`}`, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'created', detail: `${r.run_id}: ${r.results_expected} answers over ${r.cases} cases of ${r.agent}'s draft, config ${r.config_hash?.slice(0, 12) ?? 'unknown'}`, natural_id: r.run_id, after: r });
      return { ok: true, started: true, ...r, message: `Started ${r.run_id}: ${r.cases} cases, ${r.results_expected} answers, against ${r.agent}'s draft (config ${r.config_hash?.slice(0, 12) ?? 'unknown'}), on ${r.ran_on}${r.fallback_reason ? ` because ${r.fallback_reason}` : ''}${r.covers_agent_id ? `; it covers ${r.covers_agent_id}'s draft too` : ''}. Read it with read_draft_eval run_id="${r.run_id}". Publish only once it reads passed, then record the agent inventory.`, audit_id: audit };
    } catch (e) {
      const refusal = e instanceof draftEval.DraftEvalError;
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: refusal ? 'refused' : 'failed', detail: `${refusal ? (e as draftEval.DraftEvalError).reason + ': ' : ''}${message}`.slice(0, 500) });
      return { ok: false, started: false, reason: refusal ? (e as draftEval.DraftEvalError).reason : 'error', message: `${message} Nothing was asked.`, ...(refusal ? {} : { raise: true }), audit_id: audit };
    }
  },
};

export const readDraftEvalTool: ToolDefinition = {
  name: 'read_draft_eval',
  description:
    'Read draft eval runs (run_draft_eval). run_id: one run, with every case and repeat (checks that failed, the answer cut at 4,000 characters, the n8n execution id). Without run_id: the latest runs, optionally for one agent. A run is running, passed, failed (a regression against the latest finished production run), draft_changed (the draft was edited mid-run: not a verdict), stopped_credit, timed_out, interrupted (the server restarted) or error. Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'One run, e.g. DRAFT-202610131600-AB12.' },
      agent: { type: 'string', description: `Only this agent's runs: ${AGENT_KEYS.join(', ')}.` },
      limit: { type: 'number', description: 'How many runs without run_id. Default 10, at most 50.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read draft eval runs' },
  handler: async (args) => {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
    if (runId) {
      const r = await draftEval.read(runId);
      return r ? { ok: true, run: r } : { ok: false, reason: 'not_found', message: `No draft eval run "${runId}" is held.` };
    }
    const agent = typeof args.agent === 'string' && args.agent.trim() ? draftEval.agentKeyFor(args.agent) : null;
    if (typeof args.agent === 'string' && args.agent.trim() && !agent) return { ok: false, reason: 'unknown_agent', message: `One of: ${AGENT_KEYS.join(', ')}.` };
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    const runs = await draftEval.recent(limit, agent);
    return { ok: true, runs, note: runs.length ? undefined : 'No draft eval has been run yet.' };
  },
};

export const DRAFT_EVAL_WRITE_TOOLS: ToolDefinition[] = [runDraftEvalTool, readDraftEvalTool];
