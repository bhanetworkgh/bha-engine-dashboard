/**
 * Every execution of every workflow, stored one row per execution.
 *
 * **This replaced two counter tables, and it replaced them because counters
 * were the fault.** The first shipped version kept a total per workflow per
 * month, the second a total per workflow per day, and both were wrong on the
 * live page in ways that had nothing to do with the arithmetic on screen: every
 * figure read exactly sixty times what n8n held, failures read nought, and
 * seven workflows of thirty-one appeared. One paging bug in the reader caused
 * all three — see `n8n.executionsAfter` — and a counter has no way to notice
 * that it is being told the same execution twice.
 *
 * Keyed on n8n's own execution id, none of those faults is expressible. Reading
 * the same page twice is an upsert that changes nothing. A failure is a row
 * whose `status` is `error` or `crashed`, or it is not there. A month is a
 * `GROUP BY`. There is no watermark arithmetic and nothing accumulates.
 *
 * **Why the rows are copied here at all**, given they can be read from n8n: not
 * because n8n discards them. That was asserted here on 15 Sep and never
 * verified — the instance's history begins on 12 Sep because that is when it
 * was migrated, and nothing has been observed ageing off. The real reason is
 * that a record of the engine's history should not depend on another system's
 * retention policy, whatever that policy turns out to be. What is here stays
 * here.
 *
 * **New executions arrive by poll, not by push.** n8n has no completion
 * webhook, and the alternative — a reporting node added to each workflow —
 * makes every workflow somebody forgets to instrument a silent gap, which is
 * the failure this dashboard exists to remove. So every 45 seconds this reads
 * what is above the highest id it holds. The page says so plainly; it is not
 * live.
 *
 * A workflow's system comes from the workflow registry **at read time**, by
 * join, so pointing a workflow at a system is a registry edit that re-files its
 * whole history rather than only its future. A workflow no registry row claims
 * is not dropped and not guessed at: it is counted in All systems and listed
 * under Archived, which is a tab rather than a footnote, because a workflow
 * must never be invisible because a registry row is missing.
 */
import { getMeta, nowIso, setMeta } from './db';
import { query } from './pg';
import * as events from './events';
import { delta, movement } from './delta';
import * as n8n from './n8n';
import type {
  ExecutionComparison,
  ExecutionGrain,
  ExecutionPeriod,
  ExecutionRun,
  ExecutionSystem,
  ExecutionWorkflow,
  ExecutionWorkflowDetail,
  ExecutionsData,
  MonthCoverage,
  MonthlyBoundary,
} from '../../src/data/types';

/** When the last poll finished, for the line every page prints. */
const SYNC_AT = 'executions.synced_at';
/** What the last pass had to report about itself, where it was not clean. */
const SYNC_WARNING = 'executions.warning';
/** When the history was last read whole, rather than from the highest id held. */
const BACKFILL_AT = 'executions.backfilled_at';
/** Set once the full re-read that recovers the runs the old watermark skipped has run. */
const GAP_BACKFILL = 'executions.gap_backfill_2026_09_22';

/**
 * How far below the highest id held every poll reads again (2026-09-22).
 *
 * n8n's list leaves out a run that is still going. The poll used to stop at the
 * highest id it held, so a long run — an agent turn of a minute or more — was
 * passed over for good the moment a later, shorter run finished first and moved
 * the watermark past it. On 22 Sep this database held 13,451 executions where
 * n8n held 13,771, and every one of the ten missing from 12:00–17:00 that day
 * was a run of 39 seconds or more. Reading the last 400 ids again on every
 * pass — two pages, an upsert, so it changes nothing twice — catches any run
 * that finishes within a few hours of starting.
 */
const LOOKBACK_IDS = 400;

/** Every system with a tab of its own, in the order the page draws them. */
export const SYSTEMS: { system: string; label: string }[] = [
  { system: 'Bays', label: 'Bays' },
  { system: 'North Star Twin', label: 'North Star' },
  { system: 'Research Twin', label: 'Research Twin' },
];

/** The key for "every system at once", which is what the page opens on. */
export const ALL = 'all';
/** The bucket for a workflow the registry names no system for. A tab, not a footnote. */
export const UNREGISTERED = 'unregistered';

/** How often new executions are read. A poll — n8n has nothing to push. */
export const POLL_EVERY_MS = 45_000;
/** How long a cached set of workflow names is good for. Names change rarely; ids never. */
const NAMES_FOR_MS = 10 * 60 * 1000;
/** Unfinished rows re-read per pass, oldest first. More than this and the pass would stall on lookups. */
const RESOLVE_PER_PASS = 100;
/** Rows written per statement. Keeps a backfill to a handful of round trips. */
const CHUNK = 500;

/* ------------------------------------------------------------------ write */

export interface SyncResult {
  ran: boolean;
  at: string;
  ms: number;
  /** Executions the walk read from n8n. */
  read: number;
  inserted: number;
  updated: number;
  /** Rows that had not finished before and have now, resolved by id. */
  resolved: number;
  /** Rows still not finished after this pass. */
  open: number;
  highest: number | null;
  pages: number;
  full: boolean;
  /** How many executions this database holds after the pass. */
  held: number;
  /** How many n8n says it holds. Null where it did not say. */
  reported: number | null;
  note: string;
  /** Anything that makes the pass less than complete: a stalled cursor, a page ceiling, a failed read. */
  warning: string | null;
}

let names: { at: number; byId: Map<string, string> } = { at: 0, byId: new Map() };

/** Workflow names, for rows whose workflow the registry does not carry. Cached; ids are what matter. */
async function workflowNames(force = false): Promise<Map<string, string>> {
  if (!force && names.at && Date.now() - names.at < NAMES_FOR_MS) return names.byId;
  try {
    const r = await n8n.workflows();
    names = { at: Date.now(), byId: new Map(r.workflows.map((w) => [w.id, w.name])) };
  } catch (e) {
    // A name is a nicety; an id is the fact. A failed read keeps whatever was
    // cached and says so once, rather than failing the pass.
    console.error(`executions: could not read workflow names — ${e instanceof Error ? e.message : String(e)}`);
  }
  return names.byId;
}

/** The registry's own name for a workflow, which wins over n8n's where it exists. */
async function registryNames(): Promise<Map<string, string>> {
  const r = await query<{ id: string; name: string }>(`SELECT id, name FROM registry_workflows WHERE deleted_at IS NULL`);
  return new Map(r.rows.map((x) => [String(x.id), String(x.name)]));
}

function durationOf(e: n8n.N8nExecution): number | null {
  if (!e.startedAt || !e.stoppedAt) return null;
  const ms = Date.parse(e.stoppedAt) - Date.parse(e.startedAt);
  // Null, never nought: a run of unknown length and a run of no length are
  // different facts, and an average must not be dragged down by the first.
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Writes executions into the table, keyed on the execution id.
 *
 * Returns how many rows were new. `xmax = 0` is true only for a row this
 * statement inserted, which is how an insert is told from an update without a
 * second query.
 */
async function put(rows: n8n.N8nExecution[], name: (id: string, fallback: string) => string, at: string): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((e, n) => {
      const b = n * 10;
      values.push(
        Number(e.id),
        String(e.workflowId),
        name(String(e.workflowId), String(e.workflowId)),
        String(e.status),
        e.mode ?? null,
        (e.startedAt as string).slice(0, 10),
        e.startedAt,
        e.stoppedAt ?? null,
        durationOf(e),
        at,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 10})`;
    });
    const r = await query<{ inserted: boolean }>(
      `INSERT INTO engine_execution_runs
         (execution_id, workflow_id, workflow_name, status, mode, day, started_at, stopped_at, duration_ms, first_seen_at, updated_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (execution_id) DO UPDATE SET
         workflow_id   = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status        = EXCLUDED.status,
         mode          = COALESCE(EXCLUDED.mode, engine_execution_runs.mode),
         day           = EXCLUDED.day,
         started_at    = EXCLUDED.started_at,
         stopped_at    = EXCLUDED.stopped_at,
         duration_ms   = EXCLUDED.duration_ms,
         updated_at    = EXCLUDED.updated_at
       RETURNING (xmax = 0) AS inserted`,
      values,
    );
    for (const row of r.rows) (row.inserted ? inserted++ : updated++);
  }
  if (inserted || updated) events.changed('executions');
  return { inserted, updated };
}

/**
 * Reads n8n and stores what it finds.
 *
 * `full` reads the whole history the instance holds; otherwise the walk stops
 * at the highest id already stored. Either way it is an upsert on the execution
 * id, so a full pass and a poll cannot disagree and running both changes
 * nothing twice.
 */
export async function sync(full = false): Promise<SyncResult> {
  const started = Date.now();
  const at = nowIso();
  const blank: SyncResult = { ran: false, at, ms: 0, read: 0, inserted: 0, updated: 0, resolved: 0, open: 0, highest: null, pages: 0, full, held: 0, reported: null, note: '', warning: null };
  if (!n8n.n8nConfigured()) {
    return { ...blank, note: `${n8n.N8N_API_VAR} is not set on this server, so no execution has ever been read.` };
  }

  const held = await query<{ highest: string | null }>(`SELECT max(execution_id)::text AS highest FROM engine_execution_runs`);
  const from = full ? 0 : Math.max(0, Number(held.rows[0]?.highest ?? 0) - LOOKBACK_IDS);

  let read: n8n.ExecutionRead;
  try {
    read = await n8n.executionsAfter(from);
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    console.error(`executions sync: ${note}`);
    await setMeta(SYNC_WARNING, `The last read of n8n failed at ${at}: ${note}`);
    return { ...blank, ms: Date.now() - started, note, warning: note };
  }

  const reg = await registryNames();
  const n8nNames = await workflowNames(full);
  const name = (id: string, fallback: string) => reg.get(id) ?? n8nNames.get(id) ?? fallback;

  // An execution with no start time cannot be placed on a day and is not filed
  // under today to make it fit. It is named rather than dropped silently.
  const usable = read.executions.filter((e) => Boolean(e.startedAt));
  const undated = read.executions.length - usable.length;
  const { inserted, updated } = usable.length ? await put(usable, name, at) : { inserted: 0, updated: 0 };

  /**
   * Anything stored without a final status, read again one at a time.
   *
   * The row is its own to-do list: there is no separate list of ids to keep in
   * step with it. An execution n8n no longer has cannot be resolved and is
   * marked `unknown` — which is what it is. Nothing guesses at how it ended.
   */
  const openRows = await query<{ execution_id: string }>(
    `SELECT execution_id::text AS execution_id FROM engine_execution_runs
      WHERE status NOT IN ('success','error','crashed','canceled','unknown')
      ORDER BY execution_id ASC LIMIT $1`,
    [RESOLVE_PER_PASS],
  );
  let resolved = 0;
  for (const row of openRows.rows) {
    try {
      const e = await n8n.execution(row.execution_id);
      if (!e) {
        await query(`UPDATE engine_execution_runs SET status = 'unknown', updated_at = $2 WHERE execution_id = $1`, [Number(row.execution_id), at]);
        events.changed('executions', Number(row.execution_id));
        continue;
      }
      if (!e.startedAt) continue;
      await put([e], name, at);
      if (n8n.TERMINAL.has(e.status)) resolved++;
    } catch {
      // A read that failed is not an outcome. It stays open and is tried again.
    }
  }

  const after = await query<{ open: string; highest: string | null; lowest: string | null; held: string; workflows: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status NOT IN ('success','error','crashed','canceled','unknown'))::text AS open,
            max(execution_id)::text AS highest,
            min(execution_id)::text AS lowest,
            count(*)::text AS held,
            count(DISTINCT workflow_id)::text AS workflows,
            count(*) FILTER (WHERE status IN ('error','crashed'))::text AS failed
       FROM engine_execution_runs`,
  );
  const open = Number(after.rows[0]?.open ?? 0);
  const highest = after.rows[0]?.highest ? Number(after.rows[0].highest) : null;
  const lowest = after.rows[0]?.lowest ? Number(after.rows[0].lowest) : null;
  const heldNow = Number(after.rows[0]?.held ?? 0);
  const workflowsHeld = Number(after.rows[0]?.workflows ?? 0);
  const failedHeld = Number(after.rows[0]?.failed ?? 0);

  /**
   * How much of n8n's id sequence is here.
   *
   * n8n's execution ids are a single increasing sequence, so the span between
   * the oldest and newest id held says how many executions could exist in that
   * range, and the difference from what is held is how many are missing from
   * it — deleted in n8n, or never read. It is a statement this database can
   * make on its own, without asking a second system for a total and trusting
   * that both are looking at the same set.
   */
  const span = lowest !== null && highest !== null ? highest - lowest + 1 : 0;
  const gaps = span ? span - heldNow : 0;

  /**
   * The pass checking itself against n8n's own total.
   *
   * Holding **more** than n8n reports is expected and is the point: rows stay
   * here after n8n stops returning them. Holding **fewer** means something was
   * not read, and that is worth saying rather than leaving a plausible-looking
   * total on the page.
   *
   * Every pass can make this comparison, not only a full one: the total comes
   * from the `count` n8n returns on the first page, which every pass fetches
   * whether or not there is anything new above the watermark. So a database
   * that has fallen behind says so within 45 seconds rather than at the next
   * backfill somebody remembers to run.
   */
  const shortBy = read.reported !== null && heldNow < read.reported ? read.reported - heldNow : 0;

  const warning =
    shortBy
      ? `n8n reports holding ${read.reported} executions and this database holds ${heldNow} — ${shortBy} short. Something has not been read; the figures below are of what is here, not of what ran. Reading n8n again fills the gap.`
      : read.stalled
      ? `n8n's paging did not advance: page ${read.pages} of this read came back no older than the one before it, so this pass saw only what it could reach. Nothing was double counted — rows are keyed on the execution id — but there may be executions this database has not seen.`
      : read.truncated
        ? `The read stopped at its ${read.pages}-page ceiling before reaching the ids already held, so there may be more above what was stored. The next pass continues from the highest id stored.`
        : undated
          ? `${undated} execution${undated === 1 ? '' : 's'} came back with no start time and could not be placed on a day, so ${undated === 1 ? 'it was' : 'they were'} not stored.`
          : null;

  await setMeta(SYNC_AT, at);
  await setMeta(SYNC_WARNING, warning ?? '');
  if (full) await setMeta(BACKFILL_AT, at);

  const note =
    `${read.executions.length} read from n8n over ${read.pages} page${read.pages === 1 ? '' : 's'}, ` +
    `${inserted} new, ${updated} already held${resolved ? `, ${resolved} that had not finished before now resolved` : ''}${open ? `, ${open} still running` : ''}. ` +
    `This database now holds ${heldNow} across ${workflowsHeld} workflow${workflowsHeld === 1 ? '' : 's'}, ${failedHeld} of them failed` +
    `${lowest !== null && highest !== null ? `, ids ${lowest} to ${highest}${gaps ? ` with ${gaps} of that range not here` : ' with no gaps'}` : ''}` +
    `${read.reported === null ? '' : `; n8n reports holding ${read.reported}`}.`;
  // Logged when something happened, when a pass is short of n8n, and on every
  // full read — a quiet poll that found nothing new and agrees with n8n has
  // nothing to say and says nothing.
  if (inserted || resolved || full || shortBy) console.log(`executions ${full ? 'backfill' : 'sync'}: ${note}${warning ? ` ${warning}` : ''}`);

  return { ran: true, at, ms: Date.now() - started, read: read.executions.length, inserted, updated, resolved, open, highest, pages: read.pages, full, held: heldNow, reported: read.reported, note, warning };
}

/* ------------------------------------------------------------------ poll */

let timer: NodeJS.Timeout | null = null;
let running: Promise<SyncResult> | null = null;

/** One pass at a time, whoever asks. Two at once would waste the read, not corrupt it. */
export function runSync(full = false): Promise<SyncResult> {
  if (!running) {
    running = sync(full).finally(() => {
      running = null;
    });
  }
  return running;
}

/**
 * Starts the poll.
 *
 * The first pass is a full read where nothing is held yet, so a fresh database
 * fills itself with everything n8n has rather than starting from today.
 */
export function startPolling(): void {
  if (timer) return;
  void (async () => {
    try {
      const held = await query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_execution_runs`);
      // A full read once more, after the watermark fix, to recover the runs the
      // old poll skipped. Recorded, so it happens on one boot and not on every one.
      const recover = !(await getMeta(GAP_BACKFILL));
      await runSync(Number(held.rows[0]?.n ?? 0) === 0 || recover);
      if (recover) await setMeta(GAP_BACKFILL, nowIso());
    } catch (e) {
      console.error('executions first pass failed', e);
    }
  })();
  timer = setInterval(() => void runSync().catch((e) => console.error('executions poll failed', e)), POLL_EVERY_MS);
  // Never hold the process open for this.
  timer.unref?.();
}

export function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/* --------------------------------------------------------------- calendar */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
}

/** ISO week, Monday-based, the same rule sources.ts uses for record weeks. */
function isoWeek(day: string): string {
  const d = utc(day);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y = d.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const w = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** The Monday of the ISO week a day falls in. */
function weekStart(day: string): string {
  const d = utc(day);
  const dow = d.getUTCDay() || 7;
  return addDays(day, 1 - dow);
}

function keyOf(grain: ExecutionGrain, day: string): string {
  if (grain === 'week') return isoWeek(day);
  if (grain === 'month') return day.slice(0, 7);
  return day.slice(0, 4);
}

function boundsOf(grain: ExecutionGrain, day: string): { start: string; end: string } {
  if (grain === 'week') {
    const start = weekStart(day);
    return { start, end: addDays(start, 6) };
  }
  if (grain === 'month') {
    const start = `${day.slice(0, 7)}-01`;
    const d = utc(start);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return { start, end: addDays(dayOf(d), -1) };
  }
  const y = day.slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function labelOf(grain: ExecutionGrain, start: string, spansYears = false): string {
  if (grain === 'week') {
    const [, m, d] = start.split('-');
    return `${Number(d)} ${MONTH_NAMES[Number(m) - 1]}`;
  }
  // "Aug 26" beside a week label of "24 Aug" reads as a date rather than a
  // month and a year, so the year only appears where the span crosses one.
  if (grain === 'month') return spansYears ? `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${start.slice(2, 4)}` : MONTH_NAMES[Number(start.slice(5, 7)) - 1];
  return start.slice(0, 4);
}

/** The previous period of the same grain. */
function previousOf(grain: ExecutionGrain, start: string): string {
  if (grain === 'week') return addDays(start, -7);
  if (grain === 'month') {
    const d = utc(start);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return dayOf(d);
  }
  return `${Number(start.slice(0, 4)) - 1}-01-01`;
}

/** Every period of this grain from the first day held to today, with no gaps. */
function spanOf(grain: ExecutionGrain, first: string, today: string): { key: string; start: string; end: string }[] {
  const out: { key: string; start: string; end: string }[] = [];
  let cursor = boundsOf(grain, first).start;
  const last = boundsOf(grain, today).start;
  // A hard ceiling so a bad `first` cannot spin: 520 weeks is ten years.
  for (let i = 0; i < 520 && cursor <= last; i++) {
    const b = boundsOf(grain, cursor);
    out.push({ key: keyOf(grain, cursor), start: b.start, end: b.end });
    cursor = grain === 'week' ? addDays(b.end, 1) : grain === 'month' ? addDays(b.end, 1) : `${Number(cursor.slice(0, 4)) + 1}-01-01`;
  }
  return out;
}

/* ------------------------------------------------------------------ reads */

/** n8n's own statuses, sorted into the four things a reader wants to know. */
const SUCCEEDED = new Set(['success']);
const CANCELED = new Set(['canceled']);

interface Tally {
  executions: number;
  succeeded: number;
  failed: number;
  canceled: number;
  unfinished: number;
  duration_ms: number;
  timed: number;
}

function blankTally(): Tally {
  return { executions: 0, succeeded: 0, failed: 0, canceled: 0, unfinished: 0, duration_ms: 0, timed: 0 };
}

function add(t: Tally, status: string, n: number, ms: number, timed: number): void {
  t.executions += n;
  if (n8n.FAILED.has(status)) t.failed += n;
  else if (SUCCEEDED.has(status)) t.succeeded += n;
  else if (CANCELED.has(status)) t.canceled += n;
  else t.unfinished += n;
  t.duration_ms += ms;
  t.timed += timed;
}

/**
 * The figures a tally produces.
 *
 * The failure rate is failures over **finished** runs, not over every row: an
 * execution still running has not failed and has not succeeded, and counting it
 * in the denominator would report a lower failure rate the busier the moment.
 */
function figures(t: Tally) {
  const finished = t.succeeded + t.failed + t.canceled;
  return {
    executions: t.executions,
    succeeded: t.succeeded,
    failed: t.failed,
    canceled: t.canceled,
    unfinished: t.unfinished,
    finished,
    failure_rate: finished ? t.failed / finished : null,
    avg_ms: t.timed ? Math.round(t.duration_ms / t.timed) : null,
    timed: t.timed,
  };
}

function ms(n: number | null): string {
  if (n === null) return 'unknown';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${Math.round(n / 100) / 10} s`;
  return `${Math.floor(n / 60_000)} m ${Math.round((n % 60_000) / 1000)} s`;
}

interface DayRow {
  day: string;
  system: string | null;
  status: string;
  n: number;
  duration_ms: number;
  timed: number;
}

/** Per day, per system, per status, from a day onwards. One query feeds every chart on the page. */
async function dayRows(from: string): Promise<DayRow[]> {
  const r = await query<{ day: string; system: string | null; status: string; n: string; duration_ms: string; timed: string }>(
    `SELECT e.day,
            w.system,
            e.status,
            count(*)::text                            AS n,
            COALESCE(sum(e.duration_ms), 0)::text     AS duration_ms,
            count(e.duration_ms)::text                AS timed
       FROM engine_execution_runs e
       LEFT JOIN registry_workflows w ON w.id = e.workflow_id AND w.deleted_at IS NULL
      WHERE e.day >= $1
      GROUP BY e.day, w.system, e.status`,
    [from],
  );
  return r.rows.map((x) => ({ day: x.day, system: x.system, status: x.status, n: Number(x.n), duration_ms: Number(x.duration_ms), timed: Number(x.timed) }));
}

interface WorkflowRow {
  workflow_id: string;
  workflow_name: string;
  system: string | null;
  registered: boolean;
  n8n_url: string | null;
  status: string;
  n: number;
  duration_ms: number;
  timed: number;
}

/** Per workflow, per status, inside one period. Only the period on screen is asked for. */
async function workflowRows(start: string, end: string): Promise<WorkflowRow[]> {
  const r = await query<{
    workflow_id: string;
    workflow_name: string | null;
    reg_name: string | null;
    system: string | null;
    n8n_url: string | null;
    status: string;
    n: string;
    duration_ms: string;
    timed: string;
  }>(
    `SELECT e.workflow_id,
            max(e.workflow_name)                      AS workflow_name,
            w.name                                    AS reg_name,
            w.system,
            w.n8n_url,
            e.status,
            count(*)::text                            AS n,
            COALESCE(sum(e.duration_ms), 0)::text     AS duration_ms,
            count(e.duration_ms)::text                AS timed
       FROM engine_execution_runs e
       LEFT JOIN registry_workflows w ON w.id = e.workflow_id AND w.deleted_at IS NULL
      WHERE e.day >= $1 AND e.day <= $2
      GROUP BY e.workflow_id, w.name, w.system, w.n8n_url, e.status`,
    [start, end],
  );
  return r.rows.map((x) => ({
    workflow_id: x.workflow_id,
    workflow_name: x.reg_name ?? x.workflow_name ?? x.workflow_id,
    system: x.system,
    registered: x.reg_name !== null,
    n8n_url: x.n8n_url,
    status: x.status,
    n: Number(x.n),
    duration_ms: Number(x.duration_ms),
    timed: Number(x.timed),
  }));
}

/** The failing execution ids inside one period, newest first, so each opens in n8n. */
async function failedIds(start: string, end: string, limit = 500): Promise<Map<string, string[]>> {
  const r = await query<{ workflow_id: string; execution_id: string }>(
    `SELECT workflow_id, execution_id::text AS execution_id
       FROM engine_execution_runs
      WHERE day >= $1 AND day <= $2 AND status IN ('error','crashed')
      ORDER BY execution_id DESC
      LIMIT $3`,
    [start, end, limit],
  );
  const out = new Map<string, string[]>();
  for (const row of r.rows) out.set(row.workflow_id, [...(out.get(row.workflow_id) ?? []), row.execution_id]);
  return out;
}

/** How many finished runs "recent" means. Ten is enough to see a fix hold, few enough that one bad afternoon ages out. */
export const RECENT_RUNS = 10;

/**
 * Each workflow's recent health, **whatever the period in view** (2026-09-22,
 * Destiny). A month's failure rate is honest and can still mislead: Bays —
 * Error Handler read 63% for September because 127 runs failed in one sixteen-
 * hour window when Airtable's cap hit, and every run since has succeeded. So
 * beside the month's rate, each workflow carries its last ten finished runs,
 * when it last failed, and how many have succeeded since — a fixed workflow
 * stops reading as a broken one without the month's figure being touched.
 */
async function recentHealth(): Promise<Map<string, ExecutionWorkflow['recent']>> {
  const r = await query<{ workflow_id: string; n: string; failed: string; last_failure_at: string | null; since_failure: string; last_run_at: string | null }>(
    `WITH finished AS (
       SELECT workflow_id, started_at, status IN ('error','crashed') AS bad,
              row_number() OVER (PARTITION BY workflow_id ORDER BY started_at DESC) AS rn
         FROM engine_execution_runs
        WHERE status IN ('success','error','crashed')
     ), lastfail AS (
       SELECT workflow_id, max(started_at) AS at FROM finished WHERE bad GROUP BY workflow_id
     )
     SELECT f.workflow_id,
            count(*) FILTER (WHERE f.rn <= $1)::text AS n,
            count(*) FILTER (WHERE f.rn <= $1 AND f.bad)::text AS failed,
            max(l.at) AS last_failure_at,
            count(*) FILTER (WHERE NOT f.bad AND (l.at IS NULL OR f.started_at > l.at))::text AS since_failure,
            max(f.started_at) AS last_run_at
       FROM finished f LEFT JOIN lastfail l USING (workflow_id)
      GROUP BY f.workflow_id`,
    [RECENT_RUNS],
  );
  return new Map(
    r.rows.map((x) => [
      x.workflow_id,
      { runs: Number(x.n), failed: Number(x.failed), last_failure_at: x.last_failure_at, succeeded_since_failure: Number(x.since_failure), last_run_at: x.last_run_at },
    ]),
  );
}

interface Held {
  rows: number;
  oldest: string | null;
  newest: string | null;
  highest: string | null;
}

async function held(): Promise<Held> {
  const r = await query<{ rows: string; oldest: string | null; newest: string | null; highest: string | null }>(
    `SELECT count(*)::text AS rows, min(day) AS oldest, max(day) AS newest, max(execution_id)::text AS highest FROM engine_execution_runs`,
  );
  const x = r.rows[0];
  return { rows: Number(x?.rows ?? 0), oldest: x?.oldest ?? null, newest: x?.newest ?? null, highest: x?.highest ?? null };
}

/**
 * The boundary every execution chart labels: the first period held whole.
 *
 * Not a claim about retention. It says what this database holds and from when —
 * the instance's own history begins on the oldest day here — and leaves the
 * reason to the page, which does not assert one.
 */
function boundary(grain: ExecutionGrain, oldest: string | null): MonthlyBoundary | null {
  if (!oldest) return null;
  const b = boundsOf(grain, oldest);
  const nextStart = addDays(b.end, 1);
  const word = grain === 'week' ? 'week' : grain === 'month' ? 'month' : 'year';
  return {
    month: keyOf(grain, nextStart),
    note:
      `This database holds every execution from ${oldest} onwards, which is as far back as the n8n instance's own history goes. ` +
      `The ${word} it falls in is therefore part of one, and ${labelOf(grain, nextStart)} is the first complete ${word}.`,
  };
}

export function isGrain(v: string): v is ExecutionGrain {
  return v === 'week' || v === 'month' || v === 'year';
}

/** How many periods the chart draws. Enough to see a trend, few enough to read. */
const SHOWN = 18;

export async function read(grain: ExecutionGrain = 'week', wanted?: string): Promise<ExecutionsData> {
  const h = await held();
  const syncedAt = await getMeta(SYNC_AT);
  const warning = (await getMeta(SYNC_WARNING)) || null;
  const today = nowIso().slice(0, 10);
  const first = h.oldest ?? today;
  const periods = spanOf(grain, first, today);
  const spansYears = new Set(periods.map((p) => p.start.slice(0, 4))).size > 1;
  const currentKey = keyOf(grain, today);

  // The period in view: whatever was asked for if it exists, else the one
  // running now. Every figure, the workflow table, the comparison and the
  // export all follow this one selection.
  const selected = periods.find((p) => p.key === wanted) ?? periods.find((p) => p.key === currentKey) ?? periods[periods.length - 1];
  const previousStart = boundsOf(grain, previousOf(grain, selected.start)).start;

  // Only as far back as the chart and the comparison actually need.
  const windowStart = [periods[Math.max(0, periods.length - SHOWN)].start, previousStart].sort()[0];
  const days = await dayRows(windowStart);
  const wfRows = await workflowRows(selected.start, selected.end);
  const failing = await failedIds(selected.start, selected.end);
  const recent = await recentHealth();

  // Which tabs exist: the three known systems, then anything else the registry
  // has filed a running workflow under, then Archived where anything is
  // unclaimed. A system with a tab and no rows still draws, because its absence
  // is itself worth seeing; one with rows and no tab would be invisible, which
  // is the thing that must never happen.
  const seen = new Set<string>();
  for (const d of days) seen.add(d.system ?? UNREGISTERED);
  for (const w of wfRows) seen.add(w.system ?? UNREGISTERED);
  const known = new Set(SYSTEMS.map((s) => s.system));
  const extra = [...seen].filter((s) => s !== UNREGISTERED && !known.has(s)).sort();
  const tabs = [
    { system: ALL, label: 'All systems' },
    ...SYSTEMS,
    ...extra.map((s) => ({ system: s, label: s })),
    /**
     * **"Archived", not "Unregistered"** (2026-09-16, Destiny, who checked the
     * workflows this tab was holding and found every one of them archived in
     * n8n).
     *
     * The test behind it is unchanged and is still *the workflow registry has
     * no row for this workflow*, because this server does not read n8n's own
     * archived flag — `GET /api/v1/workflows` is read for names only. So the
     * label is Destiny's verified reading of what currently lands here rather
     * than something the data itself knows, and a live workflow nobody has
     * registered would land here too and be mislabelled. Reading `isArchived`
     * and filing on that is the honest version and is the next change to make
     * here.
     */
    ...(seen.has(UNREGISTERED) ? [{ system: UNREGISTERED, label: 'Archived' }] : []),
  ];

  const mine = (system: string) => (row: { system: string | null }) =>
    system === ALL ? true : system === UNREGISTERED ? row.system === null : row.system === system;

  const tallyDays = (system: string, from: string, to: string): Tally => {
    const t = blankTally();
    for (const d of days) {
      if (d.day < from || d.day > to) continue;
      if (!mine(system)(d)) continue;
      add(t, d.status, d.n, d.duration_ms, d.timed);
    }
    return t;
  };

  const buildSystem = (system: string, label: string): ExecutionSystem => {
    const built: ExecutionPeriod[] = periods.map((p) => {
      const inWindow = p.start >= windowStart;
      const f = figures(inWindow ? tallyDays(system, p.start, p.end) : blankTally());
      const current = p.key === currentKey;
      let coverage: MonthCoverage = 'full';
      let note: string | null = null;
      if (!h.oldest || p.end < h.oldest) {
        coverage = 'none';
        note = h.oldest
          ? `This database holds no execution before ${h.oldest}, so there is no figure for this ${grain} rather than a figure of nought.`
          : 'Nothing has been read from n8n yet, so there is no figure for this period rather than a figure of nought.';
      } else if (p.start < h.oldest) {
        coverage = 'partial';
        note = `Only the part of this ${grain} from ${h.oldest}, which is as far back as n8n's own history goes.`;
      } else if (!inWindow) {
        // Outside the window this read asked for. Not drawn as nought — it is
        // simply not in this answer, and the chart shows the last 18 anyway.
        coverage = 'none';
        note = `Outside the ${SHOWN} ${grain}s this page reads.`;
      } else if (current) {
        coverage = 'partial';
        note = `This ${grain} is still running.`;
      }
      return { key: p.key, label: labelOf(grain, p.start, spansYears), start: p.start, end: p.end, ...f, coverage, note, current };
    });

    const period = built.find((p) => p.key === selected.key) ?? built[built.length - 1];
    const t = figures(tallyDays(system, selected.start, selected.end));

    /**
     * The weeks inside the period in view (2026-09-16, Destiny).
     *
     * The page shows one month at a time now, and the chart under its figures
     * shows that month's weeks. They are tallied from the **same day rows** as
     * the month's own totals, so a month and the weeks drawn under it cannot
     * disagree — the rule the whole file is built on.
     *
     * A week is cut to the period at both ends, so the first and last are
     * however many days of them fall inside the month rather than a full seven
     * counted from outside it.
     */
    const weeks: ExecutionPeriod[] = [];
    for (let cursor = selected.start; cursor <= selected.end; ) {
      const wb = boundsOf('week', cursor);
      // A week that has not started is not drawn at all. Hatching it as
      // "partly covered" said the days were only partly recorded; they have
      // not happened, which is a different thing and not worth a column.
      if (wb.start > today) break;
      const from = wb.start < selected.start ? selected.start : wb.start;
      const to = wb.end > selected.end ? selected.end : wb.end;
      const wf = figures(tallyDays(system, from, to));
      let coverage: MonthCoverage = 'full';
      let note: string | null = null;
      if (!h.oldest || to < h.oldest) {
        coverage = 'none';
        note = h.oldest
          ? `This database holds no execution before ${h.oldest}, so there is no figure for these days rather than a figure of nought.`
          : 'Nothing has been read from n8n yet.';
      } else if (from < h.oldest) {
        coverage = 'partial';
        note = `Only the part of this week from ${h.oldest}, which is as far back as this database goes.`;
      } else if (to >= today) {
        coverage = 'partial';
        note = 'These days are still running.';
      }
      weeks.push({
        key: from,
        label: `${Number(from.slice(8))}–${Number(to.slice(8))}`,
        start: from,
        end: to,
        ...wf,
        coverage,
        note,
        current: to >= today,
      });
      cursor = addDays(wb.end, 1);
    }

    // One row per workflow inside the selected period.
    const byWorkflow = new Map<string, { row: WorkflowRow; tally: Tally }>();
    for (const w of wfRows) {
      if (!mine(system)(w)) continue;
      const entry = byWorkflow.get(w.workflow_id) ?? { row: w, tally: blankTally() };
      add(entry.tally, w.status, w.n, w.duration_ms, w.timed);
      byWorkflow.set(w.workflow_id, entry);
    }
    const workflows: ExecutionWorkflow[] = [...byWorkflow.entries()]
      .map(([id, e]) => ({
        workflow_id: id,
        workflow_name: e.row.workflow_name,
        system: e.row.system,
        registered: e.row.registered,
        n8n_url: e.row.n8n_url,
        failed_ids: failing.get(id) ?? [],
        recent: recent.get(id) ?? null,
        ...figures(e.tally),
      }))
      .sort((x, y) => y.failed - x.failed || y.executions - x.executions);

    /**
     * The comparison, and the two things that make it honest.
     *
     * A period still running always has fewer executions than a finished one,
     * so comparing this week's total against the whole of last week would
     * report a collapse every Monday morning. When the period in view is the
     * current one the previous period is cut to the same elapsed point, and the
     * page says which days it used.
     *
     * And the window being compared against has to have been recorded. The test
     * is the **window's** own start, not the whole previous period: comparing
     * the first fortnight of a month against a fortnight nobody was recording
     * would read "0 → 890" and look like the engine started from nothing.
     */
    const prevBounds = boundsOf(grain, previousOf(grain, selected.start));
    const like = period.current;
    const elapsed = like ? Math.round((utc(today).getTime() - utc(selected.start).getTime()) / 86_400_000) + 1 : null;
    const cut = like && elapsed !== null ? addDays(prevBounds.start, elapsed - 1) : null;
    const winStart = prevBounds.start;
    const winEnd = cut && cut < prevBounds.end ? cut : prevBounds.end;
    const covered = Boolean(h.oldest) && winStart >= (h.oldest as string);
    const p = figures(tallyDays(system, winStart, winEnd));
    const rate = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 10);

    const executions = covered ? delta(p.executions, t.executions, null) : null;
    const successes = covered ? delta(p.succeeded, t.succeeded, 'up') : null;
    const failures = covered ? delta(p.failed, t.failed, 'down') : null;
    const failureRate = covered ? delta(rate(p.failure_rate), rate(t.failure_rate), 'down') : null;
    const avg = covered ? delta(p.avg_ms, t.avg_ms, 'down') : null;

    const againstLabel = labelOf(grain, prevBounds.start, spansYears);
    const window = like
      ? `its first ${elapsed} day${elapsed === 1 ? '' : 's'}, ${winStart} to ${winEnd}`
      : `${winStart} to ${winEnd}`;

    /**
     * The write-up, in words, because that is how somebody reads a change.
     *
     * It is generated here rather than on the page so that the downloaded
     * report and the screen cannot word the same comparison differently.
     */
    const prose = !covered
      ? h.oldest
        ? `No comparison with ${againstLabel}: this database holds nothing before ${h.oldest}, and ${winStart} to ${winEnd} is before that. Those days were not quiet, they were not recorded.`
        : `No comparison with ${againstLabel}: nothing has been read from n8n yet.`
      : t.executions === 0 && p.executions === 0
        ? `Nothing ran in ${period.label} or in ${againstLabel}.`
        : `Against ${like ? `the same point of ${againstLabel}` : againstLabel} (${window}): ` +
          [
            executions && `executions ${movement(executions)}`,
            successes && `successes ${movement(successes)}`,
            failures && `failures ${movement(failures)}`,
            failureRate && `the failure rate ${movement(failureRate, 'points')}`,
            avg && (avg.direction === 'flat' ? 'average run time unchanged' : `average run time ${avg.pct === null ? `${ms(avg.from)} → ${ms(avg.to)}` : `${Math.abs(avg.pct)}% ${avg.direction === 'down' ? 'faster' : 'slower'}`}`),
          ]
            .filter(Boolean)
            .join(', ') +
          '.';

    const comparison: ExecutionComparison = {
      against: keyOf(grain, prevBounds.start),
      against_label: againstLabel,
      executions,
      successes,
      failures,
      failure_rate: failureRate,
      avg_ms: avg,
      like_for_like: like,
      covered,
      prose,
      note: !covered
        ? h.oldest
          ? `There is nothing honest to compare against: this database holds nothing before ${h.oldest}, and ${winStart} to ${winEnd} is before that.`
          : 'There is nothing to compare against: nothing has been read from n8n yet.'
        : like
          ? `Against the same point of ${againstLabel} — ${window} — because this ${grain} is still running and a whole one would always look bigger.`
          : `Against the whole of ${againstLabel}, ${window}.`,
    };

    return { system, label, periods: built, weeks, period, workflows, comparison, ...t };
  };

  return {
    grain,
    period: selected.key,
    systems: tabs.map((s) => buildSystem(s.system, s.label)),
    boundary: boundary(grain, h.oldest),
    source: {
      at: syncedAt,
      configured: n8n.n8nConfigured(),
      poll_seconds: Math.round(POLL_EVERY_MS / 1000),
      n8n_base: n8n.n8nConfigured() ? n8n.n8nHost() : null,
      held: h.rows,
      oldest: h.oldest,
      newest: h.newest,
      highest_id: h.highest,
      warning,
      note: n8n.n8nConfigured()
        ? h.rows
          ? `Every execution n8n reports is copied into this database, one row per execution, and the page reads those rows. New ones are picked up by a poll every ${Math.round(POLL_EVERY_MS / 1000)} seconds — n8n has nothing to push, so this is not live.`
          : 'Nothing has been read from n8n yet, so these figures are empty rather than nought.'
        : `${n8n.N8N_API_VAR} is not set on this server, so no execution has ever been read and these figures are empty rather than nought.`,
    },
  };
}

/* ------------------------------------------------------- one workflow */

/**
 * One workflow's own executions inside one period: a day-by-day breakdown and
 * the individual runs, each with its id, start, duration and status.
 *
 * This is the thing a counter could not answer at all, and the reason the rows
 * are stored. A failure is not a number here, it is an id that opens in n8n.
 */
export async function workflow(workflowId: string, grain: ExecutionGrain, wanted?: string, limit = 500): Promise<ExecutionWorkflowDetail | null> {
  const h = await held();
  const today = nowIso().slice(0, 10);
  const first = h.oldest ?? today;
  const periods = spanOf(grain, first, today);
  const currentKey = keyOf(grain, today);
  const selected = periods.find((p) => p.key === wanted) ?? periods.find((p) => p.key === currentKey) ?? periods[periods.length - 1];
  const spansYears = new Set(periods.map((p) => p.start.slice(0, 4))).size > 1;

  const rows = await workflowRows(selected.start, selected.end);
  const mine = rows.filter((r) => r.workflow_id === workflowId);

  // A workflow with nothing in this period is still a workflow: its name and
  // its system come back so the panel can say "nothing ran" rather than 404.
  const idRow = await query<{ workflow_name: string | null; reg_name: string | null; system: string | null; n8n_url: string | null }>(
    `SELECT max(e.workflow_name) AS workflow_name, max(w.name) AS reg_name, max(w.system) AS system, max(w.n8n_url) AS n8n_url
       FROM engine_execution_runs e
       LEFT JOIN registry_workflows w ON w.id = e.workflow_id AND w.deleted_at IS NULL
      WHERE e.workflow_id = $1`,
    [workflowId],
  );
  if (!idRow.rows[0]?.workflow_name && !mine.length) return null;

  const tally = blankTally();
  for (const r of mine) add(tally, r.status, r.n, r.duration_ms, r.timed);
  const failing = (await failedIds(selected.start, selected.end, 2000)).get(workflowId) ?? [];

  const perDay = await query<{ day: string; status: string; n: string; duration_ms: string; timed: string }>(
    `SELECT day, status, count(*)::text AS n, COALESCE(sum(duration_ms),0)::text AS duration_ms, count(duration_ms)::text AS timed
       FROM engine_execution_runs
      WHERE workflow_id = $1 AND day >= $2 AND day <= $3
      GROUP BY day, status ORDER BY day ASC`,
    [workflowId, selected.start, selected.end],
  );
  const byDay = new Map<string, Tally>();
  for (const r of perDay.rows) {
    const t = byDay.get(r.day) ?? blankTally();
    add(t, r.status, Number(r.n), Number(r.duration_ms), Number(r.timed));
    byDay.set(r.day, t);
  }

  const runRows = await query<{ execution_id: string; status: string; mode: string | null; started_at: string; stopped_at: string | null; duration_ms: string | null }>(
    `SELECT execution_id::text AS execution_id, status, mode, started_at, stopped_at, duration_ms::text AS duration_ms
       FROM engine_execution_runs
      WHERE workflow_id = $1 AND day >= $2 AND day <= $3
      ORDER BY execution_id DESC LIMIT $4`,
    [workflowId, selected.start, selected.end, limit],
  );
  const runs: ExecutionRun[] = runRows.rows.map((r) => ({
    execution_id: r.execution_id,
    status: r.status,
    mode: r.mode,
    started_at: r.started_at,
    stopped_at: r.stopped_at,
    duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
  }));

  const meta = idRow.rows[0];
  return {
    workflow: {
      workflow_id: workflowId,
      workflow_name: meta?.reg_name ?? meta?.workflow_name ?? workflowId,
      system: meta?.system ?? null,
      registered: Boolean(meta?.reg_name),
      n8n_url: meta?.n8n_url ?? null,
      recent: (await recentHealth()).get(workflowId) ?? null,
      failed_ids: failing,
      ...figures(tally),
    },
    grain,
    period: { key: selected.key, label: labelOf(grain, selected.start, spansYears), start: selected.start, end: selected.end },
    days: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, t]) => ({ day, ...figures(t) })),
    runs,
    runs_total: tally.executions,
    n8n_base: n8n.n8nConfigured() ? n8n.n8nHost() : null,
  };
}
