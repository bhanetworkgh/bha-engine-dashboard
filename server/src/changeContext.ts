/**
 * Who made a change, through which door, in which run (25 Nov 2026, Destiny — PT9J / MPMD Part A,
 * Jason's six change fields and two approver fields).
 *
 * Every way a write reaches this server already knows who asked: an MCP tool call knows its token
 * and its requester, an engine route knows it is n8n, a page route knows it is the page, and a timer
 * knows its own name. This carries that knowledge down to the database without threading it through
 * every function: an AsyncLocalStorage context set once at each door, which `pg.ts` writes into the
 * transaction as `bha.actor`, `bha.run_id`, `bha.via` and `bha.handler`. The status ledger (`events`)
 * and the version history (`engine_record_history`) take those settings as column defaults, so a
 * change records who made it with no change to any write path.
 *
 * A write with no context records nulls, never a guess.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface ChangeContext {
  /** The person or system that asked for the change: a Slack id, an agent, `n8n`, `page`, a timer. */
  actor: string | null;
  /** The run that did it: an n8n execution id, an MCP call id, a timer tick, or a request id. */
  run_id: string | null;
  /** The door it came through, e.g. `mcp:update_record`, `engine:PATCH /api/engine/loops/12`, `timer:decision watch`. */
  via: string;
  /** What carried it out: the agent, n8n, the dashboard page, the dashboard process. */
  handler: string | null;
}

const als = new AsyncLocalStorage<ChangeContext>();

/** Runs `fn` with `ctx` as the change context for everything it awaits. */
export function run<T>(ctx: ChangeContext, fn: () => T): T {
  return als.run(clean(ctx), fn);
}

/** Sets the context for the rest of the current async chain (a timer tick). */
export function enter(ctx: ChangeContext): void {
  als.enterWith(clean(ctx));
}

export function current(): ChangeContext | undefined {
  return als.getStore();
}

export function newRunId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

const cap = (v: string | null | undefined, n: number): string | null => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  return s ? s.slice(0, n) : null;
};

function clean(ctx: ChangeContext): ChangeContext {
  return { actor: cap(ctx.actor, 120), run_id: cap(ctx.run_id, 120), via: cap(ctx.via, 200) ?? 'unknown', handler: cap(ctx.handler, 120) };
}

/** The statement and values that write the context into the current transaction (`is_local` true). */
export function settingsSql(ctx: ChangeContext): { text: string; values: string[] } {
  return {
    text: `SELECT set_config('bha.actor', $1, true), set_config('bha.run_id', $2, true), set_config('bha.via', $3, true), set_config('bha.handler', $4, true)`,
    values: [ctx.actor ?? '', ctx.run_id ?? '', ctx.via, ctx.handler ?? ''],
  };
}

/**
 * The tables whose changes are recorded: the status ledger and every table the version history
 * trigger is on (migration 130). Only a write to one of these is wrapped, so a busy write elsewhere
 * (the executions poll, say) costs no extra round trip.
 */
export const TRACKED_TABLES = [
  'engine_loops', 'engine_codex_submissions', 'engine_layer0_holds', 'engine_build_patterns', 'engine_commercial_cards',
  'engine_ns_asks', 'engine_bays_asks', 'engine_rt_asks', 'engine_rt_jobs', 'engine_client_lanes', 'engine_client_questions',
  'engine_client_requests', 'engine_incidents', 'engine_error_counts', 'engine_retry_attempts', 'engine_pay_builders',
  'engine_pay_sessions', 'engine_pay_statements', 'engine_channel_tracking', 'engine_review_returns', 'engine_lane_backlog',
  'engine_deep_think_log', 'engine_builder_profiles', 'engine_pattern_candidates',
];
const TRACKED = new RegExp(`\\b(events|${TRACKED_TABLES.join('|')})\\b`, 'i');

/** A statement that can change a tracked record, and so should carry the context. */
export function isWrite(text: string): boolean {
  return /^\s*(update|delete|insert|with)\b/i.test(text) && /\b(update|delete|insert)\b/i.test(text) && TRACKED.test(text);
}
