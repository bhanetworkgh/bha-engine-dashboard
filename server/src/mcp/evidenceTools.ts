/**
 * The evidence store over MCP (28 Oct 2026, Destiny — D3). The store and its rules are ../evidence.ts.
 *
 *   `read_evidence`  — read, both connections; in Bays', North Star's, Research Twin's and Genie's scopes.
 *                      Find a document by id, name, gate, loop or words, and read its text whole.
 *   `save_evidence`  — write connection; in Bays' scope ("Bays, save this into the evidence store" on a
 *                      file posted in Slack). Saves one document, never edits one. Audited on
 *                      engine_mcp_writes, kind evidence, refused and dry-run calls included.
 */
import * as ev from '../evidence';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const TEXT_DEFAULT = 60_000;
export const TEXT_MAX = 200_000;

const summary = (r: ev.Evidence) => ({
  evidence_id: r.evidence_id,
  name: r.name,
  version: r.version,
  title: r.title,
  proves: r.proves,
  gate: r.gate,
  loop_id: r.loop_id,
  author: r.author_name ?? r.author_id,
  author_id: r.author_id,
  written_at: r.written_at,
  saved_at: r.saved_at,
  saved_by: r.saved_by_name ?? r.saved_by,
  file_name: r.file_name,
  file_size: r.file_size,
  text_chars: r.text_chars,
  supersedes: r.supersedes,
  superseded_by: r.superseded_by,
  test: r.test,
  url: ev.pageUrl(r.evidence_id),
});

export const readEvidence: ToolDefinition = {
  name: 'read_evidence',
  description: `The evidence store: documents the engine's decisions rest on (an acceptance bundle, a live-payment proof, a test report), held on the dashboard so every system reads the same copy. With id (EV-…) or name, one document whole: what it proves, its gate or loop, who wrote it and when, and its full text (offset and max_chars page through a long one; text_truncated says when there is more). Without them, a list, newest first, of the newest version of each document, narrowed by gate, loop_id or search (words in the title, name, what it proves or the text). A record is never edited: superseded_by names a newer version, and a decision that rested on an older one rested on that one. Quote a document by its id or name, and never say it proves more than its proves line. Read only.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'An evidence id, EV-<ms>-<4>.' },
      name: { type: 'string', description: 'A record name, e.g. stripe-acceptance-bundle. The newest version unless version is given.' },
      version: { type: 'number', description: 'With name: that version.' },
      gate: { type: 'string', description: 'List the documents for one gate, e.g. charge_gate.' },
      loop_id: { type: 'string', description: 'List the documents for one loop, LOOP-…' },
      search: { type: 'string', description: 'List the documents whose title, name, proves line or text contain these words.' },
      all_versions: { type: 'boolean', description: 'List every version, not only the newest of each name.' },
      offset: { type: 'number', description: 'One document: start the text at this character. Default 0.' },
      max_chars: { type: 'number', description: `One document: at most this much text. Default ${TEXT_DEFAULT}, at most ${TEXT_MAX}.` },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the evidence store' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const id = str(args, 'id');
    const name = str(args, 'name');
    let answer: Record<string, unknown>;
    if (id || name) {
      let rec: ev.EvidenceWithText | null = null;
      if (id) rec = await ev.get(id);
      else if (typeof args.version === 'number') {
        const all = await ev.versions(name);
        const v = all.find((x) => x.version === args.version);
        rec = v ? await ev.get(v.evidence_id) : null;
      } else rec = await ev.get(name);
      if (!rec) {
        const near = await ev.list({ search: (id || name).replace(/-/g, ' ').split(' ')[0], limit: 10 });
        answer = { ok: false, reason: 'not_found', message: `No evidence record ${id || `named "${name}"`} is held.`, nearest: near.records.map((r) => ({ evidence_id: r.evidence_id, name: r.name, title: r.title })) };
      } else {
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const max = Math.min(Math.max(Math.floor(Number(args.max_chars) || TEXT_DEFAULT), 1000), TEXT_MAX);
        const text = rec.text.slice(offset, offset + max);
        const more = offset + text.length < rec.text.length;
        const versions = await ev.versions(rec.name, rec.test);
        answer = {
          ok: true,
          ...summary(rec),
          extract: rec.extract,
          notes: rec.notes,
          source_ref: rec.source_ref,
          file_url: ev.fileUrl(rec.evidence_id),
          versions: versions.map((v) => ({ evidence_id: v.evidence_id, version: v.version, saved_at: v.saved_at })),
          text,
          text_offset: offset,
          text_truncated: more,
          ...(more ? { next_offset: offset + text.length, note: `The text is ${rec.text.length} characters; this is ${offset} to ${offset + text.length}. Call again with offset ${offset + text.length} for the rest.` } : {}),
          rules: ev.RULES,
        };
      }
    } else {
      const r = await ev.list({
        gate: str(args, 'gate') || null,
        loop_id: str(args, 'loop_id') || null,
        search: str(args, 'search') || null,
        all_versions: args.all_versions === true,
        limit: 100,
      });
      answer = { ok: true, total: r.total, returned: r.records.length, records: r.records.map(summary), list_url: `${ev.pageUrl('').replace(/\?doc=$/, '')}`, rules: ev.RULES, ...(r.total === 0 ? { note: 'No document matched. An empty answer means none is saved under these terms, not that the evidence does not exist elsewhere.' } : {}) };
    }
    await mirror.logWrite({ endpoint: 'mcp:read_evidence', kind: 'evidence', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${id || name || str(args, 'gate') || str(args, 'search') || 'list'} → ${answer.ok ? (answer.evidence_id ?? `${String(answer.returned)} record(s)`) : String(answer.reason)}`, ms: Date.now() - t0 });
    return answer;
  },
};

export const saveEvidence: ToolDefinition = {
  name: 'save_evidence',
  description: `Save ONE document into the evidence store, where Bays, Genie and the twins can read it by name: use it when someone says "save this into the evidence store" on a file posted in Slack. The source is a Slack file (slack_file_id F… or slack_file_url, a PDF, Word .docx, Markdown or plain text file) or the text itself (text, with file_name). HELD HERE: requester_user_id must be Destiny, Jason or someone with a Builder Profile (not_permitted); author_id is the Slack id of the person who WROTE the document, which may differ from who asks; proves says in the saver's own words what the document proves, at least ${ev.RULE.proves_min} characters (proves_required): ask the person, never infer it. gate and loop_id say what it belongs to, when they say so. The same file twice is refused (already_saved, naming the record). A name is one document: saving under a name already held is refused (name_taken) unless supersedes names its newest version, which makes this the next version; the old one stays readable. Nothing is ever edited or deleted. It is not Codex and feeds no review or pay. dry_run reads the file and checks everything, and writes nothing. Returns {ok, written, record, url, file_url, message}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lower case and hyphens, e.g. stripe-acceptance-bundle. Defaults to the file name.' },
      title: { type: 'string', description: 'A readable title. Defaults to the file name.' },
      proves: { type: 'string', description: 'What the document proves, in the saver\'s words.' },
      gate: { type: 'string', description: 'The gate it belongs to, e.g. charge_gate.' },
      loop_id: { type: 'string', description: 'The loop it belongs to, LOOP-…' },
      author_id: { type: 'string', description: 'Slack id of the person who wrote the document.' },
      written_at: { type: 'string', description: 'When the document was written, YYYY-MM-DD or ISO. Optional.' },
      slack_file_id: { type: 'string', description: 'The Slack file id, F…' },
      slack_file_url: { type: 'string', description: 'Or the file\'s url_private.' },
      text: { type: 'string', description: 'Or the text itself.' },
      file_name: { type: 'string', description: 'With text: the file name to store it under, e.g. E01.md.' },
      supersedes: { type: 'string', description: 'The EV- id of the newest version this one replaces.' },
      notes: { type: 'string' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking for it to be saved.' },
      test: { type: 'boolean', description: 'A test record, kept apart and never accepted by a gate.' },
      dry_run: { type: 'boolean' },
    },
    required: ['proves', 'author_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Save a document into the evidence store' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id') || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'save_evidence', args: { ...args, text: typeof args.text === 'string' ? `${(args.text as string).length} characters` : undefined }, access: deps.access, kind: 'evidence', requester, dry_run: dry });
    try {
      const r = await ev.save(
        {
          name: str(args, 'name') || null,
          title: str(args, 'title') || null,
          proves: str(args, 'proves'),
          gate: str(args, 'gate') || null,
          loop_id: str(args, 'loop_id') || null,
          author_id: str(args, 'author_id'),
          written_at: str(args, 'written_at') || null,
          requester_user_id: requester ?? '',
          supersedes: str(args, 'supersedes') || null,
          notes: str(args, 'notes') || null,
          slack_file_id: str(args, 'slack_file_id') || null,
          slack_file_url: str(args, 'slack_file_url') || null,
          text: typeof args.text === 'string' ? (args.text as string) : null,
          file_name: str(args, 'file_name') || null,
          test: args.test === true,
        },
        { via: deps.agent ? `mcp:${deps.agent}` : `mcp:${deps.access}`, dry_run: dry },
      );
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'created', detail: r.message, natural_id: r.record.evidence_id, after: { ...summary(r.record), file_sha256: r.record.file_sha256 } });
      return { ...r, record: summary(r.record), audit_id: audit };
    } catch (e) {
      if (e instanceof ev.EvidenceError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was saved.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was saved.`, raise: true, audit_id: audit };
    }
  },
};

export const EVIDENCE_READ_TOOLS: ToolDefinition[] = [readEvidence];
export const EVIDENCE_WRITE_TOOLS: ToolDefinition[] = [saveEvidence];
