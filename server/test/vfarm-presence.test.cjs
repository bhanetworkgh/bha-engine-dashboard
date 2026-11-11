/**
 * Presence alerts on the Engine dashboard (LOOP-1794321147933-J1ZC, Jason 10 Nov 2026).
 *
 * vFarm's presence rule is device_silent. Until 11 Nov 2026 only its back-online frame
 * (kind device_online) arrived, and the Alerts tab drew it as "Device silent" fired. Pure checks:
 *   1. presenceRole: device_offline or single on device_silent is the device going silent;
 *      device_online on any rule, or clear on device_silent, is it coming back; anything else is not presence.
 *   2. presenceAlertId: vFarm's own alert id wins (entry, then envelope), else the fire's event id.
 *   3. UN9D condition 6 counts a device_online frame as a clear, not a fire.
 *
 * Run with:  npm run test:vfarm-presence   (no database, no network)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

req('paySync.js'); // loaded first: it extends systemFeeds' FeedError, and systemFeeds reaches it through mirror
const sf = req('systemFeeds.js');
const un9d = req('un9d.js');

assert.equal(sf.presenceRole('device_offline', 'device_silent'), 'went_silent');
assert.equal(sf.presenceRole('single', 'device_silent'), 'went_silent');
assert.equal(sf.presenceRole('device_online', 'device_silent'), 'back_online');
assert.equal(sf.presenceRole('device_online', null), 'back_online');
assert.equal(sf.presenceRole('clear', 'device_silent'), 'back_online');
assert.equal(sf.presenceRole('single', '129d8d8d-e8c6-4d87-9206-89bc874df443'), null);
assert.equal(sf.presenceRole('clear', '129d8d8d-e8c6-4d87-9206-89bc874df443'), null);
ok('presenceRole tells going silent from coming back, and leaves soil alerts alone');

assert.equal(sf.presenceAlertId({}, { alert_id: 'AS-1' }, 'ev-1'), 'AS-1');
assert.equal(sf.presenceAlertId({ alert_id: 'AS-2' }, {}, 'ev-1'), 'AS-2');
assert.equal(sf.presenceAlertId({}, { alert_state_id: 'AS-3' }, 'ev-1'), 'AS-3');
assert.equal(sf.presenceAlertId({}, {}, 'ev-1'), 'ev-1');
ok("presenceAlertId takes vFarm's alert id, else the event id");

const at = '2026-11-11T08:35:12Z';
const c6 = un9d.condition6([{ kind: 'device_online', fired_at: at, received_at: at }, { kind: 'single', fired_at: at, received_at: at }], 0);
assert.equal(c6.verdict, 'pass');
assert.match(c6.conditions[0].reason, /1 fired, 1 cleared/);
ok('UN9D condition 6 counts a back-online frame as a clear');

console.log(`\n${n} checks passed.`);
