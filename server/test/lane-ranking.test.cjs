/**
 * North Star's weighted lane ranking (28 Sep 2026, Jason's thread in
 * #bha-north-star-twin): the maths, pinned. Pure — no database.
 *
 * Run with:  npm run test:lane-ranking
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const r = require(path.join(process.env.LANE_RANKING_DIST || path.join(__dirname, '../../server-dist'), 'server/src/laneRanking.js'));

const now = new Date('2026-09-28T18:00:00Z');
const lane = (o) => ({
  lane_id: 'X', kind: 'work', gates_oct31: null, blocks_others: null, engine_leverage: null,
  commercial_tag: null, commercial_from_cards: null, effort: null, last_moved: null, open_items: 1,
  anchors: [], note: null, has_profile: true, ...o,
});

// Weights sum to 100.
assert.equal(Object.values(r.WEIGHTS).reduce((a, b) => a + b, 0), 100);

// Every factor at 5 scores 100; nothing set scores 0 and names all six as missing.
const full = r.scoreLane(lane({ gates_oct31: 5, blocks_others: 5, engine_leverage: 5, commercial_tag: 5, effort: 'small', last_moved: '2026-09-01T00:00:00Z' }), now);
assert.equal(full.score, 100);
assert.deepEqual(full.missing, []);
const empty = r.scoreLane(lane({ open_items: 0 }), now);
assert.equal(empty.score, 0);
assert.equal(empty.missing.length, 6);

// Worked example: gates 5 (25) + leverage 5 (20) + 6 days stale → 2 of 5 (4) + medium effort 3 of 5 (6) = 55.
const ex = r.scoreLane(lane({ gates_oct31: 5, engine_leverage: 5, effort: 'medium', last_moved: '2026-09-22T18:00:00Z' }), now);
assert.equal(ex.factors.days_since_moved, 2);
assert.equal(ex.score, 55);
assert.deepEqual(ex.missing, ['blocks_others', 'commercial_impact']);

// A work lane with no open loops is not stale.
assert.equal(r.scoreLane(lane({ open_items: 0, last_moved: '2026-08-01T00:00:00Z' }), now).factors.days_since_moved, 0);
// Staleness caps at 5.
assert.equal(r.scoreLane(lane({ last_moved: '2026-06-01T00:00:00Z' }), now).factors.days_since_moved, 5);

// Commercial from cards, and a tag overrides it.
assert.equal(r.commercialFromCard('High', 'Media-Ready'), 5);
assert.equal(r.commercialFromCard('Medium', 'Research-First'), 3);
assert.equal(r.commercialFromCard('', ''), null);
const c = r.scoreLane(lane({ kind: 'commercial', commercial_from_cards: 3 }), now);
assert.equal(c.factors.commercial_impact, 3);
assert.equal(c.sources.commercial_impact, 'cards');
assert.equal(r.scoreLane(lane({ kind: 'commercial', commercial_from_cards: 3, commercial_tag: 1 }), now).factors.commercial_impact, 1);
// A work lane never reads cards.
assert.equal(r.scoreLane(lane({ commercial_from_cards: 4 }), now).factors.commercial_impact, null);

// Same inputs, same order, every time; ties break on lane id.
const set = [lane({ lane_id: 'B', gates_oct31: 3 }), lane({ lane_id: 'A', gates_oct31: 3 }), lane({ lane_id: 'C', gates_oct31: 5 })];
const o1 = r.rank(set, now).map((l) => l.lane_id);
const o2 = r.rank(set.slice().reverse(), now).map((l) => l.lane_id);
assert.deepEqual(o1, ['C', 'A', 'B']);
assert.deepEqual(o1, o2);
assert.deepEqual(r.rank(set, now).map((l) => l.rank), [1, 2, 3]);

console.log('lane-ranking: all assertions passed');

// ---- lane health: research state and the re-entry signal (laneHealth.ts) ----
const h = require(path.join(process.env.LANE_RANKING_DIST || path.join(__dirname, '../../server-dist'), 'server/src/laneHealth.js'));
const job = (o) => ({ lane_id: 'LANE-X', job_id: 'J', status: 'Resolved', question: 'q', verdict: 'v', finding: '', confidence: 'High', missing: null, resolved_at: '2026-09-20T00:00:00Z', ...o });
// No linked research lane: nothing to research against.
assert.equal(h.researchState([], [job()], 1, now).action, 'none');
// Top-ranked, nothing on record: first pass.
assert.equal(h.researchState(['LANE-X'], [], 1, now).action, 'first_pass');
assert.equal(h.researchState(['LANE-X'], [], 1, now).state, 'not_started');
// Ranked below the top five: waits.
assert.equal(h.researchState(['LANE-X'], [], 6, now).action, 'none');
// An open job: in queue, nothing new proposed.
const q = h.researchState(['LANE-X'], [job({ status: 'Pending' })], 1, now);
assert.equal(q.state, 'in_queue');
assert.equal(q.action, 'none');
// Answered with high confidence and no gaps: answered for now.
const a = h.researchState(['LANE-X'], [job()], 1, now);
assert.equal(a.state, 'answered');
assert.equal(a.action, 'none');
// Low confidence or named gaps: deeper pass.
assert.equal(h.researchState(['LANE-X'], [job({ confidence: 'Low' })], 1, now).action, 'deeper_pass');
assert.equal(h.researchState(['LANE-X'], [job({ missing: 'no pricing data' })], 1, now).action, 'deeper_pass');
// Older than 30 days: stale, deeper pass.
const s = h.researchState(['LANE-X'], [job({ resolved_at: '2026-08-01T00:00:00Z' })], 1, now);
assert.equal(s.state, 'stale');
assert.equal(s.action, 'deeper_pass');
console.log('lane-health: all assertions passed');

// ---- convergence verdicts ----
assert.equal(h.convergence('work', 0, 0, 0, 0).verdict, 'unknown');
assert.equal(h.convergence('work', 9, 10, 5, 1).verdict, 'churning');
assert.match(h.convergence('work', 9, 10, 5, 1).note, /recurred/);
assert.equal(h.convergence('work', 9, 10, 5, 0).verdict, 'converging');
assert.equal(h.convergence('work', 63, 10, 89, 0).verdict, 'churning');
assert.equal(h.convergence('work', 12, 10, 8, 0).verdict, 'steady');
assert.equal(h.convergence('commercial', null, null, 0, 0).verdict, 'unknown');
console.log('lane-convergence: all assertions passed');
