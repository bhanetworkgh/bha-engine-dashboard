/**
 * Files and documents for the Bays agent (2026-09-24, Destiny): the last
 * things it did through n8n tools of its own.
 *
 *   `read_slack_file`     — read only, on both connections. A file somebody
 *                            shared with Bays, as text; a PDF has its text
 *                            layer extracted (`../pdf.ts`, no dependency).
 *   `share_doc`           — anyone with the link can read.
 *   `grant_drive_access`  — one person, **@bhanetwork.org only**, enforced
 *                            here in code and never left to a prompt.
 *   `create_doc`          — a Google Doc in a folder, for the daily digest
 *                            archive (`Bays — Daily Digests`). Chosen over a
 *                            `digest_archive` option on another tool: a Doc in
 *                            a folder is one thing, and one tool that does one
 *                            thing is one a caller can reason about.
 *
 * The three that change Drive are write tools: only on the write connection,
 * every call — refused and dry-run ones included — on `engine_mcp_writes`,
 * opened before the call and closed after it, like the record tools.
 */
import * as google from '../google';
import * as slack from '../slack';
import * as mirror from '../mirror';
import { extractPdfText } from '../pdf';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

/** The cap on text handed back, in characters. */
export const TEXT_CAP = 30_000;
/** Who is told when an address outside the domain is refused: Destiny. */
export const DOMAIN_GUARD_DM = 'U0AEW3TBYH1';
export const ALLOWED_DOMAIN = 'bhanetwork.org';
const ROLES = ['reader', 'commenter', 'writer'] as const;
type Role = (typeof ROLES)[number];

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

/**
 * The domain rule, in one function so it cannot be spelled two ways. Exactly
 * one `@`, a non-empty local part with no whitespace, and a domain that **is**
 * bhanetwork.org — so `x@evil-bhanetwork.org`, `x@bhanetwork.org.evil.com` and
 * `x@sub.bhanetwork.org` are all refused.
 */
export function isBhaEmail(raw: string): boolean {
  const e = raw.trim().toLowerCase();
  return /^[^@\s]+@bhanetwork\.org$/.test(e);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function errorOf(e: unknown): { step: string | null; status: number | null; message: string } {
  if (e instanceof google.GoogleError) return { step: e.step, status: e.status, message: e.message };
  return { step: null, status: null, message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------- read_slack_file */

export const readSlackFile: ToolDefinition = {
  name: 'read_slack_file',
  description: `Read a file somebody shared in Slack, as text. Only https://files.slack.com/ addresses (url_private or url_private_download) — anything else is refused not_a_slack_file_url. Downloaded with the Bays bot token. A PDF has its text layer extracted; anything else is returned as text. At most ${TEXT_CAP} characters, with truncated: true beyond that. Outcomes: extracted, no_text_layer (a scanned or image-only PDF, or an encrypted one), file_not_found (404), not_authorised (401/403, or Slack redirecting to sign-in). Read only.`,
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The file’s url_private or url_private_download, e.g. https://files.slack.com/files-pri/T…/F…/report.pdf' } },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Read a Slack file as text' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const url = str(args, 'url');
    const answer = await (async (): Promise<Record<string, unknown>> => {
      if (!slack.isSlackFileUrl(url)) return { ok: false, reason: 'not_a_slack_file_url', message: 'Only https://files.slack.com/ addresses are read. Pass the file’s url_private or url_private_download.' };
      if (!slack.slackConfigured()) return { ok: false, reason: 'not_configured', message: `${slack.SLACK_TOKEN_VAR} is not set on this server, so no Slack file can be downloaded.` };
      const d = await slack.download(url);
      if (!d.ok) return { ok: false, outcome: d.outcome, reason: d.outcome, status: d.status || null, step: 'download from files.slack.com', message: d.message };
      const isPdf = d.content_type.includes('application/pdf') || d.bytes.subarray(0, 5).toString('latin1') === '%PDF-';
      let text: string;
      let extra: Record<string, unknown> = {};
      if (isPdf) {
        let r;
        try {
          r = extractPdfText(d.bytes);
        } catch (e) {
          return { ok: false, outcome: 'no_text_layer', reason: 'no_text_layer', type: 'pdf', bytes: d.bytes.length, step: 'extract PDF text', message: `The PDF could not be read: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (r.encrypted) return { ok: false, outcome: 'no_text_layer', reason: 'no_text_layer', type: 'pdf', pages: r.pages, bytes: d.bytes.length, message: 'The PDF is encrypted, and encrypted PDFs are not decrypted here — no text was read.' };
        if (!r.text.replace(/\s/g, '')) {
          return {
            ok: false,
            outcome: 'no_text_layer',
            reason: 'no_text_layer',
            type: 'pdf',
            pages: r.pages,
            bytes: d.bytes.length,
            message: `The PDF has ${r.pages} page${r.pages === 1 ? '' : 's'} and no text layer — it is scanned or made of images${r.unmapped ? `, or its ${r.unmapped} strings use a font with no Unicode map` : ''}. No OCR is done here.`,
          };
        }
        text = r.text;
        extra = { type: 'pdf', pages: r.pages, ...(r.unmapped ? { unmapped_strings: r.unmapped, note: `${r.unmapped} strings used a font with no Unicode map and were left out.` } : {}) };
      } else {
        text = d.bytes.toString('utf8');
        extra = { type: d.content_type.split(';')[0] || 'unknown' };
      }
      const truncated = text.length > TEXT_CAP;
      return { ok: true, outcome: 'extracted', ...extra, bytes: d.bytes.length, chars: text.length, truncated, text: truncated ? text.slice(0, TEXT_CAP) : text, ...(truncated ? { cap: TEXT_CAP } : {}) };
    })();
    await mirror.logWrite({
      endpoint: 'mcp:read_slack_file',
      kind: 'slack_file',
      method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET',
      outcome: 'read',
      // The path only: a Slack file url carries no secret, but its query can.
      detail: `${url.split('?')[0].slice(0, 200)} → ${String(answer.outcome ?? answer.reason)}${answer.chars !== undefined ? ` (${String(answer.chars)} chars)` : ''}`,
      ms: Date.now() - t0,
    });
    return answer;
  },
};

/* --------------------------------------------------------- the Drive writes */

async function audited(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  run: () => Promise<{ outcome: string; detail: string | null; answer: Record<string, unknown>; target?: string | null }>,
): Promise<Record<string, unknown>> {
  const dry = args.dry_run === true;
  const requester = str(args, 'requester_user_id') || null;
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'google_drive', requester, dry_run: dry });
  try {
    const r = await run();
    await auditClose(audit, { outcome: r.outcome, detail: r.detail, natural_id: r.target ?? null, after: r.answer });
    return { ...r.answer, audit_id: audit };
  } catch (e) {
    const err = errorOf(e);
    await auditClose(audit, { outcome: 'failed', detail: err.message });
    return { ok: false, reason: 'google_error', step: err.step, status: err.status, message: err.message, audit_id: audit };
  }
}

const DRY = { dry_run: { type: 'boolean', description: 'Check the call and say what would happen, without calling Google.' } };
const REQUESTER = { requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' } };

export const shareDoc: ToolDefinition = {
  name: 'share_doc',
  description:
    'Make a Google Doc (or any Drive file) readable by anyone with the link: Drive permission {role: reader, type: anyone}, supportsAllDrives. Returns {ok, document_id, permission_id, link}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: { document_id: { type: 'string', description: 'The Drive file id — the part of a Docs link after /d/.' }, ...DRY, ...REQUESTER },
    required: ['document_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true, title: 'Share a Doc with anyone who has the link' },
  handler: (args, deps) =>
    audited('share_doc', args, deps, async () => {
      const id = str(args, 'document_id');
      if (!id) return { outcome: 'refused', detail: 'no document_id', answer: { ok: false, reason: 'bad_argument', message: '"document_id" is required.' } };
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would: { document_id: id, permission: { role: 'reader', type: 'anyone' } }, google_configured: google.googleConfigured() } };
      }
      if (!google.googleConfigured()) return { outcome: 'refused', detail: 'not configured', target: id, answer: { ok: false, reason: 'not_configured', message: google.notConfiguredMessage() } };
      const p = await google.shareAnyone(id);
      let link = google.docLink(id);
      try {
        link = (await google.fileMeta(id)).webViewLink ?? link;
      } catch {
        /* the share landed; the fallback link is the Docs one */
      }
      return { outcome: 'applied', detail: `anyone reader ${p.permission_id}`, target: id, answer: { ok: true, document_id: id, permission_id: p.permission_id, link } };
    }),
};

export const grantDriveAccess: ToolDefinition = {
  name: 'grant_drive_access',
  description: `Give one person access to a Drive file: role reader (default), commenter or writer. **Only addresses ending @${ALLOWED_DOMAIN}** — enforced by the server, not the prompt. Anything else is refused ok:false, reason non_bhanetwork_email, nothing is shared, and Destiny is sent a Slack DM naming the address and the file. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The Drive file id.' },
      email: { type: 'string', description: `The person’s @${ALLOWED_DOMAIN} address.` },
      role: { type: 'string', enum: [...ROLES], description: 'Default reader.' },
      ...DRY,
      ...REQUESTER,
    },
    required: ['file_id', 'email'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: `Grant one @${ALLOWED_DOMAIN} person access to a Drive file` },
  handler: (args, deps) =>
    audited('grant_drive_access', args, deps, async () => {
      const fileId = str(args, 'file_id');
      const email = str(args, 'email').toLowerCase();
      const role = (str(args, 'role') || 'reader') as Role;
      if (!fileId || !email) return { outcome: 'refused', detail: 'missing file_id or email', answer: { ok: false, reason: 'bad_argument', message: '"file_id" and "email" are both required.' } };
      if (!ROLES.includes(role)) return { outcome: 'refused', detail: `bad role ${role}`, target: fileId, answer: { ok: false, reason: 'bad_argument', message: `"role" must be one of ${ROLES.join(', ')}.` } };
      if (!isBhaEmail(email)) {
        // The hard rule. Nothing is shared; Destiny is told, whether or not
        // this is a dry run, because somebody asked for it either way.
        const requester = str(args, 'requester_user_id');
        const sent = await slack.dm(
          DOMAIN_GUARD_DM,
          `:no_entry: grant_drive_access refused an address outside ${ALLOWED_DOMAIN}.\n• Email: ${email}\n• File: ${fileId}\n• Role asked for: ${role}${requester ? `\n• Asked by: <@${requester}>` : ''}\nNothing was shared.`,
        );
        return {
          outcome: 'refused',
          detail: `non_bhanetwork_email ${email}; DM ${sent.ok ? 'sent' : `not sent — ${sent.detail}`}`,
          target: fileId,
          answer: {
            ok: false,
            reason: 'non_bhanetwork_email',
            message: `Only @${ALLOWED_DOMAIN} addresses can be given access. Nothing was shared.`,
            email,
            file_id: fileId,
            destiny_notified: sent.ok,
            ...(sent.ok ? {} : { notify_error: sent.detail }),
          },
        };
      }
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: null, target: fileId, answer: { ok: true, dry_run: true, would: { file_id: fileId, permission: { role, type: 'user', emailAddress: email } }, google_configured: google.googleConfigured() } };
      }
      if (!google.googleConfigured()) return { outcome: 'refused', detail: 'not configured', target: fileId, answer: { ok: false, reason: 'not_configured', message: google.notConfiguredMessage() } };
      const p = await google.grantUser(fileId, email, role);
      return { outcome: 'applied', detail: `${email} ${role} ${p.permission_id}`, target: fileId, answer: { ok: true, file_id: fileId, email, role, permission_id: p.permission_id } };
    }),
};

export const createDoc: ToolDefinition = {
  name: 'create_doc',
  description:
    'Create a Google Doc in a Drive folder with the given text — used for the daily digest archive (folder "Bays — Daily Digests", 1lbNlyzOknDu2mjWaOIeyUrWj-3mmax-V). Returns {ok, doc_id, link}. If the Doc is made but its text is not written, answers ok:false with the doc_id so the empty Doc is not lost. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: { type: 'string', description: 'The Drive folder id.' },
      title: { type: 'string' },
      content: { type: 'string', description: 'Plain text; line breaks are kept.' },
      ...DRY,
      ...REQUESTER,
    },
    required: ['folder_id', 'title', 'content'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Create a Google Doc in a folder' },
  handler: (args, deps) =>
    audited('create_doc', args, deps, async () => {
      const folder = str(args, 'folder_id');
      const title = str(args, 'title');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!folder || !title) return { outcome: 'refused', detail: 'missing folder_id or title', answer: { ok: false, reason: 'bad_argument', message: '"folder_id" and "title" are required.' } };
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: null, target: folder, answer: { ok: true, dry_run: true, would: { folder_id: folder, title, content_chars: content.length }, google_configured: google.googleConfigured() } };
      }
      if (!google.googleConfigured()) return { outcome: 'refused', detail: 'not configured', target: folder, answer: { ok: false, reason: 'not_configured', message: google.notConfiguredMessage() } };
      const d = await google.createDoc(folder, title, content);
      if (!d.content_written) {
        return {
          outcome: 'failed',
          detail: `doc ${d.doc_id} made, text not written: ${d.error}`,
          target: d.doc_id,
          answer: { ok: false, reason: 'content_not_written', step: 'write the Doc text (docs batchUpdate)', doc_id: d.doc_id, link: d.link, message: `The Doc exists but is empty: ${d.error}` },
        };
      }
      return { outcome: 'applied', detail: `doc ${d.doc_id} in ${folder}`, target: d.doc_id, answer: { ok: true, doc_id: d.doc_id, link: d.link, folder_id: folder, title } };
    }),
};

export const DOC_WRITE_TOOLS: ToolDefinition[] = [shareDoc, grantDriveAccess, createDoc];
