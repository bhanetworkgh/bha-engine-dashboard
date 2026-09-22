/**
 * What the Executions page's words mean, read off the code that puts a row
 * under each one (2026-09-22, Destiny's brief, rule (b)).
 *
 * Code read:
 *
 *   server/src/n8n.ts — `TERMINAL` = success, error, crashed, canceled (an
 *   execution whose outcome will not change); `FAILED` = error, crashed
 *   ("`canceled` is a person stopping it, not a fault"). `N8nExecution.mode` is
 *   stored as n8n reports it; the comment lists "webhook, trigger, integrated,
 *   manual, error".
 *
 *   server/src/executions.ts — `add()` files every row into exactly one of
 *   failed (FAILED), succeeded (`success`), canceled (`canceled`) or
 *   unfinished (anything else). `figures()`: finished = succeeded + failed +
 *   canceled; failure rate = failed ÷ finished; average = sum(duration_ms) ÷
 *   count(duration_ms), where duration is null unless n8n gave both a start
 *   and a stop. The sync re-reads by id every row whose status is not one of
 *   success, error, crashed, canceled, unknown (100 per pass), and stamps
 *   `unknown` on one n8n no longer returns. `recentHealth()` reads the last
 *   ten rows per workflow whose status is success, error or crashed, whatever
 *   month they fall in. A workflow's tab is `registry_workflows.system` by a
 *   join at read time; no (undeleted) registry row files it under Archived.
 *   Coverage is set in `read()`: none before the oldest day held (or outside
 *   the 18 periods read), partial for the period holding that oldest day and
 *   for the one still running, full otherwise.
 *
 * **Gap:** the `mode` values ("how it ran") are not defined anywhere in this
 * repository — they are stored verbatim and never mapped, counted or filtered
 * on. The definitions below say so and give n8n's own meaning for each.
 */

/** Outcome — n8n's `status`, as stored on `engine_execution_runs.status`. */
export const STATUS_DEFS: Record<string, string> = {
  success: 'n8n reported the run finished without an error. Counted as succeeded, and as finished.',
  error: 'n8n reported the run ended in an error. Counted as failed (n8n.ts FAILED), and as finished.',
  crashed: 'n8n reported the run stopped abnormally rather than ending in a handled error. Counted as failed, the same as error, and as finished.',
  canceled:
    'Stopped by a person — "not a fault" (n8n.ts). Finished, so it is in the failure rate’s denominator, but counted as neither succeeded nor failed.',
  waiting:
    'Not finished when last read. Stored with the status it was read at and re-read by id on every poll until n8n gives a final one. Counted in executions only — in none of succeeded, failed or canceled, and not in the failure rate.',
  running:
    'Not finished when last read. Stored with the status it was read at and re-read by id on every poll until n8n gives a final one. Counted in executions only — in none of succeeded, failed or canceled, and not in the failure rate.',
  new: 'Not started when last read. Re-read by id on every poll until n8n gives a final status. Counted in executions only, not in the failure rate.',
  unknown:
    'Set by this dashboard, not by n8n: the run was stored unfinished and n8n no longer returned it when re-read, so how it ended is not known. Never re-read. Counted in executions and — as the code stands — in the same not-finished bucket as waiting and running.',
};

/** Anything n8n sends that is none of the words above falls into the not-finished bucket. */
export const STATUS_OTHER =
  'A status this dashboard has no rule for. It is counted in executions and in none of succeeded, failed or canceled, and is re-read on every poll.';

/**
 * "How it ran" — n8n's `mode`, stored verbatim. Nothing in this repository
 * defines, maps or counts these; the meanings are n8n's own.
 */
export const MODE_DEFS: Record<string, string> = {
  webhook: 'n8n’s mode: started by a call to one of the workflow’s webhooks. Stored as n8n reported it; not counted separately here.',
  trigger: 'n8n’s mode: started by a trigger node — a schedule or a poll. Stored as n8n reported it; not counted separately here.',
  integrated: 'n8n’s mode: started by another workflow (an Execute Workflow call). Stored as n8n reported it; not counted separately here.',
  manual: 'n8n’s mode: run by hand from the n8n editor. Stored as n8n reported it; not counted separately here.',
  error:
    'n8n’s mode: an error workflow, started because another workflow failed. It says how the run started, not how it ended — an error-mode run can succeed.',
  retry: 'n8n’s mode: a retry of an earlier failed execution — the healer’s, or one started by hand. Stored as n8n reported it; not counted separately here.',
};

export const MODE_OTHER = 'n8n’s own mode value, stored as n8n reported it. Nothing in this dashboard defines, maps or counts it.';

/** The system tabs. A system tab is `registry_workflows.system`, joined at read time. */
export const TAB_DEFS: Record<string, string> = {
  'All systems': 'Every execution this database holds for the month, whatever system the registry files its workflow under. The other tabs sum to it exactly.',
  Bays: 'Workflows whose workflow-registry row names the system Bays.',
  'North Star': 'Workflows whose workflow-registry row names the system North Star Twin.',
  'Research Twin': 'Workflows whose workflow-registry row names the system Research Twin.',
  Archived:
    'Workflows with no row in the workflow registry. Labelled Archived because every one was archived in n8n when checked on 16 Sep; this server does not read n8n’s archived flag, so a live workflow nobody has registered would land here too.',
};

export const tabDef = (label: string): string => TAB_DEFS[label] ?? `Workflows whose workflow-registry row names the system ${label}.`;

/** The "recent" column, from `recentHealth()`. */
export const RECENT_DEF =
  'Each workflow’s last ten runs whose outcome is success, error or crashed, whenever they ran — not only this month. Canceled, unfinished and unknown runs are left out. “last N ok” means none of them failed; “x of last N failed” counts error and crashed; “none finished” means no such run is held.';

/** Coverage words on the chart, from `read()`. */
export const COVERAGE_DEFS: Record<'full' | 'partial' | 'none', string> = {
  full: 'A whole month this database holds every execution for. Solid bar.',
  partial: 'Only part of the month is held — it contains the oldest day held, or it is still running. Hatched bar.',
  none: 'No execution held for any of it: before the oldest day held, or outside the 18 months read. No bar — it was not recorded, which is not the same as nought.',
};
