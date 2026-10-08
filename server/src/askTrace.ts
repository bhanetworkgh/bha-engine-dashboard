/**
 * The ask trace (2026-10-08, Destiny — LOOP-1790612166457-UDC7).
 *
 * Handoff contract v2 gave every ask an `origin_correlation_id` and a
 * `call_chain` at each front door on 28 Sep, and then lost both: the delivery
 * workflows did not pass them into the agent's context block, so a second hop
 * started a new chain, and no ledger stored them. From 8 Oct the three delivery
 * workflows write `Origin Correlation ID` and `Call Chain` on every row of
 * `bays-asks`, `ns-asks` and `rt-asks`, and this is the read that puts one
 * ask's hops in order.
 *
 * A read and nothing else. Rows written before 8 Oct carry neither field and
 * are never drawn into a trace by guesswork: `Linked Twin Ask` proves two rows
 * are linked and nothing about an origin, so it is not used here.
 */
import { query } from './pg';

const TABLES = [
  { table: 'engine_bays_asks', agent: 'bays', label: 'Bays', page: '/bays' },
  { table: 'engine_ns_asks', agent: 'north_star', label: 'North Star', page: '/north-star' },
  { table: 'engine_rt_asks', agent: 'research_twin', label: 'Research Twin', page: '/research-twin' },
] as const;

export const TRACE_SINCE = '2026-10-08';
const QUESTION_CAP = 600;
const ANSWER_CAP = 1200;

export interface TraceHop {
  agent: string;
  agent_label: string;
  page: string;
  row_id: string;
  ask_id: string | null;
  asked_at: string | null;
  asked_by_system: string | null;
  call_chain: string[];
  hop: number;
  question: string | null;
  answer: string | null;
  answer_chars: number;
  outcome: string | null;
  delivered: string | null;
  response_seconds: number | null;
  slack_link: string | null;
  run_id: string | null;
  error: string | null;
}

const UNION = TABLES.map(
  (t) =>
    `SELECT '${t.agent}' AS agent, id::text AS row_id, fields FROM ${t.table} WHERE COALESCE(fields->>'Origin Correlation ID', '') <> ''`,
).join(' UNION ALL ');

const chainOf = (s: unknown): string[] =>
  String(s ?? '')
    .split('>')
    .map((x) => x.trim())
    .filter(Boolean);

const cut = (s: unknown, n: number): string | null => {
  const t = s === null || s === undefined ? '' : String(s);
  return t ? (t.length > n ? t.slice(0, n - 1) + '…' : t) : null;
};

/** Every origin held, newest first: how many hops it has and which agents answered. */
export async function origins() {
  const r = await query<{ origin: string; hops: string; first_at: string | null; last_at: string | null; agents: string[]; longest: string | null; question: string | null }>(
    `WITH rows AS (${UNION})
     SELECT fields->>'Origin Correlation ID' AS origin,
            count(*)::text AS hops,
            min(fields->>'Asked At') AS first_at,
            max(fields->>'Asked At') AS last_at,
            array_agg(DISTINCT agent) AS agents,
            (array_agg(fields->>'Call Chain' ORDER BY length(COALESCE(fields->>'Call Chain', '')) DESC))[1] AS longest,
            (array_agg(fields->>'Question' ORDER BY fields->>'Asked At' ASC))[1] AS question
       FROM rows
      GROUP BY 1
      ORDER BY max(fields->>'Asked At') DESC NULLS LAST
      LIMIT 200`,
  );
  const list = r.rows.map((o) => ({
    origin: o.origin,
    hops: Number(o.hops),
    first_at: o.first_at,
    last_at: o.last_at,
    agents: o.agents,
    call_chain: chainOf(o.longest),
    question: cut(o.question, 200),
  }));
  return {
    since: TRACE_SINCE,
    origins: list,
    summary: { origins: list.length, multi_hop: list.filter((o) => o.hops > 1).length, cap: 200 },
    note: `Asks recorded before ${TRACE_SINCE} carry no origin id and are not shown. A hop is one row on an agent's ask ledger.`,
  };
}

/** One origin's hops, in the order the chain grew, then by time. */
export async function trace(origin: string) {
  const r = await query<{ agent: string; row_id: string; fields: Record<string, unknown> }>(
    `WITH rows AS (${UNION}) SELECT agent, row_id, fields FROM rows WHERE fields->>'Origin Correlation ID' = $1`,
    [origin],
  );
  const hops: TraceHop[] = r.rows.map((x) => {
    const t = TABLES.find((y) => y.agent === x.agent)!;
    const f = x.fields || {};
    const chain = chainOf(f['Call Chain']);
    const answer = f['Answer'] === null || f['Answer'] === undefined ? '' : String(f['Answer']);
    const secs = f['Response Seconds'];
    return {
      agent: x.agent,
      agent_label: t.label,
      page: t.page,
      row_id: x.row_id,
      ask_id: cut(f['Ask ID'], 80),
      asked_at: cut(f['Asked At'], 40),
      asked_by_system: cut(f['Asked By System'], 60),
      call_chain: chain,
      hop: chain.length || 1,
      question: cut(f['Question'], QUESTION_CAP),
      answer: cut(answer, ANSWER_CAP),
      answer_chars: answer.length,
      outcome: cut(f['Outcome'], 60),
      delivered: cut(f['Delivered'], 60),
      response_seconds: typeof secs === 'number' ? secs : null,
      slack_link: cut(f['Slack Link'], 300),
      run_id: cut(f['Run ID'], 40),
      error: cut(f['Error'], 300),
    };
  });
  hops.sort((a, b) => a.hop - b.hop || String(a.asked_at ?? '').localeCompare(String(b.asked_at ?? '')));
  return {
    origin,
    found: hops.length > 0,
    hops,
    note: hops.length
      ? 'Ordered by the length of each row’s call chain, then by when it was asked. A hop is written when its answer is delivered, so a hop still running is not here yet.'
      : `No ask is held under this origin id. Asks recorded before ${TRACE_SINCE} carry none.`,
  };
}
