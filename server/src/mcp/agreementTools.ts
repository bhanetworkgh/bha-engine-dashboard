/**
 * `send_agreement` (5 Nov 2026, Destiny): Bays pulls up a Stage 1 agreement in Slack, for Destiny or Jason only.
 *
 * The file goes straight from this server to that person's DM as Bays and never through the agent: the answer
 * carries no contents, so nothing of it reaches a model, a log or a thread. The requester is what the caller
 * declares, so the rule that holds is the destination: the only places this can ever send are those two DMs.
 */
import * as agreements from '../agreements';
import * as slack from '../slack';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const ADMINS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const str = (a: Record<string, unknown>, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');

async function sendFile(user: string, filename: string, contentType: string, bytes: Buffer, comment: string): Promise<{ ok: boolean; step?: string; error?: string }> {
  const o = await slack.botCall('conversations.open', { users: user }, 'form');
  const channel = (o.channel as { id?: string } | undefined)?.id;
  if (!o.ok || !channel) return { ok: false, step: 'conversations.open', error: String(o.error ?? 'no channel id') };
  const g = await slack.botCall('files.getUploadURLExternal', { filename, length: bytes.length }, 'form');
  const url = typeof g.upload_url === 'string' ? g.upload_url : '';
  const fileId = typeof g.file_id === 'string' ? g.file_id : '';
  if (!g.ok || !url || !fileId) return { ok: false, step: 'files.getUploadURLExternal', error: String(g.error ?? 'no upload url') };
  const u = await slack.uploadBytes(url, bytes, contentType);
  if (!u.ok) return { ok: false, step: 'upload', error: String(u.error ?? u.status) };
  const c = await slack.botCall('files.completeUploadExternal', { files: [{ id: fileId, title: filename }], channel_id: channel, initial_comment: comment });
  if (!c.ok) return { ok: false, step: 'files.completeUploadExternal', error: String(c.error ?? 'no confirmation') };
  return { ok: true };
}

export const sendAgreement: ToolDefinition = {
  name: 'send_agreement',
  description:
    "Send one person's Stage 1 agreement to Destiny or Jason, as a file in their own DM with Bays. Use it when Destiny or Jason asks to see someone's agreement. HELD HERE: requester_user_id must be Destiny or Jason (not_permitted), for anyone else say it is theirs to ask for; the file only ever goes to the requester's DM and its contents never come back to you, so never summarise or quote an agreement. person: a first name. Sends the furthest-along copy held: countersigned, then signed, then unsigned, and says which. dry_run says what would be sent. Returns {ok, sent, person, status, file}.",
  inputSchema: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'First name, e.g. Kaiqi.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person who asked.' },
      dry_run: { type: 'boolean' },
    },
    required: ['person', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Send a Stage 1 agreement to Destiny or Jason' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id');
    const person = str(args, 'person');
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'send_agreement', args, access: deps.access, kind: 'agreements', requester, dry_run: dry });
    const finish = async (body: Record<string, unknown>, outcome: string) => {
      await auditClose(audit, { outcome, detail: String(body.message ?? '') });
      return body;
    };
    if (!ADMINS.has(requester)) return finish({ ok: false, reason: 'not_permitted', message: 'Agreements go to Destiny or Jason only. Nothing was sent.' }, 'refused');
    const { agreements: rows } = await agreements.list();
    const row = agreements.bestFor(rows, person);
    if (!row) return finish({ ok: false, reason: 'not_held', message: `No agreement is held for ${person}.` }, 'refused');
    if (dry) return finish({ ok: true, sent: false, dry_run: true, person: row.person_name, status: row.status, file: row.filename, message: `Would send ${row.filename} (${row.status}) to the requester's DM.` }, 'dry_run');
    const f = await agreements.open(row.id);
    const out = await sendFile(requester, row.filename, row.content_type, f.bytes, `${row.title} (${row.status}).`);
    if (!out.ok) return finish({ ok: false, reason: 'slack_refused', raise: true, step: out.step, message: `Slack refused at ${out.step}: ${out.error}` }, 'failed');
    return finish({ ok: true, sent: true, person: row.person_name, status: row.status, file: row.filename, message: `Sent to the requester's DM. Say so, and say nothing of what it holds.` }, 'sent');
  },
};

export const AGREEMENT_WRITE_TOOLS: ToolDefinition[] = [sendAgreement];
