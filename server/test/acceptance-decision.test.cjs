/**
 * The acceptance decision core (acceptanceDecision.ts, O7CU M1): pure, not enabled, empty authority.
 * No database, no network, no Slack, no events. Every identifier is SYNTHETIC except Jason's Slack id,
 * which the COMMERCIAL_OK rule names, and EV-1794203909317-FS3N, which the evidence rule names.
 * Facts are typed in here; nothing reads them from anywhere.
 * Run with:  npm run test:acceptance-decision   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

// ---------------------------------------------------------------- 10: no database, no network
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
const dc = require(path.join(DIST, 'server/src', 'acceptanceDecision.js'));
const ae = require(path.join(DIST, 'server/src', 'acceptanceEvidence.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const JASON = 'U0A9V97949F';
const APPROVER = 'U0TESTAPPR1';
const GATE = 'CG-1700000000002-TST3';
const LOOP = 'LOOP-1700000000000-TST1';
const C_EV = 'EV-1700000000001-TST2';
const I_EV = 'EV-1700000000004-TST5';
const LINK = 'https://example-test.slack.com/archives/C0TESTCHAN1/p1700000000123456';

// The strongest record the validator accepts today: well-formed, real, runtime_proof on a natural run.
const RECORD = Object.freeze({
  gate_id: GATE,
  loop_id: LOOP,
  runtime_verification_status: 'runtime_proof',
  acceptance_pass: false,
  actor_id: 'U0TESTACTR1',
  approver_id: APPROVER,
  closure_state: 'LOOP_ACCEPTED',
  contract_evidence_refs: Object.freeze([C_EV]),
  implementation_evidence_refs: Object.freeze([I_EV]),
  decision_link: LINK,
  proof_type: 'live_natural',
});
const ev = (id, extra = {}) => Object.freeze({ evidence_id: id, name: `synthetic-${id.slice(-4).toLowerCase()}`, test: false, gate: 'charge_gate', loop_id: LOOP, superseded_by: null, ...extra });
// Every fact as a future writer would find it if everything were in order.
const FACTS = Object.freeze({
  gate: Object.freeze({ gate_id: GATE, kind: 'acceptance_pass', verdict: 'green', test: false, decided_by: APPROVER, recorded_by: APPROVER, evidence_channel: 'C0TESTCHAN1', evidence_ts: '1700000000.123456', bundle_ref: C_EV, rail: 'vfarm_stripe_live' }),
  loop: Object.freeze({ natural_id: LOOP, status: 'In Progress', builder_id: 'hardik', assignee: APPROVER }),
  evidence: Object.freeze({ [C_EV]: ev(C_EV), [I_EV]: ev(I_EV) }),
  approver_slack: Object.freeze({ ok: true, user: APPROVER }),
});
// A synthetic authority table, for tests only: it names the record's exact gate, decision and approver.
const SYNTHETIC_AUTHORITY = Object.freeze([Object.freeze({
  id: 'test:cg:vfarm_stripe_live:loop_accepted', gate_source: 'engine_charge_gate', gate_kind: 'acceptance_pass', rail: 'vfarm_stripe_live',
  closure_state: 'LOOP_ACCEPTED', acceptance_pass: false, approvers: Object.freeze([APPROVER]), source: 'synthetic test fixture, not a Jason decision',
})]);

const EXPECTED_KEYS = Object.freeze(['authority_rule', 'authorizes', 'can_charge_live', 'contract', 'decision', 'module', 'module_status', 'persisted', 'provisional_rules_applied', 'refusals', 'validation']);
// The refusal codes this core may raise itself. Anything about the record's shape must come from the validator.
const DECISION_CODES = Object.freeze(['gate_not_held', 'gate_fact_mismatch', 'gate_is_test', 'loop_not_held', 'loop_fact_mismatch', 'evidence_not_held', 'evidence_is_test', 'evidence_superseded', 'approver_not_verified', 'approver_unverifiable', 'approver_not_author', 'delegation_unsupported', 'runtime_proof_not_natural', 'gate_rail_unknown', 'gate_authority_undefined', 'approver_not_authorized_for_gate']);

const all = [];
function decide(record, facts = FACTS) { const d = dc.decide({ record, facts }); all.push(d); return d; }
function decideWith(table, record, facts = FACTS) { const d = dc.decideWith(table, { record, facts }); all.push(d); return d; }
const codes = (d) => d.refusals.map((r) => r.code);
const has = (d, code) => d.refusals.some((r) => r.code === code);
const mine = (d) => d.refusals.filter((r) => r.source === 'decision').map((r) => r.code);

function neverAuthorizes(d, label) {
  assert.deepEqual(Object.keys(d).sort(), [...EXPECTED_KEYS].sort(), `${label}: exact keys`);
  assert.equal(d.decision, 'refuse', `${label}: M1 refuses`);
  assert.ok(d.refusals.length > 0, `${label}: at least one reason`);
  assert.equal(d.authorizes, false, `${label}: never authorizes`);
  assert.equal(d.persisted, false, `${label}: never persists`);
  assert.equal(d.can_charge_live, false, `${label}: never charges`);
  assert.equal(d.module_status, 'm1_pure_core_not_enabled');
  assert.equal(d.validation.can_charge_live, false);
  assert.equal(d.validation.acceptance_pass_allowed, false);
}

// ---------------------------------------------------------------- 1: empty authority table refuses
{
  assert.deepEqual([...dc.AUTHORITY], [], 'the real authority table is empty');
  assert.ok(Object.isFrozen(dc.AUTHORITY));
  const d = decide(RECORD);
  neverAuthorizes(d, 'empty table');
  assert.ok(has(d, 'gate_authority_undefined'), codes(d).join(', '));
  assert.equal(d.authority_rule, null);
  // The same input with the synthetic table no longer raises the authority refusal, which proves the
  // refusal above comes from the empty table, not from anything else.
  const s = decideWith(SYNTHETIC_AUTHORITY, RECORD);
  assert.ok(!has(s, 'gate_authority_undefined'), codes(s).join(', '));
  assert.equal(s.authority_rule, 'test:cg:vfarm_stripe_live:loop_accepted');
  ok('1  the real authority table is empty and frozen, and an otherwise ordered record is refused gate_authority_undefined');
}

// ---------------------------------------------------------------- 2: unknown or unverified actor refuses
{
  const notAsked = decide(RECORD, { ...FACTS, approver_slack: null });
  assert.ok(has(notAsked, 'approver_not_verified'));
  for (const reason of ['unreadable', 'not_found']) assert.ok(has(decide(RECORD, { ...FACTS, approver_slack: { ok: false, reason } }), 'approver_unverifiable'), reason);
  for (const user of ['U0SOMEONEX1', null]) assert.ok(has(decide(RECORD, { ...FACTS, approver_slack: { ok: true, user } }), 'approver_not_author'), String(user));
  // A declared approver Slack did not confirm is refused even when an authority rule names them.
  const declared = decideWith(SYNTHETIC_AUTHORITY, RECORD, { ...FACTS, approver_slack: { ok: true, user: 'U0SOMEONEX1' } });
  assert.ok(has(declared, 'approver_not_author'));
  // A verified approver the authority rule does not name is refused.
  const other = { ...RECORD, approver_id: 'U0OTHERAPR1' };
  const unnamed = decideWith(SYNTHETIC_AUTHORITY, other, { ...FACTS, approver_slack: { ok: true, user: 'U0OTHERAPR1' } });
  assert.ok(has(unnamed, 'approver_not_authorized_for_gate'), codes(unnamed).join(', '));
  // A malformed actor is the validator's to refuse, not this core's.
  const badActor = decide({ ...RECORD, actor_id: 'Hardik' });
  assert.ok(badActor.refusals.some((r) => r.code === 'bad_actor_id' && r.source === 'validator'));
  for (const d of [notAsked, declared, unnamed, badActor]) neverAuthorizes(d, 'actor');
  ok('2  an approver Slack did not confirm, could not confirm or was not asked about is refused; so is one no rule names');
}

// ---------------------------------------------------------------- 3: unknown gate refuses
{
  assert.ok(has(decide(RECORD, { ...FACTS, gate: null }), 'gate_not_held'));
  assert.ok(has(decide(RECORD, { ...FACTS, gate: { ...FACTS.gate, gate_id: 'CG-1700000000009-OTHR' } }), 'gate_fact_mismatch'));
  assert.ok(has(decide(RECORD, { ...FACTS, gate: { ...FACTS.gate, test: true } }), 'gate_is_test'));
  // A test record may rest on a test gate row; the record itself is still refused for other reasons.
  assert.ok(!has(decide({ ...RECORD, test: true }, { ...FACTS, gate: { ...FACTS.gate, test: true } }), 'gate_is_test'));
  // No rail: no authority rule can match, even with the synthetic table.
  const noRail = { ...FACTS.gate }; delete noRail.rail;
  assert.ok(has(decideWith(SYNTHETIC_AUTHORITY, RECORD, { ...FACTS, gate: noRail }), 'gate_rail_unknown'));
  // A non-charge-gate id is the validator's (proposed) refusal.
  const vfarm = decide({ ...RECORD, gate_id: 'VFARM_STAGE1' });
  assert.ok(vfarm.refusals.some((r) => r.code === 'gate_id_format_undefined' && r.source === 'validator'));
  assert.ok(has(decide(RECORD, { ...FACTS, loop: null }), 'loop_not_held'));
  assert.ok(has(decide(RECORD, { ...FACTS, loop: { ...FACTS.loop, natural_id: 'LOOP-1700000000009-OTHR' } }), 'loop_fact_mismatch'));
  ok('3  an unheld, mismatched or test gate, a gate with no rail, a non-CG gate id, and an unheld or mismatched loop each refuse');
}

// ---------------------------------------------------------------- 4: invalid or missing evidence refuses
{
  assert.ok(has(decide(RECORD, { ...FACTS, evidence: { [C_EV]: ev(C_EV) } }), 'evidence_not_held'));
  assert.ok(has(decide(RECORD, { ...FACTS, evidence: { [C_EV]: ev(C_EV, { test: true }), [I_EV]: ev(I_EV) } }), 'evidence_is_test'));
  assert.ok(has(decide(RECORD, { ...FACTS, evidence: { [C_EV]: ev(C_EV), [I_EV]: ev(I_EV, { superseded_by: 'EV-1700000000005-TST6' }) } }), 'evidence_superseded'));
  // A fact filed under the wrong id is not held.
  assert.ok(has(decide(RECORD, { ...FACTS, evidence: { [C_EV]: ev(I_EV), [I_EV]: ev(I_EV) } }), 'evidence_not_held'));
  // The validator's evidence rules come through as the validator's refusals, not re-checked here.
  const viaValidator = [
    [{ ...RECORD, contract_evidence_refs: ['EV-1794203909317-FS3N'] }, 'not_acceptance_evidence'],
    [{ ...RECORD, implementation_evidence_refs: [] }, 'evidence_refs_empty'],
    [{ ...RECORD, implementation_evidence_refs: [C_EV] }, 'evidence_ref_in_both_lists'],
    [{ ...RECORD, contract_evidence_refs: undefined }, 'missing'],
  ];
  for (const [rec, code] of viaValidator) {
    const d = decide(rec);
    assert.ok(d.refusals.some((r) => r.code === code && r.source === 'validator'), `${code}: ${codes(d)}`);
    neverAuthorizes(d, code);
  }
  ok('4  unheld, test, superseded or misfiled evidence refuses here; FS3N, empty, shared or missing lists refuse through the validator');
}

// ---------------------------------------------------------------- 5: unsupported status combination refuses
{
  for (const s of ae.RUNTIME_VERIFICATION_STATES) for (const c of ae.ACCEPTANCE_STATES) {
    const rec = { ...RECORD, runtime_verification_status: s, closure_state: c, approver_id: c === 'COMMERCIAL_OK' ? JASON : APPROVER };
    const facts = { ...FACTS, approver_slack: { ok: true, user: rec.approver_id } };
    const d = decide(rec, facts);
    const combo = d.refusals.find((r) => r.code === 'combination_not_approved');
    assert.ok(combo, `${s}/${c}: ${codes(d)}`);
    assert.equal(combo.source, 'validator', 'the combination rule is the validator\'s, not a copy here');
    neverAuthorizes(d, `${s}/${c}`);
  }
  // COMMERCIAL_OK by anyone but Jason stays refused by the validator, even if a table named them.
  const table = [{ ...SYNTHETIC_AUTHORITY[0], id: 'test:commercial', closure_state: 'COMMERCIAL_OK' }];
  const d = decideWith(table, { ...RECORD, closure_state: 'COMMERCIAL_OK' });
  assert.ok(d.refusals.some((r) => r.code === 'commercial_approver_not_authorized' && r.source === 'validator'));
  ok('5  every runtime-state and closure-state pairing is refused as not approved, by the validator\'s own rule; COMMERCIAL_OK stays Jason\'s');
}

// ---------------------------------------------------------------- 6: invalid delegation refuses
{
  const d = decide({ ...RECORD, delegation_ref: 'EV-1700000000006-TST7' });
  assert.ok(has(d, 'delegation_unsupported'));
  assert.equal(d.refusals.find((r) => r.code === 'delegation_unsupported').rule_status, 'prototype_guard');
  // Even with the synthetic table and every other fact in order.
  assert.ok(has(decideWith(SYNTHETIC_AUTHORITY, { ...RECORD, delegation_ref: 'EV-1700000000006-TST7' }), 'delegation_unsupported'));
  const bad = decide({ ...RECORD, delegation_ref: 'not-an-ev' });
  assert.ok(bad.refusals.some((r) => r.code === 'bad_delegation_ref' && r.source === 'validator'));
  assert.ok(has(bad, 'delegation_unsupported'));
  assert.ok(!has(decide(RECORD), 'delegation_unsupported'), 'no delegation, no delegation refusal');
  ok('6  any delegation_ref refuses (no format agreed); a malformed one is also refused by the validator');
}

// ---------------------------------------------------------------- 7: a forced test is not natural runtime proof
{
  for (const proof of ['test_forced', undefined]) {
    const rec = { ...RECORD }; if (proof === undefined) delete rec.proof_type; else rec.proof_type = proof;
    const d = decide(rec);
    assert.ok(has(d, 'runtime_proof_not_natural'), `${String(proof)}: ${codes(d)}`);
    assert.equal(d.refusals.find((r) => r.code === 'runtime_proof_not_natural').rule_status, 'proposed');
  }
  assert.ok(!has(decide(RECORD), 'runtime_proof_not_natural'), 'live_natural carries runtime_proof');
  for (const s of ['unresolved', 'contract_pass', 'implementation_pass']) {
    assert.ok(!has(decide({ ...RECORD, runtime_verification_status: s, proof_type: 'test_forced' }), 'runtime_proof_not_natural'), s);
  }
  ok('7  runtime_proof on a forced test, or on an unstated proof type, is refused; below runtime_proof a forced test is not refused for that');
}

// ---------------------------------------------------------------- 8: valid canonical evidence alone does not authorize
{
  assert.equal(ae.check(RECORD).structurally_valid, true, 'the canonical validator accepts the record as well-formed');
  const d = decideWith(SYNTHETIC_AUTHORITY, RECORD);
  assert.deepEqual(mine(d), [], `every fact and the synthetic authority are in order: ${codes(d)}`);
  // What is left is only what the validator itself blocks, and nothing this core can clear.
  assert.deepEqual(d.refusals.map((r) => `${r.source}:${r.code}`).sort(), ['validator:combination_not_approved', 'validator:no_trusted_writer', 'validator:pre_integration']);
  neverAuthorizes(d, 'strongest possible M1 input');
  ok('8  a well-formed record with every fact in order and a matching (synthetic) rule is still refused: no approved combination, not integrated, no writer');
}

// ---------------------------------------------------------------- 9: deterministic, and nothing changed
{
  const input = { record: JSON.parse(JSON.stringify({ ...RECORD, delegation_ref: 'EV-1700000000006-TST7' })), facts: JSON.parse(JSON.stringify(FACTS)) };
  const snapshot = JSON.stringify(input);
  const deepFreeze = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return o; };
  deepFreeze(input);
  const a = dc.decide(input);
  const b = dc.decide(input);
  assert.deepEqual(a, b, 'the same input gives the same answer');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'byte for byte');
  assert.equal(JSON.stringify(input), snapshot, 'inputs unchanged');
  a.refusals.push({ code: 'tampered' }); a.provisional_rules_applied.push('tampered');
  const c = dc.decide(input);
  assert.ok(!c.refusals.some((r) => r.code === 'tampered') && !c.provisional_rules_applied.includes('tampered'), 'answers share nothing');
  // Missing or odd input still answers, and refuses.
  for (const bad of [undefined, null, {}, { record: null, facts: null }, { record: RECORD }]) {
    const d = dc.decide(bad);
    neverAuthorizes(d, JSON.stringify(bad) ?? 'undefined');
  }
  assert.ok(Object.isFrozen(dc.DECISION_RULES) && Object.isFrozen(dc.DISCHARGED_BY_THIS_CORE));
  for (const r of Object.values(dc.DECISION_RULES)) assert.ok(Object.isFrozen(r), r.id);
  ok('9  identical inputs give identical answers; frozen inputs are read unchanged; odd input refuses; answers and rules cannot be changed');
}

// ---------------------------------------------------------------- 11: one validator, no parallel rules
{
  // Every refusal this core raises itself is one of its own fact, identity, authority, delegation or
  // proof codes; every shape or vocabulary refusal is the validator's, exactly as check() returned it.
  for (const d of all) {
    for (const r of d.refusals) {
      if (r.source === 'decision') {
        assert.ok(DECISION_CODES.includes(r.code), `unexpected decision code ${r.code}`);
        assert.ok(dc.DECISION_RULES[r.rule], `rule ${r.rule} exists`);
        assert.equal(r.rule_status, dc.DECISION_RULES[r.rule].status);
      } else {
        assert.equal(r.source, 'validator');
      }
    }
    const fromValidator = d.refusals.filter((r) => r.source === 'validator' && r.rule !== 'validator_blocks').map((r) => `${r.field}:${r.code}`);
    assert.deepEqual(fromValidator, d.validation.issues.map((i) => `${i.field}:${i.code}`), 'the validator\'s issues, unchanged and in order');
  }
  const statuses = Object.fromEntries(Object.values(dc.DECISION_RULES).map((r) => [r.id, r.status]));
  assert.deepEqual(statuses, {
    validator_issues: 'approved', validator_blocks: 'approved',
    gate_held: 'proposed', gate_real: 'proposed', loop_held: 'proposed', evidence_held: 'proposed', evidence_real: 'proposed', evidence_current: 'proposed',
    approver_slack_verified: 'proposed', natural_runtime_proof: 'proposed',
    authority_rule_required: 'prototype_guard', delegation_unsupported: 'prototype_guard',
  });
  for (const r of Object.values(dc.DECISION_RULES)) if (r.status !== 'approved') assert.match(r.authority, /Awaiting|Spec|spec/, `${r.id} says what it rests on`);
  assert.deepEqual(decide(RECORD).provisional_rules_applied, ['approver_slack_verified', 'authority_rule_required', 'delegation_unsupported', 'evidence_held', 'gate_held', 'loop_held', 'natural_runtime_proof']);
  ok('11 this core adds only fact, identity, authority, delegation and proof refusals; shape rules come from the validator unchanged; every policy rule is proposed or a guard');
}

// ---------------------------------------------------------------- 12: the sweep
{
  assert.ok(all.length >= 40, `checked ${all.length} answers`);
  const seen = new Set(all.flatMap((d) => mine(d)));
  assert.deepEqual(DECISION_CODES.filter((c) => !seen.has(c)), [], 'every decision code was produced by a real case');
  for (const d of all) neverAuthorizes(d, 'sweep');
  ok(`12 all ${DECISION_CODES.length} decision codes were produced; all ${all.length} answers refuse, with exact keys, and none authorizes, persists or charges`);
}

// ---------------------------------------------------------------- 10 (end): nothing reached out or was loaded
{
  assert.deepEqual(attempts, [], `network or database was attempted: ${attempts.join(', ')}`);
  const loaded = Object.keys(require.cache);
  const reached = loaded.filter((p) => /[\\/]node_modules[\\/]pg[\\/]|[\\/]server[\\/]src[\\/](pg|slack|engineEvents|evidence|chargeGate|acceptanceCheck|mirror)\.js$/.test(p));
  assert.deepEqual(reached, [], `the core loaded ${reached.join(', ')}`);
  const own = loaded.filter((p) => p.includes(`${path.sep}server${path.sep}src${path.sep}`)).map((p) => path.basename(p)).sort();
  assert.deepEqual(own, ['acceptanceDecision.js', 'acceptanceEvidence.js', 'proofType.js']);
  assert.deepEqual(Object.keys(dc).filter((k) => typeof dc[k] === 'function').sort(), ['decide', 'decideWith'], 'the module exports only the two decision functions');
  ok('10 no socket, request, lookup or fetch; only the core, the validator and proofType were loaded; no event, database or charging code');
}

console.log(`\n${n} checks passed`);
