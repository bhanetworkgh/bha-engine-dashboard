/**
 * The monthly rollups behind the five record pages.
 *
 * **The whole risk in this file is a chart that lies by omission.** Every
 * figure here is time-based, and several of the date fields behind them only
 * started being written recently. A month that renders as a low bar because the
 * data did not exist yet reads as a quiet month rather than as a gap in
 * instrumentation, which is worse than no chart at all.
 *
 * So every month carries its own coverage, and `created` and `advanced` carry
 * it separately, because they are usually instrumented from different dates:
 *
 *   full     recording all month
 *   partial  recording for part of it, or known to undercount; the bar is
 *            drawn and marked
 *   none     nothing was recording; **no bar is drawn** and the boundary is
 *            labelled where it falls
 *
 * The boundaries this file encodes, each of them a fact about the engine rather
 * than a rendering choice:
 *
 *   loops       raised has always been dated by `Date Raised`. **Closed is
 *               dated only by this database's own status ledger**, which began
 *               at `meta.history_since` — the loop tables carry no close date
 *               at all and nothing upstream keeps a status-change history. So
 *               the closed series and the close rate simply do not exist before
 *               that month.
 *   codex       approval *rate* is a property of the cohort, not of a dated
 *               event, so it is honest for the whole history. **Days to
 *               approval is not**: `Jason Reviewed At` was created on
 *               14 Sep 2026, there is no backfill and never will be, so
 *               Sep 2026 is partial and Oct 2026 is the first honest month.
 *   patterns    the extractor received empty payloads until the upstream fix on
 *               15 Sep 2026, so Sep 2026 undercounts.
 *   commercial  the same bug stopped card creation after 9 Sep 2026; fixed the
 *               15th. Sep 2026 undercounts, and that is real history rather
 *               than a rendering fault.
 *   clients     per-question `Last Updated` has always been written correctly.
 *               The index's `Last Run At` was frozen at 24 Aug 2026 because
 *               nothing wrote it back, so it is deliberately not the source
 *               here.
 *
 * A record with no usable date is never dropped and never re-bucketed into the
 * earliest month. It is counted as undated, by name.
 */
import { getMeta, nowIso } from './db';
import { query } from './pg';
import * as store from './store';
import type { MonthCoverage, MonthPoint, MonthlyBoundary, MonthlySeries, RecordKind } from '../../src/data/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthOf(iso: string | null): string | null {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null;
}

function labelOf(month: string, spansYears: boolean): string {
  const [y, m] = month.split('-');
  const name = MONTHS[Number(m) - 1] ?? month;
  return spansYears ? `${name} ${y.slice(2)}` : name;
}

/** Every month from the earliest seen to this one, with no gaps — a missing month is a fact. */
function span(months: string[], current: string): string[] {
  const all = [...months, current].filter(Boolean).sort();
  if (!all.length) return [current];
  const out: string[] = [];
  let [y, m] = all[0].split('-').map(Number);
  const [ey, em] = all[all.length - 1].split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
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
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function days(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 86_400_000) * 10) / 10;
}

/**
 * When the mirror row arrived, per record id — used to tell a month of output
 * from a month of imported history.
 *
 * Build Patterns is why this exists: 152 rows, most of them written to Airtable
 * in one go on 12 Aug 2026 carrying `created_at` values spread back through
 * July. Those are real dates and belong on the chart, but a bar of a hundred
 * backdated rows is not a hundred patterns' worth of output that month, and a
 * chart that does not say so is telling a story about productivity that never
 * happened.
 */
async function arrivals(kind: RecordKind): Promise<Map<string, string | null>> {
  const table = store.mirrorTable(kind);
  if (!table) return new Map();
  const r = await query<{ id: string; airtable_record_id: string | null; created_time: string | null }>(
    `SELECT id::text AS id, airtable_record_id, created_time FROM ${table}`,
  );
  return new Map(r.rows.map((x) => [x.airtable_record_id ?? `row-${x.id}`, x.created_time]));
}

/** More than two days between the date a record claims and the row turning up. */
const BACKFILL_DAYS = 2;

function isBackfilled(claimed: string | null, arrived: string | null | undefined): boolean {
  if (!claimed || !arrived) return false;
  const d = days(claimed, arrived);
  return d !== null && d > BACKFILL_DAYS;
}

/* ------------------------------------------------------------ the builder */

interface Item {
  id: string;
  /** The natural key, for the CSV and for naming an undated record. */
  key: string | null;
  created: string | null;
  advanced: boolean;
  /** For a kind whose advance is a dated event rather than a state. */
  advanced_at?: string | null;
  segment?: string | null;
}

interface Spec {
  kind: RecordKind;
  created_label: string;
  created_field: string;
  advanced_label: string | null;
  advanced_field: string | null;
  rate_label: string | null;
  /** Where the advance itself is dated from, when it is dated at all. */
  advanced_dated_from?: MonthlyBoundary | null;
  /** Months the source is known to undercount, and why. */
  partial?: Record<string, string>;
  boundary?: MonthlyBoundary | null;
  undated_note: (n: number) => string;
  segment_keys?: string[];
}

function build(spec: Spec, items: Item[], arrived: Map<string, string | null>): MonthlySeries {
  const current = nowIso().slice(0, 7);
  const dated = items.filter((i) => monthOf(i.created));
  const undated = items.filter((i) => !monthOf(i.created));
  const months = span(dated.map((i) => monthOf(i.created)!), current);
  const spansYears = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const advancedFrom = spec.advanced_dated_from ?? null;

  const points: MonthPoint[] = months.map((month) => {
    const mine = dated.filter((i) => monthOf(i.created) === month);
    // An advance the source dates goes in the month it happened; an advance
    // that is a state rather than an event is a property of the cohort that
    // was created in this month, and the label says which.
    const advanced = advancedFrom
      ? dated.filter((i) => i.advanced_at && monthOf(i.advanced_at) === month).length
      : mine.filter((i) => i.advanced).length;
    const backfilled = mine.filter((i) => isBackfilled(i.created, arrived.get(i.id))).length;

    let coverage: MonthCoverage = 'full';
    let note: string | null = null;
    // The month in progress is genuinely incomplete, so it stays hatched and
    // marked "part" — but it carries no sentence (2026-09-16, Destiny).
    // "This month is still running" told a reader what the calendar already
    // told them, and it sat where a real caveat about instrumentation goes,
    // which is the one place a redundant line does damage. A real caveat below
    // still overwrites the coverage and prints its own note.
    if (month === current) coverage = 'partial';
    if (spec.boundary && month < spec.boundary.month) {
      coverage = 'none';
      note = spec.boundary.note;
    }
    if (spec.partial?.[month]) {
      coverage = 'partial';
      note = spec.partial[month];
    }
    if (coverage !== 'none' && backfilled > mine.length / 2 && mine.length > 0) {
      coverage = 'partial';
      note = `${backfilled} of these ${mine.length} rows were written later and backdated into this month, so this is imported history rather than output produced in it.`;
    }

    let advanced_coverage: MonthCoverage = coverage;
    if (advancedFrom && month < advancedFrom.month) advanced_coverage = 'none';
    else if (advancedFrom && month === advancedFrom.month) advanced_coverage = 'partial';

    // A kind with nothing to advance to — patterns do not close — has no rate at
    // all, which is not the same as a rate of nought.
    const rate =
      spec.advanced_label === null || advanced_coverage === 'none' || coverage === 'none' || mine.length === 0
        ? null
        : Math.round((advanced / mine.length) * 100);

    return {
      month,
      label: labelOf(month, spansYears),
      created: coverage === 'none' ? 0 : mine.length,
      advanced: advanced_coverage === 'none' ? 0 : advanced,
      rate,
      coverage,
      advanced_coverage,
      note,
      backfilled,
      segments: spec.segment_keys
        ? Object.fromEntries(spec.segment_keys.map((k) => [k, mine.filter((i) => (i.segment ?? '(none)') === k).length]))
        : null,
    };
  });

  // The month the page opens on: the newest with anything in it, else this one.
  const withRows = [...points].reverse().find((p) => p.created > 0 || p.advanced > 0);

  return {
    kind: spec.kind,
    created_label: spec.created_label,
    created_field: spec.created_field,
    advanced_label: spec.advanced_label,
    advanced_field: spec.advanced_field,
    rate_label: spec.rate_label,
    months: points,
    boundary: spec.boundary ?? advancedFrom ?? null,
    undated: {
      n: undated.length,
      ids: undated.map((i) => i.key ?? i.id).slice(0, 50),
      note: spec.undated_note(undated.length),
    },
    secondary: null,
    segment_keys: spec.segment_keys ?? null,
    current: withRows?.month ?? current,
  };
}

/* -------------------------------------------------------------- the kinds */

async function loopsMonthly(): Promise<MonthlySeries> {
  const all = await store.loops();
  const arrived = await arrivals('loops');
  const since = await getMeta('history_since');
  /**
   * Closes are dated by this database's status ledger and by nothing else. The
   * loop tables carry no close date, nothing upstream keeps a status-change
   * history, and a reconcile at boot is stamped `via = 'mirror'` precisely
   * because it cannot say when the change actually happened. So before the
   * month the ledger started there is no closed figure — not a zero.
   */
  const closeMonth = since ? since.slice(0, 7) : nowIso().slice(0, 7);
  const closes = await store.loopCloses();
  const closeOf = new Map(closes.map((c) => [c.record_id, c.at]));

  return build(
    {
      kind: 'loops',
      created_label: 'Raised',
      created_field: 'Date Raised',
      advanced_label: 'Closed',
      advanced_field: 'Status → Closed, dated by this dashboard’s status ledger',
      rate_label: 'Closed ÷ raised',
      advanced_dated_from: {
        month: closeMonth,
        note:
          `Closes are dated by this dashboard's own status ledger, which began recording on ${since?.slice(0, 10) ?? 'its first boot'}. ` +
          `The loop tables carry no close date and nothing upstream keeps a status-change history, so before ${closeMonth} there is no closed figure at all — ` +
          `which is not the same as a month in which nothing closed. Raised is unaffected: Date Raised has always been written.`,
      },
      undated_note: (n) =>
        n === 0
          ? 'Every loop carries a Date Raised.'
          : `${n} ${n === 1 ? 'loop carries' : 'loops carry'} no Date Raised, so ${n === 1 ? 'it belongs' : 'they belong'} to no month. Counted here rather than dropped or filed under the earliest month.`,
    },
    all.map((l) => ({ id: l.id, key: l.loop_id, created: l.raised_at, advanced: l.status === 'closed', advanced_at: closeOf.get(l.id) ?? null })),
    arrived,
  );
}

/** The day `Jason Reviewed At` was created. Nothing before it carries a value, and nothing ever will. */
const REVIEWED_AT_FROM = '2026-09-14';

async function codexMonthly(): Promise<MonthlySeries> {
  const all = await store.codexEntries();
  const arrived = await arrivals('codex');
  const series = build(
    {
      kind: 'codex',
      created_label: 'Logged',
      created_field: 'Timestamp',
      advanced_label: 'Approved',
      advanced_field: 'Jason Status → Approved or Input Added',
      rate_label: 'Approval rate',
      undated_note: (n) =>
        n === 0
          ? 'Every submission carries a Timestamp.'
          : `${n} ${n === 1 ? 'submission carries' : 'submissions carry'} no Timestamp and ${n === 1 ? 'belongs' : 'belong'} to no month. Counted here rather than dropped.`,
    },
    all.map((e) => ({ id: e.id, key: e.codex_entry_id ?? e.submission_id, created: e.logged_at, advanced: e.stage === 'approved' })),
    arrived,
  );

  /**
   * Days to approval, which is the one metric on this page with a hard
   * instrumentation boundary.
   *
   * `Jason Reviewed At` was created on 14 Sep 2026 and there is no backfill and
   * never will be: every submission before it has an approval decision and no
   * timestamp for when the decision was made. September is therefore partial —
   * it holds only the logs Jason acted on after the 14th — and **October 2026
   * is the first honest month.** The approval *rate* above is unaffected,
   * because it is a property of the cohort rather than of a dated event.
   */
  const boundaryMonth = REVIEWED_AT_FROM.slice(0, 7);
  const [by, bm] = boundaryMonth.split('-').map(Number);
  const firstFull = bm === 12 ? `${by + 1}-01` : `${by}-${String(bm + 1).padStart(2, '0')}`;
  const spansYears = new Set(series.months.map((m) => m.month.slice(0, 4))).size > 1;
  const withReview = all.filter((e) => e.reviewed_at && e.logged_at);

  series.secondary = {
    label: 'Median days to approval',
    unit: 'days',
    points: series.months.map((p) => {
      const mine = withReview.filter((e) => monthOf(e.reviewed_at) === p.month);
      const coverage: MonthCoverage = p.month < boundaryMonth ? 'none' : p.month === boundaryMonth ? 'partial' : p.month === nowIso().slice(0, 7) ? 'partial' : 'full';
      const values = mine.map((e) => days(e.logged_at!, e.reviewed_at!)).filter((d): d is number => d !== null);
      return { month: p.month, label: labelOf(p.month, spansYears), value: coverage === 'none' ? null : median(values), n: coverage === 'none' ? 0 : values.length, coverage };
    }),
    boundary: {
      month: firstFull,
      note:
        `Jason Reviewed At was created on ${REVIEWED_AT_FROM} and there is no backfill, so nothing before it records when a decision was made. ` +
        `${boundaryMonth} holds only the logs reviewed after the 14th, and ${firstFull} is the first honest month for this figure. ` +
        `The approval rate above is not affected: it counts a cohort's state today rather than a dated event.`,
    },
    note: withReview.length
      ? `From Jason Reviewed At minus Timestamp, over the ${withReview.length} ${withReview.length === 1 ? 'log that carries' : 'logs that carry'} a review timestamp.`
      : 'No log carries a Jason Reviewed At yet, so there is no speed to report — not a speed of zero.',
  };
  return series;
}

/** The day the upstream bug that starved both extractors was fixed. */
const EXTRACTOR_FIXED = '2026-09-15';

async function patternsMonthly(): Promise<MonthlySeries> {
  const all = await store.patterns();
  const arrived = await arrivals('patterns');
  return build(
    {
      kind: 'patterns',
      created_label: 'Written',
      created_field: 'created_at',
      // Patterns do not close. There is no second state and no rate, and the
      // page says so rather than inventing one.
      advanced_label: null,
      advanced_field: null,
      rate_label: null,
      partial: {
        [EXTRACTOR_FIXED.slice(0, 7)]: `The extractor received empty payloads for most of this month and correctly produced nothing; the upstream bug was fixed on ${EXTRACTOR_FIXED}. This month undercounts, and the low bar is the outage rather than a fall in output.`,
      },
      undated_note: (n) =>
        n === 0
          ? 'Every pattern carries a created_at.'
          : `${n} ${n === 1 ? 'pattern carries' : 'patterns carry'} no created_at and ${n === 1 ? 'belongs' : 'belong'} to no month. Counted here rather than dropped or filed under the earliest month.`,
    },
    all.map((p) => ({ id: p.id, key: p.pattern_id, created: p.created_at, advanced: false })),
    arrived,
  );
}

async function commercialMonthly(): Promise<MonthlySeries> {
  const all = await store.opportunities();
  const arrived = await arrivals('commercial');
  return build(
    {
      kind: 'commercial',
      created_label: 'Cards written',
      created_field: 'created_at',
      advanced_label: 'Now at zero open questions',
      advanced_field: 'no question listed and missing_research_count = 0',
      rate_label: 'Resolution rate',
      partial: {
        [EXTRACTOR_FIXED.slice(0, 7)]: `Card creation stopped on 2026-09-09 and the upstream bug was not fixed until ${EXTRACTOR_FIXED}, so this month undercounts. That is real history, not a rendering fault.`,
      },
      undated_note: (n) =>
        n === 0
          ? 'Every card carries a created_at.'
          : `${n} ${n === 1 ? 'card carries' : 'cards carry'} no created_at and cannot be placed in any month. Counted here rather than dropped or bucketed into the earliest one.`,
    },
    all.map((o) => ({
      id: o.id,
      key: o.card_id,
      created: o.created_at,
      advanced: o.open_questions === 0,
    })),
    arrived,
  );
}

/** The movement tags, in the order the chart stacks them. */
export const MOVEMENT_TAGS = ['new', 'refined', 'same', 'contradicted'];

async function clientsMonthly(): Promise<MonthlySeries> {
  const all = await store.clientQuestions();
  const arrived = await arrivals('client_questions');
  const series = build(
    {
      kind: 'clients',
      created_label: 'Questions updated',
      created_field: 'Last Updated (per question)',
      advanced_label: 'Moved',
      advanced_field: 'Movement Tag is new, refined or contradicted',
      rate_label: 'Share that moved',
      segment_keys: [...MOVEMENT_TAGS, '(none)'],
      undated_note: (n) =>
        n === 0
          ? 'Every question carries a Last Updated.'
          : `${n} ${n === 1 ? 'question has' : 'questions have'} never been updated, so ${n === 1 ? 'it belongs' : 'they belong'} to no month. Counted here rather than dropped.`,
    },
    all.map((q) => ({
      id: q.id,
      key: q.id,
      created: q.last_updated,
      // "Same" is a run that found nothing new. It happened, but it is not movement.
      advanced: Boolean(q.movement_tag && q.movement_tag !== 'same'),
      segment: q.movement_tag,
    })),
    arrived,
  );
  return series;
}

export async function monthly(kind: RecordKind): Promise<MonthlySeries> {
  switch (kind) {
    case 'loops':
      return loopsMonthly();
    case 'codex':
      return codexMonthly();
    case 'patterns':
      return patternsMonthly();
    case 'commercial':
      return commercialMonthly();
    case 'clients':
      return clientsMonthly();
    default:
      throw new store.StoreError(`${kind} has no monthly rollup.`, 404);
  }
}
