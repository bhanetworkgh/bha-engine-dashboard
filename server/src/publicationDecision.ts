/**
 * VRFK publication decisions on the existing engine.event.v1 ledger.
 *
 * The doctrine row remains truth.  This module records the decision made from
 * that truth for one claim and one surface; it never edits doctrine and never
 * treats an old decision as authority after the doctrine change has moved.
 */
import { query } from './pg';
import { record } from './engineEvents';
import type { T0noPrimitive } from './systemFeeds';

export const EVENT_NAME = 'VFAM.claim_publication_decision';
export const EVENT_TYPE = 'vfam_claim_publication_decision';
export const DECISION_SCHEMA = 'vfam.claim_publication_decision.v1';
export const READ_SCHEMA = 'vfam.claim_publication_decision.read.v1';
export const SURFACES = ['media_twin', 'vfarm', 'genie_ns'] as const;
export const DECISIONS = ['allowed', 'hold', 'needs_evidence'] as const;

export type PublicationSurface = (typeof SURFACES)[number];
export type PublicationDecision = (typeof DECISIONS)[number];

export interface ResolvedClaim extends T0noPrimitive {
  doctrine_id: string;
  doctrine_version: string;
  change_id: string;
  claim_id: string | null;
  label: string;
}

export interface StoredDecisionDetail {
  schema: typeof DECISION_SCHEMA;
  event_name: typeof EVENT_NAME;
  decision_id: string;
  doctrine_id: string;
  doctrine_version: string;
  doctrine_change_id: string;
  claim_id: string;
  capability_id: string | null;
  surface: PublicationSurface;
  decision: PublicationDecision;
  reason: string;
  evidence_refs: string[];
  correlation_id: string | null;
  t0no: T0noPrimitive;
}

export interface DecisionEventRow {
  id: string | number;
  at: string;
  actor: string | null;
  source_ref: string | null;
  recorded_at: string;
  detail: StoredDecisionDetail;
}

export interface DecisionRead {
  schema: typeof READ_SCHEMA;
  event_name: typeof EVENT_NAME;
  doctrine_id: string;
  claim_id: string;
  surface: PublicationSurface;
  decision: PublicationDecision;
  recorded_decision: PublicationDecision | null;
  applicable: boolean;
  reason: string;
  decision_id: string | null;
  event_id: number | null;
  decided_at: string | null;
  recorded_at: string | null;
  actor: string | null;
  source_ref: string | null;
  evidence_refs: string[];
  doctrine_change_id: string;
}

export class PublicationDecisionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const clean = (v: unknown, max = 500): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

const iso = (v: unknown, field: string): string => {
  if (v === undefined || v === null || v === '') return new Date().toISOString();
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new PublicationDecisionError(422, `${field} must be an ISO 8601 time.`);
  return d.toISOString();
};

export function expectedDecision(claim: ResolvedClaim, surface: PublicationSurface): { decision: PublicationDecision; reason: string } {
  if (claim.fail_closed.needs_evidence || claim.evidence_publication_status.toUpperCase() === 'NEEDS_EVIDENCE') {
    return { decision: 'needs_evidence', reason: claim.fail_closed.reason ?? 'NEEDS_EVIDENCE' };
  }
  if (!claim.allowed_use[surface] || claim.maturity_state === 'NOT_SAFE_TO_CLAIM') {
    return { decision: 'hold', reason: !claim.allowed_use[surface] ? `NOT_ALLOWED_FOR_${surface.toUpperCase()}` : 'NOT_SAFE_TO_CLAIM' };
  }
  return { decision: 'allowed', reason: 'T0NO_GATE_CLEARED' };
}

export function prepareDecision(body: Record<string, unknown>, claim: ResolvedClaim) {
  const decision_id = clean(body.decision_id, 200);
  const doctrine_id = clean(body.doctrine_id, 100)?.toUpperCase() ?? null;
  const claim_id = clean(body.claim_id, 200);
  const surface = clean(body.surface, 40) as PublicationSurface | null;
  const actor = clean(body.actor, 200);
  const source_ref = clean(body.source_ref, 1000);
  if (!decision_id) throw new PublicationDecisionError(422, 'decision_id is required and makes a retry idempotent.');
  if (!doctrine_id || doctrine_id !== claim.doctrine_id) throw new PublicationDecisionError(422, `doctrine_id must be the resolved doctrine "${claim.doctrine_id}".`);
  if (!claim_id || claim_id !== claim.claim_id) throw new PublicationDecisionError(422, `claim_id must be the resolved claim "${claim.claim_id ?? 'NOT_HELD'}".`);
  if (!surface || !SURFACES.includes(surface)) throw new PublicationDecisionError(422, `surface must be one of ${SURFACES.join(', ')}.`);
  if (!actor) throw new PublicationDecisionError(422, 'actor is required.');
  if (!source_ref) throw new PublicationDecisionError(422, 'source_ref is required.');
  const expected = expectedDecision(claim, surface);
  const requested = clean(body.decision, 40);
  if (requested && requested !== expected.decision)
    throw new PublicationDecisionError(409, `decision "${requested}" contradicts the canonical T0NO result "${expected.decision}" (${expected.reason}).`);
  const refs = Array.isArray(body.evidence_refs)
    ? body.evidence_refs.map((x) => clean(x, 1000)).filter((x): x is string => Boolean(x))
    : [];
  const doctrineRef = `engine_media_doctrine:${claim.doctrine_id}:${claim.doctrine_version}:${claim.change_id}`;
  if (!refs.includes(doctrineRef)) refs.push(doctrineRef);
  const at = iso(body.decided_at, 'decided_at');
  const detail: StoredDecisionDetail = {
    schema: DECISION_SCHEMA,
    event_name: EVENT_NAME,
    decision_id,
    doctrine_id: claim.doctrine_id,
    doctrine_version: claim.doctrine_version,
    doctrine_change_id: claim.change_id,
    claim_id,
    capability_id: clean(body.capability_id, 200),
    surface,
    decision: expected.decision,
    reason: clean(body.reason, 1000) ?? expected.reason,
    evidence_refs: refs,
    correlation_id: clean(body.correlation_id, 300),
    t0no: {
      maturity_state: claim.maturity_state,
      claim_state: claim.claim_state,
      config_hash: claim.config_hash,
      cad_provenance: claim.cad_provenance,
      evidence_publication_status: claim.evidence_publication_status,
      fail_closed: claim.fail_closed,
      allowed_use: claim.allowed_use,
    },
  };
  return {
    at,
    actor,
    source_ref,
    detail,
    event: {
      event_type: EVENT_TYPE,
      at,
      subject_id: `${claim.doctrine_id}:${claim_id}:${surface}`,
      lane: 'MEDIA',
      actor,
      source_ref,
      detail: { ...detail },
      dedupe_key: `${EVENT_NAME}:${decision_id}`,
    },
  };
}

export async function storeDecision(body: Record<string, unknown>, claim: ResolvedClaim) {
  const prepared = prepareDecision(body, claim);
  if (body.dry_run === true) return { dry_run: true, recorded: false, id: null, decision: prepared.detail };
  const saved = await record(prepared.event);
  return { dry_run: false, ...saved, decision: prepared.detail };
}

export function resolveDecision(claim: ResolvedClaim, surface: PublicationSurface, row: DecisionEventRow | null): DecisionRead {
  const expected = expectedDecision(claim, surface);
  const base = {
    schema: READ_SCHEMA,
    event_name: EVENT_NAME,
    doctrine_id: claim.doctrine_id,
    claim_id: claim.claim_id ?? 'NOT_HELD',
    surface,
    doctrine_change_id: claim.change_id,
  } as const;
  if (!claim.claim_id)
    return { ...base, decision: 'needs_evidence', recorded_decision: null, applicable: false, reason: 'MISSING_CLAIM_ID', decision_id: null, event_id: null, decided_at: null, recorded_at: null, actor: null, source_ref: null, evidence_refs: [] };
  if (!row)
    return { ...base, decision: 'needs_evidence', recorded_decision: null, applicable: false, reason: 'MISSING_PUBLICATION_DECISION', decision_id: null, event_id: null, decided_at: null, recorded_at: null, actor: null, source_ref: null, evidence_refs: [] };
  const common = {
    decision_id: row.detail.decision_id,
    event_id: Number(row.id),
    decided_at: row.at,
    recorded_at: row.recorded_at,
    actor: row.actor,
    source_ref: row.source_ref,
    evidence_refs: row.detail.evidence_refs,
    recorded_decision: row.detail.decision,
  };
  if (row.detail.doctrine_change_id !== claim.change_id)
    return { ...base, ...common, decision: 'needs_evidence', applicable: false, reason: 'STALE_PUBLICATION_DECISION' };
  if (row.detail.decision !== expected.decision)
    return { ...base, ...common, decision: 'needs_evidence', applicable: false, reason: 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO' };
  return { ...base, ...common, decision: row.detail.decision, applicable: true, reason: row.detail.reason };
}

export async function readDecisions(claims: ResolvedClaim[], surface: PublicationSurface) {
  const wanted = claims.filter((c) => c.claim_id);
  const rows = wanted.length
    ? (await query<DecisionEventRow>(
        `SELECT DISTINCT ON (detail->>'doctrine_id', detail->>'claim_id') id, at, actor, source_ref, recorded_at, detail
           FROM engine_events
          WHERE event_type = $1 AND detail->>'event_name' = $2 AND detail->>'surface' = $3
            AND (detail->>'doctrine_id' || ':' || detail->>'claim_id') = ANY($4::text[])
          ORDER BY detail->>'doctrine_id', detail->>'claim_id', at DESC, id DESC`,
        [EVENT_TYPE, EVENT_NAME, surface, wanted.map((c) => `${c.doctrine_id}:${c.claim_id}`)],
      )).rows
    : [];
  const byClaim = new Map(rows.map((r) => [`${r.detail.doctrine_id}:${r.detail.claim_id}`, r]));
  const decisions = claims.map((c) => resolveDecision(c, surface, byClaim.get(`${c.doctrine_id}:${c.claim_id}`) ?? null));
  return { schema: READ_SCHEMA, event_name: EVENT_NAME, read_at: new Date().toISOString(), surface, decisions, counts: { claims: claims.length, allowed: decisions.filter((d) => d.decision === 'allowed' && d.applicable).length, held: decisions.filter((d) => d.decision !== 'allowed' || !d.applicable).length } };
}
