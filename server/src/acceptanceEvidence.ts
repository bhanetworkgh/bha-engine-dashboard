/**
 * The five-field acceptance-evidence record: structural check only (LOCAL PROTOTYPE, U0MN step 3,
 * 9 Nov 2026). Jason's request, DW-1794066855896-U0MN: loop_id, evidence_ref,
 * runtime_verification_status, approver_id, closure_state. Design:
 * U0MN_Task2_Five_Field_Evidence_Schema_Nov09.md (proposed, not approved).
 *
 * What this file is:
 *   - a PURE function. It reads no database, calls no network, writes nothing, and imports
 *     nothing but the pure proof_type rule;
 *   - a check of SHAPE. A well-formed EV-…, LOOP-… or Slack link says nothing about whether
 *     that record exists, who posted the message, or whether a run happened.
 *
 * The vocabularies (Jason, 9 Nov 2026, C0AF7AGC2UV p1794228033482159; SOPs f7720fc0 and a0b57dbe):
 *   - technical status: exactly `Satisfied`, `Not Satisfied`, `Not Verified`, compared exactly;
 *   - Engine acceptance state: exactly `TECH_ONLY`, `LOOP_ACCEPTED`, `COMMERCIAL_OK`;
 *   - authority: technical status by the implementing builder; LOOP_ACCEPTED by the loop owner;
 *     COMMERCIAL_OK only by Jason or an explicitly delegated commercial approver.
 *   Jason's message names the two vocabularies, not the fields. Carrying technical status in
 *   runtime_verification_status and the acceptance state in closure_state is read from his headings
 *   ("Status vocabulary", "Closure / approval vocabulary") and is PROVISIONAL until he confirms it.
 *
 * What it is not:
 *   - an approval of the whole contract. The contract is `proposed_pending_approval`: the field
 *     mapping and several design rules below still await Jason;
 *   - a judge of combinations Jason has not defined. Only `Satisfied` with `TECH_ONLY` follows from
 *     his wording; every other pairing is reported as not defined or not stated, and blocks;
 *   - a charge gate. No value here sets or implies can_charge_live; chargeGate.status() owns that;
 *   - a writer. Every result says `eligible_for_persistence: false` and `acceptance_eligible:
 *     false`, typed as the literal false, and `requireAcceptanceEligible` always throws.
 *
 * Every rule below is in RULES with its authority and status, and every issue names the rule it
 * came from, so a refusal resting on a proposed rule says so. `approved` means an existing rule
 * this code reuses; it never means Jason approved this contract.
 *
 * Rules held here that are NOT renamings (the earlier Honest Gate telemetry contract):
 *   - owner_id is not approver_id; approval_status is not closure_state; evidence_reference is not
 *     evidence_ref. Those legacy names are refused with `legacy_field_not_mapped`, never translated.
 *   - Nothing is inferred: no closure_state from a runtime status or a charge-gate pass, and no
 *     approver from an owner.
 */
import { parseProofType, ProofTypeError, type ProofType } from './proofType';

export const CONTRACT = 'bha.acceptance_evidence.v1';
/** The contract itself is a proposal. Nothing in this file may change that. */
export const CONTRACT_STATUS = 'proposed_pending_approval' as const;

// ---------------------------------------------------------------- rule authority

/**
 * approved            an existing rule, held elsewhere in this repo or set by its owner, reused here;
 * proposed            this design's own rule, awaiting Jason (or Destiny for schema matters);
 * unapproved_vocabulary  a value list nobody has approved; nothing is accepted against it;
 * prototype_guard     a safety rule of this local prototype (fail closed), not a contract rule.
 */
export type RuleStatus = 'approved' | 'proposed' | 'unapproved_vocabulary' | 'prototype_guard';

export interface Rule {
  readonly id: string;
  readonly rule: string;
  readonly status: RuleStatus;
  readonly authority: string;
}

const rule = (id: string, status: RuleStatus, ruleText: string, authority: string): Rule => Object.freeze({ id, rule: ruleText, status, authority });

/** Keys are literal, so the compiler refuses an issue that names a rule not in this table. */
export const RULES = Object.freeze({
  five_fields: rule('five_fields', 'approved', "The record carries Jason's five fields: loop_id, evidence_ref, runtime_verification_status, approver_id, closure_state.", 'Jason Bays, as recorded on DW-1794066855896-U0MN (7 Nov 2026). The request; the contract built on it is proposed.'),
  loop_id_shape: rule('loop_id_shape', 'approved', 'loop_id is LOOP-<ms>-<4>.', 'Existing code: evidence.ts and chargeGate.ts check the same pattern.'),
  ev_shape: rule('ev_shape', 'approved', 'An evidence-store id is EV-<ms>-<4>.', 'Existing code: evidence.EV_ID (migration 103, Destiny, 28 Oct 2026).'),
  evidence_ref_ev_only: rule('evidence_ref_ev_only', 'proposed', 'evidence_ref must be an evidence-store id; Drive, Slack and n8n are referenced through a saved EV record.', 'Design recommendation 8. Supported by KJYC (Jason, 6 Nov) and D3 (Destiny, 28 Oct); Jason has not stated it for this field.'),
  approver_required: rule('approver_required', 'proposed', 'approver_id is required on every record.', 'Design. Jason (9 Nov) says who sets each state; he does not say whether a record may omit approver_id.'),
  approver_shape: rule('approver_shape', 'approved', 'approver_id is a Slack user id (U… or W…).', 'Existing code: evidence.ts checks the same pattern for author and requester.'),
  approver_not_bot_id: rule('approver_not_bot_id', 'proposed', 'An approver_id shaped like a Slack bot id (B…) is refused. This is an id-shape check, not proof the id belongs to a person.', 'Design, following the MPMD approver rule (EV-1793600858856-PT9J, itself a proposal): a named person, never a machine.'),
  decision_link_required: rule('decision_link_required', 'proposed', 'Every record names the Slack message it rests on (decision_link). Not one of Jason\'s five fields.', 'Design §12.3 (identity and idempotency).'),
  slack_link_shape: rule('slack_link_shape', 'approved', 'A decision link is a Slack message permalink: https://<workspace>.slack.com/archives/<C|D|G…>/p<16 digits>.', 'Existing code: chargeGate.parseLink.'),
  run_ref_n8n_only: rule('run_ref_n8n_only', 'proposed', 'run_ref.system is "n8n"; no other run system has an agreed identity yet.', 'Design §4 (Hardik Bhatt, 9 Nov). Genie run-ledger and Stripe run identities are U0MN part 3, not yet proposed.'),
  run_ref_epoch: rule('run_ref_epoch', 'approved', 'An n8n run is identified by (id_epoch, execution_id); execution ids repeat across epochs.', 'Migration 108 (Destiny, 1 Nov 2026).'),
  run_ref_workflow_required: rule('run_ref_workflow_required', 'proposed', 'run_ref.workflow_id is required, to catch a mistyped execution id (7653 vs 72653).', 'Design §12.3.'),
  proof_type: rule('proof_type', 'approved', 'proof_type is test_forced or live_natural; left out is not stated, never live.', 'Jason, 7 Nov 2026 (proofType.ts).'),
  gate_ref_shape: rule('gate_ref_shape', 'approved', 'A charge-gate id is CG-<ms>-<4>.', 'Existing code: chargeGate.ts.'),
  supersedes_shape: rule('supersedes_shape', 'proposed', 'A correction names the record it replaces as AE-<ms>-<4>.', 'Design: the AE id format is new.'),
  status_text_shape: rule('status_text_shape', 'prototype_guard', 'A status is a non-empty string of at most 120 characters with no control characters and no leading or trailing whitespace; it is compared exactly against the vocabulary, never trimmed or re-cased.', 'Design §4 (Hardik Bhatt, 9 Nov): fail closed on a malformed value.'),
  runtime_verification_status_vocabulary: rule('runtime_verification_status_vocabulary', 'approved', 'Technical status is exactly Satisfied, Not Satisfied or Not Verified: technical acceptance only, saying nothing about commercial readiness, loop closure or client-facing promises.', 'Jason Bays, 9 Nov 2026, https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159 ("Status vocabulary"); SOP f7720fc0-79da-48b6-893b-7ff0a162922d.'),
  closure_state_vocabulary: rule('closure_state_vocabulary', 'approved', 'Engine acceptance state is exactly TECH_ONLY, LOOP_ACCEPTED or COMMERCIAL_OK, a separate field distinct from the technical fields.', 'Jason Bays, 9 Nov 2026, https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159 ("Closure / approval vocabulary"); SOP f7720fc0-79da-48b6-893b-7ff0a162922d.'),
  field_mapping_provisional: rule('field_mapping_provisional', 'proposed', 'Technical status is carried in runtime_verification_status and Engine acceptance state in closure_state.', "Read from the headings of Jason's 9 Nov message; he named the vocabularies, not the fields. Awaiting his confirmation."),
  technical_status_authority: rule('technical_status_authority', 'approved', 'Technical status is set by the implementing builder and verified via tests + artifacts.', 'Jason Bays, 9 Nov 2026 (same message, "Authority"). Verifying the evidence is a later writer step, not this pure check.'),
  tech_only_default: rule('tech_only_default', 'approved', 'TECH_ONLY is the default once tests/evidence are in.', 'Jason Bays, 9 Nov 2026 (same message). This check never fills in a default: closure_state is still required as sent.'),
  loop_accepted_authority: rule('loop_accepted_authority', 'approved', 'LOOP_ACCEPTED is set by the loop owner (e.g. Destiny for Media Twin, Hardik for vFarm Brain, Ahad for CST).', 'Jason Bays, 9 Nov 2026 (same message). Who owns the loop is checked later against the source of truth, not here.'),
  commercial_ok_authority: rule('commercial_ok_authority', 'approved', 'COMMERCIAL_OK is set only by Jason or an explicitly delegated commercial approver.', 'Jason Bays, 9 Nov 2026 (same message).'),
  no_commercial_delegate: rule('no_commercial_delegate', 'prototype_guard', 'No delegated commercial approver is recognised by this prototype; a delegation must be separately verified before anyone but Jason can set COMMERCIAL_OK.', 'U0MN implementation instruction (Hardik Bhatt, 10 Nov): no delegate is presently authorised.'),
  combination_defined_only: rule('combination_defined_only', 'prototype_guard', 'Only Satisfied with TECH_ONLY follows from Jason\'s wording (TECH_ONLY: "tests and evidence satisfied"). Not Satisfied or Not Verified with any state is not defined; Satisfied with LOOP_ACCEPTED or COMMERCIAL_OK is not stated. Neither becomes eligible.', 'U0MN implementation instruction (Hardik Bhatt, 10 Nov): undefined combinations must not become eligible. Awaiting Jason.'),
  no_live_charging: rule('no_live_charging', 'approved', 'No technical status or acceptance state sets or implies can_charge_live; only the charge gate decides it.', "chargeGate.ts RULES (Jason, 22 Oct 2026); Jason's 9 Nov message: COMMERCIAL_OK is about client-visible proofs and sales surfaces."),
  legacy_not_mapped: rule('legacy_not_mapped', 'prototype_guard', 'owner_id, approval_status and evidence_reference are refused, never translated into the new fields.', 'U0MN task instruction (Hardik Bhatt, 9 Nov); folding them is approval 4 (Jason).'),
  derived_not_supplied: rule('derived_not_supplied', 'prototype_guard', 'Fields the writer derives are never accepted from a caller.', 'Design §4 (Hardik Bhatt, 9 Nov): owner_id_snapshot and the decision parts are read from the source of truth.'),
  known_fields_only: rule('known_fields_only', 'prototype_guard', 'A field outside the record is refused, not ignored.', 'Design §4 (Hardik Bhatt, 9 Nov): fail closed on anything not in the record.'),
  never_eligible: rule('never_eligible', 'prototype_guard', 'No record is eligible to persist or to count as accepted.', 'U0MN step 3 instruction (Hardik Bhatt, 9 Nov): fail closed until Jason and Destiny approve.'),
});

export type RuleId = keyof typeof RULES;

export const JASON_DECISION_LINK = 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159';

/** An approved value list, where it came from, and the field it is provisionally carried in. */
export interface ApprovedVocabulary {
  readonly approved: true;
  readonly values: readonly string[];
  readonly name: string;
  readonly source: string;
  readonly sop: string;
  readonly rule: RuleId;
  readonly field: 'runtime_verification_status' | 'closure_state';
  readonly field_mapping: 'provisional';
}

export const TECHNICAL_STATUSES = Object.freeze(['Satisfied', 'Not Satisfied', 'Not Verified'] as const);
export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];
export const ACCEPTANCE_STATES = Object.freeze(['TECH_ONLY', 'LOOP_ACCEPTED', 'COMMERCIAL_OK'] as const);
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];

export const RUNTIME_VERIFICATION_STATUS_VOCABULARY: ApprovedVocabulary = Object.freeze({
  approved: true,
  values: TECHNICAL_STATUSES,
  name: 'technical status',
  source: JASON_DECISION_LINK,
  sop: 'f7720fc0-79da-48b6-893b-7ff0a162922d',
  rule: 'runtime_verification_status_vocabulary',
  field: 'runtime_verification_status',
  field_mapping: 'provisional',
});

export const CLOSURE_STATE_VOCABULARY: ApprovedVocabulary = Object.freeze({
  approved: true,
  values: ACCEPTANCE_STATES,
  name: 'Engine acceptance state',
  source: JASON_DECISION_LINK,
  sop: 'f7720fc0-79da-48b6-893b-7ff0a162922d',
  rule: 'closure_state_vocabulary',
  field: 'closure_state',
  field_mapping: 'provisional',
});

/** The only person who may set COMMERCIAL_OK today (Jason Bays). */
export const COMMERCIAL_APPROVER = 'U0A9V97949F';
/** Delegated commercial approvers this prototype recognises: none. A delegation must be separately verified. */
export const DELEGATED_COMMERCIAL_APPROVERS: readonly string[] = Object.freeze([]);

export type Combination =
  | 'defined'
  | 'not_defined'
  | 'not_stated'
  | 'incomplete';

// ---------------------------------------------------------------- identifier shapes
// Shape only: none of these says the thing exists. They are copied rather than imported because
// evidence.ts and chargeGate.ts load pg and slack, and this file must load neither.

/** Same pattern as evidence.ts (save) and chargeGate.ts (check). */
export const LOOP_ID = /^LOOP-\d{10,}-[A-Z0-9]{4}$/;
/** Same pattern as evidence.EV_ID. */
export const EV_ID = /^EV-\d{10,}-[A-Z0-9]{4}$/;
/** chargeGate's CG-<ms>-<4>, as its newId mints it. */
export const CG_ID = /^CG-\d{10,}-[A-Z0-9]{4}$/;
/** Proposed: the acceptance-evidence record's own id. */
export const AE_ID = /^AE-\d{10,}-[A-Z0-9]{4}$/;
/** Same pattern as evidence.ts uses for author_id and requester_user_id. */
export const SLACK_USER = /^[UW][A-Z0-9]{6,}$/;
/** The shape of a Slack bot id. Matching it says the id looks like a bot's, nothing more. */
export const SLACK_BOT_ID_SHAPE = /^B[A-Z0-9]{6,}$/;
/** An n8n workflow id as n8n issues them (e.g. 3Pzm0DlJZSNu6DU4). Checked against current ids only. */
export const N8N_WORKFLOW_ID = /^[A-Za-z0-9]{8,64}$/;
/** id_epoch is a smallint in engine_execution_runs (migration 108). */
export const MAX_EPOCH = 32767;
export const STATUS_MAX = 120;

/** Jason's five fields, as requested on U0MN. */
export const JASON_FIELDS = Object.freeze(['loop_id', 'evidence_ref', 'runtime_verification_status', 'approver_id', 'closure_state'] as const);
/** Required by this design, not by Jason's request (rule decision_link_required). */
export const PROPOSED_REQUIRED = Object.freeze(['decision_link'] as const);
export const REQUIRED = Object.freeze([...JASON_FIELDS, ...PROPOSED_REQUIRED] as const);
export const OPTIONAL = Object.freeze(['run_ref', 'gate_ref', 'proof_type', 'supersedes', 'notes', 'test'] as const);
/** The earlier telemetry contract's names. Refused, never mapped. */
export const LEGACY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  owner_id: 'owner_id is who owns the work, not who approves it; it is not approver_id and is never copied into it.',
  approval_status: 'approval_status is one approval decision, not where the acceptance stands; it is not closure_state and is never translated into it.',
  evidence_reference: 'evidence_reference was free text; evidence_ref is an evidence-store id. Save the evidence and pass its EV id.',
});
/** Filled by the writer from the source of truth, never by a caller. */
export const DERIVED_FIELDS = Object.freeze(['record_id', 'owner_id_snapshot', 'evidence_snapshot', 'recorded_by', 'via', 'decision_channel', 'decision_ts'] as const);
const RUN_REF_KEYS = Object.freeze(['system', 'id_epoch', 'execution_id', 'workflow_id']);

export type IssueCode =
  | 'not_an_object'
  | 'missing'
  | 'bad_loop_id'
  | 'bad_evidence_ref'
  | 'bad_approver_id'
  | 'approver_bot_id_shape'
  | 'bad_decision_link'
  | 'bad_status'
  | 'unknown_status_value'
  | 'commercial_approver_not_authorized'
  | 'bad_run_ref'
  | 'run_epoch_missing'
  | 'bad_run_epoch'
  | 'run_execution_id_missing'
  | 'bad_run_execution_id'
  | 'run_workflow_id_missing'
  | 'bad_run_workflow_id'
  | 'unsupported_run_system'
  | 'bad_gate_ref'
  | 'bad_supersedes'
  | 'bad_proof_type'
  | 'bad_test_flag'
  | 'bad_notes'
  | 'legacy_field_not_mapped'
  | 'derived_field_supplied'
  | 'unknown_field';

export interface Issue {
  field: string;
  code: IssueCode;
  message: string;
  /** The RULES id this refusal rests on, and that rule's status. */
  rule: string;
  rule_status: RuleStatus;
}

export interface SlackLink {
  channel: string;
  ts: string;
  thread_ts: string | null;
}

export interface RunRef {
  system: 'n8n';
  id_epoch: number;
  execution_id: number;
  workflow_id: string;
}

export interface StatusReading {
  /** The value exactly as the caller stated it when it is in the approved vocabulary, else null. Never derived. */
  value: string | null;
  /** True only for a value in Jason's approved vocabulary. The field mapping itself stays provisional. */
  approved: boolean;
  reason: 'approved_value' | 'not_in_vocabulary' | 'missing' | 'malformed';
}

/** What the writer would later have to confirm against the source of truth. None is checked here. */
export const UNVERIFIED_REFERENCES = Object.freeze([
  'loop_id exists in engine_loops',
  'evidence_ref is held in engine_evidence and is not a test record (for a real record)',
  'evidence_ref supports runtime_verification_status (set by the implementing builder, verified via tests + artifacts)',
  'decision_link is a real Slack message posted by approver_id',
  'approver_id belongs to a person (the B… check is an id shape only)',
  'for LOOP_ACCEPTED: approver_id owns the loop or track of loop_id',
  'for COMMERCIAL_OK by anyone but Jason: a separately verified commercial delegation (none is recognised today)',
  'run_ref matches one row of engine_execution_runs (id_epoch, execution_id, workflow_id)',
  'gate_ref is held in engine_charge_gate',
  'supersedes is the newest record for this loop',
] as const);

export interface CheckResult {
  contract: typeof CONTRACT;
  contract_status: typeof CONTRACT_STATUS;
  /** True when every field has a valid shape. It is NOT an approval and NOT existence. */
  structurally_valid: boolean;
  issues: Issue[];
  runtime_verification_status: StatusReading;
  closure_state: StatusReading;
  /** The two vocabularies are approved; which field carries which is not yet confirmed by Jason. */
  field_mapping: 'provisional';
  /** Whether Jason's wording defines this pairing of technical status and acceptance state. */
  combination: Combination;
  /** Never true: nothing in this record opens live charging. chargeGate.status() decides that. */
  can_charge_live: false;
  references_verified: false;
  unverified_references: string[];
  /** The proposed rules this result relied on, so a reader can tell a structural pass from an approved one. */
  proposed_rules_applied: string[];
  eligible_for_persistence: false;
  acceptance_eligible: false;
  /** Every reason this record cannot be persisted or counted, structural or not. Never empty. */
  blocked_by: string[];
  /** The cleaned shape, for display; present only when structurally valid. */
  normalised: NormalisedRecord | null;
}

export interface NormalisedRecord {
  loop_id: string;
  evidence_ref: string;
  runtime_verification_status: string;
  approver_id: string;
  closure_state: string;
  decision_link: string;
  decision: SlackLink;
  run_ref: RunRef | null;
  gate_ref: string | null;
  proof_type: ProofType | null;
  supersedes: string | null;
  notes: string | null;
  test: boolean;
}

export class AcceptanceEvidenceError extends Error {
  constructor(public reason: string, message: string, public result: CheckResult) {
    super(message);
  }
}

/**
 * A Slack message permalink → channel, ts and, for a reply, its thread. Null when it is not one. Pure.
 * Copied from chargeGate.parseLink (not imported: chargeGate loads pg and slack). One deliberate
 * difference: a thread_ts that is present but malformed is refused here, where parseLink ignores it.
 */
export function parseSlackLink(link: unknown): SlackLink | null {
  if (typeof link !== 'string' || link.length > 500) return null;
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/);
  if (!m) return null;
  const thread = u.searchParams.get('thread_ts');
  if (thread !== null && !/^\d{10}\.\d{6}$/.test(thread)) return null;
  return { channel: m[1], ts: `${m[2]}.${m[3]}`, thread_ts: thread };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROPOSED = ' (proposed rule, awaiting approval)';

/** An integer from a number or a string of digits only. Null for anything else (1.5, "7,653", "72653a", -1). */
function wholeNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Collects issues, each tied to its rule; remembers which proposed rules this check relied on. */
class Issues {
  readonly list: Issue[] = [];
  readonly proposed = new Set<string>();
  add(field: string, code: IssueCode, ruleId: RuleId, message: string): void {
    const r: Rule = RULES[ruleId];
    this.list.push({ field, code, message: r.status === 'proposed' ? message + PROPOSED : message, rule: r.id, rule_status: r.status });
  }
  rely(ruleId: RuleId): void {
    if (RULES[ruleId].status === 'proposed') this.proposed.add(ruleId);
  }
}

function readStatus(o: Record<string, unknown>, vocab: ApprovedVocabulary, issues: Issues): StatusReading {
  const field = vocab.field;
  issues.rely('field_mapping_provisional');
  if (!has(o, field) || o[field] === null) {
    issues.add(field, 'missing', 'five_fields', `${field} is required.`);
    return { value: null, approved: false, reason: 'missing' };
  }
  const v = o[field];
  if (typeof v !== 'string' || !v.trim() || v.length > STATUS_MAX || CONTROL.test(v) || v !== v.trim()) {
    issues.add(field, 'bad_status', 'status_text_shape', `${field} is a non-empty string of at most ${STATUS_MAX} characters, with no control characters and no leading or trailing spaces. It is compared exactly and never trimmed.`);
    return { value: null, approved: false, reason: 'malformed' };
  }
  // Exact match only: no trimming, no re-casing, no synonyms.
  if (!vocab.values.includes(v)) {
    issues.add(field, 'unknown_status_value', vocab.rule, `${field} carries the ${vocab.name}, exactly one of: ${vocab.values.join(', ')} (Jason, ${vocab.source}). "${v}" is not one of them.`);
    return { value: null, approved: false, reason: 'not_in_vocabulary' };
  }
  return { value: v, approved: true, reason: 'approved_value' };
}

/** Whether Jason's wording defines this pairing. Pure; never derives one value from the other. */
export function combinationOf(technical: string | null, acceptance: string | null): Combination {
  if (!technical || !acceptance) return 'incomplete';
  if (technical !== 'Satisfied') return 'not_defined';
  return acceptance === 'TECH_ONLY' ? 'defined' : 'not_stated';
}

function readRunRef(v: unknown, issues: Issues): RunRef | null {
  issues.rely('run_ref_n8n_only');
  issues.rely('run_ref_workflow_required');
  if (!isObject(v)) {
    issues.add('run_ref', 'bad_run_ref', 'run_ref_epoch', 'run_ref is an object: {system: "n8n", id_epoch, execution_id, workflow_id}.');
    return null;
  }
  const before = issues.list.length;
  if (v.system !== 'n8n') {
    issues.add('run_ref.system', 'unsupported_run_system', 'run_ref_n8n_only', 'run_ref.system must be "n8n"; no other run system has an agreed identity yet.');
  }
  let id_epoch: number | null = null;
  if (!has(v, 'id_epoch') || v.id_epoch === null) {
    issues.add('run_ref.id_epoch', 'run_epoch_missing', 'run_ref_epoch', 'run_ref.id_epoch is required: n8n execution ids repeat across epochs (migration 108; 0 is the live numbering). Never assumed.');
  } else {
    id_epoch = wholeNumber(v.id_epoch);
    if (id_epoch === null || id_epoch > MAX_EPOCH) {
      issues.add('run_ref.id_epoch', 'bad_run_epoch', 'run_ref_epoch', `run_ref.id_epoch is a whole number from 0 to ${MAX_EPOCH}.`);
      id_epoch = null;
    }
  }
  let execution_id: number | null = null;
  if (!has(v, 'execution_id') || v.execution_id === null) {
    issues.add('run_ref.execution_id', 'run_execution_id_missing', 'run_ref_epoch', 'run_ref.execution_id is required.');
  } else {
    execution_id = wholeNumber(v.execution_id);
    if (execution_id === null || execution_id < 1) {
      issues.add('run_ref.execution_id', 'bad_run_execution_id', 'run_ref_epoch', 'run_ref.execution_id is a positive whole number (digits only).');
      execution_id = null;
    }
  }
  let workflow_id: string | null = null;
  if (!has(v, 'workflow_id') || v.workflow_id === null || v.workflow_id === '') {
    issues.add('run_ref.workflow_id', 'run_workflow_id_missing', 'run_ref_workflow_required', 'run_ref.workflow_id is required: it is what tells a mistyped execution id (7653 for 72653) from the right one.');
  } else if (typeof v.workflow_id !== 'string' || !N8N_WORKFLOW_ID.test(v.workflow_id)) {
    issues.add('run_ref.workflow_id', 'bad_run_workflow_id', 'run_ref_workflow_required', 'run_ref.workflow_id is an n8n workflow id: letters and digits, 8 to 64 characters.');
  } else {
    workflow_id = v.workflow_id;
  }
  for (const k of Object.keys(v)) {
    if (!RUN_REF_KEYS.includes(k)) issues.add(`run_ref.${k}`, 'unknown_field', 'known_fields_only', `run_ref.${k} is not part of the run identity.`);
  }
  if (issues.list.length !== before || id_epoch === null || execution_id === null || workflow_id === null) return null;
  return { system: 'n8n', id_epoch, execution_id, workflow_id };
}

const STANDING_BLOCKS = Object.freeze([
  'contract_not_approved',
  'field_mapping_unconfirmed',
  'approver_authority_not_verified',
  'references_not_verified',
]);

const COMBINATION_BLOCK: Record<Combination, string | null> = Object.freeze({
  defined: null,
  not_defined: 'combination_not_defined',
  not_stated: 'combination_not_stated',
  incomplete: 'combination_incomplete',
});

function result(issues: Issues, rest: Pick<CheckResult, 'runtime_verification_status' | 'closure_state' | 'normalised'>): CheckResult {
  const combination = combinationOf(rest.runtime_verification_status.value, rest.closure_state.value);
  const comboBlock = COMBINATION_BLOCK[combination];
  return {
    contract: CONTRACT,
    contract_status: CONTRACT_STATUS,
    structurally_valid: issues.list.length === 0,
    issues: issues.list,
    runtime_verification_status: rest.runtime_verification_status,
    closure_state: rest.closure_state,
    field_mapping: 'provisional',
    combination,
    can_charge_live: false,
    references_verified: false,
    // Fresh arrays every call: one caller changing its result cannot change another's.
    unverified_references: [...UNVERIFIED_REFERENCES],
    proposed_rules_applied: [...issues.proposed].sort(),
    eligible_for_persistence: false,
    acceptance_eligible: false,
    blocked_by: [...(issues.list.length ? ['structural_issues'] : []), ...(comboBlock ? [comboBlock] : []), ...STANDING_BLOCKS],
    normalised: rest.normalised,
  };
}

/**
 * Checks the shape of one proposed record. Pure: no database, no network, no clock, no randomness.
 * Never throws on bad input; every problem is an issue. The result is never eligible to persist.
 */
export function check(input: unknown): CheckResult {
  const issues = new Issues();

  if (!isObject(input)) {
    issues.add('(record)', 'not_an_object', 'known_fields_only', 'The record is a JSON object.');
    return result(issues, {
      runtime_verification_status: { value: null, approved: false, reason: 'missing' },
      closure_state: { value: null, approved: false, reason: 'missing' },
      normalised: null,
    });
  }
  const o = input;

  // Legacy and derived names first, so a caller learns they are not mapped.
  for (const k of Object.keys(LEGACY_FIELDS)) {
    if (k in o) issues.add(k, 'legacy_field_not_mapped', 'legacy_not_mapped', LEGACY_FIELDS[k]);
  }
  for (const k of DERIVED_FIELDS) {
    if (k in o) issues.add(k, 'derived_field_supplied', 'derived_not_supplied', `${k} is filled by the writer from the source of truth, never supplied.`);
  }
  const known = new Set<string>([...REQUIRED, ...OPTIONAL, ...Object.keys(LEGACY_FIELDS), ...DERIVED_FIELDS]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) issues.add(k, 'unknown_field', 'known_fields_only', `${k} is not a field of ${CONTRACT}.`);
  }

  // loop_id
  let loop_id: string | null = null;
  if (!has(o, 'loop_id') || o.loop_id === null || o.loop_id === '') issues.add('loop_id', 'missing', 'five_fields', 'loop_id is required.');
  else if (typeof o.loop_id !== 'string' || !LOOP_ID.test(o.loop_id)) issues.add('loop_id', 'bad_loop_id', 'loop_id_shape', 'loop_id is LOOP-<ms>-<4>, e.g. LOOP-1792768395739-SMQZ.');
  else loop_id = o.loop_id;

  // evidence_ref (EV-only is proposed)
  issues.rely('evidence_ref_ev_only');
  let evidence_ref: string | null = null;
  if (!has(o, 'evidence_ref') || o.evidence_ref === null || o.evidence_ref === '') issues.add('evidence_ref', 'missing', 'five_fields', 'evidence_ref is required.');
  else if (typeof o.evidence_ref !== 'string' || !EV_ID.test(o.evidence_ref)) issues.add('evidence_ref', 'bad_evidence_ref', 'evidence_ref_ev_only', 'evidence_ref is an evidence-store id, EV-<ms>-<4>. A Drive, Slack or n8n link is not one.');
  else evidence_ref = o.evidence_ref;

  // approver_id: required on every record is proposed; never taken from owner_id.
  issues.rely('approver_required');
  issues.rely('approver_not_bot_id');
  let approver_id: string | null = null;
  if (!has(o, 'approver_id') || o.approver_id === null || o.approver_id === '') issues.add('approver_id', 'missing', 'approver_required', 'approver_id is required: the Slack id of the named person who approves.');
  else if (typeof o.approver_id === 'string' && SLACK_BOT_ID_SHAPE.test(o.approver_id)) issues.add('approver_id', 'approver_bot_id_shape', 'approver_not_bot_id', 'approver_id has the shape of a Slack bot id (B…). This is an id-shape check only; it does not prove any id belongs to a person.');
  else if (typeof o.approver_id !== 'string' || !SLACK_USER.test(o.approver_id)) issues.add('approver_id', 'bad_approver_id', 'approver_shape', 'approver_id is a Slack user id, U… or W….');
  else approver_id = o.approver_id;

  // decision_link: not one of Jason's five; required by this design.
  issues.rely('decision_link_required');
  let decision_link: string | null = null;
  let decision: SlackLink | null = null;
  if (!has(o, 'decision_link') || o.decision_link === null || o.decision_link === '') issues.add('decision_link', 'missing', 'decision_link_required', 'decision_link is required: the Slack link (Copy link) of the message stating this.');
  else {
    decision = parseSlackLink(o.decision_link);
    if (!decision) issues.add('decision_link', 'bad_decision_link', 'slack_link_shape', 'decision_link is a Slack message permalink: https://<workspace>.slack.com/archives/<C…>/p<16 digits>.');
    else decision_link = (o.decision_link as string).trim();
  }

  const runtime_verification_status = readStatus(o, RUNTIME_VERIFICATION_STATUS_VOCABULARY, issues);
  const closure_state = readStatus(o, CLOSURE_STATE_VOCABULARY, issues);

  // COMMERCIAL_OK: only Jason, or a separately verified delegate (none is recognised today).
  if (closure_state.value === 'COMMERCIAL_OK' && approver_id && approver_id !== COMMERCIAL_APPROVER && !DELEGATED_COMMERCIAL_APPROVERS.includes(approver_id)) {
    issues.add('approver_id', 'commercial_approver_not_authorized', 'commercial_ok_authority', `COMMERCIAL_OK is set only by Jason (${COMMERCIAL_APPROVER}) or an explicitly delegated commercial approver; no delegation is recognised for ${approver_id}.`);
  }

  const run_ref = has(o, 'run_ref') && o.run_ref !== null ? readRunRef(o.run_ref, issues) : null;

  let gate_ref: string | null = null;
  if (has(o, 'gate_ref') && o.gate_ref !== null) {
    if (typeof o.gate_ref !== 'string' || !CG_ID.test(o.gate_ref)) issues.add('gate_ref', 'bad_gate_ref', 'gate_ref_shape', 'gate_ref is a charge-gate id, CG-<ms>-<4>.');
    else gate_ref = o.gate_ref;
  }

  let supersedes: string | null = null;
  if (has(o, 'supersedes') && o.supersedes !== null) {
    issues.rely('supersedes_shape');
    if (typeof o.supersedes !== 'string' || !AE_ID.test(o.supersedes)) issues.add('supersedes', 'bad_supersedes', 'supersedes_shape', 'supersedes is an acceptance-evidence id, AE-<ms>-<4>.');
    else supersedes = o.supersedes;
  }

  let proof_type: ProofType | null = null;
  try {
    proof_type = parseProofType(o.proof_type);
  } catch (e) {
    issues.add('proof_type', 'bad_proof_type', 'proof_type', (e as ProofTypeError).message);
  }

  let notes: string | null = null;
  if (has(o, 'notes') && o.notes !== null) {
    if (typeof o.notes !== 'string' || o.notes.length > 2000) issues.add('notes', 'bad_notes', 'known_fields_only', 'notes is text of at most 2,000 characters.');
    else notes = o.notes.trim() || null;
  }

  if (has(o, 'test') && typeof o.test !== 'boolean') issues.add('test', 'bad_test_flag', 'known_fields_only', 'test is true or false.');
  const test = o.test === true;

  const normalised: NormalisedRecord | null =
    issues.list.length === 0 && loop_id && evidence_ref && approver_id && decision_link && decision && runtime_verification_status.value && closure_state.value
      ? { loop_id, evidence_ref, runtime_verification_status: runtime_verification_status.value, approver_id, closure_state: closure_state.value, decision_link, decision, run_ref, gate_ref, proof_type, supersedes, notes, test }
      : null;

  return result(issues, { runtime_verification_status, closure_state, normalised });
}

/**
 * A caller asking "may this count as accepted?" Always no, until the field mapping and the remaining
 * design rules are approved and a writer verifies the references. Throws, naming every reason.
 */
export function requireAcceptanceEligible(input: unknown): never {
  const r = check(input);
  throw new AcceptanceEvidenceError(
    'not_acceptance_eligible',
    `Not acceptance-eligible: ${r.blocked_by.join(', ')}. A well-formed record is not an approved one.`,
    r,
  );
}
