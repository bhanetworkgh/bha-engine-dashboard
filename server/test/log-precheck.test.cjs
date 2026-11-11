/**
 * The pre-check's completeness check (11 Nov 2026, logPrecheck.ts): Layer 0's prompt filled as the run fills it,
 * and Evaluate Layer 0 Gate's decision, ported. No database and no network. Run with:  npm run test:log-precheck
 *
 *   1. A full answer with tagged proof parks nothing.
 *   2. proof_type_ok false parks the log for proof_type (11 Nov: Destiny's log, row 46).
 *   3. A "proof type: verified" tag parks the log whatever Layer 0 said.
 *   4. A strong earlier-work match with no relog declaration parks the log for relog.
 *   5. An explicit "none this session" commercial is false and parks it.
 *   6. Layer 0's three expressions are filled, and an unknown one is refused.
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
const lp = require(path.join(DIST, 'server/src', 'logPrecheck.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const full = { mission_fit_present: true, error_fix_present_or_honest_none: true, next_step_present: true, commercial_present: true, proof_type_ok: true, continues_earlier_work: false, relog_declared: true };

assert.deepEqual(lp.layer0Missing({ output: full }, 'Proof type: test_forced. Proof type: live natural.', []).missing, []);
ok('a complete answer with good tags parks nothing');

assert.deepEqual(lp.layer0Missing({ ...full, proof_type_ok: false }, '', []).missing, ['proof_type']);
ok('proof_type_ok false parks for proof_type');

const r3 = lp.layer0Missing(full, 'Presence alerts. Proof type: verified on the rack.', []);
assert.deepEqual(r3.missing, ['proof_type']);
assert.equal(r3.bad_proof_tags.length, 1);
ok('a proof type tag that is not one of the two parks the log');

assert.deepEqual(lp.layer0Missing({ ...full, relog_declared: false }, '', [{ strength: 'strong', why: 'same recording' }]).missing, ['relog']);
assert.deepEqual(lp.layer0Missing({ ...full, relog_declared: false }, '', [{ strength: 'medium', why: 'same loop' }]).missing, []);
ok('a strong earlier match with no relog declaration parks; a medium one alone does not');

assert.deepEqual(lp.layer0Missing({ ...full, commercial_present: false }, '', []).missing, ['commercial']);
ok('no commercial angle parks for commercial');

const tpl = "=Source: {{ $('Loom Path').isExecuted ? 'L' : 'O' }}\n\nFull Transcript:\n{{ $('Extract Submission').item.json.fullTranscript }}\n\nEarlier:\n{{ (() => { const r = $('Check For Earlier Work · POST').first().json; })() }}";
const out = lp.resolveLayer0(tpl, 'THE LOG', 'Manual (typed submission)', lp.earlierLines([{ codex_entry_id: 'CODEX-1', session_description: 'desc', why: 'named in this log' }]));
assert.equal(out, 'Source: Manual (typed submission)\n\nFull Transcript:\nTHE LOG\n\nEarlier:\n- CODEX-1: desc (named in this log)');
assert.equal(lp.earlierLines([]), 'None found.');
assert.equal(lp.earlierLines(null), 'The check could not run.');
assert.throws(() => lp.resolveLayer0('={{ $json.other }}', 'x', 'y', 'z'), /does not know how to fill/);
ok('Layer 0 prompt filled as the run fills it; an unknown expression refused');

console.log(`\nlog-precheck: ${n} checks passed`);
