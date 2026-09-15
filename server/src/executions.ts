/**
 * n8n execution health, snapshotted into Postgres and read from there.
 *
 * **The constraint that shapes all of this: n8n's execution history does not
 * persist.** On 15 Sep 2026 the instance held 3,673 executions and none older
 * than 12 Sep — three days. Asking the API for August would get an honest
 * "nothing", and the chart would draw an empty month for a month that was
 * busy. So the API is the feed and `engine_executions` is the record.
 *
 * The counts are **accumulated forward, never recomputed.** Each run reads only
 * the executions above a watermark and adds them to their month's row. A month
 * whose executions have since aged out of n8n therefore keeps the count it had
 * when they existed, which is the whole point.
 *
 * Two consequences of accumulating, both deliberate:
 *
 *   - An execution still running when the job passes is not counted yet, and
 *     the watermark is held *below* it, so it is picked up with its real
 *     outcome next time rather than being counted as a success it has not
 *     earned.
 *   - Whichever month the job first ran in is partial by construction —
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
import type { ExecutionMonth, ExecutionSystem, ExecutionWorkflow, ExecutionsData, MonthCoverage, MonthlyBoundary } from '../../src/data/types';

/** The highest execution id already accumulated. Nothing at or below it is read again. */
const WATERMARK = 'executions.watermark';
/** The first month the snapshot covers. Stamped once, on the first run that reads anything. */
const SINCE = 'executions.since';
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

/** Separates the two halves of a bucket key. Neither a period nor an n8n id contains one. */
const SEP = '|';

/** The systems with a page of their own, and where that page is. */
export const SYSTEM_PAGES: { system: string; to: string; label: string }[] = [
  { system: 'Bays', to: '/bays', label: 'Bays' },
  { system: 'North Star Twin', to: '/north-star', label: 'North Star' },
  { system: 'Research Twin', to: '/research-twin', label: 'Research Twin' },
];

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function monthLabel(month: string, spansYears: boolean): string {
  const [y, m] = month.split('-');
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? month;
  return spansYears ? `${name} ${y.slice(2)}` : name;
}

export interface SnapshotResult {
  ran: boolean;
  at: string;
  ms: number;
  /** Executions read above the watermark and added to a month. */
  counted: number;
  /** Still running when the pass went by, so deliberately left for next time. */
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

  /**
   * An execution still in flight is never counted as the success it has not
   * earned. It is set aside by id and resolved on a later pass; the watermark
   * still moves past it, so nothing above it is ever read — or counted — twice.
   */
  let highestSeen = from;
  const deferred = new Set<string>(JSON.parse((await getMeta(DEFERRED)) ?? '[]') as string[]);

  interface Bucket {
    executions: number;
    failures: number;
    failed: string[];
    name: string;
    system: string | null;
  }
  const buckets = new Map<string, Bucket>();

  const count = (e: n8n.N8nExecution): boolean => {
    // An execution with no start time cannot be placed in a month, and is not
    // filed under today to make it fit.
    if (!e.startedAt) return false;
    const period = monthOf(e.startedAt);
    const known = byId.get(e.workflowId);
    const key = `${period}${SEP}${e.workflowId}`;
    const b = buckets.get(key) ?? { executions: 0, failures: 0, failed: [], name: known?.name ?? e.workflowId, system: known?.system ?? null };
    b.executions++;
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
    const period = key.slice(0, key.indexOf(SEP));
    const workflowId = key.slice(key.indexOf(SEP) + 1);
    await query(
      `INSERT INTO engine_executions (period, workflow_id, workflow_name, system, executions, failures, failed_ids, first_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
       ON CONFLICT (period, workflow_id) DO UPDATE SET
         workflow_name = EXCLUDED.workflow_name,
         system        = EXCLUDED.system,
         executions    = engine_executions.executions + EXCLUDED.executions,
         failures      = engine_executions.failures + EXCLUDED.failures,
         failed_ids    = (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM (
                            SELECT v FROM jsonb_array_elements(EXCLUDED.failed_ids || engine_executions.failed_ids) AS t(v) LIMIT 200
                          ) s),
         updated_at    = EXCLUDED.updated_at`,
      [period, workflowId, b.name, b.system, b.executions, b.failures, JSON.stringify(b.failed.sort((x, y) => Number(y) - Number(x))), at],
    );
  }

  // The watermark moves past everything that was read, finished or not: an
  // unfinished one is on the deferred list and is resolved by id, so nothing
  // needs to be read a second time to catch it.
  const watermark = highestSeen;
  if (watermark > from) await setMeta(WATERMARK, String(watermark));
  await setMeta(RAN_AT, at);
  // The first month anything was counted in. Stamped once and never moved.
  if (buckets.size) await setMetaIfAbsent(SINCE, [...buckets.keys()].map((k) => k.slice(0, k.indexOf(SEP))).sort()[0]);

  const counted = [...buckets.values()].reduce((n, b) => n + b.executions, 0);
  const note =
    `${counted} execution${counted === 1 ? '' : 's'} counted across ${buckets.size} workflow-month${buckets.size === 1 ? '' : 's'}` +
    `${resolved ? `, ${resolved} of them finishing one that was still running earlier` : ''}` +
    `${pending ? `, ${pending} still running and set aside by id for a later pass` : ''}` +
    `${dropped ? `, ${dropped} never finished before n8n discarded ${dropped === 1 ? 'it' : 'them'} and ${dropped === 1 ? 'was' : 'were'} not counted` : ''}` +
    `${read.truncated ? '. The read hit its page limit, so there may be more above the watermark; the next pass continues from where this one stopped' : ''}.`;
  if (counted || pending) console.log(`executions snapshot: ${note} watermark ${from} -> ${watermark}`);
  return { ran: true, at, ms: Date.now() - started, counted, pending, watermark, truncated: read.truncated, note };
}

/* ------------------------------------------------------------------ reads */

interface Row {
  period: string;
  workflow_id: string;
  workflow_name: string | null;
  system: string | null;
  executions: number;
  failures: number;
  failed_ids: string[];
}

async function rows(): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT period, workflow_id, workflow_name, system, executions, failures, failed_ids
       FROM engine_executions ORDER BY period DESC, executions DESC`,
  );
  return r.rows.map((x) => ({
    ...x,
    executions: Number(x.executions),
    failures: Number(x.failures),
    failed_ids: Array.isArray(x.failed_ids) ? x.failed_ids : [],
  }));
}

/**
 * The boundary every execution chart labels: the first month the snapshot
 * covers whole.
 *
 * The month the job first ran in is partial by construction — n8n was already
 * ageing executions off before anything was counted — so the first *complete*
 * month is the one after it.
 */
async function boundary(): Promise<MonthlyBoundary | null> {
  const since = await getMeta(SINCE);
  if (!since) return null;
  const [y, m] = since.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    month: next,
    note:
      `Execution counts begin in ${since}, which is when this dashboard started snapshotting them. ` +
      `n8n keeps roughly three days of execution history and then discards it, so nothing before ${since} was ever there to count, ` +
      `and ${since} itself holds only the part of the month the snapshot was running for. ${next} is the first complete month.`,
  };
}

function coverageOf(month: string, b: MonthlyBoundary | null, current: string): { coverage: MonthCoverage; note: string | null } {
  if (month === current) return { coverage: 'partial', note: 'This month is still running.' };
  if (!b) return { coverage: 'none', note: 'Nothing has been snapshotted yet, so there is no count for this month rather than a count of zero.' };
  if (month < b.month) return { coverage: 'partial', note: `Only the part of ${month} the snapshot was running for. n8n had already discarded the rest.` };
  return { coverage: 'full', note: null };
}

export async function read(): Promise<ExecutionsData> {
  const all = await rows();
  const b = await boundary();
  const current = nowIso().slice(0, 7);
  const ranAt = await getMeta(RAN_AT);

  const periods = [...new Set([...all.map((r) => r.period), current])].sort();
  const spansYears = new Set(periods.map((p) => p.slice(0, 4))).size > 1;

  const registered = await registry.list('workflows');
  const urlOf = new Map(registered.map((w) => [String(w.id), (w.n8n_url as string | null) ?? null]));

  const asWorkflow = (r: Row): ExecutionWorkflow => ({
    workflow_id: r.workflow_id,
    workflow_name: r.workflow_name ?? r.workflow_id,
    system: r.system,
    executions: r.executions,
    failures: r.failures,
    failed_ids: r.failed_ids,
    n8n_url: urlOf.get(r.workflow_id) ?? null,
  });

  const systems: ExecutionSystem[] = SYSTEM_PAGES.map(({ system, to, label }) => {
    const mine = all.filter((r) => r.system === system);
    const months: ExecutionMonth[] = periods.map((month) => {
      const inMonth = mine.filter((r) => r.period === month);
      const executions = inMonth.reduce((n, r) => n + r.executions, 0);
      const failures = inMonth.reduce((n, r) => n + r.failures, 0);
      const { coverage, note } = coverageOf(month, b, current);
      return { month, label: monthLabel(month, spansYears), executions, failures, failure_rate: executions ? failures / executions : null, coverage, note };
    });
    // The month the per-workflow table describes: the newest with anything in it.
    const newest = [...mine].sort((x, y) => y.period.localeCompare(x.period))[0]?.period ?? current;
    const inNewest = mine.filter((r) => r.period === newest);
    const executions = inNewest.reduce((n, r) => n + r.executions, 0);
    const failures = inNewest.reduce((n, r) => n + r.failures, 0);
    return {
      system,
      label,
      to,
      months,
      month: newest,
      workflows: inNewest.map(asWorkflow).sort((x, y) => y.failures - x.failures || y.executions - x.executions),
      executions,
      failures,
      failure_rate: executions ? failures / executions : null,
    };
  });

  /**
   * Workflows n8n is running that the registry names no system for. They are
   * counted and listed rather than filed under a guess — a workflow in nobody's
   * system is a registry row somebody needs to add, which is actionable, and
   * putting it under the wrong heading would not be.
   */
  const known = new Set(SYSTEM_PAGES.map((s) => s.system));
  const newestPeriod = periods[periods.length - 1];
  const unregistered = all
    .filter((r) => !r.system || !known.has(r.system))
    .filter((r) => r.period === newestPeriod)
    .map(asWorkflow)
    .sort((x, y) => y.executions - x.executions);

  return {
    systems,
    boundary: b,
    snapshot: {
      at: ranAt,
      configured: n8n.n8nConfigured(),
      // The instance a failing execution id opens on. Sent from here rather
      // than compiled into the bundle, which carries no configuration at all.
      n8n_base: n8n.n8nConfigured() ? n8n.n8nHost() : null,
      note: n8n.n8nConfigured()
        ? ranAt
          ? 'Counts are snapshotted from n8n into this database and read from there, never queried live for a past month: n8n keeps about three days of execution history and then discards it.'
          : 'The snapshot has not completed a run yet, so these figures are empty rather than zero.'
        : `${n8n.N8N_API_VAR} is not set on this server, so no execution has ever been counted and these figures are empty rather than zero.`,
    },
    unregistered,
  };
}

/* ------------------------------------------------------- the scheduled job */

/**
 * How often the snapshot runs.
 *
 * Cheap after the first pass: the reader walks down from the newest execution
 * and stops the moment it crosses the watermark, so an hourly run reads one
 * page. Frequent enough that a month's counts are never more than an hour
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
 * Brings the current month up to date before a page reads it.
 *
 * The brief allows the in-progress period to be read live. Rather than a second
 * code path that could disagree with the stored one, this runs the same
 * accumulating pass and then reads the table — so there is one source for every
 * month, and the newest one is never more than a few minutes old.
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

/** One system, for its own page. */
export async function forSystem(system: string): Promise<ExecutionSystem | null> {
  const d = await read();
  return d.systems.find((s) => s.system === system) ?? null;
}
