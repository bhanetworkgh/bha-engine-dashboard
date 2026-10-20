/**
 * The QNDM drill for SE8L's doctrine-gap watcher (2026-10-20, Destiny's proposal and Jason's
 * approval in the M4CV thread, LOOP-1791608537128-QNDM).
 *
 * It proves the watcher's whole alarm lifecycle on one labelled drill claim, never a real one:
 * healthy -> a deliberately contradicting decision -> one critical DOCTRINE incident -> a row
 * per sweep while the alarm is open -> the real decision put back -> two healthy reads close it
 * (retrying, then self_healed) -> nothing written once closed. Then the drill doctrine retires.
 *
 * The watcher's timer stays off. Each sweep is sweepCanonical() run once, by hand — the same
 * function the timer calls, with the same incident sync — so every step is taken exactly when
 * asked and the record is clean.
 *
 * The one thing here no normal path can do is `breakIt`: VRFK refuses a decision that
 * contradicts the doctrine in force (409), and that refusal is right. This records one on
 * purpose, and only on the drill doctrine. Everything else goes through the normal functions:
 * storeDoctrine for the drill doctrine and its retirement, storeDecision for the real decision.
 */
import * as doctrineGap from './doctrineGap';
import * as publicationDecision from './publicationDecision';
import * as systemFeeds from './systemFeeds';
import { record } from './engineEvents';
import { query } from './pg';

export const DOCTRINE_ID = doctrineGap.DRILL_DOCTRINE_ID;
export const CLAIM_ID = 'BREAK';
export const SURFACE: publicationDecision.PublicationSurface = 'genie_ns';
export const LOOP = 'LOOP-1791608537128-QNDM';
export const STEPS = ['status', 'create', 'record_decision', 'break', 'sweep', 'retire'] as const;
export type DrillStep = (typeof STEPS)[number];

export class DrillError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

const key = (surface: string) => `doctrine:${surface}:${DOCTRINE_ID}:${CLAIM_ID}`;
const runOk = (run: string) => /^[A-Za-z0-9-]{1,40}$/.test(run);

async function drillClaim(): Promise<publicationDecision.ResolvedClaim | null> {
  const r = await systemFeeds.doctrineClaims({ doctrine_id: DOCTRINE_ID });
  return (r.claims.find((c) => c.claim_id === CLAIM_ID) as publicationDecision.ResolvedClaim | undefined) ?? null;
}

/** Log the drill doctrine: one claim, every T0NO field held, cleared for genie_ns only. */
export async function create(run: string, actor: string) {
  if (!runOk(run)) throw new DrillError('bad_run', 'run must be 1 to 40 letters, digits or hyphens.');
  if (await drillClaim()) throw new DrillError('already_in_force', `${DOCTRINE_ID} is already in force. Retire it before starting another run.`);
  const now = new Date().toISOString();
  return systemFeeds.storeDoctrine({
    schema: 'media.doctrine.v1',
    change_id: `${DOCTRINE_ID}-${run}-created`,
    doctrine_id: DOCTRINE_ID,
    doctrine_name: 'QNDM drill (not a doctrine)',
    version: `drill-${run}`,
    change_type: 'created',
    summary: `QNDM drill run ${run}: one labelled drill claim for the SE8L watcher drill Jason approved on 20 Oct 2026. Not a claim. Never publish. Retired when the drill ends.`,
    claims: [
      {
        claim_id: CLAIM_ID,
        label: 'Drill claim, not a real claim',
        maturity: 'DRILL_ONLY',
        allowed_wording: 'DRILL: not a claim. Never publish or repeat this.',
        prohibited_wording: 'Anything at all: this is a drill record.',
        claim_state: 'drill_not_a_claim',
        config_hash: 'DRILL-QNDM-NOT-A-CONFIG',
        cad_provenance: { cad_revision: 'DRILL-NOT-A-CAD-REVISION', provenance_ref: 'DRILL-NOT-A-PROVENANCE' },
        evidence_publication_status: 'DRILL_ONLY',
        fail_closed: { needs_evidence: false, reason: null },
        allowed_use: { media_twin: false, vfarm: false, genie_ns: true },
      },
    ],
    changed_at: now,
    approved_by: 'Jason Bays (drill approval, 20 Oct 2026)',
    approved_at: now,
    loop_id: LOOP,
    posted_by: actor,
  });
}

/** Record the real decision for the drill claim on genie_ns through VRFK's normal path. */
export async function recordDecision(run: string, label: string, actor: string) {
  const claim = await drillClaim();
  if (!claim) throw new DrillError('not_in_force', `${DOCTRINE_ID} is not in force. Run create first.`);
  return publicationDecision.storeDecision(
    { decision_id: `${DOCTRINE_ID}-${run}-${label}`, doctrine_id: DOCTRINE_ID, claim_id: CLAIM_ID, surface: SURFACE, actor, source_ref: LOOP, reason: `QNDM drill run ${run}: the real decision (${label}).` },
    claim,
  );
}

/** Record one decision that contradicts the drill claim on purpose. Drill doctrine only. */
export async function breakIt(run: string, actor: string) {
  const claim = await drillClaim();
  if (!claim) throw new DrillError('not_in_force', `${DOCTRINE_ID} is not in force. Run create first.`);
  if (claim.doctrine_id !== DOCTRINE_ID) throw new DrillError('not_drill', 'Only the drill doctrine can be broken.');
  const expected = publicationDecision.expectedDecision(claim, SURFACE);
  const wrong: publicationDecision.PublicationDecision = expected.decision === 'allowed' ? 'hold' : 'allowed';
  const prepared = publicationDecision.prepareDecision(
    { decision_id: `${DOCTRINE_ID}-${run}-break`, doctrine_id: DOCTRINE_ID, claim_id: CLAIM_ID, surface: SURFACE, actor, source_ref: LOOP },
    claim,
  );
  const detail = { ...prepared.event.detail, decision: wrong, reason: 'QNDM_DRILL_DELIBERATE_CONTRADICTION', drill: true };
  const saved = await record({ ...prepared.event, detail });
  return { recorded: saved.recorded, id: saved.id ?? null, decision: wrong, expected: expected.decision, decision_id: detail.decision_id };
}

/** Run the watcher's sweep once, by hand, and say what it did. */
export async function sweep() {
  const results = (await doctrineGap.sweepCanonical()) as Array<Awaited<ReturnType<typeof doctrineGap.observe>>>;
  const by: Record<string, number> = {};
  for (const r of results) by[r.write_reason] = (by[r.write_reason] ?? 0) + 1;
  const incidents = results.filter((r) => r.incident.action !== 'none' || r.incident.error).map((r) => ({ key: r.observation.recovery_key, ...r.incident }));
  const drill = results
    .filter((r) => r.observation.doctrine_id === DOCTRINE_ID)
    .map((r) => ({ surface: r.observation.surface, condition: r.observation.condition, reason: r.observation.reason, written: r.written, write_reason: r.write_reason, policy: r.policy.reason, incident: r.incident.action, ledger_id: r.incident.ledger_id, incident_error: r.incident.error }));
  return { readings: results.length, written: results.filter((r) => r.written).length, by_write_reason: by, incidents, drill };
}

/** Retire the drill doctrine: a new version that takes it out of force. */
export async function retire(run: string, actor: string) {
  const r = await systemFeeds.doctrineClaims({ doctrine_id: DOCTRINE_ID });
  const doc = r.doctrines.find((d) => d.doctrine_id === DOCTRINE_ID);
  if (!doc) throw new DrillError('not_in_force', `${DOCTRINE_ID} is not in force; nothing to retire.`);
  return systemFeeds.storeDoctrine({
    schema: 'media.doctrine.v1',
    change_id: `${DOCTRINE_ID}-${run}-retired`,
    doctrine_id: DOCTRINE_ID,
    doctrine_name: 'QNDM drill (not a doctrine)',
    version: `${doc.version}-retired`,
    previous_version: doc.version,
    change_type: 'retired',
    summary: `QNDM drill run ${run} finished; the drill doctrine is retired and out of force.`,
    claims: [],
    changed_at: new Date().toISOString(),
    loop_id: LOOP,
    posted_by: actor,
  });
}

/** Where the drill stands: the doctrine, the decisions, every row and marker on the drill keys. */
export async function status() {
  const claim = await drillClaim();
  const events = await query<{ id: string; event_type: string; at: string; detail: Record<string, unknown> }>(
    `SELECT id, event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, detail
       FROM engine_events
      WHERE (event_type IN ($1, $2, $3) AND detail->>'doctrine_id' = $4)
         OR (event_type = $5 AND detail->>'doctrine_id' = $4)
      ORDER BY at, id`,
    [doctrineGap.OBSERVED_EVENT, doctrineGap.OPENED_EVENT, doctrineGap.RECOVERED_EVENT, DOCTRINE_ID, publicationDecision.EVENT_TYPE],
  );
  const rows = events.rows.map((e) => ({
    id: Number(e.id),
    at: e.at,
    event: e.event_type,
    surface: e.detail.surface ?? null,
    condition: e.detail.condition ?? null,
    decision: e.event_type === publicationDecision.EVENT_TYPE ? e.detail.decision : null,
    decision_id: e.detail.decision_id ?? null,
    write_reason: e.detail.write_reason ?? null,
    ledger_id: e.detail.ledger_id ?? null,
  }));
  return { doctrine_in_force: Boolean(claim), keys: [key('genie_ns'), key('media_twin'), key('vfarm')], rows };
}
