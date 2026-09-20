/**
 * The repair record: every automated repair, and the way back from one.
 *
 * Built 2026-09-20, on Destiny's instruction, as the dashboard half of the
 * self-healing repair layer. The other half is `bha-repair-bridge`: n8n's
 * `Bays — Error Handler` classifies a failure, refuses the ones no code change
 * can fix, and posts a repair request to that service, which runs Claude Code
 * against the failing workflow and posts its result here.
 *
 * The design rule the whole surface exists to keep: **nothing heals invisibly.**
 * Every failure ends as retried, repaired, or waiting on a person, and every
 * repair shows the error, the root cause, the exact change, and a way back.
 *
 * Three things this module will not do, each of which is a way the record could
 * have quietly started lying:
 *
 * **A repair is repaired only where the bridge says so and a new version came
 * back.** The bridge having been *called* is not a repair. A run that finished
 * without reporting a parseable result is `needs_human`, never `repaired` —
 * that rule is enforced in the bridge and again here, because a guard that
 * lives only in the caller is not a guard.
 *
 * **A revert is stamped only once n8n has taken the older version back.** Not
 * when the button is pressed, not when the call is made. `reverted_at` is a
 * claim about another system's state, so it is written after that system has
 * agreed, and a refused revert leaves the row exactly as it was.
 *
 * **A restore needs the workflow, not a version id.** This is the one place the
 * spec and the API disagree, so it is worth stating plainly: n8n's public API
 * offers `PUT /workflows/{id}`, which replaces a workflow with a body you
 * supply, and it offers no way to fetch a historical version by its id. So
 * `version_before` alone cannot be restored from — it identifies the restore
 * point without containing it. What can be restored from is the snapshot the
 * bridge already reads before it edits anything (part one, step 5), carried
 * through on its result. Where that snapshot is present, Revert works. Where it
 * is absent, Revert **refuses and says why**, and names the manual route, which
 * is n8n's own version history. It is never drawn as a revert that happened.
 */
import { query, withTransaction, type Queryable } from './pg';
import * as mirror from './mirror';
import { N8N_API_VAR, n8nConfigured, n8nHost, replaceWorkflow, workflow, N8nError } from './n8n';

/** The five outcomes the bridge reports. Every one of them reports; silence is the one thing it may not do. */
export const OUTCOMES = ['repaired', 'not_repaired', 'needs_human', 'skipped', 'error'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export class RepairError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'RepairError';
  }
}

/* --------------------------------------------------------------- the write */

function text(v: unknown, max = 8000): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** An ISO instant, or null. A stamp that does not parse is stored as absent rather than as now. */
function instant(v: unknown): string | null {
  const t = text(v, 64);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nested(payload: Record<string, unknown>, key: string, field: string): unknown {
  const o = payload[key];
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>)[field] : undefined;
}

/**
 * `outcome` is the one field with no safe default.
 *
 * An unrecognised outcome is refused rather than filed as `error` or as
 * anything else: the five names are the vocabulary the two services share, and
 * a sixth arriving means they have drifted, which is worth a 422 that names it
 * rather than a row nobody can interpret.
 */
function outcomeOf(v: unknown): Outcome {
  const said = text(v, 40)?.toLowerCase().replace(/[\s-]+/g, '_') ?? '';
  if ((OUTCOMES as readonly string[]).includes(said)) return said as Outcome;
  throw new RepairError(
    `"outcome" is required and must be one of ${OUTCOMES.join(', ')} — it is the whole truth of a repair and there is no safe default. Got ${said ? `"${said}"` : 'nothing'}.`,
    422,
  );
}

export interface StoreResult {
  repair_id: string;
  outcome: Outcome;
  inserted: boolean;
}

/**
 * Stores one repair result, keyed on the bridge's own `repair_id`.
 *
 * An upsert, because the bridge posts once and n8n retries a failed HTTP node:
 * the same result arriving twice must update the row rather than add a second.
 * `reverted_at` and `reverted_by` are deliberately left out of the update — they
 * are this dashboard's own, and a late repost of the bridge's result must not
 * erase the fact that somebody has since put the workflow back.
 *
 * The whole payload is stored beside the columns. The columns are the read
 * model; the blob is the record, and a field the bridge adds before this
 * dashboard reads it is kept rather than dropped.
 */
export async function store(payload: Record<string, unknown>, db: Queryable = { query }): Promise<StoreResult> {
  const repairId = text(payload.repair_id, 120);
  if (!repairId) throw new RepairError('"repair_id" is required: it is what makes a repeated report update one row rather than add a second.', 422);
  const outcome = outcomeOf(payload.outcome);

  const nodesChanged = Array.isArray(payload.nodes_changed) ? payload.nodes_changed.filter((n) => typeof n === 'string').slice(0, 200) : [];

  const r = await db.query<{ inserted: boolean }>(
    `INSERT INTO engine_repairs (
       repair_id, outcome, workflow_id, workflow_name, failed_node, error_class, error_message, execution_id,
       root_cause, change_summary, nodes_changed, human_action, version_before, version_after, duration_ms,
       report_channel, payload, started_at, finished_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
     ON CONFLICT (repair_id) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       workflow_id = EXCLUDED.workflow_id,
       workflow_name = EXCLUDED.workflow_name,
       failed_node = EXCLUDED.failed_node,
       error_class = EXCLUDED.error_class,
       error_message = EXCLUDED.error_message,
       execution_id = EXCLUDED.execution_id,
       root_cause = EXCLUDED.root_cause,
       change_summary = EXCLUDED.change_summary,
       nodes_changed = EXCLUDED.nodes_changed,
       human_action = EXCLUDED.human_action,
       version_before = EXCLUDED.version_before,
       version_after = EXCLUDED.version_after,
       duration_ms = EXCLUDED.duration_ms,
       report_channel = EXCLUDED.report_channel,
       payload = EXCLUDED.payload,
       started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at
     RETURNING (xmax = 0) AS inserted`,
    [
      repairId,
      outcome,
      text(nested(payload, 'workflow', 'id') ?? payload.workflow_id, 120),
      text(nested(payload, 'workflow', 'name') ?? payload.workflow_name, 400),
      text(payload.failed_node, 400),
      text(payload.error_class, 80),
      text(payload.error_message),
      text(payload.execution_id, 120),
      text(payload.root_cause),
      text(payload.change_summary),
      JSON.stringify(nodesChanged),
      text(payload.human_action),
      text(payload.version_before, 120),
      text(payload.version_after, 120),
      int(payload.duration_ms),
      text(payload.report_channel, 40),
      JSON.stringify(payload),
      instant(payload.started_at),
      instant(payload.finished_at),
    ],
  );

  return { repair_id: repairId, outcome, inserted: Boolean(r.rows[0]?.inserted) };
}

/* ---------------------------------------------------------------- the read */

export interface Repair {
  id: number;
  repair_id: string;
  outcome: Outcome | string;
  workflow_id: string | null;
  workflow_name: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  execution_id: string | null;
  root_cause: string | null;
  change_summary: string | null;
  nodes_changed: string[];
  human_action: string | null;
  version_before: string | null;
  version_after: string | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  reverted_at: string | null;
  reverted_by: string | null;
  created_at: string;
  /** The n8n page for the execution that failed, where both ids are held. */
  execution_url: string | null;
  /**
   * Whether Revert can be offered on this row at all, decided on the server.
   * The page asks rather than working it out a second time, so the button and
   * the endpoint cannot disagree about what is revertible.
   */
  can_revert: boolean;
  /** Why not, in a sentence, where `can_revert` is false and the row is otherwise a repair. */
  revert_blocked_reason: string | null;
}

interface Row {
  id: string;
  repair_id: string;
  outcome: string;
  workflow_id: string | null;
  workflow_name: string | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  execution_id: string | null;
  root_cause: string | null;
  change_summary: string | null;
  nodes_changed: unknown;
  human_action: string | null;
  version_before: string | null;
  version_after: string | null;
  duration_ms: number | null;
  payload: Record<string, unknown> | null;
  started_at: Date | null;
  finished_at: Date | null;
  reverted_at: Date | null;
  reverted_by: string | null;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Where a pre-repair snapshot lives on the bridge's payload, if it sent one.
 *
 * Several spellings are accepted because the bridge is a separate deployment:
 * the field is not in its result contract yet, and the day it is, this reads it
 * without a migration or a release here. What it must contain is the nodes and
 * the connections — a version id is not a snapshot.
 */
function snapshotOf(payload: Record<string, unknown> | null): { name?: string; nodes: unknown[]; connections: Record<string, unknown>; settings?: unknown } | null {
  if (!payload) return null;
  for (const key of ['workflow_before', 'workflow_snapshot', 'snapshot_before', 'snapshot']) {
    const v = payload[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.nodes) && o.connections && typeof o.connections === 'object') {
      return {
        name: typeof o.name === 'string' ? o.name : undefined,
        nodes: o.nodes,
        connections: o.connections as Record<string, unknown>,
        settings: o.settings,
      };
    }
  }
  return null;
}

/**
 * Why this row cannot be reverted, or null where it can.
 *
 * Computed once, here, and returned with the row. The three guards the brief
 * names are the first three; the fourth is the snapshot, which is what an
 * actual restore is made of. The version comparison is deliberately *not* done
 * here — it needs a live read of n8n, which a list of forty rows must not make
 * forty times, so it happens at the moment somebody asks to revert.
 */
function revertBlock(r: Row): string | null {
  if (r.outcome !== 'repaired') {
    return `Only a repair is revertible, and this one is recorded as ${r.outcome.replace(/_/g, ' ')} — nothing was changed, so there is nothing to put back.`;
  }
  if (r.reverted_at) return `Already reverted${r.reverted_by ? ` by ${r.reverted_by}` : ''} at ${iso(r.reverted_at)}.`;
  if (!r.version_before) return 'No restore point was recorded for this repair, so there is no version to go back to.';
  if (!r.workflow_id) return 'This row does not name a workflow id, so there is nothing to restore.';
  if (!snapshotOf(r.payload)) {
    return 'The bridge did not send the workflow as it stood before the repair, and n8n’s public API cannot fetch a version by id — so there is nothing here to restore from. Use the workflow’s own version history in n8n.';
  }
  if (!n8nConfigured()) return `${N8N_API_VAR} is not set on this server, so n8n cannot be asked to take the older version back.`;
  return null;
}

function toRepair(r: Row): Repair {
  const blocked = revertBlock(r);
  return {
    id: Number(r.id),
    repair_id: r.repair_id,
    outcome: r.outcome,
    workflow_id: r.workflow_id,
    workflow_name: r.workflow_name,
    failed_node: r.failed_node,
    error_class: r.error_class,
    error_message: r.error_message,
    execution_id: r.execution_id,
    root_cause: r.root_cause,
    change_summary: r.change_summary,
    nodes_changed: Array.isArray(r.nodes_changed) ? (r.nodes_changed as unknown[]).filter((n): n is string => typeof n === 'string') : [],
    human_action: r.human_action,
    version_before: r.version_before,
    version_after: r.version_after,
    duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    reverted_at: iso(r.reverted_at),
    reverted_by: r.reverted_by,
    created_at: r.created_at.toISOString(),
    execution_url: r.workflow_id && r.execution_id ? `${n8nHost()}/workflow/${r.workflow_id}/executions/${r.execution_id}` : null,
    can_revert: blocked === null,
    revert_blocked_reason: blocked,
  };
}

const SELECT = `SELECT id, repair_id, outcome, workflow_id, workflow_name, failed_node, error_class, error_message,
                       execution_id, root_cause, change_summary, nodes_changed, human_action, version_before,
                       version_after, duration_ms, payload, started_at, finished_at, reverted_at, reverted_by, created_at
                  FROM engine_repairs`;

export interface RepairSummary {
  /** Every repair attempt held, whatever came of it. */
  total: number;
  last_7_days: number;
  last_30_days: number;
  /** One entry per outcome present, newest-first order irrelevant here. */
  by_outcome: { key: string; label: string; n: number }[];
  /** Repaired and not since reverted — what the engine currently claims to have fixed. */
  repaired_standing: number;
  reverted: number;
  /**
   * p50 and p95 of how long a *successful* repair took, over the ones that
   * recorded a duration. Never a mean, on the rule that holds across every
   * figure on this page: a mean hides the tail and the tail is what people feel.
   */
  median_repair_ms: number | null;
  p95_repair_ms: number | null;
  timed: number;
  /** What the duration figures are over, said in the figure's own note. */
  duration_note: string;
  /** When the newest row arrived, so the page can say how old what it shows is. */
  newest_at: string | null;
}

const OUTCOME_LABEL: Record<string, string> = {
  repaired: 'Repaired',
  not_repaired: 'Not repaired',
  needs_human: 'Needs a person',
  skipped: 'Skipped',
  error: 'Bridge error',
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export interface RepairsData {
  repairs: Repair[];
  summary: RepairSummary;
  /** Whether a revert can reach n8n at all, so the page says so once rather than on every row. */
  n8n_configured: boolean;
}

/** Every repair, newest first, with the summary computed over the same rows. */
export async function list(): Promise<RepairsData> {
  const r = await query<Row>(`${SELECT} ORDER BY created_at DESC, id DESC`);
  const repairs = r.rows.map(toRepair);

  const now = Date.now();
  const within = (days: number) => repairs.filter((x) => now - new Date(x.created_at).getTime() <= days * 86_400_000).length;

  const counts = new Map<string, number>();
  for (const x of repairs) counts.set(x.outcome, (counts.get(x.outcome) ?? 0) + 1);

  /**
   * Only repairs that actually changed something are timed. A skipped attempt
   * takes milliseconds and would drag the figure toward nothing, which would
   * read as repairs being fast rather than as most attempts never running.
   */
  const durations = repairs
    .filter((x) => x.outcome === 'repaired' && x.duration_ms !== null && x.duration_ms > 0)
    .map((x) => x.duration_ms as number)
    .sort((a, b) => a - b);

  const repaired = counts.get('repaired') ?? 0;

  return {
    repairs,
    n8n_configured: n8nConfigured(),
    summary: {
      total: repairs.length,
      last_7_days: within(7),
      last_30_days: within(30),
      by_outcome: [...counts.entries()]
        .map(([key, n]) => ({ key, label: OUTCOME_LABEL[key] ?? key.replace(/_/g, ' '), n }))
        .sort((a, b) => b.n - a.n),
      repaired_standing: repairs.filter((x) => x.outcome === 'repaired' && !x.reverted_at).length,
      reverted: repairs.filter((x) => x.reverted_at).length,
      median_repair_ms: percentile(durations, 50),
      p95_repair_ms: percentile(durations, 95),
      timed: durations.length,
      duration_note:
        durations.length === 0
          ? 'No repair has recorded how long it took, so there is nothing to take a median of.'
          : `p50 and p95 over the ${durations.length} of ${repaired} repaired run${repaired === 1 ? '' : 's'} that recorded a duration. Attempts that were skipped or errored are excluded: they take milliseconds and would read as repairs being fast rather than as most attempts never running.`,
      newest_at: repairs[0]?.created_at ?? null,
    },
  };
}

export async function byRepairId(repairId: string): Promise<Repair | null> {
  const r = await query<Row>(`${SELECT} WHERE repair_id = $1`, [repairId]);
  return r.rows[0] ? toRepair(r.rows[0]) : null;
}

/* -------------------------------------------------------------- the revert */

export interface RevertResult {
  ok: boolean;
  repair_id: string;
  message: string;
  /** Which guard refused it, where one did. Named, so the page does not have to read the sentence. */
  refused: 'not_found' | 'not_a_repair' | 'already_reverted' | 'no_restore_point' | 'no_snapshot' | 'version_moved_on' | 'not_configured' | 'n8n_refused' | null;
  /** The row as it now stands, so the page can update in place rather than re-reading everything. */
  repair: Repair | null;
}

/**
 * Puts a workflow back to the version it was on before a repair.
 *
 * The guards, in order, and each refusal says which one stopped it:
 *
 * 1. The repair exists.
 * 2. It is recorded as `repaired` — nothing else changed anything.
 * 3. It has not already been reverted.
 * 4. A restore point was recorded, and a snapshot to restore from exists.
 * 5. **The workflow's current version is still the one the repair produced.**
 *    This is the guard that matters most and the only one that costs a live
 *    read: if the version has moved on, somebody has edited the workflow since
 *    the repair, and a blind restore would throw their work away. It is refused
 *    rather than forced — the later change is not this dashboard's to discard.
 *
 * Only then is the older version written back, and `reverted_at` is stamped
 * only after n8n has confirmed the new version. A revert that n8n refused
 * leaves the row untouched, because a row saying it was reverted when it was
 * not is worse than no revert at all.
 */
export async function revert(repairId: string, actor: string): Promise<RevertResult> {
  const r = await query<Row>(`${SELECT} WHERE repair_id = $1`, [repairId]);
  const row = r.rows[0];
  if (!row) {
    return { ok: false, repair_id: repairId, refused: 'not_found', message: `No repair is held with the id ${repairId}.`, repair: null };
  }

  const held = toRepair(row);

  // The first four guards are the ones already computed for the row, so the
  // button and the endpoint cannot disagree about what is revertible.
  if (row.outcome !== 'repaired') return { ok: false, repair_id: repairId, refused: 'not_a_repair', message: held.revert_blocked_reason ?? 'This is not a repair.', repair: held };
  if (row.reverted_at) return { ok: false, repair_id: repairId, refused: 'already_reverted', message: held.revert_blocked_reason ?? 'Already reverted.', repair: held };
  if (!row.version_before || !row.workflow_id) {
    return { ok: false, repair_id: repairId, refused: 'no_restore_point', message: held.revert_blocked_reason ?? 'No restore point was recorded.', repair: held };
  }
  const snapshot = snapshotOf(row.payload);
  if (!snapshot) return { ok: false, repair_id: repairId, refused: 'no_snapshot', message: held.revert_blocked_reason ?? 'There is nothing here to restore from.', repair: held };
  if (!n8nConfigured()) {
    return { ok: false, repair_id: repairId, refused: 'not_configured', message: `${N8N_API_VAR} is not set on this server, so n8n cannot be asked to take the older version back.`, repair: held };
  }

  /**
   * The live read, and the guard it exists for. `version_after` is what the
   * repair produced; anything else means the workflow has changed since, and
   * restoring would silently discard whatever that change was.
   */
  let current: { id: string; name: string; versionId: string | null };
  try {
    current = await workflow(row.workflow_id);
  } catch (e) {
    const message = e instanceof N8nError ? e.message : e instanceof Error ? e.message : String(e);
    return { ok: false, repair_id: repairId, refused: 'n8n_refused', message: `The workflow could not be read, so nothing was changed: ${message}`, repair: held };
  }

  if (row.version_after && current.versionId && current.versionId !== row.version_after) {
    return {
      ok: false,
      repair_id: repairId,
      refused: 'version_moved_on',
      message: `The workflow has changed since this repair: it is on ${current.versionId} and the repair left it on ${row.version_after}. Reverting now would throw that later change away, so nothing was done. Look at the workflow's history in n8n and decide what should survive.`,
      repair: held,
    };
  }

  // Everything agrees. Write the older version back.
  try {
    await replaceWorkflow(row.workflow_id, {
      name: snapshot.name ?? current.name,
      nodes: snapshot.nodes,
      connections: snapshot.connections,
      settings: snapshot.settings,
    });
  } catch (e) {
    const message = e instanceof N8nError ? e.message : e instanceof Error ? e.message : String(e);
    await mirror.logWrite({
      endpoint: `${n8nHost()}/api/v1/workflows/${row.workflow_id}`,
      kind: 'repairs',
      method: 'PUT',
      key_label: N8N_API_VAR,
      natural_id: repairId,
      outcome: 'error',
      detail: `revert by ${actor} refused: ${message}`,
    });
    return { ok: false, repair_id: repairId, refused: 'n8n_refused', message: `n8n refused the restore, so nothing was changed and this repair still stands: ${message}`, repair: held };
  }

  /**
   * Re-read, so the version this row records as the reverted-to one is the one
   * n8n actually produced rather than the one we asked for. A restore creates a
   * *new* version holding the old content; it does not bring the old version id
   * back, and saying otherwise would be a small lie that a later version check
   * would then act on.
   */
  let after: string | null = null;
  try {
    after = (await workflow(row.workflow_id)).versionId;
  } catch {
    // The restore landed; only the confirming read failed. The stamp still
    // goes on — what it claims is that n8n took the change, which it did.
    after = null;
  }

  const stamped = await withTransaction(async (db) => {
    await db.query(
      `UPDATE engine_repairs
          SET reverted_at = now(),
              reverted_by = $2,
              payload = payload || jsonb_build_object('reverted', jsonb_build_object('by', $2::text, 'restored_version', $3::text, 'from_version', $4::text))
        WHERE repair_id = $1`,
      [repairId, actor, after, row.version_after],
    );
    const again = await db.query<Row>(`${SELECT} WHERE repair_id = $1`, [repairId]);
    return again.rows[0] ? toRepair(again.rows[0]) : held;
  });

  await mirror.logWrite({
    endpoint: `${n8nHost()}/api/v1/workflows/${row.workflow_id}`,
    kind: 'repairs',
    method: 'PUT',
    key_label: N8N_API_VAR,
    natural_id: repairId,
    outcome: 'updated',
    detail: `reverted by ${actor} to the workflow as it stood before the repair${after ? ` — n8n now on ${after}` : ''}`,
  });

  return {
    ok: true,
    repair_id: repairId,
    refused: null,
    /**
     * Worded as what happened rather than as success. The workflow is back to
     * its pre-repair content, which also means the original failure is back:
     * that is the point of a revert and the page should not imply otherwise.
     */
    message: `${row.workflow_name ?? row.workflow_id} is back to the version it was on before this repair${after ? `, as n8n version ${after}` : ''}. The failure this repair addressed is no longer fixed.`,
    repair: stamped,
  };
}
