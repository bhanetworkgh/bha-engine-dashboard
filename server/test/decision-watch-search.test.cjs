/**
 * list_decision_watches search (2026-11-23): a watch is found by the words in its own text, best first.
 * Run with: npm run test:decision-watch-search
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const { searchWatches } = require(path.join(DIST, 'server/src/mcp/decisionWatchTools'));

const rows = [
  { watch_id: 'DW-1', decision: 'Stripe 2KG0 product definition', next_step: null, sop_refs: null },
  { watch_id: 'DW-2', decision: 'write the stress-test checklist as a Monitoring Twin eval', next_step: 'GATING NOTE: not sellable', sop_refs: 'SOP 9a00cbe5' },
  { watch_id: 'DW-3', decision: 'Monitoring alerts for the rover', next_step: null, sop_refs: null },
];
const got = searchWatches(rows, 'Monitoring Twin gating checklist');
assert.deepEqual(got.map((w) => w.watch_id), ['DW-2', 'DW-3']);
console.log('  ok  best match first, a watch matching no word is left out');
assert.deepEqual(searchWatches(rows, '9a00cbe5').map((w) => w.watch_id), ['DW-2']);
console.log('  ok  the SOP references are searched');
assert.equal(searchWatches(rows, 'the and').length, 3);
console.log('  ok  a search of only stopwords filters nothing');
console.log('3 checks passed');
