/**
 * Acceptance-State Contract v0, structural check only (C1, 11 Nov 2026; SOP 2b794599).
 * A TEMPORARY contract-alignment module: pure, called by nothing, never authorizing.
 * Pure test: no database, no network, no Slack. Every identifier below is SYNTHETIC: the shapes are
 * real, the records are not, and nothing here says any of them exists.
 * Run with:  npm run test:acceptance-state-v0   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

// ---------------------------------------------------------------- 19: no database, no network
const attempts = [];
const refuse = (what) => function () { attempts.push(what); throw new Error(`network refused in this test: ${what}`); };
net.Socket.prototype.connect = refuse('net.Socket.connect');
net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
http.request = refuse('http.request');
http.get = refuse('http.get');
https.request = refuse('https.request');
https.get = refuse('https.get');
dns.lookup = refuse('dns.lookup');
globalThis.fetch = refuse('fetch');
delete process.env.DATABASE_URL;

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
// The PR #23 validator is loaded first and read before v0 exists, so check 13 can show v0 changes nothing in it.
const ae = require(path.join(DIST, 'server/src', 'acceptanceEvidence.js'));
const V1_VALID = Object.freeze({
  loop_id: 'LOOP-1700000000000-TST1',
  evidence_ref: 'EV-1700000000001-TST2',
  runtime_verification_status: 'Satisfied',
  approver_id: 'U0TESTAPPR1',
  closure_state: 'TECH_ONLY',
  decision_link: 'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456',
});
const v1Before = JSON.stringify(ae.check(V1_VALID));
const v1RulesBefore = JSON.stringify(ae.RULES);

const v0 = require(path.join(DIST, 'server/src', 'acceptanceStateV0.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const VALID = Object.freeze({
  gate_id: 'CG-1700000000002-TST3',
  loop_id: 'LOOP-1700000000000-TST1',
  runtime_verification_status: 'runtime_proof',
  acceptance_pass: false,
  actor_id: 'U0TESTACTR1',
});
const FOUR = ['unresolved', 'contract_pass', 'implementation_pass', 'runtime_proof'];
const codes = (r) => r.issues.map((i) => `${i.field}:${i.code}`);
const onField = (r, f) => r.issues.filter((i) => i.field === f).map((i) => i.code);
const without = (k) => { const o = { ...VALID }; delete o[k]; return o; };
const STANDING = ['temporary_module_not_canonical', 'contract_questions_open', 'references_not_verified', 'no_trusted_writer'];
const all = []; // every result produced, for check 18

function check(input) {
  const r = v0.checkV0(input);
  all.push(r);
  return r;
}

// The result's keys, written out here rather than read from the module, so a field the module adds
// (an `allowed: true`, say) fails the run instead of passing unseen.
const EXPECTED_KEYS = Object.freeze([
  'acceptance_pass_allowed', 'acceptance_pass_blocked_by', 'acceptance_pass_requested', 'authorizes', 'blocked_by',
  'can_charge_live', 'contract', 'contract_sop', 'eligible_for_persistence', 'issues', 'module_status', 'normalised',
  'provisional_rules_applied', 'references_verified', 'runtime_verification_status', 'structurally_valid', 'unverified_references',
]);
// Every issue code the module documents (IssueCodeV0), written out independently.
const ISSUE_CODES = Object.freeze([
  'not_an_object', 'missing', 'bad_loop_id', 'bad_gate_id', 'gate_id_format_undefined', 'bad_status', 'unknown_status_value',
  'v1_status_value', 'bad_acceptance_pass', 'acceptance_pass_requires_runtime_proof', 'acceptance_pass_not_verifiable_here',
  'bad_actor_id', 'actor_bot_id_shape', 'bad_delegation_ref', 'v1_field_not_mapped', 'legacy_field_not_mapped', 'unknown_field',
]);

function exactShape(r, label) {
  const keys = Object.keys(r).sort();
  const extra = keys.filter((k) => !EXPECTED_KEYS.includes(k));
  const gone = EXPECTED_KEYS.filter((k) => !keys.includes(k));
  assert.deepEqual({ extra, gone }, { extra: [], gone: [] }, `${label}: unexpected result keys`);
}

function neverAuthorizes(r, label) {
  exactShape(r, label);
  assert.equal(r.acceptance_pass_allowed, false, `${label}: acceptance_pass never allowed`);
  assert.equal(r.eligible_for_persistence, false, `${label}: never persistable`);
  assert.equal(r.authorizes, false, `${label}: never authorizes`);
  assert.equal(r.can_charge_live, false, `${label}: never opens live charging`);
  assert.equal(r.references_verified, false, `${label}: references never verified here`);
  assert.equal(r.module_status, 'temporary_contract_alignment', `${label}: temporary module`);
  assert.equal(r.contract_sop, '2b794599-7862-4da7-b2bc-45d33f79aa52', `${label}: cites the contract SOP`);
  for (const b of STANDING) assert.ok(r.blocked_by.includes(b), `${label}: blocked_by names ${b}`);
}

// ---------------------------------------------------------------- 1: a minimal valid record
{
  const r = check(VALID);
  assert.deepEqual(r.issues, [], codes(r).join(', '));
  assert.equal(r.structurally_valid, true);
  assert.equal(r.runtime_verification_status, 'runtime_proof');
  assert.equal(r.acceptance_pass_requested, false);
  assert.deepEqual(r.acceptance_pass_blocked_by, [], 'nothing to block when true was not asked for');
  assert.deepEqual(r.normalised, { ...VALID, delegation_ref: null });
  assert.ok(!r.blocked_by.includes('structural_issues'));
  assert.ok(!r.blocked_by.includes('acceptance_pass_not_allowed'));
  assert.deepEqual(r.provisional_rules_applied, ['actor_not_bot_id', 'actor_shape', 'gate_id_format']);
  neverAuthorizes(r, 'valid');
  ok('1 a well-formed v0 record with acceptance_pass false is structurally valid, and still allowed, persisted and authorized nothing');
}

// ---------------------------------------------------------------- 2: the four values, exactly
{
  assert.deepEqual([...v0.RUNTIME_VERIFICATION_STATUS_V0], FOUR, 'exactly the SOP §3 list, in its order');
  assert.ok(Object.isFrozen(v0.RUNTIME_VERIFICATION_STATUS_V0));
  for (const s of FOUR) {
    const r = check({ ...VALID, runtime_verification_status: s });
    assert.equal(r.structurally_valid, true, `${s}: ${codes(r)}`);
    assert.equal(r.runtime_verification_status, s);
    neverAuthorizes(r, s);
  }
  ok('2 each of unresolved, contract_pass, implementation_pass and runtime_proof is accepted exactly, and no other value is listed');
}

// ---------------------------------------------------------------- 3: near misses refused
{
  for (const bad of ['Runtime_Proof', 'RUNTIME_PROOF', 'runtime-proof', ' runtime_proof', 'runtime_proof ', 'passed', 'proven', 'contract pass', 'pass']) {
    const r = check({ ...VALID, runtime_verification_status: bad });
    assert.deepEqual(onField(r, 'runtime_verification_status'), ['unknown_status_value'], `${JSON.stringify(bad)}: ${codes(r)}`);
    assert.equal(r.runtime_verification_status, null, 'never derived or corrected');
    assert.equal(r.normalised, null);
  }
  for (const bad of [42, true, {}, [], '   ', 'x'.repeat(121)]) {
    assert.deepEqual(onField(check({ ...VALID, runtime_verification_status: bad }), 'runtime_verification_status'), ['bad_status'], JSON.stringify(bad));
  }
  assert.deepEqual(onField(check(without('runtime_verification_status')), 'runtime_verification_status'), ['missing']);
  ok('3 re-cased, padded, hyphenated or invented status values are refused, never trimmed or corrected');
}

// ---------------------------------------------------------------- 4: PR #23 vocabulary named, not translated
{
  for (const v of [...ae.TECHNICAL_STATUSES, ...ae.ACCEPTANCE_STATES]) {
    const r = check({ ...VALID, runtime_verification_status: v });
    const i = r.issues.find((x) => x.field === 'runtime_verification_status');
    assert.equal(i.code, 'v1_status_value', `${v}: ${codes(r)}`);
    assert.equal(i.rule, 'v1_not_mapped');
    assert.match(i.message, /never translated/);
    assert.match(i.message, /f7720fc0/);
    assert.equal(r.runtime_verification_status, null, `${v} is never mapped to a v0 value`);
  }
  ok('4 Satisfied, Not Satisfied, Not Verified, TECH_ONLY, LOOP_ACCEPTED and COMMERCIAL_OK are refused by name as PR #23 values, never mapped');
}

// ---------------------------------------------------------------- 5: acceptance_pass is a real boolean
{
  for (const bad of ['true', 'false', 1, 0, 'yes', {}, []]) {
    const r = check({ ...VALID, acceptance_pass: bad });
    assert.deepEqual(onField(r, 'acceptance_pass'), ['bad_acceptance_pass'], JSON.stringify(bad));
    assert.equal(r.acceptance_pass_requested, null);
    neverAuthorizes(r, JSON.stringify(bad));
  }
  assert.deepEqual(onField(check({ ...VALID, acceptance_pass: null }), 'acceptance_pass'), ['missing']);
  assert.deepEqual(onField(check(without('acceptance_pass')), 'acceptance_pass'), ['missing']);
  ok('5 acceptance_pass given as a string, number, object or null, or left out, is refused');
}

// ---------------------------------------------------------------- 6: true needs runtime_proof
{
  for (const s of ['unresolved', 'contract_pass', 'implementation_pass']) {
    const r = check({ ...VALID, runtime_verification_status: s, acceptance_pass: true });
    assert.deepEqual(onField(r, 'acceptance_pass'), ['acceptance_pass_requires_runtime_proof'], `${s}: ${codes(r)}`);
    assert.equal(r.issues.find((i) => i.field === 'acceptance_pass').rule_status, 'sop');
    assert.ok(r.acceptance_pass_blocked_by.includes('runtime_proof_required'), s);
    neverAuthorizes(r, s);
  }
  ok('6 acceptance_pass true with unresolved, contract_pass or implementation_pass is refused by the SOP §4 rule');
}

// ---------------------------------------------------------------- 7: true with runtime_proof is still refused
{
  const r = check({ ...VALID, acceptance_pass: true });
  assert.deepEqual(onField(r, 'acceptance_pass'), ['acceptance_pass_not_verifiable_here'], codes(r).join(', '));
  assert.equal(r.structurally_valid, false, 'the SOP says the validator must reject true without verified authorization');
  assert.equal(r.acceptance_pass_requested, true);
  assert.deepEqual(r.acceptance_pass_blocked_by, [
    'contract_evidence_not_verified', 'implementation_evidence_not_verified', 'authorization_not_verified',
    'evidence_fields_undefined', 'gate_authority_undefined', 'no_trusted_writer',
  ]);
  assert.ok(!r.acceptance_pass_blocked_by.includes('runtime_proof_required'));
  assert.ok(r.blocked_by.includes('acceptance_pass_not_allowed'));
  assert.equal(r.normalised, null);
  neverAuthorizes(r, 'runtime_proof + true');
  ok('7 acceptance_pass true with runtime_proof is refused, naming the unverified evidence and authority and the undefined contract parts');
}

// ---------------------------------------------------------------- 8: delegation never enough here
{
  const d = check({ ...VALID, delegation_ref: 'EV-1700000000003-TST4' });
  assert.equal(d.structurally_valid, true, codes(d).join(', '));
  assert.equal(d.normalised.delegation_ref, 'EV-1700000000003-TST4');
  assert.ok(d.provisional_rules_applied.includes('delegation_ref_shape'));
  neverAuthorizes(d, 'delegation, false');

  const t = check({ ...VALID, acceptance_pass: true, delegation_ref: 'EV-1700000000003-TST4' });
  assert.equal(t.structurally_valid, false);
  assert.ok(t.acceptance_pass_blocked_by.includes('delegation_record_unverified'));
  assert.ok(t.acceptance_pass_blocked_by.includes('authorization_not_verified'), 'a delegation_ref is not a verified authorization');
  neverAuthorizes(t, 'delegation, true');

  for (const bad of ['https://drive.google.com/x', 'U0TESTDLGT1', 'CG-1700000000002-TST3', 'EV-1', 42, {}]) {
    const r = check({ ...VALID, delegation_ref: bad });
    assert.deepEqual(onField(r, 'delegation_ref'), ['bad_delegation_ref'], JSON.stringify(bad));
    assert.match(r.issues.find((i) => i.field === 'delegation_ref').message, /provisional rule, awaiting decision/);
  }
  assert.deepEqual(onField(check({ ...VALID, delegation_ref: null }), 'delegation_ref'), [], 'null is absent');
  ok('8 a well-formed delegation_ref passes shape only and never satisfies authorization; a malformed one is refused on a provisional rule');
}

// ---------------------------------------------------------------- 9 and 10: the §4 statement
{
  const F = ['contract_evidence_verified', 'implementation_evidence_verified', 'authorization_verified'];
  let met = 0;
  for (const status of [...FOUR, 'Satisfied', null, undefined, 'RUNTIME_PROOF']) {
    for (let mask = 0; mask < 8; mask += 1) {
      const facts = {};
      F.forEach((f, i) => { facts[f] = Boolean(mask & (1 << i)); });
      const d = v0.acceptancePassDecision(status, facts);
      assert.equal(d.authorizes, false, 'never authorizes');
      const expected = status === 'runtime_proof' && mask === 7;
      assert.equal(d.meets_sop_conditions, expected, `${status} ${mask}`);
      assert.equal(d.unmet.length === 0, expected);
      if (expected) met += 1;
      if (status !== 'runtime_proof') assert.equal(d.unmet[0], 'runtime_proof_required');
    }
  }
  assert.equal(met, 1, 'exactly one of the combinations meets the conditions');
  // Only the boolean true counts as verified: a truthy claim is not.
  const UNMET = { contract_evidence_verified: 'contract_evidence_not_verified', implementation_evidence_verified: 'implementation_evidence_not_verified', authorization_verified: 'authorization_not_verified' };
  for (const f of F) {
    for (const truthy of ['true', 1, 'yes', {}, [true]]) {
      const facts = { contract_evidence_verified: true, implementation_evidence_verified: true, authorization_verified: true, [f]: truthy };
      const d = v0.acceptancePassDecision('runtime_proof', facts);
      assert.equal(d.meets_sop_conditions, false, `${f}=${JSON.stringify(truthy)}`);
      assert.deepEqual(d.unmet, [UNMET[f]], `${f}=${JSON.stringify(truthy)}`);
    }
  }
  assert.deepEqual(v0.acceptancePassDecision('runtime_proof').unmet, ['contract_evidence_not_verified', 'implementation_evidence_not_verified', 'authorization_not_verified']);
  // checkV0 never consults caller-supplied facts: putting them in the record is refused, not used.
  const smuggled = check({ ...VALID, acceptance_pass: true, contract_evidence_verified: true, implementation_evidence_verified: true, authorization_verified: true });
  for (const f of F) assert.deepEqual(onField(smuggled, f), ['unknown_field'], f);
  assert.ok(smuggled.acceptance_pass_blocked_by.includes('authorization_not_verified'));
  neverAuthorizes(smuggled, 'smuggled facts');
  ok('9 acceptancePassDecision meets the SOP conditions only for runtime_proof with all three facts exactly true, and authorizes nothing');
  ok('10 any status but runtime_proof never meets them; truthy claims and facts placed in a record are not verification');
}

// ---------------------------------------------------------------- 11: gate_id
{
  assert.deepEqual(onField(check(without('gate_id')), 'gate_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, gate_id: '' }), 'gate_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, gate_id: '   ' }), 'gate_id'), ['bad_gate_id']);
  assert.deepEqual(onField(check({ ...VALID, gate_id: 42 }), 'gate_id'), ['bad_gate_id']);
  for (const other of ['media-twin', 'VFARM_STAGE1', 'GATE-1700000000004-TST5', 'cg-1700000000002-tst3']) {
    const r = check({ ...VALID, gate_id: other });
    const i = r.issues.find((x) => x.field === 'gate_id');
    assert.equal(i.code, 'gate_id_format_undefined', other);
    assert.equal(i.rule_status, 'provisional');
    assert.match(i.message, /provisional rule, awaiting decision/);
  }
  assert.equal(check(VALID).normalised.gate_id, 'CG-1700000000002-TST3');
  ok('11 gate_id is required; a charge-gate id is recognised and any other gate id is refused on a provisional rule');
}

// ---------------------------------------------------------------- 11b: loop_id
{
  assert.deepEqual(onField(check(without('loop_id')), 'loop_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, loop_id: '' }), 'loop_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, loop_id: null }), 'loop_id'), ['missing']);
  for (const bad of ['LOOP-1', 'loop-1700000000000-tst1', 'LOOP-1700000000000-tst1', 'SMQZ', 'LOOP-1700000000000-TST', 'LOOP-1700000000000-TST1 ', 42, 1700000000000, {}, []]) {
    const r = check({ ...VALID, loop_id: bad });
    assert.deepEqual(onField(r, 'loop_id'), ['bad_loop_id'], `${JSON.stringify(bad)}: ${codes(r)}`);
    const i = r.issues.find((x) => x.field === 'loop_id');
    assert.equal(i.rule, 'loop_id_shape');
    assert.equal(i.rule_status, 'sop');
    assert.equal(r.normalised, null);
    neverAuthorizes(r, JSON.stringify(bad));
  }
  assert.equal(check(VALID).normalised.loop_id, 'LOOP-1700000000000-TST1');
  ok('11b loop_id is required; LOOP-1, lower case, a bare suffix like SMQZ, a padded id, numbers and objects are refused as bad_loop_id');
}

// ---------------------------------------------------------------- 12: actor_id
{
  assert.deepEqual(onField(check(without('actor_id')), 'actor_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, actor_id: 'B0TESTBOT01' }), 'actor_id'), ['actor_bot_id_shape']);
  for (const bad of ['u0testactr1', 'Hardik', 'U0', 42, {}]) assert.deepEqual(onField(check({ ...VALID, actor_id: bad }), 'actor_id'), ['bad_actor_id'], JSON.stringify(bad));
  assert.equal(check({ ...VALID, actor_id: 'W0TESTACTR2' }).structurally_valid, true);
  const i = check({ ...VALID, actor_id: 'Hardik' }).issues.find((x) => x.field === 'actor_id');
  assert.equal(i.rule_status, 'provisional');
  ok('12 actor_id is required; a bot-shaped or non-Slack-id actor is refused on a provisional shape rule');
}

// ---------------------------------------------------------------- 13: PR #23 fields refused, PR #23 unchanged
{
  for (const [k, v] of Object.entries({ closure_state: 'TECH_ONLY', approver_id: 'U0TESTAPPR1', evidence_ref: 'EV-1700000000001-TST2', gate_ref: 'CG-1700000000002-TST3', decision_link: V1_VALID.decision_link, run_ref: {}, proof_type: 'test_forced', supersedes: 'AE-1700000000005-TST6', notes: 'x', test: true })) {
    const r = check({ ...VALID, [k]: v });
    const i = r.issues.find((x) => x.field === k);
    assert.equal(i.code, 'v1_field_not_mapped', k);
    assert.equal(i.rule, 'v1_not_mapped');
    assert.equal(r.normalised, null, `${k} is never carried through`);
  }
  // approver_id is not read as actor_id, and gate_ref not as gate_id.
  assert.deepEqual(onField(check({ ...without('actor_id'), approver_id: 'U0TESTAPPR1' }), 'actor_id'), ['missing']);
  assert.deepEqual(onField(check({ ...without('gate_id'), gate_ref: 'CG-1700000000002-TST3' }), 'gate_id'), ['missing']);
  // A whole PR #23 record is refused under v0, and the PR #23 validator still passes it, unchanged.
  const asV0 = check(V1_VALID);
  assert.equal(asV0.structurally_valid, false);
  for (const k of ['closure_state', 'approver_id', 'evidence_ref', 'decision_link']) assert.ok(onField(asV0, k).includes('v1_field_not_mapped'), k);
  assert.deepEqual(onField(asV0, 'runtime_verification_status'), ['v1_status_value']);
  assert.equal(ae.check(V1_VALID).structurally_valid, true, 'PR #23 still accepts its own record');
  assert.equal(JSON.stringify(ae.check(V1_VALID)), v1Before, 'PR #23 result identical before and after v0 loaded and ran');
  assert.equal(JSON.stringify(ae.RULES), v1RulesBefore, 'PR #23 rules untouched');
  assert.deepEqual([...ae.TECHNICAL_STATUSES], ['Satisfied', 'Not Satisfied', 'Not Verified']);
  assert.deepEqual([...ae.ACCEPTANCE_STATES], ['TECH_ONLY', 'LOOP_ACCEPTED', 'COMMERCIAL_OK']);
  ok('13 every PR #23 field is refused as not mapped, nothing is renamed, and the PR #23 validator answers exactly as before');
}

// ---------------------------------------------------------------- 14: legacy and unknown fields
{
  for (const k of ['owner_id', 'approval_status', 'evidence_reference']) {
    assert.deepEqual(onField(check({ ...VALID, [k]: 'x' }), k), ['legacy_field_not_mapped'], k);
  }
  for (const k of ['actor', 'gateId', 'acceptancePass', 'record_id', 'recorded_by', '__proto__x']) {
    assert.deepEqual(onField(check({ ...VALID, [k]: 'x' }), k), ['unknown_field'], k);
  }
  for (const bad of [null, undefined, 'x', 42, [], [VALID]]) {
    const r = check(bad);
    assert.deepEqual(codes(r), ['(record):not_an_object'], JSON.stringify(bad));
    neverAuthorizes(r, String(bad));
  }
  ok('14 legacy telemetry fields, unknown fields and non-objects are refused, never ignored');
}

// ---------------------------------------------------------------- 15: the historical gate row is not a v0 record
{
  // The shape of the one real charge-gate row CG-1793247501592-59M7 (synthetic values; SOP cd1ea717).
  const historical = { gate_id: 'CG-1700000000002-TST3', kind: 'acceptance_pass', rail: 'vfarm_stripe_live', verdict: 'green', decided_by: 'U0TESTACTR1', recorded_by: 'U0TESTRCDR1', bundle_ref: 'EV-1700000000001-TST2', evidence_link: V1_VALID.decision_link, test: false };
  const r = check(historical);
  assert.equal(r.structurally_valid, false);
  for (const f of ['loop_id', 'runtime_verification_status', 'acceptance_pass', 'actor_id']) assert.deepEqual(onField(r, f), ['missing'], f);
  for (const f of ['kind', 'verdict', 'decided_by', 'bundle_ref']) assert.deepEqual(onField(r, f), ['unknown_field'], f);
  assert.ok(!onField(r, 'decided_by').includes('v1_field_not_mapped'));
  assert.equal(r.normalised, null);
  neverAuthorizes(r, 'historical');
  ok('15 a charge-gate row shaped like CG-…-59M7 cannot pass as a v0 record; decided_by is not read as actor_id');
}

// ---------------------------------------------------------------- 16: input never changed, results never shared
{
  const input = { ...VALID, acceptance_pass: true, delegation_ref: 'EV-1700000000003-TST4', approver_id: 'U0TESTAPPR1' };
  const snapshot = JSON.stringify(input);
  Object.freeze(input);
  const r1 = check(input);
  assert.equal(JSON.stringify(input), snapshot, 'input unchanged');
  const r2 = check(input);
  assert.deepEqual(r1, r2, 'same input, same answer');
  r1.unverified_references.push('tampered');
  r1.blocked_by.push('tampered');
  r1.acceptance_pass_blocked_by.push('tampered');
  const r3 = check(input);
  assert.ok(!r3.unverified_references.includes('tampered'));
  assert.ok(!r3.blocked_by.includes('tampered'));
  assert.ok(!r3.acceptance_pass_blocked_by.includes('tampered'));
  assert.ok(Object.isFrozen(v0.RULES_V0) && Object.isFrozen(v0.V1_FIELDS) && Object.isFrozen(v0.UNVERIFIED_REFERENCES_V0) && Object.isFrozen(v0.V0_REQUIRED));
  assert.equal(r3.unverified_references.length, v0.UNVERIFIED_REFERENCES_V0.length);
  ok('16 a frozen input is read without being changed, the answer is repeatable, and results share nothing');
}

// ---------------------------------------------------------------- 17: always throws
{
  for (const input of [VALID, { ...VALID, acceptance_pass: true }, {}, null]) {
    assert.throws(() => v0.requireV0AcceptanceEligible(input), (e) => {
      assert.ok(e instanceof v0.AcceptanceStateV0Error);
      assert.equal(e.reason, 'not_acceptance_eligible');
      assert.match(e.message, /temporary_module_not_canonical/);
      neverAuthorizes(e.result, 'thrown');
      return true;
    });
  }
  ok('17 requireV0AcceptanceEligible throws for every input, a valid one included');
}

// ---------------------------------------------------------------- 20: every rule cites its source
{
  const expect = {
    v0_fields: 'sop', loop_id_shape: 'sop', gate_id_required: 'sop', status_vocabulary: 'sop', acceptance_pass_boolean: 'sop',
    acceptance_pass_requires_runtime_proof: 'sop', acceptance_pass_conditions: 'sop', actor_required: 'sop', delegation_unverified: 'sop',
    historical_not_rewritten: 'sop', no_live_money: 'sop',
    gate_id_format: 'provisional', actor_shape: 'provisional', actor_not_bot_id: 'provisional', delegation_ref_shape: 'provisional',
    v1_not_mapped: 'guard', legacy_not_mapped: 'guard', known_fields_only: 'guard', never_authorizes: 'guard',
  };
  assert.deepEqual(Object.keys(v0.RULES_V0).sort(), Object.keys(expect).sort());
  for (const [id, status] of Object.entries(expect)) assert.equal(v0.RULES_V0[id].status, status, id);
  for (const r of Object.values(v0.RULES_V0)) {
    if (r.status === 'sop') assert.match(r.source, /SOP [0-9a-f]{8}/, `${r.id} cites an SOP`);
    if (r.status === 'provisional') assert.match(r.source, /Awaiting|awaiting|C1 reading/, `${r.id} says it is a reading`);
    assert.ok(r.source.length > 10, r.id);
  }
  // Every issue across the run names a real rule, its true status, and says so when provisional.
  for (const res of all) {
    for (const i of res.issues) {
      assert.ok(v0.RULES_V0[i.rule], `${i.field}: rule ${i.rule} exists`);
      assert.equal(i.rule_status, v0.RULES_V0[i.rule].status, `${i.field}:${i.code}`);
      if (i.rule_status === 'provisional') assert.match(i.message, /provisional rule, awaiting decision/, i.field);
      else assert.doesNotMatch(i.message, /provisional rule/, i.field);
    }
  }
  assert.equal(v0.CONTRACT_SOP, '2b794599-7862-4da7-b2bc-45d33f79aa52');
  assert.equal(v0.MODULE_STATUS, 'temporary_contract_alignment');
  ok('20 every rule is sop, provisional or guard; SOP rules cite an SOP id and provisional rules say they await a decision');
}

// ---------------------------------------------------------------- 18: the fixed falses, over every result
{
  // Breadth is proved by coverage, not a count: the run must have produced every documented issue code.
  const seen = new Set(all.flatMap((r) => r.issues.map((i) => i.code)));
  assert.deepEqual(ISSUE_CODES.filter((c) => !seen.has(c)), [], 'every documented issue code was produced at least once');
  assert.deepEqual([...seen].filter((c) => !ISSUE_CODES.includes(c)), [], 'no undocumented issue code was produced');
  for (const r of all) {
    exactShape(r, 'sweep');
    assert.equal(r.acceptance_pass_allowed, false);
    assert.equal(r.eligible_for_persistence, false);
    assert.equal(r.authorizes, false);
    assert.equal(r.can_charge_live, false);
    assert.ok(r.blocked_by.length >= STANDING.length);
    if (r.acceptance_pass_requested === true) assert.ok(r.acceptance_pass_blocked_by.length > 0);
  }
  ok(`18 all ${ISSUE_CODES.length} issue codes were produced; every one of ${all.length} results has exactly the expected keys, with acceptance_pass_allowed, eligible_for_persistence, authorizes and can_charge_live false`);
}

// ---------------------------------------------------------------- 19 (end): nothing reached out
{
  assert.deepEqual(attempts, [], `network or database was attempted: ${attempts.join(', ')}`);
  const loaded = Object.keys(require.cache);
  const reached = loaded.filter((p) => /[\\/]node_modules[\\/]pg[\\/]|[\\/]server[\\/]src[\\/](pg|slack|engineEvents|evidence|chargeGate)\.js$/.test(p));
  assert.deepEqual(reached, [], `the module loaded ${reached.join(', ')}`);
  const own = loaded.filter((p) => p.includes(`${path.sep}server${path.sep}src${path.sep}`)).map((p) => path.basename(p)).sort();
  assert.deepEqual(own, ['acceptanceEvidence.js', 'acceptanceStateV0.js', 'proofType.js']);
  ok('19 no socket, request, lookup or fetch was attempted, and only the two validators and proofType were loaded');
}

console.log(`\n${n} checks passed`);
