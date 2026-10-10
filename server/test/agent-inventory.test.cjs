/**
 * The slim agent inventory input (2026-10-10). No database, no network.
 *
 *   - the row derived from a slimmed get_agent result is the row derived from
 *     the whole one, field for field;
 *   - the instruction text's length and sha256 survive the slimming;
 *   - a slim result with a malformed digest stores no digest, never a wrong one;
 *   - AGENT_FILE=<get_agent.json> runs the same comparison on a real agent.
 *
 * Run with:  npm run test:agent-inventory
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { derive } = require(path.join(DIST, 'server/src/agentInventory.js'));
const { slim } = require('../../scripts/agent-inventory-slim.cjs');
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

const INSTRUCTIONS = 'You are a test agent.\n'.repeat(40);
const FIXTURE = {
  agent: { id: 'AGENTTEST0001', name: 'Test (Agent)', published: true, activeVersionId: 'v-1' },
  configHash: 'abc',
  config: {
    name: 'Test (Agent)', model: 'openrouter/x', instructions: INSTRUCTIONS, credential: 'cred-model', memory: { enabled: true }, config: { reasoning: 'low', maxIterations: 20 },
    tools: [
      { type: 'node', name: 'Search_Codex', description: 'long '.repeat(200), node: { nodeType: 'n8n-nodes-base.httpRequestTool', nodeParameters: { url: 'https://rag.example/api/v1/ask', jsonBody: 'x'.repeat(900) }, credentials: { httpHeaderAuth: { id: 'c1', name: 'BHARAG - Codex' } } } },
      { type: 'node', name: 'Edit_Doc_Text', description: 'long '.repeat(50), node: { nodeType: 'n8n-nodes-base.googleDocsTool', nodeParameters: { operation: 'update' }, credentials: { googleDocsOAuth2Api: { id: 'c2', name: 'Docs' } } } },
      { type: 'workflow', workflowId: 'wf1', workflow: 'Bays — Slack Send', name: 'Slack_Send_Message', description: 'd', inputs: { text: { mode: 'ai' } } },
      { type: 'node', name: 'Delete_Thing', requireApproval: true, node: { nodeType: 'x', nodeParameters: {} } },
    ],
    mcpServers: [{ name: 'BHA Dashboard', url: 'https://dashboard.bhanetwork.org/mcp/agent', authentication: 'bearerAuth', credential: 'c3', toolFilter: { mode: 'allow', tools: ['find_records', 'share_doc', 'update_record'] } }],
    skills: [{ id: 'skill_a' }],
    tasks: [{ id: 'task_a', enabled: true }],
  },
  skills: { skill_a: { name: 'Docs', description: 'd', allowedTools: ['share_doc'], instructions: 'very long '.repeat(500) } },
  tasks: [{ id: 'task_a', name: 'Digest', cronExpression: '0 9 * * *', timezone: 'America/New_York', enabled: true, objective: 'long '.repeat(900) }],
};

function compare(whole, label) {
  const s = slim(whole);
  const a = derive(whole, { readAt: '2026-10-10T00:00:00.000Z' });
  const b = derive(JSON.parse(JSON.stringify(s)), { readAt: '2026-10-10T00:00:00.000Z' });
  const { raw: ra, ...rowA } = a;
  const { raw: rb, ...rowB } = b;
  assert.deepEqual(rowB, rowA);
  ok(`${label}: the slim result derives the same row as the whole one (${a.tools.length} tools, ${a.tasks.length} tasks, ${a.autonomy_tier})`);
  const text = whole.config.instructions;
  assert.equal(rb.instructions_chars, text.length);
  assert.equal(rb.instructions_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(rb.instructions_sha256, ra.instructions_sha256);
  assert.equal(rb.slim, true);
  assert.equal(ra.slim, false);
  assert.equal('instructions' in rb.config, false);
  ok(`${label}: the instruction text's length and sha256 survive, and raw says which form was stored`);
  const ratio = JSON.stringify(s).length / JSON.stringify(whole).length;
  assert.ok(ratio < 0.6, `slim is ${Math.round(ratio * 100)}% of the whole`);
  ok(`${label}: slim is ${JSON.stringify(s).length} characters against ${JSON.stringify(whole).length}`);
}

compare(FIXTURE, 'fixture');

const bad = slim(FIXTURE);
bad.config.instructions_sha256 = 'not-a-hash';
const rb = derive(bad, {}).raw;
assert.equal(rb.instructions_sha256, null);
assert.equal(rb.slim, false);
ok('a malformed digest is stored as no digest');

if (process.env.AGENT_FILE) compare(JSON.parse(fs.readFileSync(process.env.AGENT_FILE, 'utf8')), 'real agent');

console.log(`\n${passed} checks passed.`);
