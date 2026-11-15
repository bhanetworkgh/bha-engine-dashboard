/**
 * /held-pay (15 Nov 2026, Destiny): the pure parts of heldPay.ts. No database and no network.
 * Run with:  npm run test:held-pay
 *
 *   1. A held note lists each held part with its share and what releases it (the part's own "missing").
 *   2. The log's date comes from its Submission ID.
 *   3. Names resolve from a mention, a Slack id or a first name; "all" is everyone; an unknown word is unknown.
 *   4. Nothing held reads as nothing held, never an empty list.
 *   5. A long list is cut under the Slack length cap and says how many were left out.
 *   6. Shares are shown as percent of a day; no money.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const h = require(path.join(DIST, 'server/src', 'heldPay.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const note = (o = {}) => ({
  submission_id: 'U0AC6RFNP3P_1794691177696', codex_entry_id: 'CODEX-20261114-ahad-vfarm-sensor-debug', builder_slack_id: 'U0AC6RFNP3P', builder: 'Ahad',
  held_share: 0.4, credited_share: 0.2, released_share: 0, docked_share: 0.4, reason_tag: 'RELOG_OLD_WORK', release_condition: 'the fix, merged', decided_at: '2026-11-15T10:22:06Z', released_parts: [],
  suggested: { parts: [
    { what: 'Evidence doc', status: 'live', score: 1, tag: 'BLOCKED_EXTERNAL', missing: [] },
    { what: 'admin.js fix', status: 'held', score: 0, tag: 'INSUFFICIENT_PROOF', missing: ['the fallback path writes a record'] },
    { what: 'Regression test', status: 'held', score: 0, tag: 'INSUFFICIENT_PROOF', missing: [], silent_failure: 'test copies the logic' },
  ] },
  ...o,
});

const it = h.itemFor(note());
assert.equal(it.parts.length, 2); assert.equal(it.parts[0].share + it.parts[1].share, 0.4);
assert.equal(it.parts[0].needs, 'the fallback path writes a record'); assert.equal(it.parts[1].needs, 'test copies the logic');
ok('each held part with its share and what releases it');

assert.equal(h.logDate(note()), '2026-11-14'); assert.equal(h.logDate({ submission_id: 'x', decided_at: '2026-11-12T10:00:00Z' }), '2026-11-12');
ok('the log date comes from its Submission ID, else when it was decided');

const people = [{ id: 'U0AC6RFNP3P', name: 'Ahad' }, { id: 'U0AEW3TBYH1', name: 'Destiny Arupi' }, { id: 'U0AF011R821', name: 'Jeganathan' }];
assert.equal(h.whoIsNamed('', people), null);
assert.equal(h.whoIsNamed('all', people), 'all');
assert.equal(h.whoIsNamed('<@U0AC6RFNP3P|ahad>', people).name, 'Ahad');
assert.equal(h.whoIsNamed('jegan', people).id, 'U0AF011R821');
assert.equal(h.whoIsNamed('destiny', people).id, 'U0AEW3TBYH1');
assert.equal(h.whoIsNamed('bob', people), 'unknown');
ok('a mention, a first name or "all"; an unknown word is unknown');

assert.match(h.personText(people[0], [], true), /no pay held/);
ok('nothing held says so');

const many = Array.from({ length: 40 }, (_, i) => h.itemFor(note({ submission_id: `U0AC6RFNP3P_17946${String(i).padStart(7, '0')}`, codex_entry_id: `CODEX-${i}-a-long-name-for-the-log-entry` })));
const t = h.personText(people[0], many, true);
assert.ok(t.length <= h.MAX_CHARS, `length ${t.length}`); assert.match(t, /more held logs?/);
ok('a long list stays under the Slack cap and says how many were left out');

const one = h.personText(people[0], [it], false);
assert.match(one, /Ahad has 40% of a day held/); assert.doesNotMatch(one, /\$/);
ok('percent of a day, no money');

const b = h.personBlocks(people[0], [it], true, null);
const lists = b.filter((x) => x.type === 'rich_text').flatMap((x) => x.elements);
assert.equal(lists.length, 4); assert.equal(lists[0].type, 'rich_text_list'); assert.equal(lists[1].indent, 1);
assert.match(JSON.stringify(lists[1]), /Needs: .*the fallback path/);
assert.ok(h.personBlocks(people[0], many, true, null).length <= 50);
ok('blocks: one bullet per held piece, what releases it nested under it, under 50 blocks');

console.log(`held-pay: ${n} checks passed`);
