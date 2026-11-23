/**
 * update_record's append (2026-11-23, Jason in C0ASMPYQLG3 1795434107.741089): a decision is added below what a
 * field holds and never replaces it. Run with: npm run test:update-append
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { appendTo } = require(path.join(DIST, 'server/src/mcp/writeTools'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const e = '2026-11-24 (Jason): Decision - P1.0 FLAGSHIP is one in-house rack, not four.';
assert.deepEqual(appendTo(undefined, [e]), { ok: true, value: [e] }); ok('no field yet becomes a list of the new entry');
assert.deepEqual(appendTo(['a'], [e]), { ok: true, value: ['a', e] }); ok('a list gets the entry added at the end');
assert.deepEqual(appendTo('old note', [e]), { ok: true, value: ['old note', e] }); ok('text already there becomes the first item');
assert.deepEqual(appendTo('', [e, 'x']), { ok: true, value: [e, 'x'] }); ok('an empty field takes every entry in order');
assert.equal(appendTo(42, [e]).ok, false); ok('a number is refused, never guessed at');
assert.equal(appendTo({ a: 1 }, [e]).ok, false); ok('an object is refused');
console.log(`update-append: ${n} passed`);
