/**
 * The Airtable half of a loop edit: change the fields on a row, or move the row
 * to another builder's table.
 *
 * Decision (2026-09-14, Destiny): edits go from this server straight to
 * Airtable. The n8n write-back built this morning is retired — it handled the
 * status only, and two paths writing the same field is the thing worth
 * avoiding. Postgres is still written first (see store.editLoop); this runs
 * after, and a failure here never undoes it.
 *
 * **Field names are Airtable's own and are never translated.** Read from the
 * live base on 2026-09-14, all seven tables identical:
 *
 *   What · Raised By · Date Raised · Source Link · Status ·
 *   Assignee Slack User ID · loop_id · lane_tag · raised_in · last_modified
 *
 * Two of those are worth stating because the brief for this work named them
 * differently. The lane field is **`lane_tag`**, not `Lane` — no field called
 * `Lane` exists in any of the seven tables, and writing one with `typecast` on
 * would have created a second lane field that nothing reads while the real one
 * silently never changed. And **`raised_in`** is a real field carrying data
 * that the brief's move list left out; it is carried across a move for the same
 * reason everything else is.
 *
 * `last_modified` is a formula (LAST_MODIFIED_TIME()) and is never written.
 */
import * as airtable from './airtable';
import { LOOP_LANE_TAGS, LOOP_STATUS_TO_AIRTABLE, LOOP_TABLES, SLACK_TO_BUILDER, loopTable, type AtRecord } from './sources';
import type { LoopStatus } from '../../src/data/types';

/** Every field this dashboard writes or carries, spelled as Airtable spells it. */
export const FIELD = {
  what: 'What',
  status: 'Status',
  lane: 'lane_tag',
  assignee: 'Assignee Slack User ID',
  raisedBy: 'Raised By',
  dateRaised: 'Date Raised',
  sourceLink: 'Source Link',
  raisedIn: 'raised_in',
  loopId: 'loop_id',
} as const;

/**
 * What a move copies to the new row.
 *
 * `Assignee Slack User ID` is deliberately absent: it is set from the
 * destination table, never copied from the source. The digest routes by table,
 * and a row sitting in one builder's table naming another builder is what
 * mis-delivered on 7 Sept. `last_modified` is absent because it is a formula.
 */
const CARRIED = [FIELD.loopId, FIELD.what, FIELD.status, FIELD.lane, FIELD.raisedBy, FIELD.dateRaised, FIELD.sourceLink, FIELD.raisedIn] as const;

/** The Slack id that belongs to a builder's table. Inverted from the roster in sources.ts. */
const BUILDER_TO_SLACK: Record<string, string> = Object.fromEntries(Object.entries(SLACK_TO_BUILDER).map(([slack, builder]) => [builder, slack]));

export const BUILDERS = LOOP_TABLES.map((t) => t.owner);

export class LoopError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

/** What the interface may change. Everything else on the row is read-only. */
export interface LoopPatch {
  title?: string;
  status?: LoopStatus;
  lane_tag?: string | null;
  /** A move, not a field — see moveTo below. */
  builder?: string;
}

/**
 * How an Airtable write ended.
 *
 * `duplicate` is its own state and not a kind of failure, because the recovery
 * is different and specific: the loop exists twice and someone has to delete
 * one. Folding it into `failed` would tell the reader the save did not happen,
 * which is the opposite of the truth.
 */
export type LoopWriteState = 'ok' | 'skipped' | 'failed' | 'duplicate';

export interface LoopWriteResult {
  state: LoopWriteState;
  /** The record id the loop now lives under. New after a move. */
  record_id: string | null;
  reason: string | null;
  http: number | null;
  /** Which steps actually completed, in order. The whole point on a half-landed move. */
  steps: string[];
  from_table: string | null;
  to_table: string | null;
  /**
   * The record the move read from, kept only when it is still there: a
   * duplicate is exactly "this id, in from_table, was never deleted", and
   * without it the copy can be named but not removed.
   */
  from_record_id?: string | null;
}

/** Validates a patch before anything is written anywhere. Throws with the field named. */
export function validate(patch: LoopPatch): void {
  if (patch.title !== undefined && !patch.title.trim()) throw new LoopError('A loop needs a What — it is the loop.');
  if (patch.status !== undefined && !LOOP_STATUS_TO_AIRTABLE[patch.status]) {
    throw new LoopError(`"${patch.status}" is not a status a loop can have. One of: open, in progress, closed.`);
  }
  if (patch.lane_tag !== undefined && patch.lane_tag !== null && !(LOOP_LANE_TAGS as readonly string[]).includes(patch.lane_tag)) {
    throw new LoopError(`"${patch.lane_tag}" is not a lane the loop tables define. One of: ${LOOP_LANE_TAGS.join(', ')}.`);
  }
  // Rejected before any write happens, as asked: only the seven builders with a
  // table are destinations, and a move to somewhere that does not exist would
  // otherwise delete a source row with nowhere to have put it.
  if (patch.builder !== undefined && !loopTable(patch.builder)) {
    throw new LoopError(`"${patch.builder}" is not a builder with an Open Loops table. One of: ${BUILDERS.join(', ')}.`);
  }
}

/** The patch as Airtable field names. Only what the caller actually set. */
export function asFields(patch: LoopPatch): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (patch.title !== undefined) f[FIELD.what] = patch.title.trim();
  if (patch.status !== undefined) f[FIELD.status] = LOOP_STATUS_TO_AIRTABLE[patch.status];
  if (patch.lane_tag !== undefined) f[FIELD.lane] = patch.lane_tag;
  return f;
}

export interface ApplyInput {
  /** Airtable's id for the row today. Null when Airtable has no row for this loop. */
  record_id: string | null;
  /** The table the row is in today. */
  table: string;
  loop_id: string | null;
  /** The fields to set, already in Airtable's names. */
  fields: Record<string, unknown>;
  /** The builder to move to, when the save changes it. */
  moveTo: string | null;
}

function ok(record_id: string, steps: string[], from: string | null, to: string | null): LoopWriteResult {
  return { state: 'ok', record_id, reason: null, http: null, steps, from_table: from, to_table: to };
}
function failed(reason: string, http: number | null, steps: string[], from: string | null, to: string | null, record_id: string | null = null): LoopWriteResult {
  return { state: 'failed', record_id, reason, http, steps, from_table: from, to_table: to };
}

function why(e: unknown): { reason: string; http: number | null } {
  if (e instanceof airtable.AirtableError) return { reason: e.message, http: e.status || null };
  return { reason: e instanceof Error ? e.message : String(e), http: null };
}

/**
 * Applies one save to Airtable. Never throws: the Postgres write has already
 * happened and is this dashboard's own record, so every outcome comes back as
 * a result to be stored and shown.
 */
export async function apply(input: ApplyInput): Promise<LoopWriteResult> {
  const steps: string[] = [];

  /**
   * The write-back is off by default as of 2026-09-21 — see AIRTABLE_WRITEBACK
   * in airtable.ts. Checked first, before the token and the base, because when
   * it is off neither of those matters and neither is a thing to report.
   *
   * `skipped`, not `failed`: the edit is saved, this dashboard's tables are the
   * record, and there is nothing for a person to do. `unlanded()` in the
   * interface treats only `failed` and `duplicate` as a disagreement, so the
   * row carries no marker, the panel carries no warning and the toast says
   * what the save said.
   */
  if (!airtable.writebackEnabled()) {
    return { state: 'skipped', record_id: input.record_id, reason: airtable.WRITEBACK_OFF_REASON, http: null, steps, from_table: input.table, to_table: null };
  }

  if (!airtable.airtableConfigured()) {
    return failed('AIRTABLE_TOKEN is not set on this server, so nothing was written to Airtable and the row there still holds the old values.', null, steps, input.table, null);
  }
  if (!airtable.LOOPS_BASE_ID) {
    return failed(`${airtable.OPEN_LOOPS_BASE_VAR} is not set on this server, so there is no Open Loops base to write to and the row there still holds the old values.`, null, steps, input.table, null);
  }
  // A loop opened in the dashboard has no Airtable row until the engine writes
  // one and pushes it back. There is nothing to update and nothing to move.
  if (!input.record_id) {
    return { state: 'skipped', record_id: null, reason: 'This loop was opened in the dashboard and Airtable has no row for it yet, so the change was saved here only. It reaches Airtable when the engine writes the loop and pushes it back.', http: null, steps, from_table: input.table, to_table: null };
  }

  const destination = input.moveTo ? loopTable(input.moveTo) : null;
  if (input.moveTo && !destination) {
    return failed(`"${input.moveTo}" is not a builder with an Open Loops table.`, null, steps, input.table, null);
  }
  // A "move" to the table the row is already in is an ordinary edit.
  if (!destination || destination.table === input.table) {
    try {
      const rec = await airtable.updateRecord(airtable.loopsBase(), input.table, input.record_id, input.fields);
      steps.push('updated the row');
      return ok(rec.id, steps, input.table, input.table);
    } catch (e) {
      const { reason, http } = why(e);
      return failed(reason, http, steps, input.table, input.table);
    }
  }

  return move(input, destination.table, destination.owner, steps);
}

/**
 * Moves a row to another builder's table.
 *
 * Read, create, confirm, then delete — and the order is the whole design.
 * Deleting first and failing the create loses the loop with nothing to recover
 * from. This way the worst case is the loop existing twice, which is visible,
 * nameable, and fixable by hand.
 */
async function move(input: ApplyInput, toTable: string, toBuilder: string, steps: string[]): Promise<LoopWriteResult> {
  const from = input.table;

  // 1. Read the full source row. Everything carried across comes from here, so
  //    a stale copy would silently write yesterday's values into the new table.
  let source: AtRecord;
  try {
    source = await airtable.getRecord(airtable.loopsBase(), from, input.record_id!);
    steps.push('read the source row');
  } catch (e) {
    const { reason, http } = why(e);
    const fromName = LOOP_TABLES.find((t) => t.table === from)?.label ?? from;
    return failed(`could not read the loop from ${fromName}, so nothing was moved and it is still there: ${reason}`, http, steps, from, toTable);
  }

  // 2. Create in the destination, carrying the source's fields with this save's
  //    edits on top, and the destination builder's own Slack id.
  const fields: Record<string, unknown> = {};
  for (const key of CARRIED) {
    const v = (source.fields ?? {})[key];
    if (v !== undefined && v !== null && v !== '') fields[key] = v;
  }
  Object.assign(fields, input.fields);
  fields[FIELD.assignee] = BUILDER_TO_SLACK[toBuilder] ?? null;

  let created: AtRecord;
  try {
    created = await airtable.createRecord(airtable.loopsBase(), toTable, fields);
  } catch (e) {
    const { reason, http } = why(e);
    const fromName = LOOP_TABLES.find((t) => t.table === from)?.label ?? from;
    const toName = LOOP_TABLES.find((t) => t.table === toTable)?.label ?? toTable;
    return failed(`the loop could not be created in ${toName}, so it is still in ${fromName} and was not moved: ${reason}`, http, steps, from, toTable);
  }

  // 3. Confirm a record id came back before anything is deleted. An empty id
  //    with a 200 would otherwise take the delete down with it.
  if (!created?.id) {
    return failed('Airtable accepted the new row but returned no record id, so the original was left in place rather than deleted against nothing.', null, steps, from, toTable);
  }
  steps.push(`created ${created.id} in the destination table`);

  // 4. Only now the source copy goes.
  try {
    await airtable.deleteRecord(airtable.loopsBase(), from, input.record_id!);
    steps.push('deleted the source row');
  } catch (e) {
    const { reason, http } = why(e);
    // Do not retry the move and do not swallow it. The new row is real and is
    // the one the loop lives under from here; the old one is a duplicate
    // somebody has to remove. Named precisely, because a generic error here
    // leaves a loop in two tables with nothing saying so.
    const fromName = LOOP_TABLES.find((t) => t.table === from)?.label ?? from;
    const toName = LOOP_TABLES.find((t) => t.table === toTable)?.label ?? toTable;
    return {
      state: 'duplicate',
      record_id: created.id,
      reason: `This loop now exists in both ${fromName} and ${toName} — the copy in ${fromName} needs deleting. It was created in ${toName} as ${created.id}, and removing it from ${fromName} failed: ${reason}`,
      http,
      steps,
      from_table: from,
      to_table: toTable,
      // The id of the copy left behind, so the delete can be retried against
      // exactly that row rather than searched for later.
      from_record_id: input.record_id,
    };
  }

  return ok(created.id, steps, from, toTable);
}

/**
 * Deletes the copy a half-landed move left behind, and nothing else.
 *
 * Only the source row, by the record id the move read from, in the table it
 * read it from. It never re-creates anything and never touches the destination
 * row: the loop already lives there, Postgres already says so, and a retry
 * that re-ran the move would make a third copy out of a second one.
 *
 * A source record that is already gone is a success, not an error — somebody
 * deleting it in Airtable by hand is the other way this ends, and the state it
 * leaves behind is the state this was trying to reach.
 */
export async function retryDelete(input: { table: string; record_id: string; to_table: string | null }): Promise<LoopWriteResult> {
  const steps: string[] = [];
  const fromName = LOOP_TABLES.find((t) => t.table === input.table)?.label ?? input.table;

  const toName = input.to_table ? (LOOP_TABLES.find((t) => t.table === input.to_table)?.label ?? input.to_table) : null;
  /**
   * A retry that does not land leaves the loop exactly as it was — in two
   * tables — so it stays `duplicate` rather than becoming `failed`. The row
   * keeps its marker, the action stays on offer, and the reason is replaced
   * with what happened this time.
   */
  const stillTwo = (reason: string, http: number | null): LoopWriteResult => ({
    state: 'duplicate',
    record_id: null,
    reason: `This loop is still in both ${fromName}${toName ? ` and ${toName}` : ''} — the copy in ${fromName} needs deleting, and removing it failed again: ${reason}`,
    http,
    steps,
    from_table: input.table,
    to_table: input.to_table,
    from_record_id: input.record_id,
  });

  /**
   * Deliberately still a `duplicate` when the write-back is off, and
   * deliberately not silent.
   *
   * This is not a page edit that saved: it is somebody pressing a button that
   * exists to delete a row in Airtable, and the copy really is still sitting in
   * two tables. Saying nothing would be claiming the repair happened. The
   * action stays on offer, and it works the moment the flag goes back on.
   */
  if (!airtable.writebackEnabled()) {
    return stillTwo(`${airtable.WRITEBACK_VAR} is off, so nothing was sent to Airtable and the copy was left where it is.`, null);
  }
  if (!airtable.airtableConfigured()) {
    return stillTwo('AIRTABLE_TOKEN is not set on this server, so nothing was sent to Airtable.', null);
  }
  if (!airtable.LOOPS_BASE_ID) {
    return stillTwo(`${airtable.OPEN_LOOPS_BASE_VAR} is not set on this server, so there is no base to delete it from.`, null);
  }

  try {
    await airtable.deleteRecord(airtable.loopsBase(), input.table, input.record_id);
    steps.push(`deleted ${input.record_id} from ${fromName}`);
    return { state: 'ok', record_id: null, reason: null, http: null, steps, from_table: input.table, to_table: input.to_table, from_record_id: null };
  } catch (e) {
    const { reason, http } = why(e);
    // 404 is the record already being gone. Airtable answers the same way
    // whether we deleted it a moment ago or somebody did it by hand this
    // morning, and in both cases the copy this was sent to remove is not there.
    if (http === 404) {
      steps.push(`${input.record_id} was already gone from ${fromName}`);
      return { state: 'ok', record_id: null, reason: null, http: null, steps, from_table: input.table, to_table: input.to_table, from_record_id: null };
    }
    return stillTwo(reason, http);
  }
}
