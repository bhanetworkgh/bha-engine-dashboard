/**
 * The outside digest from BHA RSS (14 Nov 2026, D4): what a post must carry before it is stored.
 * Pure, no database or network. Run with: npm run test:outside-digest
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
try { require.resolve('pg'); } catch {
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'pg' ? { Pool: class {}, types: { setTypeParser() {} } } : load.call(this, req, ...rest); };
}
const od = require(path.join(DIST, 'server/src/outsideDigest.js'));
const bharag = require(path.join(DIST, 'server/src/bharag.js'));

const good = {
  digest_date: '2026-11-14',
  title: 'Outside digest -- 2026-11-14: Robots pick fruit',
  body: '## What moved outside\n- A robot picks strawberries [x](https://ex.com/a)\n'.repeat(2),
  period_start: '2026-11-14T00:00:00Z',
  period_end: '2026-11-15T00:00:00Z',
  items_used: 12,
  sources_used: 5,
  items: [{ title: 'A', url: 'https://ex.com/a', kind: 'rss', source: 'Ex' }],
};

// 1. A complete digest parses.
const p = od.parse(good);
assert.equal(p.digest_date, '2026-11-14');
assert.equal(p.items_used, 12);
assert.equal(p.items.length, 1);
assert.equal(p.period_end, '2026-11-15T00:00:00.000Z');

// 2. Each missing or wrong field is refused by name, never stored half.
const bad = (patch, word) => assert.throws(() => od.parse({ ...good, ...patch }), (e) => e instanceof od.DigestError && e.status === 422 && e.message.includes(word));
bad({ digest_date: '14 Nov' }, 'digest_date');
bad({ title: '' }, 'title');
bad({ body: 'short' }, 'body');
bad({ period_end: '2026-11-13T00:00:00Z' }, 'period_start');

// 3. The digest goes to its own BHARAG workspace variable.
assert.equal(bharag.INGEST_KEY_VARS.outside, 'BHARAG_OUTSIDE_KEY');

console.log('outside digest: 3 checks passed');
