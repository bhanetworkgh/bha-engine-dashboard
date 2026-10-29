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
import * as doctrineEpisodes from './doctrineEpisodes';
import * as engineEvents from './engineEvents';
import * as events from './events';
import * as mirror from './mirror';
import * as publicationDecision from './publicationDecision';
import * as systemFeeds from './systemFeeds';

export const OBSERVED_EVENT = 'doctrine_gap_observed';
export const OPENED_EVENT = 'doctrine_gap_incident_opened';
export const RECOVERED_EVENT = 'doctrine_gap_recovered';
export const SCHEMA = 'doctrine.gap.observation.v1';
export const SUMMARY_SCHEMA = 'doctrine.gap.summary.v1';
export const WATCH_FLAG = 'DOCTRINE_GAP_WATCH_ENABLED';
/** The surface a resolver failure, and its recovery, is filed under; with no claim, make() keys it MEDIA_DOCTRINE:RESOLVER. */
export const RESOLVER_SURFACE: publicationDecision.PublicationSurface = 'genie_ns';

/** Proposed by SE8L; not doctrine and not silently represented as Canon. */
export const PROPOSED_POLICY = {
  resolver_consecutive_failures: 2,
  resolver_failure_active_minutes: 5,
  resolver_failure_window_hours: 24,
  recovery_consecutive_healthy: 2,
} as const;

/**
 * SE8L escalation of needs_evidence / stale_evidence to Research Twin (SOP 192331ee, Jason, 27 Oct
 * 2026): a verified active consumer, at least one real hit on the gap, and the gap present for 7
 * consecutive days, then one job per doctrine key through researchSignals.open() (T4). It never opens
 * an incident: those two conditions are research questions, not operational faults (SOP dc89a498).
 */
export const RESEARCH_RULE = { min_gap_days: 7, min_real_hits: 1, source: 'SOP 192331ee (Jason, 27 Oct 2026)' } as const;

/**
 * How continuity is judged. 30 minutes is APPROVED FOR PRODUCTION (Jason, 28 Oct 2026, SE8L/YEAO thread
 * C0AF7AGC2UV 1793217396.662699; SOP 113b5b86): the initial production continuity threshold, to be
 * tightened once live behaviour is seen. A gap between two confirmations longer than this ends the
 * episode, and the time it covers never counts towards the seven days. Changing it is a new decision
 * from Jason and a BUILD_LOG line.
 */
export const CONTINUITY = { max_confirmation_gap_minutes: 30, clock_skew_seconds: 60, status: 'APPROVED_FOR_PRODUCTION', source: 'Jason, 28 Oct 2026 (SOP 113b5b86)' } as const;

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
  /** The canonical read answered, with this many claims. A fact about the resolver only, never about doctrine or a claim. */
  resolver_ok?: { claims: number } | null;
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
  /** Which read said evidence is missing or stale: the claim itself (T0NO) or one surface's publication decision (VRFK). New field, never a rename. */
  gap_source?: 't0no' | 'publication';
  /** The sweep this reading belongs to (engine_doctrine_gap_sweeps.seq): its identity across a crash, a retry and a takeover. */
  sweep_seq?: number;
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
  // Healthy here means the resolver answered: the claim is dropped so the key is the resolver's, and
  // a read that returned no claims says so rather than reading as doctrine in good order.
  if (input.resolver_ok)
    return make({ ...input, claim: null }, 'healthy', 'verified', 'info', input.resolver_ok.claims > 0 ? 'RESOLVER_READ_OK' : 'RESOLVER_READ_OK_NO_CLAIMS', 'NONE');
  const c = input.claim;
  if (!c || !c.fail_closed || !c.allowed_use || !c.cad_provenance || !c.maturity_state || !c.claim_state || !c.evidence_publication_status)
    return make(input, 'malformed_response', 'failed', 'critical', 'MALFORMED_T0NO_RESPONSE', 'Destiny / Engine runtime');

  const mechanicalMissing = input.requires_mechanical_provenance === true && (!held(c.config_hash) || !cadHeld(c));
  if (mechanicalMissing && (input.attempted_public_use || input.requested_use === 'render' || input.requested_use === 'public'))
    return make(input, 'missing_critical_field', 'not_had', 'critical', !held(c.config_hash) ? 'MISSING_CONFIG_HASH' : 'UNRESOLVED_CAD_PROVENANCE', 'Jegan / canonical mechanical-config owner');

  if (input.requested_use === 'paid' && c.claim_state === 'interest_only_live')
    return make(input, 'prohibited_surface_use', 'verified', 'critical', 'PAID_CLAIM_BLOCKED_BY_INTEREST_ONLY_LIVE', 'Jason / commercial authority');

  if (c.fail_closed.needs_evidence || c.evidence_publication_status.toUpperCase() === 'NEEDS_EVIDENCE')
    return { ...make(input, 'needs_evidence', 'not_had', 'warning', c.fail_closed.reason ?? 'NEEDS_EVIDENCE', c.fail_closed.reason?.includes('CAD') || c.fail_closed.reason?.includes('CONFIG') ? 'Jegan / canonical mechanical-config owner' : 'Hardik / doctrine owner'), gap_source: 't0no' };

  if (!c.allowed_use[input.surface] || c.maturity_state === 'NOT_SAFE_TO_CLAIM')
    return make(input, 'prohibited_surface_use', 'verified', input.attempted_public_use ? 'critical' : 'warning', !c.allowed_use[input.surface] ? `NOT_ALLOWED_FOR_${input.surface.toUpperCase()}` : 'NOT_SAFE_TO_CLAIM', 'Hardik / doctrine owner');

  const p = input.publication;
  if (!p) return make(input, 'publication_trace_missing', 'not_had', input.attempted_public_use ? 'critical' : 'info', 'MISSING_PUBLICATION_DECISION', 'Hardik / Media publication owner');
  if (p.reason === 'STALE_PUBLICATION_DECISION') return { ...make(input, 'stale_evidence', 'failed', 'warning', p.reason, 'Hardik / Media publication owner'), gap_source: 'publication' };
  if (p.reason === 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO') return make(input, 'contradictory_evidence', 'failed', 'critical', p.reason, 'Hardik / Media publication owner');
  if (!p.applicable || p.decision === 'needs_evidence') return { ...make(input, 'needs_evidence', 'not_had', 'warning', p.reason, 'Hardik / Media publication owner'), gap_source: 'publication' };
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

  const since = now - PROPOSED_POLICY.resolver_failure_window_hours * 3_600_000;
  const recent = all.filter((x) => Date.parse(x.observed_at) >= since && x.condition === current.condition);
  if (current.condition === 'resolver_unavailable') {
    const firstAt = recent.length ? Date.parse(recent[0].observed_at) : now;
    const due = recent.length >= PROPOSED_POLICY.resolver_consecutive_failures || (current.active_consumer && now - firstAt >= PROPOSED_POLICY.resolver_failure_active_minutes * 60_000);
    return { incident: due, guidance: true, aggregate: true, recover: false, reason: due ? 'RESOLVER_FAILURE_THRESHOLD_MET' : 'FIRST_RESOLVER_FAILURE' };
  }
  // A missing or stale piece of evidence is a research question, never an incident (SOP dc89a498 and
  // 192331ee, 27 Oct 2026): it reaches Research Twin through its episode (eligibleForResearch), only.
  if (current.condition === 'needs_evidence' || current.condition === 'stale_evidence')
    return { incident: false, guidance: true, aggregate: true, recover: false, reason: 'RESEARCH_EPISODE_ONLY' };
  return { incident: false, guidance: true, aggregate: true, recover: false, reason: 'GUIDANCE_ONLY' };
}

/**
 * Write only on a change of state (Jason's third condition before the watcher may go ON, 16 and
 * 20 Oct 2026; LOOP-1792472755186-M4CV). Every sweep reads every claim on every surface, and writing
 * each reading made about 12,000 identical rows a day for 14 claims. A reading is written when it is
 * the first for its key, or any state field differs from the last one written, and otherwise only
 * under the three exceptions Jason listed (SOP 9daadbc3, 27 Oct 2026):
 *   - alarm_recovery: an alarm is open on its key and the reading is healthy. That reading moves the
 *     alarm towards its close (two healthy reads in a row), so it is part of the alarm's evolution.
 *     An identical unhealthy reading while the alarm is open is not written.
 *   - counting: a resolver failure, because "2 failures within 24 hours" cannot be read back from
 *     state changes alone. Tagged write_reason counting, never an incident, and keyed on its sweep's
 *     seq, so a replay or a takeover of the same sweep cannot count it twice.
 *   - incident_restatement: not decided here. Only an open incident is restated, at most once in any
 *     rolling 24 hours, by the alarm row (doctrineEpisodes.takeRestatement), carrying its ledger id.
 * Until 27 Oct an open alarm wrote every reading (alarm_open), an incident action wrote its reading
 * (acting) and every key was restated daily (daily_restatement). Those names stay in WriteReason
 * because stored rows carry them; nothing writes them now.
 */
export const WRITE_RULE = { status: 'state_change_only', restate_hours: 24, restate: 'open_incident_only_rolling_24h', exceptions: ['alarm_recovery', 'counting', 'incident_restatement'] } as const;
export const STATE_FIELDS = ['condition', 'reason', 'evidence_state', 'severity', 'publication_decision', 't0no_fail_closed', 'config_hash_held', 'cad_provenance_held', 'active_consumer', 'attempted_public_use', 'requested_use'] as const;
export type WriteReason = 'first' | 'changed' | 'alarm_recovery' | 'counting' | 'incident_restatement' | 'alarm_open' | 'acting' | 'daily_restatement';
export interface WriteDecision { write: boolean; reason: WriteReason | 'unchanged'; changed: string[] }

/** Pure: which state fields differ between two readings of one key. */
export function changedFields(a: DoctrineGapObservation, b: DoctrineGapObservation): string[] {
  return STATE_FIELDS.filter((f) => (a[f] ?? null) !== (b[f] ?? null));
}

/** Pure: whether this reading is written. `last` is the newest one written for the key, at any age. */
export function writeDecision(current: DoctrineGapObservation, last: DoctrineGapObservation | null, ctx: { alarmOpen: boolean; policy: DoctrineGapPolicy; now?: number }): WriteDecision {
  if (!last) return { write: true, reason: 'first', changed: [] };
  const changed = changedFields(current, last);
  if (changed.length) return { write: true, reason: 'changed', changed };
  if (ctx.alarmOpen) return current.condition === 'healthy' ? { write: true, reason: 'alarm_recovery', changed } : { write: false, reason: 'unchanged', changed };
  if (current.condition === 'resolver_unavailable') return { write: true, reason: 'counting', changed };
  return { write: false, reason: 'unchanged', changed };
}

/**
 * Pure: the Research Twin question a gap is, or null when it is not one. needs_evidence from T0NO is
 * a fact about the claim, the same on every surface, so the surfaces share one key and one job.
 * needs_evidence and stale_evidence from a publication decision are per surface: nothing in that
 * decision says two surfaces lack the same thing. The drill doctrine and every operational condition
 * (resolver, malformed, unauthorized, contradiction) are never research.
 */
export function researchKeyFor(o: Pick<DoctrineGapObservation, 'condition' | 'doctrine_id' | 'claim_id' | 'surface' | 'gap_source'>): string | null {
  if (o.doctrine_id === DRILL_DOCTRINE_ID) return null;
  const base = `doctrine-gap:${clean(o.doctrine_id)}:${clean(o.claim_id)}`;
  if (o.condition === 'needs_evidence') return o.gap_source === 't0no' ? `${base}:t0no_needs_evidence` : o.gap_source === 'publication' ? `${base}:publication_needs_evidence:${clean(o.surface)}` : null;
  if (o.condition === 'stale_evidence') return o.gap_source === 'publication' ? `${base}:stale_evidence:${clean(o.surface)}` : null;
  return null;
}

export interface EpisodeRow {
  episode_id: string;
  recovery_key: string;
  research_key: string;
  condition: string;
  first_sweep_seq: number;
  last_sweep_seq: number;
  started_at: string;
  last_confirmed_at: string;
  confirmations: number;
  continuity: 'verified' | 'unverified';
  ended_at: string | null;
  end_reason: string | null;
}
export type EpisodeEnd = 'recovered' | 'condition_changed' | 'continuity_broken' | 'clock_doubt';
export type EpisodeStep =
  | { action: 'none' }
  | { action: 'replay'; reason: string }
  | { action: 'confirm'; episode_id: string; at: string }
  | { action: 'start'; research_key: string; at: string; continuity: 'verified' | 'unverified'; note: string | null }
  | { action: 'end'; episode_id: string; reason: EpisodeEnd; at: string }
  | { action: 'end_then_start'; episode_id: string; reason: EpisodeEnd; at: string; research_key: string; continuity: 'verified' | 'unverified'; note: string | null };

/**
 * Pure: what one reading does to its key's episode. `open` is the key's open episode, `maxSeq` the
 * highest sweep seq any episode of the key has seen, and `sweep.at` the database's clock when the
 * sweep began, the only clock used. A seq not above maxSeq is a replay and changes nothing, so a
 * retried or taken-over sweep cannot confirm a key twice or reopen one it already ended.
 */
export function episodeStep(open: EpisodeRow | null, maxSeq: number | null, researchKey: string | null, sweep: { seq: number; at: string; db_now: string }): EpisodeStep {
  if (maxSeq !== null && sweep.seq <= maxSeq) return { action: 'replay', reason: `sweep ${sweep.seq} is not after ${maxSeq}, already applied to this key` };
  const at = sweep.at;
  const t = Date.parse(at);
  const dbNow = Date.parse(sweep.db_now);
  const clockDoubt = !Number.isFinite(t) || !Number.isFinite(dbNow) || t > dbNow + CONTINUITY.clock_skew_seconds * 1000 || (open !== null && t < Date.parse(open.last_confirmed_at));
  const fresh = (reason: EpisodeEnd | null): { continuity: 'verified' | 'unverified'; note: string | null } =>
    clockDoubt ? { continuity: 'unverified', note: 'the sweep time was not after the last confirmation, or was ahead of the database clock; this episode can never count towards the seven days' } : { continuity: 'verified', note: reason ? `started after the previous episode ended ${reason}` : null };
  if (!open) return researchKey ? { action: 'start', research_key: researchKey, at, ...fresh(null) } : { action: 'none' };
  if (!researchKey) return { action: 'end', episode_id: open.episode_id, reason: 'recovered', at };
  const reason: EpisodeEnd | null =
    researchKey !== open.research_key ? 'condition_changed' : clockDoubt ? 'clock_doubt' : t - Date.parse(open.last_confirmed_at) > CONTINUITY.max_confirmation_gap_minutes * 60_000 ? 'continuity_broken' : null;
  if (reason) return { action: 'end_then_start', episode_id: open.episode_id, reason, at, research_key: researchKey, ...fresh(reason) };
  return { action: 'confirm', episode_id: open.episode_id, at };
}

/** What the consumer-use reader found for one doctrine key. */
export type ConsumerEvidence =
  | { ok: true; verified_consumer: boolean; consumer: string | null; real_hits: number; hit_refs: string[]; note: string | null }
  | { ok: false; error: string };
export type EligibilityRefusal =
  | 'episode_ended'
  | 'continuity_unverified'
  | 'gap_age_under_7_days'
  | 'consumer_evidence_unreadable'
  | 'no_verified_consumer'
  | 'no_real_hit';

/**
 * Pure: whether an episode may open one Research Twin job (SOP 192331ee). Every condition is checked
 * and every one that fails is named, so a refusal says all of what is missing, not the first thing.
 * Continuity is unverified when the episode was started on a doubtful clock, or when nothing has
 * confirmed it for longer than CONTINUITY allows (the watcher stopped, the resolver failed): the
 * seven days are only counted while somebody was looking.
 */
export function eligibleForResearch(ep: EpisodeRow, ev: ConsumerEvidence, now: number): { eligible: boolean; refusals: EligibilityRefusal[]; gap_age_days: number | null } {
  const refusals: EligibilityRefusal[] = [];
  const started = Date.parse(ep.started_at);
  const confirmed = Date.parse(ep.last_confirmed_at);
  if (ep.ended_at) refusals.push('episode_ended');
  if (ep.continuity !== 'verified' || !Number.isFinite(started) || !Number.isFinite(confirmed) || now - confirmed > CONTINUITY.max_confirmation_gap_minutes * 60_000 || confirmed < started)
    refusals.push('continuity_unverified');
  const age = Number.isFinite(started) ? (Math.min(now, Number.isFinite(confirmed) ? confirmed : now) - started) / 86_400_000 : null;
  if (age === null || age < RESEARCH_RULE.min_gap_days) refusals.push('gap_age_under_7_days');
  if (!ev.ok) refusals.push('consumer_evidence_unreadable');
  else {
    if (!ev.verified_consumer) refusals.push('no_verified_consumer');
    if (ev.real_hits < RESEARCH_RULE.min_real_hits) refusals.push('no_real_hit');
  }
  return { eligible: refusals.length === 0, refusals, gap_age_days: age === null ? null : Math.floor(age * 100) / 100 };
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

/** The newest observation written for a key, at any age: what a new reading is compared with. */
async function lastObservation(recoveryKey: string): Promise<DoctrineGapObservation | null> {
  const r = await query<EventRow>(`SELECT event_type, at, detail FROM engine_events WHERE event_type = $1 AND detail->>'recovery_key' = $2 ORDER BY at DESC, id DESC LIMIT 1`, [OBSERVED_EVENT, recoveryKey]);
  return r.rows[0]?.detail ?? null;
}

async function latestMarker(recoveryKey: string): Promise<EventRow | null> {
  const r = await query<EventRow>(`SELECT event_type, at, detail FROM engine_events WHERE event_type IN ($1, $2) AND detail->>'recovery_key' = $3 ORDER BY at DESC, id DESC LIMIT 1`, [OPENED_EVENT, RECOVERED_EVENT, recoveryKey]);
  return r.rows[0] ?? null;
}

/**
 * The QNDM drill's doctrine (2026-10-20, Jason's approval in the M4CV thread; doctrineDrill.ts).
 * An incident it opens is tagged `drill` and asks for no research, so the drill never opens a
 * real Research Twin job (T4 reads research_needed). It is still a DOCTRINE incident everywhere
 * else: Logstream records it and leaves it out of its counts, and the drill marks it a test.
 */
export const DRILL_DOCTRINE_ID = 'QNDM-DRILL';

function incidentBody(o: DoctrineGapObservation) {
  const drill = o.doctrine_id === DRILL_DOCTRINE_ID;
  return {
    type: 'INC' as const,
    subsystem: 'DOCTRINE', source: 'bays', severity: o.severity,
    summary: `Doctrine gap / ${o.surface} / ${o.doctrine_id}:${o.claim_id}: ${o.reason}`.slice(0, 200),
    payload: {
      lane: 'bays', workflow_or_scenario: 'T0NO doctrine-gap monitor', failed_node_or_component: `${o.surface} / ${o.doctrine_id}:${o.claim_id}`,
      error_class: o.condition.toUpperCase(), error_message: `${o.reason}. Evidence=${o.evidence_state}. ${guidanceFor(o).next_action ?? ''}`.slice(0, 1000), error_message_original_bytes: null,
      execution_id: o.recovery_key, impact_tags: drill ? ['media', 'doctrine', o.surface, 'drill'] : ['media', 'doctrine', o.surface], retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
      // Every doctrine incident is operational (SOP dc89a498, 27 Oct 2026): a resolver outage, a refused or
      // malformed read, a contradiction. None asks T4 for research; a research question reaches Research
      // Twin only through its episode and researchSignals.detectDoctrineGaps. Until 27 Oct this was !drill.
      self_healing_strategy: 'The doctrine-gap monitor closes only after two consecutive healthy canonical reads. It never changes doctrine, publication state, cards or loops.', research_needed: false, research_id: null,
      commercial_hint: o.requested_use === 'paid' ? 'Commercial/public claim remains blocked.' : null, resolved_at: null, resolved_by: null,
    },
  };
}

/**
 * Engine health's copy of a doctrine-gap incident (2026-10-20, found by the QNDM drill). Engine health
 * reads the ledger every three minutes and only what is open at that moment, so the drill's incident,
 * open for under a minute, was in the ledger and on no page. The Monitoring Twin met the same gap on
 * 4 Oct and copies its incidents at open and close (monitoringTwin.copyToHealth); this is the same
 * copy, through the same mirror.upsert the ledger poll uses, so Engine health and Logstream hold every
 * doctrine incident under its ledger id. Never throws: a copy that fails is logged, and the poll still
 * catches any incident open long enough to be read.
 */
async function copyToHealth(o: DoctrineGapObservation, ledgerId: string, raw: unknown): Promise<void> {
  try {
    const res = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const inc = (res.incident && typeof res.incident === 'object' ? res.incident : res) as Record<string, unknown>;
    const fields = { ...incidentBody(o), resolution_status: 'open', created_at: o.observed_at, ...inc, entity_id: ledgerId };
    await mirror.upsert('incidents', { fields, lane_id: 'bays' }, 'engine');
    await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $2 WHERE natural_id = $1`, [ledgerId, new Date().toISOString()]);
    events.changed('incidents');
  } catch (e) {
    console.error(`[doctrine-gap] Engine health copy of ${ledgerId} (${o.recovery_key}) was not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function closeOnHealth(ledgerId: string, at: string): Promise<void> {
  try {
    await query(
      `UPDATE engine_incidents SET open_now = false, resolved_at = COALESCE(resolved_at, $2), resolved_by = COALESCE(resolved_by, $3) WHERE natural_id = $1`,
      [ledgerId, at, 'doctrine-gap-monitor (two healthy reads)'],
    );
    events.changed('incidents');
  } catch (e) {
    console.error(`[doctrine-gap] Engine health copy of ${ledgerId} was not marked closed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Whether an incident is open on this key, and its ledger id. The alarm row (migration 102) answers
 * where it exists; a key whose incident was opened before 27 Oct has only the OPENED / RECOVERED
 * markers, so they answer for it.
 */
async function openAlarm(recoveryKey: string): Promise<{ open: boolean; ledger_id: string | null; tracked: boolean }> {
  const alarm = await doctrineEpisodes.readAlarm(recoveryKey);
  if (alarm) return { open: alarm.state === 'open', ledger_id: alarm.ledger_id, tracked: true };
  const marker = await latestMarker(recoveryKey);
  return marker?.event_type === OPENED_EVENT ? { open: true, ledger_id: marker.detail.ledger_id ?? null, tracked: false } : { open: false, ledger_id: null, tracked: false };
}

function restatementEvent(o: DoctrineGapObservation, slot: { ledger_id: string; n: number }) {
  const r = { ...o, observation_id: `DG-${digest(`restate:${slot.ledger_id}:${slot.n}`)}`, write_reason: 'incident_restatement' as WriteReason, ledger_id: slot.ledger_id, restatement: slot.n };
  return { ...observationEvent(r), dedupe_key: `${OBSERVED_EVENT}:restate:${slot.ledger_id}:${slot.n}` };
}

/**
 * Record one reading of one key inside its sweep, and synchronize only the existing BHARAG lifecycle.
 *
 * The reading's identity is its key and its sweep's seq, never its time, so the same reading replayed
 * (a retry, a sweep taken over after a crash) is the same event and the same episode step, and
 * changes nothing the second time. The event, the episode step and any restatement are one fenced
 * transaction. An incident open or close is decided outside it but only reaches BHARAG after a fenced
 * claim, so a worker that has lost its sweep never calls out. A FencedError is thrown, not caught:
 * the sweep that gets it stops.
 */
export async function observe(input: DoctrineGapInput, sweep: doctrineEpisodes.Sweep) {
  const classified = classify(input);
  const base: DoctrineGapObservation = { ...classified, sweep_seq: sweep.seq, observation_id: `DG-${digest(`${classified.recovery_key}:${sweep.seq}`)}` };
  const before = await history(base.recovery_key);
  const policy = policyFor(base, before);
  const alarm = await openAlarm(base.recovery_key);
  const write = writeDecision(base, await lastObservation(base.recovery_key), { alarmOpen: alarm.open, policy });
  // write_reason is a new field on the stored observation, never a rename; a reading not written keeps none.
  const o: DoctrineGapObservation & { write_reason?: WriteReason } = write.write ? { ...base, write_reason: write.reason as WriteReason } : base;
  const researchKey = researchKeyFor(o);

  const stored = await doctrineEpisodes.fenced(sweep, async (db, dbNow) => {
    const recorded = write.write ? (await engineEvents.record(observationEvent(o), db)).recorded : false;
    const ep = await doctrineEpisodes.readEpisode(db, o.recovery_key);
    const step = episodeStep(ep.open, ep.maxSeq, researchKey, { seq: sweep.seq, at: sweep.at, db_now: dbNow });
    const applied = await doctrineEpisodes.applyEpisode(db, step, o, sweep.seq);
    let restated: { ledger_id: string; n: number } | null = null;
    if (alarm.open && alarm.tracked && !write.write) {
      restated = await doctrineEpisodes.takeRestatement(db, o.recovery_key);
      if (restated) await engineEvents.record(restatementEvent(o, restated), db);
    }
    return { recorded, step: step.action, episode_id: applied.episode_id, episode_changed: applied.changed, restated };
  });

  let incident: { action: string; ledger_id: string | null; error: string | null } = { action: 'none', ledger_id: null, error: null };
  if (policy.incident && !alarm.open) {
    // The claim is fenced and one-winner; only its winner reaches BHARAG.
    const token = await doctrineEpisodes.fenced(sweep, (db) => doctrineEpisodes.claimAlarmOpen(db, o.recovery_key));
    if (!token) incident = { action: 'claimed_elsewhere', ledger_id: null, error: null };
    else {
      let ledger_id: string | null = null;
      try {
        const live = await bharag.liveIncidents('bays');
        const existing = live.find((x) => x.payload?.execution_id === o.recovery_key);
        const opened = existing ? null : await bharag.openIncident('bays', incidentBody(o));
        ledger_id = existing?.entity_id ?? opened!.id;
        await doctrineEpisodes.recordAlarmOpen(o.recovery_key, token, ledger_id);
        await copyToHealth(o, ledger_id, opened?.raw ?? existing ?? null);
        await engineEvents.record({ event_type: OPENED_EVENT, at: o.observed_at, subject_id: o.recovery_key, lane: 'MEDIA', actor: 'doctrine-gap-monitor', source_ref: 'LOOP-1791557096370-SE8L', detail: { ...o, ledger_id, policy_reason: policy.reason }, dedupe_key: `${OPENED_EVENT}:${o.recovery_key}:${ledger_id}` });
        incident = { action: existing ? 'linked_existing' : 'opened', ledger_id, error: null };
      } catch (e) {
        // Not knowing whether BHARAG opened it, the claim is given back: the next claimant looks for it there first.
        if (!ledger_id) await doctrineEpisodes.releaseAlarmClaim(o.recovery_key, token).catch(() => undefined);
        incident = { action: 'none', ledger_id, error: e instanceof Error ? e.message : String(e) };
      }
    }
  } else if (policy.recover && alarm.open && alarm.ledger_id) {
    const ledger_id = alarm.ledger_id;
    // The fence refreshes the heartbeat, so no takeover can happen for SWEEP_RULE.stale_after_minutes after this.
    await doctrineEpisodes.fenced(sweep, async () => undefined);
    try {
      await bharag.markRetrying('bays', ledger_id);
      await bharag.closeIncident('bays', ledger_id, 'doctrine-gap-monitor', o.observed_at, 'self_healed');
      await doctrineEpisodes.recordAlarmClosed(o.recovery_key, ledger_id);
      await closeOnHealth(ledger_id, o.observed_at);
      await engineEvents.record({ event_type: RECOVERED_EVENT, at: o.observed_at, subject_id: o.recovery_key, lane: 'MEDIA', actor: 'doctrine-gap-monitor', source_ref: 'LOOP-1791557096370-SE8L', detail: { ...o, ledger_id, policy_reason: policy.reason }, dedupe_key: `${RECOVERED_EVENT}:${o.recovery_key}:${ledger_id}:${o.observation_id}` });
      incident = { action: 'closed_after_two_healthy_reads', ledger_id, error: null };
    } catch (e) {
      incident = { action: 'none', ledger_id, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // The sweep discards its results, so without this line a failed open or close would be silent.
  if (incident.error) console.error(`[doctrine-gap] incident sync failed for ${o.recovery_key} (${o.condition}, ${policy.reason}): ${incident.error}`);
  return {
    observation: o, written: write.write, write_reason: stored.restated ? ('incident_restatement' as const) : write.reason, recorded: stored.recorded, policy, guidance: guidanceFor(o), incident,
    sweep_seq: sweep.seq, research_key: researchKey, episode: { step: stored.step, episode_id: stored.episode_id, changed: stored.episode_changed }, restated: stored.restated,
  };
}

/** The newest observations summary() reads in one window; one more is fetched to tell a full window from a cut one. */
export const SUMMARY_LIMIT = 2000;

/** Pure: the rows a capped read keeps, and whether the window held more than the cap. */
export function capRows<T>(rows: T[], limit = SUMMARY_LIMIT): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function summary(hours = 24) {
  const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  const r = await query<EventRow>(`SELECT event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, detail FROM engine_events WHERE event_type = $1 AND at >= now() - ($2::text || ' hours')::interval ORDER BY at DESC, id DESC LIMIT $3`, [OBSERVED_EVENT, String(safeHours), SUMMARY_LIMIT + 1]);
  const { rows, truncated } = capRows(r.rows);
  const observations = rows.map((x) => x.detail);
  const groups = aggregateObservations(observations);
  // Counts are readings written, not sweeps run: an unchanged reading writes nothing (WRITE_RULE). Whether
  // anything was checked is the sweeps table's to say, so an empty window is never read as "not looked at".
  let sweeps: Awaited<ReturnType<typeof doctrineEpisodes.lastSweeps>> | { error: string };
  try {
    sweeps = await doctrineEpisodes.lastSweeps();
  } catch (e) {
    sweeps = { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    schema: SUMMARY_SCHEMA, read_at: new Date().toISOString(), window_hours: safeHours, policy: { status: 'PROPOSED', ...PROPOSED_POLICY },
    research_rule: RESEARCH_RULE, continuity: CONTINUITY,
    write_rule: WRITE_RULE,
    sweeps,
    counts: { observations: observations.length, groups: groups.length, limit: SUMMARY_LIMIT, truncated },
    note: truncated ? `More than ${SUMMARY_LIMIT} observations in the last ${safeHours} hours; only the newest ${SUMMARY_LIMIT} were read, so every count here is a floor. Ask for fewer hours to see the rest.` : null,
    groups,
  };
}

/**
 * One pass over every claim on every surface, as one sweep (doctrineEpisodes.claimSweep). Nothing is
 * read when another sweep is running. The reads are made first and the readings recorded after, so a
 * failure while recording (the database, or this worker losing its sweep) is never mistaken for the
 * resolver failing, which until 27 Oct it could be. A sweep that loses its fence stops where it is
 * and does not finish; one that fails otherwise stays running and is taken over, under the same seq,
 * once its heartbeat is old.
 */
export async function sweepCanonical() {
  const results: Array<Awaited<ReturnType<typeof observe>>> = [];
  const claimed = await doctrineEpisodes.claimSweep();
  if (!claimed.sweep) {
    console.log(`[doctrine-gap] sweep skipped: ${claimed.reason}`);
    return results;
  }
  const sweep = claimed.sweep;
  const readings: DoctrineGapInput[] = [];
  let claimsRead: number | null = null;
  let resolverError: string | null = null;
  try {
    const doctrine = await systemFeeds.doctrineClaims({});
    for (const surface of publicationDecision.SURFACES) {
      const publications = await publicationDecision.readDecisions(doctrine.claims as publicationDecision.ResolvedClaim[], surface);
      for (let i = 0; i < doctrine.claims.length; i++) {
        const claim = doctrine.claims[i] as publicationDecision.ResolvedClaim;
        // Fail closed on the consumer (2026-10-17, Destiny and Jason): allowed_use says a surface MAY
        // use a claim, not that anything does, and T0NO defaults genie_ns to true on an unresolved
        // claim, so reading it as an active consumer made every claim escalate. Nothing in the engine
        // records real use of a claim yet, so the sweep asserts none. needs_evidence and stale_evidence
        // never open an incident (27 Oct); they reach Research Twin only through their episode and a
        // verified consumer-use event (doctrineConsumer), which nothing writes yet.
        readings.push({ surface, claim, publication: publications.decisions[i] ?? null, active_consumer: false, attempted_public_use: false, requires_mechanical_provenance: false, requested_use: 'internal' });
      }
    }
    claimsRead = doctrine.claims.length;
  } catch (e) {
    resolverError = e instanceof Error ? e.message : String(e);
    readings.push({ surface: RESOLVER_SURFACE, resolver_error: { message: resolverError }, active_consumer: true });
  }
  try {
    for (const r of readings) results.push(await observe(r, sweep));
    // A resolver incident closes only on healthy reads under its own key, and claim reads never carry it,
    // so while one is open every fully successful sweep says the resolver answered. observe() still
    // requires two in a row.
    if (claimsRead !== null) {
      const resolverKey = classify({ surface: RESOLVER_SURFACE, resolver_ok: { claims: claimsRead } }).recovery_key;
      if ((await openAlarm(resolverKey)).open) results.push(await observe({ surface: RESOLVER_SURFACE, resolver_ok: { claims: claimsRead }, active_consumer: false }, sweep));
    }
  } catch (e) {
    if (e instanceof doctrineEpisodes.FencedError) {
      console.error(`[doctrine-gap] ${e.message}; stopped after ${results.length} of ${readings.length} readings`);
      return results;
    }
    throw e;
  }
  if (!(await doctrineEpisodes.finishSweep(sweep, { keys: results.length, claims_read: claimsRead, resolver_error: resolverError })))
    console.error(`[doctrine-gap] sweep ${sweep.seq} was taken over before it finished; this worker did not close it`);
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
