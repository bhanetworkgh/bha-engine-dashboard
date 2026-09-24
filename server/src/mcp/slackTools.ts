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

async function audited(
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

type NudgeLine = { recipient: string; user_id: string; ok: boolean; ts: string; channel: string; error: string };

/** `SNG - Format Result`: one line per recipient, sent first-named first, the invalid ones after. */
function summarise(results: NudgeLine[]): string {
  const sent = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (sent.length) parts.push(`Sent to ${sent.map((r) => `${r.recipient} (ts ${r.ts})`).join(', ')}.`);
  if (failed.length) parts.push(`Couldn't send to ${failed.map((r) => `${r.recipient}: ${r.error}`).join('; ')}.`);
  return parts.join(' ');
}

export const sendNudge: ToolDefinition = {
  name: 'send_nudge',
  description:
    'DM every person named, one Slack DM each — the person being nudged AND everyone cc\'d. recipients: user ids (U…/W…) or <@U…> mentions, as an array or one string separated by spaces or commas. Anything that is not a Slack user id comes back as not_a_slack_user_id, never dropped. thread_link is appended to the text unless already in it. Returns {ok (every recipient sent), sent_count, failed_count, results: [{recipient, user_id, ok, ts, error}], summary}. Empty text or no valid recipient: ok:false and nothing is sent. As the Bays bot; audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      recipients: {
        description: 'Slack user ids or <@U…> mentions — an array, or one string separated by spaces, commas or semicolons.',
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
      },
      text: { type: 'string', description: 'The message. Slack mrkdwn.' },
      thread_link: { type: 'string', description: 'Optional permalink to the thread this is about; appended after a blank line unless the text already has it.' },
      ...DRY,
      ...REQUESTER,
    },
    required: ['recipients', 'text'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'DM each person named, one message each' },
  handler: (args, deps) =>
    audited('send_nudge', args, deps, async () => {
      const { valid, invalid, total } = parseRecipients(args.recipients);
      const body = typeof args.text === 'string' ? args.text.trim() : '';
      const text = nudgeText(body, str(args, 'thread_link'));
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
      if (args.dry_run === true) {
        return {
          outcome: 'dry_run',
          detail: `${valid.length} valid, ${invalid.length} invalid`,
          target: valid.join(','),
          answer: {
            ok: invalid.length === 0,
            dry_run: true,
            would_send_to: valid,
            not_a_slack_user_id: invalid,
            text,
            slack_configured: slack.slackConfigured(),
            summary: `Would send ${valid.length} DM${valid.length === 1 ? '' : 's'}${invalid.length ? `; ${invalid.length} recipient${invalid.length === 1 ? ' is' : 's are'} not a Slack user id` : ''}.`,
          },
        };
      }
      if (!slack.slackConfigured()) return { outcome: 'refused', detail: 'not configured', target: valid.join(','), answer: notConfigured() };

      // One post per recipient, in order. A refusal for one never stops the rest.
      const results: NudgeLine[] = [];
      for (const u of valid) {
        const r = await slack.botCall('chat.postMessage', { channel: u, text, unfurl_links: false });
        results.push({
          recipient: `<@${u}>`,
          user_id: u,
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
        answer: { ok: failed === 0, sent_count: sent, failed_count: failed, results, summary: summarise(results) },
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

export const SLACK_WRITE_TOOLS: ToolDefinition[] = [sendNudge, postFile];
