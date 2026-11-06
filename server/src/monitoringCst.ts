/**
 * The Customer Service Twin on the Monitoring Twin (6 Nov 2026, Destiny; Jason's Engine-first list on
 * the 5 Nov log: CST wired into the Monitoring Twin). CST sends its calls and texts here through
 * `POST /api/engine/cst-events`; this says what arrived, by channel. CST sends nothing to Research
 * Twin and reads no farm data, so a sensor fault is never in these rows.
 *
 * It carries no message, reply, number or name: this read reaches Genie's and the twins' tokens, and
 * the whole record stays on the Customer Service Twin page. Test traffic is counted in nothing.
 * A quiet line is not a fault, so an empty window is said as empty and opens no incident.
 */
import type { Queryable } from './pg';

export const WATCH = { recent: 20, window_days: 7, channels: ['voice', 'sms', 'whatsapp', 'web', 'email'] };

export interface TurnRow {
  turn_id: string;
  channel: string | null;
  at: string | null;
  status: string | null;
  intent: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  duration_ms: number | null;
}

const failedDelivery = (d: string | null) => d === 'failed' || d === 'undelivered';
export const isFailed = (r: TurnRow) => r.status === 'error' || failedDelivery(r.delivery_status);

/** Pure: rows newest first, the last `window_days` of real turns. */
export function summarise(rows: TurnRow[], newest: Map<string, string>, now: number) {
  const dayAgo = now - 86_400_000;
  const channels = WATCH.channels
    .map((channel) => {
      const of = rows.filter((r) => r.channel === channel);
      return {
        channel,
        last_24h: of.filter((r) => r.at !== null && Date.parse(r.at) >= dayAgo).length,
        last_7d: of.length,
        failed_7d: of.filter(isFailed).length,
        last_at: newest.get(channel) ?? null,
      };
    })
    .filter((c) => c.last_at !== null || c.last_7d > 0);
  return {
    source: 'POST /api/engine/cst-events',
    window_days: WATCH.window_days,
    channels,
    last_at: [...newest.values()].sort().at(-1) ?? null,
    turns_7d: rows.length,
    failed_7d: rows.filter(isFailed).length,
    recent: rows.slice(0, WATCH.recent).map((r) => ({ ...r, failed: isFailed(r) })),
    note: rows.length
      ? 'Real calls and texts only; test traffic is left out. The words and numbers are on the Customer Service Twin page.'
      : `No real call or text has arrived in ${WATCH.window_days} days. A quiet line is not a fault, and this says nothing about whether CST tried to send one.`,
  };
}

export async function read(db: Queryable, now = Date.now()) {
  const iso = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  try {
    const [rows, newest] = await Promise.all([
      db.query<TurnRow>(
        `SELECT turn_id, channel, ${iso('occurred_at')} AS at, status, intent, delivery_status, delivery_error, duration_ms
           FROM engine_cst_turns WHERE NOT test AND occurred_at >= now() - ($1::int * interval '1 day') ORDER BY occurred_at DESC`,
        [WATCH.window_days],
      ),
      db.query<{ channel: string; at: string }>(`SELECT channel, ${iso('max(occurred_at)')} AS at FROM engine_cst_turns WHERE NOT test AND channel IS NOT NULL GROUP BY channel`),
    ]);
    return { ok: true as const, ...summarise(rows.rows, new Map(newest.rows.map((n) => [n.channel, n.at])), now) };
  } catch (e) {
    return { ok: false as const, note: `The CST rows could not be read: ${e instanceof Error ? e.message : String(e)}. That is not the same as no calls.` };
  }
}
