/**
 * BP-INFRA-002 on the twins' vFarm read (LOOP-8AQG, 21 Oct 2026). Pure: no database, no network.
 * Run with:  npm run test:vfarm-evidence   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ev = require(path.join(DIST, 'server/src', 'vfarmEvidence.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const farm = (o = {}) => ({ farm_id: 'F1', name: 'v-farm', synthetic: false, feed: { last_snapshot_at: '2026-10-21T16:00:00Z', age_s: 30, silent: false }, devices: [{ device_id: 'a', state: 'LIVE' }, { device_id: 'b', state: 'LIVE' }], open_incidents: [], ...o });

let s = ev.evidenceStatus(farm());
assert.equal(s.state, 'live'); assert.equal(s.reportable, true); assert.deepEqual(s.reportable_devices, ['a', 'b']);
ok('every device LIVE is live and reportable');

s = ev.evidenceStatus(farm({ devices: [{ device_id: 'a', state: 'LIVE' }, { device_id: 'b', state: 'OFFLINE' }], open_incidents: [{ incident_id: 'INC-VFARM.X', ledger_id: 'INC-BAYS.MONITORING-1' }] }));
assert.equal(s.state, 'degraded'); assert.equal(s.degraded, true); assert.deepEqual(s.reportable_devices, ['a']);
assert.deepEqual(s.not_reportable_devices, [{ device_id: 'b', state: 'OFFLINE' }]); assert.deepEqual(s.incidents, ['INC-BAYS.MONITORING-1']);
assert.match(s.instruction, /never quote its last value as current/);
ok('a device not LIVE degrades the farm, names the device and the open incident, and only LIVE devices are reportable');

s = ev.evidenceStatus(farm({ feed: { last_snapshot_at: '2026-10-21T15:00:00Z', age_s: 3600, silent: true } }));
assert.equal(s.state, 'degraded'); assert.equal(s.reportable, false); assert.deepEqual(s.reportable_devices, []);
assert.match(s.instruction, /could not look/); assert.match(s.fallback, /silent since/);
ok('a silent feed is degraded, nothing reportable, "could not look" not "nothing there"');

s = ev.evidenceStatus(farm({ feed: { last_snapshot_at: null, age_s: null, silent: true } }));
assert.equal(s.state, 'absent'); assert.equal(s.reportable, false);
ok('no snapshot ever is absent');

s = ev.evidenceStatus(farm({ synthetic: true }));
assert.equal(s.state, 'simulated'); assert.equal(s.reportable, false); assert.match(s.instruction, /Never report/);
ok('a simulated farm is never reportable as the rack');

s = ev.evidenceStatus(farm({ devices: [{ device_id: 'a', state: 'OFFLINE' }, { device_id: 'b', state: 'NOT_WIRED' }] }));
assert.equal(s.state, 'degraded'); assert.equal(s.reportable, false); assert.match(s.fallback, /none of its 2 devices is reporting/);
ok('a feed arriving with every device down is degraded and says no current readings');

s = ev.noRealFarm();
assert.equal(s.state, 'absent'); assert.equal(s.degraded, true);
ok('no real farm held is absent, never "no problems"');
console.log(`\n${n} checks passed`);
