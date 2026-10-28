/**
 * Research signals: one job per signal, a daily budget, and the triggers that
 * were written down and never wired (2026-10-11, Destiny.
 * LOOP-1788310653393-Q9CR; the contract is BP-CONTRACT-005-CLOSED_LOOP_V1,
 * whose "NOT YET WIRED" list this closes except for T7).
 *
 * Two parts.
 *
 *   **The guard.** `open()` is the one way an automatic research job is opened.
 *   Logstream's trigger and the Monitoring Twin's recurrence rule call it too.
 *     - One job per signal. A signal has a key (a fault signature, a card and
 *       its state, a lane and its gap, a red flag name). A signal whose job is
 *       still open adds to that job. A job that was capped is never reopened.
 *       A job that resolved can reopen only where the signal re-arms, and only
 *       after its re-arm days.
 *     - Five new automatic jobs a day (UTC) across the engine. Over that, the
 *       signal waits as `held_budget` and is tried again on every pass.
 *     - Backlog signals (cards that have had missing research for weeks) take
 *       at most three of the five, so a new fault always has room.
 *     - No job is opened while the model credit is under $15, or cannot be
 *       read: research spends credit, and on 10 Oct the account ran dry.
 *
 *   **The triggers.** `detect()` reads what the engine already keeps:
 *     - T4, incidents: an incident its handler marked `research_needed`, or
 *       the same workflow and step ending `needs_human` at the repair bridge
 *       twice in 7 days. (Logstream's 3-in-7 rule is the third T4 source and
 *       calls the guard itself.)
 *     - T5, lane health: a North Star answer that flags Architect Attention or
 *       a lane needing intervention AND ends its gaps with a line
 *       `Research Twin question: <question>`. North Star writes that line; this
 *       never decides what counts as an outside-world question.
 *     - T6, commercial: a card whose lane_state is needs_revision or
 *       pilot_failed, and, once each, a card with missing research and no job.
 *     - T8, repeated red flag: the same `Red Flag Name` on 3 or more logs in
 *       14 days.
 *
 * Not built, and said wherever this is read: T7 (vFarm anomalies) waits on
 * Jegan's vFarm Twin contract, and T6's "high-intent front-door lead" has no
 * definition anybody has agreed.
 *
 * What it can do is open a Research Twin job and add a line to an open one.
 * It closes, retries, edits and pays nothing. No silent failures: a signal that
 * does not get its job keeps a state and a reason, and is tried again.
 */
import { createHash } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineWrite from './engineWrite';
import * as engineEvents from './engineEvents';
import * as logstream from './logstream';
import * as timers from './timers';
import * as doctrineGap from './doctrineGap';
import * as doctrineEpisodes from './doctrineEpisodes';
import * as doctrineConsumer from './doctrineConsumer';
import { JOB_STATUSES } from './sources';

export const RULE = {
  daily_budget: 5,
  backlog_daily_cap: 3,
  credit_floor_usd: 15,
  needs_human_at: 2,
  needs_human_window_days: 7,
  lane_health_window_days: 7,
  red_flag_at: 3,
  red_flag_window_days: 14,
  rearm_fault_days: 7,
  rearm_red_flag_days: 14,
} as const;

export type TriggerCode = 'T4' | 'T5' | 'T6' | 'T8' | 'MONITORING';
export type SignalState = 'job_opened' | 'added_to_job' | 'held_budget' | 'held_credit' | 'not_reopened' | 'failed';

export interface Signal {
  trigger: TriggerCode;
  /** What makes two signals the same signal. */
  key: string;
  /** Written to the job as `Opened By`. */
  source: string;
  /** The one thing that raised it this time: an incident id, an ask id, a card id. A repeat of the same ref changes nothing. */
  ref: string;
  /** A commercial LANE-… id for the job's Lane, or null. */
  lane?: string | null;
  card_id?: string | null;
  question: string;
  context: string;
  /** 1 for a live signal, 2 for backlog. */
  priority?: 1 | 2;
  /** Days after which a resolved job may be reopened by the same signal; null for never. */
  rearm_days?: number | null;
  fixture?: boolean;
  detail?: Record<string, unknown>;
}
export interface Outcome {
  state: SignalState;
  signal_id: string;
  job_id: string | null;
  reason: string | null;
  /** True when `not_reopened` only means "not yet": the signal re-arms and its days have not passed. A caller with its own row keeps that row waiting. */
  wait?: boolean;
}

const LOCK = 8134207623;
const SWEEP_MS = 5 * 60_000;
const OPENROUTER_URL = (process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const mint = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X')}`;
const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/* ---------------------------------------------------------------- credit */

export type Credit = { ok: true; remaining_usd: number; read_at: string } | { ok: false; error: string; read_at: string };
let creditCache: { at: number; value: Credit } | null = null;
const CREDIT_CACHE_MS = 10 * 60_000;

/** The OpenRouter balance, read with the server's own key and held for ten minutes. Never throws. */
export async function credit(fresh = false): Promise<Credit> {
  if (!fresh && creditCache && Date.now() - creditCache.at < CREDIT_CACHE_MS) return creditCache.value;
  const read_at = new Date().toISOString();
  const key = process.env.OPENROUTER_API_KEY?.trim();
  let value: Credit;
  if (!key) value = { ok: false, error: 'OPENROUTER_API_KEY is not set on this server, so the balance cannot be read', read_at };
  else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${OPENROUTER_URL}/credits`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal });
      const text = await res.text();
      let body: { data?: { total_credits?: unknown; total_usage?: unknown } } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        /* not JSON: the status says what happened */
      }
      const total = Number(body.data?.total_credits);
      const used = Number(body.data?.total_usage);
      if (res.status >= 200 && res.status < 300 && Number.isFinite(total) && Number.isFinite(used)) value = { ok: true, remaining_usd: Math.round((total - used) * 100) / 100, read_at };
      else value = { ok: false, error: `OpenRouter answered ${res.status} to the balance read: ${clip(text, 160) || 'no body'}`, read_at };
    } catch (e) {
      value = { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'OpenRouter did not answer the balance read within 10 seconds' : `the balance read failed: ${e instanceof Error ? e.message : String(e)}`, read_at };
    } finally {
      clearTimeout(timer);
    }
  }
  creditCache = { at: Date.now(), value };
  return value;
}
/** For the tests. */
export function forgetCredit(): void {
  creditCache = null;
}

/* ----------------------------------------------------------------- guard */

interface Row {
  id: string;
  signal_id: string;
  state: string;
  job_id: string | null;
  refs: string[];
  rearm_days: number | null;
  opened_at: string | null;
  attempts: number;
  previous_jobs?: string[];
}

/**
 * A job opened before its signal row was told: postRecord landed and the write after it did not (a
 * crash, a failed update). The row has no job_id but a job carries its Signal Key. open() always found
 * such a job while it was still open; once it had been resolved or capped nothing found it, and the
 * next pass opened a second job for the same signal (27 Oct 2026). This writes the job back onto the
 * row, so the rules for a job the row knows about apply to it exactly as they would have. A job the
 * row has already moved past (previous_jobs, after a re-arm) is never it. Open jobs are left to the
 * existing recovery in open(), unchanged.
 */
async function adoptLostJob(row: Row, key: string): Promise<Row> {
  const lost = await query<{ job_id: string; status: string | null; opened_at: string | null }>(
    `SELECT natural_id AS job_id, fields->>'Status' AS status, fields->>'Opened At' AS opened_at FROM engine_rt_jobs
      WHERE fields->>'Signal Key' = $1 AND natural_id IS NOT NULL AND NOT ($2::jsonb ? natural_id) ORDER BY id DESC LIMIT 1`,
    [key, JSON.stringify(row.previous_jobs ?? [])],
  );
  const j = lost.rows[0];
  if (!j || OPEN_STATUSES.includes(j.status ?? '')) return row;
  const openedAt = row.opened_at ?? (j.opened_at && Number.isFinite(Date.parse(j.opened_at)) ? new Date(j.opened_at).toISOString() : null);
  await query(`UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, opened_at = coalesce(opened_at, $3::timestamptz) WHERE id = $1 AND job_id IS NULL`, [row.id, j.job_id, openedAt]);
  console.error(`[research-signals] ${row.signal_id}: job ${j.job_id} (${j.status ?? 'no status'}) carried this signal's key but was not on its row; written back, not reopened`);
  return { ...row, state: 'job_opened', job_id: j.job_id, opened_at: openedAt };
}

const OPEN_STATUSES = ['Pending', 'In Progress'];

async function jobStatus(jobId: string): Promise<string | null> {
  const r = await query<{ status: string | null }>(`SELECT fields->>'Status' AS status FROM engine_rt_jobs WHERE natural_id = $1 ORDER BY id DESC LIMIT 1`, [jobId]);
  return r.rows[0] ? (r.rows[0].status ?? '') : null;
}

async function note(event: 'research_signal_job_opened' | 'research_signal_held', signalId: string, s: Signal, detail: Record<string, unknown>, dedupe: string): Promise<void> {
  try {
    await engineEvents.record({ event_type: event, subject_id: signalId, lane: s.lane ?? null, actor: 'Research signals', detail: { trigger: s.trigger, key: s.key, source: s.source, fixture: s.fixture === true, ...detail }, dedupe_key: dedupe });
  } catch (e) {
    console.error(`[research-signals] ${signalId}: the event was not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The one way an automatic research job is opened. Safe to call again with the
 * same signal and ref: it answers what already happened. Never throws.
 */
export async function open(s: Signal): Promise<Outcome> {
  const priority = s.priority ?? 1;
  const rearm = s.rearm_days ?? null;
  try {
    // What the signal already has, before anything is spent on it.
    const held = await query<Row>(`SELECT id::text, signal_id, state, job_id, refs, rearm_days, opened_at::text, attempts, previous_jobs FROM engine_research_signals WHERE signal_key = $1`, [s.key]);
    const row = held.rows[0] && !held.rows[0].job_id ? await adoptLostJob(held.rows[0], s.key) : held.rows[0];
    let previous: string | null = null;
    if (row?.job_id) {
      const status = await jobStatus(row.job_id);
      const seen = (row.refs ?? []).includes(s.ref);
      if (status !== null && OPEN_STATUSES.includes(status)) {
        if (seen) return { state: 'job_opened', signal_id: row.signal_id, job_id: row.job_id, reason: null };
        await query(`UPDATE engine_research_signals SET refs = refs || $2::jsonb, occurrences = occurrences + 1, last_seen_at = now() WHERE id = $1`, [row.id, JSON.stringify([s.ref])]);
        await addToJob(row.job_id, s);
        return { state: 'added_to_job', signal_id: row.signal_id, job_id: row.job_id, reason: `the signal already has an open job, ${row.job_id}; this was added to it` };
      }
      // The signal keeps the job it got. Saying "not again" changes nothing on its row but the refs.
      const stop = async (reason: string, wait = false): Promise<Outcome> => {
        if (!seen) await query(`UPDATE engine_research_signals SET last_seen_at = now(), refs = refs || to_jsonb($2::text) WHERE id = $1`, [row.id, s.ref]);
        return { state: 'not_reopened', signal_id: row.signal_id, job_id: row.job_id, reason, ...(wait ? { wait: true } : {}) };
      };
      if (status === null) return stop(`its job ${row.job_id} was removed by a person, so it is not opened again automatically`);
      if (status === 'Capped (needs human)') return stop(`its job ${row.job_id} was capped and needs a person; a capped question is not reopened automatically`);
      // A status outside the job vocabulary, an empty one included, is not taken to mean finished (27 Oct
      // 2026): until then it fell through to the rearm rule below and could open a second job.
      if (!JOB_STATUSES.includes(status)) return stop(`its job ${row.job_id} has status "${status}", which is not one this guard knows (${JOB_STATUSES.join(', ')}); it is not reopened automatically`);
      if (rearm === null) return stop(`already researched once: job ${row.job_id} is ${status}`);
      const since = row.opened_at ? (Date.now() - new Date(row.opened_at).getTime()) / 86_400_000 : Infinity;
      if (since < rearm) return stop(`researched ${Math.floor(since)} day(s) ago (job ${row.job_id}, ${status}); the same signal can open a new job after ${rearm} days`, true);
      previous = row.job_id;
    } else {
      // Checked against open jobs first: a job that carries this signal's key and is still open is
      // this signal's job, whatever the row says. It is how a job whose own bookkeeping write was
      // lost (a crash, a failed update) is found again and never opened twice.
      const mineAlready = await query<{ job_id: string }>(`SELECT natural_id AS job_id FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1 AND fields->>'Status' = ANY($2) AND natural_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [s.key, OPEN_STATUSES]);
      if (mineAlready.rows[0] && row) {
        await query(`UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, last_seen_at = now(), opened_at = coalesce(opened_at, now()), refs = CASE WHEN refs ? $3 THEN refs ELSE refs || to_jsonb($3::text) END WHERE id = $1`, [row.id, mineAlready.rows[0].job_id, s.ref]);
        return { state: 'job_opened', signal_id: row.signal_id, job_id: mineAlready.rows[0].job_id, reason: null };
      }
    }

    // The balance is read outside the lock: a slow answer must not hold every other signal.
    const c = await credit();
    const creditHold = !c.ok ? `the model credit could not be read, so nothing is opened: ${c.error}` : c.remaining_usd < RULE.credit_floor_usd ? `the model credit is $${c.remaining_usd.toFixed(2)}, under the $${RULE.credit_floor_usd} floor` : null;

    // Take a slot, or say why not, under one lock so two passes cannot both take the last one.
    const taken = await withTransaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
      // Render overlaps the old and the new instance on a deploy, so two passes can reach this
      // point for one signal. Whoever holds the lock second sees what the first did and stops.
      const cur = await db.query<{ signal_id: string; state: string; job_id: string | null; fresh: boolean }>(`SELECT signal_id, state, job_id, (opened_at > now() - interval '2 minutes') AS fresh FROM engine_research_signals WHERE signal_key = $1`, [s.key]);
      const c0 = cur.rows[0];
      if (c0 && c0.job_id && c0.job_id !== (row?.job_id ?? null)) return { id: '', signal_id: c0.signal_id, hold: null, first_hold: false, other: { job_id: c0.job_id as string | null, in_flight: false } };
      if (c0 && c0.state === 'opening' && c0.fresh) return { id: '', signal_id: c0.signal_id, hold: null, first_hold: false, other: { job_id: null as string | null, in_flight: true } };
      const today = await db.query<{ opened: number; backlog: number }>(
        `SELECT count(*)::int AS opened, count(*) FILTER (WHERE priority = 2)::int AS backlog
           FROM engine_research_signals WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND signal_key <> $1`,
        [s.key],
      );
      const { opened, backlog } = today.rows[0];
      const hold: { state: 'held_credit' | 'held_budget'; reason: string } | null = creditHold
        ? { state: 'held_credit', reason: creditHold }
        : opened >= RULE.daily_budget
          ? { state: 'held_budget', reason: `${opened} automatic jobs were already opened today (UTC); the budget is ${RULE.daily_budget} a day, so this waits for tomorrow` }
          : priority === 2 && backlog >= RULE.backlog_daily_cap
            ? { state: 'held_budget', reason: `${backlog} backlog jobs were already opened today (UTC); backlog takes at most ${RULE.backlog_daily_cap} of the ${RULE.daily_budget}, so this waits for tomorrow` }
            : null;
      const state = hold ? hold.state : 'opening';
      const up = await db.query<{ id: string; signal_id: string }>(
        `INSERT INTO engine_research_signals (signal_id, signal_key, trigger_code, source, priority, lane, card_id, question, context, refs, rearm_days, state, reason, fixture, detail, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::jsonb, CASE WHEN $12 = 'opening' THEN now() END)
         ON CONFLICT (signal_key) DO UPDATE SET
           state = EXCLUDED.state, reason = EXCLUDED.reason, last_seen_at = now(), question = EXCLUDED.question, context = EXCLUDED.context, detail = EXCLUDED.detail,
           refs = CASE WHEN engine_research_signals.refs ? $16 THEN engine_research_signals.refs ELSE engine_research_signals.refs || to_jsonb($16::text) END,
           previous_jobs = CASE WHEN $17::text IS NULL THEN engine_research_signals.previous_jobs ELSE engine_research_signals.previous_jobs || to_jsonb($17::text) END,
           job_id = CASE WHEN $17::text IS NULL THEN engine_research_signals.job_id ELSE NULL END,
           opened_at = CASE WHEN EXCLUDED.state = 'opening' THEN now() ELSE CASE WHEN $17::text IS NULL THEN engine_research_signals.opened_at ELSE NULL END END
         RETURNING id::text, signal_id`,
        [mint('RSG'), s.key, s.trigger, s.source, priority, s.lane ?? null, s.card_id ?? null, s.question, s.context, JSON.stringify([s.ref]), rearm, state, hold?.reason ?? null, s.fixture === true, JSON.stringify(s.detail ?? {}), s.ref, previous],
      );
      return { id: up.rows[0].id, signal_id: up.rows[0].signal_id, hold, first_hold: Boolean(hold) && row?.state !== hold?.state, other: null as { job_id: string | null; in_flight: boolean } | null };
    });

    if (taken.other) {
      if (taken.other.job_id) return { state: 'job_opened', signal_id: taken.signal_id, job_id: taken.other.job_id, reason: null };
      return { state: 'failed', signal_id: taken.signal_id, job_id: null, reason: 'another pass is opening this signal\'s job right now; it is read again on the next pass' };
    }

    if (taken.hold) {
      if (taken.first_hold) await note('research_signal_held', taken.signal_id, s, { state: taken.hold.state, reason: taken.hold.reason }, `research_signal_held:${taken.signal_id}:${taken.hold.state}:${new Date().toISOString().slice(0, 10)}`);
      return { state: taken.hold.state, signal_id: taken.signal_id, job_id: null, reason: taken.hold.reason };
    }

    // The slot is taken. Open the job; if it does not land, give the slot back and say why.
    try {
      const now = new Date().toISOString();
      const jobId = mint('JOB');
      const res = await engineWrite.postRecord(
        'rt-jobs',
        {
          created_time: now,
          fields: {
            'Job ID': jobId,
            Question: s.question,
            Context: s.context.slice(0, 6000),
            'Card ID': s.card_id ?? '',
            Lane: s.lane ?? '',
            Status: 'Pending',
            Attempts: 0,
            'Opened By': s.source,
            'Opened At': now,
            'Opened By Trigger': s.trigger,
            'Signal Key': s.key,
            ...(s.fixture ? { Fixture: true } : {}),
          },
        },
        { endpoint: 'research-signals:open', method: 'INTERNAL', key_label: 'server', t0: Date.now(), note: `${taken.signal_id}: ${s.trigger} ${s.key}` },
      );
      const job = res.natural_id ?? jobId;
      // The job exists from here on. If this write is lost the next pass finds the job by its Signal Key.
      try {
        await query(`UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, attempts = attempts + 1 WHERE id = $1`, [taken.id, job]);
      } catch (e) {
        console.error(`[research-signals] ${taken.signal_id}: job ${job} was opened but its signal row was not updated: ${e instanceof Error ? e.message : String(e)}`);
      }
      await note('research_signal_job_opened', taken.signal_id, s, { job_id: job, ref: s.ref, reopened_after: previous }, `research_signal_job_opened:${taken.signal_id}:${job}`);
      return { state: 'job_opened', signal_id: taken.signal_id, job_id: job, reason: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[research-signals] ${taken.signal_id} (${s.trigger} ${s.key}): the job was not opened: ${msg}`);
      await query(`UPDATE engine_research_signals SET state = 'failed', reason = $2, opened_at = NULL, attempts = attempts + 1 WHERE id = $1`, [taken.id, msg.slice(0, 500)]);
      return { state: 'failed', signal_id: taken.signal_id, job_id: null, reason: msg.slice(0, 500) };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[research-signals] ${s.trigger} ${s.key}: the guard failed: ${msg}`);
    return { state: 'failed', signal_id: '', job_id: null, reason: msg.slice(0, 500) };
  }
}

/** A signal seen again while its job is open: one dated line on the job's Context, so Research Twin reads it. */
async function addToJob(jobId: string, s: Signal): Promise<void> {
  try {
    const r = await query<{ id: string; context: string | null }>(`SELECT id::text, fields->>'Context' AS context FROM engine_rt_jobs WHERE natural_id = $1 ORDER BY id DESC LIMIT 1`, [jobId]);
    if (!r.rows[0]) return;
    const line = `[${new Date().toISOString().slice(0, 10)}] Seen again (${s.trigger}, ${s.ref}): ${clip(s.question, 300)}`;
    const context = `${r.rows[0].context ?? ''}\n${line}`.slice(0, 6000);
    await engineWrite.patchRecord('rt-jobs', r.rows[0].id, { Context: context }, { endpoint: 'research-signals:add', method: 'INTERNAL', key_label: 'server', t0: Date.now(), note: `${s.trigger} ${s.key} added to ${jobId}` });
  } catch (e) {
    console.error(`[research-signals] ${jobId}: the repeat was counted but not written onto the job: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------- triggers */

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * The line North Star ends its gaps with. Null when there is none, when it
 * says none, or when it is too short to be a question. Pure, so it is tested.
 */
export function researchQuestionOf(answer: string | null | undefined): string | null {
  const lines = String(answer ?? '').split(/\r?\n/);
  let found: string | null = null;
  for (const raw of lines) {
    const m = raw.match(/^[\s>*_\-•`]*Research Twin question[*_`]*\s*:\s*(.+?)\s*$/i);
    if (m) found = m[1];
  }
  if (found === null) return null;
  const q = found.replace(/^[*_`"'“”\s]+|[*_`"'“”\s]+$/g, '').trim();
  if (/^(none|no|n\/a|not applicable|nothing)\b/i.test(q)) return null;
  return q.length >= 15 ? q : null;
}

const BAD_HEALTH = ['needs intervention', 'critical'];
const truthy = (v: unknown): boolean => ['true', 'yes', '1'].includes(String(v ?? '').trim().toLowerCase());

/** A red flag name as a key: snake_case, and null where the log named none. */
export function redFlagKey(v: unknown): string | null {
  const k = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return !k || ['none', 'n_a', 'na', 'null', 'no'].includes(k) ? null : k;
}

async function detectIncidents(): Promise<Signal[]> {
  const out: Signal[] = [];
  const flagged = await query<{ incident_id: string; workflow: string | null; node: string | null; tags: string[] | null; error_class: string | null; summary: string | null }>(
    `SELECT natural_id AS incident_id, fields->'payload'->>'workflow_or_scenario' AS workflow, fields->'payload'->>'failed_node_or_component' AS node,
            CASE WHEN jsonb_typeof(fields->'payload'->'impact_tags') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(fields->'payload'->'impact_tags')) END AS tags,
            fields->'payload'->>'error_class' AS error_class, coalesce(fields->'payload'->>'error_summary', fields->>'summary') AS summary
       FROM engine_incidents
      WHERE natural_id IS NOT NULL AND lower(coalesce(fields->'payload'->>'research_needed', '')) IN ('true', 'yes', '1')
        AND ${logstream.INCIDENT_AT} > now() - interval '7 days'
      ORDER BY 1`,
  );
  for (const i of flagged.rows) {
    if (logstream.excludedReason(i)) continue;
    // A doctrine incident is operational and never research (SOP dc89a498, 27 Oct 2026): a resolver
    // outage, a refused or malformed read, a contradiction. Their incidents no longer ask for research,
    // and this holds for any written before that change. Doctrine research comes from detectDoctrineGaps.
    if (logstream.thresholdExcludedReason({ ...i, tags: i.tags }) === 'doctrine') continue;
    const sig = logstream.signatureOf(i.workflow, i.node);
    out.push({
      trigger: 'T4',
      key: `fault:${sig}`,
      source: 'Engine signal (incident)',
      ref: i.incident_id,
      rearm_days: RULE.rearm_fault_days,
      question: `The step "${i.node}" in "${i.workflow}" raised an incident its handler marked as needing research (${i.error_class ?? 'class not recorded'}). Is there a cause outside BHA's own code (an API change, a supplier, a price, a rule) that explains it, and what should change?`,
      context: [
        `Opened by the engine's incident trigger (T4, BP-CONTRACT-005): an incident with research_needed true opens one job for the fault, never one per incident. Incident ${i.incident_id}.`,
        i.summary ? `What the handler recorded: ${clip(i.summary, 600)}` : '',
        'The question is the outside cause. A code fix stays with Repair.',
        `Before writing the finding, read this fault's history: call read_logstream (BHA_Dashboard_read_logstream) with signature "${sig}". Cite it as a source by its tool name.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  const repairs = await query<{ workflow: string | null; node: string | null; n: number; ids: string[]; actions: (string | null)[] }>(
    `SELECT workflow_name AS workflow, failed_node AS node, count(*)::int AS n, array_agg(repair_id ORDER BY created_at) AS ids, array_agg(human_action ORDER BY created_at) AS actions
       FROM engine_repairs
      WHERE outcome = 'needs_human' AND created_at > now() - ($1 || ' days')::interval
      GROUP BY 1, 2 HAVING count(*) >= $2 ORDER BY 1, 2`,
    [String(RULE.needs_human_window_days), RULE.needs_human_at],
  );
  for (const r of repairs.rows) {
    if (logstream.excludedReason({ workflow: r.workflow, node: r.node })) continue;
    const sig = logstream.signatureOf(r.workflow, r.node);
    out.push({
      trigger: 'T4',
      key: `fault:${sig}`,
      source: 'Engine signal (repair)',
      ref: `repairs:${r.ids.join(',')}`,
      rearm_days: RULE.rearm_fault_days,
      question: `The repair bridge could not fix the step "${r.node}" in "${r.workflow}" ${r.n} times in ${RULE.needs_human_window_days} days and handed each to a person. Is there a cause outside BHA's own code (an API change, a supplier, a price, a rule) that explains why it keeps needing a person, and what should change?`,
      context: [
        `Opened by the engine's repair trigger (T4, BP-CONTRACT-005): the same workflow and failed step ending needs_human ${RULE.needs_human_at} or more times in ${RULE.needs_human_window_days} days opens one job. Repairs: ${r.ids.join(', ')}.`,
        `What the bridge asked a person to do: ${r.actions.filter(Boolean).map((a) => clip(a, 300)).join(' | ') || 'not recorded'}`,
        'The question is the outside cause. A code fix stays with Repair.',
        `Before writing the finding, read this fault's history: call read_logstream (BHA_Dashboard_read_logstream) with signature "${sig}". Cite it as a source by its tool name.`,
      ].join('\n'),
    });
  }
  return out;
}

async function detectLaneHealth(): Promise<Signal[]> {
  const out: Signal[] = [];
  const r = await query<{ ask_id: string; lane: string | null; health: string | null; attention: string | null; answer: string | null; linked: string | null; link: string | null; asked_at: string | null }>(
    `SELECT natural_id AS ask_id, fields->>'Lane' AS lane, fields->>'Claimed Lane Health' AS health, fields->>'Architect Attention' AS attention,
            fields->>'Answer' AS answer, fields->>'Linked Twin Ask' AS linked, fields->>'Slack Link' AS link, fields->>'Asked At' AS asked_at
       FROM engine_ns_asks
      WHERE natural_id IS NOT NULL AND fields->>'Outcome' = 'Answered'
        AND CASE WHEN fields->>'Asked At' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (fields->>'Asked At')::timestamptz END > now() - ($1 || ' days')::interval
      ORDER BY fields->>'Asked At'`,
    [String(RULE.lane_health_window_days)],
  );
  for (const a of r.rows) {
    const flagged = truthy(a.attention) || BAD_HEALTH.includes(String(a.health ?? '').trim().toLowerCase());
    if (!flagged) continue;
    // North Star already asked Research Twin in that run: the answer went to the thread, and a job would ask twice.
    if (String(a.linked ?? '').trim()) continue;
    const q = researchQuestionOf(a.answer);
    if (!q) continue;
    const lane = String(a.lane ?? '').trim();
    out.push({
      trigger: 'T5',
      key: `ns_gap:${lane || 'no-lane'}:${hash(norm(q))}`,
      source: 'Engine signal (North Star lane health)',
      ref: a.ask_id,
      lane: lane.startsWith('LANE-') ? lane : null,
      rearm_days: null,
      question: q,
      context: [
        `Opened by the engine's lane-health trigger (T5, BP-CONTRACT-005): North Star flagged ${truthy(a.attention) ? 'Architect Attention' : `lane health "${a.health}"`} and named this as the outside-world question still open. North Star ask ${a.ask_id}, ${a.asked_at ?? 'time not recorded'}.`,
        `Lane North Star named: ${lane || 'none'}.${a.link ? ` Thread: ${a.link}` : ''}`,
        'Research the outside-world fact only. North Star does the ranking; do not rank or judge the lane.',
      ].join('\n'),
      detail: { ask_id: a.ask_id, lane, health: a.health, attention: truthy(a.attention) },
    });
  }
  return out;
}

function cardQuestions(missing: string | null, questions: string | null): string[] {
  try {
    const arr = JSON.parse(missing ?? '') as unknown;
    if (Array.isArray(arr)) {
      const open = arr.filter((x): x is { type?: string; item?: string } => Boolean(x) && typeof x === 'object').filter((x) => !x.type || x.type === 'open_question').map((x) => String(x.item ?? '').trim()).filter(Boolean);
      if (open.length) return open;
    }
  } catch {
    /* not JSON: fall back to the pipe-separated field */
  }
  return String(questions ?? '').split(' | ').map((x) => x.trim()).filter(Boolean);
}

async function detectCards(): Promise<Signal[]> {
  const out: Signal[] = [];
  const r = await query<{ card_id: string; lane: string | null; lane_state: string | null; title: string | null; missing: string | null; questions: string | null; n: string | null; has_job: boolean; reason: string | null }>(
    `SELECT c.natural_id AS card_id, c.fields->>'lane_id' AS lane, c.fields->>'lane_state' AS lane_state, c.fields->>'opportunity_title' AS title,
            c.fields->>'missing_research' AS missing, c.fields->>'missing_research_questions' AS questions, c.fields->>'missing_research_count' AS n,
            EXISTS (SELECT 1 FROM engine_rt_jobs j WHERE j.fields->>'Card ID' = c.natural_id) AS has_job,
            c.fields->>'lane_state_blocked_reason' AS reason
       FROM engine_commercial_cards c
      WHERE c.natural_id IS NOT NULL
        AND (c.fields->>'lane_state' IN ('needs_revision', 'pilot_failed') OR c.fields->>'missing_research_count' ~ '^[1-9]')
      ORDER BY CASE WHEN c.fields->>'missing_research_count' ~ '^[0-9]+$' THEN (c.fields->>'missing_research_count')::int ELSE 999 END, c.fields->>'created_at', c.natural_id`,
  );
  for (const c of r.rows) {
    const title = c.title || c.card_id;
    if (c.lane_state === 'needs_revision' || c.lane_state === 'pilot_failed') {
      out.push({
        trigger: 'T6',
        key: `card:${c.card_id}:${c.lane_state}`,
        source: 'Engine signal (commercial card)',
        ref: `${c.card_id}:${c.lane_state}`,
        lane: c.lane,
        card_id: c.card_id,
        rearm_days: null,
        question: `The commercial card "${title}" moved to ${c.lane_state === 'pilot_failed' ? 'pilot failed' : 'needs revision'}. What changed in the outside world (the buyer, the market, a competitor, a price, a rule) that explains it, and what should the next version of the card test?`,
        context: [`Opened by the engine's commercial trigger (T6, BP-CONTRACT-005): a card whose lane state becomes needs_revision or pilot_failed opens one job on what changed. Card ${c.card_id}, lane ${c.lane ?? 'not recorded'}.`, c.reason ? `What the card says about it: ${clip(c.reason, 500)}` : ''].filter(Boolean).join('\n'),
      });
      continue;
    }
    if (c.has_job) continue;
    const qs = cardQuestions(c.missing, c.questions);
    if (!qs.length) continue;
    out.push({
      trigger: 'T6',
      key: `card:${c.card_id}:missing_research`,
      source: 'Engine signal (commercial card)',
      ref: `${c.card_id}:missing_research`,
      lane: c.lane,
      card_id: c.card_id,
      priority: 2,
      rearm_days: null,
      question: qs[0],
      context: [
        `Opened by the engine's commercial trigger (T6, BP-CONTRACT-005): a card with missing research and no research job is queued once. Card ${c.card_id}, "${title}", lane ${c.lane ?? 'not recorded'}, ${c.n ?? '?'} open question(s) on the card.`,
        qs.length > 1 ? `The card's other open questions, for context only: ${qs.slice(1).map((q) => clip(q, 300)).join(' | ')}` : '',
        'Answer the question above. Queue a follow-up only for a question that is still genuinely distinct after this one is answered.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return out;
}

async function detectRedFlags(): Promise<Signal[]> {
  const r = await query<{ submission_id: string; name: string | null; builder: string | null; flags: string | null; codex_id: string | null }>(
    `SELECT natural_id AS submission_id, fields->>'Red Flag Name' AS name, fields->>'Builder Name' AS builder,
            substring(fields->>'Layer1 Review ' from 'Red Flags\n(.*?)\n\nImprovement Prompt') AS flags, fields->>'Codex Entry ID' AS codex_id
       FROM engine_codex_submissions
      WHERE natural_id IS NOT NULL AND nullif(fields->>'Red Flag Name', '') IS NOT NULL
        AND CASE WHEN created_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN created_time::timestamptz END > now() - ($1 || ' days')::interval
      ORDER BY created_time`,
    [String(RULE.red_flag_window_days)],
  );
  const by = new Map<string, typeof r.rows>();
  for (const row of r.rows) {
    const k = redFlagKey(row.name);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), row]);
  }
  const out: Signal[] = [];
  for (const [name, logs] of by) {
    if (logs.length < RULE.red_flag_at) continue;
    const builders = [...new Set(logs.map((l) => l.builder).filter(Boolean))];
    out.push({
      trigger: 'T8',
      key: `red_flag:${name}`,
      source: 'Engine signal (log review)',
      ref: `logs:${hash(logs.map((l) => l.submission_id).join(','))}`,
      rearm_days: RULE.rearm_red_flag_days,
      question: `The log review named the same red flag, "${name}", on ${logs.length} session logs in ${RULE.red_flag_window_days} days (${builders.join(', ') || 'builder not recorded'}). What do these gaps have in common, and what written standard would prevent them?`,
      context: [
        `Opened by the engine's log-review trigger (T8, BP-CONTRACT-005): the same Red Flag Name on ${RULE.red_flag_at} or more logs in ${RULE.red_flag_window_days} days opens one job. The answer can only become a pattern candidate for a person to review. It is never a pay decision and changes no verdict.`,
        ...logs.slice(0, 8).map((l) => `- ${l.codex_id || l.submission_id} (${l.builder ?? 'builder not recorded'}): ${clip(l.flags, 400) || 'red flag text not recorded'}`),
        'Read the logs with find_records kind codex. Cite each log you rely on.',
      ].join('\n'),
      detail: { red_flag: name, logs: logs.map((l) => l.codex_id || l.submission_id), builders },
    });
  }
  return out;
}

/**
 * SE8L doctrine gaps (T4; SOP 192331ee, Jason, 27 Oct 2026). An open needs_evidence / stale_evidence
 * episode becomes one signal per research question (`research_key`, shared across surfaces only where
 * the gap is the claim's own) once doctrineGap.eligibleForResearch says yes: verified continuity for 7
 * days, a verified consumer and at least one real hit. With VERIFIED_CONSUMER_WRITERS empty nothing is
 * eligible, so in production this returns no signals and every refusal is listed for the read.
 *
 * The ref is the episode: a repeat pass for the same episode changes nothing, a second surface's
 * episode while the job is open is added to it, and once the job is resolved only a NEW episode (the
 * gap recovered and came back) may open another (rearm_days 0). An episode a finished job already
 * covers (opened at or after the episode began, unreadable dates counted as covering) is skipped here,
 * because rearm_days 0 would otherwise reopen for the same episode.
 * Capped, removed and unknown-status jobs are never reopened (open()). This opens nothing itself.
 */
export async function detectDoctrineGaps(opts: { writers?: readonly string[]; now?: number } = {}): Promise<Signal[]> {
  const out: Signal[] = [];
  const now = opts.now ?? Date.now();
  lastDoctrineRefusals.clear();
  const byKey = new Map<string, Array<Awaited<ReturnType<typeof doctrineEpisodes.openResearchEpisodes>>[number] & { gap_age_days: number | null }>>();
  for (const ep of await doctrineEpisodes.openResearchEpisodes()) {
    const ev = await doctrineConsumer.consumerEvidence(ep.doctrine_id, ep.claim_id, ep.started_at, opts.writers);
    const verdict = doctrineGap.eligibleForResearch(ep, ev, now);
    lastDoctrineRefusals.set(ep.episode_id, { research_key: ep.research_key, refusals: verdict.refusals, gap_age_days: verdict.gap_age_days });
    if (!verdict.eligible) continue;
    byKey.set(ep.research_key, [...(byKey.get(ep.research_key) ?? []), { ...ep, gap_age_days: verdict.gap_age_days }]);
  }
  for (const [key, eps] of byKey) {
    // An episode already has its job when a job carrying this key was opened at or after the episode
    // began: only this detector writes doctrine-gap keys. Read from the jobs, not the signal row, so a
    // job whose bookkeeping write was lost still counts. While that job is open the episode goes on to
    // open() (a no-op, or added to the job); once it is finished the episode is skipped, because with
    // rearm_days 0 open() would otherwise give the same episode a second job.
    const jobs = await query<{ opened_at: string | null; status: string | null }>(`SELECT fields->>'Opened At' AS opened_at, fields->>'Status' AS status FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1 AND natural_id IS NOT NULL`, [key]);
    const covered = (e: { started_at: string }) => jobs.rows.some((j) => !OPEN_STATUSES.includes(j.status ?? '') && !(Date.parse(j.opened_at ?? '') < Date.parse(e.started_at)));
    const ep = eps.find((e) => !covered(e));
    if (!ep) continue;
    const surfaces = [...new Set(eps.map((e) => e.surface))].join(', ');
    out.push({
      trigger: 'T4',
      key,
      source: 'Engine signal (doctrine gap)',
      ref: ep.episode_id,
      rearm_days: 0,
      question: `Claim ${ep.claim_id} of doctrine ${ep.doctrine_id} has been ${ep.condition.replace('_', ' ')} for ${Math.floor(ep.gap_age_days ?? 0)} days while a verified consumer used it. What evidence would close this gap, where does it exist, and who holds it?`,
      context: [
        `Opened by SE8L (T4, SOP 192331ee): a needs_evidence / stale_evidence gap present for at least ${doctrineGap.RESEARCH_RULE.min_gap_days} consecutive days with a verified consumer and at least ${doctrineGap.RESEARCH_RULE.min_real_hits} real hit. One job per doctrine key; further gaps on it are added here, never a new job, until this job is resolved.`,
        `Episode ${ep.episode_id} on ${surfaces} (key ${ep.recovery_key}), since ${ep.started_at}, last confirmed ${ep.last_confirmed_at}.`,
        'The question is the missing evidence. It changes no doctrine, publication decision, card or loop.',
      ].join('\n'),
      detail: { research_key: key, episodes: eps.map((e) => e.episode_id), surfaces: eps.map((e) => e.surface) },
    });
  }
  return out;
}

/** The last refusal per episode, for the read: why each open gap has not reached Research Twin. */
const lastDoctrineRefusals = new Map<string, { research_key: string; refusals: string[]; gap_age_days: number | null }>();
export function doctrineRefusals(): Array<{ episode_id: string; research_key: string; refusals: string[]; gap_age_days: number | null }> {
  return [...lastDoctrineRefusals].map(([episode_id, v]) => ({ episode_id, ...v }));
}

/** Every signal the engine's own records hold right now. A read: it opens nothing. */
export async function detect(): Promise<{ signals: Signal[]; errors: string[] }> {
  const signals: Signal[] = [];
  const errors: string[] = [];
  for (const [name, fn] of [['incidents (T4)', detectIncidents], ['lane health (T5)', detectLaneHealth], ['commercial cards (T6)', detectCards], ['red flags (T8)', detectRedFlags], ['doctrine gaps (T4, SE8L)', () => detectDoctrineGaps()]] as const) {
    try {
      signals.push(...(await fn()));
    } catch (e) {
      const msg = `${name} could not be read: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[research-signals] ${msg}`);
      errors.push(msg);
    }
  }
  // One signal per key per pass: two sources naming the same fault are one signal.
  const seen = new Set<string>();
  return { signals: signals.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true))), errors };
}

let sweeping = false;
let lastPass: { at: string; detected: number; jobs_opened: number; added: number; held: number; not_reopened: number; failed: number; errors: string[] } | null = null;

/** What the last pass did, kept for the read; a source that could not be read is one event a day, never silence. */
async function remember(r: { detected: number; jobs_opened: number; added: number; held: number; not_reopened: number; failed: number; errors: string[] }): Promise<void> {
  lastPass = { at: new Date().toISOString(), ...r };
  for (const e of r.errors) {
    try {
      await engineEvents.record({ event_type: 'research_signals_source_unread', subject_id: e.split(' could not be read')[0].slice(0, 80), lane: null, actor: 'Research signals', detail: { error: e.slice(0, 600) }, dedupe_key: `research_signals_source_unread:${e.split(' could not be read')[0]}:${new Date().toISOString().slice(0, 10)}` });
    } catch (err) {
      console.error(`[research-signals] the failed read was not recorded as an event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** One pass: find the signals, then put each through the guard, live ones before backlog. Never throws. */
export async function sweep(): Promise<{ detected: number; jobs_opened: number; added: number; held: number; not_reopened: number; failed: number; errors: string[] }> {
  const out = { detected: 0, jobs_opened: 0, added: 0, held: 0, not_reopened: 0, failed: 0, errors: [] as string[] };
  if (sweeping) return out;
  sweeping = true;
  try {
    const found = await detect();
    out.errors = found.errors;
    out.detected = found.signals.length;
    const tally = (state: SignalState, wasOpen: boolean) => {
      if (state === 'job_opened') out.jobs_opened += wasOpen ? 0 : 1;
      else if (state === 'added_to_job') out.added++;
      else if (state === 'held_budget' || state === 'held_credit') out.held++;
      else if (state === 'not_reopened') out.not_reopened++;
      else out.failed++;
    };
    const seen = new Set<string>();
    // Live signals before backlog, so a fault is never queued behind a card that has waited for weeks.
    for (const s of [...found.signals].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))) {
      seen.add(s.key);
      const before = await query<{ state: string }>(`SELECT state FROM engine_research_signals WHERE signal_key = $1`, [s.key]);
      const was = before.rows[0];
      tally((await open(s)).state, was?.state === 'job_opened');
    }
    // A signal this module raised that is still waiting, and that this pass did not see again.
    // A question North Star asked, or an incident, does not stop being a question because a week
    // went by while the budget or the credit held it: it is tried again from what was stored.
    // A card or a red flag that no longer holds is let go, and says so.
    {
      const waiting = await query<{ id: string; signal_key: string; trigger_code: TriggerCode; source: string; priority: number; lane: string | null; card_id: string | null; question: string; context: string; refs: string[]; rearm_days: number | null; fixture: boolean; detail: Record<string, unknown> }>(
        `SELECT id::text, signal_key, trigger_code, source, priority, lane, card_id, question, context, refs, rearm_days, fixture, detail
           FROM engine_research_signals WHERE state IN ('held_budget', 'held_credit', 'failed') AND source LIKE 'Engine signal%' AND fixture = false ORDER BY priority, detected_at`,
      );
      for (const w of waiting.rows) {
        if (seen.has(w.signal_key)) continue;
        if (w.trigger_code === 'T6' || w.trigger_code === 'T8') {
          // Only when every source was read: a table that could not be read is not a signal that stopped holding.
          if (found.errors.length) continue;
          await query(`UPDATE engine_research_signals SET state = 'not_reopened', reason = 'it stopped holding before a job could be opened, so none was', last_seen_at = now() WHERE id = $1`, [w.id]);
          out.not_reopened++;
          continue;
        }
        const r = await open({ trigger: w.trigger_code, key: w.signal_key, source: w.source, ref: (w.refs ?? [])[0] ?? w.signal_key, lane: w.lane, card_id: w.card_id, question: w.question, context: w.context, priority: w.priority === 2 ? 2 : 1, rearm_days: w.rearm_days, fixture: w.fixture, detail: w.detail });
        tally(r.state, false);
      }
    }
    // A crossing Logstream or the Monitoring Twin stopped asking about (its own row aged out) is let go here.
    const aged = await query(
      `UPDATE engine_research_signals SET state = 'not_reopened', reason = 'what raised it aged out before a job could be opened, so none was'
        WHERE state IN ('held_budget', 'held_credit', 'failed') AND source IN ('Logstream', 'Monitoring Twin') AND last_seen_at < now() - interval '1 day'`,
    );
    out.not_reopened += aged.rowCount ?? 0;
    await remember(out);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[research-signals] sweep failed: ${msg}`);
    const failed = { ...out, failed: out.failed + 1, errors: [...out.errors, msg] };
    await remember(failed);
    return failed;
  } finally {
    sweeping = false;
  }
}

/**
 * What a pass would do, calling the guard for nothing: every signal held by the
 * records now, with what the guard would answer. The balance is the one thing
 * it reads from outside. A read.
 */
export async function plan(): Promise<{ signals: Array<Record<string, unknown>>; errors: string[]; today: { opened: number; backlog_opened: number; budget: number }; credit: Credit }> {
  const found = await detect();
  const c = await credit();
  const t = await query<{ opened: number; backlog: number }>(
    `SELECT count(*)::int AS opened, count(*) FILTER (WHERE priority = 2)::int AS backlog FROM engine_research_signals WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  );
  let { opened, backlog } = t.rows[0];
  const start = { opened, backlog_opened: backlog, budget: RULE.daily_budget };
  const out: Array<Record<string, unknown>> = [];
  for (const s of [...found.signals].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))) {
    const held = await query<Row>(`SELECT id::text, signal_id, state, job_id, refs, rearm_days, opened_at::text, attempts FROM engine_research_signals WHERE signal_key = $1`, [s.key]);
    const row = held.rows[0];
    let would: string;
    let why: string | null = null;
    const status = row?.job_id ? await jobStatus(row.job_id) : undefined;
    if (row?.job_id && status !== null && status !== undefined && OPEN_STATUSES.includes(status)) {
      would = (row.refs ?? []).includes(s.ref) ? 'nothing: its job is already open' : 'add to its open job';
      why = row.job_id;
    } else if (row?.job_id && (status === null || status === 'Capped (needs human)' || (s.rearm_days ?? null) === null || (row.opened_at ? (Date.now() - new Date(row.opened_at).getTime()) / 86_400_000 : Infinity) < (s.rearm_days ?? 0))) {
      would = 'not reopen';
      why = status === null ? `job ${row.job_id} was removed` : `job ${row.job_id} is ${status}`;
    } else if (!c.ok || c.remaining_usd < RULE.credit_floor_usd) {
      would = 'hold: credit';
      why = c.ok ? `$${c.remaining_usd.toFixed(2)} is under the $${RULE.credit_floor_usd} floor` : c.error;
    } else if (opened >= RULE.daily_budget) {
      would = 'hold: daily budget';
      why = `${opened} of ${RULE.daily_budget} opened today`;
    } else if ((s.priority ?? 1) === 2 && backlog >= RULE.backlog_daily_cap) {
      would = 'hold: backlog cap';
      why = `${backlog} of ${RULE.backlog_daily_cap} backlog jobs opened today`;
    } else {
      would = 'open a job';
      opened++;
      if ((s.priority ?? 1) === 2) backlog++;
    }
    out.push({ trigger: s.trigger, key: s.key, source: s.source, priority: s.priority ?? 1, lane: s.lane ?? null, card_id: s.card_id ?? null, question: clip(s.question, 240), would, why, held_now: row ? row.state : null });
  }
  return { signals: out, errors: found.errors, today: start, credit: c };
}

/* ------------------------------------------------------------------ read */

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export const WORDS = [
  `One research job per signal. A signal whose job is still open adds to that job; a capped job is never reopened automatically.`,
  `${RULE.daily_budget} new automatic jobs a day (UTC) across the engine. Anything over waits for the next day and is listed in Monday's research digest.`,
  `Backlog (a card with missing research and no job) takes at most ${RULE.backlog_daily_cap} of the ${RULE.daily_budget}, so a new fault always has room.`,
  `Nothing is opened while the model credit is under $${RULE.credit_floor_usd} or cannot be read.`,
  `T4 incidents: an incident marked research_needed, the same step needing a person at the repair bridge ${RULE.needs_human_at} times in ${RULE.needs_human_window_days} days, or Logstream's own thresholds.`,
  `T5 lane health: a North Star answer that flags Architect Attention or a lane needing intervention and ends its gaps with "Research Twin question: <question>".`,
  `T6 commercial: a card moving to needs_revision or pilot_failed, and, once each, a card with missing research and no job.`,
  `T8 red flags: the same Red Flag Name on ${RULE.red_flag_at} or more logs in ${RULE.red_flag_window_days} days.`,
];
export const NOT_BUILT = ['T7 (vFarm anomalies) waits on the vFarm Twin contract, which is Jegan\'s.', 'T6 does not fire on a "high-intent front-door lead": nobody has defined one.'];

/** What the page, the agents and Monday's digest read. `held_only` is the digest's view. */
export async function read(opts: { held_only?: boolean; limit?: number } = {}): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  const [today, counts, rows] = await Promise.all([
    query<{ opened: number; backlog: number }>(
      `SELECT count(*)::int AS opened, count(*) FILTER (WHERE priority = 2)::int AS backlog FROM engine_research_signals WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    ),
    query<{ state: string; n: number }>(`SELECT state, count(*)::int AS n FROM engine_research_signals GROUP BY 1 ORDER BY 1`),
    query(
      `SELECT s.signal_id, s.signal_key, s.trigger_code, s.source, s.priority, s.lane, s.card_id, s.question, s.state, s.reason, s.job_id, s.previous_jobs, s.occurrences, s.fixture,
              ${TS('s.detected_at')} AS detected_at, ${TS('s.last_seen_at')} AS last_seen_at, ${TS('s.opened_at')} AS opened_at,
              (SELECT r.fields->>'Status' FROM engine_rt_jobs r WHERE r.natural_id = s.job_id ORDER BY r.id DESC LIMIT 1) AS job_status
         FROM engine_research_signals s
        WHERE ($1::boolean IS NOT TRUE OR s.state IN ('held_budget', 'held_credit', 'failed'))
        ORDER BY CASE WHEN s.state IN ('held_budget', 'held_credit', 'failed') THEN 0 ELSE 1 END, s.priority, s.detected_at DESC LIMIT $2`,
      [opts.held_only === true, limit],
    ),
  ]);
  const c = creditCache?.value ?? null;
  return {
    rule: { ...RULE, words: WORDS, not_built: NOT_BUILT, contract: 'BP-CONTRACT-005-CLOSED_LOOP_V1' },
    today: { utc_day: new Date().toISOString().slice(0, 10), opened: today.rows[0].opened, backlog_opened: today.rows[0].backlog, budget: RULE.daily_budget, left: Math.max(0, RULE.daily_budget - today.rows[0].opened) },
    credit: c ? (c.ok ? { read: true, remaining_usd: c.remaining_usd, floor_usd: RULE.credit_floor_usd, read_at: c.read_at } : { read: false, error: c.error, floor_usd: RULE.credit_floor_usd, read_at: c.read_at }) : { read: false, error: 'not read since this process started; it is read when a signal next needs a job', floor_usd: RULE.credit_floor_usd, read_at: null },
    by_state: Object.fromEntries(counts.rows.map((x) => [x.state, x.n])),
    last_pass: lastPass ?? { at: null, note: 'no pass has run since this process started; the first runs three minutes after boot' },
    signals: rows.rows,
    signals_cap: limit,
  };
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => void sweep();
  timer = setInterval(() => (timers.beat('research signals'), tick()), SWEEP_MS);
  timer.unref();
  setTimeout(tick, 180_000).unref();
}
