/**
 * Decision Watch (2026-10-11, Destiny — LOOP-1791743584778-5YQA, backlog task
 * TASK-1791743558788-FJOO; Jason, 11 Oct, #bha-coordination: "I want that
 * solved as infra, not as vibes"). The spec is docs/design/decision-watch-v0.md.
 *
 * Bays only speaks when something calls it, so a decision put to a person in a
 * thread and then left unanswered had nothing that came back to it. A watch is
 * the record of one such decision: what was asked, where, who owes the answer,
 * which SOP and North Star position it ties to, and how long to wait.
 *
 * A sweep every five minutes walks the watches that are still open:
 *
 *   1. The linked loop or backlog task is read from this database. Closed or
 *      done closes the watch (`moved`); a change to the row is movement and
 *      restarts the wait.
 *   2. The thread is read from Slack. A message from the owner closes the
 *      watch (`answered`), unless the decision has more than one part
 *      (`close_on_reply` false, 14 Oct 2026), when it restarts the wait like
 *      anyone else's; a message from anyone else restarts the wait. Bot
 *      posts, this module's own reminders included, are never movement.
 *   3. Quiet past the wait: one reminder, as Bays, in the thread (a DM to the
 *      owner where the watch has no thread), naming the decision, the SOP and
 *      North Star reference, the owner and the next logged step.
 *   4. After the last reminder and one more quiet wait: one escalation naming
 *      Jason and Destiny, and the watch stops (`escalated`).
 *
 * **It never reminds on a thread it could not read.** Quiet and unread look
 * the same from here and only one of them is a reason to nudge a person, so
 * an unread thread keeps its watch open with the reason, is tried again every
 * pass, and is written to `engine_events` once a day.
 *
 * The numbers are `RULE` and nowhere else. All it can do is post a Slack
 * message and change its own rows: it closes no loop and edits no record.
 *
 * **PX07 is its first standing use** (`autoCapital`): every open CAPITAL-lane
 * loop and backlog task with an owner this engine can name gets one watch,
 * once, under the SOP "CAPITAL Lane Live-Client Ownership & Escalation". The
 * wait starts when the watch is made, never from the row's old date, so
 * switching this on reminds nobody about the past.
 */
import * as engineEvents from './engineEvents';
import { query } from './pg';
import * as quota from './quota';
import * as slack from './slack';
import * as timers from './timers';

export const RULE = {
  wait_hours: 24,
  min_wait_hours: 1,
  max_wait_hours: 168,
  max_reminders: 3,
  /** Reminders and escalations posted per UTC day, across every watch. */
  daily_cap: 12,
  /** A watched thread is re-read at most this often while it is not yet due. */
  recheck_minutes: 30,
  tick_seconds: 300,
  /** Watches looked at in one pass, oldest check first. */
  per_pass: 40,
  /** Longest a watch can be snoozed, from now (18 Oct 2026, Destiny). */
  max_snooze_days: 14,
} as const;

/** Destiny and Jason: who an escalation names, and who may close anybody's watch. */
export const APPROVERS = ['U0A9V97949F', 'U0AEW3TBYH1'] as const;
const CAPITAL_SOP = 'SOP -- CAPITAL Lane Live-Client Ownership & Escalation (BHARAG 8caa5d47-3d6c-43da-8a79-67f823ca87a4)';

/** `escalating` is held for the moment an escalation is being posted, and by nothing else. */
export type WatchStatus = 'watching' | 'escalating' | 'answered' | 'moved' | 'escalated' | 'cancelled';
export const OPEN_STATUS: WatchStatus = 'watching';

export interface WatchRow {
  id: string;
  watch_id: string;
  decision: string;
  owner_user_id: string;
  owner_name: string | null;
  lane: string | null;
  sop_refs: string | null;
  ns_refs: string | null;
  next_step: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  thread_link: string | null;
  record_kind: string | null;
  record_id: string | null;
  status: WatchStatus;
  close_reason: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  wait_minutes: number;
  max_reminders: number;
  reminders_sent: number;
  quiet_since: Date;
  last_reminder_at: Date | null;
  last_reminder_ts: string | null;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  created_by: string | null;
  created_via: string | null;
  auto_key: string | null;
  record_hash: string | null;
  fixture: boolean;
  /** False for a decision with more than one part: the owner replying restarts the wait instead of closing the watch (14 Oct 2026). */
  close_on_reply: boolean;
  /** No reminder or escalation is posted before this; the watch stays open and replies still count (18 Oct 2026, migration 82). */
  snoozed_until: Date | null;
  snoozed_by: string | null;
  /**
   * An owner message at or before this is not an answer. Set when a snooze is asked for: the
   * owner asking Bays "snooze this" in the thread is a message from the owner, and on a
   * single-part watch it would otherwise close the watch it asked to pause (18 Oct 2026).
   */
  owner_seen_until: Date | null;
  history: Array<{ at: string; what: string; post?: string }>;
}

const newId = (now = Date.now()) => `DW-${now}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const hoursWords = (minutes: number) => {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} minutes`;
  const h = Math.round(minutes / 60);
  return h % 24 === 0 && h >= 24 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`;
};

export function dueAt(w: Pick<WatchRow, 'quiet_since' | 'wait_minutes'>): Date {
  return new Date(new Date(w.quiet_since).getTime() + w.wait_minutes * 60_000);
}

/** A Slack permalink for a thread, built here so a row never depends on one being handed in. */
export function permalink(channel: string, ts: string): string {
  return `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

/** `…/archives/C…/p1791733223226019` (with or without `?thread_ts=`) to its channel and the thread's root ts. */
export function parseThreadLink(link: string): { channel: string; ts: string } | null {
  try {
    const u = new URL(link.trim().replace(/^<|>$/g, '').split('|')[0]);
    const m = u.pathname.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d{16})/);
    if (!m) return null;
    const root = u.searchParams.get('thread_ts');
    return { channel: m[1], ts: root && /^\d+\.\d+$/.test(root) ? root : `${m[2].slice(0, -6)}.${m[2].slice(-6)}` };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ open */

export interface OpenInput {
  decision: string;
  owner_user_id: string;
  owner_name?: string | null;
  lane?: string | null;
  sop_refs?: string | null;
  ns_refs?: string | null;
  next_step?: string | null;
  channel_id?: string | null;
  thread_ts?: string | null;
  record_kind?: 'loops' | 'lane_backlog' | null;
  record_id?: string | null;
  wait_minutes?: number;
  created_by?: string | null;
  created_via?: string | null;
  auto_key?: string | null;
  fixture?: boolean;
  /** Default true. False when the decision has more than one part; see `WatchRow.close_on_reply`. */
  close_on_reply?: boolean;
}

export type OpenResult = { ok: true; created: boolean; watch: WatchRow } | { ok: false; reason: string; message: string };

async function ownerName(userId: string): Promise<string | null> {
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [userId]).catch(() => ({ rows: [] as Array<{ name: string | null }> }));
  return r.rows[0]?.name ?? null;
}

/**
 * The linked record as it is now. `hash` is of its fields: `updated_at` is set
 * on every write, changed or not, so a repeated post from n8n would otherwise
 * read as movement and a watch would never come due.
 */
async function recordState(kind: string, id: string): Promise<{ found: boolean; done: boolean; hash: string | null; label: string }> {
  if (kind === 'loops') {
    const r = await query<{ status: string | null; hash: string }>(
      `SELECT fields->>'Status' AS status, md5(fields::text) AS hash FROM engine_loops WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    return { found: Boolean(row), done: row?.status === 'Closed', hash: row?.hash ?? null, label: `loop ${id}` };
  }
  const r = await query<{ status: string | null; hash: string }>(
    `SELECT fields->>'status' AS status, md5(fields::text) AS hash FROM engine_lane_backlog WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [id],
  );
  const row = r.rows[0];
  const st = (row?.status ?? '').toLowerCase();
  return { found: Boolean(row), done: st === 'false' || st === 'done' || st === 'closed', hash: row?.hash ?? null, label: `backlog task ${id}` };
}

/**
 * Opens a watch. A second ask for the same thread and owner while the first is
 * still open answers the first (`created: false`): Jason's messages routinely
 * reach Bays twice, once in the thread and once in a DM.
 */
export async function open(input: OpenInput): Promise<OpenResult> {
  const decision = input.decision.trim();
  if (decision.length < 8) return { ok: false, reason: 'decision_required', message: 'Say what is being waited on, in a sentence.' };
  if (!/^[UW][A-Z0-9]{6,}$/.test(input.owner_user_id)) return { ok: false, reason: 'owner_required', message: `"${input.owner_user_id}" is not a Slack user id (U…). A watch needs the person who owes the answer.` };
  const hasThread = Boolean(input.channel_id && input.thread_ts);
  const hasRecord = Boolean(input.record_kind && input.record_id);
  if (!hasThread && !hasRecord) return { ok: false, reason: 'nothing_to_watch', message: 'A watch needs a Slack thread, a loop or a backlog task to watch.' };
  let recordHash: string | null = null;
  if (hasRecord) {
    const st = await recordState(input.record_kind as string, input.record_id as string);
    recordHash = st.hash;
    if (!st.found) return { ok: false, reason: 'record_not_found', message: `No ${st.label} is held, so there is nothing to watch.` };
    if (st.done) return { ok: false, reason: 'record_already_done', message: `The ${st.label} is already closed, so there is nothing to wait for.` };
  }
  const wait = Math.round(input.wait_minutes ?? RULE.wait_hours * 60);
  const floor = input.fixture ? 1 : RULE.min_wait_hours * 60;
  if (!(wait >= floor && wait <= RULE.max_wait_hours * 60)) {
    return { ok: false, reason: 'bad_wait', message: `The wait must be between ${RULE.min_wait_hours} and ${RULE.max_wait_hours} hours.` };
  }

  if (hasThread) {
    const held = await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE channel_id = $1 AND thread_ts = $2 AND owner_user_id = $3 AND status = 'watching' LIMIT 1`, [input.channel_id, input.thread_ts, input.owner_user_id]);
    if (held.rows[0]) return { ok: true, created: false, watch: held.rows[0] };
  }
  const id = newId();
  const name = input.owner_name ?? (await ownerName(input.owner_user_id));
  const r = await query<WatchRow>(
    `INSERT INTO engine_decision_watches
       (watch_id, decision, owner_user_id, owner_name, lane, sop_refs, ns_refs, next_step, channel_id, thread_ts, thread_link,
        record_kind, record_id, wait_minutes, max_reminders, created_by, created_via, auto_key, fixture, history, record_hash, close_on_reply)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      id,
      clip(decision, 1500),
      input.owner_user_id,
      name,
      input.lane?.trim() || null,
      input.sop_refs?.trim() || null,
      input.ns_refs?.trim() || null,
      input.next_step?.trim() || null,
      hasThread ? input.channel_id : null,
      hasThread ? input.thread_ts : null,
      hasThread ? permalink(input.channel_id as string, input.thread_ts as string) : null,
      hasRecord ? input.record_kind : null,
      hasRecord ? input.record_id : null,
      wait,
      RULE.max_reminders,
      input.created_by ?? null,
      input.created_via ?? null,
      input.auto_key ?? null,
      input.fixture === true,
      JSON.stringify([{ at: new Date().toISOString(), what: `opened${input.created_via ? ` through ${input.created_via}` : ''}${input.close_on_reply === false ? '; more than one part, so a reply from the owner does not close it' : ''}` }]),
      recordHash,
      input.close_on_reply !== false,
    ],
  );
  if (!r.rows[0]) {
    // The unique index refused it: the same thread and owner, or the same auto key, landed a moment ago.
    const again = input.auto_key
      ? await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE auto_key = $1 LIMIT 1`, [input.auto_key])
      : await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE channel_id = $1 AND thread_ts = $2 AND owner_user_id = $3 AND status = 'watching' LIMIT 1`, [input.channel_id, input.thread_ts, input.owner_user_id]);
    if (again.rows[0]) return { ok: true, created: false, watch: again.rows[0] };
    return { ok: false, reason: 'not_recorded', message: 'The watch could not be recorded.' };
  }
  const w = r.rows[0];
  await event('decision_watch_opened', w, `dw:${w.watch_id}:opened`, { owner: w.owner_user_id, wait_minutes: w.wait_minutes, via: w.created_via });
  return { ok: true, created: true, watch: w };
}

async function event(type: string, w: WatchRow, dedupe: string, detail: Record<string, unknown>): Promise<void> {
  if (w.fixture) return;
  await engineEvents
    .record({ event_type: type, subject_id: w.watch_id, lane: w.lane ?? 'BAYS', actor: 'decision watch', source_ref: w.thread_link ?? (w.record_id ? `${w.record_kind} ${w.record_id}` : null), detail: { decision: clip(w.decision, 300), ...detail }, dedupe_key: dedupe })
    .catch((e) => console.error(`[decision-watch] event ${type} for ${w.watch_id} not recorded: ${e instanceof Error ? e.message : String(e)}`));
}

/* ----------------------------------------------------------------- close */

async function settle(w: WatchRow, status: WatchStatus, reason: string, by: string | null, now: Date): Promise<void> {
  const r = await query(
    `UPDATE engine_decision_watches
        SET status = $2, close_reason = $3, closed_by = $4, closed_at = $5, last_error = NULL,
            history = history || $6::jsonb
      WHERE watch_id = $1 AND status = 'watching'`,
    [w.watch_id, status, clip(reason, 600), by, now.toISOString(), JSON.stringify([{ at: now.toISOString(), what: `${status}: ${clip(reason, 300)}` }])],
  );
  if (r.rowCount) await event(status === 'escalated' ? 'decision_watch_escalated' : 'decision_watch_closed', w, `dw:${w.watch_id}:${status}`, { status, reason: clip(reason, 300), by });
}

export type CloseResult = { ok: true; watch_id: string; status: WatchStatus } | { ok: false; reason: string; message: string };

/** A person, or Bays for a person, closing a watch. The requester, the owner, Destiny or Jason may. */
export async function close(watchId: string, by: string, status: 'answered' | 'cancelled', reason: string, now = new Date()): Promise<CloseResult> {
  const found = await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [watchId]);
  const w = found.rows[0];
  if (!w) return { ok: false, reason: 'not_found', message: `No watch has the id "${watchId}". Use list_decision_watches to find it.` };
  if (w.status !== 'watching') return { ok: false, reason: 'already_closed', message: `${watchId} is already ${w.status}.` };
  const may = by === w.created_by || by === w.owner_user_id || (APPROVERS as readonly string[]).includes(by);
  if (!may) return { ok: false, reason: 'not_permitted', message: `${watchId} can be closed by the person who asked for it, by its owner <@${w.owner_user_id}>, or by Destiny or Jason.` };
  await settle(w, status, reason, by, now);
  return { ok: true, watch_id: watchId, status };
}

/* ---------------------------------------------------------------- update */

export const UPDATABLE = ['sop_refs', 'ns_refs', 'next_step'] as const;
export type Updatable = (typeof UPDATABLE)[number];
export type UpdateResult =
  | { ok: true; watch: WatchRow; changed: Array<{ field: Updatable; from: string | null; to: string | null }>; flipped?: boolean }
  | { ok: false; reason: string; message: string };

/**
 * Sets or adds to the references on a watch that is still open (2026-10-11,
 * Jason, #bha-coordination 1791746835.121559: an SOP written after a watch was
 * opened could not be attached to it, so its reminders could only say "this is
 * quiet"). Three fields and no others: what is being waited on, who owes it and
 * where are what the watch *is*, and changing those is a new watch. `append`
 * adds to what is held instead of replacing it. Every change is a dated line in
 * the watch's history and one `decision_watch_updated` event with both values.
 */
export async function update(watchId: string, by: string, changes: Partial<Record<Updatable, string | null>>, opts: { append?: boolean; replace?: boolean; closeOnReply?: boolean } = {}, now = new Date()): Promise<UpdateResult> {
  const found = await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [watchId]);
  const w = found.rows[0];
  if (!w) return { ok: false, reason: 'not_found', message: `No watch has the id "${watchId}". Use list_decision_watches to find it.` };
  if (w.status !== 'watching') return { ok: false, reason: 'already_closed', message: `${watchId} is ${w.status}, so its reminders are over and there is nothing to attach a reference to.` };
  const may = by === w.created_by || by === w.owner_user_id || (APPROVERS as readonly string[]).includes(by);
  if (!may) return { ok: false, reason: 'not_permitted', message: `${watchId} can be changed by the person who asked for it, by its owner <@${w.owner_user_id}>, or by Destiny or Jason.` };
  const changed: Array<{ field: Updatable; from: string | null; to: string | null }> = [];
  for (const field of UPDATABLE) {
    if (!(field in changes)) continue;
    const given = changes[field];
    const from = w[field] ?? null;
    let to = typeof given === 'string' ? given.trim() || null : null;
    // Adds by default (14 Oct 2026): a replace dropped Jason's three-point next step on DW-1791901078077-O0B8.
    // Only `replace: true`, or an empty string to clear a field, takes what is held away.
    const append = opts.replace !== true && opts.append !== false;
    if (to && append && from) {
      if (from.toLowerCase().includes(to.toLowerCase())) to = from;
      else to = field === 'next_step' ? `${from}\nUpdate ${now.toISOString().slice(0, 10)}: ${to}` : `${from}; ${to}`;
    }
    const limit = field === 'next_step' ? 3000 : 1200;
    if (to && to.length > limit) return { ok: false, reason: 'too_long', message: `${field} would be ${to.length} characters; the limit is ${limit}. Send it with replace: true and a shorter text that keeps every part still owed.` };
    if (to !== from) changed.push({ field, from, to });
  }
  const flip = typeof opts.closeOnReply === 'boolean' && opts.closeOnReply !== (w.close_on_reply !== false);
  if (!changed.length && !flip) return { ok: true, watch: w, changed, flipped: false };
  const next = Object.fromEntries(changed.map((c) => [c.field, c.to])) as Partial<Record<Updatable, string | null>>;
  const lines = changed.map((c) =>
    c.from && c.to && c.to.startsWith(c.from)
      ? `${c.field} added to: "${clip(c.to.slice(c.from.length).replace(/^(\n|; )/, ''), 200)}"`
      : `${c.field} ${c.from ? 'changed' : 'set'}${c.to ? ` to "${clip(c.to, 200)}"` : ' to nothing'}`,
  );
  if (flip) lines.push(opts.closeOnReply ? 'a reply from the owner now closes it' : 'more than one part: a reply from the owner no longer closes it');
  const line = lines.join('; ');
  const r = await query<WatchRow>(
    `UPDATE engine_decision_watches
        SET sop_refs = CASE WHEN $2::boolean THEN $3 ELSE sop_refs END,
            ns_refs = CASE WHEN $4::boolean THEN $5 ELSE ns_refs END,
            next_step = CASE WHEN $6::boolean THEN $7 ELSE next_step END,
            close_on_reply = CASE WHEN $9::boolean THEN $10 ELSE close_on_reply END,
            history = history || $8::jsonb
      WHERE watch_id = $1 AND status = 'watching'
      RETURNING *`,
    [watchId, 'sop_refs' in next, next.sop_refs ?? null, 'ns_refs' in next, next.ns_refs ?? null, 'next_step' in next, next.next_step ?? null, JSON.stringify([{ at: now.toISOString(), what: `updated by ${by}: ${line}` }]), flip, opts.closeOnReply === true],
  );
  if (!r.rows[0]) return { ok: false, reason: 'already_closed', message: `${watchId} closed while it was being changed. Nothing was changed.` };
  // Not deduped: every change is its own event.
  await event('decision_watch_updated', r.rows[0], `dw:${watchId}:updated:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`, { by, changes: changed, ...(flip ? { close_on_reply: opts.closeOnReply } : {}) });
  return { ok: true, watch: r.rows[0], changed, flipped: flip };
}

/* ---------------------------------------------------------------- snooze */

export type SnoozeResult =
  | { ok: true; watch: WatchRow; snoozed_until: Date | null; changed: boolean }
  | { ok: false; reason: string; message: string };

const dayWords = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * Pauses a watch's reminders until a date (18 Oct 2026, Destiny — Kaiqi in
 * #workflow-logs-kaiqi asked not to be reminded while heads-down on 31 Oct, and
 * the only way Bays had was to cancel the watch and open a new one with a
 * longer wait, which lost its history and filed real work as "cancelled").
 * The watch stays open: the thread is still read, the owner's reply still
 * closes it, and a linked record closing still moves it. Nothing is posted
 * before `until`; after it the watch carries on as it was, so a watch already
 * quiet past its wait reminds on the next pass. At most `RULE.max_snooze_days`
 * from now. `until` null ends a snooze early. The owner, whoever asked for the
 * watch, Destiny or Jason may.
 */
export async function snooze(watchId: string, by: string, until: Date | null, reason: string | null, now = new Date()): Promise<SnoozeResult> {
  const found = await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [watchId]);
  const w = found.rows[0];
  if (!w) return { ok: false, reason: 'not_found', message: `No watch has the id "${watchId}". Use list_decision_watches to find it.` };
  if (w.status !== 'watching') return { ok: false, reason: 'already_closed', message: `${watchId} is ${w.status}, so it posts nothing and there is nothing to snooze.` };
  const may = by === w.created_by || by === w.owner_user_id || (APPROVERS as readonly string[]).includes(by);
  if (!may) return { ok: false, reason: 'not_permitted', message: `${watchId} can be snoozed by its owner <@${w.owner_user_id}>, by the person who asked for it, or by Destiny or Jason.` };
  const latest = new Date(now.getTime() + RULE.max_snooze_days * 86_400_000);
  if (until) {
    if (Number.isNaN(until.getTime())) return { ok: false, reason: 'bad_until', message: 'The snooze date could not be read.' };
    if (until.getTime() <= now.getTime()) return { ok: false, reason: 'not_in_future', message: `${dayWords(until)} has already passed. Give a date after now.` };
    if (until.getTime() > latest.getTime()) return { ok: false, reason: 'too_long', message: `A watch can be snoozed for at most ${RULE.max_snooze_days} days, so the latest date now is ${dayWords(latest)}.` };
  }
  const was = w.snoozed_until && new Date(w.snoozed_until).getTime() > now.getTime() ? new Date(w.snoozed_until) : null;
  if (!until && !was) return { ok: true, watch: w, snoozed_until: null, changed: false };
  if (until && was && was.getTime() === until.getTime()) return { ok: true, watch: w, snoozed_until: until, changed: false };
  const why = reason?.trim() ? `: ${clip(reason.trim(), 300)}` : '';
  const line = until ? `snoozed by ${by} until ${dayWords(until)}${was ? ` (was ${dayWords(was)})` : ''}${why}` : `snooze ended early by ${by}${why}`;
  const r = await query<WatchRow>(
    `UPDATE engine_decision_watches
        SET snoozed_until = $2, snoozed_by = $3, history = history || $4::jsonb, owner_seen_until = $5,
            last_error = CASE WHEN last_error LIKE 'held:%' THEN NULL ELSE last_error END
      WHERE watch_id = $1 AND status = 'watching'
      RETURNING *`,
    [watchId, until ? until.toISOString() : null, until ? by : null, JSON.stringify([{ at: now.toISOString(), what: line }]), now.toISOString()],
  );
  if (!r.rows[0]) return { ok: false, reason: 'already_closed', message: `${watchId} closed while it was being snoozed. Nothing was changed.` };
  await event(until ? 'decision_watch_snoozed' : 'decision_watch_unsnoozed', r.rows[0], `dw:${watchId}:snooze:${now.getTime()}`, { by, until: until ? until.toISOString() : null, was: was ? was.toISOString() : null, reason: reason?.trim() || null });
  return { ok: true, watch: r.rows[0], snoozed_until: until, changed: true };
}

/** True while a snooze is still running. */
export function snoozedAt(w: Pick<WatchRow, 'snoozed_until'>, now: Date): boolean {
  return Boolean(w.snoozed_until && new Date(w.snoozed_until).getTime() > now.getTime());
}

/* ------------------------------------------------------------ Slack side */

interface Msg {
  user?: string;
  bot_id?: string;
  subtype?: string;
  ts?: string;
  text?: string;
}

type ThreadRead = { ok: true; messages: Msg[]; read_as: string } | { ok: false; error: string };

const SCOPE_ERRORS = new Set(['missing_scope', 'not_in_channel', 'channel_not_found', 'not_allowed_token_type']);

const PAGES = 5;

/** Every reply after `oldest` under one message, following Slack's cursor. As one token. */
async function replies(channel: string, threadTs: string, oldest: string, token?: string | null): Promise<{ ok: true; messages: Msg[] } | { ok: false; error: string }> {
  const messages: Msg[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const r = await slack.botCall('conversations.replies', { channel, ts: threadTs, oldest, limit: 200, cursor }, 'form', token);
    if (!r.ok) return { ok: false, error: String(r.error) };
    messages.push(...((r.messages as Msg[]) ?? []));
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) return { ok: true, messages };
  }
  // More than a thousand replies since the watch opened: say so; never read a partial thread as a quiet one.
  return { ok: false, error: `more than ${PAGES * 200} replies to read` };
}

/** Replies after `oldest` under one message. Bays' own token first, North Star's where Bays cannot read the place. */
async function readSince(channel: string, threadTs: string, oldest: string): Promise<ThreadRead> {
  const tried: string[] = [];
  if (slack.slackConfigured()) {
    const r = await replies(channel, threadTs, oldest);
    if (r.ok) return { ok: true, messages: r.messages, read_as: 'Bays' };
    tried.push(`Bays: ${r.error}`);
    if (!SCOPE_ERRORS.has(r.error)) return { ok: false, error: `conversations.replies as Bays: ${r.error}` };
  } else tried.push(`Bays: ${slack.SLACK_TOKEN_VAR} is not set`);
  const ns = slack.northStarToken();
  if (ns) {
    const r = await replies(channel, threadTs, oldest, ns);
    if (r.ok) return { ok: true, messages: r.messages, read_as: 'North Star' };
    tried.push(`North Star: ${r.error}`);
  } else tried.push(`North Star: ${slack.NS_TOKEN_VAR} is not set`);
  return { ok: false, error: `conversations.replies could not read ${channel} thread ${threadTs} (${tried.join('; ')})` };
}

/** Slack's answers that mean the message is not there, as opposed to "not allowed to look". */
const GONE_ERRORS = new Set(['thread_not_found', 'message_not_found']);

export type ThreadCheck =
  | { ok: true; root: string; checked: boolean; read_as: 'Bays' | 'North Star' | null }
  | { ok: false; reason: 'thread_not_found' | 'thread_not_readable' | 'thread_check_failed'; message: string };

/**
 * Every threaded watch is checked at open (14 Oct 2026, Destiny). On 14 Oct
 * DW-1791991788784-OSK0 was opened on a ts no message in #bha-coordination
 * carries: it could never read its thread (`thread_not_found` on every sweep),
 * so it could never see the owner answer and would have reminded and escalated
 * regardless, and the duplicate check, which matches on the thread, missed
 * that it was the same ask as DW-1791991978962-19QD a minute later. So:
 *  - a reply's ts becomes its thread's root, whichever way the place was given,
 *    so the watch reads the whole thread and a second ask matches the first;
 *  - a ts Slack says is not there is refused (`thread_not_found`);
 *  - a place neither Bays nor North Star can read is refused
 *    (`thread_not_readable`): a watch that cannot see replies only nags;
 *  - any other Slack answer is refused (`thread_check_failed`), to try again.
 * With no Slack token configured nothing can be checked and the ts is kept as
 * given (`checked: false`); the sweep already says why it cannot read.
 */
export async function checkThread(channel: string, ts: string): Promise<ThreadCheck> {
  const tokens: Array<{ token: string | undefined; as: 'Bays' | 'North Star' }> = [];
  if (slack.slackConfigured()) tokens.push({ token: undefined, as: 'Bays' });
  const ns = slack.northStarToken();
  if (ns) tokens.push({ token: ns, as: 'North Star' });
  if (!tokens.length) return { ok: true, root: ts, checked: false, read_as: null };
  const tried: string[] = [];
  for (const t of tokens) {
    const r = await slack.botCall('conversations.replies', { channel, ts, limit: 1 }, 'form', t.token);
    if (r.ok) {
      const first = ((r.messages as Array<{ ts?: string; thread_ts?: string }>) ?? [])[0];
      if (!first) return { ok: false, reason: 'thread_not_found', message: `Slack has no message ${ts} in ${channel}. Pass the link of the message the ask was made in (Copy link in Slack), not an id from somewhere else.` };
      const root = first.thread_ts && /^\d+\.\d+$/.test(first.thread_ts) ? first.thread_ts : ts;
      return { ok: true, root, checked: true, read_as: t.as };
    }
    const error = String(r.error);
    if (GONE_ERRORS.has(error)) return { ok: false, reason: 'thread_not_found', message: `Slack has no message ${ts} in ${channel} (${error}). Pass the link of the message the ask was made in (Copy link in Slack), not an id from somewhere else.` };
    tried.push(`${t.as}: ${error}`);
    if (!SCOPE_ERRORS.has(error)) return { ok: false, reason: 'thread_check_failed', message: `Could not check ${channel} thread ${ts} (${tried.join('; ')}). Nothing was opened; try again.` };
  }
  return { ok: false, reason: 'thread_not_readable', message: `Neither Bays nor North Star can read ${channel} (${tried.join('; ')}), so a watch there could never see a reply. Add Bays to the channel, or watch the loop or task instead (record_id, no thread).` };
}

/** The thread's root for a ts, or the ts as given where it cannot be read. Kept for callers that only want the root. */
export async function resolveRoot(channel: string, ts: string): Promise<string> {
  const c = await checkThread(channel, ts);
  return c.ok ? c.root : ts;
}

const mention = (id: string) => `<@${id}>`;

export function reminderText(w: WatchRow, n: number, now: Date): string {
  const quiet = hoursWords((now.getTime() - new Date(w.quiet_since).getTime()) / 60_000);
  const lines = [
    `${w.fixture ? 'TEST. ' : ''}:eyes: *Decision Watch* ${mention(w.owner_user_id)}, this is still waiting on you:`,
    `> ${clip(w.decision, 600).replace(/\n+/g, '\n> ')}`,
  ];
  if (w.sop_refs) lines.push(`*SOP:* ${w.sop_refs}`);
  if (w.ns_refs) lines.push(`*North Star:* ${w.ns_refs}`);
  if (w.record_id) lines.push(`*Tracked as:* ${w.record_kind === 'loops' ? 'loop' : 'backlog task'} \`${w.record_id}\``);
  lines.push(`*Next logged step:* ${w.next_step || 'reply here with the decision, or say what is blocking it.'}`);
  // 19 Oct 2026 (LOOP-1792136810976-BBGL): the closing line says what really closes this watch. On a
  // decision with more than one part (close_on_reply false) a reply restarts the wait, so telling the
  // owner it closes the watch was wrong (DW-1791985832450-IKOZ and DW-1791989874656-W3JQ, 16 Oct).
  const where = w.thread_ts ? 'in this thread' : 'in a thread on this message';
  const closes = w.close_on_reply === false
    ? `This decision has more than one part, so a reply from you ${where} restarts the wait; the watch closes once every part is answered${w.record_id ? ' or the tracked item closes' : ''}. Waiting on a date? Ask Bays to snooze it until then.`
    : `A reply from you ${where} closes this watch.`;
  lines.push(`_Reminder ${n} of ${w.max_reminders}. No movement for ${quiet}. ${closes} (\`${w.watch_id}\`)_`);
  return lines.join('\n');
}

export function escalationText(w: WatchRow): string {
  const where = w.thread_link ? '' : w.record_id ? ` (${w.record_kind === 'loops' ? 'loop' : 'backlog task'} \`${w.record_id}\`)` : '';
  return [
    `${w.fixture ? 'TEST. ' : ''}:rotating_light: *Decision Watch, escalated* ${APPROVERS.map(mention).join(' ')}`,
    `${w.max_reminders} reminders went to ${mention(w.owner_user_id)} and nothing has moved${where}:`,
    `> ${clip(w.decision, 600).replace(/\n+/g, '\n> ')}`,
    ...(w.sop_refs ? [`*SOP:* ${w.sop_refs}`] : []),
    ...(w.ns_refs ? [`*North Star:* ${w.ns_refs}`] : []),
    `*Lane owner:* ${mention(w.owner_user_id)}${w.lane ? ` (${w.lane})` : ''}. *Next logged step:* ${w.next_step || 'a decision, or a named blocker.'}`,
    `_This watch (\`${w.watch_id}\`) has stopped. Nothing more will be posted about it._`,
  ].join('\n');
}

type Posted = { ok: true; ts: string; channel: string } | { ok: false; error: string };

async function post(channel: string, text: string, threadTs: string | null): Promise<Posted> {
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set` };
  const r = await slack.botCall('chat.postMessage', { channel, text, thread_ts: threadTs ?? undefined, unfurl_links: false, unfurl_media: false });
  return r.ok && typeof r.ts === 'string' ? { ok: true, ts: r.ts, channel: typeof r.channel === 'string' ? r.channel : channel } : { ok: false, error: `chat.postMessage: ${String(r.error ?? 'unknown error')}` };
}

async function postedToday(now: Date): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM engine_decision_watches w, jsonb_array_elements(w.history) h
      WHERE NOT w.fixture AND h->>'post' = 'true' AND h->>'at' >= $1`,
    [`${now.toISOString().slice(0, 10)}T00:00:00.000Z`],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/* ----------------------------------------------------------------- sweep */

export interface SweepResult {
  looked_at: number;
  opened_auto: number;
  closed: string[];
  reminded: string[];
  escalated: string[];
  held_cap: string[];
  unread: string[];
  failed: string[];
  would?: Array<{ watch_id: string; action: string }>;
}

async function note(w: WatchRow, patch: { quiet_since?: Date; last_error?: string | null; checked?: Date; history?: string; record_hash?: string }): Promise<void> {
  await query(
    `UPDATE engine_decision_watches
        SET quiet_since = GREATEST(quiet_since, COALESCE($2::timestamptz, quiet_since)),
            record_hash = COALESCE($8, record_hash),
            last_error = CASE WHEN $3::boolean THEN $4 ELSE last_error END,
            last_checked_at = COALESCE($5::timestamptz, last_checked_at),
            history = CASE WHEN $6::text IS NULL THEN history ELSE history || jsonb_build_array(jsonb_build_object('at', $7::text, 'what', $6::text)) END
      WHERE watch_id = $1 AND status = 'watching'`,
    [w.watch_id, patch.quiet_since ? patch.quiet_since.toISOString() : null, patch.last_error !== undefined, patch.last_error ?? null, patch.checked ? patch.checked.toISOString() : null, patch.history ?? null, new Date().toISOString(), patch.record_hash ?? null],
  );
}

/**
 * PX07: one watch per open CAPITAL-lane loop or backlog task with a nameable
 * owner. Keyed on the record, so a record is watched once and never again.
 */
export async function autoCapital(): Promise<number> {
  let made = 0;
  const tasks = await query<{ natural_id: string; task: string | null; owner: string | null; user_id: string | null }>(
    `SELECT b.natural_id, b.fields->>'task' AS task, b.fields->>'owner' AS owner, p.natural_id AS user_id
       FROM engine_lane_backlog b
       LEFT JOIN engine_builder_profiles p ON lower(p.fields->>'name') = lower(b.fields->>'owner')
      WHERE b.fields->>'lane' = 'CAPITAL' AND lower(coalesce(b.fields->>'status', 'true')) NOT IN ('false', 'done', 'closed')
        AND NOT EXISTS (SELECT 1 FROM engine_decision_watches w WHERE w.auto_key = 'capital:' || b.natural_id)`,
  );
  const loops = await query<{ natural_id: string; task: string | null; owner: string | null; user_id: string | null }>(
    `SELECT DISTINCT ON (l.natural_id) l.natural_id, l.fields->>'What' AS task, NULL::text AS owner, l.fields->>'Assignee Slack User ID' AS user_id
       FROM engine_loops l
      WHERE l.fields->>'lane_tag' = 'CAPITAL' AND l.fields->>'Status' IN ('Open', 'In Progress')
        AND NOT EXISTS (SELECT 1 FROM engine_decision_watches w WHERE w.auto_key = 'capital:' || l.natural_id)
      ORDER BY l.natural_id, l.updated_at DESC`,
  );
  for (const [kind, rows] of [['lane_backlog', tasks.rows], ['loops', loops.rows]] as const) {
    for (const row of rows) {
      if (!row.user_id || !/^[UW][A-Z0-9]{6,}$/.test(row.user_id) || !row.task) continue; // an owner that is not one person is not reminded
      const r = await open({
        decision: clip(row.task, 700),
        owner_user_id: row.user_id,
        owner_name: row.owner,
        lane: 'CAPITAL',
        sop_refs: CAPITAL_SOP,
        next_step: `Log where this stands on the ${kind === 'loops' ? 'loop' : 'task'}, or say what is blocking it.`,
        record_kind: kind,
        record_id: row.natural_id,
        created_via: 'auto: CAPITAL lane (PX07)',
        auto_key: `capital:${row.natural_id}`,
      });
      if (r.ok && r.created) made++;
    }
  }
  return made;
}

/**
 * One pass. `dry` changes nothing and posts nothing: it answers what each open
 * watch would get. `only` narrows the pass to one watch.
 */
export async function sweep(now = new Date(), opts: { dry?: boolean; only?: string } = {}): Promise<SweepResult> {
  const out: SweepResult = { looked_at: 0, opened_auto: 0, closed: [], reminded: [], escalated: [], held_cap: [], unread: [], failed: [], ...(opts.dry ? { would: [] } : {}) };
  if (!opts.dry && !opts.only) out.opened_auto = await autoCapital().catch((e) => (console.error(`[decision-watch] CAPITAL auto-watch failed: ${e instanceof Error ? e.message : String(e)}`), 0));

  // An escalation that was claimed and never finished (the process stopped mid-post) goes back to
  // watching with the reason, so it is tried again and never sits unseen.
  if (!opts.dry) {
    await query(
      `UPDATE engine_decision_watches SET status = 'watching', last_error = 'an escalation was interrupted before it was recorded; it is being tried again'
        WHERE status = 'escalating' AND (last_checked_at IS NULL OR last_checked_at < $1::timestamptz - interval '10 minutes')`,
      [now.toISOString()],
    );
  }
  const rows = await query<WatchRow>(
    `SELECT * FROM engine_decision_watches WHERE status = 'watching' AND ($1::text IS NULL OR watch_id = $1) ORDER BY last_checked_at ASC NULLS FIRST, id ASC LIMIT $2`,
    [opts.only ?? null, RULE.per_pass],
  );
  let posted = await postedToday(now);
  const would = (w: WatchRow, action: string) => out.would?.push({ watch_id: w.watch_id, action });

  for (const w of rows.rows) {
    out.looked_at++;
    try {
      let quietSince = new Date(w.quiet_since);

      // 1. The linked record, from this database.
      if (w.record_kind && w.record_id) {
        const st = await recordState(w.record_kind, w.record_id);
        if (!st.found || st.done) {
          const why = st.found ? `the ${st.label} was closed` : `the ${st.label} is no longer held`;
          if (opts.dry) would(w, `close as moved: ${why}`);
          else (await settle(w, 'moved', why, null, now), out.closed.push(w.watch_id));
          continue;
        }
        if (st.hash && w.record_hash && st.hash !== w.record_hash) {
          quietSince = now;
          if (!opts.dry) await note(w, { quiet_since: quietSince, record_hash: st.hash, history: `the ${st.label} changed, so the wait starts again` });
        } else if (st.hash && !w.record_hash && !opts.dry) await note(w, { record_hash: st.hash });
      }

      // 2. The thread (or, with no thread, the DM a reminder went to), from Slack.
      const due = quietSince.getTime() + w.wait_minutes * 60_000 <= now.getTime();
      const stale = !w.last_checked_at || now.getTime() - new Date(w.last_checked_at).getTime() >= RULE.recheck_minutes * 60_000;
      // A watch with no thread reads the replies under its own last reminder, in the owner's DM:
      // any message at all in that DM is not an answer to this watch.
      const place = w.thread_ts ? { channel: w.channel_id as string, thread: w.thread_ts } : w.channel_id && w.last_reminder_ts ? { channel: w.channel_id, thread: w.last_reminder_ts } : null;
      let readOk = true;
      if (place && (due || stale)) {
        const oldest = (new Date(w.created_at).getTime() / 1000).toFixed(6);
        const read = await readSince(place.channel, place.thread, oldest);
        if (!read.ok) {
          out.unread.push(w.watch_id);
          if (!opts.dry) {
            await note(w, { last_error: clip(read.error, 500), checked: now });
            await event('decision_watch_unread', w, `dw:${w.watch_id}:unread:${now.toISOString().slice(0, 10)}`, { error: clip(read.error, 300) });
          } else would(w, `the place could not be read (${clip(read.error, 160)})`);
          // A thread that was not read is never reminded on. A watch on a record
          // carries on: the record, read above, is what it is waiting on.
          if (w.thread_ts) continue;
          readOk = false;
        }
        const human = (read.ok ? read.messages : []).filter((m) => m.user && !m.bot_id && (!m.subtype || m.subtype === 'thread_broadcast') && m.ts && Number(m.ts) > Number(oldest));
        // An owner message up to a snooze is the snooze being asked for, never the answer.
        const ownerFloor = w.owner_seen_until ? Math.max(Number(oldest), new Date(w.owner_seen_until).getTime() / 1000) : Number(oldest);
        const fromOwner = human.filter((m) => m.user === w.owner_user_id && Number(m.ts) > ownerFloor).sort((a, b) => Number(b.ts) - Number(a.ts))[0];
        if (fromOwner && w.close_on_reply !== false) {
          const why = `${w.owner_name || 'the owner'} replied ${w.thread_ts ? 'in the thread' : 'under the reminder'} (${permalink(place.channel, fromOwner.ts as string)})`;
          if (opts.dry) would(w, `close as answered: ${why}`);
          else (await settle(w, 'answered', why, w.owner_user_id, now), out.closed.push(w.watch_id));
          continue;
        }
        // A watch with more than one part (14 Oct 2026, Jason in #workflow-logs-kaiqi: "keep reminding until
        // all three are addressed"): the owner's reply is movement, never the answer. It closes only when a
        // person, or Bays for one, confirms every part was answered, or the linked record closes.
        const ownerReplyNew = fromOwner && w.close_on_reply === false && Number(fromOwner.ts) * 1000 > quietSince.getTime() ? fromOwner : null;
        const newest = human.map((m) => Number(m.ts) * 1000).sort((a, b) => b - a)[0];
        if (newest && newest > quietSince.getTime()) quietSince = new Date(newest);
        if (ownerReplyNew && opts.dry) would(w, 'the owner replied; this watch has more than one part, so the wait starts again and it stays open');
        if (!opts.dry && readOk) {
          await note(w, {
            quiet_since: quietSince,
            last_error: null,
            checked: now,
            ...(ownerReplyNew ? { history: `${w.owner_name || 'the owner'} replied (${permalink(place.channel, ownerReplyNew.ts as string)}); more than one part, so it stays open until every part is confirmed answered` } : {}),
          });
        }
      } else if (!opts.dry && !place) await note(w, { checked: now });

      // 3. Snoozed: the thread was still read above, so a reply still counts, but nothing is posted.
      if (snoozedAt(w, now)) {
        if (opts.dry) would(w, `nothing: snoozed until ${new Date(w.snoozed_until as Date).toISOString()}`);
        continue;
      }

      // 4. Quiet past the wait.
      if (quietSince.getTime() + w.wait_minutes * 60_000 > now.getTime()) {
        if (opts.dry) would(w, `nothing: not due until ${new Date(quietSince.getTime() + w.wait_minutes * 60_000).toISOString()}`);
        continue;
      }
      const escalate = w.reminders_sent >= w.max_reminders;
      if (posted >= RULE.daily_cap && !w.fixture) {
        out.held_cap.push(w.watch_id);
        if (opts.dry) would(w, `hold: today's ${RULE.daily_cap} posts are used`);
        else {
          await note(w, { last_error: `held: today's ${RULE.daily_cap} Decision Watch posts are used; tried again on the next pass` });
          // Once a day per watch: the rate limit doing its job is logged, not only noted on the row.
          await event('decision_watch_held', w, `dw:${w.watch_id}:held:${now.toISOString().slice(0, 10)}`, { reason: 'daily_cap', cap: RULE.daily_cap, posted_today: posted });
        }
        continue;
      }
      const live = { ...w, quiet_since: quietSince };
      if (escalate) {
        if (opts.dry) { would(w, 'escalate to Jason and Destiny, then stop'); continue; }
        const target = w.thread_ts ? { channel: w.channel_id as string, thread: w.thread_ts } : { channel: quota.channelId() ?? '', thread: null };
        if (!target.channel) { out.failed.push(w.watch_id); await note(w, { last_error: `escalation not posted: ${quota.CHANNEL_VAR} is not set, and this watch has no thread to escalate in` }); continue; }
        // The claim comes first: whoever moves the row out of 'watching' is the one that posts.
        const claim = await query(`UPDATE engine_decision_watches SET status = 'escalating' WHERE watch_id = $1 AND status = 'watching' AND reminders_sent = $2`, [w.watch_id, w.reminders_sent]);
        if (!claim.rowCount) continue;
        const p = await post(target.channel, escalationText(live), target.thread);
        await query(`UPDATE engine_decision_watches SET status = 'watching' WHERE watch_id = $1 AND status = 'escalating'`, [w.watch_id]);
        if (!p.ok) { out.failed.push(w.watch_id); await note(w, { last_error: `escalation not posted: ${p.error}` }); continue; }
        await query(`UPDATE engine_decision_watches SET history = history || $2::jsonb WHERE watch_id = $1`, [w.watch_id, JSON.stringify([{ at: now.toISOString(), what: 'escalation posted', post: 'true' }])]);
        await settle(w, 'escalated', `${w.max_reminders} reminders and no movement; escalated to Jason and Destiny (${permalink(p.channel, p.ts)})`, null, now);
        posted++;
        out.escalated.push(w.watch_id);
        continue;
      }
      const n = w.reminders_sent + 1;
      if (opts.dry) { would(w, `post reminder ${n} of ${w.max_reminders}`); continue; }
      // The claim comes first, so two passes (the timer and a person, or two instances during a
      // deploy) cannot both post reminder n: only the one whose UPDATE lands goes on to Slack.
      const claim = await query(
        `UPDATE engine_decision_watches SET reminders_sent = $2, last_reminder_at = $3, quiet_since = $3
          WHERE watch_id = $1 AND status = 'watching' AND reminders_sent = $4`,
        [w.watch_id, n, now.toISOString(), w.reminders_sent],
      );
      if (!claim.rowCount) continue;
      const p = w.thread_ts ? await post(w.channel_id as string, reminderText(live, n, now), w.thread_ts) : await post(w.owner_user_id, reminderText(live, n, now), null);
      if (!p.ok) {
        // Nothing went out, so the claim is given back and the next pass tries again.
        await query(
          `UPDATE engine_decision_watches SET reminders_sent = $2, last_reminder_at = $3, quiet_since = $4, last_error = $5 WHERE watch_id = $1 AND reminders_sent = $6`,
          [w.watch_id, w.reminders_sent, iso(w.last_reminder_at), quietSince.toISOString(), `reminder ${n} not posted: ${p.error}`, n],
        );
        out.failed.push(w.watch_id);
        continue;
      }
      await query(
        `UPDATE engine_decision_watches
            SET last_reminder_ts = $2, last_error = NULL, channel_id = COALESCE(channel_id, $3), history = history || $4::jsonb
          WHERE watch_id = $1`,
        [w.watch_id, p.ts, p.channel, JSON.stringify([{ at: now.toISOString(), what: `reminder ${n} of ${w.max_reminders} posted (${permalink(p.channel, p.ts)})`, post: 'true' }])],
      );
      await event('decision_watch_reminded', w, `dw:${w.watch_id}:reminder:${n}`, { reminder: n, of: w.max_reminders, link: permalink(p.channel, p.ts) });
      posted++;
      out.reminded.push(w.watch_id);
    } catch (e) {
      out.failed.push(w.watch_id);
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[decision-watch] ${w.watch_id} failed: ${why}`);
      if (!opts.dry) await note(w, { last_error: clip(why, 500) }).catch(() => undefined);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ read */

const lagosTime = (d: Date) =>
  `${d.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} Lagos (${d.toISOString().slice(11, 16)} UTC)`;

/**
 * What moves this watch, in words, built from the row (19 Oct 2026, Destiny). On 18 Oct Bays told
 * Kaiqi a progress note would reset his watch's clock; the watch was on a different thread, so it
 * would not. The list handed Bays a channel id and a ts and left the meaning to it. This sentence
 * is the same rule `sweep` applies and the reminder states, so Bays can quote it instead of guessing.
 */
export function movesText(w: WatchRow, due: Date, now = new Date()): string {
  if (w.status !== 'watching') return `Closed (${w.status}). Nothing moves it any more.`;
  const owner = w.owner_name || `<@${w.owner_user_id}>`;
  const ownerReply = w.close_on_reply === false
    ? `a reply from ${owner} restarts the wait (the decision has more than one part, so it stays open until every part is answered and close_decision_watch is called)`
    : `a reply from ${owner} closes it`;
  const parts: string[] = [];
  if (w.thread_ts && w.thread_link) {
    parts.push(`This watch is on ${w.thread_link}. Only messages in that thread count: ${ownerReply}; a reply from anyone else restarts the wait. A message anywhere else (another thread, a channel, a DM) does not count.`);
  } else {
    parts.push(`This watch has no thread: reminders go to ${owner} by DM, and only a reply in a thread on one of those reminders counts (${ownerReply}).`);
  }
  if (w.record_id) parts.push(`It also restarts when ${w.record_kind === 'loops' ? 'loop' : 'backlog task'} ${w.record_id} changes, and closes when it closes.`);
  if (snoozedAt(w, now)) parts.push(`Snoozed until ${dayWords(new Date(w.snoozed_until as Date))}: nothing is posted before then, but a reply still counts.`);
  const next = w.reminders_sent >= w.max_reminders ? 'escalation to Jason and Destiny' : `reminder ${w.reminders_sent + 1} of ${w.max_reminders}`;
  parts.push(due.getTime() <= now.getTime() ? `If nothing moves, ${next} goes on the next pass (within five minutes).` : `If nothing moves, ${next} goes at ${lagosTime(due)}.`);
  return parts.join(' ');
}

export function show(w: WatchRow, now = new Date()) {
  const open = w.status === 'watching';
  const snoozed = open && snoozedAt(w, now);
  // A snoozed watch acts no sooner than the snooze ends, and no sooner than its own wait.
  const due = snoozed ? new Date(Math.max(dueAt(w).getTime(), new Date(w.snoozed_until as Date).getTime())) : dueAt(w);
  return {
    watch_id: w.watch_id,
    status: w.status,
    state: !open ? w.status : snoozed ? `snoozed until ${dayWords(new Date(w.snoozed_until as Date))}` : w.last_error ? 'watching, with a problem' : w.reminders_sent >= w.max_reminders ? 'last reminder sent, escalates next' : w.reminders_sent ? `reminded ${w.reminders_sent} of ${w.max_reminders}` : 'watching',
    decision: w.decision,
    owner_user_id: w.owner_user_id,
    owner_name: w.owner_name,
    lane: w.lane,
    sop_refs: w.sop_refs,
    ns_refs: w.ns_refs,
    next_step: w.next_step,
    thread_link: w.thread_link,
    record: w.record_id ? { kind: w.record_kind, id: w.record_id } : null,
    wait: hoursWords(w.wait_minutes),
    wait_minutes: w.wait_minutes,
    reminders_sent: w.reminders_sent,
    max_reminders: w.max_reminders,
    quiet_since: iso(w.quiet_since),
    next_action_at: open ? due.toISOString() : null,
    next_action: open ? (w.reminders_sent >= w.max_reminders ? 'escalate to Jason and Destiny' : `reminder ${w.reminders_sent + 1} of ${w.max_reminders}`) : null,
    overdue: open && due.getTime() <= now.getTime(),
    how_it_moves: movesText(w, due, now),
    next_action_when: !open ? null : due.getTime() <= now.getTime() ? 'due now' : `in ${hoursWords((due.getTime() - now.getTime()) / 60_000)}`,
    last_reminder_at: iso(w.last_reminder_at),
    last_checked_at: iso(w.last_checked_at),
    problem: w.last_error,
    close_reason: w.close_reason,
    closed_by: w.closed_by,
    closed_at: iso(w.closed_at),
    created_at: iso(w.created_at),
    created_by: w.created_by,
    created_via: w.created_via,
    fixture: w.fixture,
    closes_on_owner_reply: w.close_on_reply !== false,
    snoozed_until: snoozed ? iso(w.snoozed_until) : null,
    snoozed_by: snoozed ? w.snoozed_by : null,
    history: w.history ?? [],
  };
}

/** The page's and the tool's read: open watches first (soonest action first), then the closed ones, newest first. */
export async function read(opts: { fixtures?: boolean; limit?: number } = {}) {
  const now = new Date();
  const r = await query<WatchRow>(`SELECT * FROM engine_decision_watches WHERE ($1::boolean OR NOT fixture) ORDER BY created_at DESC LIMIT $2`, [opts.fixtures === true, opts.limit ?? 300]);
  const rows = r.rows.map((w) => show(w, now));
  const open = rows.filter((w) => w.status === 'watching').sort((a, b) => String(a.next_action_at).localeCompare(String(b.next_action_at)));
  const closed = rows.filter((w) => w.status !== 'watching').sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
  const count = (s: string) => rows.filter((w) => w.status === s).length;
  return {
    rule: {
      wait_hours: RULE.wait_hours,
      max_reminders: RULE.max_reminders,
      daily_cap: RULE.daily_cap,
      in_words: `A watch waits ${RULE.wait_hours} hours for movement (the owner replying, anyone else replying, or the linked loop or task changing). Quiet past that, Bays posts a reminder in the thread, up to ${RULE.max_reminders}. After the last one and another quiet wait, one escalation names Jason and Destiny and the watch stops. At most ${RULE.daily_cap} posts a day across all watches. A thread that could not be read is never reminded on. A watch can be snoozed for up to ${RULE.max_snooze_days} days by its owner, whoever asked for it, Destiny or Jason: it stays open, a reply still counts, and nothing is posted until the date.`,
    },
    counts: { watching: open.length, snoozed: open.filter((w) => w.snoozed_until).length, with_a_problem: open.filter((w) => w.problem).length, answered: count('answered'), moved: count('moved'), escalated: count('escalated'), cancelled: count('cancelled') },
    posted_today: await postedToday(now),
    watches: [...open, ...closed],
  };
}

/* ----------------------------------------------------------------- timer */

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('decision watch');
    if (busy) return;
    busy = true;
    sweep()
      .then((r) => {
        const did = r.opened_auto + r.closed.length + r.reminded.length + r.escalated.length + r.failed.length;
        if (did) console.log(`[decision-watch] ${r.looked_at} looked at: ${r.opened_auto} opened (CAPITAL), ${r.closed.length} closed, ${r.reminded.length} reminded, ${r.escalated.length} escalated, ${r.failed.length} failed, ${r.unread.length} unread`);
      })
      .catch((e) => console.error(`[decision-watch] sweep failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.tick_seconds * 1000);
  timer.unref();
}
