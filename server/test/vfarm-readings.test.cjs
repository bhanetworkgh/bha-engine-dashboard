/**
 * Reading history from each vFarm snapshot (LOOP-3ASC sensor side, migration 87). Pure: no database.
 * Run with:  npm run test:vfarm-readings   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const sf = require(path.join(DIST, 'server/src', 'systemFeeds.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const at = '2026-10-21T16:28:24.016Z';
let r = sf.readingRows({ humidity: { unit: 'percent_rh', value: 69, status: 'ok' }, temperature: { unit: 'celsius', value: 29.3, status: 'ok' } }, at);
assert.deepEqual(r.map((x) => [x.metric, x.value, x.unit, x.status, x.read_at]), [['humidity', 69, 'percent_rh', 'ok', at], ['temperature', 29.3, 'celsius', 'ok', at]]);
ok('each metric of a reading becomes one row, with its unit, status and the reading time');
assert.deepEqual(sf.readingRows({ relay: { unit: '', value: 0, status: 'ok' } }, at).map((x) => [x.value, x.unit]), [[0, null]]);
ok('a relay at 0 is a reading, not a missing one');
assert.deepEqual(sf.readingRows({ ph: 4.2 }, at).map((x) => x.value), [4.2]);
ok('a bare number is read as the value');
assert.deepEqual(sf.readingRows({ ph: { value: 'n/a' } }, at), []);
assert.deepEqual(sf.readingRows({ ph: { value: 4 } }, null), []);
assert.deepEqual(sf.readingRows(null, at), []);
ok('no number, no reading time or no reading writes nothing');
console.log(`\n${n} checks passed`);
