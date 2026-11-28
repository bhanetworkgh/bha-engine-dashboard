/**
 * VFARM_CONFIDENCE_SCORING_V0 (28 Nov 2026, LOOP-1795071778245-XHRR). Pure: no database, no network.
 * Run with:  npm run test:confidence-score   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const cs = require(path.join(DIST, 'server/src', 'confidenceScore.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const pass = (at, cites) => `[${at}] finding ${cites.map((c) => `[S${c}]`).join(' ')}`;

let c = cs.score({});
assert.equal(c.score, 0); assert.equal(c.band, 'Low'); assert.equal(c.version, 'VFARM_CONFIDENCE_SCORING_V0');
ok('an empty card scores 0, Low');

c = cs.score({ confidence: 'High' });
assert.equal(c.score, 0); assert.equal(c.model_label, 'High');
ok('the model-written label is kept as model_label and is never an input');

c = cs.score({ research_gleanings: pass('2026-11-25T00:00:00.000Z', [1, 1, 2]) });
assert.equal(c.parts.find((p) => p.part === 'citations').count, 2);
assert.equal(c.score, 20);
ok('a repeated [S1] in one pass counts once: 2 citations (10) + 1 pass (10) = 20');

const g = [pass('2026-11-25T00:00:00.000Z', [1, 2, 3, 4]), pass('2026-11-26T00:00:00.000Z', [1, 2, 3, 4])].join('\n\n');
c = cs.score({ research_gleanings: g, source_logs: 'Jeganathan · A\nKavin G N · B', experiment_results: 'ran it' });
assert.equal(c.score, 40 + 20 + 30 + 10); assert.equal(c.band, 'High');
ok('8 citations over 2 passes, an experiment result and 2 logs is 100, High (each part at its cap)');

c = cs.score({ research_gleanings: pass('2026-11-25T00:00:00.000Z', Array.from({ length: 20 }, (_, i) => i + 1)) });
assert.equal(c.parts.find((p) => p.part === 'citations').points, 40);
ok('citations stop at 40');

c = cs.score({ research_gleanings: g, source_logs: 'A · x', experiment_results: 'y', missing_research_count: '3' });
assert.equal(c.score, 40 + 20 + 30 + 5 - 30); assert.equal(c.band, 'Medium');
ok('3 open questions take 30 off');

c = cs.score({ missing_research_count: 0, missing_research_questions: 'q1 | q2' });
assert.equal(c.open_questions, 2);
ok('a count of 0 beside listed questions counts the listed questions (the sources.ts rule)');

c = cs.score({ missing_research_count: 9 });
assert.equal(c.score, 0);
ok('the score never goes below 0');

const high = { research_gleanings: g, source_logs: 'A · x\nB · y', experiment_results: '' };
assert.equal(cs.score(high).score, 70);
let gt = cs.gate(high, 'pilot');
assert.equal(gt.allowed, true);
gt = cs.gate(high, 'actuation');
assert.equal(gt.allowed, false); assert.match(gt.missing.join(), /no recorded experiment result/);
ok('High with no experiment result passes the pilot gate and fails the actuation gate, naming why');

gt = cs.gate({ ...high, missing_research_count: 1 }, 'pilot');
assert.equal(gt.allowed, false); assert.match(gt.missing.join(), /band is Medium/); assert.match(gt.missing.join(), /1 open research question/);
ok('an open question fails the pilot gate, and names both the band and the question');

assert.equal(cs.gatedAction({ lane_state: 'pilot_running' }), 'pilot');
assert.equal(cs.gatedAction({ pilot_state: 'pilot_live' }), 'pilot');
assert.equal(cs.gatedAction({ lane_state: 'needs_revision', pilot_state: 'pilot_failed' }), null);
ok('only a move into pilot_running or pilot_live is a gated action');

(async () => {
  const patched = [];
  const rows = [{ id: '1', fields: high }, { id: '2', fields: cs.annotate({}) }];
  const r = await cs.backfill({ rows: async () => rows, patch: async (id, p) => { patched.push(id); rows.find((x) => x.id === id).fields = { ...rows.find((x) => x.id === id).fields, ...p }; } });
  assert.deepEqual(patched, ['1']); assert.equal(r.updated, 1); assert.equal(r.unchanged, 1); assert.equal(r.bands.High, 1);
  const again = await cs.backfill({ rows: async () => rows, patch: async () => { throw new Error('should not patch'); } });
  assert.equal(again.updated, 0); assert.equal(again.unchanged, 2);
  ok('the backfill writes only cards whose stored score differs, and a second run changes nothing');
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
