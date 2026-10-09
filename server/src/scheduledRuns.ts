/**
 * The Scheduled runs page's read (2026-10-09, Destiny — LOOP-1791498530857-K9B7).
 *
 * Jason, 8 Oct: "a minimal run log (timestamp, task ID, success/failure, error) so we can
 * distinguish infra-level misses from task-level failures". Every scheduler the engine has,
 * on one page, from records that already exist. Nothing here writes, and nothing here calls
 * another system: it is four reads of this database and one of this process's own memory.
 *
 *  - **Agent tasks.** Bays' scheduled tasks run inside the n8n Agent, whose timer keeps no
 *    history. From 9 Oct each task writes a `started` row first (Record_Scheduled_Run) and its
 *    last step closes that row. The schedule itself is read from the agent inventory, never
 *    typed here, so every time a task was due is a row whether or not anything ran:
 *    no row for a due time is **never started** (the timer did not fire, or the agent stopped
 *    before its first step: the log cannot split those two); a row left at started is
 *    **started, not finished**; a closed row carries its own outcome.
 *    A due time before the run log began says "no record", never "never started": a finish
 *    line was the only thing written then, so its absence proves less.
 *  - **Workflows.** n8n runs started by a trigger node, from `engine_execution_runs`.
 *  - **Reminders.** Posts Slack holds for Bays, from `engine_scheduled_posts`.
 *  - **Background timers.** This process's own, from `timers.ts`.
 */
import { query } from './pg';
import * as timers from './timers';

/** The first deploy that could hold a `started` row. Before it, a missing row is "no record". */
export const RUN_LOG_SINCE = '2026-10-09T16:00:00.000Z';
const DAYS = 7;
const GRACE_MS = 45 * 60_000;
const MATCH_AFTER_MS = 4 * 3_600_000;
const MATCH_BEFORE_MS = 10 * 60_000;

export type AgentRunState = 'finished' | 'failed' | 'started_not_finished' | 'never_started' | 'no_record' | 'due_soon' | 'unscheduled';

export interface AgentRun {
  key: string;
  agent: string;
  task: string;
  due_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  state: AgentRunState;
  outcome: string | null;
  seconds: number | null;
  summary: string | null;
  error: string | null;
  tool_issues: string | null;
  slack_link: string | null;
  ask_id: string | null;
  /** True where the row was written before the run log: a finish line with no start. */
  finish_only: boolean;
}

interface Task {
  agent: string;
  name: string;
  short: string;
  cron: string;
  timezone: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** "Open loops reminder -- Jegan (daily 08:15 ET)" is recorded as "Open loops reminder -- Jegan". */
const shortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();

/* ------------------------------------------------------------------- cron */

function fieldMatches(field: string, value: number, min: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    let lo = min;
    let hi = Infinity;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isFinite(a)) return false;
      lo = a;
      hi = b === undefined ? (stepRaw ? Infinity : a) : b;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, ms: number): { minute: number; hour: number; day: number; month: number; dow: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** Every time a five-field cron was due between two instants, in its own time zone. */
export function dueTimes(cron: string, tz: string, fromMs: number, toMs: number): number[] {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return [];
  const out: number[] = [];
  const start = Math.ceil(fromMs / 60_000) * 60_000;
  for (let t = start; t <= toMs; t += 60_000) {
    const p = partsIn(tz, t);
    if (!fieldMatches(f[0], p.minute, 0) || !fieldMatches(f[1], p.hour, 0)) continue;
    if (!fieldMatches(f[3], p.month, 1)) continue;
    const domAny = f[2] === '*';
    const dowAny = f[4] === '*';
    const dom = fieldMatches(f[2], p.day, 1);
    const dow = fieldMatches(f[4], p.dow, 0) || (p.dow === 0 && fieldMatches(f[4], 7, 0));
    // The usual cron rule: with both set, either one is enough.
    if (domAny && dowAny ? true : domAny ? dow : dowAny ? dom : dom || dow) out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------- read */

interface AskRow {
  fields: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const iso = (v: unknown) => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

export async function scheduledRuns(now = Date.now()) {
  const fromMs = now - DAYS * 86_400_000;
  const since = new Date(fromMs).toISOString();
  const logSince = Date.parse(RUN_LOG_SINCE);

  const [inv, asks, wf, posts] = await Promise.all([
    query<{ name: string; tasks: unknown; read_at: string }>(`SELECT name, tasks, read_at FROM engine_agent_inventory ORDER BY name`),
    query<AskRow>(`SELECT fields FROM engine_bays_asks WHERE fields->>'Source' = 'scheduled' AND created_time >= $1 ORDER BY created_time DESC LIMIT 3000`, [since]),
    query<{ execution_id: string; workflow_id: string; workflow_name: string | null; status: string; started_at: string; stopped_at: string | null; duration_ms: string | null }>(
      `SELECT execution_id, workflow_id, workflow_name, status, started_at, stopped_at, duration_ms FROM engine_execution_runs WHERE mode = 'trigger' AND started_at >= $1 ORDER BY started_at DESC LIMIT 3000`,
      [since],
    ),
    query<{ reminder_id: string; channel_id: string; text: string; post_at: string; status: string; requested_by: string | null; created_at: string }>(
      `SELECT reminder_id, channel_id, text, post_at, status, requested_by, created_at FROM engine_scheduled_posts WHERE post_at >= $1 OR status = 'scheduled' ORDER BY post_at DESC LIMIT 500`,
      [since],
    ),
  ]);

  /* The schedule, from the agent inventory. */
  const tasks: Task[] = [];
  let inventoryReadAt: string | null = null;
  for (const a of inv.rows) {
    if (!inventoryReadAt || a.read_at < inventoryReadAt) inventoryReadAt = a.read_at;
    for (const t of Array.isArray(a.tasks) ? (a.tasks as Record<string, unknown>[]) : []) {
      if (t.enabled === false) continue;
      const name = str(t.name);
      const cron = str(t.cron);
      if (!name || !cron) continue;
      tasks.push({ agent: a.name, name, short: shortName(name), cron, timezone: str(t.timezone) ?? 'UTC' });
    }
  }

  /* The recorded runs. */
  const rows = asks.rows.map((r) => {
    const f = r.fields;
    const outcome = str(f['Task Outcome']);
    const open = outcome === 'started';
    const startedAt = iso(f['Started At']) ?? (open ? iso(f['Asked At']) : null);
    const finishedAt = open ? null : (iso(f['Finished At']) ?? iso(f['Asked At']));
    const secs = typeof f['Response Seconds'] === 'number' ? (f['Response Seconds'] as number) : null;
    return {
      task: str(f['Task Name']) ?? '(no task name)',
      at: Date.parse(startedAt ?? finishedAt ?? '') || 0,
      startedAt,
      finishedAt,
      outcome,
      open,
      seconds: secs,
      summary: open ? null : str(f['Answer']),
      error: str(f['Error']),
      issues: str(f['Tool Issues']),
      link: str(f['Slack Link']),
      askId: str(f['Ask ID']),
      used: false,
    };
  });

  const agentRuns: AgentRun[] = [];
  const stateOf = (r: (typeof rows)[number]): AgentRunState => (r.open ? 'started_not_finished' : r.outcome === 'failed' ? 'failed' : 'finished');
  const fromRow = (r: (typeof rows)[number], agent: string, due: number | null): AgentRun => ({
    key: `${r.askId ?? r.task}:${r.at}`,
    agent,
    task: r.task,
    due_at: due === null ? null : new Date(due).toISOString(),
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    state: stateOf(r),
    outcome: r.outcome,
    seconds: r.seconds,
    summary: r.summary ? r.summary.slice(0, 1200) : null,
    error: r.error,
    tool_issues: r.issues,
    slack_link: r.link,
    ask_id: r.askId,
    finish_only: !r.open && !r.startedAt,
  });

  for (const t of tasks) {
    const mine = rows.filter((r) => norm(r.task).startsWith(norm(t.short)) || norm(t.short).startsWith(norm(r.task)));
    for (const due of dueTimes(t.cron, t.timezone, fromMs, now)) {
      // The run for this due time: the earliest unused row from just before it to four hours after.
      const hit = mine.filter((r) => !r.used && r.at >= due - MATCH_BEFORE_MS && r.at <= due + MATCH_AFTER_MS).sort((a, b) => a.at - b.at)[0];
      if (hit) {
        hit.used = true;
        agentRuns.push(fromRow(hit, t.agent, due));
        continue;
      }
      agentRuns.push({
        key: `${t.name}:${due}`,
        agent: t.agent,
        task: t.short,
        due_at: new Date(due).toISOString(),
        started_at: null,
        finished_at: null,
        state: now - due < GRACE_MS ? 'due_soon' : due < logSince ? 'no_record' : 'never_started',
        outcome: null,
        seconds: null,
        summary: null,
        error: null,
        tool_issues: null,
        slack_link: null,
        ask_id: null,
        finish_only: false,
      });
    }
  }
  // Runs nothing on the schedule accounts for: a re-run by the watch, a hand run, a test.
  for (const r of rows) if (!r.used) agentRuns.push({ ...fromRow(r, 'Bays (Agent)', null), state: r.open ? 'started_not_finished' : r.outcome === 'failed' ? 'failed' : 'unscheduled' });
  agentRuns.sort((a, b) => Date.parse(b.due_at ?? b.started_at ?? b.finished_at ?? '') - Date.parse(a.due_at ?? a.started_at ?? a.finished_at ?? ''));

  const count = (s: AgentRunState) => agentRuns.filter((r) => r.state === s).length;
  const due = agentRuns.filter((r) => r.due_at !== null && r.state !== 'due_soon');

  /* Workflows. */
  const workflowRuns = wf.rows.map((r) => ({
    execution_id: String(r.execution_id),
    workflow_id: r.workflow_id,
    workflow: r.workflow_name ?? r.workflow_id,
    status: r.status,
    started_at: r.started_at,
    stopped_at: r.stopped_at,
    seconds: r.duration_ms === null ? null : Math.round(Number(r.duration_ms) / 100) / 10,
  }));
  const byWorkflow = new Map<string, { workflow: string; runs: number; failed: number; last_run_at: string; last_status: string }>();
  for (const r of workflowRuns) {
    const w = byWorkflow.get(r.workflow_id);
    const bad = r.status === 'error' || r.status === 'crashed';
    if (w) {
      w.runs += 1;
      if (bad) w.failed += 1;
    } else byWorkflow.set(r.workflow_id, { workflow: r.workflow, runs: 1, failed: bad ? 1 : 0, last_run_at: r.started_at, last_status: r.status });
  }

  return {
    window: { days: DAYS, from: since, to: new Date(now).toISOString() },
    run_log_since: RUN_LOG_SINCE,
    agent: {
      tasks: tasks.map((t) => ({ agent: t.agent, task: t.short, cron: t.cron, timezone: t.timezone })),
      schedule_read_at: inventoryReadAt,
      runs: agentRuns,
      summary: {
        due: due.length,
        finished: count('finished'),
        failed: count('failed'),
        started_not_finished: count('started_not_finished'),
        never_started: count('never_started'),
        no_record: count('no_record'),
        unscheduled: count('unscheduled'),
      },
    },
    workflows: {
      runs: workflowRuns,
      by_workflow: [...byWorkflow.values()].sort((a, b) => b.runs - a.runs),
      summary: { workflows: byWorkflow.size, runs: workflowRuns.length, failed: workflowRuns.filter((r) => r.status === 'error' || r.status === 'crashed').length },
    },
    reminders: posts.rows.map((p) => ({
      reminder_id: p.reminder_id,
      channel_id: p.channel_id,
      text: p.text.slice(0, 300),
      post_at: new Date(p.post_at).toISOString(),
      // Slack holds and posts these; the bot cannot read the channel back, so a past one is "handed to Slack".
      state: p.status === 'cancelled' ? 'cancelled' : Date.parse(String(p.post_at)) <= now ? 'handed to Slack' : 'waiting',
      requested_by: p.requested_by,
    })),
    timers: { since: timers.STARTED_AT, list: timers.list() },
    notes: [
      `The agent schedule is read from the agent inventory (last read ${inventoryReadAt ? inventoryReadAt.slice(0, 10) : 'never'}), so a task added or re-timed since then shows on the old schedule until the inventory is recorded again.`,
      `The run log began ${RUN_LOG_SINCE.slice(0, 16).replace('T', ' ')} UTC. Before it a task wrote only a finish line, so a due time with nothing recorded says "no record"; from then on it says "never started".`,
      '"Never started" cannot tell a timer that did not fire from an agent that stopped before its first step. Both are platform-level, not the task failing.',
      'Workflows are n8n runs started by a trigger node. Schedule triggers are most of them; a workflow started by another kind of trigger node is listed too.',
      'Scheduled checks run by Claude outside the engine are not held in this database and are not listed.',
    ],
  };
}
