// Genie rebuild 10.10 to 10.12: the reuse check's match rule, the pattern demotion rule and the loop convergence rule. Pure, no database.
const assert = require('node:assert/strict');
const { judge, idsIn, summarise } = require('../../server-dist/server/src/reuseCheck.js');
const { demotes } = require('../../server-dist/server/src/patternTrust.js');
const conv = require('../../server-dist/server/src/loopConvergence.js');

// 10.10: a real overlap matches in either direction; generic words do not.
assert.equal(judge('add a retry with backoff to the daily digest slack post', 'Daily digest Slack post retry with backoff and alert').hit, true);
assert.equal(judge('fix the pay card layout', 'Daily digest Slack post retry with backoff and alert').hit, false);
assert.equal(judge('test run check build', 'test run check build').hit, false, 'stopwords alone never match');
assert.deepEqual(idsIn('extends BP-GENIEMED-1794922148538-0Q6O and LOOP-1794927443021-QA4U'), ['BP-GENIEMED-1794922148538-0Q6O', 'LOOP-1794927443021-QA4U']);
assert.ok(summarise([], false, 'db down').startsWith('Reuse check did not run: db down'), 'a check that did not run says so');
assert.ok(summarise([], true).includes('nothing on record'));

// 10.11: Genie's improved rule (distinct voters, exposure, recency); misrouted downs never count.
const ok = { shown: 20, downs: 5, voters: 3, last_up: null, last_down: '2026-11-19' };
assert.equal(demotes(ok).demote, true);
assert.equal(demotes({ ...ok, voters: 1 }).demote, false, 'five downs from one voter are one signal');
assert.equal(demotes({ ...ok, shown: 8 }).demote, false, 'too few showings to judge');
assert.equal(demotes({ ...ok, shown: 40 }).demote, false, 'under 20% of showings');
assert.equal(demotes({ ...ok, last_up: '2026-11-20' }).demote, false, 'an up after the latest down keeps it');

// 10.12: three progress posts and no close is a flag; a close after them is not.
assert.equal(conv.judge({ progress: 3, closed_since: false }), true);
assert.equal(conv.judge({ progress: 2, closed_since: false }), false);
assert.equal(conv.judge({ progress: 5, closed_since: true }), false);
console.log('build-trail: 15 checks passed');
