/**
 * Log and remove SOPs in BHARAG over MCP (2026-10-13, Destiny).
 *
 *   log_sop    — write one SOP into the workspace Bays writes SOPs into
 *                (BHARAG_SOPS_KEY), through the write guard, then read it back
 *                and compare the stored text with what was sent.
 *   delete_sop — remove one SOP from that workspace, by BHARAG id.
 *
 * Built because the SOPs tab showed three superseded copies of one SOP still
 * in BHARAG after their removal was planned by hand and missed, and because an
 * SOP Jason approves should be loggable without retyping it to Bays.
 *
 * Both are a person's tools: write connection only, in no agent's scope, and
 * only Destiny or Jason may call them (requester_user_id). Every call is
 * audited on engine_mcp_writes, refused and dry-run ones included; a delete
 * keeps the SOP's whole text on its audit line ("before"), so a removed SOP
 * can still be read. Only a document whose title starts "SOP" can be touched.
 */
import * as bharag from '../bharag';
import * as mirror from '../mirror';
import * as sops from '../sops';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const logSopTool: ToolDefinition = {
  name: 'log_sop',
  description:
    'Write one SOP into BHARAG, in the workspace Bays writes and reads SOPs in (BHARAG_SOPS_KEY), through the write guard. title must start "SOP -- ". content is stored as sent. source_link: the Slack thread the SOP came from (required). supersedes: BHARAG ids of SOPs this one replaces, recorded on it (they are not removed; use delete_sop). requester_user_id: Destiny or Jason. Refused when an SOP with the same title is already held. After the ingest the SOP is read back and its stored text compared with what was sent: verified true only when they match. dry_run checks everything and writes nothing. Returns {ok, id, verified}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Starts "SOP -- ".' },
      content: { type: 'string', description: 'The SOP text, stored as sent.' },
      source_link: { type: 'string', description: 'The Slack thread it came from.' },
      supersedes: { type: 'array', items: { type: 'string' }, description: 'BHARAG ids of SOPs this replaces.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking: Destiny or Jason.' },
      dry_run: { type: 'boolean' },
    },
    required: ['title', 'content', 'source_link', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Log an SOP into BHARAG' },
  handler: async (args, deps) => {
    const title = str(args.title);
    const content = typeof args.content === 'string' ? args.content : '';
    const link = str(args.source_link);
    const requester = str(args.requester_user_id) || null;
    const supersedes = Array.isArray(args.supersedes) ? args.supersedes.map(str).filter(Boolean) : [];
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'log_sop', args: { ...args, content: `${content.length} characters` }, access: deps.access, kind: 'bharag_sop', requester, dry_run: dry });
    const refuse = async (why: string, message: string, extra: Record<string, unknown> = {}) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why, ...extra } });
      return { ok: false, logged: false, reason: why, message: `${message} Nothing was written.`, ...extra, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can log an SOP with this tool. Send requester_user_id.');
    if (!/^SOP\s+--\s+\S/.test(title)) return refuse('bad_title', 'title must start "SOP -- " followed by the rule\'s name.');
    if (!content.trim()) return refuse('empty', 'content is empty.');
    if (!/^https:\/\/[a-z0-9-]+\.slack\.com\//i.test(link)) return refuse('bad_source', 'source_link must be the Slack thread the SOP came from.');
    const now = await sops.read({ fresh: true });
    if (!now.ok || !now.complete) return refuse('cannot_check_duplicates', `The SOP list could not be read whole (${now.error ?? now.note ?? 'incomplete'}), so a duplicate cannot be ruled out.`);
    const same = now.sops.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (same) return refuse('already_held', `An SOP titled "${title}" is already held (${same.id}).`, { existing_id: same.id });
    const missing = supersedes.filter((id) => !now.sops.some((s) => s.id === id));
    if (missing.length) return refuse('unknown_supersedes', `supersedes names ids that are not SOPs held: ${missing.join(', ')}.`, { missing });
    const doc = {
      title,
      content,
      source_type: 'manual',
      content_type: 'doc',
      project_tags: ['sop'],
      metadata: { doc_type: 'sop', source_link: link, requested_by: requester, supersedes, logged_via: 'mcp:log_sop' },
    };
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would log "${title}" (${content.length} characters)`, guard_result: { key_variable: sops.keyVar(), supersedes } });
      return { ok: true, logged: false, dry_run: true, title, characters: content.length, key_variable: sops.keyVar(), supersedes, message: 'Dry run: nothing was written.', audit_id: audit };
    }
    const r = await bharag.ingestWithKey(sops.keyVar(), doc, 'mcp:log_sop');
    if (!r.ok || !r.id) {
      await auditClose(audit, { outcome: 'failed', detail: r.detail });
      return { ok: false, logged: false, reason: 'ingest_failed', message: `Not stored in BHARAG: ${r.detail}`, raise: true, audit_id: audit };
    }
    sops.forget();
    let verified = false;
    let readBack = 'not read';
    try {
      const back = await bharag.getDocument('codex', r.id, sops.keyVar());
      verified = !!back && back.title?.trim() === title && (back.raw_content ?? '') === content;
      readBack = !back ? 'not found on read-back' : verified ? 'stored text matches' : 'stored text differs from what was sent (the guard may have redacted something)';
    } catch (e) {
      readBack = `read-back failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    await auditClose(audit, { outcome: 'created', detail: `logged ${r.id}; ${readBack}`, natural_id: r.id, after: { id: r.id, title, verified } });
    return { ok: true, logged: true, id: r.id, title, verified, read_back: readBack, key_variable: sops.keyVar(), supersedes, audit_id: audit };
  },
};

export const deleteSopTool: ToolDefinition = {
  name: 'delete_sop',
  description:
    'Remove one SOP from BHARAG (the workspace BHARAG_SOPS_KEY opens), by BHARAG document id. Only a document whose title starts "SOP". confirm must be exactly "DELETE <id>". reason is required (e.g. "superseded by <id>"). requester_user_id: Destiny or Jason. The SOP\'s whole text is kept on the audit line before it is removed, and the removal is checked by reading the id again. dry_run says what would be removed. Returns {ok, deleted, verified_gone}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The SOP\'s BHARAG document id.' },
      confirm: { type: 'string', description: 'Exactly "DELETE <id>".' },
      reason: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['id', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true, title: 'Remove an SOP from BHARAG' },
  handler: async (args, deps) => {
    const id = str(args.id);
    const reason = str(args.reason).slice(0, 300);
    const requester = str(args.requester_user_id) || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'delete_sop', args, access: deps.access, kind: 'bharag_sop', requester, dry_run: dry });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, natural_id: id || null, guard_result: { reason: why } });
      return { ok: false, deleted: false, reason: why, message: `${message} Nothing was removed.`, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can remove an SOP with this tool.');
    if (!reason) return refuse('reason_required', 'Send a reason, e.g. "superseded by <id>".');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return refuse('bad_id', 'id must be a BHARAG document id.');
    const d = await sops.doc(id);
    if (!d.ok) return refuse('not_an_sop', d.reason);
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would remove ${id} "${d.sop.title}"`, natural_id: id });
      return { ok: true, deleted: false, dry_run: true, id, title: d.sop.title, message: 'Dry run: nothing was removed.', audit_id: audit };
    }
    if (str(args.confirm) !== `DELETE ${id}`) return refuse('confirm_required', `confirm must be exactly "DELETE ${id}".`);
    const r = await bharag.deleteDocument(sops.keyVar(), id);
    if (!r.ok) {
      await auditClose(audit, { outcome: 'failed', detail: r.detail, natural_id: id, before: d.sop });
      return { ok: false, deleted: false, reason: 'delete_failed', message: `BHARAG did not remove it: ${r.detail}`, raise: true, audit_id: audit };
    }
    sops.forget();
    const after = await sops.doc(id);
    const gone = !after.ok && after.status === 404;
    await auditClose(audit, { outcome: gone ? 'deleted' : 'failed', detail: `${gone ? 'removed' : 'asked to remove, but it still reads'} ${id} "${d.sop.title}" — ${reason}`, natural_id: id, before: d.sop });
    return gone
      ? { ok: true, deleted: true, verified_gone: true, id, title: d.sop.title, message: `Removed "${d.sop.title}". Its text is kept on audit line ${audit}.`, audit_id: audit }
      : { ok: false, deleted: false, verified_gone: false, id, reason: 'still_there', message: 'BHARAG answered the delete, but the SOP still reads.', raise: true, audit_id: audit };
  },
};

/**
 * read_sop (2026-10-14, Destiny — LOOP-1791848474713-ZZVU). One SOP's whole text, by BHARAG id
 * or by exact title, the same read the Codex page's SOPs tab makes (sops.doc).
 *
 * Built because a search returns pieces of a document, not the document. On 14 Oct Bays was
 * asked to walk a blocked builder through Destiny's Operator Playbook and its three searches
 * returned the playbook's top, its Twilio part and its escalation order, but not the section
 * that covered the error, so it answered with general advice and named the wrong second. An
 * agent that has found an SOP reads it whole with this before it tells anyone what to do.
 *
 * Read only, both connections, in Bays' scope. Only a document whose title starts "SOP" can be
 * read. A title that matches nothing returns the closest titles with their ids, never a guess.
 * One `read` line per call on engine_writes.
 */
const MAX_SOP_CHARS = 30000;
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const readSopTool: ToolDefinition = {
  name: 'read_sop',
  description:
    'Read one SOP in full: its whole text, title, id, dates and source link. Use it after a search finds an SOP, because a search returns pieces of a document and the piece you need may not be among them. Before telling a blocked person how to clear something from a builder\'s Operator Playbook ("SOP -- Operator Playbook: <name>"), read that playbook whole with this tool and answer from the section that matches. Name the SOP by id (the BHARAG document id a search returns) or by its exact title. A title that matches nothing returns the closest SOP titles and their ids; nothing is guessed. Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The SOP\'s BHARAG document id (a UUID).' },
      title: { type: 'string', description: 'The SOP\'s exact title, e.g. "SOP -- Operator Playbook: Destiny Arupi (Engine Steward)". Case and punctuation do not matter.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Read one SOP in full' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const keyLabel = deps.access === 'read' ? 'MCP_SECRET' : 'MCP_WRITE_TOKEN';
    const log = (detail: string) => mirror.logWrite({ endpoint: 'mcp:read_sop', kind: 'bharag_sop', method: 'MCP', key_label: keyLabel, outcome: 'read', detail: detail.slice(0, 400), ms: Date.now() - t0 });
    let id = str(args.id);
    const title = str(args.title);
    if (!id && !title) return { ok: false, reason: 'no_sop_named', message: 'Send id (the BHARAG document id) or title (the SOP\'s exact title).' };
    if (!id) {
      const list = await sops.read();
      if (!list.ok) {
        await log(`title "${title}" → list unreadable: ${list.error ?? 'unknown'}`);
        return { ok: false, reason: 'sops_unreadable', message: `The SOP list could not be read from BHARAG: ${list.error ?? 'unknown error'}. Nothing was guessed.` };
      }
      const want = normTitle(title);
      const exact = list.sops.filter((s) => normTitle(s.title) === want);
      if (exact.length === 0) {
        const words = want.split(' ').filter((w) => w.length > 2 && w !== 'sop');
        const close = list.sops
          .map((s) => ({ s, hits: words.filter((w) => normTitle(s.title).includes(w)).length }))
          .filter((x) => x.hits > 0)
          .sort((a, b) => b.hits - a.hits)
          .slice(0, 10)
          .map((x) => ({ id: x.s.id, title: x.s.title }));
        await log(`title "${title}" → no exact match, ${close.length} close`);
        return { ok: false, reason: 'no_such_title', message: `No SOP is titled "${title}". The closest titles are listed; read one by its id.${list.complete ? '' : ' The SOP list was read only in part, so one may be missing from it.'}`, close_matches: close };
      }
      id = exact[0].id; // newest first, so a repeated title reads its newest copy
    }
    const d = await sops.doc(id);
    if (!d.ok) {
      await log(`${id} → ${d.status} ${d.reason}`);
      return { ok: false, reason: d.status === 404 ? 'not_found' : 'unreadable', message: d.reason };
    }
    const content = d.sop.content ?? '';
    const truncated = content.length > MAX_SOP_CHARS;
    await log(`${id} "${d.sop.title}" → ${content.length} chars${truncated ? ' (cut)' : ''}`);
    return {
      ok: true,
      id: d.sop.id,
      title: d.sop.title,
      created_at: d.sop.created_at,
      updated_at: d.sop.updated_at,
      source_link: d.sop.source_link,
      same_title: d.sop.same_title,
      content: truncated ? content.slice(0, MAX_SOP_CHARS) : content,
      content_chars: content.length,
      truncated,
      ...(d.sop.content === null ? { note: 'BHARAG returned no text for this SOP.' } : {}),
      ...(truncated ? { note: `Cut at ${MAX_SOP_CHARS} of ${content.length} characters.` } : {}),
    };
  },
};

export const SOP_READ_TOOLS: ToolDefinition[] = [readSopTool];

export const SOP_WRITE_TOOLS: ToolDefinition[] = [logSopTool, deleteSopTool];
