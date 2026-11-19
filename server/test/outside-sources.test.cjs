// Genie rebuild 8.8: the source score rule (server/src/outsideSources.ts), pure, no database.
const assert = require('node:assert/strict');
const { decide, bare, RULE } = require('../../server-dist/server/src/outsideSources.js');

const now = new Date('2026-11-19T10:00:00Z');
const S = (id, cited, used, created = '2026-11-01T00:00:00Z', every = 24) => ({ id, kind: 'rss', url: `https://x/${id}`, active: true, every_hours: every, base_every_hours: 24, created_at: created, cited, used });
const src = [S('a', 10, 2), S('b', 1, 0), S('c', 0, 0), S('d', 5, 0, '2026-11-15T00:00:00Z'), S('e', 2, 1), S('f', 0, 0, '2026-11-01T00:00:00Z', 12), S('g', 4, 0)];
const at = (days, when = now) => Object.fromEntries(decide(src, { now: when, history_days: days }).map((d) => [d.source_id, d]));

let r = at(5);
assert.equal(r.a.action, 'faster'); assert.equal(r.a.to_hours, 12);
assert.equal(r.e.action, 'faster', 'a tie at the cut is in the top quarter');
assert.equal(r.d.action, 'none', 'a source younger than a week is not judged');
assert.equal(r.c.action, 'none', 'nothing cited with only 5 days of digests: left at its pace');
assert.equal(r.f.action, 'base', 'a source off its usual pace is put back when it no longer earns it');
r = at(20);
assert.equal(r.c.action, 'slower'); assert.equal(r.c.to_hours, 48);
r = at(40, new Date('2026-12-10T00:00:00Z'));
assert.equal(r.c.action, 'retire');
assert.ok(r.c.reason.includes(`${RULE.retire_after_days} days`));
assert.equal(bare('https://a.example/x/?utm=1&y=2#top'), 'https://a.example/x');
console.log('outside-sources: 10 checks passed');
