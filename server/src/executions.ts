/**
 * n8n execution health, snapshotted into Postgres and read from there.
 *
 * **The constraint that shapes all of this: n8n's execution history does not
 * persist.** On 15 Sep 2026 the instance held 3,673 executions and none older
 * than 12 Sep — three days. Asking the API for August would get an honest
 * "nothing", and the chart would draw an empty month for a month that was
 * busy. So the API is the feed and `engine_execution_days` is the record.
 *
 * The counts are **accumulated forward, never recomputed.** Each run reads only
 * the executions above a watermark and adds them to their day's row. A period
 * whose executions have since aged out of n8n therefore keeps the count it had
 * when they existed, which is the whole point.
 *
 * **The grain is a day** (2026-09-15, Destiny). The page reports weekly,
 * monthly and yearly, and a month cannot be divided into weeks after the fact.
 * A day is the smallest period anyone asked for and every larger one is a sum
 * over days, so one table answers all three.
 *
 * Two consequences of accumulating, both deliberate:
 *
 *   - An execution still running when the job passes is not counted yet. Its id
 *     goes on a deferred list and is resolved individually later, so it is
 *     counted once, with its real outcome, and nothing above it is read twice.
 *   - Whichever day the job first ran on is partial by construction —
 *     everything before it was already ageing off or never seen. That boundary
 *     is stored and every chart that reads this labels it.
 *
 * A workflow's system comes from the workflow registry, which already holds one
 * row per workflow with its `system`. So pointing a new workflow at a system is
 * a registry edit, not a deploy — the same rule as the watched-clients index.
 * A workflow n8n reports that no registry row names is counted and listed as
 * unregistered rather than being filed under a guess.
 */
import { getMeta, nowIso, setMeta, setMetaIfAbsent } from './db';
import { query } from './pg';
import * as n8n from './n8n';
import * as registry from './registry';
import type {
  ExecutionComparison,
  ExecutionDelta,
  ExecutionGrain,
  ExecutionPeriod,
  ExecutionSystem,
  ExecutionWorkflow,
  ExecutionsData,
  MonthCoverage,
  MonthlyBoundary,
} from '../../src/data/types';

/**
 * The highest execution id already accumulated into the daily table.
 *
 * A key of its own rather than the monthly table's: `engine_executions` holds
 * months that cannot be split into days, so this starts from nought and re-reads
 * what n8n still has. That costs nothing — n8n keeps about three days and the
 * monthly table is hours old — and it leaves the old table exactly as it was,
 * unread, because nothing here drops a table.
 */
const WATERMARK = 'executions.day_watermark';
/** The first day the snapshot covers. Stamped once, on the first run that reads anything. */
const SINCE = 'executions.since_day';
/** When the snapshot last completed, for the line the pages print. */
const RAN_AT = 'executions.ran_at';
/**
 * Executions that were still running when the pass went past them, by id.
 *
 * They are **not** counted and the watermark moves past them anyway; each is
 * looked up individually on later passes until it has finished, and only then
 * counted. The obvious alternative — holding the watermark below the oldest
 * unfinished execution — was tried and is wrong twice over: everything above it
 * gets counted again on every pass (a September total of 2 read 4 after two
 * passes with nothing new), and one execution parked in `waiting` on a Wait
 * node would freeze all counting behind it indefinitely.
 */
const DEFERRED = 'executions.deferred';

/** As many unfinished executions as this will carry before it starts forgetting the oldest. */
const MAX_DEFERRED = 500;

/** Separates the two halves of a bucket key. Neither a day nor an n8n id contains one. */
const SEP = '|';

/** Every system with a tab of its own, in the order the page draws them. */
export const SYSTEMS: { system: string; label: string }[] = [
  { system: 'Bays', label: 'Bays' },
  { system: 'North Star Twin', label: 'North Star' },
  { system: 'Research Twin', label: 'Research Twin' },
];

/** The key for "every system at once", which is what the page opens on. */
export const ALL = 'all';

export interface SnapshotResult {
  ran: boolean;
  at: string;
  ms: number;
  counted: number;
  pending: number;
  watermark: number;
  truncated: boolean;
  note: string;
}

/**
 * Reads everything n8n has above the watermark and adds it to the table.
 *
 * Safe to run as often as you like: it is keyed on the execution id, so an
 * execution is counted exactly once however many times this runs.
 */
export async function snapshot(): Promise<SnapshotResult> {
  const started = Date.now();
  const at = nowIso();
  if (!n8n.n8nConfigured()) {
    return { ran: false, at, ms: 0, counted: 0, pending: 0, watermark: 0, truncated: false, note: `${n8n.N8N_API_VAR} is not set on this server, so no execution has ever been counted.` };
  }

  const from = Number((await getMeta(WATERMARK)) ?? 0);
  let read: Awaited<ReturnType<typeof n8n.executionsAfter>>;
  try {
    read = await n8n.executionsAfter(from);
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    console.error(`executions snapshot: ${note}`);
    return { ran: false, at, ms: Date.now() - started, counted: 0, pending: 0, watermark: from, truncated: false, note };
  }

  // Which system each workflow belongs to, from the registry rather than from
  // anything hardcoded here.
  const workflows = await registry.list('workflows');
  const byId = new Map<string, { name: string; system: string | null }>();
  for (const w of workflows) byId.set(String(w.id), { name: String(w.name ?? w.id), system: (w.system as string | null) ?? null });

  let highestSeen = from;
  const deferred = new Set<string>(JSON.parse((await getMeta(DEFERRED)) ?? '[]') as string[]);

  interface Bucket {
    executions: number;
    failures: number;
    duration_ms: number;
    duration_counted: number;
    failed: string[];
    name: string;
    system: string | null;
  }
  const buckets = new Map<string, Bucket>();

  const count = (e: n8n.N8nExecution): boolean => {
    // An execution with no start time cannot be placed on a day, and is not
    // filed under today to make it fit.
    if (!e.startedAt) return false;
    const day = e.startedAt.slice(0, 10);
    const known = byId.get(e.workflowId);
    const key = `${day}${SEP}${e.workflowId}`;
    const b = buckets.get(key) ?? { executions: 0, failures: 0, duration_ms: 0, duration_counted: 0, failed: [], name: known?.name ?? e.workflowId, system: known?.system ?? null };
    b.executions++;
    /**
     * Duration is kept as a sum and a count, never as an average, so a mean
     * over any span of days is exact rather than an average of averages. An
     * execution that finished without a `stoppedAt` is left out of both, so the
     * mean is always over the number of runs it says it is.
     */
    if (e.stoppedAt) {
      const ms = Date.parse(e.stoppedAt) - Date.parse(e.startedAt);
      if (Number.isFinite(ms) && ms >= 0) {
        b.duration_ms += ms;
        b.duration_counted++;
      }
    }
    if (n8n.FAILED.has(e.status)) {
      b.failures++;
      b.failed.push(e.id);
    }
    buckets.set(key, b);
    return true;
  };

  for (const e of read.executions) {
    highestSeen = Math.max(highestSeen, Number(e.id));
    if (!n8n.TERMINAL.has(e.status) || !e.startedAt) {
      deferred.add(e.id);
      continue;
    }
    count(e);
  }

  /**
   * Everything set aside on an earlier pass, looked up one at a time. Normally
   * a handful; each one either finishes and is counted exactly once, or has
   * aged out of n8n before finishing, in which case nothing knows how it ended
   * and it is dropped rather than guessed at.
   */
  let resolved = 0;
  let dropped = 0;
  for (const id of [...deferred]) {
    if (Number(id) > highestSeen) continue;
    try {
      const e = await n8n.execution(id);
      if (!e) {
        deferred.delete(id);
        dropped++;
        continue;
      }
      if (!n8n.TERMINAL.has(e.status)) continue;
      if (count(e)) resolved++;
      deferred.delete(id);
    } catch {
      // Leave it deferred; a read that failed is not an outcome.
    }
  }

  // Bounded, oldest first, so a long-lived `waiting` execution cannot grow this
  // without limit. What falls off is named in the log rather than lost quietly.
  const kept = [...deferred].sort((a, b) => Number(a) - Number(b));
  if (kept.length > MAX_DEFERRED) {
    const forgotten = kept.splice(0, kept.length - MAX_DEFERRED);
    console.error(`executions snapshot: giving up on ${forgotten.length} execution(s) that never finished — ${forgotten.slice(0, 10).join(', ')}`);
  }
  await setMeta(DEFERRED, JSON.stringify(kept));
  const pending = kept.length;

  for (const [key, b] of buckets) {
    const day = key.slice(0, key.indexOf(SEP));
    const workflowId = key.slice(key.indexOf(SEP) + 1);
    await query(
      `INSERT INTO engine_execution_days (day, workflow_id, workflow_name, system, executions, failures, duration_ms, duration_counted, failed_ids, first_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
       ON CONFLICT (day, workflow_id) DO UPDATE SET
         workflow_name    = EXCLUDED.workflow_name,
         system           = EXCLUDED.system,
         executions       = engine_execution_days.executions + EXCLUDED.executions,
         failures         = engine_execution_days.failures + EXCLUDED.failures,
         duration_ms      = engine_execution_days.duration_ms + EXCLUDED.duration_ms,
         duration_counted = engine_execution_days.duration_counted + EXCLUDED.duration_counted,
         failed_ids       = (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM (
                               SELECT v FROM jsonb_array_elements(EXCLUDED.failed_ids || engine_execution_days.failed_ids) AS t(v) LIMIT 200
                             ) s),
         updated_at       = EXCLUDED.updated_at`,
      [day, workflowId, b.name, b.system, b.executions, b.failures, b.duration_ms, b.duration_counted, JSON.stringify(b.failed.sort((x, y) => Number(y) - Number(x))), at],
    );
  }

  // The watermark moves past everything that was read, finished or not: an
  // unfinished one is on the deferred list and is resolved by id, so nothing
  // needs to be read a second time to catch it.
  const watermark = highestSeen;
  if (watermark > from) await setMeta(WATERMARK, String(watermark));
  await setMeta(RAN_AT, at);
  // The first day anything was counted on. Stamped once and never moved.
  if (buckets.size) await setMetaIfAbsent(SINCE, [...buckets.keys()].map((k) => k.slice(0, k.indexOf(SEP))).sort()[0]);

  const counted = [...buckets.values()].reduce((n, b) => n + b.executions, 0);
  const note =
    `${counted} execution${counted === 1 ? '' : 's'} counted across ${buckets.size} workflow-day${buckets.size === 1 ? '' : 's'}` +
    `${resolved ? `, ${resolved} of them finishing one that was still running earlier` : ''}` +
    `${pending ? `, ${pending} still running and set aside by id for a later pass` : ''}` +
    `${dropped ? `, ${dropped} never finished before n8n discarded ${dropped === 1 ? 'it' : 'them'} and ${dropped === 1 ? 'was' : 'were'} not counted` : ''}` +
    `${read.truncated ? '. The read hit its page limit, so there may be more above the watermark; the next pass continues from where this one stopped' : ''}.`;
  if (counted || pending) console.log(`executions snapshot: ${note} watermark ${from} -> ${watermark}`);
  return { ran: true, at, ms: Date.now() - started, counted, pending, watermark, truncated: read.truncated, note };
}

/* ------------------------------------------------------- the scheduled job */

/**
 * How often the snapshot runs.
 *
 * Cheap after the first pass: the reader walks down from the newest execution
 * and stops the moment it crosses the watermark, so an hourly run reads one
 * page. Frequent enough that a period's counts are never more than an hour
 * behind even if the process restarts.
 */
export const SNAPSHOT_EVERY_MS = 60 * 60 * 1000;

/** How stale the snapshot may be before a page read refreshes it in line. */
const STALE_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running: Promise<SnapshotResult> | null = null;

/** One at a time, whoever asks. Two passes at once would double-count nothing, but would waste the read. */
export function runSnapshot(): Promise<SnapshotResult> {
  if (!running) {
    running = snapshot().finally(() => {
      running = null;
    });
  }
  return running;
}

export function startSnapshots(): void {
  if (timer) return;
  void runSnapshot().catch((e) => console.error('executions snapshot failed', e));
  timer = setInterval(() => void runSnapshot().catch((e) => console.error('executions snapshot failed', e)), SNAPSHOT_EVERY_MS);
  // Never hold the process open for this.
  timer.unref?.();
}

export function stopSnapshots(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Brings the current period up to date before a page reads it.
 *
 * The in-progress period is allowed to be read live. Rather than a second code
 * path that could disagree with the stored one, this runs the same accumulating
 * pass and then reads the table — so there is one source for every period, and
 * the newest one is never more than a few minutes old.
 */
export async function refreshIfStale(): Promise<void> {
  if (!n8n.n8nConfigured()) return;
  const ranAt = await getMeta(RAN_AT);
  if (ranAt && Date.now() - Date.parse(ranAt) < STALE_MS) return;
  try {
    await runSnapshot();
  } catch (e) {
    // A page still renders what the table holds; it says when that was.
    console.error(`executions refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

interface Row {
  day: string;
  workflow_id: string;
  workflow_name: string | null;
  system: string | null;
  executions: number;
  failures: number;
  duration_ms: number;
  duration_counted: number;
  failed_ids: string[];
}

async function rows(): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT day, workflow_id, workflow_name, system, executions, failures, duration_ms, duration_counted, failed_ids
       FROM engine_execution_days ORDER BY day DESC`,
  );
  return r.rows.map((x) => ({
    ...x,
    executions: Number(x.executions),
    failures: Number(x.failures),
    duration_ms: Number(x.duration_ms),
    duration_counted: Number(x.duration_counted),
    failed_ids: Array.isArray(x.failed_ids) ? x.failed_ids : [],
  }));
}

/**
 * The boundary every execution chart labels: the first period the snapshot
 * covers whole.
 *
 * The period the job first ran in is partial by construction — n8n was already
 * ageing executions off before anything was counted — so the first *complete*
 * one is the next.
 */
async function boundary(grain: ExecutionGrain): Promise<MonthlyBoundary | null> {
  const since = await getMeta(SINCE);
  if (!since) return null;
  const b = boundsOf(grain, since);
  const nextStart = addDays(b.end, 1);
  const word = grain === 'week' ? 'week' : grain === 'month' ? 'month' : 'year';
  return {
    month: keyOf(grain, nextStart),
    note:
      `Execution counts begin on ${since}, which is when this dashboard started snapshotting them. ` +
      `n8n keeps roughly three days of execution history and then discards it, so nothing before ${since} was ever there to count, ` +
      `and the ${word} it falls in holds only the part of it the snapshot was running for. ${labelOf(grain, nextStart)} is the first complete ${word}.`,
  };
}

function rateOf(failures: number, executions: number): number | null {
  return executions ? failures / executions : null;
}

function meanOf(ms: number, counted: number): number | null {
  return counted ? Math.round(ms / counted) : null;
}

/**
 * One figure against the same figure last period.
 *
 * `better` says whether the movement is good news, which is not the same as up.
 * More executions is neither; more failures is bad; a faster average is good.
 */
function delta(from: number | null, to: number | null, better: 'up' | 'down' | null): ExecutionDelta | null {
  if (from === null || to === null) return null;
  const direction = to > from ? 'up' : to < from ? 'down' : 'flat';
  return {
    from,
    to,
    // A ratio against nought has no meaning, so it is null rather than infinite
    // or a hundred per cent. The two raw figures are both on the delta, so the
    // page can still say "0 → 4" where it cannot say "+400%".
    pct: from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10,
    direction,
    better: better === null || direction === 'flat' ? null : better === 'up' ? direction === 'up' : direction === 'down',
  };
}

export async function read(grain: ExecutionGrain = 'week'): Promise<ExecutionsData> {
  const all = await rows();
  const b = await boundary(grain);
  const since = await getMeta(SINCE);
  const ranAt = await getMeta(RAN_AT);
  const today = nowIso().slice(0, 10);
  const first = since ?? (all.length ? all[all.length - 1].day : today);
  const periods = spanOf(grain, first, today);
  const currentKey = keyOf(grain, today);
  const spansYears = new Set(periods.map((p) => p.start.slice(0, 4))).size > 1;

  const registered = await registry.list('workflows');
  const urlOf = new Map(registered.map((w) => [String(w.id), (w.n8n_url as string | null) ?? null]));

  /** Every row in one period, optionally cut short at a day — for the like-for-like comparison. */
  const inPeriod = (mine: Row[], p: { start: string; end: string }, until?: string) =>
    mine.filter((r) => r.day >= p.start && r.day <= (until && until < p.end ? until : p.end));

  const totals = (rs: Row[]) => {
    const executions = rs.reduce((n, r) => n + r.executions, 0);
    const failures = rs.reduce((n, r) => n + r.failures, 0);
    const ms = rs.reduce((n, r) => n + r.duration_ms, 0);
    const timed = rs.reduce((n, r) => n + r.duration_counted, 0);
    return { executions, failures, successes: executions - failures, failure_rate: rateOf(failures, executions), avg_ms: meanOf(ms, timed), timed };
  };

  const buildSystem = (system: string, label: string): ExecutionSystem => {
    const mine = system === ALL ? all : all.filter((r) => r.system === system);

    const built: ExecutionPeriod[] = periods.map((p) => {
      const t = totals(inPeriod(mine, p));
      const current = p.key === currentKey;
      let coverage: MonthCoverage = 'full';
      let note: string | null = null;
      if (current) {
        coverage = 'partial';
        note = `This ${grain} is still running.`;
      }
      if (!since) {
        coverage = 'none';
        note = 'Nothing has been snapshotted yet, so there is no count for this period rather than a count of nought.';
      } else if (p.end < since) {
        coverage = 'none';
        note = `n8n had already discarded these executions before anything was counted, so there is no figure for this ${grain} at all.`;
      } else if (p.start < since) {
        coverage = 'partial';
        note = `Only the part of this ${grain} from ${since}, when counting started.`;
      }
      return { key: p.key, label: labelOf(grain, p.start, spansYears), start: p.start, end: p.end, ...t, coverage, note, current };
    });

    // The period the workflow table and the comparison describe: the newest
    // with anything in it, else the one running now.
    const newest = [...built].reverse().find((p) => p.executions > 0) ?? built[built.length - 1];
    const bounds = periods.find((p) => p.key === newest?.key);
    const inNewest = bounds ? inPeriod(mine, bounds) : [];

    // One row per workflow inside that period, summed across its days.
    const byWorkflow = new Map<string, Row[]>();
    for (const r of inNewest) byWorkflow.set(r.workflow_id, [...(byWorkflow.get(r.workflow_id) ?? []), r]);
    const workflows: ExecutionWorkflow[] = [...byWorkflow.entries()]
      .map(([id, rs]) => {
        const t = totals(rs);
        return {
          workflow_id: id,
          workflow_name: rs[0].workflow_name ?? id,
          system: rs[0].system,
          executions: t.executions,
          failures: t.failures,
          avg_ms: t.avg_ms,
          timed: t.timed,
          // Newest first, and bounded the same way the table bounds them.
          failed_ids: rs.flatMap((r) => r.failed_ids).sort((x, y) => Number(y) - Number(x)).slice(0, 200),
          n8n_url: urlOf.get(id) ?? null,
        };
      })
      .sort((x, y) => y.failures - x.failures || y.executions - x.executions);

    const t = totals(inNewest);

    /**
     * The comparison, and the one thing that makes it honest.
     *
     * A period still running always has fewer executions than a finished one,
     * so comparing this week's total against the whole of last week would
     * report a collapse every Monday morning. When the period in view is the
     * current one, the previous period is cut to the same elapsed point — "so
     * far this week against the same point last week" — and the page says so.
     * Rates and averages need no such cut, but taking them from the same window
     * keeps every figure in the comparison describing the same span.
     */
    let comparison: ExecutionComparison | null = null;
    if (bounds && newest) {
      const prevStart = previousOf(grain, bounds.start);
      const prevBounds = boundsOf(grain, prevStart);
      const like = newest.current;
      // Days elapsed, counting today: a period that started today is one day in,
      // not nought, and the sentence under the figures says the same number the
      // window actually spans.
      const elapsed = like ? Math.round((utc(today).getTime() - utc(bounds.start).getTime()) / 86_400_000) + 1 : null;
      const cut = like && elapsed !== null ? addDays(prevBounds.start, elapsed - 1) : undefined;
      const prevRows = inPeriod(mine, prevBounds, cut);
      /**
       * Whether the window being compared against was being counted at all.
       *
       * The whole previous period is the wrong thing to check. Counting began on
       * 24 Aug; comparing the first fortnight of September against the first
       * fortnight of August would read "0 → 890" and look like the engine
       * started from nothing, when in truth nobody was counting in that window.
       * So the test is the window's own start, and a window that begins before
       * counting did gets no comparison and says why.
       */
      const windowStart = prevBounds.start;
      const windowEnd = cut && cut < prevBounds.end ? cut : prevBounds.end;
      const prevCovered = Boolean(since) && windowStart >= (since as string);
      const p = totals(prevRows);
      comparison = {
        against: keyOf(grain, prevStart),
        against_label: labelOf(grain, prevBounds.start, spansYears),
        executions: prevCovered ? delta(p.executions, t.executions, null) : null,
        successes: prevCovered ? delta(p.successes, t.successes, 'up') : null,
        failures: prevCovered ? delta(p.failures, t.failures, 'down') : null,
        failure_rate:
          prevCovered && p.failure_rate !== null && t.failure_rate !== null
            ? delta(Math.round(p.failure_rate * 1000) / 10, Math.round(t.failure_rate * 1000) / 10, 'down')
            : null,
        avg_ms: prevCovered ? delta(p.avg_ms, t.avg_ms, 'down') : null,
        like_for_like: like,
        note: !prevCovered
          ? since
            ? `There is nothing honest to compare against: counting only started on ${since}, and ${windowStart} to ${windowEnd} is before that. Those days were not quiet, they were not recorded.`
            : 'There is nothing to compare against: nothing has been counted yet.'
          : like
            ? `Against the same point of ${labelOf(grain, prevBounds.start, spansYears)} — its first ${elapsed} day${elapsed === 1 ? '' : 's'}, ${windowStart} to ${windowEnd} — because this ${grain} is still running and a whole one would always look bigger.`
            : `Against the whole of ${labelOf(grain, prevBounds.start, spansYears)}, ${windowStart} to ${windowEnd}.`,
      };
    }

    return {
      system,
      label,
      periods: built,
      period: newest?.key ?? currentKey,
      workflows,
      executions: t.executions,
      successes: t.successes,
      failures: t.failures,
      failure_rate: t.failure_rate,
      avg_ms: t.avg_ms,
      timed: t.timed,
      comparison,
    };
  };

  /**
   * Workflows n8n is running that the registry names no system for. They are
   * counted and listed rather than filed under a guess — a workflow in nobody's
   * system is a registry row somebody needs to add, which is actionable, and
   * putting it under the wrong heading would not be.
   */
  const known = new Set(SYSTEMS.map((s) => s.system));
  const orphanRows = all.filter((r) => !r.system || !known.has(r.system));
  const orphanBy = new Map<string, Row[]>();
  for (const r of orphanRows) orphanBy.set(r.workflow_id, [...(orphanBy.get(r.workflow_id) ?? []), r]);
  const unregistered: ExecutionWorkflow[] = [...orphanBy.entries()]
    .map(([id, rs]) => {
      const t = totals(rs);
      return {
        workflow_id: id,
        workflow_name: rs[0].workflow_name ?? id,
        system: rs[0].system,
        executions: t.executions,
        failures: t.failures,
        avg_ms: t.avg_ms,
        timed: t.timed,
        failed_ids: rs.flatMap((r) => r.failed_ids).slice(0, 50),
        n8n_url: urlOf.get(id) ?? null,
      };
    })
    .sort((x, y) => y.executions - x.executions);

  return {
    grain,
    systems: [{ system: ALL, label: 'All systems' }, ...SYSTEMS].map((s) => buildSystem(s.system, s.label)),
    boundary: b,
    snapshot: {
      at: ranAt,
      configured: n8n.n8nConfigured(),
      // The instance a failing execution id opens on. Sent from here rather
      // than compiled into the bundle, which carries no configuration at all.
      n8n_base: n8n.n8nConfigured() ? n8n.n8nHost() : null,
      note: n8n.n8nConfigured()
        ? ranAt
          ? 'Counts are snapshotted from n8n into this database and read from there, never queried live for a past period: n8n keeps about three days of execution history and then discards it.'
          : 'The snapshot has not completed a run yet, so these figures are empty rather than nought.'
        : `${n8n.N8N_API_VAR} is not set on this server, so no execution has ever been counted and these figures are empty rather than nought.`,
    },
    unregistered,
  };
}

export function isGrain(v: string): v is ExecutionGrain {
  return v === 'week' || v === 'month' || v === 'year';
}
