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
// D6, 24 Oct 2026: a farm asked for by name, as Genie asked for "vFarm_01".
const held = [
  { farm_id: '21dde23e-f7f6-46bc-9b54-e97fabaaafd7', code: 'v-farm', name: 'v-farm', synthetic: false, listed: true },
  { farm_id: '9598b09c-c10c-403b-b4c2-7c5405b54987', code: 'vfarm-01', name: 'Vfarm_01', synthetic: false, listed: false },
  { farm_id: 'SIM-TOMATO-01', code: 'sim-tomato-01', name: 'Simulated tomato test rack', synthetic: true },
];
let m = ev.matchFarms(held, 'vFarm_01');
assert.deepEqual(m.farms.map((f) => f.farm_id), ['9598b09c-c10c-403b-b4c2-7c5405b54987']); assert.equal(m.matched_by, 'code_or_name');
m = ev.matchFarms(held, 'V-FARM');
assert.deepEqual(m.farms.map((f) => f.farm_id), ['21dde23e-f7f6-46bc-9b54-e97fabaaafd7']);
m = ev.matchFarms(held, 'SIM-TOMATO-01');
assert.equal(m.matched_by, 'farm_id');
assert.equal(ev.farmKey('vFarm_01'), ev.farmKey('vfarm-01'));
assert.notEqual(ev.farmKey('vfarm'), ev.farmKey('vfarm-01'));
ok('matchFarms: by id exactly, else by code or name without case or punctuation; v-farm and Vfarm_01 stay two farms');
assert.deepEqual(ev.matchFarms(held, 'rack-9').farms, []);
s = ev.unknownFarm('rack-9', held);
assert.equal(s.state, 'absent'); assert.match(s.fallback, /don't hold a farm called "rack-9"/); assert.match(s.fallback, /Vfarm_01 \(9598b09c.*no longer listed/); assert.doesNotMatch(s.fallback, /no real vFarm farm/);
ok('a name nothing answers to says so and lists the farms held, never "no real farm"');
console.log(`\n${n} checks passed`);
