/**
 * The LogStream end-to-end judge (10 Nov 2026): what each case must show on the Codex row, the parked row and
 * Jason's card. No database and no network. Run with:  npm run test:logstream-e2e
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const e = require(path.join(DIST, 'server/src', 'logstreamE2e.js'));
const ps = require(path.join(DIST, 'server/src', 'paySuggest.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const live = { what: 'x', new_this_session: true, merged: true, integrated: true, live_event: true, silent_failure: '', evidence: 'PR 1' };
const row = (f) => { const sug = ps.suggest(f); return { id: '9', fields: { 'Submission ID': 'S1', ...f, 'Pay Suggestion': JSON.stringify(sug) } }; };
const btn = (fields) => { const s = JSON.parse(fields['Pay Suggestion']); return 'S1|destiny||' + JSON.stringify({ r: s.pay_recommendation, s: s.rest, c: s.credited_share, h: s.held_share, t: s.reason_tag || '', n: '', k: '', l: '' }); };
const card = (fields, extra = '') => ({ blocks: [{ type: 'section', text: { text: '*Suggested pay* ' + extra } }], button: btn(fields) });

assert.equal(e.sessionUrl('r1', 'local_only'), 'https://otter.ai/u/TEST-LOGSTREAM-r1-local_only'); ok('every TEST log carries the run prefix cleanup matches on');
assert.equal(e.cleanRun('a b-c/1'), 'abc1'); ok('a run label keeps letters and digits only');
for (const c of e.CASES) { const l = e.caseLog(c, 'r1'); assert.match(l.description, /^TEST/); assert.match(l.transcript, /proof type: (test_forced|live_natural)/); }
ok('every case log says TEST and tags its proof type');
assert.ok(e.caseLog('relog_undeclared', 'r1').transcript.includes(e.EARLIER_LOG)); ok('the re-log case names the earlier log, so the earlier-work check finds it');
assert.deepEqual(e.buttonSuggestion('S|u|relog|{"r":"half","c":0.5}'), { r: 'half', c: 0.5 }); assert.equal(e.buttonSuggestion('S|u|'), null); ok('the button suggestion is read as the pop-up reads it');

let f = row({ 'Log Class': 'fresh_build', 'Work Parts': JSON.stringify([{ ...live, merged: false, integrated: false, live_event: false, proof_level: 0, evidence: 'ran it by hand on my laptop' }]) }).fields;
let v = e.judge('local_only', 'submit', { codex: { id: '9', fields: f }, layer0: null, card: card(f) });
assert.equal(v.pass, true, JSON.stringify(v.checks)); ok('local only passes when held whole as INSUFFICIENT_PROOF (level 0) and the button matches');
v = e.judge('local_only', 'submit', { codex: { id: '9', fields: f }, layer0: null, card: { blocks: [], button: 'S1|destiny||{"r":"full","c":1,"h":0}' } });
assert.equal(v.pass, false); assert.ok(v.checks.some((c) => !c.pass && /pop-up/.test(c.name))); ok('a button that would open on full fails');

f = row({ 'Log Class': 'fresh_build', 'Work Parts': JSON.stringify([{ ...live, silent_failure: 'missing key writes nothing' }]) }).fields;
v = e.judge('silent_failure', 'submit', { codex: { id: '9', fields: f }, layer0: null, card: card(f, ':red_circle: Silent failure: x') });
assert.equal(v.pass, true, JSON.stringify(v.checks)); ok('a silent failure passes when flagged first, held and on the card');
v = e.judge('silent_failure', 'submit', { codex: { id: '9', fields: f }, layer0: null, card: card(f) });
assert.equal(v.pass, false); ok('a silent failure missing from the card fails');

v = e.judge('relog_undeclared', 'submit', { codex: { id: '9', fields: f }, layer0: { id: '3', fields: { Status: 'pending_builder_input', 'Missing Fields': '["relog"]' } }, card: { blocks: [{ text: 'In review, incomplete' }], button: null } });
assert.equal(v.pass, true, JSON.stringify(v.checks)); ok('an undeclared re-log passes when parked for the earlier-work question');
v = e.judge('relog_undeclared', 'submit', { codex: { id: '9', fields: f }, layer0: { id: '3', fields: { Status: 'pending_builder_input', 'Missing Fields': '["commercial"]' } }, card: null });
assert.equal(v.pass, false); ok('parked for some other reason fails');

f = row({ 'Log Class': 'RELOG_OLD_WORK', 'Relog Of': e.EARLIER_LOG, 'Relog Delta': 'the new read-back check', 'Work Parts': JSON.stringify([{ ...live, new_this_session: false }, live]) }).fields;
v = e.judge('relog_undeclared', 'answer', { codex: { id: '9', fields: f }, layer0: { id: '3', fields: { Status: 'completed', 'Relog Answer': 'RELOG_OLD_WORK. Earlier log: x.' } }, card: card(f, 'Complete, ready to approve') });
assert.equal(v.pass, true, JSON.stringify(v.checks)); ok('after the answer: re-log, old work docked, delta credited, card complete');
f = row({ 'Log Class': 'fresh_build', 'Work Parts': JSON.stringify([live]) }).fields;
v = e.judge('relog_undeclared', 'answer', { codex: { id: '9', fields: f }, layer0: { id: '3', fields: { Status: 'completed', 'Relog Answer': 'RELOG_OLD_WORK' } }, card: card(f, 'Complete.') });
assert.equal(v.pass, false); ok('a re-log the review paid in full fails');
v = e.judge('local_only', 'submit', { codex: null, layer0: null, card: null });
assert.equal(v.pass, false); ok('no Codex row fails, never passes on nothing');

console.log(`logstream-e2e: ${n} passed`);
