/**
 * Incident -> pattern capture (2026-10-15, Destiny — Jason in #bha-self-healing,
 * 1792079140.605749: "the minimal form of SPEC-CORE.INCIDENTS-002 ... capture +
 * routing only").
 *
 * The repair bridge traces every failure it is handed against the build
 * patterns on record and says so on the result it posts here
 * (`payload.trace.pattern_status`). Until this file, "none_on_record" — "No
 * Build Pattern on record for this failure -- a candidate for a new one" — was
 * a line on a Slack card and nothing else. Now:
 *
 * - **Every incident it touches carries a `canonical_id`**: the fault
 *   signature, `fault:<workflow> :: <failed step>`, the key Logstream and the
 *   research signals already group repeats by, so one fault has one id however
 *   many times it happens.
 * - **"matched" writes the bridge's pattern ids into `pattern_refs`** on those
 *   incidents: the incident -> pattern trail is a column, not prose.
 * - **"none_on_record" in an engine lane writes one pattern candidate per
 *   fault**, Proposed, owned by the lane's owner (`LANE_OWNERS`), on the
 *   Candidates tab beside every other candidate. A repeat of the same fault
 *   adds its incident to that candidate; it never makes a second one. A fault
 *   whose candidate was declined is not proposed again, and one already
 *   registered as a pattern gets that pattern written into `pattern_refs`.
 * - **Nothing is promoted.** Turning a candidate into a pattern is the
 *   existing Register flow, by a person; this only captures and routes.
 *
 * Tests, the monitoring simulator and a guard's refused ask are left out, by
 * Logstream's own rule (`logstream.excludedReason`). The BHARAG ledger itself
 * still refuses keys it does not know (SOP-ENGINE-CONTRACT-NOTE-001 section 5),
 * so both fields live on this dashboard's copy of the incident.
 *
 * One row per fault in `engine_pattern_captures` (migration 79) is the memory
 * of what was decided, because a registered candidate is deleted from the list.
 * Runs after every repair the bridge posts, and as a sweep every ten minutes,
 * which is also the backfill: each repair is handled once (`repair_ids`).
 */
import { query } from './pg';
import * as engineWrite from './engineWrite';
import * as engineEvents from './engineEvents';
import * as logstream from './logstream';
import * as timers from './timers';
import { dashboardBase } from './patternAnnounce';
import { LANE_OWNERS } from './writeGuards';

/** Repair lane (as the bridge spells it) -> loop lane tag. The engine's critical lanes only. */
export const LANE_TAGS: Record<string, string> = {
  bays: 'BAYS',
  north_star: 'NS',
  ns: 'NS',
  research_twin: 'RT',
  rt: 'RT',
  genie: 'GENIE',
  monitoring: 'VFARM_HARDWARE',
  vfarm: 'VFARM_HARDWARE',
  cst: 'CST',
};

const ORIGIN = 'incident';
const FLAGGED_BY = 'Engine (repair bridge found no pattern on record)';
const SWEEP_MS = 10 * 60_000;

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstSentence = (s: string): string => {
  const m = s.match(/^[\s\S]*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
};

export function canonicalId(workflow: string | null, node: string | null): string {
  return `fault:${logstream.signatureOf(workflow, node)}`;
}

interface RepairRow {
  repair_id: string;
  outcome: string;
  workflow_name: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  root_cause: string | null;
  execution_id: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

interface Capture {
  signature: string;
  canonical_id: string;
  lane: string | null;
  state: string;
  candidate_id: string | null;
  candidate_row_id: string | null;
  pattern_id: string | null;
  repair_ids: string[];
  incident_ids: string[];
  execution_ids: string[];
  occurrences: number;
  first_seen_at: string | null;
}

export interface CaptureResult {
  repair_id: string;
  result:
    | 'no_trace'
    | 'already_handled'
    | 'linked_pattern'
    | 'traced_other'
    | 'excluded'
    | 'not_a_critical_lane'
    | 'candidate_created'
    | 'added_to_candidate'
    | 'pattern_exists'
    | 'declined_before'
    | 'failed';
  signature?: string;
  canonical_id?: string;
  candidate_id?: string | null;
  pattern_ids?: string[];
  incidents?: string[];
  detail?: string;
}

/* One at a time: the bridge can post the same repair twice, and a repeat of a fault
   arriving while its candidate is being written must add to it, not make a second. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function incidentsFor(executionId: string | null): Promise<string[]> {
  if (!executionId) return [];
  const r = await query<{ natural_id: string }>(
    `SELECT natural_id FROM engine_incidents WHERE natural_id IS NOT NULL AND fields->'payload'->>'execution_id' = $1 ORDER BY natural_id`,
    [executionId],
  );
  return r.rows.map((x) => x.natural_id);
}

async function stampIncidents(ids: string[], canonical: string, patternIds: string[], candidateId: string | null): Promise<void> {
  if (!ids.length) return;
  await query(
    `UPDATE engine_incidents SET
       canonical_id = $2,
       pattern_refs = (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(pattern_refs || $3::jsonb) AS x),
       pattern_candidate_id = COALESCE($4, pattern_candidate_id)
     WHERE natural_id = ANY($1)`,
    [ids, canonical, JSON.stringify(patternIds), candidateId],
  );
}

async function ownerOf(laneTag: string): Promise<{ id: string; name: string }> {
  const id = LANE_OWNERS[laneTag] ?? 'U0AEW3TBYH1';
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]);
  return { id, name: str(r.rows[0]?.name) || id };
}

/** What happened to a candidate since it was written: still there, declined, or registered and handed off. */
async function candidateNow(c: Capture): Promise<{ status: string | null; pattern_id: string | null; row_id: string | null }> {
  if (!c.candidate_id) return { status: null, pattern_id: null, row_id: null };
  const r = await query<{ id: string; status: string | null; pattern_id: string | null }>(
    `SELECT id::text, fields->>'Status' AS status, fields->>'Pattern ID' AS pattern_id FROM engine_pattern_candidates WHERE natural_id = $1 ORDER BY id DESC LIMIT 1`,
    [c.candidate_id],
  );
  if (r.rows[0]) return { status: r.rows[0].status, pattern_id: r.rows[0].pattern_id, row_id: r.rows[0].id };
  const d = await query<{ pattern_id: string | null; reason: string | null }>(
    `SELECT fields->>'Pattern ID' AS pattern_id, reason FROM record_deletions WHERE kind = 'pattern_candidates' AND natural_id = $1 ORDER BY seq DESC LIMIT 1`,
    [c.candidate_id],
  );
  const del = d.rows[0];
  if (!del) return { status: 'Missing', pattern_id: null, row_id: null };
  const pid = del.pattern_id || (str(del.reason).match(/Registered as (BP-[^\s]+)/)?.[1] ?? null);
  return { status: pid ? 'Registered' : 'Deleted', pattern_id: pid, row_id: null };
}

function summaryOf(r: RepairRow): string {
  const cls = str(r.error_class).toUpperCase() || 'UNCLASSIFIED';
  const msg = clip(str(r.error_message) || 'no error message recorded', 300);
  const cause = clip(firstSentence(str(r.root_cause)), 300);
  return `${cls}: ${msg}${cause ? ` Root cause, per the repair bridge: ${cause}` : ''} The repair bridge found no build pattern on record for this failure, so it is captured here for an architect to turn into one, or decline.`;
}

async function writeCandidate(r: RepairRow, sig: string, canonical: string, laneTag: string, incidents: string[], prior: Capture | null): Promise<{ natural_id: string; row_id: string }> {
  const owner = await ownerOf(laneTag);
  const now = new Date().toISOString();
  const natural = `CAND-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;
  const repairs = [...(prior?.repair_ids ?? []), r.repair_id];
  const incs = [...new Set([...(prior?.incident_ids ?? []), ...incidents])];
  const execs = [...new Set([...(prior?.execution_ids ?? []), ...(r.execution_id ? [r.execution_id] : [])])];
  const fields: Record<string, unknown> = {
    Candidate: clip(`Fault: ${str(r.failed_node) || '(no step)'} in ${str(r.workflow_name) || '(no workflow)'}`, 200),
    Summary: summaryOf(r),
    Lane: laneTag,
    Status: 'Proposed',
    Builder: owner.name,
    'Builder Slack ID': owner.id,
    'Suggested Architect': owner.name,
    'Architect Slack ID': owner.id,
    'Why This Architect': `Default draft owner: owns the ${laneTag} lane, where this failure happened. Reassign from the candidate if someone else should write it.`,
    'Flagged By': FLAGGED_BY,
    'Source Link': incidents[0] ? `${dashboardBase()}/engine-health?incident=${encodeURIComponent(incidents[0])}` : `${dashboardBase()}/engine-health?tab=repairs`,
    'Date Flagged': (prior?.first_seen_at ?? r.created_at ?? now).slice(0, 10),
    Origin: ORIGIN,
    'Fault Signature': sig,
    'Canonical ID': canonical,
    'Error Class': str(r.error_class) || null,
    'Incident IDs': incs.join(', ') || null,
    'Execution IDs': execs.join(', ') || null,
    'Repair IDs': repairs.join(', '),
    Occurrences: repairs.length,
    'Last Seen': r.created_at ?? now,
  };
  const res = await engineWrite.postRecord('pattern_candidates', { natural_id: natural, fields }, {
    endpoint: 'pattern-capture',
    method: 'POST',
    key_label: 'internal (pattern capture)',
    note: `from ${r.repair_id}`,
  });
  return { natural_id: res.natural_id ?? natural, row_id: String(res.id) };
}

async function addToCandidate(rowId: string, c: Capture): Promise<void> {
  await engineWrite.patchRecord(
    'pattern_candidates',
    rowId,
    {
      'Incident IDs': c.incident_ids.join(', ') || null,
      'Execution IDs': c.execution_ids.join(', ') || null,
      'Repair IDs': c.repair_ids.join(', '),
      Occurrences: c.repair_ids.length,
      'Last Seen': new Date().toISOString(),
    },
    { endpoint: 'pattern-capture', method: 'PATCH', key_label: 'internal (pattern capture)', note: 'repeat of the same fault' },
  );
}

async function saveCapture(c: Capture, extra: { workflow: string | null; failed_node: string | null; error_class: string | null; error?: string | null; last_seen_at: string }): Promise<void> {
  await query(
    `INSERT INTO engine_pattern_captures (signature, canonical_id, lane, workflow, failed_node, error_class, state, candidate_id, candidate_row_id, pattern_id,
       repair_ids, incident_ids, execution_ids, occurrences, first_seen_at, last_seen_at, error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17, now())
     ON CONFLICT (signature) DO UPDATE SET
       state = EXCLUDED.state, candidate_id = EXCLUDED.candidate_id, candidate_row_id = EXCLUDED.candidate_row_id, pattern_id = EXCLUDED.pattern_id,
       repair_ids = EXCLUDED.repair_ids, incident_ids = EXCLUDED.incident_ids, execution_ids = EXCLUDED.execution_ids,
       occurrences = EXCLUDED.occurrences, last_seen_at = EXCLUDED.last_seen_at, error = EXCLUDED.error, lane = COALESCE(EXCLUDED.lane, engine_pattern_captures.lane), updated_at = now()`,
    [
      c.signature, c.canonical_id, c.lane, extra.workflow, extra.failed_node, extra.error_class, c.state, c.candidate_id, c.candidate_row_id, c.pattern_id,
      JSON.stringify(c.repair_ids), JSON.stringify(c.incident_ids), JSON.stringify(c.execution_ids), c.occurrences, c.first_seen_at, extra.last_seen_at, extra.error ?? null,
    ],
  );
}

async function loadCapture(sig: string): Promise<Capture | null> {
  const r = await query<Capture>(
    `SELECT signature, canonical_id, lane, state, candidate_id, candidate_row_id::text, pattern_id, repair_ids, incident_ids, execution_ids, occurrences,
            to_char(first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen_at
       FROM engine_pattern_captures WHERE signature = $1`,
    [sig],
  );
  return r.rows[0] ?? null;
}

async function handle(repairId: string): Promise<CaptureResult> {
  const rr = await query<RepairRow>(
    `SELECT repair_id, outcome, workflow_name, failed_node, error_class, error_message, root_cause, execution_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, payload
       FROM engine_repairs WHERE repair_id = $1`,
    [repairId],
  );
  const r = rr.rows[0];
  if (!r) return { repair_id: repairId, result: 'no_trace', detail: 'no such repair' };
  const trace = (r.payload?.trace ?? null) as { pattern_status?: string; pattern_ids?: unknown[] } | null;
  if (!trace || !trace.pattern_status) return { repair_id: repairId, result: 'no_trace' };

  const sig = logstream.signatureOf(r.workflow_name, r.failed_node);
  const canonical = canonicalId(r.workflow_name, r.failed_node);
  const incidents = await incidentsFor(r.execution_id);

  if (trace.pattern_status === 'matched') {
    const ids = (Array.isArray(trace.pattern_ids) ? trace.pattern_ids : []).map(str).filter(Boolean);
    await stampIncidents(incidents, canonical, ids, null);
    return { repair_id: repairId, result: 'linked_pattern', signature: sig, canonical_id: canonical, pattern_ids: ids, incidents };
  }
  if (trace.pattern_status !== 'none_on_record') {
    await stampIncidents(incidents, canonical, [], null);
    return { repair_id: repairId, result: 'traced_other', signature: sig, detail: trace.pattern_status };
  }

  const excluded = logstream.excludedReason({ workflow: r.workflow_name, node: r.failed_node });
  if (excluded) {
    await stampIncidents(incidents, canonical, [], null);
    return { repair_id: repairId, result: 'excluded', signature: sig, detail: excluded };
  }
  const laneTag = LANE_TAGS[str(r.payload?.lane).toLowerCase()];
  if (!laneTag) {
    await stampIncidents(incidents, canonical, [], null);
    return { repair_id: repairId, result: 'not_a_critical_lane', signature: sig, detail: str(r.payload?.lane) || 'no lane on the repair' };
  }

  const prior = await loadCapture(sig);
  if (prior?.repair_ids.includes(repairId)) {
    await stampIncidents(incidents, canonical, prior.pattern_id ? [prior.pattern_id] : [], prior.candidate_id);
    return { repair_id: repairId, result: 'already_handled', signature: sig, candidate_id: prior.candidate_id };
  }
  const meta = { workflow: r.workflow_name, failed_node: r.failed_node, error_class: r.error_class, last_seen_at: r.created_at };
  const c: Capture = prior ?? {
    signature: sig, canonical_id: canonical, lane: laneTag, state: 'new', candidate_id: null, candidate_row_id: null, pattern_id: null,
    repair_ids: [], incident_ids: [], execution_ids: [], occurrences: 0, first_seen_at: r.created_at,
  };
  const withThis = (x: Capture): Capture => ({
    ...x,
    repair_ids: [...x.repair_ids, repairId],
    incident_ids: [...new Set([...x.incident_ids, ...incidents])],
    execution_ids: [...new Set([...x.execution_ids, ...(r.execution_id ? [r.execution_id] : [])])],
    occurrences: x.occurrences + 1,
  });

  // What became of the candidate since: it decides whether this one is added, skipped or linked.
  const now = await candidateNow(c);
  if (now.status === 'Registered' && now.pattern_id) {
    const next = { ...withThis(c), state: 'registered', pattern_id: now.pattern_id };
    await saveCapture(next, meta);
    await stampIncidents(next.incident_ids, canonical, [now.pattern_id], c.candidate_id);
    return { repair_id: repairId, result: 'pattern_exists', signature: sig, candidate_id: c.candidate_id, pattern_ids: [now.pattern_id], incidents };
  }
  if (now.status === 'Declined') {
    const next = { ...withThis(c), state: 'declined' };
    await saveCapture(next, meta);
    await stampIncidents(incidents, canonical, [], c.candidate_id);
    return { repair_id: repairId, result: 'declined_before', signature: sig, candidate_id: c.candidate_id };
  }
  if (now.row_id && (now.status === 'Proposed' || now.status === 'Approved' || !now.status)) {
    const next = { ...withThis(c), state: 'proposed', candidate_row_id: now.row_id };
    await addToCandidate(now.row_id, next);
    await saveCapture(next, meta);
    await stampIncidents(next.incident_ids, canonical, [], c.candidate_id);
    return { repair_id: repairId, result: 'added_to_candidate', signature: sig, candidate_id: c.candidate_id, incidents };
  }

  // No candidate for this fault, or the one written was deleted without being registered: write one.
  try {
    const made = await writeCandidate(r, sig, canonical, laneTag, incidents, prior);
    const next = { ...withThis(c), state: 'proposed', candidate_id: made.natural_id, candidate_row_id: made.row_id, lane: laneTag };
    await saveCapture(next, meta);
    await stampIncidents(next.incident_ids, canonical, [], made.natural_id);
    await engineEvents
      .record({
        event_type: 'pattern_candidate_captured',
        subject_id: made.natural_id,
        lane: laneTag,
        actor: 'pattern-capture',
        source_ref: repairId,
        detail: { signature: sig, canonical_id: canonical, incidents: next.incident_ids, workflow: r.workflow_name, failed_node: r.failed_node, error_class: r.error_class },
        dedupe_key: `pattern_candidate_captured:${made.natural_id}`,
      })
      .catch((e) => console.error(`[pattern-capture] event not written for ${made.natural_id}: ${(e as Error).message}`));
    return { repair_id: repairId, result: 'candidate_created', signature: sig, canonical_id: canonical, candidate_id: made.natural_id, incidents };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Not marked handled: the next sweep tries this repair again.
    await saveCapture({ ...c, state: c.candidate_id ? c.state : 'failed' }, { ...meta, error: msg }).catch(() => undefined);
    console.error(`[pattern-capture] candidate not written for ${repairId} (${sig}): ${msg}`);
    return { repair_id: repairId, result: 'failed', signature: sig, detail: msg };
  }
}

/** One repair, after the bridge posted it. Never throws: a capture must not fail the repair's own write. */
export function fromRepair(repairId: string): Promise<CaptureResult> {
  return serial(() => handle(repairId)).catch((e) => {
    console.error(`[pattern-capture] ${repairId}: ${(e as Error).message}`);
    return { repair_id: repairId, result: 'failed' as const, detail: (e as Error).message };
  });
}

/** Every traced repair not yet handled, oldest first. The backfill and the safety net in one. */
export async function sweep(): Promise<{ handled: number; results: CaptureResult[] }> {
  const r = await query<{ repair_id: string }>(
    `SELECT r.repair_id FROM engine_repairs r
      WHERE r.payload->'trace'->>'pattern_status' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM engine_pattern_captures c WHERE c.repair_ids ? r.repair_id)
      ORDER BY r.created_at ASC`,
  );
  const results: CaptureResult[] = [];
  for (const row of r.rows) results.push(await fromRepair(row.repair_id));
  return { handled: results.length, results };
}

/**
 * A captured candidate was registered (candidateActions.register): its pattern id
 * goes onto every incident it came from, and the capture remembers it, before
 * the candidate row is handed off and deleted.
 */
export async function linkRegistered(candidateFields: Record<string, unknown>, patternId: string | null): Promise<void> {
  const sig = str(candidateFields['Fault Signature']);
  if (!sig || !patternId || str(candidateFields.Origin) !== ORIGIN) return;
  const c = await loadCapture(sig);
  const incidents = c?.incident_ids ?? str(candidateFields['Incident IDs']).split(',').map((s) => s.trim()).filter(Boolean);
  await query(`UPDATE engine_pattern_captures SET state = 'registered', pattern_id = $2, updated_at = now() WHERE signature = $1`, [sig, patternId]);
  await stampIncidents(incidents, str(candidateFields['Canonical ID']) || `fault:${sig}`, [patternId], null);
}

/** Every capture, newest first, for reads and the test. */
export async function list(limit = 100): Promise<Array<Record<string, unknown>>> {
  const r = await query(`SELECT * FROM engine_pattern_captures ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

export function startSweeping(): void {
  const tick = (): void => {
    timers.beat('pattern capture');
    void sweep()
      .then((s) => {
        const made = s.results.filter((x) => x.result === 'candidate_created').length;
        if (made) console.log(`[pattern-capture] ${made} candidate(s) written from ${s.handled} repair(s)`);
      })
      .catch((e) => console.error(`[pattern-capture] sweep failed: ${(e as Error).message}`));
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, SWEEP_MS).unref();
}
