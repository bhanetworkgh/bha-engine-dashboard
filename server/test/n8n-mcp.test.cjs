/**
 * record_agent_inventory reading the agent from n8n itself (2026-10-11).
 *
 * No database and no network: `pg.js` and `publishGate.js` are replaced in the
 * require cache before the tool is loaded, and `fetch` is a stand-in for n8n's
 * MCP server. What is pinned:
 *
 *   - getAgent sends initialize first, then one tools/call for get_agent, with
 *     the token as a Bearer header, and reads a JSON answer and an SSE answer;
 *   - `agent_id: "bays"` records the agent with no config handed over, and the
 *     row says the server read it from n8n;
 *   - a changed active version starts the publish check, exactly as before;
 *   - `all` asks for the three engine agents plus any agent already held, and
 *     an agent n8n does not have is ok:false, not recorded, the rest recorded;
 *   - a refused token is `unauthorised`, said once, and nothing is recorded;
 *   - an answer about a different agent is `bad_answer` and nothing is recorded;
 *   - dry_run reads and derives and writes no inventory row;
 *   - agent and agent_id together are refused; a handed-over result still works;
 *   - with no token, nothing is asked and the answer names the variable.
 *
 * Run with:  npm run test:n8n-mcp
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.N8N_MCP_URL = 'https://n8n.test/mcp-server/http';
process.env.N8N_MCP_TOKEN = 'tok-test';
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

/* ---- the database, stood in ---- */
const audits = [];
const inventory = new Map();
const inventoryInserts = [];
async function query(sql, params = []) {
  if (/INSERT INTO engine_mcp_writes/.test(sql)) {
    audits.push({ id: audits.length + 1, args: JSON.parse(params[1]), dry_run: params[5], outcome: 'pending' });
    return { rows: [{ id: String(audits.length) }], rowCount: 1 };
  }
  if (/UPDATE engine_mcp_writes/.test(sql)) {
    const a = audits[Number(params[0]) - 1];
    a.outcome = params[1];
    a.detail = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (/SELECT agent_id FROM engine_agent_inventory ORDER BY/.test(sql)) return { rows: [...inventory.keys()].sort().map((agent_id) => ({ agent_id })), rowCount: inventory.size };
  if (/FROM engine_agent_inventory WHERE agent_id = \$1/.test(sql)) {
    const r = inventory.get(params[0]);
    return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
  }
  if (/INSERT INTO engine_agent_inventory/.test(sql)) {
    const row = {
      agent_id: params[0], name: params[1], published: params[2], active_version_id: params[3], config_hash: params[4], model: params[5],
      tools: JSON.parse(params[9]), mcp_servers: JSON.parse(params[10]), skills: JSON.parse(params[11]), tasks: JSON.parse(params[12]),
      autonomy_tier: params[15], tier_reason: params[16], owner: params[17], read_from: params[18], read_at: params[19], recorded_by: params[20], raw: JSON.parse(params[21]),
    };
    inventory.set(row.agent_id, row);
    inventoryInserts.push(row.agent_id);
    return { rows: [row], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
const stub = (rel, exports) => {
  const p = require.resolve(path.join(DIST, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('server/src/pg.js', { query, withTransaction: async (fn) => fn({ query }), afterCommit: (_db, fn) => fn(), getPool: () => ({ query }), DATABASE_URL: 'stub', closePool: async () => {}, assertDatabase: async () => ({}), databaseIdentity: () => null });
const versionChanges = [];
stub('server/src/publishGate.js', { onVersionChange: async (c) => { versionChanges.push(c); } });

/* ---- n8n's MCP server, stood in ---- */
const BAYS = 'Nw5igXu4WWrjUMWB', NS = '8NQRXadH0OrKe5XV', RT = 'dDtsExaaXhlFd2dv';
const agentAnswer = (id, version) => ({
  ok: true,
  agent: { id, name: `${id} (Agent)`, published: true, versionId: version, activeVersionId: version },
  configHash: `hash-${version}`,
  config: {
    name: `${id} (Agent)`, model: 'openrouter/x', instructions: 'You are a test agent.\n'.repeat(30),
    tools: [
      { type: 'node', name: 'Search_Codex', node: { nodeType: 'n8n-nodes-base.httpRequestTool', nodeParameters: { url: 'https://rag.example/api/v1/ask' } } },
      { type: 'workflow', workflowId: 'wf1', workflow: 'Slack Send', name: 'Slack_Send_Message' },
    ],
    mcpServers: [], skills: [{ id: 'skill_a' }], tasks: [{ id: 'task_a', enabled: true }],
  },
  skills: { skill_a: { name: 'Docs', description: 'd', allowedTools: [], instructions: 'long '.repeat(200) } },
  tasks: [{ id: 'task_a', name: 'Digest', cronExpression: '0 9 * * *', timezone: 'America/New_York', enabled: true, objective: 'long '.repeat(200) }],
});
const n8n = { mode: 'json', status: 200, versions: { [BAYS]: 'v-1', [NS]: 'v-1', [RT]: 'v-1' }, answerAs: null };
const calls = [];
/* A failed assertion thrown inside fetch would be caught by the client and read as "unreachable", so what the stand-in objects to is collected and checked at the end. */
const violations = [];
const expect = (cond, what) => { if (!cond) violations.push(what); };
globalThis.fetch = async (url, init = {}) => {
  expect(String(url) === 'https://n8n.test/mcp-server/http', `called ${url}`);
  expect(init.method === 'POST', `method ${init.method}`);
  expect(init.headers.authorization === 'Bearer tok-test', 'the token did not travel as a Bearer header');
  expect(init.redirect === 'error', 'redirects are not refused');
  const msg = JSON.parse(init.body);
  if (msg.method !== 'initialize') {
    expect(init.headers['mcp-protocol-version'] === '2025-03-26', `protocol header ${init.headers['mcp-protocol-version']} is not the version the server agreed to`);
    if (n8n.mode === 'json') expect(init.headers['mcp-session-id'] === 'sess-1', 'the session id was not sent back');
  }
  calls.push(msg.method + (msg.params && msg.params.name ? `:${msg.params.name}` : ''));
  if (n8n.status !== 200) return new Response('Unauthorized', { status: n8n.status });
  const send = (payload) =>
    n8n.mode === 'sse'
      ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'n8n', version: '1' } } });
  if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
  expect(msg.method === 'tools/call', `unexpected method ${msg.method}`);
  expect(msg.params.name === 'get_agent', `called tool ${msg.params.name}: get_agent is the only tool this server may call on n8n`);
  const id = msg.params.arguments.agentId;
  const version = Object.hasOwn(n8n.versions, id) ? n8n.versions[id] : null;
  if (!version) return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'not_found', message: 'Agent not found.' }) }] } });
  return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(agentAnswer(n8n.answerAs || id, version)) }] } });
};

const n8nMcp = require(path.join(DIST, 'server/src/n8nMcp.js'));
const { recordAgentInventory, KNOWN_AGENTS } = require(path.join(DIST, 'server/src/mcp/inventoryTools.js'));
const deps = { access: 'write', startedAt: new Date().toISOString(), dispatch: async () => ({ status: 404, body: null }), agent: null };
const run = (args) => recordAgentInventory.handler(args, deps);

(async () => {
  assert.deepEqual(KNOWN_AGENTS, { bays: BAYS, north_star: NS, research_twin: RT });

  // 1. The client itself, JSON and SSE.
  let a = await n8nMcp.getAgent(BAYS);
  assert.equal(a.agent.id, BAYS);
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/call:get_agent']);
  ok('getAgent initializes, then makes one get_agent call');
  n8n.mode = 'sse';
  a = await n8nMcp.getAgent(NS);
  assert.equal(a.config.tools.length, 2);
  n8n.mode = 'json';
  ok('an answer sent as an event stream is read the same way');
  await assert.rejects(n8nMcp.getAgent('not an id!'), (e) => e.reason === 'not_found');
  ok('something that is not an agent id is refused before n8n is asked');

  // 2. The tool: one agent by name, nothing handed over.
  let r = await run({ agent_id: 'bays', requester_user_id: 'U0AEW3TBYH1' });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'inserted');
  assert.equal(r.read_from, 'n8n MCP');
  assert.equal(r.row.agent_id, BAYS);
  assert.equal(r.row.active_version_id, 'v-1');
  assert.match(r.row.recorded_by, /read from n8n by the server/);
  assert.equal('raw' in r.row, false);
  assert.equal(inventory.get(BAYS).raw.config.instructions, undefined, 'the instruction text is not stored');
  assert.equal(audits.at(-1).outcome, 'applied');
  assert.equal(audits.at(-1).args.read_from, 'n8n MCP');
  assert.equal(versionChanges.length, 0, 'a first record is not a version change');
  ok('agent_id "bays" records the agent with nothing handed over, and the row says the server read it');

  // 3. A new active version starts the publish check.
  n8n.versions[BAYS] = 'v-2';
  r = await run({ agent_id: BAYS });
  assert.equal(r.outcome, 'updated');
  assert.deepEqual(versionChanges.map((c) => [c.agent_id, c.from, c.to]), [[BAYS, 'v-1', 'v-2']]);
  r = await run({ agent_id: 'Bays' });
  assert.equal(r.outcome, 'unchanged');
  assert.equal(versionChanges.length, 1);
  ok('a changed active version starts the publish check once; the same config again is unchanged');

  // 4. dry_run writes no inventory row.
  const before = inventoryInserts.length;
  n8n.versions[BAYS] = 'v-3';
  r = await run({ agent_id: 'bays', dry_run: true });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.row.active_version_id, 'v-3');
  assert.equal(inventoryInserts.length, before);
  assert.equal(inventory.get(BAYS).active_version_id, 'v-2');
  assert.equal(audits.at(-1).outcome, 'dry_run');
  n8n.versions[BAYS] = 'v-2';
  ok('dry_run reads the live agent and derives the row without writing it');

  // 5. all: the three engine agents plus anything already held; one n8n does not have.
  inventory.set('GONEAGENT0001', { agent_id: 'GONEAGENT0001', name: 'Gone', active_version_id: 'v-9', config_hash: 'h', autonomy_tier: 'T0', tools: [], mcp_servers: [], tasks: [] });
  const heldBefore = JSON.stringify(inventory.get('GONEAGENT0001'));
  r = await run({ agent_id: 'all' });
  assert.equal(r.ok, false);
  assert.equal(r.asked_for, 4);
  assert.equal(r.recorded, 3);
  assert.equal(r.failed, 1);
  const gone = r.agents.find((x) => x.agent_id === 'GONEAGENT0001');
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'not_found');
  assert.equal(gone.recorded, false);
  assert.equal(JSON.stringify(inventory.get('GONEAGENT0001')), heldBefore, 'the held row is left exactly as it was');
  assert.deepEqual(r.agents.filter((x) => x.ok).map((x) => x.agent_id).sort(), [NS, BAYS, RT].sort());
  assert.ok(r.agents.every((x) => !('row' in x)), 'all answers one short line per agent');
  inventory.delete('GONEAGENT0001');
  ok('"all" reads the three engine agents and any agent already held; one n8n does not have is not recorded');

  // 6. A refused token: said once, nothing recorded.
  n8n.status = 401;
  const auditCount = audits.length, insertCount = inventoryInserts.length;
  r = await run({ agent_id: 'all' });
  assert.equal(r.ok, false);
  assert.equal(r.agents.length, 1, 'it stops at the first refusal');
  assert.equal(r.agents[0].reason, 'unauthorised');
  assert.match(r.agents[0].message, /N8N_MCP_TOKEN/);
  assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(audits), /tok-test/, 'the token is in no answer and no audit row');
  // The same refusal for one of the three engine agents leaves its held row as it was.
  const baysBefore = JSON.stringify(inventory.get(BAYS));
  r = await run({ agent_id: 'bays' });
  assert.equal(r.reason, 'unauthorised');
  assert.equal(JSON.stringify(inventory.get(BAYS)), baysBefore);
  assert.equal(audits.length, auditCount + 2, 'one refused line for the stopped "all", one for the single agent');
  assert.equal(audits.at(-2).outcome, 'refused');
  assert.equal(audits.at(-1).outcome, 'refused');
  assert.equal(inventoryInserts.length, insertCount);
  n8n.status = 200;
  ok('a refused token is unauthorised, named once, audited as refused, and nothing is recorded');

  // 7. An answer about a different agent is never recorded.
  n8n.answerAs = NS;
  r = await run({ agent_id: 'research_twin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_answer');
  assert.equal(inventoryInserts.length, insertCount);
  n8n.answerAs = null;
  ok('an answer about a different agent is bad_answer and nothing is recorded');

  // 8. Arguments.
  r = await run({ agent_id: 'bays', agent: agentAnswer(BAYS, 'v-2') });
  assert.equal(r.reason, 'bad_argument');
  assert.equal(audits.at(-1).outcome, 'refused');
  assert.equal(r.audit_id, audits.length, 'the refusal is on the audit');
  const ownerInserts = inventoryInserts.length;
  r = await run({ agent_id: 'all', owner: 'Somebody' });
  assert.equal(r.reason, 'bad_argument');
  assert.match(r.message, /owner/);
  assert.equal(inventoryInserts.length, ownerInserts, 'no agent was re-owned');
  r = await run({ agent_id: 'constructor' });
  assert.equal(r.ok, false);
  assert.equal(r.agent_id, 'constructor');
  r = await run({});
  assert.equal(r.reason, 'bad_argument');
  const fetchesBefore = calls.length;
  r = await run({ agent: agentAnswer('HANDEDOVER001', 'v-1') });
  assert.equal(r.ok, true);
  assert.equal(r.read_from, 'handed over');
  assert.equal(calls.length, fetchesBefore, 'a handed-over result asks n8n nothing');
  ok('agent with agent_id, and owner with all, are refused and audited; a handed-over get_agent result still records');

  // 9. No token: nothing is asked, and the variable is named.
  const out = execFileSync(process.execPath, ['-e', `
    globalThis.fetch = async () => { console.log('FETCHED'); return new Response('{}'); };
    const m = require(${JSON.stringify(path.join(DIST, 'server/src/n8nMcp.js'))});
    m.getAgent('Nw5igXu4WWrjUMWB').then(() => console.log('RESOLVED'), (e) => console.log(m.n8nMcpConfigured(), e.reason, e.message));
  `], { env: { ...process.env, N8N_MCP_TOKEN: '' }, encoding: 'utf8' });
  assert.match(out, /^false not_configured .*N8N_MCP_TOKEN is not set/);
  assert.doesNotMatch(out, /FETCHED|RESOLVED/);
  ok('with no token nothing is asked, and the answer names N8N_MCP_TOKEN');

  assert.deepEqual(violations, [], 'the n8n stand-in objected to a request');
  ok('every request went to the one address, as a POST with the Bearer token, redirects refused, the agreed protocol version and the session id');

  console.log(`\n${passed} checks passed.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
