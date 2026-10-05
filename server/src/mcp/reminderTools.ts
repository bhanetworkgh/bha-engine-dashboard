/**
 * Scheduled reminder posts, as Bays (2026-10-05, Destiny).
 *
 * "Bays, post a reminder in #bha-coordination on 15 October asking Hardik where
 * the accounts stand." Three write tools, in Bays' scope:
 *
 *   `schedule_reminder` — Slack's own `chat.scheduleMessage`, as the Bays bot.
 *                         **Slack holds the message and posts it**, so it goes
 *                         out whether or not this engine is up on the day.
 *   `list_reminders`    — what is waiting, and what has gone.
 *   `cancel_reminder`   — `chat.deleteScheduledMessage`, by the person who
 *                         asked for it, or by Destiny or Jason.
 *
 * **The confirmation is held here, not in a prompt.** Without `confirmed: true`
 * the tool schedules nothing and answers the exact text, place and time it
 * would use, for Bays to show the person. A model that skips the question
 * cannot skip this.
 *
 * Every reminder is a row in `engine_scheduled_posts` (migration 59), and every
 * call is on `engine_mcp_writes` like the other Slack writes. **What the row
 * cannot say**: that the post landed. Slack sends it and tells nobody, and the
 * Bays bot has no scope to read a channel back, so a reminder whose time has
 * passed is "handed to Slack", and the page and the tool say exactly that.
 * The text is fixed when it is scheduled; nothing rewrites it on the day.
 */
import { query } from '../pg';
import * as slack from '../slack';
import { audited } from './slackTools';
import type { ToolDefinition } from './tools';

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Destiny and Jason, who may cancel anybody's reminder. The same two the loop guards name. */
const ADMINS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
/** Slack refuses a post less than a moment away and one more than 120 days out. */
const MIN_LEAD_MS = 2 * 60_000;
const MAX_LEAD_MS = 120 * 86_400_000;
const MAX_TEXT = 3500;
const CHANNEL_RE = /^[CG][A-Z0-9]{6,}$/;
const USER_RE = /^[UW][A-Z0-9]{6,}$/;
const TS_RE = /^\d{9,11}\.\d{1,6}$/;

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const bare = (v: string) => v.replace(/^<[@#]?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

/** "Thu 15 Oct 2026, 10:00 Lagos time (09:00 UTC)" — the time as the team reads it, beside the one stored. */
export function sayWhen(at: Date): string {
  const lagos = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const utc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return `${lagos} Lagos time (${utc} UTC)`;
}

/**
 * The time must say its own zone. "2026-10-15T10:00" would be read as UTC here
 * and as Lagos by the person who typed it, an hour apart, so it is refused.
 */
export function parseWhen(raw: string, now = Date.now()): { ok: true; at: Date } | { ok: false; reason: string; message: string } {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    return { ok: false, reason: 'time_needs_a_zone', message: `"${raw}" does not say its time zone. Send ISO 8601 with an offset, e.g. 2026-10-15T10:00:00+01:00 for 10:00 Lagos time.` };
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { ok: false, reason: 'bad_time', message: `"${raw}" is not a date and time. Send ISO 8601 with an offset, e.g. 2026-10-15T10:00:00+01:00.` };
  if (t - now < MIN_LEAD_MS) return { ok: false, reason: 'time_in_the_past', message: `${sayWhen(new Date(t))} is not at least two minutes from now, so there is nothing to schedule.` };
  if (t - now > MAX_LEAD_MS) return { ok: false, reason: 'too_far_ahead', message: `${sayWhen(new Date(t))} is more than 120 days away, which is as far ahead as Slack will hold a message.` };
  return { ok: true, at: new Date(t) };
}

const newId = (now = Date.now()) => `REM-${now}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;

interface Row {
  reminder_id: string;
  channel_id: string;
  thread_ts: string | null;
  text: string;
  post_at: string;
  slack_scheduled_id: string | null;
  status: string;
  requested_by: string | null;
  agent: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
}
const COLS = `reminder_id, channel_id, thread_ts, text, slack_scheduled_id, status, requested_by, agent, cancelled_by,
  to_char(post_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS post_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cancelled_at`;

/** What a row is now, in words. A time that has passed is "handed to Slack", never "posted". */
export function stateOf(r: { status: string; post_at: string }, now = Date.now()): 'waiting' | 'handed_to_slack' | 'cancelled' {
  if (r.status === 'cancelled') return 'cancelled';
  return Date.parse(r.post_at) > now ? 'waiting' : 'handed_to_slack';
}

function show(r: Row) {
  return {
    reminder_id: r.reminder_id,
    state: stateOf(r),
    channel_id: r.channel_id,
    thread_ts: r.thread_ts,
    post_at: r.post_at,
    when: sayWhen(new Date(r.post_at)),
    text: r.text,
    requested_by: r.requested_by,
    scheduled_through: r.agent ?? 'the shared connector',
    created_at: r.created_at,
    cancelled_at: r.cancelled_at,
    cancelled_by: r.cancelled_by,
  };
}

/** The page's read: every reminder, soonest waiting first, then what has gone, newest first. */
export async function reminders(limit = 200) {
  const r = await query<Row>(`SELECT ${COLS} FROM engine_scheduled_posts ORDER BY post_at DESC LIMIT $1`, [limit]);
  const rows = r.rows.map(show);
  const waiting = rows.filter((x) => x.state === 'waiting').sort((a, b) => a.post_at.localeCompare(b.post_at));
  return {
    reminders: [...waiting, ...rows.filter((x) => x.state !== 'waiting')],
    waiting: waiting.length,
    note: 'Slack holds each message and posts it as Bays. A reminder whose time has passed was handed to Slack; this dashboard cannot read the channel back to confirm the post.',
  };
}

export const scheduleReminder: ToolDefinition = {
  name: 'schedule_reminder',
  description:
    'Schedule one message to be posted later, as Bays, in a channel or a thread. Use it when a person asks Bays to post a reminder or a check-in on a date. Slack holds the message and posts it at post_at; the text is fixed now and is not rewritten on the day. CALL IT TWICE: first without "confirmed" — nothing is scheduled and the answer is the exact text, place and time, which you show the person word for word and ask them to confirm; then, only after they say yes, again with the same arguments and confirmed: true. post_at is ISO 8601 WITH an offset (10:00 Lagos time is 2026-10-15T10:00:00+01:00); a time with no zone is refused. At least 2 minutes and at most 120 days ahead. Bays must already be in the channel (Slack answers not_in_channel otherwise). Returns {ok, reminder_id, when}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'The channel to post in: C… or G…. Not a user id; a DM reminder is send_nudge\'s job.' },
      text: { type: 'string', description: 'The message, exactly as it should be posted. Slack mrkdwn; mention people as <@U…>.' },
      post_at: { type: 'string', description: 'When to post, ISO 8601 with an offset, e.g. 2026-10-15T10:00:00+01:00.' },
      thread_ts: { type: 'string', description: 'Optional. The thread to post into (the parent message\'s ts, e.g. 1791163483.127439).' },
      confirmed: { type: 'boolean', description: 'true only after the person has seen the preview and said yes. Without it nothing is scheduled.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required; it is who may cancel the reminder later.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would be scheduled, without calling Slack.' },
    },
    required: ['channel_id', 'text', 'post_at', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Schedule a reminder post as Bays' },
  handler: (args, deps) =>
    audited('schedule_reminder', args, deps, async () => {
      const channel = bare(str(args, 'channel_id'));
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      const thread = str(args, 'thread_ts') || null;
      const requester = bare(str(args, 'requester_user_id'));
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: channel || null, answer: { ok: false, reason, message: `${message} Nothing was scheduled.` } });

      if (!CHANNEL_RE.test(channel)) return refuse('not_a_slack_channel_id', `"${channel}" is not a Slack channel id (C… or G…).`);
      if (!text) return refuse('bad_argument', 'No message text was supplied.');
      if (text.length > MAX_TEXT) return refuse('text_too_long', `The message is ${text.length} characters; the limit is ${MAX_TEXT}.`);
      if (thread && !TS_RE.test(thread)) return refuse('bad_thread_ts', `"${thread}" is not a Slack message ts (e.g. 1791163483.127439).`);
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const when = parseWhen(str(args, 'post_at'));
      if (!when.ok) return refuse(when.reason, when.message);

      const plan = { channel_id: channel, thread_ts: thread, post_at: when.at.toISOString(), when: sayWhen(when.at), text, posts_as: 'Bays', requested_by: requester };
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: channel, answer: { ok: true, dry_run: true, would_schedule: plan, slack_configured: slack.slackConfigured() } };
      if (args.confirmed !== true) {
        return {
          outcome: 'preview',
          detail: 'not confirmed',
          target: channel,
          answer: {
            ok: false,
            reason: 'needs_confirmation',
            preview: plan,
            message: `Nothing is scheduled yet. Show the person this exact text, the place and "${plan.when}", and ask them to confirm. Only after they say yes, call schedule_reminder again with the same arguments and confirmed: true.`,
          },
        };
      }
      if (!slack.slackConfigured()) return { outcome: 'refused', detail: 'not configured', target: channel, answer: { ok: false, reason: 'not_configured', message: `${slack.SLACK_TOKEN_VAR} is not set on this server, so nothing can be scheduled in Slack.` } };

      const s = await slack.botCall('chat.scheduleMessage', { channel, text, post_at: Math.floor(when.at.getTime() / 1000), thread_ts: thread ?? undefined, unfurl_links: false });
      const scheduledId = typeof s.scheduled_message_id === 'string' ? s.scheduled_message_id : '';
      if (!s.ok || !scheduledId) {
        const error = s.error || 'no scheduled_message_id in the answer';
        const hint = error === 'not_in_channel' ? ' Bays is not a member of that channel; somebody has to add Bays to it first.' : '';
        return { outcome: 'failed', detail: `chat.scheduleMessage: ${error}`, target: channel, answer: { ok: false, step: 'chat.scheduleMessage', error, message: `Slack refused to schedule it: ${error}.${hint} Nothing was scheduled.` } };
      }

      const id = newId();
      try {
        await query(
          `INSERT INTO engine_scheduled_posts (reminder_id, channel_id, thread_ts, text, post_at, slack_scheduled_id, status, requested_by, agent)
           VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8)`,
          [id, channel, thread, text, when.at.toISOString(), scheduledId, requester, deps.agent ?? null],
        );
      } catch (e) {
        // Slack holds a message this dashboard could not record. Take it back
        // rather than leave a post nobody can list or cancel.
        const undo = await slack.botCall('chat.deleteScheduledMessage', { channel, scheduled_message_id: scheduledId });
        const why = e instanceof Error ? e.message : String(e);
        return {
          outcome: 'failed',
          detail: `record: ${why}; slack undo ${undo.ok ? 'ok' : undo.error}`,
          target: channel,
          answer: {
            ok: false,
            step: 'record',
            error: why,
            raise: !undo.ok,
            message: undo.ok
              ? 'The reminder could not be recorded on the dashboard, so it was taken back out of Slack. Nothing is scheduled.'
              : `The reminder could not be recorded on the dashboard AND could not be taken back out of Slack (${undo.error}). Slack will still post it at ${plan.when}; tell Destiny. Slack id ${scheduledId}.`,
          },
        };
      }
      return {
        outcome: 'applied',
        detail: `${id} → ${channel}${thread ? ` thread ${thread}` : ''} at ${plan.post_at} (slack ${scheduledId})`,
        target: id,
        answer: { ok: true, reminder_id: id, ...plan, message: `Scheduled. Slack will post it as Bays on ${plan.when}. To cancel: cancel_reminder with reminder_id ${id}.` },
      };
    }),
};

export const listReminders: ToolDefinition = {
  name: 'list_reminders',
  description:
    'List the reminder posts scheduled through schedule_reminder: waiting ones first (soonest first), then cancelled ones and ones whose time has passed. state is waiting, cancelled or handed_to_slack — the last means the time has passed and Slack was holding it; this server cannot read the channel to confirm the post, so say "should have posted", not "posted". Set waiting_only to see just what is still to go out.',
  inputSchema: {
    type: 'object',
    properties: {
      waiting_only: { type: 'boolean', description: 'Only reminders still waiting to go out.' },
      requester_user_id: { type: 'string', description: 'Optional. Only reminders this person asked for.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'List scheduled reminder posts' },
  handler: async (args) => {
    const all = await reminders();
    const who = bare(str(args, 'requester_user_id'));
    let rows = all.reminders;
    if (args.waiting_only === true) rows = rows.filter((r) => r.state === 'waiting');
    if (who) rows = rows.filter((r) => r.requested_by === who);
    return { ok: true, count: rows.length, waiting: rows.filter((r) => r.state === 'waiting').length, reminders: rows.slice(0, 50), truncated: rows.length > 50, note: all.note };
  },
};

export const cancelReminder: ToolDefinition = {
  name: 'cancel_reminder',
  description:
    'Cancel a reminder that is still waiting, by its reminder_id (REM-…, from schedule_reminder or list_reminders). Only the person who asked for it, Destiny or Jason may cancel it. Slack cannot cancel a message within about a minute of its time, or one already posted; that comes back as ok:false with Slack\'s reason. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string', description: 'REM-…' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would be cancelled, without calling Slack.' },
    },
    required: ['reminder_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Cancel a scheduled reminder post' },
  handler: (args, deps) =>
    audited('cancel_reminder', args, deps, async () => {
      const id = str(args, 'reminder_id');
      const requester = bare(str(args, 'requester_user_id'));
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: id || null, answer: { ok: false, reason, message: `${message} Nothing was changed.` } });
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const found = await query<Row>(`SELECT ${COLS} FROM engine_scheduled_posts WHERE reminder_id = $1`, [id]);
      const row = found.rows[0];
      if (!row) return refuse('not_found', `No reminder has the id "${id}". Use list_reminders to find it.`);
      const state = stateOf(row);
      if (state === 'cancelled') return refuse('already_cancelled', `${id} was already cancelled.`);
      if (state === 'handed_to_slack') return refuse('already_due', `${id} was due on ${sayWhen(new Date(row.post_at))}; Slack has already been asked to post it.`);
      if (row.requested_by !== requester && !ADMINS.has(requester)) return refuse('not_permitted', `${id} was scheduled by <@${row.requested_by}>; only they, Destiny or Jason can cancel it.`);
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would_cancel: show(row) } };

      const d = await slack.botCall('chat.deleteScheduledMessage', { channel: row.channel_id, scheduled_message_id: row.slack_scheduled_id ?? '' });
      if (!d.ok) {
        return { outcome: 'failed', detail: `chat.deleteScheduledMessage: ${d.error}`, target: id, answer: { ok: false, step: 'chat.deleteScheduledMessage', error: d.error, message: `Slack would not cancel it: ${d.error}. The reminder is unchanged and will still post on ${sayWhen(new Date(row.post_at))}.` } };
      }
      await query(`UPDATE engine_scheduled_posts SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE reminder_id = $1`, [id, requester]);
      return { outcome: 'applied', detail: `${id} cancelled by ${requester}${deps.agent ? ` through ${deps.agent}` : ''}`, target: id, answer: { ok: true, reminder_id: id, cancelled: true, message: `${id} is cancelled. Slack will not post it.` } };
    }),
};

export const REMINDER_WRITE_TOOLS: ToolDefinition[] = [scheduleReminder, listReminders, cancelReminder];
