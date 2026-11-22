/**
 * Genie's controls, kept on the dashboard (16 Nov 2026, Destiny: "let's do 1 to 7 now", the Claude and
 * ChatGPT Slack features). Genie (genie-v3-migration) holds no database of its own for these, so it
 * reads and writes them here, on the inbound key, through one route: POST /api/engine/genie-control
 * with an `op`.
 *
 * - Channels: whether Genie follows a channel, whether it speaks up there unasked (proactive), the
 *   channel's daily ask limit, and the channel's memory (notes people asked Genie to remember there).
 *   Memory belongs to its channel and is never read anywhere else.
 * - Usage: one counter per channel per UTC day. Genie asks before every run; over the limit, it says
 *   so and does not run.
 * - Tasks: recurring asks ("every Monday at 9, post my open loops here"). Genie claims the due ones
 *   every minute; the claim moves next_run_at forward in the same statement, so two Genie instances
 *   never run one task twice.
 *
 * Who may change what: following, proactive and limits are Destiny's or Jason's. Anyone may add a
 * note or a task; a note or task is removed by the person who made it, Destiny or Jason.
 * Every change is one engine event (lane GENIE), which is the admin log the Genie page shows.
 */
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as approvals from './genieApprovals';
import * as reuseCheck from './reuseCheck';
import * as patternTrust from './patternTrust';
import * as shared from './sharedMemory';
import { isFormerBuilder } from './sources';

export const CONTROL_EVENTS = ['genie_channel_updated', 'genie_memory_added', 'genie_memory_removed', 'genie_limit_reached', 'genie_task_created', 'genie_task_cancelled', 'genie_task_ran', 'genie_nudge_posted'];
export const ADMINS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
export const LIMITS = { notes_per_channel: 50, note_chars: 500, tasks_per_channel: 20, prompt_chars: 1_000 };
const CHANNEL = /^[CGD][A-Z0-9]{6,}$/;
const USER = /^[UW][A-Z0-9]{6,}$/;

export class GenieControlError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function channelOf(b: Row): string {
  const c = str(b.channel_id, 40);
  if (!CHANNEL.test(c)) throw new GenieControlError(422, 'channel_id is required: a Slack channel id (C…, G… or D…).');
  return c;
}
function requesterOf(b: Row): string {
  const u = str(b.requester, 40);
  if (!USER.test(u)) throw new GenieControlError(422, 'requester is required: the Slack user id of the person asking.');
  return u;
}
function admin(u: string, what: string): void {
  if (!ADMINS.has(u)) throw new GenieControlError(403, `Only Destiny or Jason can ${what}.`);
}

async function log(type: string, subject: string, actor: string, detail: Row): Promise<void> {
  await engineEvents.record({ event_type: type, subject_id: subject, lane: 'GENIE', actor, source_ref: 'genie-control', detail });
}

/* ------------------------------------------------------------------ channels */

export async function channel(channelId: string): Promise<Row> {
  const r = await query<Row>(`SELECT channel_id, followed, proactive, daily_limit, memory, updated_by, updated_at FROM engine_genie_channels WHERE channel_id = $1`, [channelId]);
  const u = await query<{ asks: number }>(`SELECT asks FROM engine_genie_usage WHERE channel_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date`, [channelId]);
  const row = r.rows[0] ?? { channel_id: channelId, followed: false, proactive: false, daily_limit: null, memory: [], updated_by: null, updated_at: null };
  return { ...row, asks_today: Number(u.rows[0]?.asks ?? 0) };
}

async function ensure(channelId: string): Promise<void> {
  await query(`INSERT INTO engine_genie_channels (channel_id) VALUES ($1) ON CONFLICT (channel_id) DO NOTHING`, [channelId]);
}

export async function setChannel(b: Row): Promise<Row> {
  const c = channelOf(b);
  const who = requesterOf(b);
  admin(who, 'change how Genie behaves in a channel');
  const sets: string[] = [];
  const vals: unknown[] = [c];
  const changed: Row = {};
  for (const k of ['followed', 'proactive'] as const) {
    if (typeof b[k] === 'boolean') {
      vals.push(b[k]);
      sets.push(`${k} = $${vals.length}`);
      changed[k] = b[k];
    }
  }
  if (b.daily_limit !== undefined) {
    const n = b.daily_limit === null ? null : Number(b.daily_limit);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10_000)) throw new GenieControlError(422, 'daily_limit is a whole number from 1 to 10,000, or null for no limit.');
    vals.push(n);
    sets.push(`daily_limit = $${vals.length}`);
    changed.daily_limit = n;
  }
  if (sets.length === 0) throw new GenieControlError(422, 'Send followed, proactive or daily_limit.');
  // Speaking up unasked needs Genie to follow the channel.
  if (changed.proactive === true && changed.followed === undefined) {
    sets.push('followed = true');
    changed.followed = true;
  }
  vals.push(who);
  await ensure(c);
  await query(`UPDATE engine_genie_channels SET ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = now() WHERE channel_id = $1`, vals);
  await log('genie_channel_updated', c, who, changed);
  return { ok: true, changed, channel: await channel(c) };
}

export async function remember(b: Row): Promise<Row> {
  const c = channelOf(b);
  const who = requesterOf(b);
  const note = str(b.note, LIMITS.note_chars + 1);
  if (note.length < 3) throw new GenieControlError(422, 'note is required: what to remember, 3 characters or more.');
  if (note.length > LIMITS.note_chars) throw new GenieControlError(422, `A note is at most ${LIMITS.note_chars} characters.`);
  await ensure(c);
  const cur = await channel(c);
  const mem = Array.isArray(cur.memory) ? (cur.memory as Row[]) : [];
  if (mem.length >= LIMITS.notes_per_channel) throw new GenieControlError(409, `This channel already holds ${LIMITS.notes_per_channel} notes. Ask Genie to forget one first.`);
  const id = `N${Date.now().toString(36).toUpperCase()}`;
  const entry = { id, note, by: who, at: new Date().toISOString() };
  await query(`UPDATE engine_genie_channels SET memory = memory || $2::jsonb, updated_by = $3, updated_at = now() WHERE channel_id = $1`, [c, JSON.stringify([entry]), who]);
  await log('genie_memory_added', c, who, { id, note });
  return { ok: true, added: entry, notes: mem.length + 1 };
}

export async function forget(b: Row): Promise<Row> {
  const c = channelOf(b);
  const who = requesterOf(b);
  const id = str(b.note_id, 40);
  const words = str(b.match, 200).toLowerCase();
  const cur = await channel(c);
  const mem = Array.isArray(cur.memory) ? (cur.memory as Row[]) : [];
  const hits = mem.filter((n) => (id && n.id === id) || (!id && words.length >= 3 && String(n.note).toLowerCase().includes(words)));
  if (hits.length === 0) return { ok: false, reason: 'not_found', message: 'No note here matches that.', notes: mem };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', message: 'More than one note matches; name it more exactly.', matches: hits };
  const hit = hits[0];
  if (hit.by !== who && !ADMINS.has(who)) throw new GenieControlError(403, 'Only the person who added a note, Destiny or Jason can remove it.');
  const kept = mem.filter((n) => n.id !== hit.id);
  await query(`UPDATE engine_genie_channels SET memory = $2::jsonb, updated_by = $3, updated_at = now() WHERE channel_id = $1`, [c, JSON.stringify(kept), who]);
  await log('genie_memory_removed', c, who, { id: hit.id, note: hit.note });
  return { ok: true, removed: hit, notes: kept.length };
}

/** One more ask today in this channel; refused past the channel's limit, and said so. */
export async function usage(b: Row): Promise<Row> {
  const c = channelOf(b);
  const r = await query<{ asks: number }>(
    `INSERT INTO engine_genie_usage (channel_id, day, asks) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (channel_id, day) DO UPDATE SET asks = engine_genie_usage.asks + 1 RETURNING asks`, [c]);
  const asks = Number(r.rows[0].asks);
  const lim = await query<{ daily_limit: number | null; memory: unknown }>(`SELECT daily_limit, memory FROM engine_genie_channels WHERE channel_id = $1`, [c]);
  const limit = lim.rows[0]?.daily_limit ?? null;
  // The channel's memory rides on the same call, so every ask in a channel carries its notes.
  const memory = Array.isArray(lim.rows[0]?.memory) ? (lim.rows[0]?.memory as Row[]).map((n) => ({ id: n.id, note: n.note })) : [];
  const allowed = limit === null || asks <= limit;
  if (!allowed && asks === limit + 1) await log('genie_limit_reached', c, str(b.user_id, 40) || 'genie', { limit, asks });
  return { ok: true, allowed, asks, limit, memory };
}

export async function followed(): Promise<Row> {
  const r = await query<Row>(`SELECT channel_id, proactive FROM engine_genie_channels WHERE followed AND proactive ORDER BY channel_id`);
  return { ok: true, channels: r.rows };
}

/* --------------------------------------------------------------------- tasks */

/** The UTC offset of a zone at a moment, in minutes. */
function offsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((local - at.getTime()) / 60000);
}

/** The next time on one of `days` (0 Sunday … 6 Saturday) at hour:minute in tz, strictly after `after`. */
export function nextRun(days: number[], hour: number, minute: number, tz: string, after: Date): Date {
  const local = new Date(after.getTime() + offsetMinutes(after, tz) * 60000);
  for (let d = 0; d <= 8; d += 1) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, hour, minute));
    if (!days.includes(day.getUTCDay())) continue;
    const guess = day.getTime() - offsetMinutes(day, tz) * 60000;
    const utc = new Date(day.getTime() - offsetMinutes(new Date(guess), tz) * 60000);
    if (utc.getTime() > after.getTime()) return utc;
  }
  throw new GenieControlError(422, 'No run time could be worked out for that schedule.');
}

function scheduleOf(b: Row): { days: number[]; hour: number; minute: number; tz: string } {
  const days = Array.isArray(b.days) ? [...new Set((b.days as unknown[]).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  const hour = Number(b.hour);
  const minute = Number(b.minute ?? 0);
  const tz = str(b.tz, 64) || 'Africa/Lagos';
  if (days.length === 0) throw new GenieControlError(422, 'days is required: weekdays 0 (Sunday) to 6 (Saturday).');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new GenieControlError(422, 'hour (0 to 23) and minute (0 to 59) are required.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new GenieControlError(422, `${tz} is not a time zone.`);
  }
  return { days, hour, minute, tz };
}

export async function createTask(b: Row): Promise<Row> {
  const c = channelOf(b);
  const who = requesterOf(b);
  const prompt = str(b.prompt, LIMITS.prompt_chars + 1);
  if (prompt.length < 3) throw new GenieControlError(422, 'prompt is required: what Genie should do each time.');
  if (prompt.length > LIMITS.prompt_chars) throw new GenieControlError(422, `A task's prompt is at most ${LIMITS.prompt_chars} characters.`);
  const s = scheduleOf(b);
  const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM engine_genie_tasks WHERE channel_id = $1 AND status = 'active'`, [c]);
  if (Number(n.rows[0].n) >= LIMITS.tasks_per_channel) throw new GenieControlError(409, `This channel already has ${LIMITS.tasks_per_channel} recurring tasks. Cancel one first.`);
  const id = `GT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const next = nextRun(s.days, s.hour, s.minute, s.tz, new Date());
  await query(
    `INSERT INTO engine_genie_tasks (id, channel_id, thread_ts, created_by, prompt, schedule, next_run_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, c, str(b.thread_ts, 40) || null, who, prompt, JSON.stringify(s), next.toISOString()],
  );
  await log('genie_task_created', id, who, { channel_id: c, prompt, schedule: s, next_run_at: next.toISOString() });
  return { ok: true, id, next_run_at: next.toISOString(), schedule: s, prompt };
}

export async function listTasks(b: Row): Promise<Row> {
  const c = str(b.channel_id, 40);
  const r = await query<Row>(
    `SELECT id, channel_id, thread_ts, created_by, prompt, schedule, next_run_at, last_run_at, last_result, status, created_at
       FROM engine_genie_tasks WHERE status = 'active' ${c ? 'AND channel_id = $1' : ''} ORDER BY next_run_at`, c ? [c] : []);
  return { ok: true, tasks: r.rows };
}

/**
 * Which task "stop this recurring task" means when no id is given (18 Nov 2026, Destiny: copying the id
 * back made no sense). Asked in the thread of a task's own post, that task: the post's ts is on its
 * genie_task_ran event. Otherwise the asker's only active task in the channel. Two or more is a question,
 * never a guess.
 */
export async function resolveTask(b: Row, who: string): Promise<{ id?: string; candidates?: Row[] }> {
  const c = str(b.channel_id, 40);
  const thread = str(b.thread_ts, 40);
  if (thread) {
    const r = await query<{ id: string }>(
      `SELECT t.id FROM engine_events e JOIN engine_genie_tasks t ON t.id = e.subject_id
        WHERE e.event_type = 'genie_task_ran' AND e.detail->>'ts' = $1 ORDER BY e.id DESC LIMIT 1`, [thread]);
    if (r.rows[0]) return { id: r.rows[0].id };
  }
  if (!c) return { candidates: [] };
  const r = await query<Row>(
    `SELECT id, prompt, schedule FROM engine_genie_tasks WHERE status = 'active' AND channel_id = $1 AND created_by = $2 ORDER BY created_at`, [c, who]);
  if (r.rows.length === 1) return { id: String(r.rows[0].id) };
  return { candidates: r.rows };
}

export async function cancelTask(b: Row): Promise<Row> {
  const who = requesterOf(b);
  let id = str(b.id, 60);
  if (!id) {
    const found = await resolveTask(b, who);
    if (!found.id) {
      const list = found.candidates ?? [];
      return list.length === 0
        ? { ok: false, reason: 'no_task', message: 'You have no recurring task running in this channel.' }
        : { ok: false, reason: 'which_task', candidates: list, message: `You have ${list.length} recurring tasks here. Say which: ${list.map((t) => `${String(t.id)} (${String(t.prompt)})`).join('; ')}.` };
    }
    id = found.id;
  }
  const r = await query<Row>(`SELECT id, created_by, channel_id, prompt, status FROM engine_genie_tasks WHERE id = $1`, [id]);
  const t = r.rows[0];
  if (!t) return { ok: false, reason: 'not_found', message: `No task ${id}.` };
  if (t.status !== 'active') return { ok: false, reason: 'not_active', message: `${id} is already ${String(t.status)}.` };
  if (t.created_by !== who && !ADMINS.has(who)) throw new GenieControlError(403, 'Only the person who set up a task, Destiny or Jason can cancel it.');
  await query(`UPDATE engine_genie_tasks SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`, [id, who]);
  await log('genie_task_cancelled', id, who, { channel_id: t.channel_id, prompt: t.prompt });
  return { ok: true, cancelled: id, prompt: t.prompt };
}

/** Claims every due task and moves each to its next run, in one transaction. */
export async function dueTasks(): Promise<Row> {
  const tasks = await withTransaction(async (db) => {
    const r = await db.query<Row>(`SELECT id, channel_id, thread_ts, created_by, prompt, schedule FROM engine_genie_tasks WHERE status = 'active' AND next_run_at <= now() ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED`);
    const now = new Date();
    for (const t of r.rows) {
      const s = t.schedule as { days: number[]; hour: number; minute: number; tz: string };
      await db.query(`UPDATE engine_genie_tasks SET last_run_at = now(), next_run_at = $2 WHERE id = $1`, [t.id, nextRun(s.days, s.hour, s.minute, s.tz, now).toISOString()]);
    }
    return r.rows;
  });
  return { ok: true, tasks };
}

export async function taskResult(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const result = str(b.result, 300);
  await query(`UPDATE engine_genie_tasks SET last_result = $2 WHERE id = $1`, [id, result]);
  await log('genie_task_ran', id, 'genie', { result, ts: str(b.ts, 40) || null });
  return { ok: true };
}

export async function logNudge(b: Row): Promise<Row> {
  const c = channelOf(b);
  await log('genie_nudge_posted', c, 'genie', { message_ts: str(b.message_ts, 40), thread_ts: str(b.thread_ts, 40), asked_by: str(b.asked_by, 40) });
  return { ok: true };
}

/* ------------------------------------------------------------------- the route */

export async function handle(b: Row): Promise<Row> {
  switch (str(b.op, 40)) {
    case 'channel':
      return { ok: true, channel: await channel(channelOf(b)) };
    case 'set_channel':
      return setChannel(b);
    case 'remember':
      return remember(b);
    case 'forget':
      return forget(b);
    case 'usage':
      return usage(b);
    case 'followed':
      return followed();
    case 'create_task':
      return createTask(b);
    case 'list_tasks':
      return listTasks(b);
    case 'cancel_task':
      return cancelTask(b);
    case 'due_tasks':
      return dueTasks();
    case 'task_result':
      return taskResult(b);
    case 'log_nudge':
      return logNudge(b);
    case 'people':
      return people();
    // Step 6.1 (17 Nov 2026): Genie's direct tools wait on Destiny or Jason (genieApprovals.ts).
    case 'approval_request':
      return approvals.request(b);
    case 'approval_card':
      return approvals.setCard(b);
    case 'approval_decide':
      return approvals.decide(b);
    case 'approval_finish':
      return approvals.finish(b);
    case 'approval_expire':
      return approvals.expire();
    // Steps 10.9 to 10.11 (19 Nov 2026): the build trail's rating, the reuse check, the pattern trust record.
    case 'build_rate':
      return approvals.rate(b);
    case 'build_rate_card':
      return approvals.setRateCard(b);
    // 22 Nov 2026: the chat app's Rate this build card, and the record keeping itself current.
    case 'builds_for_thread':
      return approvals.buildsForThread(b);
    case 'build_review':
      return approvals.reviewBuild(b);
    case 'reuse_check':
      return { ...(await reuseCheck.check(b)) };
    case 'pattern_trust':
      return patternTrust.read();
    // Steps 7 and 8 (17 Nov 2026): one memory across the engine, and what every part is doing.
    case 'shared_remember':
      return shared.remember({ ...b, written_by: 'genie', said_by: b.requester });
    case 'shared_recall':
      return shared.recall(b);
    case 'shared_forget':
      return shared.forget(b);
    case 'activity':
      return shared.activity(b);
    default:
      throw new GenieControlError(422, 'op is one of channel, set_channel, remember, forget, usage, followed, create_task, list_tasks, cancel_task, due_tasks, task_result, log_nudge, people, approval_request, approval_card, approval_decide, approval_finish, approval_expire, build_rate, build_rate_card, reuse_check, pattern_trust, shared_remember, shared_recall, shared_forget, activity.');
  }
}

/**
 * Who is who (16 Nov 2026, Destiny: a summary called him "she"). Each Builder Profile's
 * Slack id, name and pronouns, read live, so Genie refers to people as their profile says,
 * and whether they are active (not a former builder). Nothing else on the profile is returned.
 */
export async function people(): Promise<Row> {
  const r = await query<Row>(`SELECT natural_id AS user_id, fields->>'name' AS name, NULLIF(TRIM(fields->>'pronouns'), '') AS pronouns
      FROM engine_builder_profiles WHERE natural_id IS NOT NULL ORDER BY fields->>'name'`);
  // active (21 Nov 2026): false for a builder who has left (sources.FORMER_BUILDERS). Genie treats a person with
  // an active profile as staff, so a new builder is never answered as a guest for want of a row in Genie's own map.
  return { ok: true, people: r.rows.map((p) => ({ ...p, active: !isFormerBuilder(String(p.user_id ?? '')) })) };
}

/** What the Genie page's Controls tab shows: channels, recurring tasks and the last 100 control actions. */
export async function page(): Promise<Row> {
  const ch = await query<Row>(`SELECT c.channel_id, c.followed, c.proactive, c.daily_limit, jsonb_array_length(c.memory) AS notes, c.memory, c.updated_by, c.updated_at,
      COALESCE(u.asks, 0) AS asks_today FROM engine_genie_channels c
      LEFT JOIN engine_genie_usage u ON u.channel_id = c.channel_id AND u.day = (now() AT TIME ZONE 'UTC')::date ORDER BY c.updated_at DESC NULLS LAST`);
  const tasks = await query<Row>(`SELECT id, channel_id, created_by, prompt, schedule, next_run_at, last_run_at, last_result, status, created_at FROM engine_genie_tasks ORDER BY status, next_run_at LIMIT 200`);
  const actions = await query<Row>(`SELECT id, event_type, subject_id, actor, detail, at FROM engine_events WHERE event_type = ANY($1) AND lane = 'GENIE' ORDER BY at DESC LIMIT 100`, [[...CONTROL_EVENTS, ...approvals.APPROVAL_EVENTS]]);
  return { channels: ch.rows, tasks: tasks.rows, actions: actions.rows, approvals: await approvals.list() };
}
