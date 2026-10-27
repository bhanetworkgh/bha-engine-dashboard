/**
 * The draft eval (13 Oct 2026, Destiny — agent maturity, evaluation and change
 * control: "the eval still follows the publish").
 *
 * Until this, an agent change went live first and the eval ran about three
 * minutes later (publishGate.ts): a failing version had already answered
 * people by the time anyone knew. This runs an agent's eval cases against its
 * **unpublished draft** instead, through n8n's own `call_agent` (its Preview
 * chat), so the verdict exists before the publish.
 *
 * It is the runner's eval, not a second one:
 *   - the cases are `agent_eval_set` (the same n8n Data Table), newest row per
 *     case_id, active only, every repeat;
 *   - each question carries the same context block the runner sends;
 *   - each answer is scored by the same code checks (`score`, a port of the
 *     runner's Score Answer node) and a case passes only if every repeat does;
 *   - a regression is what the publish check calls one: a case that passed in
 *     the latest finished production run and fails here. A case already
 *     failing there is named and is not a regression.
 *
 * What makes it a verdict about one draft, and nothing else:
 *   - the draft's `configHash` is read before the first case and after the
 *     last. If they differ the draft changed mid-run and the run is
 *     `draft_changed`, never `passed`;
 *   - the publish check matches a run to a version by that hash
 *     (`verdictFor`): a later edit makes a new hash and the old run no longer
 *     covers it.
 *
 * Guards: n8n's MCP token must be set; the OpenRouter balance must be at least
 * $15 (the runner's floor) and is read fresh, except for an Anthropic backup,
 * which spends none of it (25 Oct 2026); one draft run per agent at a
 * time; an answer that failed because the account could not pay stops the run
 * (`stopped_credit`), as the runner does. A run is not resumed across a
 * restart: one left `running` at boot is marked `interrupted`.
 *
 * North Star's answers are scored raw here: the runner passes them through the
 * Builder Pronoun Guard first, and this does not. The run says so in `detail`.
 *
 * It asks and scores. It never publishes, never edits an agent and never
 * writes to `engine_eval_runs` (whose readers treat every row as production).
 */
import * as engineEvents from './engineEvents';
import * as n8nMcp from './n8nMcp';
import { query } from './pg';
import * as researchSignals from './researchSignals';

// concurrency 1 from 13 Oct 2026: at 3, n8n's MCP server answered 429 to 32 of 60 calls in the first run.
export const RULE = { credit_floor_usd: 15, concurrency: 1, call_timeout_ms: 300_000, run_limit_minutes: 120 } as const;

export const AGENTS: Record<string, { id: string; name: string }> = {
  bays: { id: 'Nw5igXu4WWrjUMWB', name: 'Bays (Agent)' },
  north_star: { id: '8NQRXadH0OrKe5XV', name: 'North Star (Agent)' },
  research_twin: { id: 'dDtsExaaXhlFd2dv', name: 'Research Twin (Agent)' },
};
/**
 * The Anthropic backups (18 Oct 2026, Destiny): exact copies of the three
 * primaries on Anthropic, called only when OpenRouter fails. They answer the
 * primary's cases, so a backup is tested with its primary's case set; the run
 * stores the backup's own agent id and name, which is what the publish check
 * matches on.
 */
export const BACKUPS: Record<string, { key: string; name: string }> = {
  PjKGbV4ZnH4YOfri: { key: 'bays', name: 'Bays (Anthropic backup)' },
  fqeON4jXjenIi3cP: { key: 'north_star', name: 'North Star (Anthropic backup)' },
  '7ToBQqHpffX1eUG0': { key: 'research_twin', name: 'Research Twin (Anthropic backup)' },
};
const EVAL_TABLE = process.env.AGENT_EVAL_SET_TABLE_ID?.trim() || 'Uj5kCvQBixzY3MqU';
const EVAL_PROJECT = process.env.AGENT_EVAL_SET_PROJECT_ID?.trim() || 'HjupolvfBya6b0ox';
const CREDIT_ERROR = /(exceed your available credits|insufficient credits|payment required|requires more credits|credit balance is too low)/i;

type Dict = Record<string, unknown>;

export function agentKeyFor(idOrKey: string): string | null {
  const v = String(idOrKey || '').trim();
  if (AGENTS[v]) return v;
  for (const [k, a] of Object.entries(AGENTS)) if (a.id === v) return k;
  return null;
}

/* ----------------------------------------------------------- the runner's own parts */

/** The context block the runner's Expand Repeats node writes, word for word. */
export function contextFor(agent: string, ask: string, q: string): string {
  if (agent === 'north_star') return ['[Context supplied by the system -- not typed by the person]', 'ask_id: ' + ask, 'channel_id: (none) | thread_ts: (none)', 'builder_id: SYSTEM-EVAL | lane_id: (none)', 'action_token: (none -- Search_Slack will not work on this ask)', 'This is a direct question from another BHA system (source: eval), not a Slack message. Your answer is delivered back to it for you.', '[End of context]', '', 'Question:', q].join('\n');
  if (agent === 'research_twin') return 'source: eval, ask_id: ' + ask + ', session_id: ' + ask + ', builder_id: SYSTEM-EVAL, lane_id: ENGINE_INTERNAL, card_id: , queue_row_id: , channel_id: , thread_ts: \n\n' + q;
  return ['[Context supplied by the system]', 'This is a direct question from another BHA system (source: eval), not a Slack message.', 'Asked on behalf of: <@U0AEW3TBYH1> (user ID U0AEW3TBYH1) | lane: not given', 'Your reply will be posted for you into channel (none). Do not post it yourself.', '[End of context]', '', 'Question:', q].join('\n');
}

export interface CheckResult { name: string; ok: boolean; detail: string }

/** The runner's Score Answer node, ported: code checks only, each named. */
export function score(answer: string, error: string | null, checksJson: unknown): { passed: boolean; results: CheckResult[] } {
  let checks: Dict = {};
  try {
    checks = typeof checksJson === 'string' ? (JSON.parse(checksJson || '{}') as Dict) : ((checksJson as Dict) ?? {});
  } catch {
    checks = {};
  }
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail = '') => results.push({ name, ok: !!ok, detail });
  const err = answer ? '' : error || 'the agent returned no answer text';
  add('answered', !err, err ? String(err).slice(0, 200) : answer.length + ' chars');
  if (checks.two_sections) add('two_sections', /what the evidence supports/i.test(answer) && /what it does not( yet)? support/i.test(answer));
  if (checks.cites) {
    const markers = [...new Set(answer.match(/\[S\d+\]/g) || [])];
    const at = answer.search(/\n\s*[*_#]*\s*sources\b/i);
    const listed = new Set(((at >= 0 ? answer.slice(at) : '').match(/^\s*\[S\d+\]/gm) || []).map((s) => s.trim()));
    const unmapped = markers.filter((m) => !listed.has(m));
    add('cites', markers.length > 0 && unmapped.length === 0, markers.length + ' markers' + (unmapped.length ? ', not in Sources: ' + unmapped.join(' ') : ''));
  }
  for (const re of (Array.isArray(checks.contains) ? checks.contains : []) as string[]) add('contains /' + re + '/', new RegExp(re, 'i').test(answer));
  for (const re of (Array.isArray(checks.not_contains) ? checks.not_contains : []) as string[]) add('not_contains /' + re + '/', !new RegExp(re, 'i').test(answer));
  return { passed: results.every((r) => r.ok), results };
}

export interface EvalCase { case_id: string; question: string; checks: string; repeats: number }

/** The newest row per case_id, active, for one agent: what the runner would ask. */
export function latestCases(rows: Dict[], agent: string): EvalCase[] {
  const latest: Record<string, Dict> = {};
  for (const c of rows) {
    const id = typeof c.case_id === 'string' ? c.case_id : '';
    if (!id) continue;
    if (!latest[id] || Number(c.id) > Number(latest[id].id)) latest[id] = c;
  }
  return Object.values(latest)
    .filter((c) => c.agent === agent && c.active !== false)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((c) => ({ case_id: String(c.case_id), question: String(c.question ?? ''), checks: typeof c.checks === 'string' ? c.checks : JSON.stringify(c.checks ?? {}), repeats: Math.max(1, Math.min(5, Number(c.repeats) || 1)) }));
}

/* ----------------------------------------------------------- the production baseline */

const FINISHED = `WITH runs AS (
    SELECT fields->>'Run ID' AS run_id, max(fields->>'Run At')::timestamptz AS ended,
           count(*) AS n, max((fields->>'Run Size')::int) AS size
      FROM engine_eval_runs GROUP BY 1)
  SELECT run_id FROM runs WHERE size IS NOT NULL AND n >= size`;

async function baseline(agent: string): Promise<{ run_id: string; failed: Set<string>; cases: Set<string> } | null> {
  const r = await query<{ run_id: string }>(
    `${FINISHED} AND EXISTS (SELECT 1 FROM engine_eval_runs e WHERE e.fields->>'Run ID' = runs.run_id AND e.fields->>'Agent' = $1) ORDER BY ended DESC LIMIT 1`,
    [agent],
  );
  const run = r.rows[0]?.run_id;
  if (!run) return null;
  const c = await query<{ case_id: string; ok: boolean }>(
    `SELECT fields->>'Case ID' AS case_id, bool_and((fields->>'Passed') = 'true') AS ok FROM engine_eval_runs WHERE fields->>'Run ID' = $1 AND fields->>'Agent' = $2 GROUP BY 1`,
    [run, agent],
  );
  return { run_id: run, failed: new Set(c.rows.filter((x) => !x.ok).map((x) => x.case_id)), cases: new Set(c.rows.map((x) => x.case_id)) };
}

/* ----------------------------------------------------------- running one */

export class DraftEvalError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    this.name = 'DraftEvalError';
  }
}

const mint = (): string => `DRAFT-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;

async function configHash(agentId: string): Promise<string | null> {
  // configHash and every skill hash together (n8nMcp.changeHash): a skill
  // edited mid-run or after the run is a change, not the config tested.
  return n8nMcp.changeHash(await n8nMcp.getAgent(agentId));
}

export interface StartResult {
  run_id: string | null;
  agent: string;
  agent_id: string;
  cases: number;
  results_expected: number;
  case_ids: string[];
  config_hash: string | null;
  credit_usd: number | null;
  dry_run: boolean;
  /** Which route the answers come through: OpenRouter for a main agent, Anthropic for a backup. */
  ran_on: 'OpenRouter' | 'Anthropic';
  /** Set when a main agent's run fell back to its backup: the main agent, and its draft's config, the run covers. */
  covers_agent_id: string | null;
  covers_config_hash: string | null;
  fallback_reason: string | null;
}

/** A main agent's Anthropic backup, by the main agent's key. */
export const BACKUP_OF: Record<string, string> = Object.fromEntries(Object.entries(BACKUPS).map(([id, b]) => [b.key, id]));

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as Dict).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Dict)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Tools a backup carries in another shape that does the same thing, by tool
 * name: the backup's workflow id. Each is a deliberate, documented stand-in.
 *   GitHub: n8n's MCP will not let an agent's GitHub node take a model-filled
 *   owner and repository, so the backup reads a repository through
 *   `Bays — GitHub Repo Read` (18 Oct 2026; the workflow's sticky says so).
 */
export const EQUIVALENT_BACKUP_TOOLS: Record<string, string> = { GitHub: 'FB4i1s8gebDDQM45' };

/** Tools keyed by name (their order is not behaviour); a known stand-in compares equal to the original. */
function toolsByName(tools: unknown, side: 'main' | 'backup'): Dict {
  const out: Dict = {};
  for (const t of Array.isArray(tools) ? (tools as Dict[]) : []) {
    const name = String(t?.name ?? '');
    const stand = EQUIVALENT_BACKUP_TOOLS[name];
    out[name] = stand && (side === 'main' || (t.type === 'workflow' && t.workflowId === stand)) ? `equivalent:${name}` : t;
  }
  return out;
}

/** The parts of a draft that decide how it answers; name, model, credential and scheduled tasks are left out. */
const BEHAVIOUR_KEYS = ['instructions', 'tools', 'personalisation', 'memory', 'providerTools', 'config', 'mcpServers'] as const;

/**
 * Where a backup's draft would answer differently from its main agent's draft,
 * in words; empty when the two differ only in name, model route, credential and
 * scheduled tasks. Two get_agent results in, nothing read or written.
 * Skills are compared by name, because each agent's skills carry its own ids.
 */
export function behaviourDiff(main: Dict, backup: Dict): string[] {
  const out: string[] = [];
  const mc = (main.config ?? {}) as Dict;
  const bc = (backup.config ?? {}) as Dict;
  const keyed = (c: Dict, side: 'main' | 'backup'): Dict => ({ ...c, tools: toolsByName(c.tools, side) });
  const mk = keyed(mc, 'main');
  const bk = keyed(bc, 'backup');
  for (const k of BEHAVIOUR_KEYS) if (stable(mk[k]) !== stable(bk[k])) out.push(k === 'mcpServers' ? 'its MCP servers or their tool permissions' : k === 'instructions' ? 'its instructions' : k === 'tools' ? 'its tools' : k);
  if (stable(main.customTools ?? []) !== stable(backup.customTools ?? [])) out.push('its custom tools');
  const skills = (r: Dict): Map<string, string> => {
    const m = new Map<string, string>();
    for (const s of Object.values((r.skills ?? {}) as Dict)) {
      const x = (s ?? {}) as Dict;
      m.set(String(x.name), stable({ d: x.description, i: x.instructions, t: x.allowedTools ?? [], r: x.references ?? [] }));
    }
    return m;
  };
  const ms = skills(main);
  const bs = skills(backup);
  for (const [n, v] of ms) {
    if (!bs.has(n)) out.push(`skill "${n}" is missing on the backup`);
    else if (bs.get(n) !== v) out.push(`skill "${n}" differs`);
  }
  for (const n of bs.keys()) if (!ms.has(n)) out.push(`skill "${n}" is only on the backup`);
  return out;
}

async function busyCheck(agentId: string, name: string): Promise<void> {
  const busy = await query<{ run_id: string }>(`SELECT run_id FROM engine_draft_eval_runs WHERE agent_id = $1 AND state = 'running' LIMIT 1`, [agentId]);
  if (busy.rows[0]) throw new DraftEvalError(`A draft eval is already running for ${name} (${busy.rows[0].run_id}). One at a time per agent.`, 'already_running');
}

/**
 * Checks everything, records the run and starts it in the background.
 * Returns at once; the run takes minutes. Throws DraftEvalError on a refusal,
 * with nothing recorded and nothing asked.
 *
 * **A main agent falls back to its Anthropic backup** (25 Oct 2026, Destiny:
 * "evals have a backup the way Bays works"). When OpenRouter's balance is under
 * the floor or cannot be read, the run asks the backup instead, which spends
 * Anthropic credit, but only when the backup's draft matches the main draft in
 * everything that decides an answer (`behaviourDiff`): the two run the same
 * model by different routes, so the verdict is about the same change. The run
 * then covers the main draft too (`covers_*`), which is what the publish check
 * matches. A backup that differs is refused, naming what differs; this server
 * does not edit an agent to make them match.
 */
export async function start(input: { agent: string; requested_by: string | null; dry_run?: boolean }): Promise<StartResult> {
  const backup = BACKUPS[String(input.agent || '').trim()];
  const agent = backup ? backup.key : agentKeyFor(input.agent);
  if (!agent) throw new DraftEvalError(`"${input.agent}" is not an agent this can test. One of: ${Object.keys(AGENTS).join(', ')}, or a backup's id (${Object.keys(BACKUPS).join(', ')}).`, 'unknown_agent');
  const a = backup ? { id: String(input.agent).trim(), name: backup.name } : AGENTS[agent];
  if (!n8nMcp.n8nMcpConfigured()) throw new DraftEvalError(`${n8nMcp.N8N_MCP_VAR} is not set on this server, so the draft cannot be asked.`, 'not_configured');
  await busyCheck(a.id, a.name);
  const cases = await readCases(agent);
  // A backup answers on Anthropic, not OpenRouter (25 Oct 2026): Anthropic has no API that reads a
  // balance, so a backup's run is not gated on one; it stops at the first answer the account could
  // not pay for, as every run does.
  if (backup) {
    return begin({ agent, a, cases, input, provider: 'Anthropic', credit: null, covers: null, why: null, notes: ['Anthropic backup: answers on Anthropic, so the OpenRouter balance was not checked; Anthropic exposes no balance to read.'] });
  }
  const credit = await researchSignals.credit(true);
  const why = !credit.ok
    ? `the OpenRouter balance could not be read (${credit.error})`
    : credit.remaining_usd < RULE.credit_floor_usd
      ? `OpenRouter credit is $${credit.remaining_usd.toFixed(2)}, under the $${RULE.credit_floor_usd} a run needs`
      : null;
  if (!why) return begin({ agent, a, cases, input, provider: 'OpenRouter', credit: credit.ok ? credit.remaining_usd : null, covers: null, why: null, notes: [] });
  return fallback(agent, a, cases, input, why, credit.ok ? 'credit_low' : 'credit_unread');
}

async function readCases(agent: string): Promise<EvalCase[]> {
  let rows: Dict[];
  try {
    rows = await n8nMcp.readDataTableRows(EVAL_TABLE, EVAL_PROJECT);
  } catch (e) {
    throw new DraftEvalError(`The eval cases could not be read from agent_eval_set: ${e instanceof Error ? e.message : String(e)}`, 'cases_unread');
  }
  const cases = latestCases(rows, agent);
  if (!cases.length) throw new DraftEvalError(`agent_eval_set holds no active case for ${agent}.`, 'no_cases');
  return cases;
}

const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The main agent's run, on its Anthropic backup. Refused when there is none or the drafts differ. */
async function fallback(agent: string, main: { id: string; name: string }, cases: EvalCase[], input: { requested_by: string | null; dry_run?: boolean }, why: string, reason: string): Promise<StartResult> {
  const bid = BACKUP_OF[agent];
  if (!bid) throw new DraftEvalError(`${sentence(why)}, and ${main.name} has no Anthropic backup to run it on. Nothing was asked.`, reason);
  const b = { id: bid, name: BACKUPS[bid].name };
  await busyCheck(b.id, b.name);
  let mainDraft: Dict;
  let backupDraft: Dict;
  try {
    [mainDraft, backupDraft] = await Promise.all([n8nMcp.getAgent(main.id), n8nMcp.getAgent(b.id)]);
  } catch (e) {
    throw new DraftEvalError(`${sentence(why)}, and the drafts could not be read from n8n to check ${b.name} matches ${main.name}: ${e instanceof Error ? e.message : String(e)}`, 'draft_unread');
  }
  const diff = behaviourDiff(mainDraft, backupDraft);
  if (diff.length) {
    throw new DraftEvalError(
      `${sentence(why)}, so this would run on ${b.name}, but its draft does not match ${main.name}'s draft: ${diff.slice(0, 6).join('; ')}${diff.length > 6 ? `; and ${diff.length - 6} more` : ''}. Bring the backup in line with the main draft, then run it again. Nothing was asked.`,
      'backup_differs',
    );
  }
  const coversHash = n8nMcp.changeHash(mainDraft);
  return begin({
    agent, a: b, cases, input, provider: 'Anthropic', credit: null, why,
    covers: { agent_id: main.id, name: main.name, hash: coversHash },
    hash: n8nMcp.changeHash(backupDraft),
    notes: [`Ran on the Anthropic backup because ${why}. Its draft matched ${main.name}'s draft in everything but the model route, so this run covers ${main.name} at config ${(coversHash ?? 'unknown').slice(0, 16)}.`],
  });
}

async function begin(o: {
  agent: string; a: { id: string; name: string }; cases: EvalCase[]; input: { requested_by: string | null; dry_run?: boolean };
  provider: 'OpenRouter' | 'Anthropic'; credit: number | null; covers: { agent_id: string; name: string; hash: string | null } | null;
  why: string | null; notes: string[]; hash?: string | null;
}): Promise<StartResult> {
  const expected = o.cases.reduce((n, c) => n + c.repeats, 0);
  const hash = o.hash !== undefined ? o.hash : await configHash(o.a.id).catch((e) => {
    throw new DraftEvalError(`The draft's config could not be read from n8n: ${e instanceof Error ? e.message : String(e)}`, 'draft_unread');
  });
  const out: StartResult = {
    run_id: null, agent: o.agent, agent_id: o.a.id, cases: o.cases.length, results_expected: expected, case_ids: o.cases.map((c) => c.case_id),
    config_hash: hash, credit_usd: o.credit, dry_run: o.input.dry_run === true, ran_on: o.provider,
    covers_agent_id: o.covers?.agent_id ?? null, covers_config_hash: o.covers?.hash ?? null, fallback_reason: o.why,
  };
  if (o.input.dry_run) return out;
  const runId = mint();
  const notes = [o.agent === 'north_star' ? 'North Star answers are scored raw: the runner passes them through the Builder Pronoun Guard first and this does not.' : null, ...o.notes].filter(Boolean).join(' ');
  await query(
    `INSERT INTO engine_draft_eval_runs (run_id, agent, agent_id, agent_name, config_hash_before, cases, results_expected, credit_before_usd, requested_by, detail, covers_agent_id, covers_config_hash, ran_on, fallback_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    // ran_on and fallback_reason stored (27 Oct 2026, migration 97), so a backup run is counted without reading detail.
    [runId, o.agent, o.a.id, o.a.name, hash, o.cases.length, expected, o.credit, o.input.requested_by, notes || null, o.covers?.agent_id ?? null, o.covers?.hash ?? null, o.provider, o.why ?? null],
  );
  const main = o.provider === 'OpenRouter' ? o.a : null;
  void run(runId, o.agent, o.a.id, o.cases, o.provider, {
    covers: o.covers,
    // OpenRouter running out mid-run starts the whole run again on the backup, never a mix of the two.
    onCreditOut: main ? () => fallback(o.agent, main, o.cases, { requested_by: o.input.requested_by }, 'OpenRouter credit ran out during the run', 'credit_low') : null,
  }).catch(async (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[draft-eval] ${runId}: ${msg}`);
    await query(`UPDATE engine_draft_eval_runs SET state = 'error', detail = $2, finished_at = now() WHERE run_id = $1 AND state = 'running'`, [runId, msg.slice(0, 1000)]).catch(() => undefined);
  });
  return { ...out, run_id: runId };
}

interface Result { case_id: string; repeat: number; passed: boolean; failed_checks: string; answer: string; execution_id: string | null; status: string; not_asked?: boolean }

async function run(
  runId: string, agent: string, agentId: string, cases: EvalCase[], provider = 'OpenRouter',
  opts: { covers?: { agent_id: string; name: string; hash: string | null } | null; onCreditOut?: (() => Promise<StartResult>) | null } = {},
): Promise<void> {
  const items = cases.flatMap((c) => Array.from({ length: c.repeats }, (_, i) => ({ c, repeat: i + 1 })));
  const results: Result[] = [];
  const deadline = Date.now() + RULE.run_limit_minutes * 60_000;
  let stop: { state: string; detail: string } | null = null;
  let next = 0;
  const worker = async () => {
    while (!stop && next < items.length) {
      if (Date.now() > deadline) {
        stop = { state: 'timed_out', detail: `the run passed its ${RULE.run_limit_minutes}-minute limit with ${results.length} of ${items.length} answers` };
        return;
      }
      const it = items[next++];
      const ask = `${runId}-${it.c.case_id}-${it.repeat}`;
      let ans: n8nMcp.DraftAnswer;
      let notAsked = false;
      try {
        try {
          ans = await n8nMcp.callAgentDraft(agentId, contextFor(agent, ask, it.c.question), RULE.call_timeout_ms);
        } catch (first) {
          // One more try, 30 seconds later, when the road dropped (13 Oct 2026: 2 of 60 calls ended
          // "stopped answering part-way through: terminated"). The eval cases write nothing, so asking
          // the draft a second time is safe. A refusal of the token is not retried.
          if (first instanceof n8nMcp.N8nMcpError && first.reason === 'unauthorised') throw first;
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          ans = await n8nMcp.callAgentDraft(agentId, contextFor(agent, ask, it.c.question), RULE.call_timeout_ms);
        }
      } catch (e) {
        // A transport failure (n8n's MCP server unreachable, refusing, rate-limiting) is a fact
        // about the road to the draft, not about the draft: the answer was never asked for.
        notAsked = true;
        ans = { status: 'not_asked', response: '', execution_id: null, error: e instanceof Error ? e.message : String(e) };
      }
      if (!ans.response && CREDIT_ERROR.test(String(ans.error))) {
        stop = { state: 'stopped_credit', detail: `stopped at ${it.c.case_id} (repeat ${it.repeat}): ${provider} credit is out. The answers so far are a partial run, not a verdict. The agent said: ${String(ans.error).slice(0, 300)}` };
        return;
      }
      const s = score(ans.response, ans.error, it.c.checks);
      results.push({
        case_id: it.c.case_id,
        repeat: it.repeat,
        passed: s.passed,
        failed_checks: s.results.filter((r) => !r.ok).map((r) => r.name + (r.detail ? ` (${r.detail})` : '')).join(' | '),
        answer: ans.response.slice(0, 4000),
        execution_id: ans.execution_id,
        status: ans.status,
        ...(notAsked ? { not_asked: true } : {}),
      });
      await query(`UPDATE engine_draft_eval_runs SET results_done = $2 WHERE run_id = $1`, [runId, results.length]).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RULE.concurrency, items.length) }, worker));

  const byCase = new Map<string, boolean>();
  for (const r of results) byCase.set(r.case_id, (byCase.get(r.case_id) ?? true) && r.passed);
  const failed = [...byCase.entries()].filter(([, ok]) => !ok).map(([id]) => id).sort();
  const passed = byCase.size - failed.length;
  results.sort((x, y) => x.case_id.localeCompare(y.case_id) || x.repeat - y.repeat);

  let state: string;
  let detail: string;
  let hashAfter: string | null = null;
  let regressed: string[] = [];
  let compared: string | null = null;
  const halted = stop as { state: string; detail: string } | null;
  if (halted) {
    state = halted.state;
    detail = halted.detail;
    if (state === 'stopped_credit' && opts.onCreditOut) {
      try {
        const again = await opts.onCreditOut();
        detail += ` Started again on the Anthropic backup as ${again.run_id}.`;
      } catch (e) {
        detail += ` Not started again on the Anthropic backup: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } else {
    hashAfter = await configHash(agentId).catch(() => null);
    const before = (await query<{ config_hash_before: string | null }>(`SELECT config_hash_before FROM engine_draft_eval_runs WHERE run_id = $1`, [runId])).rows[0]?.config_hash_before ?? null;
    const base = await baseline(agent);
    compared = base?.run_id ?? null;
    regressed = base ? failed.filter((c) => !base.failed.has(c)) : failed;
    const known = failed.filter((c) => !regressed.includes(c));
    const unasked = results.filter((r) => r.not_asked);
    if (unasked.length) {
      state = 'incomplete';
      detail = `${unasked.length} of ${results.length} answers were never asked of the draft (${String(unasked[0].failed_checks).slice(0, 200)}), so this is not a verdict; run it again`;
    } else if (!hashAfter || !before) {
      state = 'incomplete';
      detail = 'the draft config could not be read again after the run, so this run cannot be tied to one draft; run it again';
    } else if (hashAfter !== before) {
      state = 'draft_changed';
      detail = `the draft changed during the run (config ${before.slice(0, 12)} before, ${hashAfter.slice(0, 12)} after), so this is not a verdict about either`;
    } else if (opts.covers && (!opts.covers.hash || (await configHash(opts.covers.agent_id).catch(() => null)) !== opts.covers.hash)) {
      // A backup run covers the main draft only while that draft is still the one it was matched against.
      state = 'draft_changed';
      detail = `${opts.covers.name}'s draft changed during the run (or could not be read again), so this run no longer covers it; run it again`;
    } else if (regressed.length) {
      state = 'failed';
      detail = `${passed} of ${byCase.size} cases passed; ${regressed.join(', ')} failed${base ? ` and passed in ${base.run_id}` : ' (no finished production run to compare with)'}${known.length ? `; already failing before: ${known.join(', ')}` : ''}`;
    } else {
      state = 'passed';
      detail = `${passed} of ${byCase.size} cases passed${known.length ? `; ${known.join(', ')} failed and were already failing in ${base?.run_id}` : ''}${base ? `; compared with ${base.run_id}` : ''}`;
    }
  }
  await query(
    `UPDATE engine_draft_eval_runs SET state = $2, detail = trim(both ' ' from coalesce(detail || ' ', '') || $3), config_hash_after = $4, results_done = $5, cases_passed = $6,
            failed_cases = $7::jsonb, regressed = $8::jsonb, compared_with = $9, results = $10::jsonb, finished_at = now()
      WHERE run_id = $1`,
    [runId, state, detail, hashAfter, results.length, passed, JSON.stringify(failed), JSON.stringify(regressed), compared, JSON.stringify(results)],
  );
  await engineEvents
    .record({ event_type: 'draft_eval_finished', subject_id: agentId, lane: 'ENGINE', actor: 'draft eval', detail: { run_id: runId, agent, state, detail, config_hash: hashAfter, cases: byCase.size, cases_passed: passed, regressed }, dedupe_key: `draft_eval:${runId}` })
    .catch((e) => console.error(`[draft-eval] event not recorded: ${e instanceof Error ? e.message : String(e)}`));
}

/** A run left `running` by a process that stopped is not resumed. Called at boot. */
export async function markInterrupted(): Promise<number> {
  const r = await query(`UPDATE engine_draft_eval_runs SET state = 'interrupted', detail = trim(both ' ' from coalesce(detail || ' ', '') || 'the server restarted during the run; it was not resumed'), finished_at = now() WHERE state = 'running'`);
  return r.rowCount ?? 0;
}

/* ----------------------------------------------------------- reading */

export interface DraftRun {
  run_id: string; agent: string; agent_id: string; agent_name: string; state: string; detail: string | null;
  cases: number; results_expected: number; results_done: number; cases_passed: number | null;
  failed_cases: string[]; regressed: string[]; compared_with: string | null;
  config_hash_before: string | null; config_hash_after: string | null;
  requested_by: string | null; started_at: string; finished_at: string | null;
  covers_agent_id: string | null; covers_config_hash: string | null;
  results?: Result[];
}

const COLS = `run_id, agent, agent_id, agent_name, state, detail, cases, results_expected, results_done, cases_passed, failed_cases, regressed, compared_with,
              config_hash_before, config_hash_after, requested_by, started_at::text AS started_at, finished_at::text AS finished_at,
              covers_agent_id, covers_config_hash`;

export async function read(runId: string): Promise<DraftRun | null> {
  const r = await query<DraftRun>(`SELECT ${COLS}, results FROM engine_draft_eval_runs WHERE run_id = $1`, [runId]);
  return r.rows[0] ?? null;
}

export async function recent(limit = 20, agent?: string | null): Promise<DraftRun[]> {
  const r = agent
    ? await query<DraftRun>(`SELECT ${COLS} FROM engine_draft_eval_runs WHERE agent = $2 ORDER BY started_at DESC LIMIT $1`, [limit, agent])
    : await query<DraftRun>(`SELECT ${COLS} FROM engine_draft_eval_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

/**
 * The draft verdict that covers a version: the newest finished run for this
 * agent whose draft config, read after the run, is the config now published,
 * or a run on its Anthropic backup that was matched against that same config.
 */
export async function verdictFor(agentId: string, hash: string | null): Promise<{ run_id: string; state: string; detail: string | null } | null> {
  if (!hash) return null;
  const r = await query<{ run_id: string; state: string; detail: string | null }>(
    `SELECT run_id, state, detail FROM engine_draft_eval_runs
      WHERE ((agent_id = $1 AND config_hash_after = $2) OR (covers_agent_id = $1 AND covers_config_hash = $2))
        AND state IN ('passed', 'failed') ORDER BY finished_at DESC LIMIT 1`,
    [agentId, hash],
  );
  return r.rows[0] ?? null;
}
