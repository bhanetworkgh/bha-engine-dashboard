/**
 * The acceptance check: one real record run through the single canonical validator, and the result
 * written down (13 Nov 2026, Destiny — Jason's hold on CODEX-20261113-destiny-arupi-genie-cutover-
 * readback-fix: "one real production event for it, logged").
 *
 * acceptanceEvidence.ts is pure and nothing called it. This is its first caller, and it stays on the
 * safe side of SOP 3cc1ba00 and Destiny's rule of 10 Nov (nothing writes acceptance records until the
 * first loop and her go):
 *   - it runs acceptanceEvidence.check() exactly as merged, on the record as sent, never changing it;
 *   - it checks the references this database can check (the charge-gate decision, the loop, each EV)
 *     and says which it could not;
 *   - it writes ONE engine event, acceptance_evidence_checked, keyed on the record's digest, so the
 *     same record twice is one event. That event is a check result, never an acceptance decision: it
 *     is not acceptance_evidence_recorded (reserved for U0MN's trusted writer, LOOP-1794326998164-O7CU),
 *     it saves no acceptance record, and every authorizing field in it is the literal false.
 *   - it is in engineEvents.IN_PROCESS_ONLY, so nothing outside the dashboard can post one.
 */
import { createHash } from 'node:crypto';
import * as ae from './acceptanceEvidence';
import * as events from './engineEvents';
import { query } from './pg';

export const EVENT_TYPE = 'acceptance_evidence_checked';

export interface GateFact {
  gate_id: string;
  kind: string;
  verdict: string;
  test: boolean;
  decided_by: string;
  recorded_by: string | null;
  evidence_channel: string | null;
  evidence_ts: string | null;
  bundle_ref: string | null;
}
export interface LoopFact {
  natural_id: string;
  status: string | null;
  builder_id: string | null;
  assignee: string | null;
}
export interface EvidenceFact {
  evidence_id: string;
  name: string;
  test: boolean;
  gate: string | null;
  loop_id: string | null;
  superseded_by: string | null;
}
export interface Facts {
  gate: GateFact | null;
  loop: LoopFact | null;
  evidence: Record<string, EvidenceFact | undefined>;
}

export type RefResult = 'held' | 'not_held' | 'mismatch' | 'test_record' | 'not_checked';
export interface RefCheck {
  reference: string;
  result: RefResult;
  detail: string;
}

/** The references this check cannot settle from the database, said plainly rather than implied. */
export const NOT_CHECKED_HERE = Object.freeze([
  'whether each EV is really contract or implementation evidence for this gate (which list it sits in is the caller\'s reading)',
  'that Slack shows approver_id posted decision_link (the charge gate confirmed it when the decision was recorded)',
  'that approver_id is the loop owner, for LOOP_ACCEPTED',
  'per-gate authorization for acceptance_pass (no register exists yet)',
] as const);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** JSON with keys sorted at every level, so one record has one digest however its keys were ordered. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const digestOf = (record: unknown): string => createHash('sha256').update(canonical(record)).digest('hex');

/** What the database says about the record's references. Pure: the facts are read by loadFacts. */
export function referenceChecks(record: unknown, facts: Facts): RefCheck[] {
  const out: RefCheck[] = [];
  const o = isObj(record) ? record : {};
  const gateId = typeof o.gate_id === 'string' ? o.gate_id : null;
  const g = facts.gate;
  if (!gateId) out.push({ reference: 'gate_id', result: 'not_checked', detail: 'no gate_id to look up' });
  else if (!g) out.push({ reference: 'gate_id', result: 'not_held', detail: `${gateId} is not a charge-gate decision held here` });
  else {
    out.push(g.test
      ? { reference: 'gate_id', result: 'test_record', detail: `${gateId} is a test decision` }
      : { reference: 'gate_id', result: 'held', detail: `${gateId}: ${g.kind} ${g.verdict}, decided by ${g.decided_by}` });
    const link = ae.parseSlackLink(o.decision_link);
    if (!link) out.push({ reference: 'decision_link', result: 'not_checked', detail: 'decision_link is not a Slack message link' });
    else if (link.channel === g.evidence_channel && link.ts === g.evidence_ts) out.push({ reference: 'decision_link', result: 'held', detail: `the message ${gateId} was recorded on (${link.channel} ${link.ts})` });
    else out.push({ reference: 'decision_link', result: 'mismatch', detail: `${gateId} rests on ${g.evidence_channel} ${g.evidence_ts}, not ${link.channel} ${link.ts}` });
    if (typeof o.approver_id === 'string') {
      out.push(o.approver_id === g.decided_by
        ? { reference: 'approver_id', result: 'held', detail: `${o.approver_id} made the decision on ${gateId}` }
        : { reference: 'approver_id', result: 'mismatch', detail: `${gateId} was decided by ${g.decided_by}, not ${o.approver_id}` });
    }
    if (typeof o.actor_id === 'string') {
      const writers = [g.recorded_by, g.decided_by].filter(Boolean);
      out.push(writers.includes(o.actor_id)
        ? { reference: 'actor_id', result: 'held', detail: `${o.actor_id} ${o.actor_id === g.recorded_by ? 'recorded' : 'decided'} ${gateId}` }
        : { reference: 'actor_id', result: 'mismatch', detail: `${gateId} was recorded by ${g.recorded_by ?? 'nobody named'} and decided by ${g.decided_by}, not ${o.actor_id}` });
    }
  }
  const loopId = typeof o.loop_id === 'string' ? o.loop_id : null;
  if (!loopId) out.push({ reference: 'loop_id', result: 'not_checked', detail: 'no loop_id to look up' });
  else if (!facts.loop) out.push({ reference: 'loop_id', result: 'not_held', detail: `${loopId} is not a loop held here` });
  else out.push({ reference: 'loop_id', result: 'held', detail: `${loopId}: ${facts.loop.status ?? 'no status'}, ${facts.loop.builder_id ?? 'no builder'}'s table` });
  for (const list of ['contract_evidence_refs', 'implementation_evidence_refs'] as const) {
    for (const id of strList(o[list])) {
      const e = facts.evidence[id];
      if (!e) out.push({ reference: `${list}:${id}`, result: 'not_held', detail: `${id} is not in the evidence store` });
      else if (e.test) out.push({ reference: `${list}:${id}`, result: 'test_record', detail: `${id} (${e.name}) is a test record` });
      else out.push({ reference: `${list}:${id}`, result: 'held', detail: `${id} ${e.name}${e.gate ? `, gate ${e.gate}` : ''}${e.loop_id ? `, loop ${e.loop_id}` : ''}${e.superseded_by ? `; superseded by ${e.superseded_by}` : ''}` });
    }
  }
  return out;
}

/** The event's detail. Every authorizing field is the literal false, whatever the record says. */
export function eventDetail(record: unknown, result: ae.CheckResult, refs: RefCheck[], digest: string) {
  return {
    contract: result.contract,
    contract_sop: result.contract_sop,
    validator: 'server/src/acceptanceEvidence.ts check()',
    record_sha256: digest,
    record,
    structurally_valid: result.structurally_valid,
    combination: result.combination,
    runtime_verification_status: result.runtime_verification_status,
    closure_state: result.closure_state,
    acceptance_pass_requested: result.acceptance_pass_requested,
    issues: result.issues.map((i) => ({ field: i.field, code: i.code, rule: i.rule, rule_status: i.rule_status })),
    blocked_by: result.blocked_by,
    proposed_rules_applied: result.proposed_rules_applied,
    references: refs,
    references_held: refs.filter((r) => r.result === 'held').length,
    references_failed: refs.filter((r) => r.result === 'not_held' || r.result === 'mismatch' || r.result === 'test_record').length,
    not_checked_here: NOT_CHECKED_HERE,
    acceptance_pass_allowed: false as const,
    eligible_for_persistence: false as const,
    acceptance_eligible: false as const,
    authorizes: false as const,
    can_charge_live: false as const,
    acceptance_record_saved: false as const,
  };
}

export async function loadFacts(record: unknown): Promise<Facts> {
  const o = isObj(record) ? record : {};
  const facts: Facts = { gate: null, loop: null, evidence: {} };
  if (typeof o.gate_id === 'string' && ae.CG_ID.test(o.gate_id)) {
    const r = await query<GateFact>(
      `SELECT gate_id, kind, verdict, test, decided_by, recorded_by, evidence_channel, evidence_ts, bundle_ref FROM engine_charge_gate WHERE gate_id = $1`,
      [o.gate_id],
    );
    facts.gate = r.rows[0] ?? null;
  }
  if (typeof o.loop_id === 'string' && ae.LOOP_ID.test(o.loop_id)) {
    const r = await query<LoopFact>(
      `SELECT natural_id, fields->>'Status' AS status, builder_id, fields->>'Assignee Slack User ID' AS assignee
         FROM engine_loops WHERE natural_id = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
      [o.loop_id],
    );
    facts.loop = r.rows[0] ?? null;
  }
  const ids = [...strList(o.contract_evidence_refs), ...strList(o.implementation_evidence_refs)].filter((id) => ae.EV_ID.test(id)).slice(0, 40);
  if (ids.length) {
    const r = await query<EvidenceFact>(
      `SELECT e.evidence_id, e.name, e.test, e.gate, e.loop_id,
              (SELECT n.evidence_id FROM engine_evidence n WHERE n.supersedes = e.evidence_id ORDER BY n.saved_at DESC LIMIT 1) AS superseded_by
         FROM engine_evidence e WHERE e.evidence_id = ANY($1)`,
      [ids],
    );
    for (const row of r.rows) facts.evidence[row.evidence_id] = row;
  }
  return facts;
}

export interface RunResult {
  ok: true;
  dry_run: boolean;
  event_id: number | null;
  duplicate: boolean;
  record_sha256: string;
  structurally_valid: boolean;
  blocked_by: string[];
  references: RefCheck[];
  summary: string;
  detail: ReturnType<typeof eventDetail>;
}

/** One record through the validator, its references checked, and (unless a dry run) one event written. */
export async function run(opts: { record: unknown; actor: string; dry_run?: boolean }): Promise<RunResult> {
  const result = ae.check(opts.record);
  const facts = await loadFacts(opts.record);
  const refs = referenceChecks(opts.record, facts);
  const digest = digestOf(opts.record);
  const detail = eventDetail(opts.record, result, refs, digest);
  const o = isObj(opts.record) ? opts.record : {};
  const subject = (typeof o.gate_id === 'string' && o.gate_id) || (typeof o.loop_id === 'string' && o.loop_id) || `acceptance-record:${digest.slice(0, 12)}`;
  const failed = detail.references_failed;
  const summary = `${result.structurally_valid ? 'Well-formed' : `Not well-formed (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`}; ${detail.references_held} of ${refs.length} references held${failed ? `, ${failed} failed` : ''}; blocked by ${result.blocked_by.length} rule${result.blocked_by.length === 1 ? '' : 's'}; nothing authorized and no acceptance record saved.`;
  let event_id: number | null = null;
  let duplicate = false;
  if (!opts.dry_run) {
    const key = `acceptance_check:${digest}`;
    const w = await events.record({
      event_type: EVENT_TYPE,
      subject_id: subject,
      lane: 'ENGINE',
      actor: opts.actor,
      source_ref: typeof o.decision_link === 'string' ? o.decision_link : null,
      detail,
      dedupe_key: key,
    });
    if (w.recorded) event_id = w.id;
    else {
      duplicate = true;
      const r = await query<{ id: string }>(`SELECT id FROM engine_events WHERE dedupe_key = $1`, [key]);
      event_id = r.rows[0] ? Number(r.rows[0].id) : null;
    }
  }
  return { ok: true, dry_run: !!opts.dry_run, event_id, duplicate, record_sha256: digest, structurally_valid: result.structurally_valid, blocked_by: result.blocked_by, references: refs, summary, detail };
}
