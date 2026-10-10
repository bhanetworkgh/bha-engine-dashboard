/**
 * SE8L — one doctrine-gap interpretation for Monitoring, North Star and RT.
 *
 * T0NO and VRFK remain truth. This module only observes their result, emits
 * engine.event.v1 records, maps a gap to guidance and (when explicitly
 * enabled) mirrors an operational fault into the existing BHARAG incident
 * lifecycle. It owns no doctrine, publication or loop/card state.
 */
import { createHash } from 'node:crypto';
import { query } from './pg';
import * as bharag from './bharag';
import * as engineEvents from './engineEvents';
import * as publicationDecision from './publicationDecision';
import * as systemFeeds from './systemFeeds';

export const OBSERVED_EVENT = 'doctrine_gap_observed';
export const OPENED_EVENT = 'doctrine_gap_incident_opened';
export const RECOVERED_EVENT = 'doctrine_gap_recovered';
export const SCHEMA = 'doctrine.gap.observation.v1';
export const SUMMARY_SCHEMA = 'doctrine.gap.summary.v1';
export const WATCH_FLAG = 'DOCTRINE_GAP_WATCH_ENABLED';

/** Proposed by SE8L; not doctrine and not silently represented as Canon. */
export const PROPOSED_POLICY = {
  resolver_consecutive_failures: 2,
  resolver_failure_active_minutes: 5,
  repeated_needs_evidence_count: 3,
  repeated_needs_evidence_hours: 24,
  recovery_consecutive_healthy: 2,
} as const;

export const CRITICAL_FIELD_POLICY = {
  claim_state: { critical_for: ['vfarm', 'commercial'], immediate_when_attempted: true },
  config_hash: { critical_for: ['mechanical_publication', 'render'], immediate_when_attempted: true },
  cad_provenance: { critical_for: ['mechanical_publication', 'render'], immediate_when_attempted: true },
  evidence_publication_status: { critical_for: ['all_publication'], immediate_when_attempted: true },
  fail_closed: { critical_for: ['all_consumers'], immediate_when_attempted: true },
  allowed_use: { critical_for: ['all_consumers'], immediate_when_attempted: true },
} as const;

export const CONDITIONS = [
  'healthy',
  'resolver_unavailable',
  'unauthorized_read',
  'malformed_response',
  'needs_evidence',
  'missing_critical_field',
  'publication_hold',
  'publication_trace_missing',
  'stale_evidence',
  'contradictory_evidence',
  'prohibited_surface_use',
] as const;
export type DoctrineGapCondition = (typeof CONDITIONS)[number];
export type EvidenceState = 'unknown' | 'not_had' | 'failed' | 'verified';
export type Severity = 'info' | 'warning' | 'critical';

export interface DoctrineGapInput {
  surface: publicationDecision.PublicationSurface;
  claim?: publicationDecision.ResolvedClaim | null;
  publication?: publicationDecision.DecisionRead | null;
  resolver_error?: { status?: number | null; message: string } | null;
  active_consumer?: boolean;
  attempted_public_use?: boolean;
  requires_mechanical_provenance?: boolean;
  requested_use?: 'internal' | 'public' | 'render' | 'paid';
}

export interface DoctrineGapObservation {
  schema: typeof SCHEMA;
  observation_id: string;
  observed_at: string;
  recovery_key: string;
  condition: DoctrineGapCondition;
  evidence_state: EvidenceState;
  severity: Severity;
  surface: publicationDecision.PublicationSurface;
  doctrine_id: string;
  claim_id: string;
  capability_id: string | null;
  reason: string;
  owner_hint: string;
  active_consumer: boolean;
  attempted_public_use: boolean;
  requested_use: DoctrineGapInput['requested_use'];
  publication_decision: publicationDecision.PublicationDecision | null;
  t0no_fail_closed: boolean;
  config_hash_held: boolean;
  cad_provenance_held: boolean;
}

export interface DoctrineGapPolicy {
  incident: boolean;
  guidance: boolean;
  aggregate: boolean;
  recover: boolean;
  reason: string;
}

export interface DoctrineGapGuidance {
  action: 'NONE' | 'HOLD' | 'NEEDS_EVIDENCE' | 'RESTORE_SERVICE' | 'CORRECT_CONTRADICTION';
  owner: string | null;
  next_action: string | null;
  card_recommendation: 'none' | 'owner_card_if_blocking' | 'monitoring_incident';
  closure_condition: string;
}

const held = (v: unknown): boolean => typeof v === 'string' && Boolean(v.trim()) && v !== 'NOT_HELD';
const cadHeld = (c: publicationDecision.ResolvedClaim): boolean => held(c.cad_provenance?.cad_revision) && held(c.cad_provenance?.provenance_ref);
const clean = (v: string): string => v.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 220);
const digest = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 20);

function make(input: DoctrineGapInput, condition: DoctrineGapCondition, evidence_state: EvidenceState, severity: Severity, reason: string, owner: string): DoctrineGapObservation {
  const c = input.claim;
  const doctrine = c?.doctrine_id ?? 'MEDIA_DOCTRINE';
  const claim = c?.claim_id ?? 'RESOLVER';
  const recovery_key = `doctrine:${clean(input.surface)}:${clean(doctrine)}:${clean(claim)}`;
  const observed_at = new Date().toISOString();
  return {
    schema: SCHEMA,
    observation_id: `DG-${digest(`${recovery_key}:${condition}:${reason}:${observed_at}`)}`,
    observed_at,
    recovery_key,
    condition,
    evidence_state,
    severity,
    surface: input.surface,
    doctrine_id: doctrine,
    claim_id: claim,
    capability_id: null,
    reason,
    owner_hint: owner,
    active_consumer: input.active_consumer === true,
    attempted_public_use: input.attempted_public_use === true,
    requested_use: input.requested_use ?? 'internal',
    publication_decision: input.publication?.decision ?? null,
    t0no_fail_closed: c?.fail_closed?.needs_evidence === true,
    config_hash_held: Boolean(c && held(c.config_hash)),
    cad_provenance_held: Boolean(c && cadHeld(c)),
  };
}

/** Pure classification. No consumer may locally reinterpret these conditions. */
export function classify(input: DoctrineGapInput): DoctrineGapObservation {
  if (input.resolver_error) {
    const status = input.resolver_error.status ?? null;
    if (status === 401 || status === 403) return make(input, 'unauthorized_read', 'failed', 'critical', `RESOLVER_AUTH_${status}`, 'Destiny / Engine runtime');
    return make(input, 'resolver_unavailable', 'failed', 'warning', input.resolver_error.message || 'RESOLVER_UNAVAILABLE', 'Destiny / Engine runtime');
  }
  const c = input.claim;
  if (!c || !c.fail_closed || !c.allowed_use || !c.cad_provenance || !c.maturity_state || !c.claim_state || !c.evidence_publication_status)
    return make(input, 'malformed_response', 'failed', 'critical', 'MALFORMED_T0NO_RESPONSE', 'Destiny / Engine runtime');

  const mechanicalMissing = input.requires_mechanical_provenance === true && (!held(c.config_hash) || !cadHeld(c));
  if (mechanicalMissing && (input.attempted_public_use || input.requested_use === 'render' || input.requested_use === 'public'))
    return make(input, 'missing_critical_field', 'not_had', 'critical', !held(c.config_hash) ? 'MISSING_CONFIG_HASH' : 'UNRESOLVED_CAD_PROVENANCE', 'Jegan / canonical mechanical-config owner');

  if (input.requested_use === 'paid' && c.claim_state === 'interest_only_live')
    return make(input, 'prohibited_surface_use', 'verified', 'critical', 'PAID_CLAIM_BLOCKED_BY_INTEREST_ONLY_LIVE', 'Jason / commercial authority');

  if (c.fail_closed.needs_evidence || c.evidence_publication_status.toUpperCase() === 'NEEDS_EVIDENCE')
    return make(input, 'needs_evidence', 'not_had', 'warning', c.fail_closed.reason ?? 'NEEDS_EVIDENCE', c.fail_closed.reason?.includes('CAD') || c.fail_closed.reason?.includes('CONFIG') ? 'Jegan / canonical mechanical-config owner' : 'Hardik / doctrine owner');

  if (!c.allowed_use[input.surface] || c.maturity_state === 'NOT_SAFE_TO_CLAIM')
    return make(input, 'prohibited_surface_use', 'verified', input.attempted_public_use ? 'critical' : 'warning', !c.allowed_use[input.surface] ? `NOT_ALLOWED_FOR_${input.surface.toUpperCase()}` : 'NOT_SAFE_TO_CLAIM', 'Hardik / doctrine owner');

  const p = input.publication;
  if (!p) return make(input, 'publication_trace_missing', 'not_had', input.attempted_public_use ? 'critical' : 'info', 'MISSING_PUBLICATION_DECISION', 'Hardik / Media publication owner');
  if (p.reason === 'STALE_PUBLICATION_DECISION') return make(input, 'stale_evidence', 'failed', 'warning', p.reason, 'Hardik / Media publication owner');
  if (p.reason === 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO') return make(input, 'contradictory_evidence', 'failed', 'critical', p.reason, 'Hardik / Media publication owner');
  if (!p.applicable || p.decision === 'needs_evidence') return make(input, 'needs_evidence', 'not_had', 'warning', p.reason, 'Hardik / Media publication owner');
  if (p.decision === 'hold') return make(input, 'publication_hold', 'verified', 'info', p.reason, 'Hardik / Media publication owner');
  return make(input, 'healthy', 'verified', 'info', 'T0NO_AND_VRFK_CLEAR', 'NONE');
}

/** Pure threshold/recovery decision. Caller supplies same-key history oldest→newest. */
export function policyFor(current: DoctrineGapObservation, history: DoctrineGapObservation[], now = Date.now()): DoctrineGapPolicy {
  const all = [...history, current].filter((x) => x.recovery_key === current.recovery_key);
  const healthyTail = [...all].reverse().findIndex((x) => x.condition !== 'healthy');
  const healthyCount = healthyTail === -1 ? all.length : healthyTail;
  if (current.condition === 'healthy') return { incident: false, guidance: false, aggregate: false, recover: healthyCount >= PROPOSED_POLICY.recovery_consecutive_healthy, reason: healthyCount >= 2 ? 'TWO_CONSECUTIVE_HEALTHY_READS' : 'HEALTHY_CONFIRMATION_PENDING' };

  const immediate =
    current.condition === 'unauthorized_read' || current.condition === 'malformed_response' || current.condition === 'contradictory_evidence' ||
    (current.condition === 'missing_critical_field' && (current.active_consumer || current.attempted_public_use)) ||
    (current.condition === 'publication_trace_missing' && current.attempted_public_use) ||
    (current.condition === 'prohibited_surface_use' && current.attempted_public_use);
  if (immediate) return { incident: true, guidance: true, aggregate: true, recover: false, reason: 'IMMEDIATE_CRITICAL_GAP' };

  const since = now - PROPOSED_POLICY.repeated_needs_evidence_hours * 3_600_000;
  const recent = all.filter((x) => Date.parse(x.observed_at) >= since && x.condition === current.condition);
  if (current.condition === 'resolver_unavailable') {
    const firstAt = recent.length ? Date.parse(recent[0].observed_at) : now;
    const due = recent.length >= PROPOSED_POLICY.resolver_consecutive_failures || (current.active_consumer && now - firstAt >= PROPOSED_POLICY.resolver_failure_active_minutes * 60_000);
    return { incident: due, guidance: true, aggregate: true, recover: false, reason: due ? 'RESOLVER_FAILURE_THRESHOLD_MET' : 'FIRST_RESOLVER_FAILURE' };
  }
  if (current.condition === 'needs_evidence' || current.condition === 'stale_evidence') {
    const due = current.active_consumer && recent.length >= PROPOSED_POLICY.repeated_needs_evidence_count;
    return { incident: due, guidance: true, aggregate: true, recover: false, reason: due ? `REPEATED_${current.condition.toUpperCase()}_THRESHOLD_MET` : 'OBSERVE_AND_GUIDE' };
  }
  return { incident: false, guidance: true, aggregate: true, recover: false, reason: 'GUIDANCE_ONLY' };
}

export function guidanceFor(o: DoctrineGapObservation): DoctrineGapGuidance {
  if (o.condition === 'healthy') return { action: 'NONE', owner: null, next_action: null, card_recommendation: 'none', closure_condition: 'Evidence remains verified.' };
  if (o.condition === 'resolver_unavailable' || o.condition === 'unauthorized_read' || o.condition === 'malformed_response')
    return { action: 'RESTORE_SERVICE', owner: 'Destiny / Engine runtime', next_action: 'Restore the canonical resolver/read authorization and prove one valid T0NO read.', card_recommendation: 'monitoring_incident', closure_condition: 'Two consecutive healthy canonical reads.' };
  if (o.condition === 'contradictory_evidence')
    return { action: 'CORRECT_CONTRADICTION', owner: o.owner_hint, next_action: 'Reconcile the persisted VRFK trace with current T0NO; do not publish meanwhile.', card_recommendation: 'monitoring_incident', closure_condition: 'A current applicable VRFK decision plus two healthy reads.' };
  if (o.condition === 'publication_hold' || o.condition === 'prohibited_surface_use')
    return { action: 'HOLD', owner: o.owner_hint, next_action: 'Keep the affected surface held; obtain owner-approved doctrine/evidence before any new decision.', card_recommendation: 'owner_card_if_blocking', closure_condition: 'Canonical doctrine and applicable VRFK decision permit the requested use.' };
  const mechanical = o.reason.includes('CONFIG') || o.reason.includes('CAD');
  return { action: 'NEEDS_EVIDENCE', owner: o.owner_hint, next_action: mechanical ? 'Obtain canonical config_hash/CAD provenance readback from the mechanical authority.' : 'Supply the named evidence and record an applicable VRFK decision.', card_recommendation: 'owner_card_if_blocking', closure_condition: 'The named evidence is held canonically and two healthy reads follow.' };
}

export function observationEvent(o: DoctrineGapObservation) {
  return { event_type: OBSERVED_EVENT, at: o.observed_at, subject_id: o.recovery_key, lane: 'MEDIA', actor: 'doctrine-gap-monitor', source_ref: 'LOOP-1791557096370-SE8L', detail: { ...o, guidance: guidanceFor(o) }, dedupe_key: `${OBSERVED_EVENT}:${o.observation_id}` };
}

export function aggregateObservations(rows: DoctrineGapObservation[]) {
  const grouped = new Map<string, { recovery_key: string; condition: DoctrineGapCondition; surface: string; doctrine_id: string; claim_id: string; count: number; first_at: string; last_at: string; evidence_state: EvidenceState; owner: string; unresolved: boolean }>();
  for (const o of rows) {
    const key = `${o.recovery_key}:${o.condition}`;
    const g = grouped.get(key);
    if (g) { g.count++; if (o.observed_at < g.first_at) g.first_at = o.observed_at; if (o.observed_at > g.last_at) g.last_at = o.observed_at; }
    else grouped.set(key, { recovery_key: o.recovery_key, condition: o.condition, surface: o.surface, doctrine_id: o.doctrine_id, claim_id: o.claim_id, count: 1, first_at: o.observed_at, last_at: o.observed_at, evidence_state: o.evidence_state, owner: o.owner_hint, unresolved: o.condition !== 'healthy' });
  }
  return [...grouped.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
}

type EventRow = { event_type: string; at: string; detail: DoctrineGapObservation & { ledger_id?: string } };
async function history(recoveryKey: string, hours = 24): Promise<DoctrineGapObservation[]> {
  const r = await query<EventRow>(`SELECT event_type, at, detail FROM engine_events WHERE event_type = $1 AND detail->>'recovery_key' = $2 AND at >= now() - ($3::text || ' hours')::interval ORDER BY at, id`, [OBSERVED_EVENT, recoveryKey, String(hours)]);
  return r.rows.map((x) => x.detail);
}

async function latestMarker(recoveryKey: string): Promise<EventRow | null> {
  const r = await query<EventRow>(`SELECT event_type, at, detail FROM engine_events WHERE event_type IN ($1, $2) AND detail->>'recovery_key' = $3 ORDER BY at DESC, id DESC LIMIT 1`, [OPENED_EVENT, RECOVERED_EVENT, recoveryKey]);
  return r.rows[0] ?? null;
}

function incidentBody(o: DoctrineGapObservation) {
  return {
    type: 'INC' as const,
    subsystem: 'DOCTRINE', source: 'bays', severity: o.severity,
    summary: `Doctrine gap / ${o.surface} / ${o.doctrine_id}:${o.claim_id}: ${o.reason}`.slice(0, 200),
    payload: {
      lane: 'bays', workflow_or_scenario: 'T0NO doctrine-gap monitor', failed_node_or_component: `${o.surface} / ${o.doctrine_id}:${o.claim_id}`,
      error_class: o.condition.toUpperCase(), error_message: `${o.reason}. Evidence=${o.evidence_state}. ${guidanceFor(o).next_action ?? ''}`.slice(0, 1000), error_message_original_bytes: null,
      execution_id: o.recovery_key, impact_tags: ['media', 'doctrine', o.surface], retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
      self_healing_strategy: 'The doctrine-gap monitor closes only after two consecutive healthy canonical reads. It never changes doctrine, publication state, cards or loops.', research_needed: true, research_id: null,
      commercial_hint: o.requested_use === 'paid' ? 'Commercial/public claim remains blocked.' : null, resolved_at: null, resolved_by: null,
    },
  };
}

/** Record one observation and synchronize only the existing BHARAG lifecycle. */
export async function observe(input: DoctrineGapInput) {
  const o = classify(input);
  const before = await history(o.recovery_key);
  await engineEvents.record(observationEvent(o));
  const policy = policyFor(o, before);
  const marker = await latestMarker(o.recovery_key);
  const openMarker = marker?.event_type === OPENED_EVENT ? marker : null;
  let incident: { action: string; ledger_id: string | null; error: string | null } = { action: 'none', ledger_id: null, error: null };
  try {
    if (policy.incident && !openMarker) {
      const live = await bharag.liveIncidents('bays');
      const existing = live.find((x) => x.payload?.execution_id === o.recovery_key);
      const ledger_id = existing?.entity_id ?? (await bharag.openIncident('bays', incidentBody(o))).id;
      await engineEvents.record({ event_type: OPENED_EVENT, at: o.observed_at, subject_id: o.recovery_key, lane: 'MEDIA', actor: 'doctrine-gap-monitor', source_ref: 'LOOP-1791557096370-SE8L', detail: { ...o, ledger_id, policy_reason: policy.reason }, dedupe_key: `${OPENED_EVENT}:${o.recovery_key}:${ledger_id}` });
      incident = { action: existing ? 'linked_existing' : 'opened', ledger_id, error: null };
    } else if (policy.recover && openMarker?.detail.ledger_id) {
      const ledger_id = openMarker.detail.ledger_id;
      await bharag.markRetrying('bays', ledger_id);
      await bharag.closeIncident('bays', ledger_id, 'doctrine-gap-monitor', o.observed_at, 'self_healed');
      await engineEvents.record({ event_type: RECOVERED_EVENT, at: o.observed_at, subject_id: o.recovery_key, lane: 'MEDIA', actor: 'doctrine-gap-monitor', source_ref: 'LOOP-1791557096370-SE8L', detail: { ...o, ledger_id, policy_reason: policy.reason }, dedupe_key: `${RECOVERED_EVENT}:${o.recovery_key}:${ledger_id}:${o.observation_id}` });
      incident = { action: 'closed_after_two_healthy_reads', ledger_id, error: null };
    }
  } catch (e) {
    incident.error = e instanceof Error ? e.message : String(e);
  }
  return { observation: o, policy, guidance: guidanceFor(o), incident };
}

export async function summary(hours = 24) {
  const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  const r = await query<EventRow>(`SELECT event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, detail FROM engine_events WHERE event_type = $1 AND at >= now() - ($2::text || ' hours')::interval ORDER BY at DESC, id DESC LIMIT 2000`, [OBSERVED_EVENT, String(safeHours)]);
  const observations = r.rows.map((x) => x.detail);
  return { schema: SUMMARY_SCHEMA, read_at: new Date().toISOString(), window_hours: safeHours, policy: { status: 'PROPOSED', ...PROPOSED_POLICY }, counts: { observations: observations.length, groups: aggregateObservations(observations).length }, groups: aggregateObservations(observations) };
}

export async function sweepCanonical() {
  const results: unknown[] = [];
  try {
    const doctrine = await systemFeeds.doctrineClaims({});
    for (const surface of publicationDecision.SURFACES) {
      const publications = await publicationDecision.readDecisions(doctrine.claims as publicationDecision.ResolvedClaim[], surface);
      for (let i = 0; i < doctrine.claims.length; i++) {
        const claim = doctrine.claims[i] as publicationDecision.ResolvedClaim;
        results.push(await observe({ surface, claim, publication: publications.decisions[i] ?? null, active_consumer: claim.allowed_use[surface], attempted_public_use: false, requires_mechanical_provenance: false, requested_use: 'internal' }));
      }
    }
  } catch (e) {
    results.push(await observe({ surface: 'genie_ns', resolver_error: { message: e instanceof Error ? e.message : String(e) }, active_consumer: true }));
  }
  return results;
}

export function startWatching() {
  if (process.env[WATCH_FLAG]?.trim().toLowerCase() !== 'true') {
    console.log(`  doctrine gaps: watcher OFF — ${WATCH_FLAG} is not true; read/classifier paths remain available`);
    return;
  }
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    sweepCanonical().catch((e) => console.error(`[doctrine-gap] sweep failed: ${(e as Error).message}`)).finally(() => { busy = false; });
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
