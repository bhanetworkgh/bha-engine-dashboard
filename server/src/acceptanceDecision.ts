/**
 * The acceptance decision core (O7CU milestone M1, 15 Nov 2026, Hardik). PURE and NOT ENABLED.
 *
 * What it does: given one acceptance record and the facts a future trusted writer would have read
 * (the charge-gate row, the loop, each evidence record, and what Slack said about who posted the
 * decision message), it answers allow or refuse, with every reason. It never reads a database, calls
 * Slack or the network, writes an event, or touches charging. Nothing calls it yet: no tool, route,
 * writer or agent (spec: O7CU_Trusted_Acceptance_Writer_Reader_Spec_Nov15.md, §3 and §8 M1).
 *
 * How it stays one validator, not two (SOP d0606fb6): every rule about the record's shape, its
 * vocabularies, the evidence lists, FS3N, COMMERCIAL_OK's approver and the status combinations is
 * the canonical validator's (acceptanceEvidence.check()). This file never re-checks any of them. It
 * turns each validator issue, and each validator block it cannot clear itself, into a refusal, and
 * adds only what a pure shape check cannot know:
 *   - whether the gate, the loop and every evidence record are held, real (not test) and current;
 *   - whether Slack confirms approver_id posted decision_link;
 *   - whether an authority rule lets this approver make this decision on this gate;
 *   - whether a delegation is involved (refused: no format is agreed);
 *   - whether runtime_proof rests on a natural run (a forced test never counts).
 *
 * Why it refuses everything today: the authority table is EMPTY, no status combination is approved
 * (the validator's combination_not_approved), and the validator's pre_integration and
 * no_trusted_writer blocks are not cleared in M1. Allowing anything needs Jason's decisions (spec §7)
 * and later milestones. Every policy rule here is marked proposed or prototype_guard: none is an
 * approved business rule until Jason or Destiny says so.
 */
import * as ae from './acceptanceEvidence';
import type { EvidenceFact, GateFact, LoopFact } from './acceptanceCheck';

export const MODULE = 'acceptance_decision.m1';
/** M1: a pure core with an empty authority table. It is not wired to anything and allows nothing. */
export const MODULE_STATUS = 'm1_pure_core_not_enabled' as const;

// ---------------------------------------------------------------- rules this file adds

export type DecisionRuleStatus = 'approved' | 'proposed' | 'prototype_guard';
export interface DecisionRule {
  readonly id: string;
  readonly status: DecisionRuleStatus;
  readonly rule: string;
  readonly authority: string;
}
const rule = (id: string, status: DecisionRuleStatus, text: string, authority: string): DecisionRule => Object.freeze({ id, status, rule: text, authority });

export const DECISION_RULES = Object.freeze({
  validator_issues: rule('validator_issues', 'approved', 'Every issue the canonical validator raises refuses the decision.', 'SOP d0606fb6: acceptanceEvidence.ts is the one validator.'),
  validator_blocks: rule('validator_blocks', 'approved', 'Every validator block this core cannot clear refuses: combination_not_approved, acceptance_pass_not_allowed, pre_integration, no_trusted_writer and any other.', 'acceptanceEvidence.ts blocked_by; spec §3.2.'),
  gate_held: rule('gate_held', 'proposed', 'gate_id names a charge-gate row that is held, and the facts are about that row.', 'Spec §4 / W-2. Awaiting Destiny (gate format) and Jason (what is a gate).'),
  gate_real: rule('gate_real', 'proposed', 'A real record cannot rest on a test charge-gate row.', 'Spec §4; as chargeGate never counts a test row.'),
  loop_held: rule('loop_held', 'proposed', 'loop_id names a held loop, and the facts are about that loop.', 'Spec §4 / W-2.'),
  evidence_held: rule('evidence_held', 'proposed', 'Every EV in both evidence lists is held in the evidence store.', 'SOP 8034ef06 (linked records); spec §4 / W-6.'),
  evidence_real: rule('evidence_real', 'proposed', 'A real record cannot rest on a test evidence record.', 'Spec §4 / W-6; as evidence.forGate refuses bundle_is_test.'),
  evidence_current: rule('evidence_current', 'proposed', 'An evidence record a newer version supersedes is refused; the newer one must be named.', 'Spec §4 / W-6.'),
  approver_slack_verified: rule('approver_slack_verified', 'proposed', 'Slack must confirm that approver_id posted decision_link. Not checked, unreadable, not found or another poster refuses.', 'Spec §4 / W-5; the charge gate\'s slackAuthor pattern. Awaiting Destiny (DECISION 3).'),
  authority_rule_required: rule('authority_rule_required', 'prototype_guard', 'An authority rule must name this gate kind, rail, closure state, acceptance_pass and approver. The table is empty, so nothing is authorized.', 'Spec §4 / W-4. Entries only from cited Jason decisions (DECISION 2).'),
  delegation_unsupported: rule('delegation_unsupported', 'prototype_guard', 'Any delegation_ref refuses: no delegation format or verification is agreed.', 'SOP 2b794599 §6 sets the requirement, not the format. Awaiting Jason and Destiny (DECISION 6).'),
  natural_runtime_proof: rule('natural_runtime_proof', 'proposed', 'runtime_proof needs proof_type live_natural. A forced test, or an unstated proof type, never establishes natural runtime proof.', 'SOP a0d187f9 ("real events"); spec W-8. Awaiting Jason (DECISION 7).'),
});
export type DecisionRuleId = keyof typeof DECISION_RULES;

/** Validator blocks this core clears by its own checks (each check that fails is its own refusal). */
export const DISCHARGED_BY_THIS_CORE = Object.freeze(['approver_authority_not_verified', 'references_not_verified'] as const);
/** Validator blocks that only restate its issues; the issues themselves are the refusals. */
const RESTATES_ISSUES = Object.freeze(['structural_issues']);

// ---------------------------------------------------------------- authority (empty)

/** Who may make which decision on which gate. Entries are added only from a cited Jason decision. */
export interface AuthorityRule {
  readonly id: string;
  /** Only charge-gate rows exist as gates today (gate_id CG-, proposed). */
  readonly gate_source: 'engine_charge_gate';
  /** The charge-gate row's own kind, e.g. 'acceptance_pass'. */
  readonly gate_kind: string;
  /** The charge-gate row's rail, e.g. 'vfarm_stripe_live'. */
  readonly rail: string;
  readonly closure_state: ae.AcceptanceState;
  readonly acceptance_pass: boolean;
  /** Slack user ids of the people who may decide this. */
  readonly approvers: readonly string[];
  /** The SOP id or Slack permalink of Jason's decision this entry rests on. */
  readonly source: string;
}

/** EMPTY in M1. No actor has implicit authority. */
export const AUTHORITY: readonly AuthorityRule[] = Object.freeze([]);

// ---------------------------------------------------------------- inputs and outputs

/** acceptanceCheck's gate fact, plus the row's rail, which an authority rule must match. */
export interface DecisionGateFact extends GateFact {
  rail?: string | null;
}

/** What Slack said about who posted decision_link (the charge gate's slackAuthor shape). */
export type SlackAuthorFact = { ok: true; user: string | null } | { ok: false; reason: 'not_found' | 'unreadable' };

/** Facts a future writer reads before deciding. Never supplied by an agent or a caller's record. */
export interface DecisionFacts {
  gate: DecisionGateFact | null;
  loop: LoopFact | null;
  evidence: Readonly<Record<string, EvidenceFact | undefined>>;
  /** null: Slack was not asked, which refuses like any unverified approver. */
  approver_slack: SlackAuthorFact | null;
}

export interface DecisionInput {
  record: unknown;
  facts: DecisionFacts;
}

export interface Refusal {
  code: string;
  /** 'validator': the canonical validator said so. 'decision': this core said so. */
  source: 'validator' | 'decision';
  /** The rule id, from acceptanceEvidence.RULES or DECISION_RULES. */
  rule: string;
  rule_status: string;
  field: string | null;
  message: string;
}

export interface AcceptanceDecision {
  module: typeof MODULE;
  module_status: typeof MODULE_STATUS;
  contract: typeof ae.CONTRACT;
  /** 'allow' only when nothing refuses. In M1 it is always 'refuse'. */
  decision: 'allow' | 'refuse';
  refusals: Refusal[];
  /** The authority rule that matched, or null. */
  authority_rule: string | null;
  /** The proposed or guard rules this answer relied on, so a reader can tell them from approved ones. */
  provisional_rules_applied: string[];
  /** The canonical validator's own answer, as returned. */
  validation: ae.CheckResult;
  /** Fixed: this core decides; it never authorizes, persists or charges anything itself. */
  authorizes: false;
  persisted: false;
  can_charge_live: false;
}

// ---------------------------------------------------------------- the decision

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
const evList = (o: Record<string, unknown>, k: string): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string' && ae.EV_ID.test(x)) : []);

class Refusals {
  readonly list: Refusal[] = [];
  readonly provisional = new Set<string>();
  decision(id: DecisionRuleId, code: string, field: string | null, message: string): void {
    const r = DECISION_RULES[id];
    if (r.status !== 'approved') this.provisional.add(id);
    this.list.push({ code, source: 'decision', rule: id, rule_status: r.status, field, message });
  }
  rely(id: DecisionRuleId): void {
    if (DECISION_RULES[id].status !== 'approved') this.provisional.add(id);
  }
}

/**
 * Decides one record against an authority table. PURE: no clock, no randomness, no I/O; it reads its
 * inputs and changes none of them. Exported for tests with a synthetic table; a future writer calls
 * decide(), which always uses AUTHORITY.
 */
export function decideWith(authority: readonly AuthorityRule[], input: DecisionInput): AcceptanceDecision {
  const out = new Refusals();
  const record = input?.record;
  const facts: DecisionFacts = input?.facts ?? { gate: null, loop: null, evidence: {}, approver_slack: null };
  const validation = ae.check(record);

  // 1. The canonical validator: every issue, and every block this core does not clear.
  for (const i of validation.issues) {
    out.list.push({ code: i.code, source: 'validator', rule: i.rule, rule_status: i.rule_status, field: i.field, message: i.message });
  }
  for (const b of validation.blocked_by) {
    if ((DISCHARGED_BY_THIS_CORE as readonly string[]).includes(b) || RESTATES_ISSUES.includes(b)) continue;
    out.list.push({ code: b, source: 'validator', rule: 'validator_blocks', rule_status: DECISION_RULES.validator_blocks.status, field: null, message: `The canonical validator blocks this record: ${b}.` });
  }

  const o = isObj(record) ? record : {};
  const realRecord = o.test !== true;
  const gateId = str(o, 'gate_id');
  const loopId = str(o, 'loop_id');
  const approverId = str(o, 'approver_id');
  const closure = str(o, 'closure_state');
  const pass = typeof o.acceptance_pass === 'boolean' ? o.acceptance_pass : null;

  // 2. The gate.
  out.rely('gate_held');
  const gate = facts.gate;
  if (!gate) out.decision('gate_held', 'gate_not_held', 'gate_id', `${gateId ?? 'The gate'} is not a charge-gate row held here.`);
  else if (gate.gate_id !== gateId) out.decision('gate_held', 'gate_fact_mismatch', 'gate_id', `The gate facts are about ${gate.gate_id}, not ${gateId ?? 'the record\'s gate'}.`);
  else if (gate.test && realRecord) out.decision('gate_real', 'gate_is_test', 'gate_id', `${gate.gate_id} is a test charge-gate row; a real record cannot rest on it.`);

  // 3. The loop.
  out.rely('loop_held');
  const loop = facts.loop;
  if (!loop) out.decision('loop_held', 'loop_not_held', 'loop_id', `${loopId ?? 'The loop'} is not a loop held here.`);
  else if (loop.natural_id !== loopId) out.decision('loop_held', 'loop_fact_mismatch', 'loop_id', `The loop facts are about ${loop.natural_id}, not ${loopId ?? 'the record\'s loop'}.`);

  // 4. The evidence, each list on its own (the lists' shape is the validator's).
  out.rely('evidence_held');
  for (const list of ['contract_evidence_refs', 'implementation_evidence_refs'] as const) {
    for (const id of evList(o, list)) {
      const e = facts.evidence[id];
      if (!e || e.evidence_id !== id) out.decision('evidence_held', 'evidence_not_held', list, `${id} is not held in the evidence store.`);
      else if (e.test && realRecord) out.decision('evidence_real', 'evidence_is_test', list, `${id} (${e.name}) is a test record; a real record cannot rest on it.`);
      else if (e.superseded_by) out.decision('evidence_current', 'evidence_superseded', list, `${id} (${e.name}) is superseded by ${e.superseded_by}; name the current version.`);
    }
  }

  // 5. The approver, as Slack says, never as declared.
  out.rely('approver_slack_verified');
  const slack = facts.approver_slack;
  if (!slack) out.decision('approver_slack_verified', 'approver_not_verified', 'approver_id', 'Slack was not asked who posted decision_link, so approver_id is not verified.');
  else if (!slack.ok) out.decision('approver_slack_verified', 'approver_unverifiable', 'approver_id', `Slack could not confirm who posted decision_link (${slack.reason}).`);
  else if (!approverId || slack.user !== approverId) out.decision('approver_slack_verified', 'approver_not_author', 'approver_id', `Slack says ${slack.user ?? 'no person'} posted decision_link, not ${approverId ?? 'the named approver'}.`);

  // 6. Delegation: no format is agreed, so any delegation refuses.
  out.rely('delegation_unsupported');
  if (o.delegation_ref !== undefined && o.delegation_ref !== null) {
    out.decision('delegation_unsupported', 'delegation_unsupported', 'delegation_ref', 'No delegation format or verification is agreed yet; a delegated decision cannot be accepted.');
  }

  // 7. Natural runtime proof.
  out.rely('natural_runtime_proof');
  if (o.runtime_verification_status === 'runtime_proof' && o.proof_type !== 'live_natural') {
    out.decision('natural_runtime_proof', 'runtime_proof_not_natural', 'proof_type', `runtime_proof needs proof_type live_natural; ${typeof o.proof_type === 'string' ? `"${o.proof_type}"` : 'an unstated proof type'} does not establish natural runtime proof.`);
  }

  // 8. Authority: a rule must name this gate, decision and approver. The table is empty in M1.
  out.rely('authority_rule_required');
  let matched: AuthorityRule | null = null;
  const candidates = gate && gate.gate_id === gateId
    ? authority.filter((r) => r.gate_source === 'engine_charge_gate' && r.gate_kind === gate.kind && typeof gate.rail === 'string' && r.rail === gate.rail && r.closure_state === closure && r.acceptance_pass === pass)
    : [];
  if (gate && gate.gate_id === gateId && typeof gate.rail !== 'string') {
    out.decision('authority_rule_required', 'gate_rail_unknown', 'gate_id', `${gate.gate_id}'s rail is not known, so no authority rule can be matched.`);
  } else if (candidates.length === 0) {
    out.decision('authority_rule_required', 'gate_authority_undefined', 'gate_id', `No authority rule names ${gateId ?? 'this gate'} for ${closure ?? 'this state'} with acceptance_pass ${String(pass)}. Nobody is authorized.`);
  } else {
    matched = candidates.find((r) => approverId !== null && r.approvers.includes(approverId)) ?? null;
    if (!matched) out.decision('authority_rule_required', 'approver_not_authorized_for_gate', 'approver_id', `${approverId ?? 'The approver'} is not named by the authority rule for this gate and decision.`);
  }

  return {
    module: MODULE,
    module_status: MODULE_STATUS,
    contract: ae.CONTRACT,
    decision: out.list.length === 0 ? 'allow' : 'refuse',
    refusals: out.list,
    authority_rule: matched ? matched.id : null,
    provisional_rules_applied: [...out.provisional].sort(),
    validation,
    authorizes: false,
    persisted: false,
    can_charge_live: false,
  };
}

/** Decides one record against the real authority table (empty in M1, so every answer refuses). */
export function decide(input: DecisionInput): AcceptanceDecision {
  return decideWith(AUTHORITY, input);
}
