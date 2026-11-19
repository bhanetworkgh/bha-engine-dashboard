/**
 * The Apify usage watch and read_apify's paths (19 Nov 2026). Pure: no database, no network.
 * Run with:  npm run test:apify-usage   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const au = require(path.join(DIST, 'server/src', 'apifyUsage.js'));
const sr = require(path.join(DIST, 'server/src', 'serviceReads.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

for (const p of ['/users/me/limits', '/users/me/usage/monthly', '/actor-runs', '/actor-runs/abc123', '/acts', '/acts/automation-lab~youtube-transcript/runs']) assert.equal(sr.refusal('apify', p, {}), null, p);
for (const p of ['/users/me', '/users/me/proxy', '/acts/x/runs/y/abort', '/key-value-stores']) assert.equal(sr.refusal('apify', p, {})?.reason, 'path_refused', p);
ok('read_apify reads usage and runs, never /users/me (the proxy password)');

const base = { cycle_start: '2026-11-01T00:00:00.000Z', cycle_end: '2026-12-01T00:00:00.000Z', included_usd: 19, hard_limit_usd: null, plan: 'STARTER' };
const at = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`);

assert.deepEqual(au.judge({ ...base, used_usd: 1 }, null, at(1)), []);
ok('early in the cycle and under 50%: nothing');

let a = au.judge({ ...base, used_usd: 6 }, null, at(5));
assert.equal(a.length, 1); assert.equal(a[0].key, 'pace'); assert.match(a[0].text, /runs out on 2026-11-1\d/);
ok('on pace to run out early: one pace line naming the day');

a = au.judge({ ...base, used_usd: 6 }, { cycle_start: base.cycle_start, sent: ['pace'] }, at(6));
assert.deepEqual(a, []);
ok('the pace line is said once a cycle');

a = au.judge({ ...base, used_usd: 16 }, { cycle_start: base.cycle_start, sent: ['pace'] }, at(14));
assert.equal(a.length, 1); assert.equal(a[0].key, 't80');
ok('crossing 50 and 80 in one gap is one line, at 80%');

a = au.judge({ ...base, used_usd: 19.5 }, { cycle_start: base.cycle_start, sent: ['pace', 't50', 't80'] }, at(20));
assert.equal(a[0].key, 't100'); assert.match(a[0].text, /pay as you go/);
a = au.judge({ ...base, used_usd: 19.5, hard_limit_usd: 19 }, { cycle_start: base.cycle_start, sent: ['t50', 't80'] }, at(20));
assert.match(a[0].text, /blocked/);
ok('at 100%: billed on top, or blocked where a usage limit is set');

a = au.judge({ ...base, cycle_start: '2026-12-01T00:00:00.000Z', cycle_end: '2027-01-01T00:00:00.000Z', used_usd: 10 }, { cycle_start: base.cycle_start, sent: ['t50', 't80', 't100', 'pace'] }, new Date('2026-12-20T00:00:00Z'));
assert.equal(a[0].key, 't50');
ok('a new cycle starts the lines again');

assert.deepEqual(au.judge({ ...base, included_usd: null, used_usd: 50 }, null, at(10)), []);
ok('no included credit read: no line, never a guessed budget');

console.log(`\napify usage: ${n} checks passed`);
