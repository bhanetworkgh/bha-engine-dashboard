/**
 * What the Retries and Repairs tabs' status words mean, read off the code that
 * writes them (2026-09-22, Destiny's brief, rule (b)).
 *
 * Retries. None of the three statuses is computed by this dashboard: the row is
 * the healer's own, copied through `mapRetryAttempt` in server/src/sources.ts
 * (`status` and `triggered_by` read as Airtable single-selects, `(no status)`
 * where the row carries none), and counted in `retryMetrics` in
 * server/src/health.ts (recovery rate = Recovered ÷ (Recovered + Exhausted),
 * Retrying left out of both). The wording of each is derived from the live n8n
 * workflow `BHA — Self Healer` (oOAZaW1aQaRP2arc), read 2026-09-22: "Check
 * Retry" claims recovery only where n8n's retry call answered 200/201 **and**
 * the new run's status is `success` (or, for a run still going after two
 * minutes, "Read Retry Result" finds `retrySuccessId` on the original); "Retries
 * Left?" loops while `attempt < 3`; "Record Retry Recovered" and "Record Retry
 * Exhausted" are the only two nodes that write a status, and "Normalise
 * Handover" stamps `triggered_by` as `Dashboard` for the Retry now webhook and
 * `Handler` for an error handler's handover. **Nothing in that workflow writes
 * `Retrying` or `Schedule`**: both are the vocabulary of the 5-minute schedule
 * it replaced on 21 Sep (`RETRY_STATUSES`, `RETRY_TRIGGERS` in sources.ts).
 *
 * The Retry now reasons are `mapRetryAttempt`'s `can_retry`/`blocked_reason`,
 * the same checks `retryNow` in health.ts repeats on the server, plus the page's
 * own `heal_configured` (`bharag.healConfigured`, ENGINE_HEAL_URL).
 *
 * Repairs. The five outcomes are `OUTCOMES` in server/src/repairs.ts, set by
 * `bha-repair-bridge` (a separate service; its code is not in this repository)
 * and stored as sent by `repairs.store` — anything else is refused 422.
 * Standing, reverted and the guards are this repository's own: `revertBlock`,
 * `revert` and `list` in repairs.ts.
 */

export const RETRY_STATUS_DEFS: Record<string, string> = {
  Retrying:
    'Written by the healer while an incident still had attempts left. This dashboard never sets it and leaves it out of the recovery rate as undecided. The healer running today (BHA — Self Healer) writes only Recovered and Exhausted, so a row still at Retrying was left by the 5-minute schedule it replaced on 21 Sep and nothing has rewritten it since.',
  Recovered:
    'Written by the healer when n8n accepted a retry and the new run finished with status success — or, for a run still going after two minutes, when the original execution later carried a successful retry. Counted as a recovery here.',
  Exhausted:
    'Written by the healer after its third attempt without a successful run; the current healer then hands the failure to the repair bridge. The earlier schedule also wrote it at once for an execution n8n no longer held (pruned), which is why last_result is shown in full. Counted as a failed verdict here.',
  '(no status)': 'The row carries no status at all. Shown as it is, and left out of the recovery rate.',
};

export const RETRY_TRIGGER_DEFS: Record<string, string> = {
  Schedule: 'Picked up by the 5-minute schedule that ran the healer until 21 Sep. The healer running today does not write this value.',
  Handler: 'Handed to the healer by a lane’s error handler — how every automatic retry starts since 21 Sep.',
  Dashboard:
    'Started with Retry now on this page: the server posts to ENGINE_HEAL_URL, the healer’s engine-heal webhook, which records the retry as Dashboard. Same mechanism and same cap as an automatic one.',
};

/** Why Retry now is greyed out, in the order the button checks. */
export const RETRY_BLOCK_DEFS: Record<string, string> = {
  'Not configured': 'ENGINE_HEAL_URL is not set on this server, so there is nothing to ask. It defaults to the live webhook, so this should not appear.',
  'At the cap': 'The row records three attempts or more. Checked on the attempt count alone, so a Recovered row at three is greyed out too.',
  'No execution id': 'The row carries no execution id; the healer refuses without one, because there is nothing to resume from.',
  Busy: 'Another Retry now from this page is still waiting for the healer to answer.',
};

export const REPAIR_OUTCOME_DEFS: Record<string, string> = {
  repaired:
    'The repair bridge reported outcome "repaired": it changed the workflow. Only these rows can be reverted. This server stores the outcome as the bridge sent it and does not itself check that a version_after came back — the bridge is what enforces that.',
  not_repaired: 'The repair bridge reported that it ran and made no change. The incident stays open for a person.',
  needs_human:
    'The repair bridge reported that a person has to act — including a run that could not report a parseable result. Its human_action sentence is shown on the row. The incident stays open.',
  skipped: 'The repair bridge declined to run a repair and said so. Changes nothing and asks nothing of anybody; counted apart from not repaired.',
  error: 'The repair bridge itself failed while running the repair (shown as bridge error). Grouped with not repaired in the filter and on the strip.',
};

export const REPAIR_STATE_DEFS: Record<string, string> = {
  standing: 'Outcome repaired and not since reverted — a fix the workflow currently has. Counted from the rows on screen.',
  reverted:
    'Somebody pressed Revert here and n8n accepted the restore. Stamped by this dashboard only after n8n took the workflow back; the pill then reads reverted whatever the outcome was.',
};

/** The four guards a revert checks, as `revert` in repairs.ts names them. */
export const REVERT_GUARD_DEFS: Record<string, string> = {
  not_a_repair: 'The outcome is not repaired, so nothing was changed and there is nothing to put back.',
  already_reverted: 'reverted_at is already set on the row.',
  no_restore_point:
    'No version_before (or no workflow id) was recorded. Before that, the row also needs the bridge’s pre-repair snapshot of the workflow, because n8n cannot fetch an old version by id.',
  version_moved_on:
    'The workflow’s current version in n8n is no longer the version_after the repair produced — somebody has edited it since, and a restore would throw that away. The only guard that reads n8n live, so it is checked when Revert is pressed, not on the list.',
};
