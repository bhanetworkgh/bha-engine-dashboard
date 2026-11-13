/**
 * The acceptance check (acceptanceCheck.ts, 13 Nov 2026): the validator's first caller. Pure parts only:
 * the digest, the reference checks against facts handed in, the event detail, and that the event type
 * cannot be posted from outside. No database, no network.
 *   SERVER_DIST=<built server> node server/test/acceptance-check.test.cjs
 * The record below is the real one run in production: Hardik's green acceptance pass on the Stripe
 * payment path (CG-1793247501592-59M7), loop LOOP-1792827895094-JD68, his bundle and the live USD 1.00
 * evidence. The facts are typed in here; the production run reads them from the database.
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
const ac = require(path.join(DIST, 'server/src', 'acceptanceCheck.js'));
const ae = require(path.join(DIST, 'server/src', 'acceptanceEvidence.js'));
const ev = require(path.join(DIST, 'server/src', 'engineEvents.js'));

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };

const record = {
  gate_id: 'CG-1793247501592-59M7',
  loop_id: 'LOOP-1792827895094-JD68',
  runtime_verification_status: 'runtime_proof',
  acceptance_pass: false,
  actor_id: 'U0AEW3TBYH1',
  approver_id: 'U0BKT6MAW2Y',
  closure_state: 'TECH_ONLY',
  contract_evidence_refs: ['EV-1793222643594-35TG'],
  implementation_evidence_refs: ['EV-1793222642623-6RKW'],
  decision_link: 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793246611879339',
  proof_type: 'test_forced',
};
const facts = {
  gate: { gate_id: 'CG-1793247501592-59M7', kind: 'acceptance_pass', verdict: 'green', test: false, decided_by: 'U0BKT6MAW2Y', recorded_by: 'U0AEW3TBYH1', evidence_channel: 'C0ASMPYQLG3', evidence_ts: '1793246611.879339', bundle_ref: 'EV-1793222643594-35TG' },
  loop: { natural_id: 'LOOP-1792827895094-JD68', status: 'In Progress', builder_id: 'destiny', assignee: 'U0AEW3TBYH1' },
  evidence: {
    'EV-1793222643594-35TG': { evidence_id: 'EV-1793222643594-35TG', name: 'stripe-honest-gate-acceptance-bundle-v1', test: false, gate: 'charge_gate', loop_id: 'LOOP-1792827895094-JD68', superseded_by: null },
    'EV-1793222642623-6RKW': { evidence_id: 'EV-1793222642623-6RKW', name: 'stripe-live-1usd-acceptance-e01', test: false, gate: 'charge_gate', loop_id: 'LOOP-1792827895094-JD68', superseded_by: null },
  },
};

// 1. the digest ignores key order and sees every change
const shuffled = Object.fromEntries(Object.entries(record).reverse());
assert.equal(ac.digestOf(record), ac.digestOf(shuffled));
assert.notEqual(ac.digestOf(record), ac.digestOf({ ...record, closure_state: 'LOOP_ACCEPTED' }));
assert.match(ac.digestOf(record), /^[0-9a-f]{64}$/);
ok('one record, one digest, whatever the key order; any change is a new digest');

// 2. the real record: every reference held
const refs = ac.referenceChecks(record, facts);
assert.deepEqual(refs.map((r) => [r.reference, r.result]), [
  ['gate_id', 'held'], ['decision_link', 'held'], ['approver_id', 'held'], ['actor_id', 'held'], ['loop_id', 'held'],
  ['contract_evidence_refs:EV-1793222643594-35TG', 'held'], ['implementation_evidence_refs:EV-1793222642623-6RKW', 'held'],
]);
ok('the real record: gate, its message, approver, recorder, loop and both EVs are held');

// 3. a wrong approver, a wrong message, a missing loop and a test EV are each named
const bad = ac.referenceChecks(
  { ...record, approver_id: 'U0A9V97949F', decision_link: 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793246611879340' },
  { ...facts, loop: null, evidence: { ...facts.evidence, 'EV-1793222642623-6RKW': { ...facts.evidence['EV-1793222642623-6RKW'], test: true } } },
);
const byRef = Object.fromEntries(bad.map((r) => [r.reference, r.result]));
assert.equal(byRef.approver_id, 'mismatch');
assert.equal(byRef.decision_link, 'mismatch');
assert.equal(byRef.loop_id, 'not_held');
assert.equal(byRef['implementation_evidence_refs:EV-1793222642623-6RKW'], 'test_record');
assert.equal(ac.referenceChecks({ ...record, gate_id: 'CG-1793247501592-ZZZZ' }, { ...facts, gate: null })[0].result, 'not_held');
ok('a wrong approver or message is a mismatch, a missing loop or gate is not held, a test EV is named');

// 4. the event detail never authorizes, whatever the record asks
const asked = { ...record, acceptance_pass: true };
const d = ac.eventDetail(asked, ae.check(asked), refs, ac.digestOf(asked));
for (const k of ['acceptance_pass_allowed', 'eligible_for_persistence', 'acceptance_eligible', 'authorizes', 'can_charge_live', 'acceptance_record_saved']) assert.equal(d[k], false, k);
assert.equal(d.acceptance_pass_requested, true);
assert.ok(d.issues.some((i) => i.code === 'acceptance_pass_not_verifiable_here'));
assert.ok(d.blocked_by.length > 0);
ok('acceptance_pass = true is refused by the validator and every authorizing field is the literal false');

// 5. the real record through the validator: well-formed, still blocked (no combination is approved yet)
const r = ae.check(record);
assert.equal(r.structurally_valid, true, JSON.stringify(r.issues));
assert.equal(r.eligible_for_persistence, false);
assert.ok(r.blocked_by.length > 0);
ok('the real record is well-formed and still blocked, as the validator is built to say');

// 6. nobody outside the dashboard can post the check's event
assert.ok(ev.externalRefusal('acceptance_evidence_checked'));
assert.ok(ev.externalRefusal('acceptance_evidence_recorded'));
ok('acceptance_evidence_checked is in-process only, beside the reserved acceptance_evidence_recorded');

console.log(`acceptance-check: ${n} checks passed`);
