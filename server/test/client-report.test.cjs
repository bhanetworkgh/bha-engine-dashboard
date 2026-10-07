/**
 * The weekly client report's template (7 Oct 2026, LOOP-1788870070271-SR9G and
 * LOOP-1788870072972-TYL9). No database and no network: buildReport is pure.
 *
 *   - formal gaps (flagged) and caveats named in prose are counted apart, and
 *     the At a glance table, the digging section and the returned counts agree;
 *   - Purpose & Future Translation prints the lane's own Client Purpose and
 *     Future Translation, never Commercial Hook, and says so when unwritten;
 *   - Current maturity is computed from the same counts.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.REPORT_DIST || path.join(__dirname, '../../server-dist');
// Nothing here touches the database; where `pg` is not installed (a bare
// checkout) a stand-in lets the module graph load.
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'pg') {
    try { return load.call(this, request, ...rest); } catch { return { Pool: class { on() {} }, types: { setTypeParser() {}, builtins: {} } }; }
  }
  return load.call(this, request, ...rest);
};
const mirrorPath = require.resolve(path.join(DIST, 'server/src/mirror.js'));
require.cache[mirrorPath] = { id: mirrorPath, filename: mirrorPath, loaded: true, exports: {} };
const { buildReport } = require(path.join(DIST, 'server/src/mcp/researchTwinTools.js'));
const step = (s) => console.log(`  ok  ${s}`);

const ans = (notYet) => `What the evidence supports\nTwo plants are running.\n\nWhat it does not yet support\n${notYet}\n\nSources\n[S1] Example - https://example.org/a`;
const rows = [
  { fields: { Question: 'Who is recycling at scale?', 'This Week Answer': ans('No audited throughput figures exist.'), 'Plain Summary': 'Two plants run.', Confidence: 'Medium', 'Movement Tag': 'refined', 'Run Count': 4 } },
  { fields: { Question: 'Is policy moving?', 'This Week Answer': ans('No material gaps this cycle.'), 'Plain Summary': 'Yes.', Confidence: 'High', 'Movement Tag': 'same', 'Run Count': 4 } },
  { fields: { Question: 'What is the price trend?', 'This Week Answer': ans('Spot prices are not public.'), 'Plain Summary': 'Unclear.', Confidence: 'Low', 'Movement Tag': 'new', 'Run Count': 3, 'Missing Research': true, 'Next Experiments': 'Find a price index' } },
];
const lane = { client_name: 'Client 2 — Rare Earth Recycling', lane_id: 'CLIENT2_RARE_EARTH_RECYCLING', trend_shape: 'Early build-out.', commercial_hook: 'INTERNAL: first live proof point for the weekly loop.', purpose: 'Track whether rare-earth recycling is becoming investable.', future_translation: 'A watchlist of recyclers to size a position against.' };

const r = buildReport(lane, {}, rows, '2026-10-07');
const md = r.report_content;
assert.equal(r.flagged_count, 1);
assert.equal(r.caveat_count, 2, 'a "No material gaps" answer is not a caveat');
assert.match(md, /\| Flagged as thin or stuck \| 1 \|/);
assert.match(md, /\| Answers naming a caveat \| 2 \|/);
assert.match(md, /\*\*Questions flagged this cycle\*\*/);
assert.match(md, /\*\*Caveats named in this cycle's answers\*\*/);
step('formal gaps and prose caveats are counted apart and the table matches the body');

assert.match(md, /## Purpose & Future Translation/);
assert.match(md, /\*\*Purpose\*\*\n\nTrack whether rare-earth recycling is becoming investable\./);
assert.match(md, /\*\*Future translation\*\*\n\nA watchlist of recyclers to size a position against\./);
assert.doesNotMatch(md, /INTERNAL/, 'Commercial Hook never reaches the client report');
assert.ok(md.indexOf('## At a glance') < md.indexOf('## Purpose & Future Translation') && md.indexOf('## Purpose & Future Translation') < md.indexOf('## Client Summary'));
step('Purpose and Future translation come from the lane, never Commercial Hook');

assert.match(md, /\*\*Current maturity\*\*\n\nThis is an established lane with a trend on record\. 3 questions tracked, with at most 4 research passes on any one of them\. 1 flagged as thin or stuck; 2 answers name a caveat\./);
step('Current maturity is computed from the same counts');

const bare = buildReport({ client_name: 'New lane', commercial_hook: 'INTERNAL' }, {}, [rows[1]], '2026-10-07').report_content;
assert.equal((bare.match(/_Not yet written for this lane\._/g) || []).length, 2);
assert.match(bare, /This is a young lane: the trend is not yet established\./);
assert.match(bare, /0 flagged as thin or stuck; 0 answers name a caveat\./);
assert.doesNotMatch(bare, /INTERNAL/);
step('an unwritten Purpose or Future translation says so');

console.log('client-report: all passed');
