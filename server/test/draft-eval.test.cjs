/**
 * The draft eval's pure parts (13 Oct 2026): the runner's checks, ported, the
 * newest-row-per-case rule and the context block. No database, no network:
 * only the functions are called, never start() or run().
 */
const assert = require('node:assert');
const d = require('../../server-dist/server/src/draftEval.js');

let n = 0;
const ok = (cond, what) => { assert(cond, what); n++; console.log(`ok ${n} - ${what}`); };

ok(d.score('Kavin owns it', null, '{"contains":["Kavin"]}').passed, 'contains passes on a matching answer');
const none = d.score('', 'the draft ended with status "awaiting_approval"', '{}');
ok(!none.passed && none.results[0].detail.includes('awaiting_approval'), 'no answer fails "answered" and names the status');
ok(d.score("I'm not opening a Decision Watch here", null, JSON.stringify({ not_contains: ["\\bi (have |'ve )?(just )?(opened|set up|started) a decision watch"] })).passed, 'a refusal in words does not trip the revised BAYS-DW-03 check');
ok(d.score('See [S1].\n\nSources\n[S1] x', null, '{"cites":true}').passed, 'cites passes when every marker is listed');
ok(!d.score('See [S1] [S2].\n\nSources\n[S1] x', null, '{"cites":true}').passed, 'cites fails on a marker missing from Sources');
ok(!d.score('no sections', null, '{"two_sections":true}').passed, 'two_sections fails without both headings');

const rows = [
  { id: 1, case_id: 'A', agent: 'bays', question: 'old', checks: '{}', repeats: 1, active: true },
  { id: 2, case_id: 'A', agent: 'bays', question: 'new', checks: '{}', repeats: 3, active: true },
  { id: 3, case_id: 'B', agent: 'bays', question: 'off', checks: '{}', repeats: 1, active: false },
  { id: 4, case_id: 'C', agent: 'north_star', question: 'other agent', checks: '{}', repeats: 1, active: true },
];
const cases = d.latestCases(rows, 'bays');
ok(cases.length === 1 && cases[0].question === 'new' && cases[0].repeats === 3, 'newest row per case wins, inactive and other agents are left out');
ok(d.contextFor('bays', 'ASK-1', 'Q?').endsWith('Question:\nQ?'), "Bays' context block ends with the question, as the runner's does");
ok(d.contextFor('research_twin', 'ASK-1', 'Q?').startsWith('source: eval, ask_id: ASK-1'), "Research Twin's context block is the runner's");
ok(d.agentKeyFor('Nw5igXu4WWrjUMWB') === 'bays' && d.agentKeyFor('nobody') === null, 'agent ids and keys resolve, unknowns do not');

// The fallback to the Anthropic backup (25 Oct 2026): it only covers a main draft the backup matches.
const skill = (name, instructions) => ({ name, description: 'd', instructions, allowedTools: ['t'] });
const main = {
  config: { name: 'Bays (Agent)', model: 'openrouter/anthropic/claude-sonnet-5', credential: 'A', instructions: 'be good', tools: [{ name: 'x' }], mcpServers: [{ name: 'BHA', url: 'u', toolPermissions: { tools: { a: 'always_allow' } } }], tasks: [{ id: 't1' }], memory: { enabled: true }, config: { maxIterations: 60 } },
  skills: { skill_1: skill('Open loops', 'one'), skill_2: skill('Parked logs', 'two') },
  customTools: [],
};
const backup = JSON.parse(JSON.stringify(main));
backup.config.name = 'Bays (Anthropic backup)'; backup.config.model = 'anthropic/claude-sonnet-5'; backup.config.credential = 'B'; backup.config.tasks = null;
backup.config.mcpServers = [{ toolPermissions: { tools: { a: 'always_allow' } }, url: 'u', name: 'BHA' }];
backup.skills = { skill_9: skill('Parked logs', 'two'), skill_8: skill('Open loops', 'one') };
ok(d.behaviourDiff(main, backup).length === 0, 'name, model route, credential, tasks, skill ids and key order do not count as a difference');
const drifted = JSON.parse(JSON.stringify(backup));
drifted.skills.skill_9.instructions = 'old wording';
delete drifted.config.mcpServers[0].toolPermissions.tools.a;
drifted.config.instructions = 'be good, older';
const diff = d.behaviourDiff(main, drifted);
ok(diff.includes('its instructions') && diff.includes('its MCP servers or their tool permissions') && diff.includes('skill "Parked logs" differs'), 'a drifted backup is named: instructions, tool permissions, one skill');
const missing = JSON.parse(JSON.stringify(backup)); delete missing.skills.skill_8;
ok(d.behaviourDiff(main, missing).includes('skill "Open loops" is missing on the backup'), 'a skill the backup lacks is named');
const stand = JSON.parse(JSON.stringify(backup));
main.config.tools = [{ name: 'GitHub', type: 'node', node: { nodeType: 'n8n-nodes-base.githubTool' } }, { name: 'x' }];
stand.config.tools = [{ name: 'x' }, { name: 'GitHub', type: 'workflow', workflowId: 'FB4i1s8gebDDQM45' }];
ok(d.behaviourDiff(main, stand).length === 0, "the backup's GitHub workflow stands in for the main GitHub node, and tool order does not count");
stand.config.tools[1].workflowId = 'SOMETHING_ELSE';
ok(d.behaviourDiff(main, stand).includes('its tools'), 'a GitHub tool pointing anywhere else is a difference');
ok(d.BACKUP_OF.bays === 'PjKGbV4ZnH4YOfri' && d.BACKUP_OF.north_star && d.BACKUP_OF.research_twin, 'every main agent has its backup');
console.log(`\n${n} checks passed`);
