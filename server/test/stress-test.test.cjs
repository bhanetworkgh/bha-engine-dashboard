/**
 * The engine half of the vFarm stress test (10 Nov 2026, LOOP-1794168643405-SK22). Pure: no
 * database and no network. Run with:  npm run test:stress-test
 *
 *   1. on_time: a clean window passes; a gap over 600 s, a stale newest snapshot, slow arrival
 *      and a late reading each fail and are named; no snapshot is not_yet_possible.
 *   2. checks 2 to 4 take UN9D's own conditions, so a LIVE device on old data fails
 *      nothing_old_live and an overlapping incident fails one_alert.
 *   3. the run passes only when all four checks pass.
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
const st = require(path.join(DIST, 'server/src', 'stressTest.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const clean = { window_min: 60, snapshots: 20, gaps_s: Array(19).fill(180), last_snapshot_age_s: 40, transit_p95_s: 20, transit_max_s: 23, readings: 160, reading_devices: 6, reading_lag_p95_s: 67, reading_lag_max_s: 112 };
const pass = (id, condition) => ({ id, condition, verdict: 'pass', reason: 'fine.' });
const un9dOk = [
  { test: 'Test 1', verdict: 'pass', conditions: [pass('observed_time', 'times'), pass('freshness', 'stale never live'), pass('agreement', 'agree')] },
  { test: 'Test 2', verdict: 'pass', conditions: [pass('incident_opened', 'opened'), pass('recovers_once', 'recovers'), pass('downstream_agrees', 'downstream')] },
];

let c = st.onTime(clean);
assert.equal(c.verdict, 'pass'); assert.match(c.reason, /20 snapshot\(s\) in 60 min/); ok('a clean hour is on time, and says what it measured');

c = st.onTime({ ...clean, gaps_s: [...clean.gaps_s.slice(1), 720] });
assert.equal(c.verdict, 'fail'); assert.match(c.reason, /1 gap\(s\) between snapshots over 600 s \(longest 720 s\)/); ok('a gap over 600 s fails and is named');

c = st.onTime({ ...clean, last_snapshot_age_s: 900 });
assert.equal(c.verdict, 'fail'); assert.match(c.reason, /newest snapshot is 900 s old/); ok('a feed silent now fails even if the window was clean');

c = st.onTime({ ...clean, transit_p95_s: 75 });
assert.equal(c.verdict, 'fail'); assert.match(c.reason, /took up to 75 s to arrive/); ok('slow arrival fails');

c = st.onTime({ ...clean, reading_lag_max_s: 1000 });
assert.equal(c.verdict, 'fail'); assert.match(c.reason, /one reading landed 1000 s after it was read/); ok('a reading later than the offline line fails');

c = st.onTime({ ...clean, snapshots: 0, gaps_s: [], last_snapshot_age_s: 4000 });
assert.equal(c.verdict, 'not_yet_possible'); assert.match(c.reason, /No snapshot arrived/); ok('no snapshot in the window is not_yet_possible, never a pass');

let r = st.judge(clean, un9dOk);
assert.equal(r.verdict, 'pass'); assert.deepEqual(r.checks.map((x) => x.id), ['on_time', 'state_correct', 'one_alert', 'nothing_old_live']); ok('all four pass: the run passes, in the checklist order');

const stale = JSON.parse(JSON.stringify(un9dOk)); stale[0].conditions[1] = { id: 'freshness', condition: 'stale never live', verdict: 'fail', reason: '2 device(s) read LIVE although the feed is 15 min old.' };
r = st.judge(clean, stale);
assert.equal(r.verdict, 'fail'); assert.equal(r.checks.find((x) => x.id === 'nothing_old_live').verdict, 'fail'); assert.equal(r.checks.find((x) => x.id === 'state_correct').verdict, 'pass'); ok('a LIVE device on old data fails nothing_old_live only');

const dupe = JSON.parse(JSON.stringify(un9dOk)); dupe[1].conditions[1] = { id: 'recovers_once', condition: 'recovers', verdict: 'fail', reason: 'relay-1: INC-1 and INC-2 open together.' };
r = st.judge(clean, dupe);
assert.equal(r.checks.find((x) => x.id === 'one_alert').verdict, 'fail'); assert.match(r.checks.find((x) => x.id === 'one_alert').reason, /open together/); ok('two incidents open at once fails one_alert, with UN9D\'s reason');

const none = JSON.parse(JSON.stringify(un9dOk)); none[1].conditions = [{ id: 'incident_opened', condition: 'opened', verdict: 'not_yet_possible', reason: 'No device has gone quiet.' }];
r = st.judge(clean, none);
assert.equal(r.verdict, 'not_yet_possible'); ok('no quiet sensor yet is not_yet_possible, never a pass');

assert.equal(st.RULE.snapshot_gap_max_s, 600); assert.equal(st.RULE.reading_lag_max_s, 900); ok('the lines are the Monitoring Twin\'s own (feed silent 600 s, offline 900 s)');

console.log(`stress-test: ${n} passed`);
