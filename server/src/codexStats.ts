/**
 * The Codex statistics tab: one month set against the month before it.
 *
 * Six figures — how much was logged, how much of it was approved, how fast,
 * how much the completeness check stopped, how much has been paid, and how
 * fast that was. Every one of them is a month-over-month comparison, because
 * "our approval rate is 86%" answers nothing on its own and "up 9 points on
 * August" answers the question somebody actually has.
 *
 * **The two rules that keep a comparison honest are the Executions page's**
 * (CLAUDE.md section 7), and they apply here for the same reason:
 *
 *   1. A month still running is never set against a whole one. On the 16th,
 *      comparing sixteen days of September against the whole of August would
 *      report a collapse every month, so the previous month is cut to the same
 *      elapsed day and the page says which days it used.
 *   2. A comparison whose window predates everything held is refused outright,
 *      and says those months were not quiet, they were not recorded.
 *
 * **Which figures are cohort states and which are dated events** is the other
 * thing this file has to keep straight, and it is the same distinction
 * `monthly.ts` draws for the chart:
 *
 *   logs, approval rate, flag rate, pay rate   properties of the cohort logged
 *                                              in that month, read as they
 *                                              stand today. Honest for the
 *                                              whole history — no field has to
 *                                              have been recording.
 *   days to approval                           a dated event, from
 *                                              `Jason Reviewed At`, which was
 *                                              created on 14 Sep 2026 with no
 *                                              backfill. Bucketed by the month
 *                                              the decision was made, not the
 *                                              month the log was written, so a
 *                                              month is not dragged down by
 *                                              logs nobody has reached yet.
 *   days to payment                            **there is no such field.** See
 *                                              below; the tile says so rather
 *                                              than drawing a zero.
 */
import { nowIso } from './db';
import * as store from './store';
import { delta, movement } from './delta';
import type { CodexEntry, CodexStatMetric, CodexStats } from '../../src/data/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelOf(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1] ?? month} ${y}`;
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Every month from the earliest logged to this one, with no gaps — a month with nothing in it is a fact. */
function span(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 86_400_000) * 10) / 10;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}

/**
 * Rows dated inside a month, optionally cut at a day of the month.
 *
 * The cut is what makes a running month comparable: on 16 September the
 * previous month is read as 1–16 August and nothing after it.
 */
function within(iso: string | null, month: string, cutDay: number | null): boolean {
  if (!iso || iso.slice(0, 7) !== month) return false;
  return cutDay === null || Number(iso.slice(8, 10)) <= cutDay;
}

/** The day `Jason Reviewed At` was created. Nothing before it carries a value, and nothing ever will. */
const REVIEWED_AT_FROM = '2026-09-14';

/**
 * Why there is no time-to-payment figure, said once and shown on its own tile.
 *
 * `Paid` is a Yes/No single select. **Nothing anywhere dates the moment it
 * changed** — there is no Paid At on any of the six builder tables, the way
 * `Jason Reviewed At` dates a review, and this dashboard does not write the
 * field so its own status ledger has never seen it move either. A resync would
 * only record when this database looked, which is not when the payment
 * happened.
 *
 * So the honest answer is that the figure does not exist, not that it is nought
 * or that the data is still coming. It becomes computable the day the workflow
 * that flips `Paid` also stamps the moment it did — exactly as days-to-approval
 * became computable on 14 Sep — and not before.
 */
const NO_PAY_CLOCK =
  'Nothing dates a payment. Paid is a Yes/No select with no Paid At beside it, and this dashboard does not write the field, ' +
  'so neither Airtable nor the status ledger knows when a log went from No to Yes — only that it is Yes now. ' +
  'This becomes a real figure the day the workflow that flips Paid also stamps when it did, the way Jason Reviewed At does for a review.';

interface Cohort {
  month: string;
  cut: number | null;
  /** Logs written in the month — the cohort every rate below is a property of. */
  logs: CodexEntry[];
  /** Decisions made in the month, which is a different set from the logs written in it. */
  reviews: CodexEntry[];
}

function cohortOf(all: CodexEntry[], month: string, cut: number | null): Cohort {
  return {
    month,
    cut,
    logs: all.filter((e) => within(e.logged_at, month, cut)),
    reviews: all.filter((e) => e.reviewed_at && e.logged_at && within(e.reviewed_at, month, cut)),
  };
}

/** Approved logs carrying a Paid value at all. An empty Paid is unknown, never No. */
function payable(c: Cohort): CodexEntry[] {
  return c.logs.filter((e) => e.stage === 'approved' && e.paid !== null);
}

export async function codexStats(month?: string | null): Promise<CodexStats> {
  const all = await store.codexEntries();
  const today = nowIso();
  const current = today.slice(0, 7);
  const dated = all.map((e) => e.logged_at?.slice(0, 7)).filter((m): m is string => Boolean(m));
  const earliest = dated.length ? dated.sort()[0] : current;
  const months = span(earliest, current);

  const selected = month && months.includes(month) ? month : months[months.length - 1];
  const previous = prevMonth(selected);
  const running = selected === current;
  // A running month is compared against the same elapsed stretch of the month
  // before it, and against nothing else.
  const cut = running ? Number(today.slice(8, 10)) : null;
  // The previous month has to have been inside the span at all. Before the
  // first log this database holds there is no comparison to make, and saying
  // "down 100%" there would be a lie about a month nobody was recording.
  const covered = previous >= earliest;

  const now = cohortOf(all, selected, cut);
  const before = cohortOf(all, previous, cut);

  const metric = (
    m: Omit<CodexStatMetric, 'change'> & { better: 'up' | 'down' | null },
  ): CodexStatMetric => ({
    ...m,
    change: covered && !m.unavailable ? delta(m.previous, m.value, m.better) : null,
  });

  const approved = (c: Cohort) => c.logs.filter((e) => e.stage === 'approved').length;
  const flagged = (c: Cohort) => c.logs.filter((e) => e.layer0_flagged).length;
  const paid = (c: Cohort) => payable(c).filter((e) => e.paid === true).length;
  const speed = (c: Cohort) =>
    median(c.reviews.map((e) => daysBetween(e.logged_at!, e.reviewed_at!)).filter((d): d is number => d !== null));

  const unpriced = now.logs.filter((e) => e.stage === 'approved' && e.paid === null).length;
  const reviewBoundary = REVIEWED_AT_FROM.slice(0, 7);

  const metrics: CodexStatMetric[] = [
    metric({
      key: 'logs',
      label: 'Logs submitted',
      field: 'Timestamp',
      unit: 'count',
      value: now.logs.length,
      previous: before.logs.length,
      n: now.logs.length,
      previous_n: before.logs.length,
      // More logs is not by itself good news and fewer is not bad — it tracks
      // how much work was done, not how well. Uncoloured, like executions.
      better: null,
      // "N here, M then" only where there is an M. With no previous month held,
      // printing "0 then" would state a zero for a month nobody recorded,
      // which is the one thing the rest of this file exists to avoid.
      note: `Every submission carries a Timestamp, so this counts the whole month with no boundary${
        cut !== null && covered ? ` — and ${labelOf(previous)} is cut to its first ${cut} days so the two are the same length` : ''
      }.${covered ? ` ${now.logs.length} here, ${before.logs.length} in ${labelOf(previous)}.` : ''}`,
      unavailable: false,
    }),
    metric({
      key: 'approval_rate',
      label: 'Approval rate',
      field: 'Jason Status → Approved or Input Added',
      unit: 'percent',
      value: share(approved(now), now.logs.length),
      previous: share(approved(before), before.logs.length),
      n: now.logs.length,
      previous_n: before.logs.length,
      better: 'up',
      note: now.logs.length
        ? `${approved(now)} of ${now.logs.length} ${now.logs.length === 1 ? 'log' : 'logs'} logged this month stand approved today. A cohort's state, not a dated event, so it is honest for the whole history.`
        : 'No log was written this month, so there is no rate — not a rate of nought.',
      unavailable: false,
    }),
    metric({
      key: 'approval_days',
      label: 'Median days to approval',
      field: 'Jason Reviewed At − Timestamp',
      unit: 'days',
      value: selected < reviewBoundary ? null : speed(now),
      previous: previous < reviewBoundary ? null : speed(before),
      n: now.reviews.length,
      previous_n: before.reviews.length,
      better: 'down',
      note:
        selected < reviewBoundary
          ? `Jason Reviewed At was created on ${REVIEWED_AT_FROM} and there is no backfill, so nothing before ${reviewBoundary} records when a decision was made. Those months were not instant, they were not timed.`
          : selected === reviewBoundary
            ? `Partial: this month holds only the decisions made on or after ${REVIEWED_AT_FROM}, the day Jason Reviewed At was created, so it undercounts. ${labelOf(nextMonth(reviewBoundary))} is the first month it covers whole.`
            : `Over the ${now.reviews.length} ${now.reviews.length === 1 ? 'decision' : 'decisions'} made this month, counted from when each log was written. Bucketed by when the decision was made rather than when the log was, so a month is not dragged down by logs nobody has reached yet.`,
      unavailable: false,
    }),
    metric({
      key: 'flag_rate',
      label: 'Stopped by the completeness check',
      field: 'Layer0 Flagged',
      unit: 'percent',
      value: share(flagged(now), now.logs.length),
      previous: share(flagged(before), before.logs.length),
      n: flagged(now),
      previous_n: flagged(before),
      better: 'down',
      note: now.logs.length
        ? `${flagged(now)} of ${now.logs.length} ${now.logs.length === 1 ? 'log' : 'logs'} ${flagged(now) === 1 ? 'was' : 'were'} flagged. Layer0 Flagged means was flagged once, ever — nothing clears it when the builder answers — so this is how often the check stopped a log, not how many are still owed.`
        : 'No log was written this month, so there is nothing for the check to have stopped.',
      unavailable: false,
    }),
    metric({
      key: 'pay_rate',
      label: 'Pay rate',
      field: 'Paid, over approved logs',
      unit: 'percent',
      value: share(paid(now), payable(now).length),
      previous: share(paid(before), payable(before).length),
      n: payable(now).length,
      previous_n: payable(before).length,
      better: 'up',
      note: payable(now).length
        ? `${paid(now)} of ${payable(now).length} approved ${payable(now).length === 1 ? 'log' : 'logs'} from this month ${paid(now) === 1 ? 'is' : 'are'} marked paid.${unpriced ? ` ${unpriced} further approved ${unpriced === 1 ? 'log carries' : 'logs carry'} no Paid value at all and ${unpriced === 1 ? 'is' : 'are'} left out rather than counted as unpaid — resync the page to pull the column through.` : ''}`
        : approved(now)
          ? `No approved log from this month carries a Paid value yet, so there is no rate — not a rate of nought. Resync the page to pull the column through from Airtable.`
          : 'No log from this month is approved, so there is nothing to have paid.',
      unavailable: false,
    }),
    metric({
      key: 'pay_days',
      label: 'Median days to payment',
      field: 'no field records this',
      unit: 'days',
      value: null,
      previous: null,
      n: 0,
      previous_n: 0,
      better: 'down',
      note: NO_PAY_CLOCK,
      unavailable: true,
    }),
  ];

  const windowLabel = cut !== null ? `1–${cut} ${labelOf(previous)}` : labelOf(previous);
  const prose = written(metrics, labelOf(previous), covered, cut !== null);

  return {
    months: months.map((m) => ({ month: m, label: labelOf(m), logs: all.filter((e) => within(e.logged_at, m, null)).length })),
    selected,
    selected_label: labelOf(selected),
    previous,
    previous_label: labelOf(previous),
    like_for_like: cut !== null,
    window: covered ? windowLabel : null,
    covered,
    metrics,
    prose,
    note: !covered
      ? `There is nothing honest to compare ${labelOf(selected)} against: the first log this database holds is from ${labelOf(earliest)}. ${labelOf(previous)} was not quiet, it was not recorded.`
      : cut !== null
        ? `${labelOf(selected)} is still running, so it is compared against the same stretch of the month before it — ${windowLabel}, its first ${cut} ${cut === 1 ? 'day' : 'days'} — and not against the whole of it. Setting 16 days against 31 would report a collapse every month.`
        : `${labelOf(selected)} is complete and is compared against the whole of ${labelOf(previous)}.`,
  };
}

/**
 * The comparison in words, written on the server so the tab and anything that
 * quotes it cannot word the same change differently — the same rule the
 * Executions page's period sentence follows.
 *
 * A figure with no comparison is left out of the sentence rather than given a
 * placeholder: a sentence that says "and days to payment unchanged" about a
 * figure nothing records is worse than saying nothing.
 */
function written(metrics: CodexStatMetric[], against: string, covered: boolean, cutShort: boolean): string {
  if (!covered) return `Nothing recorded before this month, so there is no comparison to make.`;
  const say = (key: string, word: string, unit: 'pct' | 'points'): string | null => {
    const m = metrics.find((x) => x.key === key);
    return m?.change ? `${word} ${movement(m.change, unit)}` : null;
  };
  const parts = [
    say('logs', 'logs', 'pct'),
    say('approval_rate', 'approval rate', 'points'),
    say('approval_days', 'time to approval', 'pct'),
    say('flag_rate', 'completeness flags', 'points'),
    say('pay_rate', 'pay rate', 'points'),
  ].filter((p): p is string => p !== null);
  if (!parts.length) return `Nothing in ${against} can be compared against, so there is no change to report.`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Against ${cutShort ? `the same days of ${against}` : against}: ${list}.`;
}
