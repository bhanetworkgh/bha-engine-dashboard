/**
 * The Bays page's read (2026-10-05, Destiny).
 *
 * `engine_bays_asks` has been written since 28 Sep 2026 and, until this page,
 * read only by the agent scorecard and the quality alert. From 5 Oct it also
 * holds one row per scheduled task run (`Source: scheduled`) and one per Ask
 * Bays panel question (`Source: dashboard_panel`), and a ledger nobody can look
 * at is one nobody can check. This is a read and nothing else: the rows are
 * written by n8n through `/api/engine/bays-asks`, and nothing here changes one.
 *
 * Field names are the ledger's own, read verbatim from the blob. The answer is
 * cut at 6,000 characters for the page (there are hundreds of rows a week and
 * the list ships them all); `answer_chars` is the full length, so a cut answer
 * says it was cut.
 */
import { query } from './pg';

const ANSWER_CAP = 6000;

export interface BaysAskRow {
  id: string;
  ask_id: string | null;
  asked_at: string | null;
  asked_by_system: string | null;
  asked_by_person: string | null;
  source: string | null;
  question: string | null;
  answer: string | null;
  answer_chars: number | null;
  outcome: string | null;
  tool_issues: string | null;
  delivered: string | null;
  delivered_as: string | null;
  delivery_target: string | null;
  slack_link: string | null;
  error: string | null;
  response_seconds: number | null;
  lane: string | null;
  run_id: string | null;
  task_name: string | null;
  task_outcome: string | null;
  retention_cleared_at: string | null;
}

const share = (n: number, of: number, note: string) => ({ n, of, pct: of ? Math.round((n / of) * 1000) / 10 : null, note });

/** Monday of the ISO week, UTC, as YYYY-MM-DD. */
function weekOf(t: string): string {
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Failed, as the ledger says it. Everything else Bays answered, with or without a tool issue. */
export const baysFailed = (a: { outcome: string | null }) => a.outcome === 'Failed';
/** A reply that was meant for somebody and did not reach them. A scheduled run that had nothing to post is not one. */
export const baysUndelivered = (a: { delivered: string | null; source: string | null }) =>
  a.delivered !== null && a.delivered !== 'Delivered' && !(a.source === 'scheduled' && a.delivered === 'Nothing posted');

export async function baysData() {
  const f = (k: string) => `nullif(fields->>'${k}', '')`;
  const r = await query<BaysAskRow & { response_seconds: string | null }>(
    `SELECT id::text AS id,
            ${f('Ask ID')} AS ask_id, ${f('Asked At')} AS asked_at, ${f('Asked By System')} AS asked_by_system,
            ${f('Asked By Person')} AS asked_by_person, ${f('Source')} AS source, ${f('Question')} AS question,
            left(${f('Answer')}, ${ANSWER_CAP}) AS answer, length(fields->>'Answer') AS answer_chars,
            ${f('Outcome')} AS outcome, ${f('Tool Issues')} AS tool_issues, ${f('Delivered')} AS delivered,
            ${f('Delivered As')} AS delivered_as, ${f('Delivery Target')} AS delivery_target, ${f('Slack Link')} AS slack_link,
            left(${f('Error')}, 2000) AS error, ${f('Response Seconds')} AS response_seconds, ${f('Lane')} AS lane,
            ${f('Run ID')} AS run_id, ${f('Task Name')} AS task_name, ${f('Task Outcome')} AS task_outcome,
            ${f('Retention Cleared At')} AS retention_cleared_at
       FROM engine_bays_asks
      ORDER BY fields->>'Asked At' DESC NULLS LAST, id DESC`,
  );
  const asks: BaysAskRow[] = r.rows.map((a) => {
    const s = a.response_seconds === null ? NaN : Number(a.response_seconds);
    return { ...a, response_seconds: Number.isFinite(s) ? s : null };
  });
  const dated = asks.filter((a) => a.asked_at && !Number.isNaN(Date.parse(a.asked_at)));
  const now = Date.now();

  // The last eight weeks, oldest first; a week with nothing held draws nothing.
  const weeks: Array<{ week: string; label: string; total: number; counts: Record<string, number> }> = [];
  for (let i = 7; i >= 0; i--) {
    const w = weekOf(new Date(now - i * 7 * 86_400_000).toISOString());
    weeks.push({ week: w, label: new Date(`${w}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), total: 0, counts: {} });
  }
  for (const a of dated) {
    const w = weeks.find((x) => x.week === weekOf(a.asked_at as string));
    if (!w) continue;
    const o = a.outcome ?? 'No outcome';
    w.total++;
    w.counts[o] = (w.counts[o] ?? 0) + 1;
  }

  const keys = new Map<string, BaysAskRow[]>();
  for (const a of asks) {
    const k = a.source ?? '(not sent)';
    keys.set(k, [...(keys.get(k) ?? []), a]);
  }
  const by_source = [...keys.entries()]
    .map(([key, mine]) => ({
      key,
      label: key,
      asks: mine.length,
      answered: mine.filter((a) => !baysFailed(a)).length,
      delivered: mine.filter((a) => !baysUndelivered(a)).length,
      external: null,
    }))
    .sort((a, b) => b.asks - a.asks);

  const n = asks.length;
  return {
    asks,
    meta: {
      rows: n,
      undated: n - dated.length,
      first_ask_at: dated.length ? (dated[dated.length - 1].asked_at as string) : null,
      last_ask_at: dated.length ? (dated[0].asked_at as string) : null,
      answer_cap: ANSWER_CAP,
    },
    summary: {
      asks: n,
      failed: share(asks.filter(baysFailed).length, n, 'Rows whose Outcome is Failed, over every row held.'),
      outcome_per_week: weeks,
      by_source,
    },
  };
}
