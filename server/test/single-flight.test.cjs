/**
 * Identical page reads share one answer (2026-11-23): concurrent callers join one run, a change on the
 * events bus starts a fresh run for later callers, and a finished run is never served again.
 * Run with: npm run test:single-flight
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { shared, stats } = require(path.join(DIST, 'server/src/singleFlight'));
const events = require(path.join(DIST, 'server/src/events'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let runs = 0;
  const slow = (v) => async () => { runs += 1; await wait(30); return v; };

  const all = await Promise.all(Array.from({ length: 28 }, () => shared('open-loops', slow('a'))));
  assert.equal(runs, 1); assert.ok(all.every((x) => x === 'a')); ok('28 identical reads at once run once and share the answer');

  await shared('open-loops', slow('b'));
  assert.equal(runs, 2); ok('a read after the last one finished runs again (nothing is cached)');

  runs = 0;
  const first = shared('k', slow('before'));
  events.changed('loops');
  await wait(5); // changed() announces after commit, which is a microtask with no transaction
  const second = shared('k', slow('after'));
  const third = shared('k', slow('ignored'));
  assert.deepEqual(await Promise.all([first, second, third]), ['before', 'after', 'after']);
  assert.equal(runs, 2); ok('a caller after a change never joins the read that began before it, and joins the new one');

  runs = 0;
  await Promise.all([shared('x', slow(1)), shared('y', slow(2))]);
  assert.equal(runs, 2); ok('different keys do not share');

  let failed = 0;
  const boom = async () => { await wait(10); throw new Error('nope'); };
  await Promise.all([shared('err', boom).catch(() => (failed += 1)), shared('err', boom).catch(() => (failed += 1))]);
  assert.equal(failed, 2); assert.equal(await shared('err', slow('ok')), 'ok'); ok('a failed read fails every joiner and does not stick');

  assert.equal(stats().running, 0); ok('nothing is left running');
  console.log(`single-flight: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
