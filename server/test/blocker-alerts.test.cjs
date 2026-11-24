/**
 * Blocker alerts (24 Nov 2026, Destiny): who a blocked loop is waiting on, read from its own "Blocked By".
 *
 * Pure parts only, no database. The texts are real "Blocked By" values held on 24 Nov 2026. What is pinned:
 *   - "Name: what" names the person before the colon, and a ";" clause each;
 *   - with no colon, the words before "(" name the person, and so does a bracket of names only;
 *   - a bracket of prose, a vendor, a part arriving or "none named" tags nobody;
 *   - the post tags the person, names each loop by its last four, and asks why and when;
 *   - the round is due Monday and Friday from 14:00 UTC only.
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
const b = require(path.join(DIST, 'server/src/blockerAlerts.js'));
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

const PEOPLE = [
  { id: 'U0A9V97949F', name: 'Jason Bays' },
  { id: 'U0AEW3TBYH1', name: 'Destiny Arupi' },
  { id: 'U0AF011R821', name: 'Jegan' },
  { id: 'U_KAVIN', name: 'Kavin' },
  { id: 'U_HARDIK', name: 'Hardik Bhatt' },
  { id: 'U0AC6RFNP3P', name: 'Ahad' },
];
const who = (t) => b.blockersNamed(t, PEOPLE).map((p) => p.name).sort();

assert.deepEqual(who('Jason: his yes on the AUTO_REUSE plan'), ['Jason Bays']);
assert.deepEqual(who('LOOP-1794416320069-UN0Y (Jegan): PR #109 merge; Destiny: answers to the five open envelope questions'), ['Destiny Arupi', 'Jegan']);
assert.deepEqual(who('Jegan and Kavin: lock the first version of the vFarm Asset Manifest'), ['Jegan', 'Kavin']);
ok('a colon names the person before it, one clause at a time');

assert.deepEqual(who('Jason Bays (authorized reviewer for KMG9 RAG acceptance)'), ['Jason Bays']);
assert.deepEqual(who('Jegan (confirm composite index applied, with exact SQL and table name)'), ['Jegan']);
assert.deepEqual(who('Sample video approval (Jason) and confirmation of provider eligibility'), ['Jason Bays']);
assert.deepEqual(who('Separate approval (Destiny or Jason) for the Context Harvester correction'), ['Destiny Arupi', 'Jason Bays']);
ok('with no colon, the head or a bracket of names says who');

assert.deepEqual(who("Tello support's answer on the 5862 line's history (Hardik's email, 19 Nov)"), []);
assert.deepEqual(who('DFRobot DFR0300 EC sensor arriving'), []);
assert.deepEqual(who('A reviewer for the ordering-bug fix (none named)'), []);
assert.deepEqual(who('TikTok lockout clearing (Destiny binds TikTok after)'), []);
assert.deepEqual(who('Fabricator: confirm the aluminum arm sections'), []);
ok('prose in a bracket, a vendor or a part tags nobody');

const text = 'LOOP-1794416320069-UN0Y (Jegan): PR #109 merge; Destiny: answers to the five open envelope questions';
assert.equal(b.whatIsNeeded(text, PEOPLE[1]), 'answers to the five open envelope questions');
assert.equal(b.whatIsNeeded(text, PEOPLE[2]), 'PR #109 merge');
ok('each person is shown only what is waiting on them');

const loop = { loop_id: 'LOOP-1788320149597-RSA1', title: 'Envelope contract', status: 'Open', blocked_by: text, unblock_date: '2026-11-20', late: true, days_late: 4, lane: 'VFARM', tag: null, why: null, owner: 'Jegan', link: 'https://dashboard.bhanetwork.org/open-loops/LOOP-1788320149597-RSA1' };
const post = b.postText(PEOPLE[1], [loop]);
assert.match(post, /^<@U0AEW3TBYH1> this loop is waiting on you/);
assert.match(post, /\|RSA1>/);
assert.match(post, /why it's held and when you can clear it/);
assert.match(post, /4 days late/);
assert.doesNotMatch(post, /PR #109/);
ok('the post tags the person, names the loop and asks why and when');

assert.equal(b.isDue(new Date('2026-11-23T14:00:00Z')), true); // Monday
assert.equal(b.isDue(new Date('2026-11-23T13:59:00Z')), false);
assert.equal(b.isDue(new Date('2026-11-27T18:00:00Z')), true); // Friday
assert.equal(b.isDue(new Date('2026-11-24T15:00:00Z')), false); // Tuesday
ok('due Monday and Friday from 14:00 UTC only');

console.log(`blocker alerts: ${passed} passed`);
