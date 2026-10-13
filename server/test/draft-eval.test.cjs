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
console.log(`\n${n} checks passed`);
