/**
 * SE8L resolver recovery, pure checks. Run with: npm run test:se8l-resolver
 *
 * A resolver failure is filed under doctrine:genie_ns:MEDIA_DOCTRINE:RESOLVER, and claim reads never
 * carry that key, so the incident it opens could never close. resolver_ok is the healthy reading for
 * that key. These checks pin its shape and that policyFor() is unchanged: two healthy readings to
 * recover, and a second failure within 24 hours still opens an incident whatever came between
 * (the PROPOSED threshold — whether "2 failures" means 2 in a row is an open owner question).
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const gap = require(path.join(DIST, 'server/src/doctrineGap.js'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const at = (o, time, id) => ({ ...o, observed_at: time, observation_id: id });
const T = (m) => `2026-10-17T00:${String(m).padStart(2, '0')}:00.000Z`;

const failure = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_error: { message: 'connection refused' }, active_consumer: true });
const success = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_ok: { claims: 3 } });
const empty = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_ok: { claims: 0 } });

assert.equal(gap.RESOLVER_SURFACE, 'genie_ns');
assert.equal(failure.recovery_key, 'doctrine:genie_ns:MEDIA_DOCTRINE:RESOLVER');
assert.equal(success.recovery_key, failure.recovery_key);
assert.equal(empty.recovery_key, failure.recovery_key);
ok('resolver success and resolver failure share one recovery key, in the existing format');

assert.equal(success.condition, 'healthy');
assert.equal(success.reason, 'RESOLVER_READ_OK');
assert.equal(empty.condition, 'healthy');
assert.equal(empty.reason, 'RESOLVER_READ_OK_NO_CLAIMS');
assert.equal(success.doctrine_id, 'MEDIA_DOCTRINE');
assert.equal(success.claim_id, 'RESOLVER');
assert.equal(empty.config_hash_held, false);
assert.equal(empty.cad_provenance_held, false);
assert.equal(gap.guidanceFor(success).action, 'NONE');
ok('resolver_ok is healthy for the resolver only: RESOLVER_READ_OK, or RESOLVER_READ_OK_NO_CLAIMS when the read returned nothing, never a doctrine or claim id');

const withClaim = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_ok: { claims: 1 }, claim: { doctrine_id: 'B93H', claim_id: 'CAP-1' } });
assert.equal(withClaim.recovery_key, failure.recovery_key);
assert.equal(withClaim.claim_id, 'RESOLVER');
ok('a claim passed beside resolver_ok is ignored, so a resolver reading can never land on a claim key');

const errorWins = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_error: { message: 'down' }, resolver_ok: { claims: 1 } });
assert.equal(errorWins.condition, 'resolver_unavailable');
ok('a resolver_error outranks resolver_ok');

const f1 = at(failure, T(0), 'f1');
const f2 = at(failure, T(5), 'f2');
const h1 = at(success, T(10), 'h1');
const h2 = at(success, T(15), 'h2');
assert.equal(gap.policyFor(f2, [f1], Date.parse(T(5))).incident, true);
assert.equal(gap.policyFor(h1, [f1, f2], Date.parse(T(10))).recover, false);
assert.equal(gap.policyFor(h2, [f1, f2, h1], Date.parse(T(15))).recover, true);
assert.equal(gap.policyFor(at(empty, T(15), 'e2'), [f1, f2, h1], Date.parse(T(15))).recover, true);
ok('policyFor unchanged on the resolver key: two failures open, one healthy reading does not recover, the second does (a no-claims read counts as the resolver answering)');

const f3 = at(failure, T(20), 'f3');
const h3 = at(success, T(25), 'h3');
assert.equal(gap.policyFor(h3, [f1, f2, h1, f3], Date.parse(T(25))).recover, false);
ok('a failure between two healthy readings resets the count');

// Pins today's threshold, not a policy choice: two failures within 24 hours open an incident even
// with healthy readings between them. Owner question: 2 within 24 hours, or 2 in a row?
const isolated = gap.policyFor(at(failure, T(40), 'i2'), [at(failure, T(0), 'i1'), at(success, T(10), 'ih1'), at(success, T(20), 'ih2')], Date.parse(T(40)));
assert.equal(isolated.incident, true);
assert.equal(isolated.reason, 'RESOLVER_FAILURE_THRESHOLD_MET');
ok('existing threshold kept: a second failure within 24 hours opens an incident even after healthy readings (owner question, not changed here)');

console.log(`\n${passed} SE8L resolver checks passed.`);
