/**
 * Genie's direct tools wait on a person (17 Nov 2026, Destiny — Genie rebuild step 6.1). Genie reaches GitHub,
 * Render, n8n, Supabase, Twilio and ElevenLabs through their own MCP servers. Reading runs freely; a call that
 * changes something (a deploy, a published workflow, a merged change, a sent message) is not made. Genie stores
 * it here, posts an Approve / Deny card in the thread it was asked in, and makes the call only once Destiny or
 * Jason approves. Stripe is read only and never reaches this table.
 *
 * Held here, not in Genie, so a request outlives a Genie deploy and every outcome is on the dashboard:
 * - one row per request; the same call still pending is the same request (a unique index on its digest);
 * - only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) decide, checked here and by the table's CHECK;
 * - the claim is one UPDATE … WHERE status = 'pending', so two clicks, or two Genie instances, cannot both win;
 * - a click by anyone else changes nothing and is kept in attempts;
 * - 24 hours with no answer is expired, and an expired request is never run;
 * - every step is one engine event (lane GENIE).
 *
 * The chat app approves in the chat (21 Nov 2026, Destiny: a builder working in the app should not wait on
 * Destiny or Jason in Slack, any more than Destiny waits on someone at Anthropic to approve his own change).
 * A request held from the app carries `surface: 'chat'`: no card is posted, and the person who asked decides
 * it themself, in the app. That holds only for a person with an active Builder Profile (or Destiny or Jason),
 * checked here when the request is stored and again when it is decided; Destiny and Jason can still decide
 * any request. A request from Slack is unchanged: only Destiny or Jason decide it. Who decided is on the row.
 */
import { createHash } from 'node:crypto';
import { query } from './pg';
import * as engineEvents from './engineEvents';
import * as reuse from './reuseCheck';
import * as trust from './patternTrust';
import * as timers from './timers';
import { isFormerBuilder } from './sources';
import * as builder from './genieBuilder';

export const APPROVERS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
export const APPROVAL_EVENTS = ['genie_approval_requested', 'genie_approval_decided', 'genie_approval_finished', 'genie_approval_expired', 'genie_build_planned', 'genie_build_built', 'genie_build_rated'];

/**
 * The build trail (19 Nov 2026, Genie rebuild 10.9): every Genie build is plan, decision, built, rating.
 * The plan is written when the call is held: the goal (the ask), the change (the call in words) and the reuse
 * check (10.10) on both. The decision is the click, with its choice: go ahead, extend a match, or use what
 * exists (which runs nothing). Built is what the call did. The rating is the asker's: useful, partly, or not
 * useful with a reason (wrong, outdated, misrouted); 48 hours with none is not_rated, never assumed useful.
 * The choices and ratings are the votes the pattern trust record keeps (10.11).
 */
export const RATINGS = ['useful', 'partly', 'not_useful'] as const;
export const CHOICES = ['go_ahead', 'extend', 'reuse'] as const;
export const RATE_WITHIN_HOURS = 48;

type Row = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const CHANNEL = /^[CGD][A-Z0-9]{6,}$/;
const SLACK_USER = /^[UW][A-Z0-9]{6,}$/;

/**
 * Who may decide a request. Pure. Destiny or Jason, always. For a request held from the chat app, also the
 * person who asked, while they are an active builder. Nobody decides another person's request.
 */
export function mayDecide(row: { surface?: unknown; requester?: unknown }, who: string, activeBuilder: boolean): boolean {
  if (APPROVERS.has(who)) return true;
  return row.surface === 'chat' && !!who && who === row.requester && activeBuilder;
}

/** An active builder has a Builder Profile and has not left BHA. Destiny and Jason always count. */
export async function isActiveBuilder(id: string): Promise<boolean> {
  if (APPROVERS.has(id)) return true;
  if (!SLACK_USER.test(id) || isFormerBuilder(id)) return false;
  const r = await query<Row>(`SELECT 1 FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]);
  return r.rows.length > 0;
}
const NAME = /^[a-z0-9_-]{1,40}$/;

export class ApprovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function log(type: string, id: string, actor: string, detail: Row): Promise<void> {
  await engineEvents.record({ event_type: type, subject_id: id, lane: 'GENIE', actor, source_ref: 'genie-approvals', detail });
}

/** The same server, tool and arguments are the same request. Pure. */
export function digestOf(server: string, tool: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([server, tool, args ?? {}])).digest('hex');
}

/** Stores a held call. A repeat of one still pending answers that request, so no second card is posted. */
export async function request(b: Row): Promise<Row> {
  const server = str(b.server, 40);
  const tool = str(b.tool, 120);
  const surface = str(b.surface, 10) === 'chat' ? 'chat' : 'slack';
  const requester = str(b.requester, 40);
  if (!NAME.test(server)) throw new ApprovalError(422, 'server is required: the MCP server id.');
  if (!tool) throw new ApprovalError(422, 'tool is required.');
  let channel = str(b.channel_id, 40);
  if (surface === 'chat') {
    // No card and no channel: the request waits in the app, on the person who asked.
    if (!SLACK_USER.test(requester)) throw new ApprovalError(422, 'requester is required for a request from the chat app: the Slack id of the person who asked.');
    if (!(await isActiveBuilder(requester))) {
      return { ok: false, reason: 'not_permitted', message: 'Only a person with an active Builder Profile can ask Genie for a change from the chat app. Nothing was held.' };
    }
    channel = 'chat';
  } else if (!CHANNEL.test(channel)) throw new ApprovalError(422, 'channel_id is required: where the approval card is posted.');
  const summary = str(b.summary, 1500) || `${server}: ${tool}`;
  const args = b.args && typeof b.args === 'object' ? b.args : {};
  // In the app the same call asked by two people is two requests: each decides their own.
  const digest = surface === 'chat' ? createHash('sha256').update(JSON.stringify([server, tool, args ?? {}, 'chat', requester])).digest('hex') : digestOf(server, tool, args);
  const held = await query<Row>(`SELECT id, card_ts FROM engine_genie_approvals WHERE digest = $1 AND status = 'pending' AND expires_at > now()`, [digest]);
  if (held.rows[0]) return { ok: true, id: held.rows[0].id, repeat: true, card_ts: held.rows[0].card_ts };
  const id = `GAP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const goal = str(b.goal, 3000);
  const thread = surface === 'chat' ? str(b.conversation_id, 80) || null : str(b.thread_ts, 40) || null;
  const check = await reuse.check({ text: `${goal}\n${summary}`, source_ref: id, thread: thread ? `${channel}:${thread}` : null });
  const plan = { goal: goal || null, change: summary, reuse: { ran: check.ran, reason: check.reason ?? null, summary: check.summary, matches: check.matches }, patterns_used: [] as string[] };
  await query(
    `INSERT INTO engine_genie_approvals (id, server, tool, args, summary, channel_id, thread_ts, requester, request_id, digest, plan, surface)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [id, server, tool, JSON.stringify(args), summary, channel, thread, requester || null, str(b.request_id, 80) || null, digest, JSON.stringify(plan), surface],
  );
  await log('genie_approval_requested', id, requester || 'genie', { server, tool, summary, channel_id: channel, thread_ts: thread, surface });
  await log('genie_build_planned', id, str(b.requester, 40) || 'genie', { goal: goal || null, change: summary, reuse_ran: check.ran, matches: check.matches.map((m) => m.id) });
  return { ok: true, id, repeat: false, plan, surface };
}

export async function setCard(b: Row): Promise<Row> {
  await query(`UPDATE engine_genie_approvals SET card_ts = $2 WHERE id = $1`, [str(b.id, 60), str(b.card_ts, 40) || null]);
  return { ok: true };
}

/**
 * Approve or deny. Only an approver changes anything; the claim is one statement. Approved hands back the stored
 * call (server, tool, args) for Genie to make; Genie reports the result with finish().
 */
export async function decide(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const who = str(b.decider, 40);
  const decision = str(b.decision, 10);
  if (decision !== 'approve' && decision !== 'deny') throw new ApprovalError(422, 'decision is approve or deny.');
  const askedChoice = str(b.choice, 10);
  if (askedChoice && !(CHOICES as readonly string[]).includes(askedChoice)) throw new ApprovalError(422, 'choice is go_ahead, extend or reuse.');
  const r = await query<Row>(`SELECT * FROM engine_genie_approvals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found', message: `No approval ${id}.` };
  if (!mayDecide(row, who, row.surface === 'chat' && who === row.requester ? await isActiveBuilder(who) : false)) {
    await query(`UPDATE engine_genie_approvals SET attempts = attempts || $2::jsonb WHERE id = $1`, [id, JSON.stringify([{ by: who, at: new Date().toISOString(), decision }])]);
    const message = row.surface === 'chat'
      ? 'Only the person who asked for this (while they are an active builder), Destiny or Jason can approve or deny it.'
      : 'Only Destiny or Jason can approve or deny this.';
    return { ok: false, reason: 'not_permitted', message, row };
  }
  if (row.status !== 'pending') return { ok: false, reason: 'already_decided', message: `This was already ${String(row.status)}.`, row };
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    await query(`UPDATE engine_genie_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [id]);
    await log('genie_approval_expired', id, 'genie', { server: row.server, tool: row.tool });
    return { ok: false, reason: 'expired', message: 'This request is over 24 hours old and has expired. Ask Genie again.', row };
  }
  // Use what exists is a deny with its own choice: nothing runs, and the match it points at gets the credit.
  const status = decision === 'approve' && askedChoice !== 'reuse' ? 'approved' : 'denied';
  const plan = (row.plan as Row | null) ?? {};
  const matched = (((plan.reuse as Row | undefined)?.matches as reuse.Match[] | undefined) ?? []).filter((m) => m.kind === 'pattern').map((m) => m.id);
  const choice = askedChoice || (status === 'approved' && matched.length ? 'go_ahead' : null);
  const patternsUsed = choice === 'extend' ? matched : [];
  const claimed = await query<Row>(
    `UPDATE engine_genie_approvals SET status = $2, decided_by = $3, decided_at = now(), choice = $4,
            plan = jsonb_set(COALESCE(plan, '{}'::jsonb), '{patterns_used}', $5::jsonb)
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, who, choice, JSON.stringify(patternsUsed)],
  );
  if (!claimed.rows[0]) return { ok: false, reason: 'already_decided', message: 'Someone decided this a moment ago.' };
  await log('genie_approval_decided', id, who, { decision: status, choice, server: row.server, tool: row.tool, summary: row.summary, surface: row.surface ?? 'slack', self_approved: row.surface === 'chat' && who === row.requester });
  const thread = row.thread_ts ? `${String(row.channel_id)}:${String(row.thread_ts)}` : null;
  for (const p of matched) {
    if (choice === 'reuse' || choice === 'extend') await trust.vote({ pattern_id: p, kind: 'up', reason: choice, voter: who, thread, source_ref: id });
    else if (choice === 'go_ahead') await trust.vote({ pattern_id: p, kind: 'down', reason: 'overridden', voter: who, thread, source_ref: id });
  }
  return { ok: true, decision: status, choice, row: claimed.rows[0] };
}

/** What happened once an approved call was made. A call never claimed approved is refused. */
export async function finish(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const ok = b.ok === true;
  const built = { ok, what: ok ? str(b.result, 600) || 'done, with no output' : null, error: ok ? null : str(b.error, 600) || 'no reason given', at: new Date().toISOString() };
  const r = await query<Row>(
    `UPDATE engine_genie_approvals SET status = $2, result = $3, error = $4, finished_at = now(), built = $5::jsonb WHERE id = $1 AND status = 'approved' RETURNING *`,
    [id, ok ? 'done' : 'failed', str(b.result, 4000) || null, ok ? null : str(b.error, 2000) || 'no reason given', JSON.stringify(built)],
  );
  if (!r.rows[0]) return { ok: false, reason: 'not_approved', message: `${id} is not waiting on a result.` };
  await log('genie_approval_finished', id, 'genie', { ok, server: r.rows[0].server, tool: r.rows[0].tool, error: ok ? null : str(b.error, 500) });
  await log('genie_build_built', id, 'genie', { ok, server: r.rows[0].server, tool: r.rows[0].tool });
  // The Genie Builder record keeps itself current (22 Nov 2026): the change goes onto its build now. Never able to
  // fail the finish: the change has already happened, and the boot backfill picks up anything missed.
  let build_id: string | null = null;
  try {
    build_id = await builder.linkAction(r.rows[0] as unknown as builder.ApprovalAction);
  } catch (e) {
    console.error(`[genie-approvals] ${id} could not be added to its build record: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true, rate_by: r.rows[0].requester ?? null, build_id };
}

/** Where the rating message sits, so Genie can rewrite it once rated. */
export async function setRateCard(b: Row): Promise<Row> {
  await query(`UPDATE engine_genie_approvals SET rate_ts = $2 WHERE id = $1`, [str(b.id, 60), str(b.rate_ts, 40) || null]);
  return { ok: true };
}

/**
 * The asker's rating (10.9). Only the asker, Destiny or Jason; once; only on a build that ran. A rating is the
 * vote on every pattern the build used (an extend): useful is an up, not useful is a down with its reason.
 */
export async function rate(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const who = str(b.rater, 40);
  const rating = str(b.rating, 12);
  if (!(RATINGS as readonly string[]).includes(rating)) throw new ApprovalError(422, 'rating is useful, partly or not_useful.');
  const reason = rating === 'not_useful' ? (['wrong', 'outdated', 'misrouted'].includes(str(b.reason, 12)) ? str(b.reason, 12) : 'not_useful') : null;
  const r = await query<Row>(`SELECT * FROM engine_genie_approvals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found', message: `No build ${id}.` };
  if (who !== row.requester && !APPROVERS.has(who)) return { ok: false, reason: 'not_permitted', message: 'Only the person who asked, Destiny or Jason can rate this build.' };
  if (row.status !== 'done' && row.status !== 'failed') return { ok: false, reason: 'not_built', message: 'Only a build that ran can be rated.' };
  const claimed = await query<Row>(
    `UPDATE engine_genie_approvals SET rating = $2, rating_reason = $3, rated_by = $4, rated_at = now() WHERE id = $1 AND rating IS NULL RETURNING id`,
    [id, rating, reason, who],
  );
  if (!claimed.rows[0]) return { ok: false, reason: 'already_rated', message: `Already rated ${String(row.rating)}.` };
  await log('genie_build_rated', id, who, { rating, reason });
  const used = (((row.plan as Row | null)?.patterns_used as string[] | undefined) ?? []);
  const thread = row.thread_ts ? `${String(row.channel_id)}:${String(row.thread_ts)}` : null;
  for (const p of used) {
    if (rating === 'useful') await trust.vote({ pattern_id: p, kind: 'up', reason: 'rated_useful', voter: who, thread, source_ref: `${id}:rating` });
    if (rating === 'not_useful') await trust.vote({ pattern_id: p, kind: 'down', reason: reason ?? 'not_useful', voter: who, thread, source_ref: `${id}:rating` });
  }
  return { ok: true, id, rating, reason, channel_id: row.channel_id, rate_ts: row.rate_ts };
}

/** Requests past 24 hours with no answer. Genie rewrites their cards. */
export async function expire(): Promise<Row> {
  const r = await query<Row>(`UPDATE engine_genie_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING id, server, tool, channel_id, card_ts, summary`);
  for (const row of r.rows) await log('genie_approval_expired', String(row.id), 'genie', { server: row.server, tool: row.tool });
  const unrated = await query<Row>(
    `UPDATE engine_genie_approvals SET rating = 'not_rated', rated_at = now()
      WHERE status IN ('done','failed') AND rating IS NULL AND finished_at <= now() - ($1 || ' hours')::interval
      RETURNING id, channel_id, rate_ts`,
    [String(RATE_WITHIN_HOURS)],
  );
  for (const row of unrated.rows) await log('genie_build_rated', String(row.id), 'genie', { rating: 'not_rated' });
  return { ok: true, expired: r.rows, not_rated: unrated.rows };
}

export async function list(): Promise<Row[]> {
  const r = await query<Row>(`SELECT id, server, tool, summary, channel_id, thread_ts, requester, status, decided_by, decided_at, result, error, created_at, finished_at,
            plan, choice, built, rating, rating_reason, rated_by, rated_at, surface
      FROM engine_genie_approvals ORDER BY created_at DESC LIMIT 100`);
  return r.rows;
}

/** Expiry and the 48-hour not_rated mark, every 15 minutes (19 Nov 2026: nothing called expire() on a timer before). */
let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('genie approvals sweep');
    expire()
      .then((r) => {
        const e = (r.expired as unknown[]).length, n = (r.not_rated as unknown[]).length;
        if (e || n) console.log(`[genie-approvals] ${e} request(s) expired, ${n} build(s) marked not rated`);
      })
      .catch((err) => console.error(`[genie-approvals] sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
}

/* -------------------------------------------- reviewing a build from the chat app (22 Nov 2026) */

export const BUILD_DECISIONS = ['accepted', 'modified', 'rejected'] as const;

/** How a build review reads as the per-change rating. Pure: exported for the test. */
export function ratingFromReview(decision: string, stars: number): { rating: (typeof RATINGS)[number]; reason: string | null } {
  if (decision === 'rejected' || stars <= 1) return { rating: 'not_useful', reason: 'wrong' };
  if (decision === 'accepted' && stars >= 4) return { rating: 'useful', reason: null };
  return { rating: 'partly', reason: null };
}

/**
 * The builds asked for in one conversation, for the chat app's Rate this build card: each with what it did and whether
 * it is reviewed. Only the person who asked, Destiny or Jason see a build's details.
 */
export async function buildsForThread(b: Row): Promise<Row> {
  const thread = str(b.thread_ref, 120);
  const who = str(b.requester, 40);
  if (!thread) throw new ApprovalError(422, 'thread_ref is required.');
  const rows = (await builder.forThread(thread)).filter((x) => APPROVERS.has(who) || x.requester_id === who);
  return {
    ok: true,
    builds: rows.map((x) => ({
      interaction_id: x.interaction_id,
      plan_summary: x.plan_summary,
      build_ref: x.build_ref,
      stage_reached: x.stage_reached,
      finished_at: x.finished_at,
      actions: Array.isArray(x.actions) ? (x.actions as Row[]).map((a) => ({ at: a.at, change: a.change, ok: a.ok })) : [],
      live: (x.backend_debrief as Row | null)?.published === true,
      reviewed: x.builder_decision !== null && x.usefulness_rating !== null,
      builder_decision: x.builder_decision,
      usefulness_rating: x.usefulness_rating,
      review_note: x.review_note,
      production: x.production_marked_at !== null,
      production_blockers: x.production_blockers,
    })),
  };
}

/**
 * The person's review of a build: accepted, modified or rejected, 1 to 5, a note, and whether it is in production. Only
 * the person who asked, Destiny or Jason. Written as the record's review stage (and production stage, which the
 * record still refuses unless its rule holds); every change of that build not yet rated takes its rating from it.
 */
export async function reviewBuild(b: Row): Promise<Row> {
  const id = str(b.interaction_id, 200);
  const who = str(b.rater, 40);
  const decision = str(b.decision, 12);
  const stars = Number(b.rating);
  const note = str(b.note, 4000) || null;
  if (!(BUILD_DECISIONS as readonly string[]).includes(decision)) throw new ApprovalError(422, 'decision is accepted, modified or rejected.');
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ApprovalError(422, 'rating is a whole number from 1 to 5.');
  const held = await builder.read({ interaction_id: id, limit: 1 });
  const row = held.interactions[0];
  if (!row) return { ok: false, reason: 'not_found', message: `No build ${id}.` };
  if (who !== row.requester_id && !APPROVERS.has(who)) return { ok: false, reason: 'not_permitted', message: 'Only the person who asked for this build, Destiny or Jason can review it.' };
  if (!row.finished_at) return { ok: false, reason: 'not_finished', message: 'This build has not finished yet, so it cannot be reviewed.' };
  const base = { interaction_id: id, rail_id: row.rail_id, proof_type: row.proof_type };
  const messages: Row[] = [{ ...base, stage: 'review', rater_id: who, builder_decision: decision, usefulness_rating: stars, ...(note ? { review_note: note } : {}) }];
  if (b.production === true && decision !== 'rejected' && !row.production_marked_at) messages.push({ ...base, stage: 'production', marked_by: who });
  await builder.store({ messages });
  const mapped = ratingFromReview(decision, stars);
  const open = await query<Row>(`SELECT id FROM engine_genie_approvals WHERE build_id = $1 AND status IN ('done','failed') AND (rating IS NULL OR rating = 'not_rated')`, [id]);
  for (const a of open.rows) {
    await query(`UPDATE engine_genie_approvals SET rating = $2, rating_reason = $3, rated_by = $4, rated_at = now() WHERE id = $1`, [a.id, mapped.rating, mapped.reason, who]);
    await log('genie_build_rated', String(a.id), who, { rating: mapped.rating, reason: mapped.reason, from_review: id });
  }
  return { ok: true, interaction_id: id, decision, rating: stars, production: messages.length > 1, changes_rated: open.rows.length };
}
