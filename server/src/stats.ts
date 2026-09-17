/**
 * The statistics tab behind every record page: one month set against the month
 * before it.
 *
 * Built for Codex on 16 Sep 2026 and generalised the same day (Destiny) to Open
 * loops, Build patterns, Commercial, Clients, North Star and Research Twin. One
 * engine, one set of honesty rules, one sentence-writer — six pages computing a
 * month-over-month change separately would eventually disagree about what "down
 * 12%" means.
 *
 * Each page contributes a **spec**: what dates a record into a month, and a
 * list of figures. Everything else — the month span, the like-for-like cut, the
 * refusal, the deltas and the prose — is here and is identical everywhere.
 *
 * **The two rules that keep a comparison honest are the Executions page's**
 * (CLAUDE.md section 7), and they apply to every kind for the same reason:
 *
 *   1. A month still running is never set against a whole one. On the 16th,
 *      comparing sixteen days of September against the whole of August would
 *      report a collapse every month, so the previous month is cut to the same
 *      elapsed day and the page says which days it used.
 *   2. A comparison whose window predates everything held is refused outright,
 *      and says those months were not quiet, they were not recorded.
 *
 * **Cohort states and dated events are different things** and every spec has to
 * say which it is using. A rate read off the cohort created in a month — an
 * approval rate, a close rate, a movement rate — is a property of those records
 * as they stand today, so it is honest for the whole history and needs no field
 * to have been recording. A figure timed from an event — how long a review
 * took, how long a loop took to close — exists only as far back as the field
 * that dates it, and carries that boundary onto its own tile.
 */
import { getMeta, nowIso } from './db';
import * as store from './store';
import { delta, movement } from './delta';
import type {
  BuildPattern,
  ClientQuestion,
  CodexEntry,
  Loop,
  NsAsk,
  Opportunity,
  RecordStatMetric,
  RecordStats,
  RtAsk,
  RtJob,
  StatKind,
} from '../../src/data/types';

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

function mean(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

/**
 * A percentile by nearest rank, never an interpolation.
 *
 * On a ledger holding four rows an interpolated p95 is a number nobody
 * measured; nearest rank always returns a real observation. Rounded to the
 * whole millisecond, because every duration here is reported in units far
 * coarser than that.
 */
function p(values: number[], pct: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((pct / 100) * s.length) - 1)]);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * Milliseconds between two stamps, or null where either is unreadable or the
 * second is before the first.
 *
 * **Kept in milliseconds, never rounded to days** (2026-09-16, Destiny). A
 * review that took twenty minutes and one that took four hours both rounded to
 * "0 days", which is how a figure meant to say how quickly Jason answers came
 * to say nothing at all. The page turns this into minutes, hours or days at
 * the point it is read.
 */
function msBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/** "18 min", "4.2 hours", "2.1 days" — the unit a person would use out loud. */
export function humanDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${Math.round((ms / 3_600_000) * 10) / 10} hours`;
  return `${Math.round((ms / 86_400_000) * 10) / 10} days`;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
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
  'There is no Paid At, so nothing dates the flip from No to Yes — only that it is Yes now. ' +
  'It becomes a real figure the day the workflow that flips Paid also stamps when it did.';


/* ------------------------------------------------------------- the engine */

/** What a metric is given: the month, where it was cut, and every row of the kind. */
export interface Ctx<T> {
  month: string;
  /** The day of the month the cohort stops at, where the month is still running. */
  cut: number | null;
  all: T[];
}

/** One figure, and what it is a figure of. A null value is a month that cannot support it. */
export interface Figure {
  value: number | null;
  n: number;
  note: string | null;
}

export interface MetricSpec<T> {
  key: string;
  label: string;
  /** The source field, named as Airtable spells it. Printed on the tile. */
  field: string;
  unit: 'count' | 'percent' | 'duration';
  /** Which direction is good news. Null means the page colours nothing. */
  better: 'up' | 'down' | null;
  /** The noun this metric goes by in the one-line summary. Omitted keeps it out of the sentence. */
  word?: string;
  /** True where nothing in the engine records this at all. */
  unavailable?: boolean;
  figure: (cohort: T[], ctx: Ctx<T>) => Figure;
}

export interface KindSpec<T> {
  kind: StatKind;
  /** What dates a record into a month. */
  createdOf: (r: T) => string | null;
  metrics: MetricSpec<T>[];
}

/** Rows dated inside a month, cut at a day where the month is still running. */
function within(iso: string | null, month: string, cutDay: number | null): boolean {
  if (!iso || iso.slice(0, 7) !== month) return false;
  return cutDay === null || Number(iso.slice(8, 10)) <= cutDay;
}

/** Rows of `all` whose own date (not the cohort date) falls in the month. For a dated event. */
export function datedIn<T>(all: T[], at: (r: T) => string | null, ctx: Ctx<T>): T[] {
  return all.filter((r) => within(at(r), ctx.month, ctx.cut));
}

/** A count of rows, as a figure. */
export function count(n: number, note: string | null = null): Figure {
  return { value: n, n, note };
}

/** A share of a base, as a figure. A base of nought is null, never nought per cent. */
export function rate(part: number, whole: number, note: string | null = null): Figure {
  return { value: share(part, whole), n: whole, note };
}

/** The mean of a set of millisecond spans. */
export function average(spans: number[], note: string | null = null): Figure {
  return { value: mean(spans), n: spans.length, note };
}

export function statsOf<T>(spec: KindSpec<T>, rows: T[], month?: string | null): RecordStats {
  const today = nowIso();
  const current = today.slice(0, 7);
  const dated = rows.map((r) => spec.createdOf(r)?.slice(0, 7)).filter((m): m is string => Boolean(m));
  const earliest = dated.length ? [...dated].sort()[0] : current;
  const months = span(earliest, current);

  const selected = month && months.includes(month) ? month : months[months.length - 1];
  const previous = prevMonth(selected);
  // A running month is compared against the same elapsed stretch of the month
  // before it, and against nothing else.
  const cut = selected === current ? Number(today.slice(8, 10)) : null;
  // Before the earliest month held there is no comparison to make, and saying
  // "down 100%" there would be a lie about a month nobody was recording.
  const covered = previous >= earliest;

  const ctxOf = (m: string): Ctx<T> => ({ month: m, cut, all: rows });
  const cohortOf = (m: string) => rows.filter((r) => within(spec.createdOf(r), m, cut));
  const nowCohort = cohortOf(selected);
  const beforeCohort = cohortOf(previous);

  const metrics: RecordStatMetric[] = spec.metrics.map((m) => {
    const here = m.unavailable ? { value: null, n: 0, note: null } : m.figure(nowCohort, ctxOf(selected));
    const there = m.unavailable || !covered ? { value: null, n: 0, note: null } : m.figure(beforeCohort, ctxOf(previous));
    return {
      key: m.key,
      label: m.label,
      field: m.field,
      unit: m.unit,
      value: here.value,
      previous: there.value,
      n: here.n,
      previous_n: there.n,
      better: m.better,
      note: here.note,
      unavailable: Boolean(m.unavailable),
      change: m.unavailable ? null : delta(there.value, here.value, m.better),
    };
  });

  const windowLabel = cut !== null ? `1–${cut} ${labelOf(previous)}` : labelOf(previous);
  const hereLabel = cut !== null ? `1–${cut} ${labelOf(selected)}` : labelOf(selected);

  return {
    kind: spec.kind,
    months: months.map((m) => ({
      month: m,
      label: labelOf(m),
      logs: rows.filter((r) => within(spec.createdOf(r), m, null)).length,
    })),
    selected,
    selected_label: labelOf(selected),
    previous,
    previous_label: labelOf(previous),
    like_for_like: cut !== null,
    window: covered ? windowLabel : null,
    covered,
    metrics,
    prose: written(spec, metrics, labelOf(previous), covered, cut !== null),
    note: !covered
      ? `There is nothing honest to compare ${labelOf(selected)} against: the first record this database holds is from ${labelOf(earliest)}. ${labelOf(previous)} was not quiet, it was not recorded.`
      : cut !== null
        ? `${hereLabel} against ${windowLabel} — the same ${cut} ${cut === 1 ? 'day' : 'days'} of each month. ${labelOf(selected)} is still running, so it is never set against the whole of ${labelOf(previous)}: that would report a collapse every month, on the 1st worst of all.`
        : `${labelOf(selected)} is complete and is compared against the whole of ${labelOf(previous)}.`,
  };
}

/**
 * The comparison in words, written on the server so the tab and the downloaded
 * report cannot word the same change differently — the same rule the Executions
 * page's period sentence follows.
 *
 * A figure with no comparison is left out of the sentence rather than given a
 * placeholder: saying "and time to payment unchanged" about a figure nothing
 * records is worse than saying nothing.
 */
function written<T>(spec: KindSpec<T>, metrics: RecordStatMetric[], against: string, covered: boolean, cutShort: boolean): string {
  if (!covered) return 'Nothing recorded before this month, so there is no comparison to make.';
  const parts = spec.metrics
    .filter((m) => m.word)
    .map((m) => {
      const built = metrics.find((x) => x.key === m.key);
      if (!built?.change) return null;
      return `${m.word} ${movement(built.change, m.unit === 'percent' ? 'rate' : 'pct')}`;
    })
    .filter((p): p is string => p !== null);
  if (!parts.length) return `Nothing in ${against} can be compared against, so there is no change to report.`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Against ${cutShort ? `the same days of ${against}` : against}: ${list}.`;
}

/* --------------------------------------------------------------- the kinds */

/**
 * **Every tile's note is one or two short sentences, and they are all about the
 * same length** (2026-09-16, Destiny). They were not: approval time ran to
 * seventy words where pay rate ran to twelve, so a row of cards read as six
 * different objects and the longest note pushed its own figure out of line.
 *
 * What a note is for: the base the figure is over, and the boundary if it has
 * one. Nothing else. The reasoning behind a rule lives in CLAUDE.md and in the
 * comments here, where it is the spec rather than a caption — the same
 * decision that took the three stage rules off the Codex page on 14 Sep.
 */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Codex entries.
 *
 * Three cohort states honest for the whole history, one dated event with a hard
 * boundary, and one figure nothing records at all.
 */
function codexSpec(): KindSpec<CodexEntry> {
  const reviewBoundary = REVIEWED_AT_FROM.slice(0, 7);
  const reviewsIn = (ctx: Ctx<CodexEntry>) =>
    datedIn(ctx.all.filter((e) => e.reviewed_at && e.logged_at), (e) => e.reviewed_at, ctx);
  const spans = (ctx: Ctx<CodexEntry>) =>
    reviewsIn(ctx).map((e) => msBetween(e.logged_at!, e.reviewed_at!)).filter((d): d is number => d !== null);
  /** Approved logs carrying a Paid value at all. An empty Paid is unknown, never No. */
  const payable = (c: CodexEntry[]) => c.filter((e) => e.stage === 'approved' && e.paid !== null);

  return {
    kind: 'codex',
    createdOf: (e) => e.logged_at,
    metrics: [
      {
        key: 'logs',
        label: 'Logs submitted',
        field: 'Timestamp',
        unit: 'count',
        // More logs is not by itself good news and fewer is not bad — it tracks
        // how much work was done, not how well. Uncoloured, like executions.
        better: null,
        word: 'logs',
        figure: (c) => count(c.length, 'By Timestamp, which every submission carries. No month is missing one.'),
      },
      {
        key: 'approval_rate',
        label: 'Approval rate',
        field: 'Jason Status → Approved or Input Added',
        unit: 'percent',
        better: 'up',
        word: 'approval rate',
        figure: (c) => {
          const approved = c.filter((e) => e.stage === 'approved').length;
          return rate(
            approved,
            c.length,
            c.length
              ? `${approved} of ${plural(c.length, 'log')} approved so far. A cohort's state rather than a dated event, so it is honest for the whole history.`
              : 'No log was written this month, so there is no rate — not a rate of nought.',
          );
        },
      },
      {
        key: 'approval_time',
        label: 'Average approval time',
        field: 'Jason Reviewed At − Timestamp',
        unit: 'duration',
        better: 'down',
        word: 'approval time',
        figure: (_c, ctx) => {
          const ms = spans(ctx);
          /**
           * Three things, and the month decides which apply: the boundary where
           * the field was not recording, the base the mean is over, and the
           * median beside it.
           *
           * **The base is never dropped for the boundary.** A mean of seven
           * reviews where one took two days and the rest took under an hour is
           * 7.8 hours, and a reader who cannot see that the middle one took 55
           * minutes will read 7.8 hours as how long Jason usually takes. The
           * mean is the headline; the median is how it is checked.
           */
          const note = [
            ms.length
              ? `The mean over ${plural(ms.length, 'decision')} made this month${ms.length > 1 ? `; the middle one took ${humanDuration(median(ms))}` : ''}.`
              : null,
            ctx.month < reviewBoundary
              ? `Jason Reviewed At began ${REVIEWED_AT_FROM} and nothing is backfilled, so these months were not instant — they were not timed.`
              : ctx.month === reviewBoundary
                ? `Partial: only decisions from ${REVIEWED_AT_FROM} on. ${labelOf(nextMonth(reviewBoundary))} is the first whole month.`
                : null,
          ]
            .filter(Boolean)
            .join(' ');
          return { value: ctx.month < reviewBoundary ? null : mean(ms), n: ms.length, note };
        },
      },
      {
        key: 'flag_rate',
        label: 'Stopped by the check',
        field: 'Layer0 Flagged',
        unit: 'percent',
        better: 'down',
        word: 'completeness flags',
        figure: (c) => {
          const flagged = c.filter((e) => e.layer0_flagged).length;
          return rate(
            flagged,
            c.length,
            c.length
              ? `${flagged} of ${plural(c.length, 'log')} flagged. Layer0 Flagged means flagged once ever, so this is how often the check stopped one.`
              : 'No log was written this month, so there is nothing for the check to have stopped.',
          );
        },
      },
      {
        key: 'pay_rate',
        label: 'Pay rate',
        field: 'Paid, over approved logs',
        unit: 'percent',
        better: 'up',
        word: 'pay rate',
        figure: (c) => {
          const base = payable(c);
          const paid = base.filter((e) => e.paid === true).length;
          const unpriced = c.filter((e) => e.stage === 'approved' && e.paid === null).length;
          return rate(
            paid,
            base.length,
            base.length
              ? `${paid} of ${plural(base.length, 'approved log')} marked paid.${
                  unpriced ? ` ${plural(unpriced, 'more')} ${unpriced === 1 ? 'carries' : 'carry'} no Paid value and ${unpriced === 1 ? 'is' : 'are'} left out, never counted as unpaid.` : ''
                }`
              : c.some((e) => e.stage === 'approved')
                ? 'No approved log here carries a Paid value yet, so there is no rate. Resync to pull the column through.'
                : 'No log from this month is approved, so there is nothing to have paid.',
          );
        },
      },
      {
        key: 'pay_time',
        label: 'Average time to payment',
        field: 'no field records this',
        unit: 'duration',
        better: 'down',
        unavailable: true,
        figure: () => ({ value: null, n: 0, note: NO_PAY_CLOCK }),
      },
    ],
  };
}

/**
 * Open loops.
 *
 * `Date Raised` has always been written, so raised and the close *rate* are
 * honest for the whole history. **A close is dated by this dashboard's own
 * status ledger and by nothing else** — the loop tables carry no close date and
 * nothing upstream keeps a status-change history — so the dated figures begin
 * where the ledger began and say so.
 */
function loopsSpec(closes: Map<string, string>, since: string | null): KindSpec<Loop> {
  const ledgerMonth = since ? since.slice(0, 7) : nowIso().slice(0, 7);
  // Short on purpose: it is one of five footnotes that have to sit at the same
  // height. Why the ledger is the only source is in CLAUDE.md, not on the card.
  const ledgerNote = `Dated by this dashboard's ledger, which began ${since?.slice(0, 10) ?? 'at first boot'}. Before then there is no closed figure at all.`;
  const closedIn = (ctx: Ctx<Loop>) => ctx.all.filter((l) => within(closes.get(l.id) ?? null, ctx.month, ctx.cut));

  return {
    kind: 'loops',
    createdOf: (l) => l.raised_at,
    metrics: [
      {
        key: 'raised',
        label: 'Loops raised',
        field: 'Date Raised',
        unit: 'count',
        better: null,
        word: 'loops raised',
        figure: (c) => count(c.length, 'By Date Raised, which every loop carries. No month is missing one.'),
      },
      {
        key: 'closed',
        label: 'Loops closed',
        field: 'Status → Closed, dated by this dashboard’s ledger',
        unit: 'count',
        better: 'up',
        word: 'loops closed',
        figure: (_c, ctx) => {
          const n = closedIn(ctx).length;
          return {
            value: ctx.month < ledgerMonth ? null : n,
            n,
            note: ctx.month < ledgerMonth ? ledgerNote : `${plural(n, 'loop')} closed in this month. ${ledgerNote}`,
          };
        },
      },
      {
        key: 'close_rate',
        label: 'Close rate',
        field: 'Status, over the loops raised that month',
        unit: 'percent',
        better: 'up',
        word: 'close rate',
        figure: (c) => {
          const closed = c.filter((l) => l.status === 'closed').length;
          return rate(
            closed,
            c.length,
            c.length
              ? `${closed} of ${plural(c.length, 'loop')} raised here are closed today. A cohort's state, so it is honest even where the ledger is not.`
              : 'No loop was raised this month, so there is no rate — not a rate of nought.',
          );
        },
      },
      {
        key: 'close_time',
        label: 'Average time to close',
        field: 'ledger close − Date Raised',
        unit: 'duration',
        better: 'down',
        word: 'time to close',
        figure: (_c, ctx) => {
          const ms = closedIn(ctx)
            .map((l) => (l.raised_at ? msBetween(l.raised_at, closes.get(l.id)!) : null))
            .filter((d): d is number => d !== null);
          const note = [
            ctx.month < ledgerMonth ? ledgerNote : null,
            ms.length
              ? `The mean over ${plural(ms.length, 'close')} dated here${ms.length > 1 ? `; the middle one took ${humanDuration(median(ms))}` : ''}.`
              : null,
          ]
            .filter(Boolean)
            .join(' ');
          return { value: ctx.month < ledgerMonth ? null : mean(ms), n: ms.length, note: note || ledgerNote };
        },
      },
      {
        /**
         * The sixth tile, so the grid is two full rows rather than five and a
         * gap (2026-09-16, Destiny). It is not filler: an average age hides its
         * own tail, and the oldest loop still open from a month is the one
         * somebody actually has to go and deal with. Cohort state, aged from
         * Date Raised to now, so it needs no field that was not already there.
         */
        key: 'oldest_open',
        label: 'Longest still open',
        field: 'now − Date Raised, the oldest still open',
        unit: 'duration',
        better: 'down',
        figure: (c) => {
          const now = nowIso();
          const ms = c
            .filter((l) => l.status !== 'closed' && l.raised_at)
            .map((l) => msBetween(l.raised_at!, now))
            .filter((d): d is number => d !== null);
          return {
            value: ms.length ? Math.max(...ms) : null,
            n: ms.length,
            note: ms.length
              ? `The oldest of the ${plural(ms.length, 'loop')} raised here that ${ms.length === 1 ? 'is' : 'are'} still open.`
              : c.length
                ? 'Every loop raised this month is closed, so none is still ageing.'
                : 'No loop was raised this month.',
          };
        },
      },
      {
        key: 'open_age',
        label: 'Average age still open',
        field: 'now − Date Raised, those still open',
        unit: 'duration',
        better: 'down',
        figure: (c) => {
          const now = nowIso();
          const ms = c
            .filter((l) => l.status !== 'closed' && l.raised_at)
            .map((l) => msBetween(l.raised_at!, now))
            .filter((d): d is number => d !== null);
          return average(
            ms,
            ms.length
              ? `${plural(ms.length, 'loop')} raised here ${ms.length === 1 ? 'is' : 'are'} still open, aged from Date Raised to now.`
              : c.length
                ? 'Every loop raised this month is closed, so there is no open age to report.'
                : 'No loop was raised this month.',
          );
        },
      },
    ],
  };
}

/**
 * Build patterns.
 *
 * There is no status — `pattern_status` was deleted from the base (2026-09-15,
 * Destiny) — so what varies is `reusability`, and that is what this measures.
 * The extractor's September outage is real history and shows as a low bar, the
 * same as on the chart.
 */
function patternsSpec(): KindSpec<BuildPattern> {
  const broad = (p: BuildPattern) => (p.reusability ?? '').trim().toLowerCase().startsWith('broad');
  return {
    kind: 'patterns',
    createdOf: (p) => p.created_at,
    metrics: [
      {
        key: 'written',
        label: 'Patterns written',
        field: 'created_at',
        unit: 'count',
        better: null,
        word: 'patterns',
        figure: (c) => count(c.length, 'Patterns do not close, so there is no second state and no rate for output — only how many were written.'),
      },
      {
        key: 'broad_rate',
        label: 'Broadly reusable',
        field: 'reusability',
        unit: 'percent',
        better: 'up',
        word: 'broad reusability',
        figure: (c) => {
          const known = c.filter((p) => p.reusability);
          return rate(
            known.filter(broad).length,
            known.length,
            known.length
              ? `${known.filter(broad).length} of ${plural(known.length, 'pattern')} that say anything about reusability answer Broad. Some answer in a sentence rather than Narrow, Moderate or Broad; those count in the base and not in the top.`
              : c.length
                ? 'No pattern written this month records a reusability, so there is no rate — not a rate of nought.'
                : 'No pattern was written this month.',
          );
        },
      },
      {
        key: 'reusability_recorded',
        label: 'Reusability recorded',
        field: 'reusability, over the month’s patterns',
        unit: 'percent',
        better: 'up',
        figure: (c) =>
          rate(
            c.filter((p) => p.reusability).length,
            c.length,
            c.length
              ? `${c.filter((p) => p.reusability).length} of ${plural(c.length, 'pattern')} carry a reusability at all. This is the base the figure beside it is over, which is why it is worth its own tile rather than a footnote.`
              : 'No pattern was written this month.',
          ),
      },
    ],
  };
}

/**
 * Commercial.
 *
 * The page's own question is which cards are closest to ready, so the figures
 * are the ones that move a card towards it: how many were written, how many
 * carry no open research question, how many questions are outstanding, and how
 * many reached Media-Ready.
 */
function commercialSpec(): KindSpec<Opportunity> {
  const open = (o: Opportunity) => o.missing_research_count ?? o.missing_research_questions.length;
  return {
    kind: 'commercial',
    createdOf: (o) => o.created_at,
    metrics: [
      {
        key: 'cards',
        label: 'Cards written',
        field: 'created_at',
        unit: 'count',
        better: null,
        word: 'cards',
        figure: (c) => count(c.length, 'One record missing what a complete extractor run writes carries no created_at at all and belongs to no month.'),
      },
      {
        key: 'clear_rate',
        label: 'Nothing outstanding',
        field: 'missing_research_count = 0',
        unit: 'percent',
        better: 'up',
        word: 'cards with nothing outstanding',
        figure: (c) =>
          rate(
            c.filter((o) => open(o) === 0).length,
            c.length,
            c.length
              ? `${c.filter((o) => open(o) === 0).length} of ${plural(c.length, 'card')} written this month have no open research question today. A cohort's state, not a dated event.`
              : 'No card was written this month, so there is no rate — not a rate of nought.',
          ),
      },
      {
        key: 'open_questions',
        label: 'Open research questions',
        field: 'missing_research_count, summed',
        unit: 'count',
        better: 'down',
        word: 'open research questions',
        figure: (c) => {
          const n = c.reduce((a, o) => a + open(o), 0);
          return count(
            n,
            c.length
              ? `Across the ${plural(c.length, 'card')} written this month, as they stand today. July and early-August cards lack missing_research_count entirely and count as nought open, which is what the record says rather than a guess.`
              : 'No card was written this month.',
          );
        },
      },
      {
        key: 'media_ready',
        label: 'Reached Media-Ready',
        field: 'readiness_state',
        unit: 'percent',
        better: 'up',
        figure: (c) => {
          const known = c.filter((o) => o.readiness_state);
          return rate(
            known.filter((o) => o.readiness_state === 'Media-Ready').length,
            known.length,
            known.length
              ? `Over the ${plural(known.length, 'card')} carrying a readiness_state. INCUBATE has never been used, so in practice this is Media-Ready against Research-First.`
              : 'No card written this month carries a readiness_state.',
          );
        },
      },
    ],
  };
}

/**
 * Clients.
 *
 * Counted by each question's own `Last Updated`, which has always been written
 * correctly. The index's `Last Run At` was frozen at 24 Aug because nothing
 * wrote it back and is deliberately not the source here, the same as on the
 * chart.
 */
function clientsSpec(): KindSpec<ClientQuestion> {
  const moved = (q: ClientQuestion) => Boolean(q.movement_tag && q.movement_tag !== 'same');
  return {
    kind: 'clients',
    createdOf: (q) => q.last_updated,
    metrics: [
      {
        key: 'questions',
        label: 'Questions updated',
        field: 'Last Updated (per question)',
        unit: 'count',
        better: null,
        word: 'questions updated',
        figure: (c) => count(c.length, 'By each question’s own Last Updated, which has always been written correctly. A question never updated belongs to no month.'),
      },
      {
        key: 'moved_rate',
        label: 'Share that moved',
        field: 'Movement Tag',
        unit: 'percent',
        better: 'up',
        word: 'movement',
        figure: (c) =>
          rate(
            c.filter(moved).length,
            c.length,
            c.length
              ? `${c.filter(moved).length} of ${plural(c.length, 'question')} came back new, refined or contradicted. "Same" is a run that found nothing new — it happened, but it is not movement.`
              : 'No question was updated this month, so there is no rate — not a rate of nought.',
          ),
      },
      {
        key: 'contradicted_rate',
        label: 'Contradicted',
        field: 'Movement Tag = contradicted',
        unit: 'percent',
        // A contradiction is research doing its job, not a failure, so nothing
        // here is coloured: rising is not bad news and falling is not good.
        better: null,
        figure: (c) =>
          rate(
            c.filter((q) => q.movement_tag === 'contradicted').length,
            c.length,
            c.length
              ? 'A contradiction is the research overturning an earlier answer. It is neither good nor bad news on its own, so it is not coloured.'
              : 'No question was updated this month.',
          ),
      },
      {
        key: 'stuck',
        label: 'Stuck questions',
        field: 'Research Stuck',
        unit: 'count',
        better: 'down',
        word: 'stuck questions',
        figure: (c) =>
          count(
            c.filter((q) => q.research_stuck).length,
            c.length
              ? 'One of the three circuit breakers that already exist upstream, read rather than recomputed. Among the questions updated this month.'
              : 'No question was updated this month.',
          ),
      },
    ],
  };
}

/**
 * North Star, month against month.
 *
 * Every rate is over the asks that carry the field it reads, and says so.
 * **The durations here are p50, never a mean** — the rule the twins' pages run
 * on, for the same reason: a mean latency hides the slow tail, and the tail is
 * what people feel. `average()` exists in this file for the kinds that were
 * using it before that rule was written; nothing below calls it.
 *
 * This ledger opened on 17 Sep 2026 and starts empty on purpose, so September
 * holds a handful of rows and October is the first clean month. Nothing here
 * smooths that: a month of four asks reports four asks.
 */
function northStarSpec(): KindSpec<NsAsk> {
  return {
    kind: 'northstar',
    createdOf: (r) => r.asked_at,
    metrics: [
      {
        key: 'delivery_rate',
        label: 'Delivery rate',
        field: 'Delivered',
        unit: 'percent',
        better: 'up',
        word: 'delivery rate',
        figure: (c) =>
          rate(
            c.filter((r) => r.delivered === 'Delivered').length,
            c.length,
            c.length
              ? `Answers that actually reached someone, over all ${plural(c.length, 'ask')} this month. Delivery is recorded after the answer is sent, so this is what arrived rather than what was attempted. Below 100% is a real failure — North Star once ran green for six days while Slack rejected every post.`
              : 'Nothing was asked this month, so there is nothing whose delivery could be recorded.',
          ),
      },
      {
        key: 'answered_rate',
        label: 'Answered rate',
        field: 'Outcome',
        unit: 'percent',
        better: 'up',
        word: 'answered rate',
        figure: (c) =>
          rate(
            c.filter((r) => r.outcome === 'Answered').length,
            c.length,
            c.length
              ? `Asks that came back Answered, over all ${plural(c.length, 'ask')} this month. Thin, Refused and Failed are the other three outcomes and are counted apart; nothing is inferred from the answer text.`
              : 'Nothing was asked this month.',
          ),
      },
      {
        key: 'asks',
        label: 'Asks',
        field: 'Asked At',
        unit: 'count',
        better: null,
        word: 'asks',
        figure: (c) => count(c.length, 'Every ask North Star logged this month. Silence here is itself the signal, which is why nought is a real answer rather than a missing one.'),
      },
      {
        key: 'response_p50',
        label: 'Response time (p50)',
        field: 'Response Seconds',
        unit: 'duration',
        better: 'down',
        word: 'median response time',
        figure: (c) => {
          const timed = c.filter((r) => r.response_seconds !== null);
          return {
            value: p(timed.map((r) => r.response_seconds! * 1000), 50),
            n: timed.length,
            note: timed.length
              ? `The median, over the ${timed.length} of ${plural(c.length, 'ask')} that recorded a duration. **Never a mean**: a mean hides the slow tail, and the slow tail is what people experience. The p95 is on the Asks tab beside it.`
              : c.length
                ? `None of this month's ${plural(c.length, 'ask')} recorded a response time, so there is no figure — not a figure of nought.`
                : 'Nothing was asked this month.',
          };
        },
      },
      {
        key: 'citation_rate',
        label: 'Citation coverage',
        field: 'Citation Coverage',
        unit: 'percent',
        better: 'up',
        word: 'citation coverage',
        figure: (c) => {
          const known = c.filter((r) => r.citation_coverage !== null);
          return {
            value: known.length ? Math.round((known.reduce((n, r) => n + r.citation_coverage!, 0) / known.length) * 1000) / 10 : null,
            n: known.length,
            note: known.length
              ? `The share of tool calls that produced a traceable citation, averaged over the ${known.length} of ${plural(c.length, 'ask')} that recorded one — as the agent computed it, not a model-reported confidence. Asks recording none are excluded rather than counted as nought.`
              : 'No ask this month records a citation coverage figure.',
          };
        },
      },
    ],
  };
}

/**
 * Research Twin's asks, month against month.
 *
 * The headline is whether it went outside BHA at all. Bays and North Star can
 * both query BHARAG directly, so an ask Research Twin answered without leaving
 * the building is one either of them could have answered themselves.
 */
function researchTwinSpec(): KindSpec<RtAsk> {
  return {
    kind: 'researchtwin',
    createdOf: (r) => r.asked_at,
    metrics: [
      {
        key: 'external_rate',
        label: 'Went outside BHA',
        field: 'Used Web Search',
        unit: 'percent',
        better: null,
        word: 'external-search rate',
        figure: (c) =>
          rate(
            c.filter((r) => r.used_web_search).length,
            c.length,
            c.length
              ? `Asks that needed a search outside BHA, over all ${plural(c.length, 'ask')} this month. Read from the run's own checkbox, never from the answer text. Neither direction is news on its own — a month of internal questions is a real month — so it is not coloured; the trend is what matters and it is on the statistics tab.`
              : 'Nothing was asked this month.',
          ),
      },
      {
        key: 'answered_rate',
        label: 'Answered rate',
        field: 'Outcome',
        unit: 'percent',
        better: 'up',
        word: 'answered rate',
        figure: (c) =>
          rate(
            c.filter((r) => r.outcome === 'Answered').length,
            c.length,
            c.length ? `Asks that came back Answered, over all ${plural(c.length, 'ask')} this month. Read beside the escalation rate: correctly handing something to a person is a better outcome than a confident wrong answer.` : 'Nothing was asked this month.',
          ),
      },
      {
        key: 'needs_human_rate',
        label: 'Needing a human',
        field: 'Outcome = Needs human',
        unit: 'percent',
        better: null,
        figure: (c) =>
          rate(
            c.filter((r) => r.outcome === 'Needs human').length,
            c.length,
            c.length
              ? `Asks Research Twin escalated rather than guessed at, over all ${plural(c.length, 'ask')} this month. **Deliberately not coloured**: escalating correctly is the behaviour that was asked of it, so neither direction is bad news on its own.`
              : 'Nothing was asked this month.',
          ),
      },
      {
        key: 'asks',
        label: 'Asks',
        field: 'Asked At',
        unit: 'count',
        better: null,
        word: 'asks',
        figure: (c) => count(c.length, 'Every ask Research Twin logged this month, whatever it came back with.'),
      },
      {
        key: 'response_p50',
        label: 'Response time (p50)',
        field: 'Response Seconds',
        unit: 'duration',
        better: 'down',
        word: 'median response time',
        figure: (c) => {
          const timed = c.filter((r) => r.response_seconds !== null);
          return {
            value: p(timed.map((r) => r.response_seconds! * 1000), 50),
            n: timed.length,
            note: timed.length
              ? `The median, over the ${timed.length} of ${plural(c.length, 'ask')} that recorded a duration. Never a mean; the p95 is on the Asks tab beside it.`
              : c.length
                ? `None of this month's ${plural(c.length, 'ask')} recorded a response time, so there is no figure — not a figure of nought.`
                : 'Nothing was asked this month.',
          };
        },
      },
      {
        key: 'sources',
        label: 'Answers citing nothing',
        field: 'Sources Count',
        unit: 'percent',
        better: 'down',
        figure: (c) => {
          const known = c.filter((r) => r.sources_count !== null);
          return rate(
            known.filter((r) => r.sources_count === 0).length,
            known.length,
            known.length
              ? `Answers backed by no source at all, over the ${known.length} of ${plural(c.length, 'ask')} that recorded a source count. Asks recording no count are excluded — "not recorded" and "nought sources" are different facts.`
              : c.length
                ? `None of this month's ${plural(c.length, 'ask')} records a source count.`
                : 'Nothing was asked this month.',
          );
        },
      },
    ],
  };
}

/**
 * Research jobs, month against month, dated by when the job was opened.
 *
 * **One row per job**, carrying its own status and attempts — not the attempt
 * log this replaced, where a card retried four times was four rows. Nothing
 * here collapses anything, because there is nothing to collapse.
 */
function researchJobsSpec(): KindSpec<RtJob> {
  return {
    kind: 'researchjobs',
    createdOf: (j) => j.opened_at,
    metrics: [
      {
        key: 'capped',
        label: 'Capped, needing a person',
        field: 'Status',
        unit: 'count',
        better: 'down',
        word: 'capped jobs',
        figure: (c) =>
          count(
            c.filter((j) => j.capped).length,
            c.length
              ? `Jobs opened this month that reached three passes without a usable answer. Any above nought needs attention: nothing else in the engine will move them. It is a real outcome the queue records, not a failure it is hiding.`
              : 'No job was opened this month.',
          ),
      },
      {
        key: 'opened',
        label: 'Jobs opened',
        field: 'Opened At',
        unit: 'count',
        better: null,
        word: 'jobs opened',
        figure: (c) => count(c.length, 'Every research job opened this month, by the extractor, by Bays, by Research Twin itself or by a person.'),
      },
      {
        key: 'resolution_rate',
        label: 'Resolution rate',
        field: 'Status',
        unit: 'percent',
        better: 'up',
        word: 'resolution rate',
        figure: (c) => {
          const terminal = c.filter((j) => j.status === 'Resolved' || j.capped);
          return rate(
            terminal.filter((j) => j.status === 'Resolved').length,
            terminal.length,
            terminal.length
              ? `Resolved over resolved-plus-capped, among the ${plural(terminal.length, 'job')} opened this month that have reached a terminal state. **Open jobs are excluded**: one still being worked is neither, and counting it as unresolved would make a busy month look like a failing one.`
              : c.length
                ? `None of the ${plural(c.length, 'job')} opened this month has reached a terminal state yet, so there is no rate — not a rate of nought.`
                : 'No job was opened this month.',
          );
        },
      },
      {
        key: 'resolve_p50',
        label: 'Time to resolve (p50)',
        field: 'Resolved At − Opened At',
        unit: 'duration',
        better: 'down',
        word: 'median time to resolve',
        figure: (c) => {
          const timed = c.filter((j) => j.days_to_resolve !== null);
          return {
            value: p(timed.map((j) => j.days_to_resolve! * 86_400_000), 50),
            n: timed.length,
            note: timed.length
              ? `The median, over the ${timed.length} of ${plural(c.length, 'job')} opened this month that have been resolved and carry both stamps. Never a mean; the p95 is on the Jobs tab beside it. Jobs still open have no duration and are excluded.`
              : c.length
                ? `No job opened this month has both an Opened At and a Resolved At yet, so there is nothing to time.`
                : 'No job was opened this month.',
          };
        },
      },
      {
        key: 'attempts_at_cap',
        label: 'Jobs at the cap',
        field: 'Attempts',
        unit: 'percent',
        better: 'down',
        figure: (c) => {
          const known = c.filter((j) => j.attempts !== null);
          return rate(
            known.filter((j) => j.attempts! >= 3).length,
            known.length,
            known.length
              ? `Jobs that have used all three passes, over the ${known.length} of ${plural(c.length, 'job')} recording an attempt count. Three passes without a usable answer caps the job and hands it to a person; a job with no recorded count is excluded rather than read as nought passes.`
              : c.length
                ? `None of the ${plural(c.length, 'job')} opened this month records an attempt count.`
                : 'No job was opened this month.',
          );
        },
      },
    ],
  };
}

/* -------------------------------------------------------------- dispatch */

export const STAT_KINDS: StatKind[] = ['codex', 'loops', 'patterns', 'commercial', 'clients', 'northstar', 'researchtwin', 'researchjobs'];

export function isStatKind(v: string): v is StatKind {
  return (STAT_KINDS as string[]).includes(v);
}

/** One month of a record kind, against the month before it. */
export async function stats(kind: StatKind, month?: string | null): Promise<RecordStats> {
  switch (kind) {
    case 'codex':
      return statsOf(codexSpec(), await store.codexEntries(), month);
    case 'loops': {
      // Closes are dated by the ledger and by nothing else, so the spec is
      // handed the ledger rather than reaching for a field that does not exist.
      const closes = new Map((await store.loopCloses()).map((c) => [c.record_id, c.at]));
      return statsOf(loopsSpec(closes, await getMeta('history_since')), await store.loops(), month);
    }
    case 'patterns':
      return statsOf(patternsSpec(), await store.patterns(), month);
    case 'commercial':
      return statsOf(commercialSpec(), await store.opportunities(), month);
    case 'clients':
      return statsOf(clientsSpec(), await store.clientQuestions(), month);
    case 'northstar':
      return statsOf(northStarSpec(), await store.nsAsks(), month);
    case 'researchtwin':
      return statsOf(researchTwinSpec(), await store.rtAsks(), month);
    case 'researchjobs':
      return statsOf(researchJobsSpec(), await store.rtJobs(), month);
    default:
      throw new store.StoreError(`${kind as string} has no statistics.`, 404);
  }
}
