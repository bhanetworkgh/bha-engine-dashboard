/**
 * The single canonical acceptance validator (acceptanceEvidence.ts), aligned to Acceptance-State
 * Contract v0 (SOP 2b794599) and Jason's 10 Nov rulings (SOPs d0606fb6, b3a349df, 8034ef06).
 * One test file: PR #23's checks that still hold, PR #24's v0 checks folded in, and the new SOP rules.
 * Pure: no database, no network, no Slack. Every identifier below is SYNTHETIC: the shapes are real,
 * the records are not, and nothing here says any of them exists. Two real ids are used because a rule
 * names them: Jason's Slack user id (COMMERCIAL_OK) and EV-1794203909317-FS3N (never acceptance proof).
 * Run with:  npm run test:acceptance-evidence   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

// ---------------------------------------------------------------- 27: no database, no network
// Any attempt to open a socket, resolve a name, make a request or fetch fails the run.
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
const ae = require(path.join(DIST, 'server/src', 'acceptanceEvidence.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const JASON = 'U0A9V97949F';
const FS3N = 'EV-1794203909317-FS3N';
const FOUR = ['unresolved', 'contract_pass', 'implementation_pass', 'runtime_proof'];
const LABELS = ['Satisfied', 'Not Satisfied', 'Not Verified'];
const STATES = ['TECH_ONLY', 'LOOP_ACCEPTED', 'COMMERCIAL_OK'];
const LINK = 'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456';

// Synthetic identifiers: right shape, invented values.
const VALID = Object.freeze({
  gate_id: 'CG-1700000000002-TST3',
  loop_id: 'LOOP-1700000000000-TST1',
  runtime_verification_status: 'contract_pass',
  acceptance_pass: false,
  actor_id: 'U0TESTACTR1',
  approver_id: 'U0TESTAPPR1',
  closure_state: 'TECH_ONLY',
  contract_evidence_refs: Object.freeze(['EV-1700000000001-TST2']),
  implementation_evidence_refs: Object.freeze(['EV-1700000000004-TST5']),
  decision_link: LINK,
});
const COMMERCIAL = Object.freeze({ ...VALID, closure_state: 'COMMERCIAL_OK', approver_id: JASON });
const RUN = Object.freeze({ system: 'n8n', id_epoch: 0, execution_id: 12345, workflow_id: 'SyntheticWf0001A' });
const codes = (r) => r.issues.map((i) => `${i.field}:${i.code}`);
const onField = (r, f) => r.issues.filter((i) => i.field === f).map((i) => i.code);
const hasIssue = (r, field, code) => r.issues.some((i) => i.field === field && i.code === code);
const without = (k) => { const o = { ...VALID }; delete o[k]; return o; };

// The result's keys and the documented issue codes, written out here rather than read from the
// module, so a field the module adds (an `allowed: true`, say) or an undocumented code fails the run.
const EXPECTED_KEYS = Object.freeze([
  'acceptance_eligible', 'acceptance_pass_allowed', 'acceptance_pass_blocked_by', 'acceptance_pass_requested', 'authorizes',
  'blocked_by', 'can_charge_live', 'closure_state', 'combination', 'contract', 'contract_sop', 'contract_status',
  'eligible_for_persistence', 'issues', 'normalised', 'proposed_rules_applied', 'references_verified',
  'runtime_verification_status', 'structurally_valid', 'unverified_references',
]);
const ISSUE_CODES = Object.freeze([
  'not_an_object', 'missing', 'bad_loop_id', 'bad_gate_id', 'gate_id_format_undefined', 'bad_status', 'unknown_status_value',
  'label_not_runtime_state', 'acceptance_state_not_runtime_state', 'bad_acceptance_pass', 'acceptance_pass_requires_runtime_proof',
  'acceptance_pass_not_verifiable_here', 'bad_actor_id', 'bad_approver_id', 'approver_bot_id_shape', 'commercial_ok_approver_missing',
  'commercial_approver_not_authorized', 'bad_evidence_refs', 'evidence_refs_empty', 'duplicate_evidence_ref', 'evidence_ref_in_both_lists',
  'not_acceptance_evidence', 'bad_delegation_ref', 'bad_decision_link', 'bad_run_ref', 'run_epoch_missing', 'bad_run_epoch',
  'run_execution_id_missing', 'bad_run_execution_id', 'run_workflow_id_missing', 'bad_run_workflow_id', 'unsupported_run_system',
  'bad_supersedes', 'bad_proof_type', 'bad_test_flag', 'bad_notes', 'retired_field', 'legacy_field_not_mapped',
  'derived_field_supplied', 'unknown_field',
]);
const STANDING = ['pre_integration', 'approver_authority_not_verified', 'references_not_verified', 'no_trusted_writer'];

const all = []; // every result produced through check(), for the sweep in check 26
function check(input) {
  const r = ae.check(input);
  all.push(r);
  return r;
}

function exactShape(r, label) {
  const keys = Object.keys(r).sort();
  const extra = keys.filter((k) => !EXPECTED_KEYS.includes(k));
  const gone = EXPECTED_KEYS.filter((k) => !keys.includes(k));
  assert.deepEqual({ extra, gone }, { extra: [], gone: [] }, `${label}: unexpected result keys`);
}

function neverEligible(r, label) {
  exactShape(r, label);
  assert.equal(r.acceptance_pass_allowed, false, `${label}: acceptance_pass never allowed`);
  assert.equal(r.eligible_for_persistence, false, `${label}: never eligible for persistence`);
  assert.equal(r.acceptance_eligible, false, `${label}: never acceptance-eligible`);
  assert.equal(r.authorizes, false, `${label}: never authorizes`);
  assert.equal(r.can_charge_live, false, `${label}: never opens live charging`);
  assert.equal(r.references_verified, false, `${label}: references never verified here`);
  assert.equal(r.contract, 'bha.acceptance_evidence.v2', `${label}: contract`);
  assert.equal(r.contract_sop, '2b794599-7862-4da7-b2bc-45d33f79aa52', `${label}: cites Contract v0`);
  assert.equal(r.contract_status, 'pre_integration', `${label}: pre-integration`);
  for (const b of STANDING) assert.ok(r.blocked_by.includes(b), `${label}: blocked_by names ${b}`);
}

// ---------------------------------------------------------------- 1: a well-formed record
{
  const r = check({ ...VALID, run_ref: RUN, proof_type: 'test_forced', test: true });
  assert.deepEqual(r.issues, [], codes(r).join(', '));
  assert.equal(r.structurally_valid, true);
  assert.deepEqual(r.normalised, {
    gate_id: 'CG-1700000000002-TST3', loop_id: 'LOOP-1700000000000-TST1', runtime_verification_status: 'contract_pass',
    acceptance_pass: false, actor_id: 'U0TESTACTR1', approver_id: 'U0TESTAPPR1', closure_state: 'TECH_ONLY',
    contract_evidence_refs: ['EV-1700000000001-TST2'], implementation_evidence_refs: ['EV-1700000000004-TST5'],
    delegation_ref: null, decision_link: LINK, decision: { channel: 'C0TESTCHAN1', ts: '1700000000.123456', thread_ts: null },
    run_ref: { ...RUN }, proof_type: 'test_forced', supersedes: null, notes: null, test: true,
  });
  assert.equal(r.acceptance_pass_requested, false);
  assert.deepEqual(r.acceptance_pass_blocked_by, [], 'nothing to block when true was not asked for');
  assert.ok(!r.blocked_by.includes('structural_issues'));
  assert.ok(!r.blocked_by.includes('acceptance_pass_not_allowed'));
  assert.deepEqual(r.proposed_rules_applied, ['actor_shape', 'approver_not_bot_id', 'approver_required', 'decision_link_required', 'evidence_field_names', 'gate_id_format', 'run_ref_n8n_only', 'run_ref_workflow_required']);
  neverEligible(r, 'well-formed');
  ok('1  a well-formed synthetic record is structurally valid, and still not eligible, allowed or authorizing');
}
{
  const r = check({ ...VALID, decision_link: `${LINK}?thread_ts=1699999999.000100&cid=C0TESTCHAN1`, run_ref: { ...RUN, id_epoch: '1', execution_id: '59333' } });
  assert.equal(r.structurally_valid, true, codes(r).join(', '));
  assert.equal(r.normalised.decision.thread_ts, '1699999999.000100');
  assert.equal(r.normalised.run_ref.id_epoch, 1);
  assert.equal(r.normalised.run_ref.execution_id, 59333);
  ok('1b a thread reply link and digit-string run ids are read; epoch 1 is accepted as a shape');
}

// ---------------------------------------------------------------- 2: loop_id
{
  for (const gone of [without('loop_id'), { ...VALID, loop_id: '' }, { ...VALID, loop_id: null }]) assert.deepEqual(onField(check(gone), 'loop_id'), ['missing']);
  for (const bad of ['LOOP-1', 'LOOP-123-ABCD', 'loop-1700000000000-TST1', 'LOOP-1700000000000-tst1', 'SMQZ', 'LOOP-1700000000000-TST12', 'LOOP-1700000000000-TST1 ', 'https://dashboard/open-loops/LOOP-1700000000000-TST1', 42, 1700000000000, {}, []]) {
    const r = check({ ...VALID, loop_id: bad });
    assert.deepEqual(onField(r, 'loop_id'), ['bad_loop_id'], `${JSON.stringify(bad)}: ${codes(r)}`);
    assert.equal(r.issues.find((i) => i.field === 'loop_id').rule_status, 'approved');
    assert.equal(r.normalised, null);
    assert.ok(r.blocked_by.includes('structural_issues'));
    neverEligible(r, JSON.stringify(bad));
  }
  ok('2  loop_id is required; LOOP-1, lower case, a bare suffix like SMQZ, padded ids, numbers and objects are refused');
}

// ---------------------------------------------------------------- 3: gate_id, and gate_ref retired
{
  assert.deepEqual(onField(check(without('gate_id')), 'gate_id'), ['missing']);
  assert.deepEqual(onField(check({ ...VALID, gate_id: '' }), 'gate_id'), ['missing']);
  for (const bad of ['   ', 42, {}]) assert.deepEqual(onField(check({ ...VALID, gate_id: bad }), 'gate_id'), ['bad_gate_id'], JSON.stringify(bad));
  for (const other of ['media-twin', 'VFARM_STAGE1', 'GATE-1700000000005-TST6', 'cg-1700000000002-tst3', 'EV-1700000000001-TST2']) {
    const i = check({ ...VALID, gate_id: other }).issues.find((x) => x.field === 'gate_id');
    assert.equal(i.code, 'gate_id_format_undefined', other);
    assert.equal(i.rule_status, 'proposed');
    assert.match(i.message, /proposed rule, awaiting approval/);
  }
  // gate_ref is refused by name and never read as gate_id.
  const r = check({ ...without('gate_id'), gate_ref: 'CG-1700000000002-TST3' });
  assert.deepEqual(onField(r, 'gate_ref'), ['retired_field']);
  assert.deepEqual(onField(r, 'gate_id'), ['missing']);
  assert.equal(r.normalised, null);
  ok('3  gate_id is required; only a CG- id is recognised (provisional); gate_ref is retired by name, never read as gate_id');
}

// ---------------------------------------------------------------- 4: the four runtime states, exactly
{
  assert.deepEqual([...ae.RUNTIME_VERIFICATION_STATES], FOUR, 'exactly the Contract v0 §3 list, in its order');
  const v = ae.RUNTIME_VERIFICATION_STATUS_VOCABULARY;
  assert.deepEqual([...v.values], FOUR);
  assert.equal(v.field, 'runtime_verification_status');
  assert.equal(v.sop, '2b794599-7862-4da7-b2bc-45d33f79aa52');
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.values));
  for (const s of FOUR) {
    const r = check({ ...VALID, runtime_verification_status: s });
    assert.equal(r.structurally_valid, true, `${s}: ${codes(r)}`);
    assert.deepEqual(r.runtime_verification_status, { value: s, approved: true, reason: 'approved_value' });
    neverEligible(r, s);
  }
  ok('4  runtime_verification_status accepts exactly unresolved, contract_pass, implementation_pass and runtime_proof');
}

// ---------------------------------------------------------------- 5: near misses and malformed values
{
  for (const bad of ['Runtime_Proof', 'RUNTIME_PROOF', 'runtime-proof', 'contract pass', 'passed', 'proven', 'pass', 'green', 'Closed']) {
    const r = check({ ...VALID, runtime_verification_status: bad });
    assert.deepEqual(onField(r, 'runtime_verification_status'), ['unknown_status_value'], `${bad}: ${codes(r)}`);
    assert.deepEqual(r.runtime_verification_status, { value: null, approved: false, reason: 'not_in_vocabulary' });
    assert.equal(r.normalised, null);
  }
  for (const bad of ['', '   ', 5, true, 'x'.repeat(ae.STATUS_MAX + 1), 'line\nbreak', ' runtime_proof', 'runtime_proof ', '\truntime_proof']) {
    const r = check({ ...VALID, runtime_verification_status: bad });
    assert.deepEqual(onField(r, 'runtime_verification_status'), ['bad_status'], JSON.stringify(bad).slice(0, 30));
    assert.equal(r.runtime_verification_status.reason, 'malformed', 'never trimmed or corrected');
  }
  for (const gone of [without('runtime_verification_status'), { ...VALID, runtime_verification_status: null }]) {
    const r = check(gone);
    assert.deepEqual(onField(r, 'runtime_verification_status'), ['missing']);
    assert.equal(r.runtime_verification_status.reason, 'missing');
  }
  ok('5  re-cased, hyphenated, padded or invented runtime values are refused, never trimmed or corrected');
}

// ---------------------------------------------------------------- 6: labels and acceptance states are not runtime states
{
  for (const label of LABELS) {
    const r = check({ ...VALID, runtime_verification_status: label });
    const i = r.issues.find((x) => x.field === 'runtime_verification_status');
    assert.equal(i.code, 'label_not_runtime_state', label);
    assert.equal(i.rule, 'labels_not_runtime_states');
    assert.equal(i.rule_status, 'approved');
    assert.match(i.message, /never translated/);
    assert.equal(r.runtime_verification_status.value, null, `${label} is never mapped to a runtime state`);
  }
  for (const state of STATES) {
    const r = check({ ...VALID, runtime_verification_status: state, closure_state: 'TECH_ONLY' });
    assert.deepEqual(onField(r, 'runtime_verification_status'), ['acceptance_state_not_runtime_state'], state);
    assert.equal(r.runtime_verification_status.value, null);
  }
  ok('6  Satisfied, Not Satisfied, Not Verified and the acceptance states are refused by name as runtime states, never translated');
}

// ---------------------------------------------------------------- 7: closure_state
{
  assert.deepEqual([...ae.ACCEPTANCE_STATES], STATES);
  assert.deepEqual([...ae.CLOSURE_STATE_VOCABULARY.values], STATES);
  for (const s of STATES) {
    const r = check(s === 'COMMERCIAL_OK' ? COMMERCIAL : { ...VALID, closure_state: s });
    assert.equal(r.structurally_valid, true, `${s}: ${codes(r)}`);
    assert.deepEqual(r.closure_state, { value: s, approved: true, reason: 'approved_value' });
  }
  for (const bad of ['tech_only', 'Tech Only', 'TECH ONLY', 'Commercial_OK', 'approved', 'Satisfied', 'runtime_proof', 'NOT_ACCEPTED']) {
    assert.deepEqual(onField(check({ ...VALID, closure_state: bad }), 'closure_state'), ['unknown_status_value'], bad);
  }
  assert.deepEqual(onField(check({ ...VALID, closure_state: ' TECH_ONLY' }), 'closure_state'), ['bad_status']);
  assert.deepEqual(onField(check(without('closure_state')), 'closure_state'), ['missing']);
  // approval_status is never read as closure_state.
  const r = check({ ...without('closure_state'), approval_status: 'approved' });
  assert.deepEqual(onField(r, 'approval_status'), ['legacy_field_not_mapped']);
  assert.deepEqual(onField(r, 'closure_state'), ['missing']);
  ok('7  closure_state keeps TECH_ONLY, LOOP_ACCEPTED and COMMERCIAL_OK exactly; approval_status is never read as it');
}

// ---------------------------------------------------------------- 8: acceptance_pass is a real boolean
{
  for (const bad of ['true', 'false', 1, 0, 'yes', {}, []]) {
    const r = check({ ...VALID, acceptance_pass: bad });
    assert.deepEqual(onField(r, 'acceptance_pass'), ['bad_acceptance_pass'], JSON.stringify(bad));
    assert.equal(r.acceptance_pass_requested, null);
    neverEligible(r, JSON.stringify(bad));
  }
  for (const gone of [without('acceptance_pass'), { ...VALID, acceptance_pass: null }]) assert.deepEqual(onField(check(gone), 'acceptance_pass'), ['missing']);
  ok('8  acceptance_pass given as a string, number, object or null, or left out, is refused');
}

// ---------------------------------------------------------------- 9: acceptance_pass true is always refused
{
  for (const s of ['unresolved', 'contract_pass', 'implementation_pass']) {
    const r = check({ ...VALID, runtime_verification_status: s, acceptance_pass: true });
    assert.deepEqual(onField(r, 'acceptance_pass'), ['acceptance_pass_requires_runtime_proof'], `${s}: ${codes(r)}`);
    assert.equal(r.issues.find((i) => i.field === 'acceptance_pass').rule_status, 'approved');
    assert.ok(r.acceptance_pass_blocked_by.includes('runtime_proof_required'), s);
    neverEligible(r, s);
  }
  const r = check({ ...VALID, runtime_verification_status: 'runtime_proof', acceptance_pass: true });
  assert.deepEqual(onField(r, 'acceptance_pass'), ['acceptance_pass_not_verifiable_here'], codes(r).join(', '));
  assert.equal(r.structurally_valid, false, 'the contract says the validator must reject true without verified authorization');
  assert.equal(r.acceptance_pass_requested, true);
  assert.deepEqual(r.acceptance_pass_blocked_by, ['contract_evidence_not_verified', 'implementation_evidence_not_verified', 'authorization_not_verified', 'gate_authority_undefined', 'no_trusted_writer']);
  assert.ok(r.blocked_by.includes('acceptance_pass_not_allowed'));
  assert.equal(r.normalised, null);
  neverEligible(r, 'runtime_proof + true');
  // A delegation_ref is shape only, and never a verified authorization.
  const d = check({ ...VALID, runtime_verification_status: 'runtime_proof', acceptance_pass: true, delegation_ref: 'EV-1700000000006-TST7' });
  assert.ok(d.acceptance_pass_blocked_by.includes('delegation_record_unverified'));
  assert.ok(d.acceptance_pass_blocked_by.includes('authorization_not_verified'));
  neverEligible(d, 'true with delegation');
  // COMMERCIAL_OK by Jason does not open it either.
  const c = check({ ...COMMERCIAL, runtime_verification_status: 'runtime_proof', acceptance_pass: true });
  assert.deepEqual(onField(c, 'acceptance_pass'), ['acceptance_pass_not_verifiable_here']);
  neverEligible(c, 'COMMERCIAL_OK + true');
  ok('9  acceptance_pass true needs runtime_proof, and with it is still refused, naming the unverified evidence and authority');
}

// ---------------------------------------------------------------- 10: the §4 statement, and caller facts
{
  const F = ['contract_evidence_verified', 'implementation_evidence_verified', 'authorization_verified'];
  const UNMET = { contract_evidence_verified: 'contract_evidence_not_verified', implementation_evidence_verified: 'implementation_evidence_not_verified', authorization_verified: 'authorization_not_verified' };
  let met = 0;
  for (const status of [...FOUR, 'Satisfied', null, undefined, 'RUNTIME_PROOF']) {
    for (let mask = 0; mask < 8; mask += 1) {
      const facts = {};
      F.forEach((f, i) => { facts[f] = Boolean(mask & (1 << i)); });
      const d = ae.acceptancePassDecision(status, facts);
      assert.equal(d.authorizes, false, 'never authorizes');
      const expected = status === 'runtime_proof' && mask === 7;
      assert.equal(d.meets_sop_conditions, expected, `${status} ${mask}`);
      assert.equal(d.unmet.length === 0, expected);
      if (expected) met += 1;
      if (status !== 'runtime_proof') assert.equal(d.unmet[0], 'runtime_proof_required');
    }
  }
  assert.equal(met, 1, 'exactly one combination meets the stated conditions');
  for (const f of F) {
    for (const truthy of ['true', 1, 'yes', {}, [true]]) {
      const d = ae.acceptancePassDecision('runtime_proof', { contract_evidence_verified: true, implementation_evidence_verified: true, authorization_verified: true, [f]: truthy });
      assert.equal(d.meets_sop_conditions, false, `${f}=${JSON.stringify(truthy)}`);
      assert.deepEqual(d.unmet, [UNMET[f]], `${f}=${JSON.stringify(truthy)}`);
    }
  }
  assert.deepEqual(ae.acceptancePassDecision('runtime_proof').unmet, ['contract_evidence_not_verified', 'implementation_evidence_not_verified', 'authorization_not_verified']);
  // check() never consults caller-supplied facts: placed in a record they are refused, not used.
  const smuggled = check({ ...VALID, runtime_verification_status: 'runtime_proof', acceptance_pass: true, contract_evidence_verified: true, implementation_evidence_verified: true, authorization_verified: true });
  for (const f of F) assert.deepEqual(onField(smuggled, f), ['unknown_field'], f);
  assert.ok(smuggled.acceptance_pass_blocked_by.includes('authorization_not_verified'));
  neverEligible(smuggled, 'smuggled facts');
  ok('10 acceptancePassDecision meets the stated conditions only for runtime_proof with all three facts exactly true, authorizes nothing, and is never fed by the record');
}

// ---------------------------------------------------------------- 11: actor_id, a person or an automated writer
{
  assert.deepEqual(onField(check(without('actor_id')), 'actor_id'), ['missing']);
  for (const who of ['U0TESTACTR1', 'W0TESTACTR2', 'B0TESTBOT01']) {
    const r = check({ ...VALID, actor_id: who });
    assert.equal(r.structurally_valid, true, `${who}: ${codes(r)}`);
    assert.equal(r.normalised.actor_id, who);
  }
  for (const bad of ['u0testactr1', 'Hardik', 'U0', 'n8n', 42, {}]) {
    const i = check({ ...VALID, actor_id: bad }).issues.find((x) => x.field === 'actor_id');
    assert.equal(i.code, 'bad_actor_id', JSON.stringify(bad));
    assert.equal(i.rule_status, 'proposed');
  }
  ok('11 actor_id is required and may be a person or a bot (an automated writer); other shapes are refused on a provisional rule');
}

// ---------------------------------------------------------------- 12: approver_id outside COMMERCIAL_OK
{
  for (const gone of [without('approver_id'), { ...VALID, approver_id: null }, { ...VALID, approver_id: '' }]) {
    const i = check(gone).issues.find((x) => x.field === 'approver_id');
    assert.equal(i.code, 'missing');
    assert.equal(i.rule, 'approver_required');
    assert.equal(i.rule_status, 'proposed');
  }
  const bot = check({ ...VALID, approver_id: 'B0TESTBOT01' });
  assert.deepEqual(onField(bot, 'approver_id'), ['approver_bot_id_shape']);
  assert.match(bot.issues[0].message, /id-shape check only/);
  for (const bad of ['Jason', 'u0testappr1', '<@U0TESTAPPR1>', 'U12', 7]) assert.deepEqual(onField(check({ ...VALID, approver_id: bad }), 'approver_id'), ['bad_approver_id'], String(bad));
  // Neither owner_id nor actor_id is ever taken as the approver.
  const r = check({ ...without('approver_id'), owner_id: 'U0TESTOWNR1' });
  assert.deepEqual(onField(r, 'owner_id'), ['legacy_field_not_mapped']);
  assert.deepEqual(onField(r, 'approver_id'), ['missing']);
  ok('12 a missing, bot-shaped or malformed approver is refused; owner_id and actor_id are never taken as the approver');
}

// ---------------------------------------------------------------- 13: COMMERCIAL_OK needs the human commercial authority
{
  assert.equal(ae.COMMERCIAL_APPROVER, JASON);
  assert.deepEqual([...ae.DELEGATED_COMMERCIAL_APPROVERS], [], 'no named delegate is recognised');
  assert.ok(Object.isFrozen(ae.DELEGATED_COMMERCIAL_APPROVERS));
  // Jason as approver, an automated writer as actor: structurally valid (SOP b3a349df).
  for (const actor of [JASON, 'B0TESTBOT01', 'U0TESTACTR1']) {
    const r = check({ ...COMMERCIAL, actor_id: actor });
    assert.deepEqual(r.issues, [], `${actor}: ${codes(r)}`);
    neverEligible(r, `COMMERCIAL_OK, actor ${actor}`);
  }
  // No approver_id: invalid under the approved rule, whoever the actor is, Jason included.
  for (const gone of [{ ...COMMERCIAL, approver_id: undefined }, { ...COMMERCIAL, approver_id: null }, { ...COMMERCIAL, approver_id: '' }, { ...COMMERCIAL, approver_id: undefined, actor_id: JASON }]) {
    const r = check(gone);
    const i = r.issues.find((x) => x.field === 'approver_id');
    assert.equal(i.code, 'commercial_ok_approver_missing', codes(r).join(', '));
    assert.equal(i.rule, 'commercial_ok_requires_human_approver');
    assert.equal(i.rule_status, 'approved');
    assert.equal(r.normalised, null);
    neverEligible(r, 'COMMERCIAL_OK without approver');
  }
  // Anyone but Jason as approver is refused under the approved rule.
  for (const who of ['U0TESTAPPR1', 'U0AEW3TBYH1', 'U0BKT6MAW2Y', 'W0TESTDELEG']) {
    const i = check({ ...COMMERCIAL, approver_id: who }).issues.find((x) => x.code === 'commercial_approver_not_authorized');
    assert.ok(i, `${who}: refused`);
    assert.equal(i.rule, 'commercial_ok_authority');
    assert.equal(i.rule_status, 'approved');
  }
  // A bot or malformed approver on COMMERCIAL_OK is refused by the approved rule too, not only by the proposed shape rules.
  for (const bad of ['B0TESTBOT01', 'Jason', 'u0a9v97949f']) {
    const r = check({ ...COMMERCIAL, approver_id: bad });
    assert.ok(hasIssue(r, 'approver_id', 'commercial_approver_not_authorized'), `${bad}: ${codes(r)}`);
  }
  ok('13 COMMERCIAL_OK needs an explicit approver_id that is Jason; the actor may be anyone, an automated writer included');
}

// ---------------------------------------------------------------- 14: linked contract and implementation evidence
{
  const both = check({ ...VALID, contract_evidence_refs: ['EV-1700000000001-TST2', 'EV-1700000000007-TST8'], implementation_evidence_refs: ['EV-1700000000004-TST5'] });
  assert.equal(both.structurally_valid, true, codes(both).join(', '));
  assert.deepEqual(both.normalised.contract_evidence_refs, ['EV-1700000000001-TST2', 'EV-1700000000007-TST8']);
  for (const field of ['contract_evidence_refs', 'implementation_evidence_refs']) {
    const gone = check(without(field)).issues.find((x) => x.field === field);
    assert.equal(gone.code, 'missing');
    assert.equal(gone.rule, 'evidence_linked_records');
    assert.equal(gone.rule_status, 'approved');
    assert.deepEqual(onField(check({ ...VALID, [field]: [] }), field), ['evidence_refs_empty']);
    for (const bad of ['EV-1700000000001-TST2', {}, 42, Array.from({ length: ae.MAX_EVIDENCE_REFS + 1 }, (_, i) => `EV-17000000000${String(i).padStart(2, '0')}-TS${String(i).padStart(2, '0').slice(-1)}X`)]) {
      const i = check({ ...VALID, [field]: bad }).issues.find((x) => x.field === field);
      assert.equal(i.code, 'bad_evidence_refs', `${field}=${JSON.stringify(bad).slice(0, 30)}`);
      assert.equal(i.rule_status, 'proposed');
    }
    for (const bad of ['https://drive.google.com/file/d/synthetic', 'CG-1700000000002-TST3', 'ev-1700000000001-tst2', 'slack:F0SYNTHETIC', 7]) {
      assert.deepEqual(onField(check({ ...VALID, [field]: [bad] }), `${field}[0]`), ['bad_evidence_refs'], `${field}: ${bad}`);
    }
    assert.deepEqual(onField(check({ ...VALID, [field]: [VALID[field][0], VALID[field][0]] }), `${field}[1]`), ['duplicate_evidence_ref']);
  }
  // Contract and implementation evidence are separate records.
  const same = check({ ...VALID, implementation_evidence_refs: ['EV-1700000000001-TST2'] });
  assert.deepEqual(onField(same, 'implementation_evidence_refs'), ['evidence_ref_in_both_lists']);
  assert.equal(same.issues.find((i) => i.code === 'evidence_ref_in_both_lists').rule_status, 'approved');
  // FS3N is never acceptance proof, in any slot.
  for (const at of [{ contract_evidence_refs: [FS3N] }, { implementation_evidence_refs: [FS3N] }, { contract_evidence_refs: [FS3N], implementation_evidence_refs: [FS3N] }, { contract_evidence_refs: ['EV-1700000000001-TST2', FS3N] }]) {
    const r = check({ ...VALID, ...at });
    const i = r.issues.find((x) => x.code === 'not_acceptance_evidence');
    assert.ok(i, `${JSON.stringify(at)}: ${codes(r)}`);
    assert.equal(i.rule, 'not_acceptance_evidence');
    assert.equal(i.rule_status, 'approved');
    assert.match(i.message, /never final acceptance proof/);
    assert.equal(r.structurally_valid, false);
    assert.equal(r.normalised, null);
    neverEligible(r, 'FS3N');
  }
  assert.deepEqual(onField(check({ ...VALID, delegation_ref: FS3N }), 'delegation_ref'), ['not_acceptance_evidence']);
  // The single evidence_ref is retired by name and never read as either list.
  const r = check({ ...without('contract_evidence_refs'), evidence_ref: 'EV-1700000000001-TST2' });
  assert.deepEqual(onField(r, 'evidence_ref'), ['retired_field']);
  assert.equal(r.issues.find((i) => i.field === 'evidence_ref').rule, 'evidence_ref_retired');
  assert.deepEqual(onField(r, 'contract_evidence_refs'), ['missing']);
  const legacy = check({ ...without('implementation_evidence_refs'), evidence_reference: 'EV-1700000000004-TST5' });
  assert.deepEqual(onField(legacy, 'evidence_reference'), ['legacy_field_not_mapped']);
  assert.deepEqual(onField(legacy, 'implementation_evidence_refs'), ['missing']);
  // The writer, not this check, must verify every EV's type and provenance.
  assert.ok(check(VALID).unverified_references.some((x) => /really contract or implementation evidence for this gate, with its provenance checked/.test(x)));
  ok('14 evidence is two lists of linked EV records; empty, malformed, duplicated or shared ids, FS3N anywhere and the single evidence_ref are refused');
}

// ---------------------------------------------------------------- 15: delegation_ref
{
  const d = check({ ...VALID, delegation_ref: 'EV-1700000000006-TST7' });
  assert.equal(d.structurally_valid, true, codes(d).join(', '));
  assert.equal(d.normalised.delegation_ref, 'EV-1700000000006-TST7');
  assert.ok(d.proposed_rules_applied.includes('delegation_ref_shape'));
  for (const bad of ['https://drive.google.com/x', 'U0TESTDLGT1', 'CG-1700000000002-TST3', 'EV-1', 42, {}]) {
    const i = check({ ...VALID, delegation_ref: bad }).issues.find((x) => x.field === 'delegation_ref');
    assert.equal(i.code, 'bad_delegation_ref', JSON.stringify(bad));
    assert.match(i.message, /proposed rule, awaiting approval/);
  }
  assert.deepEqual(onField(check({ ...VALID, delegation_ref: null }), 'delegation_ref'), [], 'null is absent');
  ok('15 a well-formed delegation_ref passes shape only (provisional); a malformed one is refused');
}

// ---------------------------------------------------------------- 16: Slack decision link
{
  for (const bad of [
    'http://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456',
    'https://example-test.slack.com.evil.test/archives/C0TESTCHAN1/p1700000000123456',
    'https://example-test.slack.com/archives/C0TESTCHAN1/1700000000.123456',
    'https://example-test.slack.com/archives/X0TESTCHAN1/p1700000000123456',
    'https://example-test.slack.com/archives/C0TESTCHAN1/p17000000001234',
    'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456?thread_ts=abc',
    'C0TESTCHAN1/1700000000.123456',
    'not a link',
  ]) {
    assert.deepEqual(onField(check({ ...VALID, decision_link: bad }), 'decision_link'), ['bad_decision_link'], bad);
  }
  assert.deepEqual(onField(check(without('decision_link')), 'decision_link'), ['missing']);
  assert.equal(ae.parseSlackLink('https://example-test.slack.com/archives/G0TESTGRP1/p1700000000000001/').channel, 'G0TESTGRP1');
  ok('16 a malformed or missing Slack decision link is refused; the parse is shape only');
}

// ---------------------------------------------------------------- 17: run reference
{
  const { id_epoch, ...noEpoch } = RUN;
  assert.deepEqual(onField(check({ ...VALID, run_ref: noEpoch }), 'run_ref.id_epoch'), ['run_epoch_missing']);
  assert.deepEqual(onField(check({ ...VALID, run_ref: { ...RUN, id_epoch: null } }), 'run_ref.id_epoch'), ['run_epoch_missing']);
  for (const bad of [-1, 1.5, '0x1', 32768, 'live']) assert.deepEqual(onField(check({ ...VALID, run_ref: { ...RUN, id_epoch: bad } }), 'run_ref.id_epoch'), ['bad_run_epoch'], String(bad));
  for (const [bad, code] of [['72653a', 'bad_run_execution_id'], ['7,653', 'bad_run_execution_id'], [1.5, 'bad_run_execution_id'], [-5, 'bad_run_execution_id'], [0, 'bad_run_execution_id'], ['', 'bad_run_execution_id'], [' 12345', 'bad_run_execution_id'], ['1e5', 'bad_run_execution_id'], [Number.MAX_SAFE_INTEGER + 2, 'bad_run_execution_id'], [null, 'run_execution_id_missing']]) {
    const r = check({ ...VALID, run_ref: { ...RUN, execution_id: bad } });
    assert.deepEqual(onField(r, 'run_ref.execution_id'), [code], `${JSON.stringify(bad)}: ${codes(r)}`);
    assert.equal(r.normalised, null);
  }
  const { workflow_id, ...noWf } = RUN;
  assert.deepEqual(onField(check({ ...VALID, run_ref: noWf }), 'run_ref.workflow_id'), ['run_workflow_id_missing']);
  for (const bad of ['short', 'Has Spaces In It', 'wf/../../etc', 123456789]) assert.deepEqual(onField(check({ ...VALID, run_ref: { ...RUN, workflow_id: bad } }), 'run_ref.workflow_id'), ['bad_run_workflow_id'], String(bad));
  assert.deepEqual(onField(check({ ...VALID, run_ref: { ...RUN, system: 'genie' } }), 'run_ref.system'), ['unsupported_run_system']);
  assert.deepEqual(onField(check({ ...VALID, run_ref: { ...RUN, mode: 'webhook' } }), 'run_ref.mode'), ['unknown_field']);
  assert.deepEqual(onField(check({ ...VALID, run_ref: 'n8n:0:12345' }), 'run_ref'), ['bad_run_ref']);
  ok('17 a run reference needs its epoch, a positive execution id and a workflow id; only n8n, as an object, with no extra keys');
}

// ---------------------------------------------------------------- 18: optional fields and the record's own shape
{
  for (const bad of ['live', 'LIVE_NATURAL_PLUS', 'tested', 1]) assert.deepEqual(onField(check({ ...VALID, proof_type: bad }), 'proof_type'), ['bad_proof_type'], String(bad));
  assert.equal(check({ ...VALID, proof_type: 'live_natural' }).normalised.proof_type, 'live_natural');
  assert.equal(check(VALID).normalised.proof_type, null, 'left out is not stated, never live');
  assert.deepEqual(onField(check({ ...VALID, supersedes: 'EV-1700000000001-TST2' }), 'supersedes'), ['bad_supersedes']);
  assert.equal(check({ ...VALID, supersedes: 'AE-1700000000008-TST9' }).normalised.supersedes, 'AE-1700000000008-TST9');
  assert.deepEqual(onField(check({ ...VALID, notes: 42 }), 'notes'), ['bad_notes']);
  assert.deepEqual(onField(check({ ...VALID, notes: 'x'.repeat(2001) }), 'notes'), ['bad_notes']);
  assert.deepEqual(onField(check({ ...VALID, test: 'yes' }), 'test'), ['bad_test_flag']);
  const d = check({ ...VALID, record_id: 'AE-1700000000003-TST4', owner_id_snapshot: 'U0TESTOWNR1' });
  assert.deepEqual(onField(d, 'record_id'), ['derived_field_supplied']);
  assert.deepEqual(onField(d, 'owner_id_snapshot'), ['derived_field_supplied']);
  for (const k of ['verdict', 'actor', 'gateId', 'acceptancePass', 'technical_status', 'label']) assert.deepEqual(onField(check({ ...VALID, [k]: 'x' }), k), ['unknown_field'], k);
  for (const bad of [null, undefined, 'string', 5, [], [VALID]]) {
    const r = check(bad);
    assert.deepEqual(codes(r), ['(record):not_an_object'], String(bad));
    neverEligible(r, String(bad));
  }
  ok('18 proof_type, supersedes, notes and test are checked; derived, unknown and non-object input is refused, never ignored');
}

// ---------------------------------------------------------------- 19: combinations not yet approved
{
  for (const s of FOUR) for (const c of STATES) {
    const r = check({ ...(c === 'COMMERCIAL_OK' ? COMMERCIAL : VALID), runtime_verification_status: s, closure_state: c });
    assert.equal(r.structurally_valid, true, `${s}/${c}: ${codes(r)}`);
    assert.equal(r.combination, 'not_stated', `${s}/${c}`);
    assert.ok(r.blocked_by.includes('combination_not_approved'), `${s}/${c}`);
    neverEligible(r, `${s}/${c}`);
  }
  assert.equal(ae.combinationOf('runtime_proof', null), 'incomplete');
  assert.equal(ae.combinationOf(null, 'TECH_ONLY'), 'incomplete');
  assert.ok(check(without('runtime_verification_status')).blocked_by.includes('combination_incomplete'));
  assert.ok(!all.some((r) => r.combination === 'defined'), 'no pairing is ever defined until Jason lists one');
  assert.equal(ae.RULES.combination_not_approved.status, 'prototype_guard');
  ok('19 every pairing of runtime state and acceptance state blocks as not approved; none is defined until Jason lists it');
}

// ---------------------------------------------------------------- 20: nothing opens live charging
{
  const strongest = { ...COMMERCIAL, runtime_verification_status: 'runtime_proof', proof_type: 'live_natural', run_ref: RUN, delegation_ref: 'EV-1700000000006-TST7' };
  const r = check(strongest);
  assert.equal(r.structurally_valid, true, codes(r).join(', '));
  neverEligible(r, 'strongest record');
  const walk = (o, at = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? walk(v, `${at}${k}.`) : [[`${at}${k}`, v]]));
  for (const [k, v] of walk(r)) {
    if (/charge|offer|payment|stage|live|allowed|authoriz|eligible/i.test(k)) assert.notEqual(v, true, `${k} must never be true`);
  }
  assert.equal(ae.RULES.no_live_charging.status, 'approved');
  ok('20 COMMERCIAL_OK by Jason with runtime_proof and live proof still opens no charging, eligibility or authorization');
}

// ---------------------------------------------------------------- 21: nothing inferred
{
  // A label, a gate and live proof, with no closure_state: no acceptance state is derived, not even TECH_ONLY.
  const r = check({ ...without('closure_state'), runtime_verification_status: 'runtime_proof', proof_type: 'live_natural', run_ref: RUN });
  assert.deepEqual(onField(r, 'closure_state'), ['missing']);
  assert.equal(r.closure_state.value, null);
  assert.equal(r.combination, 'incomplete');
  // An explicit closure_state is carried exactly as sent.
  assert.equal(check({ ...VALID, closure_state: 'LOOP_ACCEPTED' }).normalised.closure_state, 'LOOP_ACCEPTED');
  // No approver is taken from the actor, even on COMMERCIAL_OK with Jason as actor.
  const t = check({ ...COMMERCIAL, approver_id: undefined, actor_id: JASON });
  assert.ok(hasIssue(t, 'approver_id', 'commercial_ok_approver_missing'));
  // No runtime state is taken from a label.
  assert.equal(check({ ...VALID, runtime_verification_status: 'Satisfied' }).runtime_verification_status.value, null);
  ok('21 no acceptance state, approver or runtime state is inferred from anything else on the record');
}

// ---------------------------------------------------------------- 22: the historical gate row is not an acceptance record
{
  // The shape of the one real charge-gate row CG-1793247501592-59M7 (synthetic values; SOP cd1ea717).
  const historical = { gate_id: 'CG-1700000000002-TST3', kind: 'acceptance_pass', rail: 'vfarm_stripe_live', verdict: 'green', decided_by: 'U0TESTACTR1', recorded_by: 'U0TESTRCDR1', bundle_ref: 'EV-1700000000001-TST2', evidence_link: LINK, test: false };
  const r = check(historical);
  assert.equal(r.structurally_valid, false);
  for (const f of ['loop_id', 'runtime_verification_status', 'acceptance_pass', 'actor_id', 'approver_id', 'closure_state', 'contract_evidence_refs', 'implementation_evidence_refs', 'decision_link']) assert.deepEqual(onField(r, f), ['missing'], f);
  for (const f of ['kind', 'rail', 'verdict', 'decided_by', 'bundle_ref', 'evidence_link']) assert.deepEqual(onField(r, f), ['unknown_field'], f);
  assert.deepEqual(onField(r, 'recorded_by'), ['derived_field_supplied']);
  assert.equal(r.normalised, null);
  neverEligible(r, 'historical');
  ok('22 a charge-gate row shaped like CG-…-59M7 cannot pass as an acceptance record; decided_by and bundle_ref are not read');
}

// ---------------------------------------------------------------- 23: shared state, and inputs, cannot be changed
{
  for (const [name, v] of Object.entries({
    RULES: ae.RULES, REQUIRED: ae.REQUIRED, OPTIONAL: ae.OPTIONAL, LEGACY_FIELDS: ae.LEGACY_FIELDS, RETIRED_FIELDS: ae.RETIRED_FIELDS,
    DERIVED_FIELDS: ae.DERIVED_FIELDS, UNVERIFIED_REFERENCES: ae.UNVERIFIED_REFERENCES, NOT_ACCEPTANCE_EVIDENCE: ae.NOT_ACCEPTANCE_EVIDENCE,
    RUNTIME_VERIFICATION_STATES: ae.RUNTIME_VERIFICATION_STATES, RUNTIME_VERIFICATION_STATUS_VOCABULARY: ae.RUNTIME_VERIFICATION_STATUS_VOCABULARY,
    CLOSURE_STATE_VOCABULARY: ae.CLOSURE_STATE_VOCABULARY, TECHNICAL_STATUSES: ae.TECHNICAL_STATUSES, ACCEPTANCE_STATES: ae.ACCEPTANCE_STATES,
    DELEGATED_COMMERCIAL_APPROVERS: ae.DELEGATED_COMMERCIAL_APPROVERS,
  })) assert.ok(Object.isFrozen(v), `${name} is frozen`);
  for (const r of Object.values(ae.RULES)) assert.ok(Object.isFrozen(r), `rule ${r.id} is frozen`);
  assert.throws(() => { 'use strict'; ae.UNVERIFIED_REFERENCES.push('x'); }, TypeError);
  assert.throws(() => { 'use strict'; ae.RULES.gate_id_format.status = 'approved'; }, TypeError);
  assert.throws(() => { 'use strict'; ae.RUNTIME_VERIFICATION_STATES.push('Satisfied'); }, TypeError);
  assert.throws(() => { 'use strict'; ae.NOT_ACCEPTANCE_EVIDENCE[FS3N] = undefined; }, TypeError);
  assert.throws(() => { 'use strict'; ae.DELEGATED_COMMERCIAL_APPROVERS.push('U0TESTDELEG'); }, TypeError);
  assert.equal(ae.RULES.gate_id_format.status, 'proposed');
  // A frozen input is read without being changed, the answer is repeatable, and results share nothing.
  const input = { ...COMMERCIAL, run_ref: { ...RUN, execution_id: '12345' }, contract_evidence_refs: ['EV-1700000000001-TST2'], delegation_ref: 'EV-1700000000006-TST7' };
  const snapshot = JSON.stringify(input);
  Object.freeze(input); Object.freeze(input.run_ref); Object.freeze(input.contract_evidence_refs);
  // Taken outside the collected results on purpose: it is tampered with below, and the audits in
  // checks 25 and 26 are about what the validator returns, not what a caller did to it afterwards.
  const first = ae.check(input);
  assert.equal(JSON.stringify(input), snapshot, 'input unchanged');
  const baseline = JSON.parse(JSON.stringify(first));
  first.unverified_references.push('tampered');
  first.blocked_by.length = 0;
  first.proposed_rules_applied.push('tampered');
  first.acceptance_pass_blocked_by.push('tampered');
  first.issues.push({ field: 'x', code: 'unknown_field', message: 'x', rule: 'x', rule_status: 'approved' });
  first.normalised.run_ref.execution_id = 1;
  first.normalised.contract_evidence_refs.push('EV-1700000000009-TSTA');
  const second = check(input);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), baseline, 'the second result is unchanged by what was done to the first');
  assert.deepEqual(input.contract_evidence_refs, ['EV-1700000000001-TST2'], 'the caller\'s own list is not shared with the result');
  assert.equal(ae.UNVERIFIED_REFERENCES.includes('tampered'), false);
  ok('23 shared definitions are frozen; a frozen input is read unchanged; one result changed by its caller cannot change another');
}

// ---------------------------------------------------------------- 24: never acceptance-eligible
{
  for (const input of [VALID, COMMERCIAL, { ...VALID, runtime_verification_status: 'runtime_proof', acceptance_pass: true }, {}, null]) {
    assert.throws(() => ae.requireAcceptanceEligible(input), (e) => {
      assert.ok(e instanceof ae.AcceptanceEvidenceError);
      assert.equal(e.reason, 'not_acceptance_eligible');
      assert.match(e.message, /pre_integration/);
      neverEligible(e.result, 'thrown');
      return true;
    });
  }
  ok('24 requireAcceptanceEligible throws for every input, a valid one included');
}

// ---------------------------------------------------------------- 25: every rule names its authority
{
  const expect = {
    record_fields: 'approved', loop_id_shape: 'approved', gate_id_required: 'approved', ev_shape: 'approved',
    runtime_verification_status_vocabulary: 'approved', labels_not_runtime_states: 'approved', closure_state_vocabulary: 'approved',
    acceptance_pass_boolean: 'approved', acceptance_pass_requires_runtime_proof: 'approved', acceptance_pass_conditions: 'approved',
    actor_required: 'approved', approver_shape: 'approved', commercial_ok_requires_human_approver: 'approved', commercial_ok_authority: 'approved',
    loop_accepted_authority: 'approved', technical_status_authority: 'approved', tech_only_default: 'approved',
    evidence_linked_records: 'approved', not_acceptance_evidence: 'approved', slack_link_shape: 'approved', run_ref_epoch: 'approved',
    proof_type: 'approved', historical_not_rewritten: 'approved', no_live_charging: 'approved',
    gate_id_format: 'proposed', actor_shape: 'proposed', approver_required: 'proposed', approver_not_bot_id: 'proposed',
    evidence_field_names: 'proposed', delegation_ref_shape: 'proposed', decision_link_required: 'proposed',
    run_ref_n8n_only: 'proposed', run_ref_workflow_required: 'proposed', supersedes_shape: 'proposed',
    status_text_shape: 'prototype_guard', no_commercial_delegate: 'prototype_guard', evidence_ref_retired: 'prototype_guard',
    combination_not_approved: 'prototype_guard', legacy_not_mapped: 'prototype_guard', derived_not_supplied: 'prototype_guard',
    known_fields_only: 'prototype_guard', never_eligible: 'prototype_guard',
  };
  assert.deepEqual(Object.keys(ae.RULES).sort(), Object.keys(expect).sort(), 'no rule added or removed unseen');
  for (const [id, status] of Object.entries(expect)) assert.equal(ae.RULES[id].status, status, id);
  for (const r of Object.values(ae.RULES)) assert.ok(r.authority.length > 10, `${r.id} names its authority`);
  // Rules resting on Jason's 10 Nov rulings cite the SOP.
  for (const [id, sop] of [['commercial_ok_requires_human_approver', 'b3a349df'], ['labels_not_runtime_states', 'b3a349df'], ['evidence_linked_records', '8034ef06'], ['not_acceptance_evidence', '8034ef06'], ['runtime_verification_status_vocabulary', '2b794599'], ['acceptance_pass_conditions', '2b794599']]) {
    assert.match(ae.RULES[id].authority, new RegExp(sop), id);
  }
  // Proposed rules say what they await.
  for (const r of Object.values(ae.RULES)) if (r.status === 'proposed') assert.match(r.authority, /Design|design|reading|Hardik/, r.id);
  assert.ok(!Object.values(ae.RULES).some((r) => r.status === 'unapproved_vocabulary'), 'no vocabulary is left unapproved, and none is invented');
  // Every issue across the run names a real rule and its true status, and says so when proposed.
  for (const res of all) for (const i of res.issues) {
    assert.ok(ae.RULES[i.rule], `${i.field}: rule ${i.rule} exists`);
    assert.equal(i.rule_status, ae.RULES[i.rule].status, `${i.field}:${i.code}`);
    if (i.rule_status === 'proposed') assert.match(i.message, /proposed rule, awaiting approval/, i.field);
    else assert.doesNotMatch(i.message, /proposed rule/, i.field);
  }
  ok('25 every rule is approved, proposed or a guard with its authority; Jason\'s 10 Nov rules cite their SOPs; proposed refusals say so');
}

// ---------------------------------------------------------------- 26: the sweep
{
  const seen = new Set(all.flatMap((r) => r.issues.map((i) => i.code)));
  assert.deepEqual(ISSUE_CODES.filter((c) => !seen.has(c)), [], 'every documented issue code was produced at least once');
  assert.deepEqual([...seen].filter((c) => !ISSUE_CODES.includes(c)), [], 'no undocumented issue code was produced');
  for (const r of all) {
    neverEligible(r, 'sweep');
    assert.ok(r.blocked_by.length >= STANDING.length);
    if (r.acceptance_pass_requested === true) assert.ok(r.acceptance_pass_blocked_by.length > 0);
    else assert.deepEqual(r.acceptance_pass_blocked_by, []);
  }
  ok(`26 all ${ISSUE_CODES.length} issue codes were produced; every one of ${all.length} results has exactly the expected keys and nothing allowed, eligible or authorizing`);
}

// ---------------------------------------------------------------- 27 (end): nothing reached out
{
  assert.deepEqual(attempts, [], `network or database was attempted: ${attempts.join(', ')}`);
  const loaded = Object.keys(require.cache);
  const reached = loaded.filter((p) => /[\\/]node_modules[\\/]pg[\\/]|[\\/]server[\\/]src[\\/](pg|slack|engineEvents|evidence|chargeGate)\.js$/.test(p));
  assert.deepEqual(reached, [], `the validator loaded ${reached.join(', ')}`);
  const own = loaded.filter((p) => p.includes(`${path.sep}server${path.sep}src${path.sep}`)).map((p) => path.basename(p)).sort();
  assert.deepEqual(own, ['acceptanceEvidence.js', 'proofType.js']);
  ok('27 no socket, request, lookup or fetch was attempted, and only acceptanceEvidence and proofType were loaded');
}

console.log(`\n${n} checks passed`);
