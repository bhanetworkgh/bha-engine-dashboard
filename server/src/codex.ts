/**
 * The Airtable half of a Codex write: set Jason Status, delete a submission,
 * and reconcile against rows someone removed in Airtable by hand.
 *
 * Same shape as loops.ts and the same rule — Postgres is written first, this
 * runs after, and a failure here is recorded and shown rather than raised.
 *
 * **Field names are Airtable's own and are never translated.** Read from
 * appEmdKshNVTl64Zf on 2026-09-14; all six builder tables carry the same 23
 * fields:
 *
 *   Submission ID · Timestamp · Builder Name · Builder User ID ·
 *   Builder Channel ID · Sheet Name · Session Url · Session Description ·
 *   Summary · Transcript · Narration Quality · Session Type ·
 *   `Layer1 Review ` · Jason Status · Jason Notes · Processed At ·
 *   Orchestrator Layer2 Review · Builder Channel Post · Submission Source ·
 *   Processed Date · Layer0 Flagged · Layer0 Missing · Codex Entry ID
 *
 * `Layer1 Review ` really does end in a space, in all six. `Session Url` is
 * spelled that way here and `Session URL` in the Layer 0 table, which is a
 * different table with a different schema entirely — see LAYER0 below.
 *
 * Jason Status is a single select of exactly three: Approved, Pending,
 * Input Added. This dashboard writes the first two; Input Added is the
 * pipeline's own and is never written from here.
 */
import * as airtable from './airtable';
import { CODEX_BASE, CODEX_LAYER0, CODEX_TABLES, codexTableById, type AtRecord } from './sources';

/** Every field this module names, spelled as Airtable spells it. */
export const FIELD = {
  submissionId: 'Submission ID',
  codexEntryId: 'Codex Entry ID',
  timestamp: 'Timestamp',
  jasonStatus: 'Jason Status',
  jasonNotes: 'Jason Notes',
  /** The trailing space is real, and is in all six tables. */
  layer1Review: 'Layer1 Review ',
  layer2Review: 'Orchestrator Layer2 Review',
  layer0Flagged: 'Layer0 Flagged',
  layer0Missing: 'Layer0 Missing',
  narrationQuality: 'Narration Quality',
  sessionType: 'Session Type',
  sessionUrl: 'Session Url',
} as const;

/** Jason Status, as the single select defines it. Case matters; typecast would otherwise invent an option. */
export const JASON_STATUS = ['Approved', 'Pending', 'Input Added'] as const;
export type JasonStatus = (typeof JASON_STATUS)[number];

/** The two this dashboard writes. "Input Added" is the pipeline's to set, never a button here. */
export const WRITABLE_STATUS: JasonStatus[] = ['Approved', 'Pending'];

/**
 * The Layer 0 parking table. A different schema from the builder tables — no
 * Jason Status, no Layer 2 review, no Codex Entry ID — because a row here is a
 * submission that never reached a builder table. Its `Status` select is
 * `pending_builder_input` or `completed`, and once the builder answers, the
 * merged row feeds Layer 1 directly rather than going back through Layer 0.
 */
export const LAYER0 = CODEX_LAYER0;

export class CodexError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export type CodexWriteState = 'ok' | 'skipped' | 'failed';

export interface CodexWriteResult {
  state: CodexWriteState;
  reason: string | null;
  http: number | null;
  steps: string[];
}

function why(e: unknown): { reason: string; http: number | null } {
  if (e instanceof airtable.AirtableError) return { reason: e.message, http: e.status || null };
  return { reason: e instanceof Error ? e.message : String(e), http: null };
}

/** The status the interface may set, validated before anything is written anywhere. */
export function asJasonStatus(raw: string): JasonStatus {
  const want = raw.trim().toLowerCase();
  const found = WRITABLE_STATUS.find((s) => s.toLowerCase() === want);
  if (!found) {
    throw new CodexError(`"${raw}" is not a Jason Status this dashboard sets. One of: ${WRITABLE_STATUS.join(', ')}. "Input Added" is set by the pipeline when a builder answers in thread.`);
  }
  return found;
}

/**
 * Writes Jason Status onto the submission's own row. Never throws: Postgres has
 * already taken the change and this is Airtable being told.
 */
export async function setStatus(table: string, recordId: string | null, status: JasonStatus): Promise<CodexWriteResult> {
  const steps: string[] = [];
  if (!airtable.airtableConfigured()) {
    return { state: 'failed', reason: 'AIRTABLE_TOKEN is not set on this server, so nothing was written to Airtable and the row there still holds the old status.', http: null, steps };
  }
  if (!recordId) {
    return { state: 'skipped', reason: 'Airtable has no row for this submission, so the change was saved here only.', http: null, steps };
  }
  if (!codexTableById(table)) {
    return { state: 'failed', reason: `${table} is not one of the six submission tables, so there was nowhere to write.`, http: null, steps };
  }
  try {
    await airtable.updateRecord(airtable.SUBMISSIONS_BASE_ID, table, recordId, { [FIELD.jasonStatus]: status });
    steps.push(`set ${FIELD.jasonStatus} to ${status}`);
    return { state: 'ok', reason: null, http: null, steps };
  } catch (e) {
    const { reason, http } = why(e);
    return { state: 'failed', reason, http, steps };
  }
}

/**
 * Removes the row from Airtable.
 *
 * The Postgres row goes too, and the caller writes the whole record to the
 * deletion log before either happens — once both are gone that log is the only
 * place it can be read.
 */
export async function remove(table: string, recordId: string | null): Promise<CodexWriteResult> {
  const steps: string[] = [];
  if (!recordId) {
    return { state: 'skipped', reason: 'Airtable had no row for this submission; only the row held here was removed.', http: null, steps };
  }
  if (!airtable.airtableConfigured()) {
    return { state: 'failed', reason: 'AIRTABLE_TOKEN is not set on this server, so the Airtable row was left in place.', http: null, steps };
  }
  try {
    await airtable.deleteRecord(airtable.SUBMISSIONS_BASE_ID, table, recordId);
    steps.push('deleted the Airtable row');
    return { state: 'ok', reason: null, http: null, steps };
  } catch (e) {
    const { reason, http } = why(e);
    // A record already gone is the outcome that was wanted, not a failure.
    if (http === 404) return { state: 'ok', reason: 'The Airtable row was already gone.', http, steps };
    return { state: 'failed', reason, http, steps };
  }
}

export interface LiveIds {
  /** record ids that exist in Airtable right now, per table. */
  byTable: Map<string, Set<string>>;
  /** Tables that answered. A table that did not is absent, and nothing under it may be removed. */
  read: string[];
  /** Tables that answered with an error, and what Airtable said. */
  failed: { table: string; reason: string }[];
  /** Tables the pass ran out of time before reaching. Not a failure — nothing was asked of them. */
  unreached: string[];
}

/**
 * How long one table's read may take, and how long the whole pass may take.
 *
 * This runs while somebody waits for the page. Seven tables at the client's
 * fifteen-second write timeout is a page that can hang for ninety seconds to do
 * housekeeping, and a load that took twenty-two seconds is what prompted these.
 * The budget is checked between tables, so the worst case is the budget plus
 * one read.
 */
const READ_TIMEOUT_MS = 5_000;
const PASS_BUDGET_MS = 8_000;

/**
 * Every record id across the six builder tables and the Layer 0 table.
 *
 * Read in full or not at all, per table. A table whose read fails is left out
 * of `byTable` entirely, and the caller removes nothing under it: a failed
 * fetch and an emptied table look identical from here, and treating one as the
 * other would delete the page.
 */
export async function liveIds(): Promise<LiveIds> {
  const byTable = new Map<string, Set<string>>();
  const read: string[] = [];
  const failed: { table: string; reason: string }[] = [];
  const unreached: string[] = [];
  const started = Date.now();
  for (const t of [...CODEX_TABLES.map((t) => ({ table: t.table, label: t.label })), { table: LAYER0.table, label: LAYER0.label }]) {
    if (Date.now() - started > PASS_BUDGET_MS) {
      unreached.push(t.table);
      continue;
    }
    try {
      const ids = await airtable.listRecordIds(airtable.SUBMISSIONS_BASE_ID, t.table, READ_TIMEOUT_MS);
      byTable.set(t.table, new Set(ids));
      read.push(t.table);
    } catch (e) {
      failed.push({ table: t.table, reason: why(e).reason });
    }
  }
  return { byTable, read, failed, unreached };
}

/** Every table a resync or a reconciliation walks: the six builder tables, then Layer 0. */
export function allTables(): { table: string; label: string; owner: string | null }[] {
  return [...CODEX_TABLES.map((t) => ({ table: t.table, label: t.label, owner: t.owner })), { table: LAYER0.table, label: LAYER0.label, owner: null }];
}

/**
 * Every record in every table, whole, for a resync.
 *
 * A different budget from `liveIds` on purpose. That one runs while a page
 * loads and is bounded to seconds; this one runs because somebody pressed a
 * button and is waiting for an answer, so it is allowed to take the time seven
 * tables of full records actually take.
 */
const RESYNC_READ_TIMEOUT_MS = 20_000;
const RESYNC_BUDGET_MS = 120_000;

export interface LiveRecords {
  byTable: Map<string, AtRecord[]>;
  read: string[];
  failed: { table: string; reason: string }[];
  unreached: string[];
}

export async function liveRecords(): Promise<LiveRecords> {
  const byTable = new Map<string, AtRecord[]>();
  const read: string[] = [];
  const failed: { table: string; reason: string }[] = [];
  const unreached: string[] = [];
  const started = Date.now();
  for (const t of allTables()) {
    if (Date.now() - started > RESYNC_BUDGET_MS) {
      unreached.push(t.table);
      continue;
    }
    try {
      byTable.set(t.table, await airtable.listRecords(airtable.SUBMISSIONS_BASE_ID, t.table, RESYNC_READ_TIMEOUT_MS));
      read.push(t.table);
    } catch (e) {
      failed.push({ table: t.table, reason: why(e).reason });
    }
  }
  return { byTable, read, failed, unreached };
}

/** The label a table is known by, for a sentence a person reads. Covers Layer 0, which is not a builder. */
export function tableLabel(table: string): string {
  if (table === LAYER0.table) return LAYER0.label;
  return CODEX_TABLES.find((t) => t.table === table)?.label ?? table;
}

export { CODEX_BASE, CODEX_TABLES };
