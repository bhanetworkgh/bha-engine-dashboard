/**
 * SE8L persistence: the doctrine-gap watcher's sweeps, gap episodes and alarms (migration 102).
 *
 * Three things the watcher must keep true across a crash, a retry and two instances overlapping on a
 * deploy, and none of them can live in memory:
 *   - one sweep at a time, and a sweep whose owner went quiet is taken over under the SAME seq, with a
 *     new owner token. Every write a sweep makes checks that token inside its own transaction (the
 *     fence), so a stale worker cannot change an episode, finish the sweep or reach BHARAG after the
 *     takeover;
 *   - an episode is confirmed at most once per seq (`last_sweep_seq < seq`), so a replayed reading
 *     never counts twice and a new sweep always counts once;
 *   - an incident is opened by whoever wins the alarm row, and an open one is restated at most once in
 *     any rolling 24 hours, measured from the row's own last_restated_at on the database clock.
 * It decides nothing: doctrineGap.episodeStep and writeDecision decide, this stores.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { query, withTransaction, type Queryable } from './pg';
import type { DoctrineGapObservation, EpisodeRow, EpisodeStep } from './doctrineGap';

export const SWEEP_RULE = { stale_after_minutes: 10, opening_claim_stale_minutes: 2 } as const;
export const RESTATE_HOURS = 24;

export interface Sweep {
  seq: number;
  token: string;
  version: number;
  /** The database's clock when the sweep began. A resumed sweep keeps its first start. */
  at: string;
  resumed: boolean;
}

/** A write that found its sweep owned by somebody else. Nothing in its transaction landed. */
export class FencedError extends Error {
  constructor(seq: number) {
    super(`sweep ${seq} is no longer owned by this worker; its write was refused`);
    this.name = 'FencedError';
  }
}

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const instance = (): string => `${process.env.RENDER_INSTANCE_ID?.trim() || 'local'}:${process.pid}`;
const mint = (prefix: string): string => `${prefix}-${Date.now()}-${randomBytes(3).toString('hex').slice(0, 4).toUpperCase()}`;

/**
 * Start a sweep, take over a quiet one, or say why not. A new row only when none is running (the
 * partial unique index decides, not a read beforehand); a running one is taken over only once its
 * heartbeat is SWEEP_RULE.stale_after_minutes old, keeping its seq and changing its token.
 */
export async function claimSweep(): Promise<{ sweep: Sweep | null; reason: string | null }> {
  const token = randomUUID();
  const fresh = await query<{ seq: string; owner_version: number; at: string }>(
    `INSERT INTO engine_doctrine_gap_sweeps (state, owner_token, claimed_by) VALUES ('running', $1, $2)
     ON CONFLICT DO NOTHING RETURNING seq::text, owner_version, ${TS('started_at')} AS at`,
    [token, instance()],
  );
  if (fresh.rows[0]) return { sweep: { seq: Number(fresh.rows[0].seq), token, version: fresh.rows[0].owner_version, at: fresh.rows[0].at, resumed: false }, reason: null };
  const taken = await query<{ seq: string; owner_version: number; at: string }>(
    `UPDATE engine_doctrine_gap_sweeps SET owner_token = $1, owner_version = owner_version + 1, claimed_by = $2, heartbeat_at = now()
      WHERE state = 'running' AND heartbeat_at < now() - ($3::text || ' minutes')::interval
      RETURNING seq::text, owner_version, ${TS('started_at')} AS at`,
    [token, instance(), String(SWEEP_RULE.stale_after_minutes)],
  );
  if (taken.rows[0]) return { sweep: { seq: Number(taken.rows[0].seq), token, version: taken.rows[0].owner_version, at: taken.rows[0].at, resumed: true }, reason: null };
  return { sweep: null, reason: 'another sweep is running and its owner is still heartbeating' };
}

/**
 * The fence. Inside a transaction: refreshes the heartbeat only if this worker still owns the sweep,
 * and holds the sweep row's lock until commit, so a takeover waits for this transaction and every
 * later write by the old owner fails here. Returns the database's clock.
 */
export async function fence(db: Queryable, sweep: Sweep): Promise<string> {
  const r = await db.query<{ db_now: string }>(
    `UPDATE engine_doctrine_gap_sweeps SET heartbeat_at = now() WHERE seq = $1 AND owner_token = $2 AND state = 'running' RETURNING ${TS('now()')} AS db_now`,
    [sweep.seq, sweep.token],
  );
  if (!r.rows[0]) throw new FencedError(sweep.seq);
  return r.rows[0].db_now;
}

/** Run fn inside one fenced transaction. A FencedError rolls the whole transaction back. */
export function fenced<T>(sweep: Sweep, fn: (db: Queryable, dbNow: string) => Promise<T>): Promise<T> {
  return withTransaction(async (db) => fn(db, await fence(db, sweep)));
}

/** Close a sweep. False when this worker no longer owns it, in which case nothing is written. */
export async function finishSweep(sweep: Sweep, totals: { keys: number; claims_read: number | null; resolver_error: string | null }): Promise<boolean> {
  const r = await query(
    `UPDATE engine_doctrine_gap_sweeps SET state = 'done', finished_at = now(), keys_processed = $3, claims_read = $4, resolver_error = $5
      WHERE seq = $1 AND owner_token = $2 AND state = 'running'`,
    [sweep.seq, sweep.token, totals.keys, totals.claims_read, totals.resolver_error?.slice(0, 500) ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The newest finished sweep and the one running, for the summary: "checked" is a fact about sweeps, not about events. */
export async function lastSweeps(): Promise<{ last_done: Record<string, unknown> | null; running: Record<string, unknown> | null }> {
  const r = await query<Record<string, unknown> & { state: string }>(
    `SELECT seq::text, state, owner_version, ${TS('started_at')} AS started_at, ${TS('heartbeat_at')} AS heartbeat_at, ${TS('finished_at')} AS finished_at, keys_processed, claims_read, resolver_error
       FROM engine_doctrine_gap_sweeps WHERE seq IN (
         (SELECT max(seq) FROM engine_doctrine_gap_sweeps WHERE state = 'done'),
         (SELECT max(seq) FROM engine_doctrine_gap_sweeps WHERE state = 'running'))`,
  );
  return { last_done: r.rows.find((x) => x.state === 'done') ?? null, running: r.rows.find((x) => x.state === 'running') ?? null };
}

/* ---------------------------------------------------------------- episodes */

const EP_COLS = `episode_id, recovery_key, research_key, condition, first_sweep_seq::int AS first_sweep_seq, last_sweep_seq::int AS last_sweep_seq,
  ${TS('started_at')} AS started_at, ${TS('last_confirmed_at')} AS last_confirmed_at, confirmations, continuity, ${TS('ended_at')} AS ended_at, end_reason`;

/** The key's open episode, locked for this transaction, and the highest seq any of its episodes has seen. */
export async function readEpisode(db: Queryable, recoveryKey: string): Promise<{ open: EpisodeRow | null; maxSeq: number | null }> {
  const open = await db.query<EpisodeRow>(`SELECT ${EP_COLS} FROM engine_doctrine_gap_episodes WHERE recovery_key = $1 AND ended_at IS NULL FOR UPDATE`, [recoveryKey]);
  const max = await db.query<{ m: string | null }>(`SELECT max(last_sweep_seq)::text AS m FROM engine_doctrine_gap_episodes WHERE recovery_key = $1`, [recoveryKey]);
  return { open: open.rows[0] ?? null, maxSeq: max.rows[0]?.m == null ? null : Number(max.rows[0].m) };
}

/** Store one step. Every UPDATE repeats the seq guard, so the guard holds even if the step was computed on a stale read. */
export async function applyEpisode(db: Queryable, step: EpisodeStep, o: DoctrineGapObservation, seq: number): Promise<{ episode_id: string | null; changed: boolean }> {
  if (step.action === 'none' || step.action === 'replay') return { episode_id: null, changed: false };
  if (step.action === 'confirm') {
    const r = await db.query(
      `UPDATE engine_doctrine_gap_episodes SET last_confirmed_at = $2, last_sweep_seq = $3, confirmations = confirmations + 1
        WHERE episode_id = $1 AND ended_at IS NULL AND last_sweep_seq < $3`,
      [step.episode_id, step.at, seq],
    );
    return { episode_id: step.episode_id, changed: (r.rowCount ?? 0) > 0 };
  }
  if (step.action === 'end' || step.action === 'end_then_start') {
    const ended = await db.query(
      `UPDATE engine_doctrine_gap_episodes SET ended_at = $2, end_reason = $3, last_sweep_seq = $4 WHERE episode_id = $1 AND ended_at IS NULL AND last_sweep_seq < $4`,
      [step.episode_id, step.at, step.reason, seq],
    );
    if (step.action === 'end' || (ended.rowCount ?? 0) === 0) return { episode_id: step.episode_id, changed: (ended.rowCount ?? 0) > 0 && step.action === 'end' };
  }
  const id = mint('DGE');
  await db.query(
    `INSERT INTO engine_doctrine_gap_episodes (episode_id, recovery_key, research_key, surface, doctrine_id, claim_id, condition, first_sweep_seq, last_sweep_seq, started_at, last_confirmed_at, continuity, continuity_note, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9, $10, $11, $12::jsonb)`,
    [id, o.recovery_key, step.research_key, o.surface, o.doctrine_id, o.claim_id, o.condition, seq, step.at, step.continuity, step.note, JSON.stringify({ reason: o.reason, gap_source: o.gap_source ?? null, observation_id: o.observation_id })],
  );
  return { episode_id: id, changed: true };
}

/** Open episodes with a research question, oldest first, for researchSignals.detectDoctrineGaps. A read. */
export async function openResearchEpisodes(): Promise<Array<EpisodeRow & { surface: string; doctrine_id: string; claim_id: string }>> {
  const r = await query<EpisodeRow & { surface: string; doctrine_id: string; claim_id: string }>(
    `SELECT ${EP_COLS}, surface, doctrine_id, claim_id FROM engine_doctrine_gap_episodes WHERE ended_at IS NULL ORDER BY started_at, id`,
  );
  return r.rows;
}

/* ------------------------------------------------------------------ alarms */

export interface AlarmRow { recovery_key: string; state: 'opening' | 'open' | 'closed'; ledger_id: string | null; opened_at: string | null; last_restated_at: string | null; restatements: number }

export async function readAlarm(recoveryKey: string): Promise<AlarmRow | null> {
  const r = await query<AlarmRow>(
    `SELECT recovery_key, state, ledger_id, ${TS('opened_at')} AS opened_at, ${TS('last_restated_at')} AS last_restated_at, restatements FROM engine_doctrine_gap_alarms WHERE recovery_key = $1`,
    [recoveryKey],
  );
  return r.rows[0] ?? null;
}

/**
 * Claim the right to open this key's incident. Inside a fenced transaction, so a stale worker never
 * claims. One winner: a new row, or a closed one, or an `opening` claim older than
 * SWEEP_RULE.opening_claim_stale_minutes (its owner died mid-call; the winner looks in BHARAG for the
 * incident it may have left before opening another). Returns the claim token, or null.
 */
export async function claimAlarmOpen(db: Queryable, recoveryKey: string): Promise<string | null> {
  const token = randomUUID();
  const r = await db.query<{ claim_token: string }>(
    `INSERT INTO engine_doctrine_gap_alarms (recovery_key, state, claim_token) VALUES ($1, 'opening', $2)
     ON CONFLICT (recovery_key) DO UPDATE SET state = 'opening', claim_token = EXCLUDED.claim_token, claimed_at = now(), ledger_id = NULL, opened_at = NULL, closed_at = NULL, last_restated_at = NULL, restatements = 0
      WHERE engine_doctrine_gap_alarms.state = 'closed'
         OR (engine_doctrine_gap_alarms.state = 'opening' AND engine_doctrine_gap_alarms.claimed_at < now() - ($3::text || ' minutes')::interval)
     RETURNING claim_token`,
    [recoveryKey, token, String(SWEEP_RULE.opening_claim_stale_minutes)],
  );
  return r.rows[0]?.claim_token === token ? token : null;
}

/**
 * The incident exists: record it against the claim. Not fenced on purpose: once BHARAG has opened an
 * incident the fact must be written down whoever owns the sweep now, or the incident is orphaned. The
 * restatement clock starts at the open.
 */
export async function recordAlarmOpen(recoveryKey: string, token: string, ledgerId: string): Promise<boolean> {
  const r = await query(
    `UPDATE engine_doctrine_gap_alarms SET state = 'open', ledger_id = $3, opened_at = now(), last_restated_at = now() WHERE recovery_key = $1 AND claim_token = $2 AND state = 'opening'`,
    [recoveryKey, token, ledgerId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The open attempt failed before an incident existed: give the claim back so the next sweep may try. */
export async function releaseAlarmClaim(recoveryKey: string, token: string): Promise<void> {
  await query(`UPDATE engine_doctrine_gap_alarms SET state = 'closed', closed_at = now() WHERE recovery_key = $1 AND claim_token = $2 AND state = 'opening'`, [recoveryKey, token]);
}

/** BHARAG has closed it. Not fenced, for the reason recordAlarmOpen is not. */
export async function recordAlarmClosed(recoveryKey: string, ledgerId: string): Promise<void> {
  await query(`UPDATE engine_doctrine_gap_alarms SET state = 'closed', closed_at = now() WHERE recovery_key = $1 AND ledger_id = $2 AND state = 'open'`, [recoveryKey, ledgerId]);
}

/**
 * Take this open incident's restatement, if one is due. Inside the fenced transaction that writes the
 * restatement event, so the slot and the event land together or not at all. Due means its
 * last_restated_at (the open, or the last restatement) is at least RESTATE_HOURS old on the database
 * clock: a rolling window, never a calendar bucket, so two restatements are never under 24 hours apart.
 */
export async function takeRestatement(db: Queryable, recoveryKey: string): Promise<{ ledger_id: string; n: number } | null> {
  const r = await db.query<{ ledger_id: string; restatements: number }>(
    `UPDATE engine_doctrine_gap_alarms SET last_restated_at = now(), restatements = restatements + 1
      WHERE recovery_key = $1 AND state = 'open' AND ledger_id IS NOT NULL AND last_restated_at IS NOT NULL AND last_restated_at <= now() - ($2::text || ' hours')::interval
      RETURNING ledger_id, restatements`,
    [recoveryKey, String(RESTATE_HOURS)],
  );
  return r.rows[0] ? { ledger_id: r.rows[0].ledger_id, n: r.rows[0].restatements } : null;
}
