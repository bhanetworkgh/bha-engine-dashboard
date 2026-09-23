import type { LoopStatus } from '../../data';

/**
 * What every status word on Open loops means, read off the code that puts a
 * row there (2026-09-22, Destiny's brief, rule (b)).
 *
 *   Status — `server/src/sources.ts` `mapLoop`: the Airtable single-select
 *   `Status` is read through `AIRTABLE_TO_LOOP_STATUS` — `Open` → open,
 *   `In Progress` → in progress, `Closed` → closed. **An empty Status, or any
 *   value outside those three, is mapped to open** (`?? 'open'`), so "open"
 *   also holds whatever n8n wrote that this code does not recognise. The
 *   dashboard writes back through `LOOP_STATUS_TO_AIRTABLE`, the same three.
 *   Live on 2026-09-22 every row carried one of the three (638 / 74 / 268 of
 *   980), so the fallback holds nothing today.
 *
 *   Closed date — `server/src/store.ts` `terminalDates`: a loop's close date is
 *   the time of its last `events` row, and only when that row is a change *to*
 *   closed from a known earlier status (`from_status` not null). A loop that
 *   was already Closed when this database first saw it has no close date.
 *
 *   Age — `server/src/store.ts` `hydrateLoop`: whole days from `Date Raised` to
 *   the close date, or to today when there is none. It is **not** time in the
 *   current status: nothing upstream dates a status change, so an In Progress
 *   loop's age still counts from when it was raised. An unparseable or missing
 *   Date Raised reads 0 and the cell shows a dash.
 *
 *   Age colour — `src/lib/format.ts` `ageTone`: 14 days or more is amber, 30 or
 *   more is red, on loops that are not closed; closed rows are drawn faint.
 *
 *   Age buckets — `server/src/store.ts` `loopMetricsFor`: open and in-progress
 *   loops with a Date Raised, bucketed by `age_days`; those without one are
 *   counted as "no date raised" rather than dropped.
 *
 *   Builder table — `server/src/sources.ts` (`LOOP_TABLES`, "Owner is the table
 *   a loop lives in"): the builder is which of the tables in the Open Loops
 *   base the row sits in, never the assignee field.
 */

export const LOOP_STATUS_DEFS: Record<LoopStatus, string> = {
  open: 'Status is Open on the loop. An empty Status, or a value other than Open, In Progress or Closed, is also read as open.',
  'in progress': 'Status is In Progress — set by Start on this page or written by the engine.',
  closed:
    'Status is Closed. The closed date is set only when this dashboard saw the change happen; a loop already Closed when first held has none.',
};

/** The words on the status pills and filter, capitalised the way the page prints them. */
export const LOOP_STATUS_TERMS: Record<LoopStatus, string> = { open: 'Open', 'in progress': 'In progress', closed: 'Closed' };

export const VIEW_DEFS = {
  Loops: 'Every loop held, filtered by builder table, month raised and status.',
  Statistics: 'The month in view against the month before: raised, closed, close rate and ages.',
} as const;

export const ALL_TABLES_DEF = 'Every builder table in the Open Loops base, together.';

export function builderTableDef(name: string): string {
  return `Loops in ${name}’s table in the Open Loops base. The builder is the table a loop sits in, not its assignee.`;
}

/** The age cell's colour bands, from `ageTone`. */
export function ageBandDef(days: number, closed: boolean): string {
  const base = 'Days since Date Raised — to the close date if one was recorded, otherwise to today. Not time in the current status.';
  if (closed) return `${base} Closed, so drawn faint.`;
  if (days >= 30) return `${base} 30 days or more: red.`;
  if (days >= 14) return `${base} 14 to 29 days: amber.`;
  return `${base} Under 14 days.`;
}
