/**
 * The agent inventory (2 Oct 2026, Destiny — Agent Upgrade Plan step 5.2,
 * governance). One row per n8n Agent in `engine_agent_inventory`, holding what
 * n8n's own `get_agent` returned about it — never a description typed by hand.
 *
 * How a row gets here: the MCP write tool `record_agent_inventory` is handed
 * the `get_agent` result (the n8n MCP is the only place agent config can be
 * read from; the n8n public API has no agents endpoint), and this module keeps
 * the parts that describe the agent — model, tools, MCP scope and approvals,
 * skills, scheduled tasks, sub-agents, memory, the credential ids it references
 * — and drops the instruction text and skill bodies, which are long and are not
 * inventory. The **autonomy tier is derived here, in code**, from that config:
 *
 *   T0  read only            — no tool that can change anything
 *   T1  writes, all approved — every write tool sits behind a human approval
 *   T2  writes on request    — writes without approval, but only when asked
 *   T3  scheduled and writes — runs on a schedule *and* can write unapproved
 *
 * Which tools write: an MCP tool writes if this server registers it on the
 * write connection and not the read one (its own list, read at run time); a
 * node or workflow tool is classed by its name, on a short verb list stated on
 * the row (`writes_rule`), because n8n's node config does not say. A row says
 * when it was read and from what; the page marks it stale after seven days,
 * because an inventory that is quietly a month old is the thing this exists to
 * replace.
 */
import { createHash } from 'node:crypto';
import { nowIso } from './db';
import { query } from './pg';
import { mcpWriteToolNames } from './mcp/tools';

export const STALE_AFTER_DAYS = 7;

/** A node or workflow tool whose name carries one of these is classed as a write. */
export const WRITE_NAME_VERBS = [
  'create', 'write', 'edit', 'ingest', 'post', 'send', 'log', 'update', 'delete', 'archive', 'register', 'queue', 'compute', 'request', 'ask', 'nudge', 'publish', 'upload', 'mark',
];
/** A tool whose name opens with one of these reads, whatever follows. */
export const READ_FIRST_WORDS = ['search', 'read', 'get', 'list', 'find', 'query', 'lookup'];

export interface InventoryTool {
  name: string;
  type: 'node' | 'workflow' | 'custom' | 'mcp';
  /** For a node tool, the n8n node type; for an MCP tool, the server name. */
  via: string | null;
  writes: boolean;
  /** How `writes` was decided. */
  writes_rule: 'server registry' | 'name verb' | 'none matched';
  approval: boolean;
}

export interface InventoryMcpServer {
  name: string;
  host: string | null;
  authentication: string;
  /** Where the token travels: a bearer header, or the URL path (the state the 1 Oct re-score marked down). */
  token_in: 'header' | 'url path' | 'none' | 'other';
  tools: string[];
  approval: string[];
}

export interface InventoryTask {
  id: string;
  name: string | null;
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
}

export interface InventoryRow {
  agent_id: string;
  name: string;
  published: boolean | null;
  active_version_id: string | null;
  config_hash: string | null;
  model: string | null;
  reasoning: string | null;
  max_iterations: number | null;
  memory: Record<string, unknown> | null;
  tools: InventoryTool[];
  mcp_servers: InventoryMcpServer[];
  skills: { id: string; name: string | null; description: string | null; allowed_tools: string[] }[];
  tasks: InventoryTask[];
  sub_agents: { agent_id: string; use_when: string | null }[];
  credentials: { id: string | null; name: string | null; type: string }[];
  autonomy_tier: string;
  tier_reason: string;
  owner: string | null;
  read_from: string;
  read_at: string;
  recorded_by: string | null;
  first_seen_at: string;
  updated_at: string;
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

function hostOf(url: unknown): string | null {
  try {
    return typeof url === 'string' && url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

/**
 * Whole words, not substrings (2 Oct): `includes` made Search_Channel_Archives
 * a write on "archive". A name that opens with a read word is a read. A tool
 * whose URL ends in /ask is a query endpoint (BHARAG's), so Ask_BHA_Cluster
 * reads; Ask_Research_Twin posts to another agent's webhook, which starts a
 * run that answers in Slack, and stays a write.
 */
function nameWrites(name: string, url?: string | null): boolean {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length && READ_FIRST_WORDS.includes(words[0])) return false;
  if (url && /\/ask\/?$/.test(url.split('?')[0])) return false;
  return words.some((w) => WRITE_NAME_VERBS.includes(w));
}

/**
 * Turn one `get_agent` result into an inventory row. Pure: it reads the config
 * and this server's own write-tool registry and touches nothing else.
 */
export function derive(result: Dict, opts: { owner?: string | null; recordedBy?: string | null; readAt?: string }): Omit<InventoryRow, 'first_seen_at' | 'updated_at'> & { raw: Dict } {
  const agent = dict(result.agent);
  const config = dict(result.config);
  const agentId = str(agent.id);
  if (!agentId) throw new Error('agent.id is missing: pass the whole get_agent result');
  const name = str(config.name) ?? str(agent.name) ?? agentId;
  const writeNames = new Set(mcpWriteToolNames());

  const tools: InventoryTool[] = [];
  const credentials: InventoryRow['credentials'] = [];
  for (const t of list(config.tools).map(dict)) {
    const type = str(t.type) as InventoryTool['type'] | null;
    const tname = str(t.name) ?? str(t.workflow) ?? str(t.id) ?? '(unnamed)';
    const node = dict(t.node);
    for (const [ctype, c] of Object.entries(dict(node.credentials))) {
      const cd = dict(c);
      credentials.push({ id: str(cd.id), name: str(cd.name), type: ctype });
    }
    const writes = nameWrites(tname, str(dict(node.nodeParameters).url));
    tools.push({
      name: tname,
      type: type === 'workflow' || type === 'custom' || type === 'node' ? type : 'node',
      via: type === 'workflow' ? str(t.workflowId) ?? str(t.workflow) : str(node.nodeType),
      writes,
      writes_rule: writes ? 'name verb' : 'none matched',
      approval: t.requireApproval === true,
    });
  }

  const mcpServers: InventoryMcpServer[] = [];
  for (const m of list(config.mcpServers).map(dict)) {
    const filter = dict(m.toolFilter);
    const approval = dict(m.approval);
    const allowed = str(filter.mode) === 'allow' ? strs(filter.tools) : [];
    const approved = str(approval.mode) === 'global' ? allowed : strs(approval.tools);
    const auth = str(m.authentication) ?? 'none';
    const url = str(m.url) ?? '';
    const mname = str(m.name) ?? 'mcp';
    if (str(m.credential)) credentials.push({ id: str(m.credential), name: `${mname} (${auth})`, type: auth });
    mcpServers.push({
      name: mname,
      host: hostOf(url),
      authentication: auth,
      token_in: auth === 'bearerAuth' || auth === 'headerAuth' || auth === 'multipleHeadersAuth' ? 'header' : /\/mcp\/[0-9a-f]{20,}/i.test(url) ? 'url path' : auth === 'none' ? 'none' : 'other',
      tools: allowed,
      approval: approved,
    });
    for (const tn of allowed) {
      tools.push({ name: tn, type: 'mcp', via: mname, writes: writeNames.has(tn), writes_rule: 'server registry', approval: approved.includes(tn) });
    }
  }
  if (str(config.credential)) credentials.push({ id: str(config.credential), name: 'model credential', type: 'model' });

  const skillBodies = dict(result.skills);
  const skills = list(config.skills).map(dict).map((s) => {
    const id = str(s.id) ?? '';
    const body = dict(skillBodies[id]);
    return { id, name: str(body.name), description: str(body.description), allowed_tools: strs(body.allowedTools) };
  });

  const enabledById = new Map(list(config.tasks).map(dict).map((t) => [str(t.id) ?? '', t.enabled !== false]));
  const tasks: InventoryTask[] = list(result.tasks).map(dict).map((t) => {
    const id = str(t.id) ?? '';
    return { id, name: str(t.name), cron: str(t.cronExpression), timezone: str(t.timezone), enabled: enabledById.get(id) ?? t.enabled !== false };
  });
  // A task listed in config but with no body returned still counts.
  for (const [id, enabled] of enabledById) if (!tasks.some((t) => t.id === id)) tasks.push({ id, name: null, cron: null, timezone: null, enabled });

  const subAgents = list(dict(config.subAgents).agents).map(dict).map((a) => ({ agent_id: str(a.agentId) ?? '', use_when: str(a.useWhen) }));
  const cfg = dict(config.config);

  const writers = tools.filter((t) => t.writes);
  const unapproved = writers.filter((t) => !t.approval);
  const scheduled = tasks.filter((t) => t.enabled);
  let tier: string;
  if (writers.length === 0) tier = 'T0 read only';
  else if (unapproved.length === 0) tier = 'T1 writes, all behind approval';
  else if (scheduled.length === 0) tier = 'T2 writes on request';
  else tier = 'T3 scheduled and writes';
  const tierReason = `${tools.length} tools, ${writers.length} can write (${writers.filter((w) => w.writes_rule === 'server registry').length} by this server's registry, ${writers.filter((w) => w.writes_rule === 'name verb').length} by name), ${unapproved.length} of those without approval; ${scheduled.length} scheduled task${scheduled.length === 1 ? '' : 's'} enabled; ${subAgents.length} sub-agent${subAgents.length === 1 ? '' : 's'}.`;

  // What is kept of the raw result: everything but the long texts.
  const rawConfig: Dict = { ...config };
  delete rawConfig.instructions;
  const rawSkills: Dict = {};
  for (const [id, b] of Object.entries(skillBodies)) {
    const bd = dict(b);
    rawSkills[id] = { name: bd.name, description: bd.description, allowedTools: bd.allowedTools };
  }
  const raw: Dict = { agent, configHash: result.configHash ?? null, config: rawConfig, skills: rawSkills, tasks: result.tasks ?? [], instructions_chars: typeof config.instructions === 'string' ? config.instructions.length : null, instructions_sha256: typeof config.instructions === 'string' ? createHash('sha256').update(config.instructions).digest('hex') : null };

  return {
    agent_id: agentId,
    name,
    published: typeof agent.published === 'boolean' ? agent.published : null,
    active_version_id: str(agent.activeVersionId),
    config_hash: str(result.configHash),
    model: str(config.model),
    reasoning: str(cfg.reasoning),
    max_iterations: typeof cfg.maxIterations === 'number' ? cfg.maxIterations : null,
    memory: config.memory ? dict(config.memory) : null,
    tools,
    mcp_servers: mcpServers,
    skills,
    tasks,
    sub_agents: subAgents,
    credentials,
    autonomy_tier: tier,
    tier_reason: tierReason,
    owner: opts.owner ?? null,
    read_from: 'n8n get_agent (MCP)',
    read_at: opts.readAt ?? nowIso(),
    recorded_by: opts.recordedBy ?? null,
    raw,
  };
}

/** Upsert one row. Returns the row and whether anything changed. */
export async function record(result: Dict, opts: { owner?: string | null; recordedBy?: string | null }): Promise<{ row: InventoryRow; outcome: 'inserted' | 'updated' | 'unchanged' }> {
  const d = derive(result, opts);
  const at = nowIso();
  const before = await query<{ config_hash: string | null; autonomy_tier: string; tools: unknown; mcp_servers: unknown; tasks: unknown }>(
    `SELECT config_hash, autonomy_tier, tools, mcp_servers, tasks FROM engine_agent_inventory WHERE agent_id = $1`,
    [d.agent_id],
  );
  const prev = before.rows[0];
  const same =
    prev &&
    prev.config_hash === d.config_hash &&
    prev.autonomy_tier === d.autonomy_tier &&
    JSON.stringify(prev.tools) === JSON.stringify(d.tools) &&
    JSON.stringify(prev.mcp_servers) === JSON.stringify(d.mcp_servers) &&
    JSON.stringify(prev.tasks) === JSON.stringify(d.tasks);
  const r = await query<InventoryRow>(
    `INSERT INTO engine_agent_inventory (agent_id, name, published, active_version_id, config_hash, model, reasoning, max_iterations, memory, tools, mcp_servers, skills, tasks, sub_agents, credentials, autonomy_tier, tier_reason, owner, read_from, read_at, recorded_by, raw, first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22::jsonb, $20, $20)
     ON CONFLICT (agent_id) DO UPDATE SET
       name = EXCLUDED.name, published = EXCLUDED.published, active_version_id = EXCLUDED.active_version_id, config_hash = EXCLUDED.config_hash,
       model = EXCLUDED.model, reasoning = EXCLUDED.reasoning, max_iterations = EXCLUDED.max_iterations, memory = EXCLUDED.memory,
       tools = EXCLUDED.tools, mcp_servers = EXCLUDED.mcp_servers, skills = EXCLUDED.skills, tasks = EXCLUDED.tasks, sub_agents = EXCLUDED.sub_agents,
       credentials = EXCLUDED.credentials, autonomy_tier = EXCLUDED.autonomy_tier, tier_reason = EXCLUDED.tier_reason,
       owner = COALESCE(EXCLUDED.owner, engine_agent_inventory.owner), read_from = EXCLUDED.read_from, read_at = EXCLUDED.read_at,
       recorded_by = EXCLUDED.recorded_by, raw = EXCLUDED.raw, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      d.agent_id, d.name, d.published, d.active_version_id, d.config_hash, d.model, d.reasoning, d.max_iterations,
      d.memory ? JSON.stringify(d.memory) : null, JSON.stringify(d.tools), JSON.stringify(d.mcp_servers), JSON.stringify(d.skills), JSON.stringify(d.tasks),
      JSON.stringify(d.sub_agents), JSON.stringify(d.credentials), d.autonomy_tier, d.tier_reason, d.owner, d.read_from, at, d.recorded_by, JSON.stringify(d.raw),
    ],
  );
  return { row: r.rows[0], outcome: !prev ? 'inserted' : same ? 'unchanged' : 'updated' };
}

export interface InventoryView {
  agents: (Omit<InventoryRow, 'memory'> & {
    memory_enabled: boolean | null;
    write_tools: number;
    unapproved_write_tools: number;
    scheduled_tasks: number;
    tokens_in_url: number;
    stale: boolean;
    last_eval: { run: string; passed: number; cases: number } | null;
  })[];
  tiers: { tier: string; meaning: string }[];
  stale_after_days: number;
  note: string;
}

const TIERS: InventoryView['tiers'] = [
  { tier: 'T0 read only', meaning: 'No tool that can change anything.' },
  { tier: 'T1 writes, all behind approval', meaning: 'Every tool that writes waits for a human approval.' },
  { tier: 'T2 writes on request', meaning: 'Can write without approval, but only when a person or system asks it.' },
  { tier: 'T3 scheduled and writes', meaning: 'Runs on its own schedule and can write without approval.' },
];

/** Which eval cases belong to which agent, by the case id prefix the eval set uses. */
function casePrefix(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('north star')) return 'NS-';
  if (n.includes('research twin')) return 'RT-';
  if (n.includes('bays')) return 'BAYS-';
  return null;
}

export async function view(): Promise<InventoryView> {
  const rows = (await query<InventoryRow>(`SELECT * FROM engine_agent_inventory ORDER BY name`)).rows;
  // The latest finished eval run, the way the scorecard decides it.
  const run = await query<{ run: string | null }>(
    `WITH runs AS (
       SELECT fields->>'Run ID' AS run, count(*) AS n, max((fields->>'Run Size')::int) AS size, max(created_time) AS last, max(id) AS last_id
         FROM engine_eval_runs GROUP BY 1)
     SELECT run FROM runs
      WHERE CASE WHEN size IS NOT NULL THEN n >= size ELSE last::timestamptz < now() - interval '30 minutes' END
      ORDER BY last_id DESC LIMIT 1`,
  );
  const runId = run.rows[0]?.run ?? null;
  const perPrefix = new Map<string, { passed: number; cases: number }>();
  if (runId) {
    const r = await query<{ prefix: string; passed: string; cases: string }>(
      `WITH per_case AS (
         SELECT fields->>'Case ID' AS case_id, bool_and((fields->>'Passed') = 'true') AS ok
           FROM engine_eval_runs WHERE fields->>'Run ID' = $1 GROUP BY 1)
       SELECT substring(case_id FROM '^[A-Z]+-') AS prefix, count(*) FILTER (WHERE ok)::text AS passed, count(*)::text AS cases
         FROM per_case GROUP BY 1`,
      [runId],
    );
    for (const x of r.rows) if (x.prefix) perPrefix.set(x.prefix, { passed: Number(x.passed), cases: Number(x.cases) });
  }
  const cutoff = Date.now() - STALE_AFTER_DAYS * 86400_000;
  const agents = rows.map((r) => {
    const { memory, ...rest } = r;
    const prefix = casePrefix(r.name);
    const ev = prefix ? perPrefix.get(prefix) : undefined;
    return {
      ...rest,
      memory_enabled: memory && typeof memory.enabled === 'boolean' ? (memory.enabled as boolean) : null,
      write_tools: r.tools.filter((t) => t.writes).length,
      unapproved_write_tools: r.tools.filter((t) => t.writes && !t.approval).length,
      scheduled_tasks: r.tasks.filter((t) => t.enabled).length,
      tokens_in_url: r.mcp_servers.filter((m) => m.token_in === 'url path').length,
      stale: new Date(r.read_at).getTime() < cutoff,
      last_eval: ev && runId ? { run: runId, ...ev } : null,
    };
  });
  return {
    agents,
    tiers: TIERS,
    stale_after_days: STALE_AFTER_DAYS,
    note: rows.length
      ? `Each row is what n8n's get_agent returned, recorded through record_agent_inventory; the tier is derived from that config in code. A row older than ${STALE_AFTER_DAYS} days is marked stale. MCP tools are classed as writes from this server's own registry; node tools by a whole word in their name (${WRITE_NAME_VERBS.join(', ')}), unless the name opens with a read word or the tool's URL ends in /ask.`
      : 'No agent has been recorded yet. Record one with the MCP tool record_agent_inventory, handing it the n8n get_agent result.',
  };
}
