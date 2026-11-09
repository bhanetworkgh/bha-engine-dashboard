/**
 * LogStream pay suggestions (9 Nov 2026, Jason's DM 1794237173.152349): what the engine suggests from
 * the review's work parts. No database and no network. Run with:  npm run test:pay-suggest
 *
 *   1. Everything merged, hooked up and with a real event: full.
 *   2. Merged and hooked up, no live event yet: half now, half held until the first event.
 *   3. Local only (not merged, or not hooked up): none now, all held, LOCAL_ONLY, with what is missing.
 *   4. A silent failure holds that part and is a red flag on the card.
 *   5. A re-log: the old part is docked, never held; only the stated delta is credited.
 *   6. A re-log with no delta stated: nothing is counted as new.
 *   7. Mixed work (Jason's worked example): the live delta credited, the Phase A part held.
 *   8. Strong earlier-work matches on a log not marked as a re-log are flagged, never silently ignored.
 *   9. No work parts and not a re-log: no suggestion.
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
const p = require(path.join(DIST, 'server/src', 'paySuggest.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const live = { what: 'live thing', new_this_session: true, merged: true, integrated: true, live_event: true, silent_failure: '', evidence: 'PR 1, event 2' };
const parts = (...a) => ({ 'Log Class': 'fresh_build', 'Work Parts': JSON.stringify(a) });

let s = p.suggest(parts(live));
assert.equal(s.pay_recommendation, 'full'); assert.equal(s.credited_share, 1); assert.equal(s.reason_tag, null); ok('all live is a full day');

s = p.suggest(parts({ ...live, live_event: false }));
assert.equal(s.pay_recommendation, 'half'); assert.equal(s.held_share, 0.5); assert.equal(s.rest, 'hold'); assert.equal(s.reason_tag, 'PARTIAL_SCOPE');
assert.match(s.release_condition, /one real event/); ok('merged with no live event is half now, half held');

s = p.suggest(parts({ ...live, merged: false, live_event: false }));
assert.equal(s.pay_recommendation, 'none'); assert.equal(s.held_share, 1); assert.equal(s.reason_tag, 'LOCAL_ONLY');
assert.match(s.release_condition, /merged in a PR with CI/); ok('local only is none now, all held, LOCAL_ONLY');

s = p.suggest(parts({ ...live, silent_failure: 'missing workspace key does nothing' }));
assert.equal(s.credited_share, 0); assert.equal(s.held_share, 1);
assert.match(s.flags[0], /^Silent failure/); assert.match(s.release_condition, /writes a record/); ok('a silent failure holds the part and is flagged first');

s = p.suggest({ 'Log Class': 'RELOG_OLD_WORK', 'Relog Of': 'CODEX-20261107-x', 'Relog Delta': 'the new reads', 'Work Parts': JSON.stringify([{ ...live, what: 'old build', new_this_session: false }, { ...live, what: 'new reads' }]) });
assert.equal(s.credited_share, 0.5); assert.equal(s.docked_share, 0.5); assert.equal(s.held_share, 0); assert.equal(s.rest, 'dock'); assert.equal(s.reason_tag, 'RELOG_OLD_WORK');
assert.match(s.reason_note, /Docked as already paid \(CODEX-20261107-x\)/); ok('a re-log docks the old part and credits only the delta');

s = p.suggest({ 'Log Class': 'RELOG_OLD_WORK', 'Work Parts': JSON.stringify([live]) });
assert.equal(s.credited_share, 0); assert.equal(s.docked_share, 1); assert.ok(s.flags.some((f) => /does not say what is new/.test(f))); ok('a re-log with no delta counts nothing as new');

s = p.suggest({ 'Log Class': 'RELOG_OLD_WORK', 'Relog Of': '459', 'Relog Delta': 'Front Door reads in PR 60; ledger writer',
  'Work Parts': JSON.stringify([
    { ...live, what: 'Day 3 build re-narrated', new_this_session: false },
    { ...live, what: '5 live Front Door reads (PR 60)' },
    { ...live, what: 'builderRun ledger writer', merged: false, integrated: false, live_event: false, silent_failure: 'missing workspace key path does nothing' },
  ]) });
assert.equal(s.pay_recommendation, 'custom_fraction'); assert.equal(s.credited_share, 0.35); assert.equal(s.docked_share, 0.35); assert.equal(s.held_share, 0.3);
assert.match(s.release_condition, /builderRun ledger writer: merged in a PR with CI/); assert.match(s.flags[0], /Silent failure: builderRun/);
ok('Jason\'s worked example: delta credited, writer held, old work docked, silent path flagged');

s = p.suggest(parts(live), { matches: [{ submission_id: 'X', codex_entry_id: 'CODEX-1', why: 'the same recording', strength: 'strong' }], looks_like_relog: true });
assert.ok(s.flags.some((f) => /earlier approved work this may repeat: CODEX-1 \(the same recording\)/.test(f))); ok('a strong earlier-work match on a fresh log is flagged');

s = p.suggest(parts(live), { matches: [], looks_like_relog: false, unread: 'db down' });
assert.ok(s.flags.some((f) => /could not run \(db down\)/.test(f))); ok('a check that could not run is said, never read as no match');

s = p.suggest({ 'Log Class': 'RELOG_OLD_WORK', 'Relog Of': 'CODEX-a', 'Relog Delta': 'all new reads', 'Work Parts': JSON.stringify([live]) });
assert.equal(s.pay_recommendation, 'full'); assert.match(s.reason_note, /Re-log of CODEX-a; new this session: all new reads/); ok('a fully live re-log is full and still says what the credit is for');
assert.equal(p.suggest({ 'Log Class': 'fresh_build', 'Work Parts': '[]' }), null); ok('no work parts and not a re-log: no suggestion');
assert.deepEqual(p.parseParts('not json'), []); assert.equal(p.parseParts([{ what: 'a' }])[0].new_this_session, true); ok('work parts parse from a JSON string or an array');

console.log(`pay-suggest: ${n} passed`);
