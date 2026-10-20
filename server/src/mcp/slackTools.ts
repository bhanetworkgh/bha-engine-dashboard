/**
 * Slack writes for the Bays agent (2026-09-24, Destiny): the last two things it
 * did through the retired `Bays — Tools Router` (`WjWzhVRq566A60fJ`), ported
 * from that workflow's Code and HTTP nodes rather than rewritten.
 *
 *   `send_nudge` — one DM per person named, the fan-out done **here, in code**
 *                  (`SNG - Build Recipients` / `SNG - Send DM` /
 *                  `SNG - Format Result`). A nudge "to Jegan, cc Kavin" once
 *                  went out as one Slack call; a DM has exactly one recipient,
 *                  so the cc got nothing and nobody knew (16 Sep). Anything
 *                  that is not a Slack user id is reported back by name,
 *                  never dropped.
 *   `post_file`  — Markdown uploaded as a `.md` file into any channel or DM
 *                  (the `PRF -` branch): files.getUploadURLExternal, the bytes,
 *                  files.completeUploadExternal, with conversations.open first
 *                  when the target is a user id.
 *
 * Both as the Bays bot, `SLACK_BAYS_BOT_TOKEN`. Both are write tools: only on
 * the write connection, every call — refused and dry-run ones included — on
 * `engine_mcp_writes`, opened before the first Slack call and closed after the
 * last, like the record and Drive tools.
 */
import * as slack from '../slack';
import { query } from '../pg';
import * as approvals from '../approvals';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DRY = { dry_run: { type: 'boolean', description: 'Check the call and say what would be sent, without calling Slack.' } };
const REQUESTER = { requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' } };

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function notConfigured(): Record<string, unknown> {
  return { ok: false, reason: 'not_configured', message: `${slack.SLACK_TOKEN_VAR} is not set on this server, so nothing can be sent to Slack.` };
}

export async function audited(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  run: () => Promise<{ outcome: string; detail: string | null; answer: Record<string, unknown>; target?: string | null }>,
): Promise<Record<string, unknown>> {
  const dry = args.dry_run === true;
  const requester = str(args, 'requester_user_id') || null;
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'slack', requester, dry_run: dry });
  try {
    const r = await run();
    await auditClose(audit, { outcome: r.outcome, detail: r.detail, natural_id: r.target ?? null, after: r.answer });
    return { ...r.answer, audit_id: audit };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, reason: 'error', message, audit_id: audit };
  }
}

/**
 * The destination guard (2026-10-10, agent maturity re-score: outbound Slack
 * had no guard at all). A DM to a person with a Builder Profile, or to one of
 * the two approvers, goes straight out: that is every nudge Bays sends day to
 * day. A DM to anyone else is held for a person, on an agent token only, on
 * the card share_doc uses. Decided here, in code, never by the prompt.
 */
export async function unknownRecipients(ids: string[]): Promise<string[]> {
  const want = [...new Set(ids)].filter((u) => !approvals.APPROVERS.includes(u));
  if (!want.length) return [];
  const r = await query<{ natural_id: string }>(`SELECT natural_id FROM engine_builder_profiles WHERE natural_id = ANY($1)`, [want]);
  const known = new Set(r.rows.map((x) => x.natural_id));
  return want.filter((u) => !known.has(u));
}

/* ------------------------------------------------------------- send_nudge */

export type Recipients = { valid: string[]; invalid: string[]; total: number };

/**
 * `SNG - Build Recipients`, as written. An array, a JSON-encoded array, or a
 * string split on whitespace, commas and semicolons; each token's first
 * `U…`/`W…` id is taken (so `<@U0AEW3TBYH1>` and `U0AEW3TBYH1` are the same
 * person, sent once), and a token carrying none is kept, by name, as invalid.
 */
export function parseRecipients(raw: unknown): Recipients {
  let r = raw;
  if (typeof r === 'string') {
    try {
      const p = JSON.parse(r);
      if (Array.isArray(p)) r = p;
    } catch {
      /* a plain string */
    }
  }
  const tokens = (Array.isArray(r) ? r : String(r ?? '').split(/[\s,;]+/)).map((x) => String(x ?? '').trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const tok of tokens) {
    const m = tok.match(/\b([UW][A-Z0-9]{6,})\b/);
    if (m) {
      if (!valid.includes(m[1])) valid.push(m[1]);
    } else invalid.push(tok);
  }
  return { valid, invalid, total: tokens.length };
}

/** The link is appended after a blank line, and only where the text does not already carry it. */
export function nudgeText(text: string, link: string): string {
  const body = text.trim();
  const l = link.trim();
  return body && l && !body.includes(l) ? `${body}\n\n${l}` : body;
}

type NudgeLine = { recipient: string; user_id: string; role?: 'recipient' | 'cc'; ok: boolean; ts: string; channel: string; error: string };

/** `SNG - Format Result`: one line per recipient, sent first-named first, the invalid ones after. */
function summarise(results: NudgeLine[]): string {
  const sent = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (sent.length) parts.push(`Sent to ${sent.map((r) => `${r.recipient}${r.role === 'cc' ? ' (copy)' : ''} (ts ${r.ts})`).join(', ')}.`);
  if (failed.length) parts.push(`Couldn't send to ${failed.map((r) => `${r.recipient}: ${r.error}`).join('; ')}.`);
  return parts.join(' ');
}

export const sendNudge: ToolDefinition = {
  name: 'send_nudge',
  description:
    'DM each person being nudged, one Slack DM each, and send a marked copy to everyone cc\'d. recipients: only the people the message is written to (U…/W… ids or <@U…> mentions, an array or one string separated by spaces or commas). cc: people who should see it but are not being asked anything (e.g. "cc Jason"); each gets the same text under a line saying who it was sent to, so a message written to Hardik never lands in Jason\'s DM looking like it was meant for him. Pass requester_user_id: if the person asking is also in recipients beside others, they are moved to cc and the answer says so (moved_to_cc). Anything that is not a Slack user id comes back as not_a_slack_user_id, never dropped. thread_link is appended to the text unless already in it. Returns {ok (every DM sent), sent_count, failed_count, results: [{recipient, user_id, role, ok, ts, error}], summary}; when any DM fails, reason is slack_refused and message carries Slack\'s own error for each. Empty text or no valid recipient: ok:false and nothing is sent. A DM to someone with no Builder Profile is not sent on an agent token: a person is asked in Slack first and the answer is ok:false, reason awaiting_approval (say so, do not retry). As the Bays bot; audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      recipients: {
        description: 'Slack user ids or <@U…> mentions — an array, or one string separated by spaces, commas or semicolons.',
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
      },
      text: { type: 'string', description: 'The message. Slack mrkdwn.' },
      thread_link: { type: 'string', description: 'Optional permalink to the thread this is about; appended after a blank line unless the text already has it.' },
      cc: {
        description: 'People to copy, not ask: Slack user ids or <@U…> mentions, an array or one string. Each gets the text under "Copy for you: Bays sent this to …".',
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
      },
      ...DRY,
      ...REQUESTER,
    },
    required: ['recipients', 'text'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'DM each person named, one message each' },
  handler: (args, deps) =>
    audited('send_nudge', args, deps, async () => {
      const parsed = parseRecipients(args.recipients);
      const ccParsed = args.cc === undefined || args.cc === null || args.cc === '' ? { valid: [] as string[], invalid: [] as string[], total: 0 } : parseRecipients(args.cc);
      const requester = str(args, 'requester_user_id').toUpperCase();
      // 18 Oct 2026 (DW-1792267745984-UBCR): "cc Jason" used to mean Jason in recipients, so he
      // got a DM written to Hardik. The person asking is never a recipient beside others: they
      // are copied, and the answer says so.
      const movedToCc = requester && parsed.valid.includes(requester) && parsed.valid.length > 1 ? [requester] : [];
      const valid = parsed.valid.filter((u) => !movedToCc.includes(u));
      const ccIds = [...new Set([...ccParsed.valid, ...movedToCc])].filter((u) => !valid.includes(u));
      const invalid = [...parsed.invalid, ...ccParsed.invalid];
      const total = parsed.total + ccParsed.total;
      const body = typeof args.text === 'string' ? args.text.trim() : '';
      const text = nudgeText(body, str(args, 'thread_link'));
      const ccText = `_Copy for you: Bays sent this to ${valid.map((u) => `<@${u}>`).join(', ')}._\n\n${text}`;
      const invalidLines: NudgeLine[] = invalid.map((x) => ({ recipient: x, user_id: '', ok: false, ts: '', channel: '', error: 'not_a_slack_user_id' }));

      if (!body || !valid.length) {
        const summary = !body
          ? 'No message text was supplied, so nothing was sent.'
          : 'None of the recipients was a Slack user ID, so nothing was sent. Look each person up and pass their user ID.';
        return {
          outcome: 'refused',
          detail: !body ? 'no_message_text' : `no_valid_recipients (${invalid.length} invalid of ${total})`,
          answer: { ok: false, reason: !body ? 'no_message_text' : 'no_valid_recipients', sent_count: 0, failed_count: invalidLines.length, results: invalidLines, summary },
        };
      }
      const unknown = await unknownRecipients([...valid, ...ccIds]);
      if (args.dry_run === true) {
        return {
          outcome: 'dry_run',
          detail: `${valid.length} valid, ${invalid.length} invalid`,
          target: valid.join(','),
          answer: {
            ok: invalid.length === 0,
            dry_run: true,
            would_send_to: valid,
            would_copy: ccIds,
            moved_to_cc: movedToCc,
            not_in_builder_profiles: unknown,
            would_wait_for_approval: unknown.length > 0 && approvals.needsApproval(),
            not_a_slack_user_id: invalid,
            text,
            slack_configured: slack.slackConfigured(),
            summary: `Would send ${valid.length} DM${valid.length === 1 ? '' : 's'}${ccIds.length ? ` and ${ccIds.length} marked cop${ccIds.length === 1 ? 'y' : 'ies'}` : ''}${invalid.length ? `; ${invalid.length} recipient${invalid.length === 1 ? ' is' : 's are'} not a Slack user id` : ''}.`,
          },
        };
      }
      if (!slack.slackConfigured()) return { outcome: 'refused', detail: 'not configured', target: valid.join(','), answer: notConfigured() };
      if (unknown.length && approvals.needsApproval()) {
        const asked = approvals.pendingAnswer(
          await approvals.request({
            tool: 'send_nudge',
            args: { ...args, destination: [...valid, ...ccIds].join(',') },
            target: [...valid, ...ccIds].join(','),
            summary: `send a DM as Bays to ${unknown.map((u) => `<@${u}>`).join(', ')}, who ${unknown.length === 1 ? 'has' : 'have'} no Builder Profile${valid.length > unknown.length ? ` (and to ${valid.length - unknown.length} known team member${valid.length - unknown.length === 1 ? '' : 's'})` : ''}. Message: "${text.slice(0, 400)}"`,
          }),
        );
        return { ...asked, target: valid.join(',') };
      }

      // One post per recipient, in order. A refusal for one never stops the rest.
      const results: NudgeLine[] = [];
      const sends: Array<[string, 'recipient' | 'cc']> = [...valid.map((u) => [u, 'recipient'] as [string, 'recipient']), ...ccIds.map((u) => [u, 'cc'] as [string, 'cc'])];
      for (const [u, role] of sends) {
        const r = await slack.botCall('chat.postMessage', { channel: u, text: role === 'cc' ? ccText : text, unfurl_links: false });
        results.push({
          recipient: `<@${u}>`,
          user_id: u,
          role,
          ok: r.ok,
          ts: r.ok ? String(r.ts ?? '') : '',
          channel: r.ok ? String(r.channel ?? '') : '',
          error: r.ok ? '' : String(r.error || 'no confirmation from Slack'),
        });
      }
      results.push(...invalidLines);
      const sent = results.filter((r) => r.ok).length;
      const failed = results.length - sent;
      return {
        outcome: sent ? 'applied' : 'failed',
        detail: `${sent} sent, ${failed} failed${failed ? `: ${results.filter((r) => !r.ok).map((r) => `${r.user_id || r.recipient} ${r.error}`).join('; ')}` : ''}`,
        target: valid.join(','),
        answer: {
          ok: failed === 0,
          ...(failed ? { reason: 'slack_refused', message: summarise(results) } : {}),
          sent_count: sent,
          failed_count: failed,
          ...(movedToCc.length ? { moved_to_cc: movedToCc, note: `${movedToCc.map((u) => `<@${u}>`).join(', ')} asked for this nudge, so they got a marked copy rather than a DM written to someone else.` } : {}),
          results,
          summary: summarise(results),
        },
      };
    }),
};

/* -------------------------------------------------------------- post_file */

/** A channel (C…), a DM (D…), a private channel or group DM (G…), or a user (U…/W…), whose DM is opened first. */
const CHANNEL_RE = /^[CDGUW][A-Z0-9]{6,}$/;

export const postFile: ToolDefinition = {
  name: 'post_file',
  description:
    'Upload Markdown as a .md file into any channel or DM, as the Bays bot. channel_id: a channel (C…), a DM (D…), a private channel (G…), or a user id (U…) — a user id has its DM opened first (conversations.open). The file is <title>.md. Steps: files.getUploadURLExternal → upload the bytes → files.completeUploadExternal with initial_comment and thread_ts. Returns {ok, file_id, channel_id, permalink}, or ok:false naming the step that failed and Slack\'s own error. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'C…, D…, G…, or a U… user id (its DM is opened).' },
      title: { type: 'string', description: 'The file title; the filename is <title>.md.' },
      content: { type: 'string', description: 'The Markdown to upload.' },
      initial_comment: { type: 'string', description: 'Optional message posted with the file.' },
      thread_ts: { type: 'string', description: 'Optional thread to post the file into.' },
      ...DRY,
      ...REQUESTER,
    },
    required: ['channel_id', 'title', 'content'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Post a Markdown file to a channel or DM' },
  handler: (args, deps) =>
    audited('post_file', args, deps, async () => {
      const target = str(args, 'channel_id').replace(/^<[@#]?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');
      const title = str(args, 'title');
      const content = typeof args.content === 'string' ? args.content : '';
      const initialComment = str(args, 'initial_comment') || undefined;
      const threadTs = str(args, 'thread_ts') || undefined;
      const bytes = Buffer.from(content, 'utf8');
      const filename = `${title}.md`;
      const isUser = /^[UW]/.test(target);

      if (!target || !title || !content.trim()) {
        return { outcome: 'refused', detail: 'missing channel_id, title or content', answer: { ok: false, reason: 'bad_argument', message: '"channel_id", "title" and a non-empty "content" are all required. Nothing was uploaded.' } };
      }
      if (!CHANNEL_RE.test(target)) {
        return { outcome: 'refused', detail: `bad channel_id ${target}`, target, answer: { ok: false, reason: 'not_a_slack_channel_id', message: `"${target}" is not a Slack channel (C…, D…, G…) or user (U…) id. Nothing was uploaded.` } };
      }
      if (args.dry_run === true) {
        return {
          outcome: 'dry_run',
          detail: null,
          target,
          answer: { ok: true, dry_run: true, would: { channel_id: target, opens_dm_first: isUser, filename, length: bytes.length, initial_comment: initialComment ?? null, thread_ts: threadTs ?? null }, slack_configured: slack.slackConfigured() },
        };
      }
      if (!slack.slackConfigured()) return { outcome: 'refused', detail: 'not configured', target, answer: notConfigured() };
      if (isUser && approvals.needsApproval() && (await unknownRecipients([target])).length) {
        const asked = approvals.pendingAnswer(
          await approvals.request({
            tool: 'post_file',
            args: { ...args, destination: target },
            target,
            summary: `send the file "${filename}" (${bytes.length} bytes) as Bays in a DM to <@${target}>, who has no Builder Profile`,
          }),
        );
        return { ...asked, target };
      }

      const fail = (step: string, error: string, extra: Record<string, unknown> = {}) => ({
        outcome: 'failed',
        detail: `${step}: ${error}`,
        target,
        answer: { ok: false, step, error, message: `Slack refused at ${step}: ${error}. ${extra.file_id ? 'The bytes were uploaded but the file was not shared.' : 'Nothing was posted.'}`, ...extra },
      });

      // A user id → its DM channel. Done before the upload (the n8n branch did it
      // after), so a user the bot cannot DM leaves no orphaned upload behind.
      let channelId = target;
      if (isUser) {
        const o = await slack.botCall('conversations.open', { users: target }, 'form');
        const ch = (o.channel as { id?: string } | undefined)?.id;
        if (!o.ok || !ch) return fail('conversations.open', o.error || 'no channel id in the answer', { user_id: target });
        channelId = ch;
      }

      const g = await slack.botCall('files.getUploadURLExternal', { filename, length: bytes.length }, 'form');
      const uploadUrl = typeof g.upload_url === 'string' ? g.upload_url : '';
      const fileId = typeof g.file_id === 'string' ? g.file_id : '';
      if (!g.ok || !uploadUrl || !fileId) return fail('files.getUploadURLExternal', g.error || 'no upload_url or file_id in the answer', { channel_id: channelId });

      const up = await slack.uploadBytes(uploadUrl, bytes, 'text/markdown');
      if (!up.ok) return fail('upload', up.error || `http_${up.status}`, { channel_id: channelId, file_id: fileId });

      const c = await slack.botCall('files.completeUploadExternal', {
        files: [{ id: fileId, title }],
        channel_id: channelId,
        initial_comment: initialComment,
        thread_ts: threadTs,
      });
      if (!c.ok) return fail('files.completeUploadExternal', c.error || 'no confirmation from Slack', { channel_id: channelId, file_id: fileId });

      // completeUploadExternal answers {id, title} per file. The permalink is
      // on files.info; a failure there does not undo a file that was posted.
      const done = Array.isArray(c.files) ? (c.files[0] as { permalink?: string } | undefined) : undefined;
      let permalink: string | null = done?.permalink ?? null;
      let permalinkError: string | undefined;
      if (!permalink) {
        const info = await slack.botCall('files.info', { file: fileId }, 'form');
        permalink = info.ok ? ((info.file as { permalink?: string } | undefined)?.permalink ?? null) : null;
        if (!permalink) permalinkError = info.error || 'files.info carried no permalink';
      }
      return {
        outcome: 'applied',
        detail: `${filename} (${bytes.length} bytes) → ${channelId}${isUser ? ` (DM with ${target})` : ''} as ${fileId}`,
        target: channelId,
        answer: { ok: true, file_id: fileId, channel_id: channelId, permalink, ...(permalinkError ? { permalink_error: permalinkError } : {}), ...(isUser ? { user_id: target } : {}), filename, length: bytes.length },
      };
    }),
};

/* ------------------------------------------------- post_channel_message */

/**
 * The channel-post guard (2026-10-11, Destiny — agent maturity). n8n's
 * `Bays — Slack Send` is the tool Bays posts digests and messages with, and it
 * posted wherever the agent named. It now asks here first.
 *
 * A destination is known when it is: a channel in channel_tracking (every
 * channel Bays captures), one of the engine's own channels below, a channel a
 * person has already approved a post into, a person with a Builder Profile or
 * an approver, or a DM (D…) Slack says is with such a person. Anything else is
 * held on the Approve / Deny card and posted by `post_channel_message` only
 * once Destiny or Jason approves. A DM Slack cannot tell us about is held:
 * unknown is never read as known.
 */
export const ENGINE_CHANNELS: ReadonlyArray<string> = ['C0C534NQ0HG', 'C0BDD5TSDQV', 'C0ASVQQ8CH3', 'C0B0668PRNW', 'C0B9LKU7DQV'];
const DEST_RE = /^[CDGUW][A-Z0-9]{6,}$/;

export type DestinationVerdict = { known: boolean; kind: 'channel' | 'user' | 'dm'; why: string };

/**
 * The person a DM channel is with, from the DMs Bays has already sent there by user id:
 * send_nudge stores each recipient's user id beside the D… channel Slack answered with.
 * Only a post Slack confirmed counts. Null when Bays has never DM'd anyone there.
 */
export async function dmPersonFromHistory(dmChannel: string): Promise<string | null> {
  if (!/^D[A-Z0-9]{6,}$/.test(dmChannel)) return null;
  const r = await query<{ user_id: string }>(
    `SELECT x->>'user_id' AS user_id
       FROM engine_mcp_writes w, jsonb_array_elements(CASE WHEN jsonb_typeof(w.after->'results') = 'array' THEN w.after->'results' ELSE '[]'::jsonb END) x
      WHERE w.tool = 'send_nudge' AND w.outcome = 'applied' AND x->>'channel' = $1 AND x->>'ok' = 'true' AND coalesce(x->>'user_id', '') ~ '^[UW][A-Z0-9]+$'
      ORDER BY w.id DESC LIMIT 1`,
    [dmChannel],
  ).catch(() => ({ rows: [] as Array<{ user_id: string }> }));
  return r.rows[0]?.user_id ?? null;
}

export async function destinationVerdict(dest: string): Promise<DestinationVerdict> {
  if (/^[UW]/.test(dest)) {
    const unknown = await unknownRecipients([dest]);
    return { known: unknown.length === 0, kind: 'user', why: unknown.length ? 'this person has no Builder Profile and is not an approver' : 'a person with a Builder Profile, or an approver' };
  }
  if (dest.startsWith('D')) {
    const info = await slack.botCall('conversations.info', { channel: dest }, 'form');
    const user = (info.channel as { user?: string } | undefined)?.user;
    if (!info.ok || typeof user !== 'string') {
      // 14 Oct 2026: Bays' token cannot read DM details (missing_scope), so a post into
      // Jegan's DM by its D… id was held for approval although Bays had DM'd him there by
      // user id that day. The DM's person is read back from Bays' own successful DMs.
      const earlier = await dmPersonFromHistory(dest);
      if (earlier) {
        const unknownEarlier = await unknownRecipients([earlier]);
        return {
          known: unknownEarlier.length === 0,
          kind: 'dm',
          why: unknownEarlier.length
            ? `a DM with ${earlier} (from Bays' earlier DMs there), who has no Builder Profile and is not an approver`
            : `a DM with ${earlier} (from Bays' earlier DMs there; Slack itself could not say: ${String(info.error ?? 'no user in the answer')}), who has a Builder Profile or is an approver`,
        };
      }
      return { known: false, kind: 'dm', why: `Slack could not say who this DM is with (${String(info.error ?? 'no user in the answer')}), and Bays has never DM'd anyone there by user id` };
    }
    const unknown = await unknownRecipients([user]);
    return { known: unknown.length === 0, kind: 'dm', why: unknown.length ? `a DM with ${user}, who has no Builder Profile and is not an approver` : `a DM with ${user}, who has a Builder Profile or is an approver` };
  }
  const extra = (process.env.SLACK_KNOWN_CHANNELS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const alerts = process.env.QUOTA_ALERT_CHANNEL?.trim();
  if (ENGINE_CHANNELS.includes(dest) || extra.includes(dest) || dest === alerts) return { known: true, kind: 'channel', why: 'one of the engine\'s own channels' };
  const tracked = await query(`SELECT 1 FROM engine_channel_tracking WHERE natural_id = $1 LIMIT 1`, [dest]);
  if (tracked.rows.length) return { known: true, kind: 'channel', why: 'a channel Bays captures (channel_tracking)' };
  const approved = await query(`SELECT 1 FROM engine_approvals WHERE tool = 'post_channel_message' AND status = 'approved' AND result_ok IS TRUE AND target = $1 LIMIT 1`, [dest]);
  if (approved.rows.length) return { known: true, kind: 'channel', why: 'a channel a person has already approved a post into' };
  return { known: false, kind: 'channel', why: 'a channel the engine does not capture and has never been approved to post into' };
}

type Part = unknown[];
function partsOf(args: Record<string, unknown>): Part[] {
  const raw = Array.isArray(args.parts) ? args.parts : [];
  return raw.filter((p): p is Part => Array.isArray(p) && p.length > 0).slice(0, 40);
}

async function postParts(dest: string, text: string, parts: Part[], threadTs: string | undefined) {
  let channel = dest;
  if (/^[UW]/.test(dest)) {
    const o = await slack.botCall('conversations.open', { users: dest }, 'form');
    const ch = (o.channel as { id?: string } | undefined)?.id;
    if (!o.ok || !ch) return { ok: false as const, step: 'conversations.open', error: String(o.error ?? 'no channel id in the answer') };
    channel = ch;
  }
  const fallback = text.replace(/\s+/g, ' ').trim().slice(0, 280) || 'Bays message';
  const bodies = parts.length ? parts : [null];
  let firstTs = '';
  const failed: { part: number; error: string }[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const r = await slack.botCall('chat.postMessage', {
      channel,
      text: bodies[i] ? (i ? `${fallback} (part ${i + 1} of ${bodies.length})` : fallback) : text.slice(0, 39000),
      blocks: bodies[i] ?? undefined,
      thread_ts: i ? threadTs || firstTs : threadTs,
      unfurl_links: false,
    });
    if (i === 0) {
      if (!r.ok || typeof r.ts !== 'string') return { ok: false as const, step: `part 1 of ${bodies.length}`, error: String(r.error ?? 'no ts in the answer') };
      firstTs = r.ts;
      if (typeof r.channel === 'string') channel = r.channel;
    } else if (!r.ok) failed.push({ part: i + 1, error: String(r.error ?? 'unknown_error') });
  }
  return { ok: failed.length === 0, channel, ts: firstTs, parts: bodies.length, failed_parts: failed, permalink: `https://bayshorizonnetwork.slack.com/archives/${channel}/p${firstTs.replace('.', '')}` };
}

export const postChannelMessage: ToolDefinition = {
  name: 'post_channel_message',
  description:
    'Post a message as the Bays bot into a channel, DM or to a person. This is the tool an approved "Bays — Slack Send" post runs through: on an agent token a destination the engine does not know (not in channel_tracking, not an engine channel, never approved before; or a person with no Builder Profile) is not posted and waits on an Approve / Deny card. destination: C…, G…, D… or a U… user id. text: the message (used as the notification text when parts are given). parts: optional array of Slack block arrays; part 1 posts at the destination and the rest as replies in its thread. Every post is checked for Slack\'s ok:false. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'C…, G…, D… or a U… user id.' },
      text: { type: 'string', description: 'The message text.' },
      parts: { type: 'array', description: 'Optional: Slack block arrays, one per message part.', items: { type: 'array', items: {} } },
      thread_ts: { type: 'string', description: 'Optional thread to post into.' },
      ...DRY,
      ...REQUESTER,
    },
    required: ['destination', 'text'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Post a message as Bays' },
  handler: (args, deps) =>
    audited('post_channel_message', args, deps, async () => {
      const dest = str(args, 'destination');
      const text = typeof args.text === 'string' ? args.text : '';
      const threadTs = str(args, 'thread_ts') || undefined;
      const parts = partsOf(args);
      if (!DEST_RE.test(dest) || !text.trim()) {
        return { outcome: 'refused', detail: 'bad destination or empty text', answer: { ok: false, reason: 'bad_argument', message: '"destination" (C…, G…, D… or U…) and a non-empty "text" are required. Nothing was posted.' } };
      }
      const verdict = await destinationVerdict(dest);
      const held = !verdict.known && approvals.needsApproval();
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: verdict.why, target: dest, answer: { ok: true, dry_run: true, destination: dest, known: verdict.known, why: verdict.why, would_wait_for_approval: held, parts: parts.length || 1 } };
      }
      if (!slack.slackConfigured()) return { outcome: 'refused', detail: 'not configured', target: dest, answer: notConfigured() };
      if (held) {
        const where = verdict.kind === 'channel' ? `<#${dest}>` : verdict.kind === 'user' ? `a DM to <@${dest}>` : `the DM ${dest}`;
        const asked = approvals.pendingAnswer(
          await approvals.request({
            tool: 'post_channel_message',
            args: { destination: dest, text, parts, ...(threadTs ? { thread_ts: threadTs } : {}) },
            target: dest,
            summary: `post a message as Bays in ${where} (${verdict.why}): "${text.replace(/\s+/g, ' ').trim().slice(0, 300)}"`,
          }),
        );
        return { ...asked, target: dest };
      }
      const r = await postParts(dest, text, parts, threadTs);
      if (!r.ok) {
        return { outcome: 'failed', detail: `${'step' in r ? r.step : 'some parts'}: ${'error' in r ? r.error : 'some_parts_failed'}`, target: dest, answer: { ...r, ok: false, error: 'error' in r ? r.error : 'some_parts_failed', message: 'Slack refused the post, or part of it. See error.' } };
      }
      return { outcome: 'applied', detail: `${r.parts} part(s) → ${r.channel}`, target: dest, answer: { ...r } };
    }),
};

export const SLACK_WRITE_TOOLS: ToolDefinition[] = [sendNudge, postFile, postChannelMessage];
