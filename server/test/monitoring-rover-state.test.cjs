/**
 * The rover's own state on the Monitoring Twin (INC-BAYS.MONITORING-632, 18 Nov 2026).
 *
 * The rover sleeps between scheduled passes, so presence read it as offline. vFarm now
 * judges it from the pass start and end (backend rover_state.judge, bhavfarm PR #115) and
 * sends one row per rover in history.sections.rover_state. roverVerdict decides what the
 * Monitoring Twin does with that row. Pure: no database, no network.
 *
 * Jason's four cases, as the Twin sees them:
 *   1. a normal pass (in_pass, then resting): no fault at all
 *   2. a start with no end inside the window (stalled): one rover_pass fault
 *   3. a completed pass then rest (resting): no fault, and presence's offline is held back
 *   4. days with no passes (missed_pass): one rover_pass fault
 * And Jegan's: off_rover holds presence back too. A stale or unknown row decides nothing.
 *
 * Run with:  npm run test:monitoring-rover
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const mt = require(path.join(DIST, 'server/src/monitoringTwin.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const NOW = Date.parse('2026-11-18T12:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

let v = mt.roverVerdict({ state: 'in_pass', alarm: false, at: at(1) }, NOW);
assert.deepEqual([v.decides, v.quiet, v.fault], [true, true, null]);
v = mt.roverVerdict({ state: 'resting', alarm: false, at: at(1) }, NOW);
assert.deepEqual([v.decides, v.quiet, v.fault], [true, true, null]);
ok('1. a normal pass, in_pass then resting, raises nothing');

v = mt.roverVerdict({ state: 'stalled', alarm: true, at: at(1), reason: 'pass started 31 min ago and never ended', pass_id: 'p1', overdue_s: 60 }, NOW);
assert.equal(v.decides, true);
assert.equal(v.fault.metric, 'stalled');
assert.match(v.fault.detail, /never ended \(pass p1\)\.$/);
assert.equal(v.fault.value, 60);
ok('2. a start with no end past the deadline is one rover_pass fault, naming the pass');

v = mt.roverVerdict({ state: 'resting', alarm: false, at: at(3) }, NOW);
assert.equal(v.decides && v.quiet, true, 'a resting rover holds back the presence offline fault');
ok('3. a completed pass then rest holds back offline');

v = mt.roverVerdict({ state: 'missed_pass', alarm: true, at: at(1) }, NOW);
assert.equal(v.fault.metric, 'missed_pass');
assert.match(v.fault.detail, /missed pass/);
ok('4. days with no passes is one rover_pass fault');

v = mt.roverVerdict({ state: 'off_rover', alarm: false, at: at(1) }, NOW);
assert.deepEqual([v.decides, v.quiet, v.fault], [true, true, null]);
v = mt.roverVerdict({ state: 'ended_away', alarm: true, at: at(1) }, NOW);
assert.equal(v.fault.metric, 'ended_away');
ok('off_rover is quiet; ended_away is a fault');

v = mt.roverVerdict({ state: 'resting', alarm: false, at: at(mt.ROVER_STATE_FRESH_S / 60 + 1) }, NOW);
assert.deepEqual([v.decides, v.fault], [false, null]);
assert.match(v.why, /stale/);
v = mt.roverVerdict({ state: 'unknown', alarm: false, at: at(1) }, NOW);
assert.equal(v.decides, false);
assert.equal(mt.roverVerdict(null, NOW).decides, false);
assert.equal(mt.roverVerdict({ state: 'resting', alarm: false }, NOW).decides, false, 'no at is never fresh');
ok('a stale, unknown, missing or undated row decides nothing, so presence still watches');

const body = mt.ledgerBody({ incident_id: 'MON-1', farm_id: 'farm-1', device_id: 'vfarm-rover-01', kind: 'rover_pass', metric: 'missed_pass', severity: 'warning', detail: 'Next pass overdue.', stage: null, synthetic: false });
assert.equal(body.payload.error_class, 'ROVER_PASS_FAULT');
assert.match(body.summary, /farm-1 \/ vfarm-rover-01: rover missed pass$/);
ok('the ledger is sent ROVER_PASS_FAULT with the state in words');

console.log(`\n${n} checks passed`);
