/**
 * Acceptance-State Contract v0: structural check only (C1, pre-integration, 11 Nov 2026).
 *
 * TEMPORARY, ISOLATED CONTRACT-ALIGNMENT MODULE. It is not a second canonical validator. It exists
 * so the wording of Jason's Acceptance-State Contract v0 (SOP 2b794599-7862-4da7-b2bc-45d33f79aa52,
 * 10 Nov 2026, Slack ts 1794316291.026599) is held in code and tested before anything relies on it.
 * Whether it later replaces, merges with or sits beside acceptanceEvidence.ts (PR #23) is Jason's and
 * Destiny's decision, and nothing here assumes the answer.
 *
 * What this file is:
 *   - PURE. No database, no network, no clock, no randomness, no writes. Its only import is
 *     acceptanceEvidence.ts, for the shapes and the legacy field list it already holds (that file is
 *     pure too and imports only proofType.ts).
 *   - CALLED BY NOTHING. No route, tool, writer or consumer imports it.
 *   - NON-AUTHORIZING. Every result carries acceptance_pass_allowed, eligible_for_persistence,
 *     authorizes and can_charge_live as the literal false, and requireV0AcceptanceEligible always
 *     throws.
 *
 * What it holds from the SOP, as written:
 *   - the logical fields of §2: gate_id, loop_id, runtime_verification_status, acceptance_pass,
 *     actor_id and delegation_ref;
 *   - the exact runtime_verification_status vocabulary of §3: unresolved, contract_pass,
 *     implementation_pass, runtime_proof. "No other values are allowed";
 *   - the acceptance_pass rule of §4 and §6: true only with runtime_proof, contract evidence,
 *     implementation evidence and a valid direct authorization or delegation, otherwise false;
 *   - §5 and §7, and SOP cd1ea717: historical records are never rewritten. This file only reads
 *     its input and never changes it.
 *   - §8, and SOP f0bc886b: no live-money effect.
 *
 * What it does NOT decide (the open questions to Jason and Destiny, C1, 11 Nov):
 *   - where Satisfied / Not Satisfied / Not Verified and TECH_ONLY / LOOP_ACCEPTED / COMMERCIAL_OK
 *     go under v0. They are not values or fields of this contract, and they are refused here by a
 *     name of their own, never translated. acceptanceEvidence.ts still reads them exactly as before;
 *   - whether actor_id is approver_id, whether gate_ref is the gate_id "equivalent", or how evidence
 *     is carried. The v1 fields are refused as not mapped, never renamed;
 *   - who is "explicitly authorized for this gate", the delegation record's format, and what counts
 *     as runtime proof. None is defined, so acceptance_pass: true is ALWAYS refused here, naming
 *     what is missing.
 *
 * Every rule is in RULES_V0 with its source and a status: `sop` (stated in an SOP), `provisional`
 * (this module's own reading, fail closed, never a business rule), or `guard` (a safety rule of this
 * module). Every issue names its rule, so a refusal resting on a provisional rule says so.
 */
import {
  ACCEPTANCE_STATES,
  CG_ID,
  EV_ID,
  LEGACY_FIELDS,
  LOOP_ID,
  SLACK_BOT_ID_SHAPE,
  SLACK_USER,
  TECHNICAL_STATUSES,
} from './acceptanceEvidence';

export const CONTRACT_V0 = 'bha.acceptance_state.v0';
export const CONTRACT_SOP = '2b794599-7862-4da7-b2bc-45d33f79aa52';
export const CONTRACT_SOURCE = 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794316291026599';
/** This module is a temporary alignment of the contract's wording, not the canonical validator. */
export const MODULE_STATUS = 'temporary_contract_alignment' as const;

// ---------------------------------------------------------------- rule authority

/**
 * sop          stated in an SOP, quoted or cited by section;
 * provisional  this module's own reading where the SOP is silent; fail closed, awaiting Jason or Destiny;
 * guard        a safety rule of this module (refuse rather than guess), not a contract rule.
 */
export type RuleStatusV0 = 'sop' | 'provisional' | 'guard';

export interface RuleV0 {
  readonly id: string;
  readonly rule: string;
  readonly status: RuleStatusV0;
  readonly source: string;
}

const rule = (id: string, status: RuleStatusV0, text: string, source: string): RuleV0 => Object.freeze({ id, rule: text, status, source });

export const RULES_V0 = Object.freeze({
  v0_fields: rule('v0_fields', 'sop', 'A record exposes gate_id, loop_id, runtime_verification_status, acceptance_pass and actor_id; delegation_ref when acting under a delegation.', 'SOP 2b794599 §2'),
  loop_id_shape: rule('loop_id_shape', 'sop', 'loop_id is required and is LOOP-<ms>-<4>.', 'SOP 2b794599 §2; SOP cd1ea717 (new gate events carry loop_id); shape as evidence.ts and chargeGate.ts'),
  gate_id_required: rule('gate_id_required', 'sop', 'gate_id (or equivalent) is required.', 'SOP 2b794599 §2'),
  gate_id_format: rule('gate_id_format', 'provisional', 'Only a charge-gate id (CG-<ms>-<4>) is recognised; any other gate id is refused until a gate id format is agreed.', 'C1 reading: the SOP does not define "or equivalent", and no shared gate registry exists. Awaiting Jason (what is a gate) and Destiny (format).'),
  status_vocabulary: rule('status_vocabulary', 'sop', 'runtime_verification_status is exactly unresolved, contract_pass, implementation_pass or runtime_proof, compared exactly.', 'SOP 2b794599 §3 ("No other values are allowed"); SOP a0d187f9'),
  acceptance_pass_boolean: rule('acceptance_pass_boolean', 'sop', 'acceptance_pass is a boolean, true or false.', 'SOP 2b794599 §2'),
  acceptance_pass_requires_runtime_proof: rule('acceptance_pass_requires_runtime_proof', 'sop', 'acceptance_pass = true is only valid when runtime_verification_status = runtime_proof.', 'SOP 2b794599 §4; SOP a0d187f9'),
  acceptance_pass_conditions: rule('acceptance_pass_conditions', 'sop', 'acceptance_pass = true also needs contract evidence, implementation evidence and a valid direct authorization or delegation_ref; "the validator must reject acceptance_pass = true" without them. None can be verified by a pure check, so true is always refused here.', 'SOP 2b794599 §4 and §6'),
  actor_required: rule('actor_required', 'sop', 'actor_id is required: who decided.', 'SOP 2b794599 §2 and §6'),
  actor_shape: rule('actor_shape', 'provisional', 'actor_id has the shape of a Slack user id (U… or W…).', 'C1 reading: the SOP names actor_id but no format. Engine decisions are recorded by Slack id elsewhere (chargeGate decided_by). Awaiting Destiny.'),
  actor_not_bot_id: rule('actor_not_bot_id', 'provisional', 'actor_id with a Slack bot id shape (B…) is refused. An id-shape check only; it proves nothing about a person.', 'C1 reading, as acceptanceEvidence.ts approver_not_bot_id'),
  delegation_ref_shape: rule('delegation_ref_shape', 'provisional', 'delegation_ref, when present, is an evidence-store id (EV-<ms>-<4>).', 'C1 reading of SOP 2b794599 §6 ("points to a delegation record in the evidence store"). The delegation record format is not defined. Awaiting Destiny.'),
  delegation_unverified: rule('delegation_unverified', 'sop', 'A delegation must name delegator, delegate, scope and effective dates; a pure check cannot read it, so a delegation_ref never satisfies authorization here.', 'SOP 2b794599 §6'),
  v1_not_mapped: rule('v1_not_mapped', 'guard', 'Fields and values of the PR #23 validator (bha.acceptance_evidence.v1) are refused under v0, never renamed or translated. acceptanceEvidence.ts still reads them unchanged.', 'C1 condition: preserve legacy fields and classifications until their meaning is verified'),
  legacy_not_mapped: rule('legacy_not_mapped', 'guard', 'owner_id, approval_status and evidence_reference (the earlier telemetry contract) are refused, never translated.', 'As acceptanceEvidence.ts legacy_not_mapped'),
  known_fields_only: rule('known_fields_only', 'guard', 'A field outside the v0 record is refused, not ignored.', 'Fail closed'),
  historical_not_rewritten: rule('historical_not_rewritten', 'sop', 'Historical acceptance records are never edited in place; this check never changes its input.', 'SOP 2b794599 §5 and §7; SOP cd1ea717'),
  no_live_money: rule('no_live_money', 'sop', 'Nothing here opens live charging or changes a live-money gate.', 'SOP 2b794599 §8; SOP f0bc886b'),
  never_authorizes: rule('never_authorizes', 'guard', 'No result authorizes, persists or allows acceptance_pass; requireV0AcceptanceEligible always throws.', 'C1 condition: pure, uncalled, non-authorizing'),
});

export type RuleIdV0 = keyof typeof RULES_V0;

// ---------------------------------------------------------------- vocabulary and fields

/** SOP 2b794599 §3, in the SOP's order. */
export const RUNTIME_VERIFICATION_STATUS_V0 = Object.freeze(['unresolved', 'contract_pass', 'implementation_pass', 'runtime_proof'] as const);
export type RuntimeVerificationStatusV0 = (typeof RUNTIME_VERIFICATION_STATUS_V0)[number];

export const V0_REQUIRED = Object.freeze(['gate_id', 'loop_id', 'runtime_verification_status', 'acceptance_pass', 'actor_id'] as const);
export const V0_OPTIONAL = Object.freeze(['delegation_ref'] as const);

/**
 * The PR #23 validator's own fields, and the open question each one waits on. Refused under v0 with
 * `v1_field_not_mapped`. Listing a field here is not a mapping: it says only that it is not one yet.
 */
export const V1_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  closure_state: 'closure_state (TECH_ONLY / LOOP_ACCEPTED / COMMERCIAL_OK) is not a field of v0. How it relates to acceptance_pass awaits Jason.',
  approver_id: 'approver_id is not a field of v0. Whether it is actor_id awaits Jason; it is never copied into actor_id.',
  evidence_ref: 'evidence_ref is not a field of v0. How contract and implementation evidence are carried awaits Jason.',
  gate_ref: 'gate_ref is not a field of v0. Whether it is the gate_id "equivalent" awaits Jason; send gate_id.',
  decision_link: 'decision_link was a proposed field of the PR #23 design and is not a field of v0.',
  run_ref: 'run_ref was a field of the PR #23 design and is not a field of v0.',
  proof_type: 'proof_type is not a field of v0. Whether a test_forced event can be runtime proof awaits Jason.',
  supersedes: 'supersedes is not a field of v0. The field naming the prior event (SOP §5) is not yet named; awaiting Destiny.',
  notes: 'notes was a field of the PR #23 design and is not a field of v0.',
  test: 'test was a field of the PR #23 design and is not a field of v0.',
});

/** Values of the PR #23 vocabularies, recognised only so a refusal can name them. Never accepted. */
const V1_VALUES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(TECHNICAL_STATUSES.map((v) => [v, 'technical status (SOP f7720fc0)'])),
  ...Object.fromEntries(ACCEPTANCE_STATES.map((v) => [v, 'Engine acceptance state (SOP f7720fc0)'])),
});

/** What a trusted writer would have to establish against the source of truth. None is checked here. */
export const UNVERIFIED_REFERENCES_V0 = Object.freeze([
  'loop_id exists in engine_loops',
  'gate_id names a gate that is held, and what counts as a gate is defined',
  'actor_id belongs to a person and posted the decision',
  'actor_id is explicitly authorized for this gate (no per-gate authorization register exists yet)',
  'delegation_ref names an evidence-store delegation record with delegator, delegate, scope and effective dates, valid at the time of the event',
  'contract evidence (schema and field-level checks) is recorded',
  'implementation evidence (tests and deployment) is recorded',
  'for runtime_proof: real events passed through this gate and are recorded in the evidence store',
  'for an escalation: the prior event is held and is the newest for this gate and loop',
] as const);

// ---------------------------------------------------------------- results

export type IssueCodeV0 =
  | 'not_an_object'
  | 'missing'
  | 'bad_loop_id'
  | 'bad_gate_id'
  | 'gate_id_format_undefined'
  | 'bad_status'
  | 'unknown_status_value'
  | 'v1_status_value'
  | 'bad_acceptance_pass'
  | 'acceptance_pass_requires_runtime_proof'
  | 'acceptance_pass_not_verifiable_here'
  | 'bad_actor_id'
  | 'actor_bot_id_shape'
  | 'bad_delegation_ref'
  | 'v1_field_not_mapped'
  | 'legacy_field_not_mapped'
  | 'unknown_field';

export interface IssueV0 {
  field: string;
  code: IssueCodeV0;
  message: string;
  rule: RuleIdV0;
  rule_status: RuleStatusV0;
}

export interface NormalisedV0 {
  gate_id: string;
  loop_id: string;
  runtime_verification_status: RuntimeVerificationStatusV0;
  acceptance_pass: boolean;
  actor_id: string;
  delegation_ref: string | null;
}

export interface CheckV0Result {
  contract: typeof CONTRACT_V0;
  contract_sop: typeof CONTRACT_SOP;
  module_status: typeof MODULE_STATUS;
  /** Every field has a valid shape. NOT an approval, NOT existence, NOT authorization. */
  structurally_valid: boolean;
  issues: IssueV0[];
  /** The status exactly as sent when it is one of the four, else null. Never derived. */
  runtime_verification_status: RuntimeVerificationStatusV0 | null;
  /** What the caller asked for, when it was a boolean; else null. */
  acceptance_pass_requested: boolean | null;
  acceptance_pass_allowed: false;
  /** Why acceptance_pass cannot be true here. Empty only when true was not asked for. */
  acceptance_pass_blocked_by: string[];
  can_charge_live: false;
  eligible_for_persistence: false;
  authorizes: false;
  references_verified: false;
  unverified_references: string[];
  /** The provisional rules this result relied on, so a pass on one is never read as an agreed rule. */
  provisional_rules_applied: string[];
  /** Every reason this record cannot be persisted or relied on. Never empty. */
  blocked_by: string[];
  normalised: NormalisedV0 | null;
}

export class AcceptanceStateV0Error extends Error {
  constructor(public reason: string, message: string, public result: CheckV0Result) {
    super(message);
  }
}

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const absent = (o: Rec, k: string): boolean => !has(o, k) || o[k] === null || o[k] === undefined || o[k] === '';

class Issues {
  readonly list: IssueV0[] = [];
  readonly provisional = new Set<string>();
  add(field: string, code: IssueCodeV0, id: RuleIdV0, message: string): void {
    const r = RULES_V0[id];
    if (r.status === 'provisional') this.provisional.add(id);
    this.list.push({ field, code, message: r.status === 'provisional' ? `${message} (provisional rule, awaiting decision)` : message, rule: id, rule_status: r.status });
  }
  rely(id: RuleIdV0): void {
    if (RULES_V0[id].status === 'provisional') this.provisional.add(id);
  }
}

// ---------------------------------------------------------------- the §4 condition, as a pure statement

/** Facts a future trusted writer would establish itself. Each counts only when it is exactly `true`. */
export interface AcceptancePassFacts {
  contract_evidence_verified?: unknown;
  implementation_evidence_verified?: unknown;
  authorization_verified?: unknown;
}

export interface AcceptancePassDecision {
  /** Whether the SOP's conditions, as stated, would be met by these facts. A statement, not a permission. */
  meets_sop_conditions: boolean;
  /** Each condition not met, in the SOP's order. */
  unmet: string[];
  /** Never true. This function authorizes nothing; caller-supplied facts are not verification. */
  authorizes: false;
}

/**
 * SOP 2b794599 §4 and §6 as one pure statement: acceptance_pass may be true only when the status is
 * runtime_proof AND contract evidence AND implementation evidence AND authorization (direct or by a
 * valid delegation) are each verified. Anything other than the boolean `true` counts as not verified.
 *
 * This is NOT an authorization mechanism. Its inputs are claims; it does not check them, and its
 * answer `authorizes: false` always. A trusted writer would have to establish each fact itself
 * against the database and Slack. checkV0 never supplies any fact, so it always refuses true.
 */
export function acceptancePassDecision(status: unknown, facts: AcceptancePassFacts = {}): AcceptancePassDecision {
  const unmet: string[] = [];
  if (status !== 'runtime_proof') unmet.push('runtime_proof_required');
  if (facts.contract_evidence_verified !== true) unmet.push('contract_evidence_not_verified');
  if (facts.implementation_evidence_verified !== true) unmet.push('implementation_evidence_not_verified');
  if (facts.authorization_verified !== true) unmet.push('authorization_not_verified');
  return { meets_sop_conditions: unmet.length === 0, unmet, authorizes: false };
}

// ---------------------------------------------------------------- the check

/** Why acceptance_pass cannot be true in this module, whatever the record says. */
const UNDEFINED_IN_CONTRACT = Object.freeze([
  'evidence_fields_undefined',
  'gate_authority_undefined',
  'no_trusted_writer',
]);

const STANDING_BLOCKS = Object.freeze([
  'temporary_module_not_canonical',
  'contract_questions_open',
  'references_not_verified',
  'no_trusted_writer',
]);

function readStatus(o: Rec, issues: Issues): RuntimeVerificationStatusV0 | null {
  const field = 'runtime_verification_status';
  if (absent(o, field)) {
    issues.add(field, 'missing', 'status_vocabulary', 'runtime_verification_status is required.');
    return null;
  }
  const v = o[field];
  if (typeof v !== 'string' || v.trim() === '' || v.length > 120) {
    issues.add(field, 'bad_status', 'status_vocabulary', 'runtime_verification_status is text.');
    return null;
  }
  if ((RUNTIME_VERIFICATION_STATUS_V0 as readonly string[]).includes(v)) return v as RuntimeVerificationStatusV0;
  if (has(V1_VALUES, v)) {
    issues.add(field, 'v1_status_value', 'v1_not_mapped', `"${v}" is the PR #23 validator's ${V1_VALUES[v]}, not a v0 runtime_verification_status. Where it belongs under v0 awaits Jason; it is never translated.`);
    return null;
  }
  issues.add(field, 'unknown_status_value', 'status_vocabulary', `runtime_verification_status is exactly one of ${RUNTIME_VERIFICATION_STATUS_V0.join(', ')}; compared exactly, never trimmed or re-cased.`);
  return null;
}

function result(issues: Issues, rest: { status: RuntimeVerificationStatusV0 | null; requested: boolean | null; delegation: boolean; normalised: NormalisedV0 | null }): CheckV0Result {
  let passBlocked: string[] = [];
  if (rest.requested === true) {
    // checkV0 supplies no facts, so every evidence and authority condition is unmet.
    passBlocked = [...acceptancePassDecision(rest.status).unmet, ...UNDEFINED_IN_CONTRACT];
    if (rest.delegation) passBlocked.push('delegation_record_unverified');
  }
  return {
    contract: CONTRACT_V0,
    contract_sop: CONTRACT_SOP,
    module_status: MODULE_STATUS,
    structurally_valid: issues.list.length === 0,
    issues: issues.list,
    runtime_verification_status: rest.status,
    acceptance_pass_requested: rest.requested,
    acceptance_pass_allowed: false,
    acceptance_pass_blocked_by: passBlocked,
    can_charge_live: false,
    eligible_for_persistence: false,
    authorizes: false,
    references_verified: false,
    // Fresh arrays every call: one caller changing its result cannot change another's.
    unverified_references: [...UNVERIFIED_REFERENCES_V0],
    provisional_rules_applied: [...issues.provisional].sort(),
    blocked_by: [...(issues.list.length ? ['structural_issues'] : []), ...(rest.requested === true ? ['acceptance_pass_not_allowed'] : []), ...STANDING_BLOCKS],
    normalised: rest.normalised,
  };
}

/**
 * Checks the shape of one record against Acceptance-State Contract v0. Pure: it reads its input and
 * never changes it. Never throws on bad input; every problem is an issue. The result never authorizes.
 */
export function checkV0(input: unknown): CheckV0Result {
  const issues = new Issues();
  if (!isObject(input)) {
    issues.add('(record)', 'not_an_object', 'known_fields_only', 'The record is a JSON object.');
    return result(issues, { status: null, requested: null, delegation: false, normalised: null });
  }
  const o = input;

  // Names from earlier contracts first, so a caller learns they are not mapped.
  for (const k of Object.keys(LEGACY_FIELDS)) {
    if (has(o, k)) issues.add(k, 'legacy_field_not_mapped', 'legacy_not_mapped', LEGACY_FIELDS[k]);
  }
  for (const k of Object.keys(V1_FIELDS)) {
    if (has(o, k)) issues.add(k, 'v1_field_not_mapped', 'v1_not_mapped', V1_FIELDS[k]);
  }
  const known = new Set<string>([...V0_REQUIRED, ...V0_OPTIONAL, ...Object.keys(LEGACY_FIELDS), ...Object.keys(V1_FIELDS)]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) issues.add(k, 'unknown_field', 'known_fields_only', `${k} is not a field of ${CONTRACT_V0}.`);
  }

  // gate_id
  issues.rely('gate_id_format');
  let gate_id: string | null = null;
  if (absent(o, 'gate_id')) issues.add('gate_id', 'missing', 'gate_id_required', 'gate_id is required.');
  else if (typeof o.gate_id !== 'string' || o.gate_id.trim() === '' || o.gate_id.length > 200) issues.add('gate_id', 'bad_gate_id', 'gate_id_required', 'gate_id is text.');
  else if (!CG_ID.test(o.gate_id)) issues.add('gate_id', 'gate_id_format_undefined', 'gate_id_format', `Only a charge-gate id (CG-<ms>-<4>) is recognised; no format is agreed for "${o.gate_id.slice(0, 60)}".`);
  else gate_id = o.gate_id;

  // loop_id
  let loop_id: string | null = null;
  if (absent(o, 'loop_id')) issues.add('loop_id', 'missing', 'loop_id_shape', 'loop_id is required.');
  else if (typeof o.loop_id !== 'string' || !LOOP_ID.test(o.loop_id)) issues.add('loop_id', 'bad_loop_id', 'loop_id_shape', 'loop_id is LOOP-<ms>-<4>, e.g. LOOP-1794326998165-6I62.');
  else loop_id = o.loop_id;

  const status = readStatus(o, issues);

  // acceptance_pass: a real boolean.
  let requested: boolean | null = null;
  if (!has(o, 'acceptance_pass') || o.acceptance_pass === null || o.acceptance_pass === undefined) issues.add('acceptance_pass', 'missing', 'acceptance_pass_boolean', 'acceptance_pass is required: true or false.');
  else if (typeof o.acceptance_pass !== 'boolean') issues.add('acceptance_pass', 'bad_acceptance_pass', 'acceptance_pass_boolean', 'acceptance_pass is the boolean true or false, never a string or a number.');
  else requested = o.acceptance_pass;

  if (requested === true) {
    if (status !== null && status !== 'runtime_proof') {
      issues.add('acceptance_pass', 'acceptance_pass_requires_runtime_proof', 'acceptance_pass_requires_runtime_proof', `acceptance_pass = true is only valid with runtime_verification_status = runtime_proof, not ${status}.`);
    } else if (status === 'runtime_proof') {
      issues.add('acceptance_pass', 'acceptance_pass_not_verifiable_here', 'acceptance_pass_conditions', 'acceptance_pass = true needs contract evidence, implementation evidence and a valid authorization or delegation. None can be verified by this check, and the evidence fields and per-gate authority are not yet defined, so it is refused.');
    }
  }

  // actor_id
  issues.rely('actor_shape');
  issues.rely('actor_not_bot_id');
  let actor_id: string | null = null;
  if (absent(o, 'actor_id')) issues.add('actor_id', 'missing', 'actor_required', 'actor_id is required: who decided.');
  else if (typeof o.actor_id === 'string' && SLACK_BOT_ID_SHAPE.test(o.actor_id)) issues.add('actor_id', 'actor_bot_id_shape', 'actor_not_bot_id', 'actor_id has the shape of a Slack bot id (B…). An id-shape check only.');
  else if (typeof o.actor_id !== 'string' || !SLACK_USER.test(o.actor_id)) issues.add('actor_id', 'bad_actor_id', 'actor_shape', 'actor_id is a Slack user id, U… or W….');
  else actor_id = o.actor_id;

  // delegation_ref: optional; when present, shape only, and never enough on its own.
  let delegation_ref: string | null = null;
  const delegation = has(o, 'delegation_ref') && o.delegation_ref !== null && o.delegation_ref !== undefined;
  if (delegation) {
    issues.rely('delegation_ref_shape');
    if (typeof o.delegation_ref !== 'string' || !EV_ID.test(o.delegation_ref)) issues.add('delegation_ref', 'bad_delegation_ref', 'delegation_ref_shape', 'delegation_ref is an evidence-store id, EV-<ms>-<4>.');
    else delegation_ref = o.delegation_ref;
  }

  const normalised: NormalisedV0 | null =
    issues.list.length === 0 && gate_id && loop_id && status && requested !== null && actor_id
      ? { gate_id, loop_id, runtime_verification_status: status, acceptance_pass: requested, actor_id, delegation_ref }
      : null;

  return result(issues, { status, requested, delegation, normalised });
}

/** "May this count as an accepted record?" Always no in this module. Throws, naming every reason. */
export function requireV0AcceptanceEligible(input: unknown): never {
  const r = checkV0(input);
  throw new AcceptanceStateV0Error('not_acceptance_eligible', `Not acceptance-eligible under ${CONTRACT_V0}: ${r.blocked_by.join(', ')}. A well-formed record is not an accepted one.`, r);
}
