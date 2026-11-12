/**
 * The acceptance-evidence record: structural check only. THE single canonical acceptance validator
 * (SOP d0606fb6, Jason, 10 Nov 2026: "PR 23 is the canonical acceptance validator… fold the v0
 * Acceptance-State Contract into a single module under the PR 23 path").
 *
 * History: U0MN's five-field record (Jason, DW-1794066855896-U0MN, 7 Nov; PR #23, merged 10 Nov),
 * now aligned to Acceptance-State Contract v0 (SOP 2b794599, Jason, 10 Nov) and the three rulings of
 * 12 Nov logged from his reply in C0AF7AGC2UV 1794063138.912579:
 *   - d0606fb6  one validator, this one; no parallel "v0 checker" (PR #24's checker is folded in here);
 *   - b3a349df  COMMERCIAL_OK needs an explicit, resolved human approver_id; actor_id may be someone
 *               else, an automated writer included; labels and runtime_verification_status are
 *               conceptually separate, and an invalid combination must be impossible to represent;
 *   - 8034ef06  evidence is linked EV records, at least one for contract evidence and one for
 *               implementation evidence; EV-1794203909317-FS3N is a collection, never final proof.
 *
 * What this file is:
 *   - PURE. It reads no database, calls no network, writes nothing, and imports nothing but the pure
 *     proof_type rule. No route, tool, writer or consumer calls it yet (SOP 3cc1ba00: live but inert;
 *     Destiny, 10 Nov: nothing reads or writes acceptance records until the first loop and her go).
 *   - a check of SHAPE. A well-formed EV-…, LOOP-… or Slack link says nothing about whether that
 *     record exists, what it proves, who posted the message, or whether a run happened.
 *   - NEVER authorizing. Every result carries acceptance_pass_allowed, eligible_for_persistence,
 *     acceptance_eligible, authorizes and can_charge_live as the literal false, and
 *     requireAcceptanceEligible always throws.
 *
 * The vocabularies:
 *   - runtime_verification_status: exactly unresolved, contract_pass, implementation_pass,
 *     runtime_proof (Contract v0 §3, "No other values are allowed");
 *   - closure_state (Engine acceptance state): exactly TECH_ONLY, LOOP_ACCEPTED, COMMERCIAL_OK
 *     (SOP f7720fc0, still in use per SOP b3a349df);
 *   - the 9 Nov labels Satisfied, Not Satisfied, Not Verified are NOT runtime states. They are refused
 *     by name in runtime_verification_status and never translated. No field carries them in this
 *     slice: where they live, and which combinations are allowed, is still Jason's.
 *
 * acceptance_pass = true is ALWAYS refused here. Contract v0 §4 allows it only with runtime_proof,
 * contract evidence, implementation evidence and a valid direct authorization or delegation; a pure
 * check can verify none of them, and who is "explicitly authorized for this gate" is not yet defined.
 *
 * Every rule below is in RULES with its authority and status, and every issue names the rule it came
 * from, so a refusal resting on a proposed rule says so. `approved` means stated by Jason (cited) or an
 * existing rule this code reuses; `proposed` is this design's own reading, awaiting a decision.
 *
 * Never renamed or inferred: owner_id is not approver_id; approval_status is not closure_state;
 * evidence_reference and the retired evidence_ref are not the evidence lists; gate_ref is not read as
 * gate_id; no closure_state, approver or runtime state is derived from anything else.
 */
import { parseProofType, ProofTypeError, type ProofType } from './proofType';

export const CONTRACT = 'bha.acceptance_evidence.v2';
/** Acceptance-State Contract v0, the contract this validator implements. */
export const CONTRACT_SOP = '2b794599-7862-4da7-b2bc-45d33f79aa52';
/** Pre-integration: nothing calls this yet, and the combinations Jason will approve are not yet listed. */
export const CONTRACT_STATUS = 'pre_integration' as const;

// ---------------------------------------------------------------- rule authority

/**
 * approved            stated by Jason (SOP cited) or an existing rule held elsewhere in this repo;
 * proposed            this design's own rule or reading, awaiting Jason (or Destiny for schema matters);
 * unapproved_vocabulary  a value list nobody has approved; nothing is accepted against it (none today);
 * prototype_guard     a safety rule of this pre-integration validator (fail closed), not a contract rule.
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
  record_fields: rule('record_fields', 'approved', 'The record carries gate_id, loop_id, runtime_verification_status, acceptance_pass, actor_id, approver_id, closure_state and its linked contract and implementation evidence.', "Jason's U0MN request (DW-1794066855896-U0MN, 7 Nov 2026), as revised by Acceptance-State Contract v0 §2 (SOP 2b794599) and SOPs b3a349df and 8034ef06 (Jason, 10 Nov)."),
  loop_id_shape: rule('loop_id_shape', 'approved', 'loop_id is required and is LOOP-<ms>-<4>.', 'SOP 2b794599 §2 and SOP cd1ea717 (new gate events carry loop_id); shape as evidence.ts and chargeGate.ts.'),
  gate_id_required: rule('gate_id_required', 'approved', 'gate_id (or equivalent) is required.', 'SOP 2b794599 §2.'),
  gate_id_format: rule('gate_id_format', 'proposed', 'Only a charge-gate id (CG-<ms>-<4>) is recognised as gate_id; any other gate id is refused until a format is agreed.', 'Design reading: the contract does not define "or equivalent" and no shared gate registry exists. Awaiting Jason (what a gate is) and Destiny (format).'),
  ev_shape: rule('ev_shape', 'approved', 'An evidence-store id is EV-<ms>-<4>.', 'Existing code: evidence.EV_ID (migration 103, Destiny, 28 Oct 2026).'),
  runtime_verification_status_vocabulary: rule('runtime_verification_status_vocabulary', 'approved', 'runtime_verification_status is exactly unresolved, contract_pass, implementation_pass or runtime_proof, compared exactly.', 'SOP 2b794599 §3 ("No other values are allowed"); SOP a0d187f9.'),
  labels_not_runtime_states: rule('labels_not_runtime_states', 'approved', 'The 9 Nov labels (Satisfied, Not Satisfied, Not Verified) and the Engine acceptance states are not runtime states: refused by name in runtime_verification_status, never translated.', 'SOP b3a349df (Jason, 10 Nov): labels and runtime_verification_status stay conceptually separate; SOP f7720fc0.'),
  closure_state_vocabulary: rule('closure_state_vocabulary', 'approved', 'closure_state (Engine acceptance state) is exactly TECH_ONLY, LOOP_ACCEPTED or COMMERCIAL_OK.', 'Jason Bays, 9 Nov 2026, https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159; SOP f7720fc0; still used by SOP b3a349df.'),
  status_text_shape: rule('status_text_shape', 'prototype_guard', 'A status is a non-empty string of at most 120 characters with no control characters and no leading or trailing whitespace; it is compared exactly, never trimmed or re-cased.', 'Fail closed on a malformed value (Hardik Bhatt, 9 Nov).'),
  acceptance_pass_boolean: rule('acceptance_pass_boolean', 'approved', 'acceptance_pass is required and is the boolean true or false.', 'SOP 2b794599 §2.'),
  acceptance_pass_requires_runtime_proof: rule('acceptance_pass_requires_runtime_proof', 'approved', 'acceptance_pass = true is only valid when runtime_verification_status = runtime_proof.', 'SOP 2b794599 §4; SOP a0d187f9.'),
  acceptance_pass_conditions: rule('acceptance_pass_conditions', 'approved', 'acceptance_pass = true also needs contract evidence, implementation evidence and a valid direct authorization or delegation_ref; "the validator must reject acceptance_pass = true" without them. None can be verified by a pure check, so true is always refused here.', 'SOP 2b794599 §4 and §6.'),
  actor_required: rule('actor_required', 'approved', 'actor_id is required: who wrote or decided the event. It may equal approver_id or differ from it (an automated writer).', 'SOP 2b794599 §2; SOP b3a349df.'),
  actor_shape: rule('actor_shape', 'proposed', 'actor_id is a Slack id of a person (U… or W…) or of a bot (B…), because an automated writer may be the actor.', 'Design reading of SOP b3a349df; the contract names actor_id but no format. Awaiting Destiny.'),
  approver_required: rule('approver_required', 'proposed', 'approver_id is required on every record.', 'Design. Jason requires it explicitly only on COMMERCIAL_OK (SOP b3a349df); every other record keeps this proposed rule.'),
  approver_shape: rule('approver_shape', 'approved', 'approver_id is a Slack user id (U… or W…).', 'Existing code: evidence.ts checks the same pattern for author and requester.'),
  approver_not_bot_id: rule('approver_not_bot_id', 'proposed', 'An approver_id shaped like a Slack bot id (B…) is refused. An id-shape check, not proof the id belongs to a person.', 'Design, following the MPMD approver rule (EV-1793600858856-PT9J): a named person, never a machine.'),
  commercial_ok_requires_human_approver: rule('commercial_ok_requires_human_approver', 'approved', 'A COMMERCIAL_OK record must carry an explicit approver_id that is the human commercial authority; without one it is invalid, whoever the actor is.', 'SOP b3a349df (Jason, 10 Nov): "Implementation and tests must treat COMMERCIAL_OK writes without a valid approver_id as invalid under the contract."'),
  commercial_ok_authority: rule('commercial_ok_authority', 'approved', 'COMMERCIAL_OK is set only by Jason or a named commercial delegate.', 'SOP f7720fc0 (Jason, 9 Nov); SOP b3a349df (10 Nov).'),
  no_commercial_delegate: rule('no_commercial_delegate', 'prototype_guard', 'No named commercial delegate is recognised: none is recorded anywhere yet, so only Jason can be the approver of COMMERCIAL_OK here.', 'Fail closed until a delegation record exists (SOP 2b794599 §6).'),
  loop_accepted_authority: rule('loop_accepted_authority', 'approved', 'LOOP_ACCEPTED is set by the loop owner (technical/operational).', 'SOP f7720fc0 (9 Nov); SOP b3a349df (10 Nov). Who owns the loop is checked later against the source of truth, not here.'),
  technical_status_authority: rule('technical_status_authority', 'approved', 'The technical labels are set by the implementing builder and verified via tests and artifacts.', 'SOP f7720fc0 (Jason, 9 Nov). No field carries the labels in this slice.'),
  tech_only_default: rule('tech_only_default', 'approved', 'TECH_ONLY is the default once tests/evidence are in.', 'SOP f7720fc0 (Jason, 9 Nov). This check never fills in a default: closure_state is required as sent.'),
  evidence_linked_records: rule('evidence_linked_records', 'approved', 'At least one EV record for contract evidence and at least one for implementation evidence, as separate records the event links by id; no single monolithic acceptance bundle.', 'SOP 8034ef06 (Jason, 10 Nov).'),
  evidence_field_names: rule('evidence_field_names', 'proposed', 'The two lists are named contract_evidence_refs and implementation_evidence_refs.', 'Design naming; SOP 8034ef06 sets the rule, not the field names. Awaiting Destiny.'),
  not_acceptance_evidence: rule('not_acceptance_evidence', 'approved', 'EV-1794203909317-FS3N is an evidence collection, not a gate, and is never accepted as acceptance proof in any evidence slot.', 'SOP 8034ef06 (Jason, 10 Nov): "Tests must fail if someone treats a generic EV such as FS3N as a complete acceptance bundle."'),
  evidence_ref_retired: rule('evidence_ref_retired', 'prototype_guard', 'The single evidence_ref is retired from this input; one EV cannot stand for both kinds of evidence. Historical Engine records are not touched.', 'SOP 8034ef06; retirement approved by Hardik Bhatt for this slice (12 Nov 2026). Awaiting Destiny\'s review.'),
  delegation_ref_shape: rule('delegation_ref_shape', 'proposed', 'delegation_ref, when present, is an evidence-store id (EV-<ms>-<4>) and is never FS3N.', 'Design reading of SOP 2b794599 §6 ("points to a delegation record in the evidence store"); the delegation record format is not defined. Awaiting Destiny.'),
  decision_link_required: rule('decision_link_required', 'proposed', 'Every record names the Slack message it rests on (decision_link).', 'Design §12.3 (identity and idempotency).'),
  slack_link_shape: rule('slack_link_shape', 'approved', 'A decision link is a Slack message permalink: https://<workspace>.slack.com/archives/<C|D|G…>/p<16 digits>.', 'Existing code: chargeGate.parseLink.'),
  run_ref_n8n_only: rule('run_ref_n8n_only', 'proposed', 'run_ref.system is "n8n"; no other run system has an agreed identity yet.', 'Design §4 (Hardik Bhatt, 9 Nov).'),
  run_ref_epoch: rule('run_ref_epoch', 'approved', 'An n8n run is identified by (id_epoch, execution_id); execution ids repeat across epochs.', 'Migration 108 (Destiny, 1 Nov 2026).'),
  run_ref_workflow_required: rule('run_ref_workflow_required', 'proposed', 'run_ref.workflow_id is required, to catch a mistyped execution id (7653 vs 72653).', 'Design §12.3.'),
  proof_type: rule('proof_type', 'approved', 'proof_type is test_forced or live_natural; left out is not stated, never live.', 'Jason, 7 Nov 2026 (proofType.ts).'),
  supersedes_shape: rule('supersedes_shape', 'proposed', 'An escalation or correction names the record it follows as AE-<ms>-<4>.', 'SOP 2b794599 §5 (a new event references the prior event); the AE id format is this design\'s. Awaiting Destiny.'),
  combination_not_approved: rule('combination_not_approved', 'prototype_guard', 'No pairing of runtime_verification_status with closure_state is approved yet, so every complete pairing blocks.', 'SOP b3a349df asks tests to enforce the allowed combinations; Jason has not listed them. Awaiting Jason.'),
  historical_not_rewritten: rule('historical_not_rewritten', 'approved', 'Historical acceptance records are never edited in place; this check never changes its input.', 'SOP 2b794599 §5 and §7; SOP cd1ea717.'),
  no_live_charging: rule('no_live_charging', 'approved', 'No runtime state, acceptance state or acceptance_pass sets or implies can_charge_live; only the charge gate decides it.', 'chargeGate.ts RULES (Jason, 22 Oct 2026); SOP 2b794599 §8; SOP f0bc886b.'),
  legacy_not_mapped: rule('legacy_not_mapped', 'prototype_guard', 'owner_id, approval_status and evidence_reference are refused, never translated into the new fields.', 'U0MN task instruction (Hardik Bhatt, 9 Nov).'),
  derived_not_supplied: rule('derived_not_supplied', 'prototype_guard', 'Fields the writer derives are never accepted from a caller.', 'Design §4 (Hardik Bhatt, 9 Nov).'),
  known_fields_only: rule('known_fields_only', 'prototype_guard', 'A field outside the record is refused, not ignored.', 'Design §4 (Hardik Bhatt, 9 Nov): fail closed.'),
  never_eligible: rule('never_eligible', 'prototype_guard', 'No record is eligible to persist, to count as accepted or to authorize anything.', 'SOP 3cc1ba00 (live but inert); Destiny, 10 Nov: nothing writes acceptance records until the first loop and her go.'),
});

export type RuleId = keyof typeof RULES;

export const JASON_DECISION_LINK = 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794228033482159';
/** Jason's 10 Nov reply that settled the single validator, the approver and the evidence pattern. */
export const JASON_FOLD_IN_LINK = 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794493906765579';

/** An approved value list, where it came from, and the field it is carried in. */
export interface ApprovedVocabulary {
  readonly approved: true;
  readonly values: readonly string[];
  readonly name: string;
  readonly source: string;
  readonly sop: string;
  readonly rule: RuleId;
  readonly field: 'runtime_verification_status' | 'closure_state';
}

/** Contract v0 §3, in its order. */
export const RUNTIME_VERIFICATION_STATES = Object.freeze(['unresolved', 'contract_pass', 'implementation_pass', 'runtime_proof'] as const);
export type RuntimeVerificationState = (typeof RUNTIME_VERIFICATION_STATES)[number];
/** The 9 Nov labels (SOP f7720fc0). Known only so they can be refused by name; never a runtime state. */
export const TECHNICAL_STATUSES = Object.freeze(['Satisfied', 'Not Satisfied', 'Not Verified'] as const);
export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];
export const ACCEPTANCE_STATES = Object.freeze(['TECH_ONLY', 'LOOP_ACCEPTED', 'COMMERCIAL_OK'] as const);
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];

export const RUNTIME_VERIFICATION_STATUS_VOCABULARY: ApprovedVocabulary = Object.freeze({
  approved: true,
  values: RUNTIME_VERIFICATION_STATES,
  name: 'runtime verification state',
  source: 'https://bayshorizonnetwork.slack.com/archives/C0AF7AGC2UV/p1794316291026599',
  sop: CONTRACT_SOP,
  rule: 'runtime_verification_status_vocabulary',
  field: 'runtime_verification_status',
});

export const CLOSURE_STATE_VOCABULARY: ApprovedVocabulary = Object.freeze({
  approved: true,
  values: ACCEPTANCE_STATES,
  name: 'Engine acceptance state',
  source: JASON_DECISION_LINK,
  sop: 'f7720fc0-79da-48b6-893b-7ff0a162922d',
  rule: 'closure_state_vocabulary',
  field: 'closure_state',
});

/** The human commercial authority: the only approver of COMMERCIAL_OK today (Jason Bays). */
export const COMMERCIAL_APPROVER = 'U0A9V97949F';
/** Named commercial delegates recognised: none. A delegation must be recorded and verified first. */
export const DELEGATED_COMMERCIAL_APPROVERS: readonly string[] = Object.freeze([]);

/**
 * EV records that are never acceptance proof, by SOP. A pure check can only name these; whether any
 * other EV is really contract or implementation evidence of this gate, and where it came from, is for
 * the trusted writer to verify against the evidence store (see UNVERIFIED_REFERENCES).
 */
export const NOT_ACCEPTANCE_EVIDENCE: Readonly<Record<string, string>> = Object.freeze({
  'EV-1794203909317-FS3N': 'EV-1794203909317-FS3N is the 22-requirement Honest Gate matrix: an evidence collection, not a gate, and never final acceptance proof (SOP 8034ef06).',
});

/** Whether the contract states this pairing. None is stated yet, so a complete pairing is never 'defined'. */
export type Combination = 'defined' | 'not_stated' | 'incomplete';

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
/** At most this many EV ids per evidence list: a list is a handful of linked records, never a dump. */
export const MAX_EVIDENCE_REFS = 20;

export const REQUIRED = Object.freeze([
  'gate_id', 'loop_id', 'runtime_verification_status', 'acceptance_pass', 'actor_id', 'approver_id',
  'closure_state', 'contract_evidence_refs', 'implementation_evidence_refs', 'decision_link',
] as const);
export const OPTIONAL = Object.freeze(['delegation_ref', 'run_ref', 'proof_type', 'supersedes', 'notes', 'test'] as const);
/** The earlier telemetry contract's names. Refused, never mapped. */
export const LEGACY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  owner_id: 'owner_id is who owns the work, not who approves it; it is not approver_id and is never copied into it.',
  approval_status: 'approval_status is one approval decision, not where the acceptance stands; it is not closure_state and is never translated into it.',
  evidence_reference: 'evidence_reference was free text; evidence is linked EV records in contract_evidence_refs and implementation_evidence_refs.',
});
/** Fields of the earlier five-field input that this validator no longer takes. Refused by name, never mapped. */
export const RETIRED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  evidence_ref: 'evidence_ref is retired: one EV cannot stand for both kinds of evidence (SOP 8034ef06). Name the linked records in contract_evidence_refs and implementation_evidence_refs. Historical records keep their own field.',
  gate_ref: 'gate_ref is retired: Contract v0 names gate_id. Send gate_id; gate_ref is never read as it.',
});
/** Filled by the writer from the source of truth, never by a caller. */
export const DERIVED_FIELDS = Object.freeze(['record_id', 'owner_id_snapshot', 'evidence_snapshot', 'recorded_by', 'via', 'decision_channel', 'decision_ts'] as const);
const RUN_REF_KEYS = Object.freeze(['system', 'id_epoch', 'execution_id', 'workflow_id']);

export type IssueCode =
  | 'not_an_object'
  | 'missing'
  | 'bad_loop_id'
  | 'bad_gate_id'
  | 'gate_id_format_undefined'
  | 'bad_status'
  | 'unknown_status_value'
  | 'label_not_runtime_state'
  | 'acceptance_state_not_runtime_state'
  | 'bad_acceptance_pass'
  | 'acceptance_pass_requires_runtime_proof'
  | 'acceptance_pass_not_verifiable_here'
  | 'bad_actor_id'
  | 'bad_approver_id'
  | 'approver_bot_id_shape'
  | 'commercial_ok_approver_missing'
  | 'commercial_approver_not_authorized'
  | 'bad_evidence_refs'
  | 'evidence_refs_empty'
  | 'duplicate_evidence_ref'
  | 'evidence_ref_in_both_lists'
  | 'not_acceptance_evidence'
  | 'bad_delegation_ref'
  | 'bad_decision_link'
  | 'bad_run_ref'
  | 'run_epoch_missing'
  | 'bad_run_epoch'
  | 'run_execution_id_missing'
  | 'bad_run_execution_id'
  | 'run_workflow_id_missing'
  | 'bad_run_workflow_id'
  | 'unsupported_run_system'
  | 'bad_supersedes'
  | 'bad_proof_type'
  | 'bad_test_flag'
  | 'bad_notes'
  | 'retired_field'
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
  /** True only for a value in the approved vocabulary. */
  approved: boolean;
  reason: 'approved_value' | 'not_in_vocabulary' | 'missing' | 'malformed';
}

/** What the trusted writer would have to establish against the source of truth. None is checked here. */
export const UNVERIFIED_REFERENCES = Object.freeze([
  'loop_id exists in engine_loops',
  'gate_id names a gate that is held, and what counts as a gate is defined',
  'every EV in contract_evidence_refs and implementation_evidence_refs is held in engine_evidence, is not a test record, and is really contract or implementation evidence for this gate, with its provenance checked (FS3N is the only one refused by name here)',
  'actor_id is the person or automated writer that wrote the event',
  'decision_link is a real Slack message posted by approver_id',
  'approver_id belongs to a person (the B… check is an id shape only)',
  'for LOOP_ACCEPTED: approver_id owns the loop or track of loop_id',
  'for COMMERCIAL_OK by anyone but Jason: a recorded, verified commercial delegation (none is recognised today)',
  'delegation_ref names an evidence-store delegation record with delegator, delegate, scope and effective dates, valid at the time of the event',
  'for acceptance_pass: the actor is explicitly authorized for this gate (no per-gate authorization register exists yet)',
  'for runtime_proof: real events passed through this gate and are recorded in the evidence store',
  'run_ref matches one row of engine_execution_runs (id_epoch, execution_id, workflow_id)',
  'supersedes is held and is the newest record for this gate and loop',
] as const);

export interface CheckResult {
  contract: typeof CONTRACT;
  contract_sop: typeof CONTRACT_SOP;
  contract_status: typeof CONTRACT_STATUS;
  /** True when every field has a valid shape. It is NOT an approval, NOT existence, NOT authorization. */
  structurally_valid: boolean;
  issues: Issue[];
  runtime_verification_status: StatusReading;
  closure_state: StatusReading;
  /** Whether the contract states this pairing of runtime state and acceptance state. None is stated yet. */
  combination: Combination;
  /** What the caller asked for, when it was a boolean; else null. */
  acceptance_pass_requested: boolean | null;
  acceptance_pass_allowed: false;
  /** Why acceptance_pass cannot be true here. Empty only when true was not asked for. */
  acceptance_pass_blocked_by: string[];
  /** Never true: nothing in this record opens live charging. chargeGate.status() decides that. */
  can_charge_live: false;
  references_verified: false;
  unverified_references: string[];
  /** The proposed rules this result relied on, so a reader can tell a structural pass from an approved one. */
  proposed_rules_applied: string[];
  eligible_for_persistence: false;
  acceptance_eligible: false;
  authorizes: false;
  /** Every reason this record cannot be persisted or counted, structural or not. Never empty. */
  blocked_by: string[];
  /** The cleaned shape, for display; present only when structurally valid. */
  normalised: NormalisedRecord | null;
}

export interface NormalisedRecord {
  gate_id: string;
  loop_id: string;
  runtime_verification_status: RuntimeVerificationState;
  acceptance_pass: boolean;
  actor_id: string;
  approver_id: string;
  closure_state: AcceptanceState;
  contract_evidence_refs: string[];
  implementation_evidence_refs: string[];
  delegation_ref: string | null;
  decision_link: string;
  decision: SlackLink;
  run_ref: RunRef | null;
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
const absent = (o: Record<string, unknown>, k: string): boolean => !has(o, k) || o[k] === null || o[k] === '';
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
    if (r.status === 'proposed') this.proposed.add(ruleId);
    this.list.push({ field, code, message: r.status === 'proposed' ? message + PROPOSED : message, rule: r.id, rule_status: r.status });
  }
  rely(ruleId: RuleId): void {
    if (RULES[ruleId].status === 'proposed') this.proposed.add(ruleId);
  }
}

/** A well-formed status string, or null after recording why not. Shared by both status fields. */
function statusText(o: Record<string, unknown>, field: string, missingRule: RuleId, issues: Issues): string | null {
  if (!has(o, field) || o[field] === null) {
    issues.add(field, 'missing', missingRule, `${field} is required.`);
    return null;
  }
  const v = o[field];
  if (typeof v !== 'string' || !v.trim() || v.length > STATUS_MAX || CONTROL.test(v) || v !== v.trim()) {
    issues.add(field, 'bad_status', 'status_text_shape', `${field} is a non-empty string of at most ${STATUS_MAX} characters, with no control characters and no leading or trailing spaces. It is compared exactly and never trimmed.`);
    return null;
  }
  return v;
}

const MISSING: StatusReading = Object.freeze({ value: null, approved: false, reason: 'missing' }) as StatusReading;

function readRuntimeStatus(o: Record<string, unknown>, issues: Issues): StatusReading {
  const field = 'runtime_verification_status';
  const v = statusText(o, field, 'runtime_verification_status_vocabulary', issues);
  if (v === null) return { ...(has(o, field) && o[field] !== null ? { value: null, approved: false, reason: 'malformed' } : MISSING) } as StatusReading;
  // Exact match only: no trimming, no re-casing, no synonyms.
  if ((RUNTIME_VERIFICATION_STATES as readonly string[]).includes(v)) return { value: v, approved: true, reason: 'approved_value' };
  if ((TECHNICAL_STATUSES as readonly string[]).includes(v)) {
    issues.add(field, 'label_not_runtime_state', 'labels_not_runtime_states', `"${v}" is a 9 Nov technical label (SOP f7720fc0), not a runtime state. Labels and runtime_verification_status are separate (SOP b3a349df); it is never translated. Where the labels are carried is Jason's to decide.`);
  } else if ((ACCEPTANCE_STATES as readonly string[]).includes(v)) {
    issues.add(field, 'acceptance_state_not_runtime_state', 'labels_not_runtime_states', `"${v}" is an Engine acceptance state; it belongs in closure_state, never in runtime_verification_status, and is never translated.`);
  } else {
    issues.add(field, 'unknown_status_value', 'runtime_verification_status_vocabulary', `runtime_verification_status is exactly one of ${RUNTIME_VERIFICATION_STATES.join(', ')} (Contract v0 §3). "${v}" is not one of them.`);
  }
  return { value: null, approved: false, reason: 'not_in_vocabulary' };
}

function readClosure(o: Record<string, unknown>, issues: Issues): StatusReading {
  const field = 'closure_state';
  const v = statusText(o, field, 'record_fields', issues);
  if (v === null) return { ...(has(o, field) && o[field] !== null ? { value: null, approved: false, reason: 'malformed' } : MISSING) } as StatusReading;
  if ((ACCEPTANCE_STATES as readonly string[]).includes(v)) return { value: v, approved: true, reason: 'approved_value' };
  issues.add(field, 'unknown_status_value', 'closure_state_vocabulary', `closure_state carries the Engine acceptance state, exactly one of: ${ACCEPTANCE_STATES.join(', ')} (SOP f7720fc0). "${v}" is not one of them.`);
  return { value: null, approved: false, reason: 'not_in_vocabulary' };
}

/** One evidence list: present, an array of 1 to MAX_EVIDENCE_REFS distinct EV ids, none of them FS3N. */
function readEvidenceRefs(o: Record<string, unknown>, field: 'contract_evidence_refs' | 'implementation_evidence_refs', issues: Issues): string[] | null {
  issues.rely('evidence_field_names');
  if (!has(o, field) || o[field] === null) {
    issues.add(field, 'missing', 'evidence_linked_records', `${field} is required: at least one EV record, linked by id (SOP 8034ef06).`);
    return null;
  }
  const v = o[field];
  if (!Array.isArray(v) || v.length > MAX_EVIDENCE_REFS) {
    issues.add(field, 'bad_evidence_refs', 'evidence_field_names', `${field} is a list of 1 to ${MAX_EVIDENCE_REFS} evidence-store ids (EV-<ms>-<4>).`);
    return null;
  }
  if (v.length === 0) {
    issues.add(field, 'evidence_refs_empty', 'evidence_linked_records', `${field} names at least one EV record (SOP 8034ef06).`);
    return null;
  }
  const before = issues.list.length;
  const seen = new Set<string>();
  v.forEach((id, i) => {
    const at = `${field}[${i}]`;
    if (typeof id !== 'string' || !EV_ID.test(id)) issues.add(at, 'bad_evidence_refs', 'ev_shape', `${at} is an evidence-store id, EV-<ms>-<4>. A Drive, Slack or n8n link is not one.`);
    else if (Object.prototype.hasOwnProperty.call(NOT_ACCEPTANCE_EVIDENCE, id)) issues.add(at, 'not_acceptance_evidence', 'not_acceptance_evidence', NOT_ACCEPTANCE_EVIDENCE[id]);
    else if (seen.has(id)) issues.add(at, 'duplicate_evidence_ref', 'evidence_linked_records', `${id} is named twice in ${field}.`);
    else seen.add(id);
  });
  return issues.list.length === before ? [...seen] : null;
}

/** Whether the contract states this pairing. Pure; never derives one value from the other. No pairing is stated yet. */
export function combinationOf(runtime: string | null, acceptance: string | null): Combination {
  if (!runtime || !acceptance) return 'incomplete';
  return 'not_stated';
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
 * Contract v0 §4 and §6 as one pure statement: acceptance_pass may be true only when the status is
 * runtime_proof AND contract evidence AND implementation evidence AND authorization (direct or by a
 * valid delegation) are each verified. Anything other than the boolean `true` counts as not verified.
 *
 * NOT an authorization mechanism. Its inputs are claims; it checks none of them, and it always answers
 * `authorizes: false`. A trusted writer would have to establish each fact itself against the database
 * and Slack. check() never supplies a fact, so it always refuses acceptance_pass = true.
 */
export function acceptancePassDecision(status: unknown, facts: AcceptancePassFacts = {}): AcceptancePassDecision {
  const unmet: string[] = [];
  if (status !== 'runtime_proof') unmet.push('runtime_proof_required');
  if (facts.contract_evidence_verified !== true) unmet.push('contract_evidence_not_verified');
  if (facts.implementation_evidence_verified !== true) unmet.push('implementation_evidence_not_verified');
  if (facts.authorization_verified !== true) unmet.push('authorization_not_verified');
  return { meets_sop_conditions: unmet.length === 0, unmet, authorizes: false };
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
  'pre_integration',
  'approver_authority_not_verified',
  'references_not_verified',
  'no_trusted_writer',
]);

/** Why acceptance_pass cannot be true here, whatever the record says, beyond the unmet §4 facts. */
const ACCEPTANCE_PASS_UNDEFINED = Object.freeze([
  'gate_authority_undefined',
  'no_trusted_writer',
]);

const COMBINATION_BLOCK: Record<Combination, string | null> = Object.freeze({
  defined: null,
  not_stated: 'combination_not_approved',
  incomplete: 'combination_incomplete',
});

function result(
  issues: Issues,
  rest: Pick<CheckResult, 'runtime_verification_status' | 'closure_state' | 'normalised' | 'acceptance_pass_requested'> & { delegation: boolean },
): CheckResult {
  const combination = combinationOf(rest.runtime_verification_status.value, rest.closure_state.value);
  const comboBlock = COMBINATION_BLOCK[combination];
  let passBlocked: string[] = [];
  if (rest.acceptance_pass_requested === true) {
    // check() supplies no facts, so every evidence and authority condition is unmet.
    passBlocked = [...acceptancePassDecision(rest.runtime_verification_status.value).unmet, ...ACCEPTANCE_PASS_UNDEFINED];
    if (rest.delegation) passBlocked.push('delegation_record_unverified');
  }
  return {
    contract: CONTRACT,
    contract_sop: CONTRACT_SOP,
    contract_status: CONTRACT_STATUS,
    structurally_valid: issues.list.length === 0,
    issues: issues.list,
    runtime_verification_status: rest.runtime_verification_status,
    closure_state: rest.closure_state,
    combination,
    acceptance_pass_requested: rest.acceptance_pass_requested,
    acceptance_pass_allowed: false,
    acceptance_pass_blocked_by: passBlocked,
    can_charge_live: false,
    references_verified: false,
    // Fresh arrays every call: one caller changing its result cannot change another's.
    unverified_references: [...UNVERIFIED_REFERENCES],
    proposed_rules_applied: [...issues.proposed].sort(),
    eligible_for_persistence: false,
    acceptance_eligible: false,
    authorizes: false,
    blocked_by: [
      ...(issues.list.length ? ['structural_issues'] : []),
      ...(rest.acceptance_pass_requested === true ? ['acceptance_pass_not_allowed'] : []),
      ...(comboBlock ? [comboBlock] : []),
      ...STANDING_BLOCKS,
    ],
    normalised: rest.normalised,
  };
}

/**
 * Checks the shape of one proposed record. Pure: no database, no network, no clock, no randomness;
 * it reads its input and never changes it. Never throws on bad input; every problem is an issue.
 * The result never authorizes and is never eligible to persist.
 */
export function check(input: unknown): CheckResult {
  const issues = new Issues();

  if (!isObject(input)) {
    issues.add('(record)', 'not_an_object', 'known_fields_only', 'The record is a JSON object.');
    return result(issues, { runtime_verification_status: MISSING, closure_state: MISSING, normalised: null, acceptance_pass_requested: null, delegation: false });
  }
  const o = input;

  // Earlier names first, so a caller learns they are not mapped.
  for (const k of Object.keys(LEGACY_FIELDS)) {
    if (has(o, k)) issues.add(k, 'legacy_field_not_mapped', 'legacy_not_mapped', LEGACY_FIELDS[k]);
  }
  for (const k of Object.keys(RETIRED_FIELDS)) {
    if (has(o, k)) issues.add(k, 'retired_field', k === 'evidence_ref' ? 'evidence_ref_retired' : 'gate_id_required', RETIRED_FIELDS[k]);
  }
  for (const k of DERIVED_FIELDS) {
    if (has(o, k)) issues.add(k, 'derived_field_supplied', 'derived_not_supplied', `${k} is filled by the writer from the source of truth, never supplied.`);
  }
  const known = new Set<string>([...REQUIRED, ...OPTIONAL, ...Object.keys(LEGACY_FIELDS), ...Object.keys(RETIRED_FIELDS), ...DERIVED_FIELDS]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) issues.add(k, 'unknown_field', 'known_fields_only', `${k} is not a field of ${CONTRACT}.`);
  }

  // gate_id
  issues.rely('gate_id_format');
  let gate_id: string | null = null;
  if (absent(o, 'gate_id')) issues.add('gate_id', 'missing', 'gate_id_required', 'gate_id is required.');
  else if (typeof o.gate_id !== 'string' || !o.gate_id.trim() || o.gate_id.length > 200) issues.add('gate_id', 'bad_gate_id', 'gate_id_required', 'gate_id is text.');
  else if (!CG_ID.test(o.gate_id)) issues.add('gate_id', 'gate_id_format_undefined', 'gate_id_format', `Only a charge-gate id (CG-<ms>-<4>) is recognised; no format is agreed for "${o.gate_id.slice(0, 60)}".`);
  else gate_id = o.gate_id;

  // loop_id
  let loop_id: string | null = null;
  if (absent(o, 'loop_id')) issues.add('loop_id', 'missing', 'loop_id_shape', 'loop_id is required.');
  else if (typeof o.loop_id !== 'string' || !LOOP_ID.test(o.loop_id)) issues.add('loop_id', 'bad_loop_id', 'loop_id_shape', 'loop_id is LOOP-<ms>-<4>, e.g. LOOP-1794326998165-6I62.');
  else loop_id = o.loop_id;

  const runtime_verification_status = readRuntimeStatus(o, issues);
  const closure_state = readClosure(o, issues);

  // acceptance_pass: a real boolean; true is never allowed here.
  let requested: boolean | null = null;
  if (!has(o, 'acceptance_pass') || o.acceptance_pass === null) issues.add('acceptance_pass', 'missing', 'acceptance_pass_boolean', 'acceptance_pass is required: true or false.');
  else if (typeof o.acceptance_pass !== 'boolean') issues.add('acceptance_pass', 'bad_acceptance_pass', 'acceptance_pass_boolean', 'acceptance_pass is the boolean true or false, never a string or a number.');
  else requested = o.acceptance_pass;
  if (requested === true) {
    const rvs = runtime_verification_status.value;
    if (rvs !== null && rvs !== 'runtime_proof') {
      issues.add('acceptance_pass', 'acceptance_pass_requires_runtime_proof', 'acceptance_pass_requires_runtime_proof', `acceptance_pass = true is only valid with runtime_verification_status = runtime_proof, not ${rvs}.`);
    } else if (rvs === 'runtime_proof') {
      issues.add('acceptance_pass', 'acceptance_pass_not_verifiable_here', 'acceptance_pass_conditions', 'acceptance_pass = true needs contract evidence, implementation evidence and a valid authorization or delegation. None can be verified by this check, and per-gate authority is not yet defined, so it is refused.');
    }
  }

  // actor_id: who wrote the event, a person or an automated writer (SOP b3a349df).
  issues.rely('actor_shape');
  let actor_id: string | null = null;
  if (absent(o, 'actor_id')) issues.add('actor_id', 'missing', 'actor_required', 'actor_id is required: who wrote or decided the event.');
  else if (typeof o.actor_id !== 'string' || !(SLACK_USER.test(o.actor_id) || SLACK_BOT_ID_SHAPE.test(o.actor_id))) issues.add('actor_id', 'bad_actor_id', 'actor_shape', 'actor_id is a Slack id: a person (U… or W…) or a bot (B…).');
  else actor_id = o.actor_id;

  // approver_id: required (proposed) on every record; on COMMERCIAL_OK, Jason's rule decides (approved).
  issues.rely('approver_required');
  issues.rely('approver_not_bot_id');
  const commercial = closure_state.value === 'COMMERCIAL_OK';
  let approver_id: string | null = null;
  if (absent(o, 'approver_id')) {
    if (commercial) issues.add('approver_id', 'commercial_ok_approver_missing', 'commercial_ok_requires_human_approver', 'A COMMERCIAL_OK record must carry an explicit approver_id: the human commercial authority (SOP b3a349df). Without one it is invalid, whoever the actor is.');
    else issues.add('approver_id', 'missing', 'approver_required', 'approver_id is required: the Slack id of the named person who approves.');
  } else if (typeof o.approver_id === 'string' && SLACK_BOT_ID_SHAPE.test(o.approver_id)) issues.add('approver_id', 'approver_bot_id_shape', 'approver_not_bot_id', 'approver_id has the shape of a Slack bot id (B…). This is an id-shape check only; it does not prove any id belongs to a person.');
  else if (typeof o.approver_id !== 'string' || !SLACK_USER.test(o.approver_id)) issues.add('approver_id', 'bad_approver_id', 'approver_shape', 'approver_id is a Slack user id, U… or W….');
  else approver_id = o.approver_id;
  // The approved rule holds on its own: any approver on COMMERCIAL_OK that is not Jason (or a named
  // delegate, of whom there are none) is refused, whatever the proposed shape rules above decide.
  if (commercial && !absent(o, 'approver_id') && o.approver_id !== COMMERCIAL_APPROVER && !DELEGATED_COMMERCIAL_APPROVERS.includes(String(o.approver_id))) {
    issues.add('approver_id', 'commercial_approver_not_authorized', 'commercial_ok_authority', `COMMERCIAL_OK is set only by Jason (${COMMERCIAL_APPROVER}) or a named commercial delegate; no delegation is recognised for ${String(o.approver_id).slice(0, 40)}.`);
  }

  // Linked evidence: two lists, separate records, never FS3N (SOP 8034ef06).
  const contract_evidence_refs = readEvidenceRefs(o, 'contract_evidence_refs', issues);
  const implementation_evidence_refs = readEvidenceRefs(o, 'implementation_evidence_refs', issues);
  if (contract_evidence_refs && implementation_evidence_refs) {
    for (const id of contract_evidence_refs.filter((x) => implementation_evidence_refs.includes(x))) {
      issues.add('implementation_evidence_refs', 'evidence_ref_in_both_lists', 'evidence_linked_records', `${id} is named as both contract and implementation evidence; they are separate records (SOP 8034ef06).`);
    }
  }

  // delegation_ref: optional; shape only, and never enough on its own.
  let delegation_ref: string | null = null;
  const delegation = has(o, 'delegation_ref') && o.delegation_ref !== null;
  if (delegation) {
    issues.rely('delegation_ref_shape');
    if (typeof o.delegation_ref !== 'string' || !EV_ID.test(o.delegation_ref)) issues.add('delegation_ref', 'bad_delegation_ref', 'delegation_ref_shape', 'delegation_ref is an evidence-store id, EV-<ms>-<4>.');
    else if (Object.prototype.hasOwnProperty.call(NOT_ACCEPTANCE_EVIDENCE, o.delegation_ref)) issues.add('delegation_ref', 'not_acceptance_evidence', 'not_acceptance_evidence', NOT_ACCEPTANCE_EVIDENCE[o.delegation_ref]);
    else delegation_ref = o.delegation_ref;
  }

  // decision_link: required by this design.
  issues.rely('decision_link_required');
  let decision_link: string | null = null;
  let decision: SlackLink | null = null;
  if (absent(o, 'decision_link')) issues.add('decision_link', 'missing', 'decision_link_required', 'decision_link is required: the Slack link (Copy link) of the message stating this.');
  else {
    decision = parseSlackLink(o.decision_link);
    if (!decision) issues.add('decision_link', 'bad_decision_link', 'slack_link_shape', 'decision_link is a Slack message permalink: https://<workspace>.slack.com/archives/<C…>/p<16 digits>.');
    else decision_link = (o.decision_link as string).trim();
  }

  const run_ref = has(o, 'run_ref') && o.run_ref !== null ? readRunRef(o.run_ref, issues) : null;

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
    issues.list.length === 0 && gate_id && loop_id && runtime_verification_status.value && requested !== null && actor_id && approver_id &&
    closure_state.value && contract_evidence_refs && implementation_evidence_refs && decision_link && decision
      ? {
          gate_id,
          loop_id,
          runtime_verification_status: runtime_verification_status.value as RuntimeVerificationState,
          acceptance_pass: requested,
          actor_id,
          approver_id,
          closure_state: closure_state.value as AcceptanceState,
          contract_evidence_refs,
          implementation_evidence_refs,
          delegation_ref,
          decision_link,
          decision,
          run_ref,
          proof_type,
          supersedes,
          notes,
          test,
        }
      : null;

  return result(issues, { runtime_verification_status, closure_state, normalised, acceptance_pass_requested: requested, delegation });
}

/**
 * A caller asking "may this count as accepted?" Always no, until the combinations, the per-gate
 * authority and a trusted writer exist and verify the references. Throws, naming every reason.
 */
export function requireAcceptanceEligible(input: unknown): never {
  const r = check(input);
  throw new AcceptanceEvidenceError(
    'not_acceptance_eligible',
    `Not acceptance-eligible: ${r.blocked_by.join(', ')}. A well-formed record is not an approved one.`,
    r,
  );
}
