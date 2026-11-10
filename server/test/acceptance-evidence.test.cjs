/**
 * The five-field acceptance-evidence record, structural check only (U0MN, 9 and 10 Nov 2026), with
 * Jason's approved vocabularies of 9 Nov (C0AF7AGC2UV p1794228033482159).
 * Pure: no database, no network, no Slack. Every identifier below is SYNTHETIC: the shapes are real,
 * the records are not, and nothing here says any of them exists. The one real id used is Jason's
 * Slack user id, because the COMMERCIAL_OK rule names him.
 * Run with:  npm run test:acceptance-evidence   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

// ---------------------------------------------------------------- 13: no database, no network
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

// Synthetic identifiers: right shape, invented values.
const VALID = Object.freeze({
  loop_id: 'LOOP-1700000000000-TST1',
  evidence_ref: 'EV-1700000000001-TST2',
  runtime_verification_status: 'Satisfied',
  approver_id: 'U0TESTAPPR1',
  closure_state: 'TECH_ONLY',
  decision_link: 'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456',
});
const RUN = Object.freeze({ system: 'n8n', id_epoch: 0, execution_id: 12345, workflow_id: 'SyntheticWf0001A' });
const codes = (r) => r.issues.map((i) => `${i.field}:${i.code}`);
const hasIssue = (r, field, code) => r.issues.some((i) => i.field === field && i.code === code);
const without = (k) => { const o = { ...VALID }; delete o[k]; return o; };
const JASON = 'U0A9V97949F';
const TECH = ['Satisfied', 'Not Satisfied', 'Not Verified'];
const STATES = ['TECH_ONLY', 'LOOP_ACCEPTED', 'COMMERCIAL_OK'];

function neverEligible(r, label) {
  assert.equal(r.eligible_for_persistence, false, `${label}: never eligible for persistence`);
  assert.equal(r.acceptance_eligible, false, `${label}: never acceptance-eligible`);
  assert.equal(r.references_verified, false, `${label}: references never verified here`);
  assert.equal(r.can_charge_live, false, `${label}: never opens live charging`);
  assert.equal(r.field_mapping, 'provisional', `${label}: the field mapping stays provisional`);
  assert.equal(r.contract_status, 'proposed_pending_approval', `${label}: contract stays proposed`);
  for (const b of ['contract_not_approved', 'field_mapping_unconfirmed', 'approver_authority_not_verified', 'references_not_verified']) {
    assert.ok(r.blocked_by.includes(b), `${label}: blocked_by names ${b}`);
  }
}

// ---------------------------------------------------------------- 1: well-formed identifiers
{
  const r = ae.check({ ...VALID, run_ref: RUN, gate_ref: 'CG-1700000000002-TST3', proof_type: 'test_forced', test: true });
  assert.deepEqual(r.issues, [], codes(r).join(', '));
  assert.equal(r.structurally_valid, true);
  assert.ok(r.normalised);
  assert.deepEqual(r.normalised.decision, { channel: 'C0TESTCHAN1', ts: '1700000000.123456', thread_ts: null });
  assert.deepEqual(r.normalised.run_ref, RUN);
  assert.equal(r.normalised.proof_type, 'test_forced');
  neverEligible(r, 'well-formed');
  assert.ok(!r.blocked_by.includes('structural_issues'));
  ok('1  a well-formed synthetic record is structurally valid, and still not eligible');
}
{
  const r = ae.check({ ...VALID, decision_link: 'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456?thread_ts=1699999999.000100&cid=C0TESTCHAN1', run_ref: { ...RUN, id_epoch: '1', execution_id: '59333' } });
  assert.equal(r.structurally_valid, true, codes(r).join(', '));
  assert.equal(r.normalised.decision.thread_ts, '1699999999.000100');
  assert.equal(r.normalised.run_ref.id_epoch, 1);
  assert.equal(r.normalised.run_ref.execution_id, 59333);
  ok('1b a thread reply link and digit-string run ids are read; epoch 1 is accepted as a shape');
}

// ---------------------------------------------------------------- 2: loop_id
for (const bad of ['LOOP-123-ABCD', 'loop-1700000000000-TST1', 'LOOP-1700000000000-tst1', 'LOOP-1700000000000-TST12', 'https://dashboard/open-loops/LOOP-1700000000000-TST1', 42]) {
  const r = ae.check({ ...VALID, loop_id: bad });
  assert.ok(hasIssue(r, 'loop_id', 'bad_loop_id'), `${bad}: ${codes(r)}`);
  assert.equal(r.structurally_valid, false);
  assert.equal(r.normalised, null);
  assert.ok(r.blocked_by.includes('structural_issues'));
}
assert.ok(hasIssue(ae.check(without('loop_id')), 'loop_id', 'missing'));
ok('2  a malformed or missing loop_id is refused by shape');

// ---------------------------------------------------------------- 3: evidence_ref
for (const bad of ['EV-123-ABCD', 'ev-1700000000001-TST2', 'https://drive.google.com/file/d/synthetic', 'slack:F0SYNTHETIC', 'engine_vfarm_farms / engine_vfarm_devices', 'CG-1700000000002-TST3']) {
  assert.ok(hasIssue(ae.check({ ...VALID, evidence_ref: bad }), 'evidence_ref', 'bad_evidence_ref'), bad);
}
assert.ok(hasIssue(ae.check(without('evidence_ref')), 'evidence_ref', 'missing'));
{
  const r = ae.check({ ...without('evidence_ref'), evidence_reference: 'EV-1700000000001-TST2' });
  assert.ok(hasIssue(r, 'evidence_reference', 'legacy_field_not_mapped'));
  assert.ok(hasIssue(r, 'evidence_ref', 'missing'), 'the legacy name is not read as evidence_ref');
}
ok('3  evidence_ref is an EV id only (provisional); Drive, Slack, n8n and free text are refused; evidence_reference is not mapped');

// ---------------------------------------------------------------- 4: approver
assert.ok(hasIssue(ae.check(without('approver_id')), 'approver_id', 'missing'));
assert.ok(hasIssue(ae.check({ ...VALID, approver_id: null }), 'approver_id', 'missing'));
assert.ok(hasIssue(ae.check({ ...VALID, approver_id: '' }), 'approver_id', 'missing'));
{
  const r = ae.check({ ...VALID, approver_id: 'B0TESTBOT01' });
  assert.ok(hasIssue(r, 'approver_id', 'approver_bot_id_shape'));
  assert.match(r.issues[0].message, /id-shape check only/, 'the refusal says it is a shape check, not proof of a person');
}
for (const bad of ['Jason', 'u0testappr1', '<@U0TESTAPPR1>', 'U12', 7]) {
  assert.ok(hasIssue(ae.check({ ...VALID, approver_id: bad }), 'approver_id', 'bad_approver_id'), String(bad));
}
{
  // owner_id is never converted into approver_id.
  const r = ae.check({ ...without('approver_id'), owner_id: 'U0TESTOWNR1' });
  assert.ok(hasIssue(r, 'owner_id', 'legacy_field_not_mapped'));
  assert.ok(hasIssue(r, 'approver_id', 'missing'));
  assert.equal(r.normalised, null);
}
ok('4  a missing, bot-shaped or malformed approver is refused; owner_id is never taken as the approver');

// ---------------------------------------------------------------- 5: Slack decision link
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
  assert.ok(hasIssue(ae.check({ ...VALID, decision_link: bad }), 'decision_link', 'bad_decision_link'), bad);
}
assert.ok(hasIssue(ae.check(without('decision_link')), 'decision_link', 'missing'));
assert.equal(ae.parseSlackLink('https://example-test.slack.com/archives/G0TESTGRP1/p1700000000000001/').channel, 'G0TESTGRP1');
ok('5  a malformed or missing Slack decision link is refused; the parse is shape only');

// ---------------------------------------------------------------- 6, 7, 8: run reference
{
  const { id_epoch, ...noEpoch } = RUN;
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: noEpoch }), 'run_ref.id_epoch', 'run_epoch_missing'));
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, id_epoch: null } }), 'run_ref.id_epoch', 'run_epoch_missing'));
  for (const bad of [-1, 1.5, '0x1', 32768, 'live']) {
    assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, id_epoch: bad } }), 'run_ref.id_epoch', 'bad_run_epoch'), String(bad));
  }
  ok('6  a run reference without its epoch is refused, never assumed to be 0');
}
{
  // Each malformed input, with the one issue it must produce on run_ref.execution_id.
  const cases = [
    ['72653a', 'bad_run_execution_id'],
    ['7,653', 'bad_run_execution_id'],
    [1.5, 'bad_run_execution_id'],
    [-5, 'bad_run_execution_id'],
    [0, 'bad_run_execution_id'],
    ['', 'bad_run_execution_id'],
    [' 12345', 'bad_run_execution_id'],
    ['1e5', 'bad_run_execution_id'],
    ['exec-72653', 'bad_run_execution_id'],
    [Number.MAX_SAFE_INTEGER + 2, 'bad_run_execution_id'],
    [null, 'run_execution_id_missing'],
  ];
  for (const [bad, code] of cases) {
    const r = ae.check({ ...VALID, run_ref: { ...RUN, execution_id: bad } });
    const onField = r.issues.filter((i) => i.field === 'run_ref.execution_id').map((i) => i.code);
    assert.deepEqual(onField, [code], `${JSON.stringify(bad)}: ${codes(r)}`);
    assert.equal(r.normalised, null);
  }
  const { execution_id, ...noExec } = RUN;
  assert.deepEqual(ae.check({ ...VALID, run_ref: noExec }).issues.map((i) => `${i.field}:${i.code}`), ['run_ref.execution_id:run_execution_id_missing']);
  ok('7  a malformed or missing execution id is refused');
}
{
  const { workflow_id, ...noWf } = RUN;
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: noWf }), 'run_ref.workflow_id', 'run_workflow_id_missing'));
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, workflow_id: '' } }), 'run_ref.workflow_id', 'run_workflow_id_missing'));
  for (const bad of ['short', 'Has Spaces In It', 'wf/../../etc', 123456789]) {
    assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, workflow_id: bad } }), 'run_ref.workflow_id', 'bad_run_workflow_id'), String(bad));
  }
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, system: 'genie' } }), 'run_ref.system', 'unsupported_run_system'));
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { id_epoch: 0, execution_id: 1, workflow_id: 'SyntheticWf0001A' } }), 'run_ref.system', 'unsupported_run_system'));
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: { ...RUN, mode: 'webhook' } }), 'run_ref.mode', 'unknown_field'));
  assert.ok(hasIssue(ae.check({ ...VALID, run_ref: 'n8n:0:12345' }), 'run_ref', 'bad_run_ref'));
  ok('8  a missing or malformed workflow id is refused; only n8n runs, as an object, with no extra keys');
}

// ---------------------------------------------------------------- 9: proof_type
for (const bad of ['live', 'LIVE_NATURAL_PLUS', 'tested', 1]) {
  assert.ok(hasIssue(ae.check({ ...VALID, proof_type: bad }), 'proof_type', 'bad_proof_type'), String(bad));
}
assert.equal(ae.check({ ...VALID, proof_type: 'live_natural' }).normalised.proof_type, 'live_natural');
assert.equal(ae.check({ ...VALID }).normalised.proof_type, null, 'left out is not stated, never live');
ok('9  proof_type is test_forced or live_natural (the approved rule); anything else is refused');

// ---------------------------------------------------------------- 10, 11: the two status fields
for (const [field, label] of [['runtime_verification_status', '10'], ['closure_state', '11']]) {
  const gone = ae.check(without(field));
  assert.ok(hasIssue(gone, field, 'missing'));
  assert.equal(gone[field].value, null);
  assert.equal(gone[field].reason, 'missing');
  assert.ok(hasIssue(ae.check({ ...VALID, [field]: null }), field, 'missing'));
  for (const bad of ['', '   ', 5, 'x'.repeat(ae.STATUS_MAX + 1), 'line\nbreak', ' PASS', 'PASS ', ' PASS ', '\tPASS', 'PASS ']) {
    const r = ae.check({ ...VALID, [field]: bad });
    assert.ok(hasIssue(r, field, 'bad_status'), JSON.stringify(bad).slice(0, 30));
    assert.equal(r[field].value, null, 'a malformed value is not carried, trimmed or otherwise');
    assert.equal(r[field].reason, 'malformed');
    assert.equal(r.normalised, null);
  }
  ok(`${label} a missing or malformed ${field} is refused, never trimmed`);
}
{
  // Inner spaces are part of an approved value and kept exactly.
  const r = ae.check({ ...VALID, runtime_verification_status: 'Not Satisfied' });
  assert.equal(r.runtime_verification_status.value, 'Not Satisfied');
  assert.equal(r.runtime_verification_status.approved, true);
  assert.equal(r.structurally_valid, true);
  ok('11a an approved value with an inner space is carried exactly');
}
{
  // approval_status is never converted into closure_state.
  const r = ae.check({ ...without('closure_state'), approval_status: 'approved' });
  assert.ok(hasIssue(r, 'approval_status', 'legacy_field_not_mapped'));
  assert.ok(hasIssue(r, 'closure_state', 'missing'));
  ok('11b approval_status is refused and never read as closure_state');
}

// ---------------------------------------------------------------- 12: approved vocabularies, exact match
{
  assert.deepEqual([...ae.TECHNICAL_STATUSES], TECH);
  assert.deepEqual([...ae.ACCEPTANCE_STATES], STATES);
  for (const [v, values, field] of [[ae.RUNTIME_VERIFICATION_STATUS_VOCABULARY, TECH, 'runtime_verification_status'], [ae.CLOSURE_STATE_VOCABULARY, STATES, 'closure_state']]) {
    assert.equal(v.approved, true);
    assert.deepEqual([...v.values], values);
    assert.equal(v.field, field);
    assert.equal(v.field_mapping, 'provisional');
    assert.equal(v.source, 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159');
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.values));
  }
  // Every approved value is accepted exactly, and is still not eligible.
  for (const t of TECH) for (const s of STATES) {
    const r = ae.check({ ...VALID, runtime_verification_status: t, closure_state: s, approver_id: s === 'COMMERCIAL_OK' ? JASON : VALID.approver_id });
    assert.equal(r.structurally_valid, true, `${t}/${s}: ${codes(r)}`);
    assert.deepEqual(r.runtime_verification_status, { value: t, approved: true, reason: 'approved_value' });
    assert.deepEqual(r.closure_state, { value: s, approved: true, reason: 'approved_value' });
    neverEligible(r, `${t}/${s}`);
  }
  // Near misses, other spellings and swapped vocabularies are refused, never corrected.
  const nearTech = ['Not satisfied', 'not verified', 'SATISFIED', 'satisfied', 'Not_Satisfied', 'NOT_VERIFIED', 'PASS', 'Pass', 'green', 'runtime_proof', 'TECH_ONLY'];
  const nearState = ['tech_only', 'Tech Only', 'TECH ONLY', 'LOOP ACCEPTED', 'COMMERCIAL OK', 'Commercial_OK', 'Closed', 'approved', 'Satisfied', 'OPEN', 'NOT_ACCEPTED'];
  for (const [field, bads] of [['runtime_verification_status', nearTech], ['closure_state', nearState]]) {
    for (const bad of bads) {
      const r = ae.check({ ...VALID, [field]: bad });
      assert.deepEqual(r.issues.filter((i) => i.field === field).map((i) => i.code), ['unknown_status_value'], `${field}=${bad}: ${codes(r)}`);
      assert.deepEqual(r[field], { value: null, approved: false, reason: 'not_in_vocabulary' });
      assert.equal(r.normalised, null);
      neverEligible(r, bad);
    }
  }
  assert.throws(() => ae.requireAcceptanceEligible({ ...VALID, run_ref: RUN, proof_type: 'live_natural' }), (e) => {
    assert.ok(e instanceof ae.AcceptanceEvidenceError);
    assert.equal(e.reason, 'not_acceptance_eligible');
    assert.equal(e.result.structurally_valid, true);
    assert.match(e.message, /field_mapping_unconfirmed/);
    return true;
  });
  assert.throws(() => ae.requireAcceptanceEligible(null), ae.AcceptanceEvidenceError);
  ok('12 only Jason\'s exact values are accepted; near misses and swapped vocabularies are refused; nothing becomes eligible');
}

// ---------------------------------------------------------------- 14: nothing inferred from a technical Satisfied
{
  // A technical Satisfied, a green charge-gate link and live_natural proof, with no closure_state.
  const r = ae.check({ ...without('closure_state'), runtime_verification_status: 'Satisfied', gate_ref: 'CG-1700000000002-TST3', proof_type: 'live_natural', run_ref: RUN });
  assert.ok(hasIssue(r, 'closure_state', 'missing'));
  assert.equal(r.closure_state.value, null, 'no acceptance state is derived, not even the TECH_ONLY default');
  assert.equal(r.combination, 'incomplete');
  assert.equal(r.normalised, null);
  neverEligible(r, 'technical Satisfied');
  // With an explicit closure_state, the value is exactly what was sent, whatever the technical status says.
  const s = ae.check({ ...VALID, runtime_verification_status: 'Satisfied', closure_state: 'LOOP_ACCEPTED' });
  assert.equal(s.closure_state.value, 'LOOP_ACCEPTED');
  assert.equal(s.normalised.closure_state, 'LOOP_ACCEPTED');
  neverEligible(s, 'Satisfied with explicit state');
  // And no approver is supplied by anything else on the record.
  const t = ae.check({ ...without('approver_id'), runtime_verification_status: 'Satisfied', gate_ref: 'CG-1700000000002-TST3' });
  assert.ok(hasIssue(t, 'approver_id', 'missing'));
  ok('14 no acceptance state or approver is inferred from a technical Satisfied or a gate link');
}

// ---------------------------------------------------------------- 18: authority (only what a pure check can hold)
{
  assert.equal(ae.COMMERCIAL_APPROVER, JASON);
  assert.deepEqual([...ae.DELEGATED_COMMERCIAL_APPROVERS], [], 'no delegate is recognised by this prototype');
  assert.ok(Object.isFrozen(ae.DELEGATED_COMMERCIAL_APPROVERS));
  // COMMERCIAL_OK: Jason only.
  const byJason = ae.check({ ...VALID, closure_state: 'COMMERCIAL_OK', approver_id: JASON });
  assert.deepEqual(byJason.issues, [], codes(byJason).join(', '));
  neverEligible(byJason, 'COMMERCIAL_OK by Jason');
  for (const who of ['U0TESTAPPR1', 'U0AEW3TBYH1', 'U0BKT6MAW2Y', 'W0TESTDELEG']) {
    const r = ae.check({ ...VALID, closure_state: 'COMMERCIAL_OK', approver_id: who });
    const i = r.issues.find((x) => x.code === 'commercial_approver_not_authorized');
    assert.ok(i, `${who}: refused`);
    assert.equal(i.field, 'approver_id');
    assert.equal(i.rule, 'commercial_ok_authority');
    assert.equal(i.rule_status, 'approved');
    assert.equal(r.normalised, null);
    neverEligible(r, `COMMERCIAL_OK by ${who}`);
  }
  // LOOP_ACCEPTED and TECH_ONLY: who owns the loop, and whether the evidence supports the status, are
  // checked later against the source of truth. Here they are named as unverified, never assumed.
  for (const s of ['LOOP_ACCEPTED', 'TECH_ONLY']) {
    const r = ae.check({ ...VALID, closure_state: s });
    assert.equal(r.structurally_valid, true);
    assert.ok(r.unverified_references.some((x) => /LOOP_ACCEPTED: approver_id owns the loop/.test(x)));
    assert.ok(r.unverified_references.some((x) => /supports runtime_verification_status/.test(x)));
    assert.ok(r.blocked_by.includes('approver_authority_not_verified'));
  }
  assert.ok(ae.check({ ...VALID }).unverified_references.some((x) => /separately verified commercial delegation \(none is recognised today\)/.test(x)));
  ok('18 COMMERCIAL_OK is Jason only (no delegate recognised); loop ownership and evidence support stay unverified');
}

// ---------------------------------------------------------------- 19: combinations Jason has not defined
{
  const expectCombo = (t, s) => (t !== 'Satisfied' ? 'not_defined' : s === 'TECH_ONLY' ? 'defined' : 'not_stated');
  const blockFor = { defined: null, not_defined: 'combination_not_defined', not_stated: 'combination_not_stated' };
  for (const t of TECH) for (const s of STATES) {
    const r = ae.check({ ...VALID, runtime_verification_status: t, closure_state: s, approver_id: s === 'COMMERCIAL_OK' ? JASON : VALID.approver_id });
    const want = expectCombo(t, s);
    assert.equal(r.combination, want, `${t}/${s}`);
    for (const b of Object.values(blockFor)) if (b) assert.equal(r.blocked_by.includes(b), b === blockFor[want], `${t}/${s}: ${b}`);
    neverEligible(r, `${t}/${s}`);
  }
  assert.equal(ae.combinationOf('Satisfied', null), 'incomplete');
  assert.equal(ae.combinationOf(null, 'TECH_ONLY'), 'incomplete');
  assert.ok(ae.check(without('runtime_verification_status')).blocked_by.includes('combination_incomplete'));
  // The defined pair is still not eligible: definition is not acceptance.
  assert.equal(ae.check({ ...VALID }).combination, 'defined');
  neverEligible(ae.check({ ...VALID }), 'Satisfied/TECH_ONLY');
  ok('19 only Satisfied/TECH_ONLY is defined; every other pairing blocks, and none becomes eligible');
}

// ---------------------------------------------------------------- 20: no status authorises live charging
{
  const strongest = { ...VALID, runtime_verification_status: 'Satisfied', closure_state: 'COMMERCIAL_OK', approver_id: JASON, gate_ref: 'CG-1700000000002-TST3', proof_type: 'live_natural', run_ref: RUN };
  const r = ae.check(strongest);
  assert.equal(r.structurally_valid, true, codes(r).join(', '));
  assert.equal(r.can_charge_live, false);
  neverEligible(r, 'strongest record');
  // No key anywhere in the result turns charging, offers, payments or stages on.
  const walk = (o, at = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? walk(v, `${at}${k}.`) : [[`${at}${k}`, v]]));
  for (const [k, v] of walk(r)) {
    if (/charge|offer|payment|stage|live/i.test(k)) assert.notEqual(v, true, `${k} must never be true`);
  }
  assert.equal(ae.RULES.no_live_charging.status, 'approved');
  ok('20 COMMERCIAL_OK by Jason on a Satisfied record still leaves can_charge_live false');
}

// ---------------------------------------------------------------- shape guards around the record
{
  for (const bad of [null, undefined, 'string', 5, [VALID]]) {
    const r = ae.check(bad);
    assert.ok(hasIssue(r, '(record)', 'not_an_object'));
    neverEligible(r, String(bad));
  }
  const d = ae.check({ ...VALID, record_id: 'AE-1700000000003-TST4', owner_id_snapshot: 'U0TESTOWNR1' });
  assert.ok(hasIssue(d, 'record_id', 'derived_field_supplied'));
  assert.ok(hasIssue(d, 'owner_id_snapshot', 'derived_field_supplied'));
  assert.ok(hasIssue(ae.check({ ...VALID, verdict: 'green' }), 'verdict', 'unknown_field'));
  assert.ok(hasIssue(ae.check({ ...VALID, supersedes: 'EV-1700000000001-TST2' }), 'supersedes', 'bad_supersedes'));
  assert.ok(hasIssue(ae.check({ ...VALID, gate_ref: 'EV-1700000000001-TST2' }), 'gate_ref', 'bad_gate_ref'));
  assert.ok(hasIssue(ae.check({ ...VALID, test: 'yes' }), 'test', 'bad_test_flag'));
  // The check is pure: the input is not changed and the same input gives the same answer.
  const input = { ...VALID, run_ref: { ...RUN, execution_id: '12345' } };
  const copy = JSON.parse(JSON.stringify(input));
  const a = ae.check(input);
  const b = ae.check(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(a, b);
  ok('15 derived, unknown and wrongly-typed optional fields are refused; the check is pure and repeatable');
}

// ---------------------------------------------------------------- 16: shared state cannot be changed
{
  const frozen = {
    RULES: ae.RULES, JASON_FIELDS: ae.JASON_FIELDS, PROPOSED_REQUIRED: ae.PROPOSED_REQUIRED, REQUIRED: ae.REQUIRED,
    OPTIONAL: ae.OPTIONAL, LEGACY_FIELDS: ae.LEGACY_FIELDS, DERIVED_FIELDS: ae.DERIVED_FIELDS,
    UNVERIFIED_REFERENCES: ae.UNVERIFIED_REFERENCES,
    RUNTIME_VERIFICATION_STATUS_VOCABULARY: ae.RUNTIME_VERIFICATION_STATUS_VOCABULARY, CLOSURE_STATE_VOCABULARY: ae.CLOSURE_STATE_VOCABULARY,
    TECHNICAL_STATUSES: ae.TECHNICAL_STATUSES, ACCEPTANCE_STATES: ae.ACCEPTANCE_STATES, DELEGATED_COMMERCIAL_APPROVERS: ae.DELEGATED_COMMERCIAL_APPROVERS,
  };
  for (const [name, v] of Object.entries(frozen)) assert.ok(Object.isFrozen(v), `${name} is frozen`);
  for (const r of Object.values(ae.RULES)) assert.ok(Object.isFrozen(r), `rule ${r.id} is frozen`);
  // Strict-mode writes to the frozen definitions throw and change nothing.
  assert.throws(() => { 'use strict'; ae.UNVERIFIED_REFERENCES.push('x'); }, TypeError);
  assert.throws(() => { 'use strict'; ae.RULES.evidence_ref_ev_only.status = 'approved'; }, TypeError);
  assert.throws(() => { 'use strict'; ae.REQUIRED.length = 0; }, TypeError);
  assert.equal(ae.RULES.evidence_ref_ev_only.status, 'proposed');
  assert.throws(() => { 'use strict'; ae.TECHNICAL_STATUSES.push('Pass'); }, TypeError);
  assert.throws(() => { 'use strict'; ae.DELEGATED_COMMERCIAL_APPROVERS.push('U0TESTDELEG'); }, TypeError);

  // One result changed by its caller leaves the next result, and the definitions, as they were.
  const input = { ...VALID, run_ref: RUN };
  const first = ae.check(input);
  const baseline = JSON.parse(JSON.stringify(first));
  first.unverified_references.push('tampered');
  first.unverified_references[0] = 'tampered';
  first.blocked_by.length = 0;
  first.proposed_rules_applied.push('tampered');
  first.issues.push({ field: 'x', code: 'unknown_field', message: 'x', rule: 'x', rule_status: 'approved' });
  first.normalised.run_ref.execution_id = 1;
  first.normalised.decision.channel = 'tampered';
  const second = ae.check(input);
  assert.deepEqual(second, baseline, 'the second result is unchanged by what was done to the first');
  assert.notEqual(second.unverified_references, first.unverified_references);
  assert.notEqual(second.blocked_by, first.blocked_by);
  assert.equal(ae.UNVERIFIED_REFERENCES.includes('tampered'), false);
  assert.equal(RUN.execution_id, 12345, 'the caller\'s own input is not changed either');
  ok('16 shared definitions are frozen, and one result changed by its caller cannot change another');
}

// ---------------------------------------------------------------- 17: rule authority
{
  assert.deepEqual([...ae.JASON_FIELDS], ['loop_id', 'evidence_ref', 'runtime_verification_status', 'approver_id', 'closure_state']);
  assert.deepEqual([...ae.PROPOSED_REQUIRED], ['decision_link']);
  assert.ok(!ae.JASON_FIELDS.includes('decision_link'), 'decision_link is not presented as one of Jason\'s fields');
  const expect = {
    evidence_ref_ev_only: 'proposed', approver_required: 'proposed', approver_not_bot_id: 'proposed',
    decision_link_required: 'proposed', run_ref_n8n_only: 'proposed', run_ref_workflow_required: 'proposed',
    supersedes_shape: 'proposed', field_mapping_provisional: 'proposed',
    runtime_verification_status_vocabulary: 'approved', closure_state_vocabulary: 'approved',
    technical_status_authority: 'approved', tech_only_default: 'approved', loop_accepted_authority: 'approved',
    commercial_ok_authority: 'approved', no_live_charging: 'approved',
    proof_type: 'approved', loop_id_shape: 'approved', run_ref_epoch: 'approved', slack_link_shape: 'approved',
    never_eligible: 'prototype_guard', legacy_not_mapped: 'prototype_guard', status_text_shape: 'prototype_guard',
    no_commercial_delegate: 'prototype_guard', combination_defined_only: 'prototype_guard',
  };
  for (const [id, status] of Object.entries(expect)) assert.equal(ae.RULES[id].status, status, id);
  for (const r of Object.values(ae.RULES)) assert.ok(r.authority.length > 10, `${r.id} names its authority`);
  // Every rule taken from Jason's 9 Nov message cites it.
  for (const id of ['runtime_verification_status_vocabulary', 'closure_state_vocabulary']) assert.match(ae.RULES[id].authority, /p1794228033482159/, id);
  for (const id of ['technical_status_authority', 'tech_only_default', 'loop_accepted_authority', 'commercial_ok_authority', 'field_mapping_provisional']) assert.match(ae.RULES[id].authority, /9 Nov/, id);
  assert.ok(!Object.values(ae.RULES).some((r) => r.status === 'unapproved_vocabulary'), 'no vocabulary is left unapproved, and none is invented');

  // Every issue names a real rule and its true status; a refusal on a proposed rule says so.
  const bad = ae.check({ loop_id: 'x', evidence_ref: 'https://drive.google.com/x', approver_id: 'B0TESTBOT01', runtime_verification_status: ' x', closure_state: 'y', run_ref: { system: 'genie', id_epoch: 0, execution_id: 1 }, owner_id: 'U0TESTOWNR1' });
  for (const i of bad.issues) {
    assert.ok(ae.RULES[i.rule], `${i.field}: rule ${i.rule} exists`);
    assert.equal(i.rule_status, ae.RULES[i.rule].status, i.field);
    if (i.rule_status === 'proposed') assert.match(i.message, /proposed rule, awaiting approval/, i.field);
    else assert.doesNotMatch(i.message, /proposed rule/, i.field);
  }
  const by = (f) => bad.issues.find((i) => i.field === f);
  assert.equal(by('evidence_ref').rule, 'evidence_ref_ev_only');
  assert.equal(by('approver_id').rule, 'approver_not_bot_id');
  assert.equal(by('decision_link').rule, 'decision_link_required');
  assert.equal(by('run_ref.system').rule, 'run_ref_n8n_only');
  assert.equal(by('run_ref.workflow_id').rule, 'run_ref_workflow_required');
  assert.equal(by('owner_id').rule_status, 'prototype_guard');
  assert.equal(by('closure_state').rule, 'closure_state_vocabulary');
  assert.equal(by('closure_state').code, 'unknown_status_value');

  // A structurally valid record still lists the proposed rules it passed on, the field mapping among them.
  const good = ae.check({ ...VALID, run_ref: RUN });
  assert.equal(good.structurally_valid, true);
  assert.deepEqual(good.proposed_rules_applied, ['approver_not_bot_id', 'approver_required', 'decision_link_required', 'evidence_ref_ev_only', 'field_mapping_provisional', 'run_ref_n8n_only', 'run_ref_workflow_required']);
  for (const id of good.proposed_rules_applied) assert.equal(ae.RULES[id].status, 'proposed');
  ok('17 every rule names its authority; Jason\'s five are kept apart from decision_link; proposed refusals say so');
}

// ---------------------------------------------------------------- 13 (end): nothing reached out
{
  assert.deepEqual(attempts, [], `network or database was attempted: ${attempts.join(', ')}`);
  const loaded = Object.keys(require.cache);
  const reached = loaded.filter((p) => /[\\/]node_modules[\\/]pg[\\/]|[\\/]server[\\/]src[\\/](pg|slack|engineEvents|evidence|chargeGate)\.js$/.test(p));
  assert.deepEqual(reached, [], `the validator loaded ${reached.join(', ')}`);
  const own = loaded.filter((p) => p.includes(`${path.sep}server${path.sep}src${path.sep}`)).map((p) => path.basename(p)).sort();
  assert.deepEqual(own, ['acceptanceEvidence.js', 'proofType.js']);
  ok('13 no socket, request, lookup or fetch was attempted, and only acceptanceEvidence and proofType were loaded');
}

console.log(`\n${n} checks passed`);
