/**
 * The founder comp snapshot over MCP (12 Nov 2026, Destiny). Write connection only, in no agent's scope, and
 * refused on any agent token: it holds every founder's day rate and equity.
 *
 *   read_comp_snapshot  — the page as it stands: the sections, the day rates by start date and the Stage 1 table.
 *   write_comp_snapshot — one section, by id. A change keeps the text it replaced (engine_comp_snapshot_history).
 *
 * The audit line on engine_mcp_writes never carries the section's text, only its length and sha256: that table is
 * not behind the admin login, and the text holds pay.
 */
import { createHash } from 'node:crypto';
import * as comp from '../compSnapshot';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const s = (a: Record<string, unknown>, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.body === 'string') {
    const b = out.body as string;
    out.body = { chars: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  }
  return out;
}

export const readCompSnapshotTool: ToolDefinition = {
  name: 'read_comp_snapshot',
  description:
    'Read the founder comp snapshot behind the admin login (/comp-snapshot): every section Destiny keeps (equity map, stages and pay, waterfall, knowledge capture, production income, blocks), the day rates by start date and the Stage 1 table, read live. Destiny or Jason only, never an agent. Read only.',
  inputSchema: {
    type: 'object',
    properties: { requester_user_id: { type: 'string', description: 'Slack id of the person reading: Destiny or Jason.' } },
    required: ['requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the comp snapshot' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'agent_not_permitted', message: `An agent (${deps.agent}) may not read the comp snapshot.` };
    if (!comp.ALLOWED.has(s(args, 'requester_user_id'))) return { ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason can read the comp snapshot.' };
    return { ok: true, page: '/comp-snapshot', ...(await comp.read()) };
  },
};

export const writeCompSnapshotTool: ToolDefinition = {
  name: 'write_comp_snapshot',
  description:
    'Write one section of the founder comp snapshot (/comp-snapshot, behind the admin login). section_id: lower case and hyphens, e.g. "equity". title is required for a new section. body: plain text, "## " for a heading, "- " for a bullet, "  - " for a sub-bullet, **bold**; at most 40,000 characters. position orders the sections (lower first). A change keeps the text it replaced, which is never edited or deleted. Destiny or Jason only, never an agent. dry_run: say what would change. Audited on engine_mcp_writes (kind comp_snapshot) without the text.',
  inputSchema: {
    type: 'object',
    properties: {
      section_id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      position: { type: 'number' },
      reason: { type: 'string', description: 'Why it changed, kept on the history line.' },
      requester_user_id: { type: 'string', description: 'Slack id: Destiny or Jason.' },
      dry_run: { type: 'boolean' },
    },
    required: ['section_id', 'body', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Write a comp snapshot section' },
  handler: async (args, deps) => {
    const requester = s(args, 'requester_user_id');
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'write_comp_snapshot', args: safeArgs(args), access: deps.access, kind: 'comp_snapshot', requester: requester || null, dry_run: dry });
    if (deps.agent) {
      const message = `An agent (${deps.agent}) may not write the comp snapshot.`;
      await auditClose(audit, { outcome: 'refused', detail: message, guard_result: { reason: 'agent_not_permitted' } });
      return { ok: false, reason: 'agent_not_permitted', message, audit_id: audit };
    }
    const r = await comp.write(
      {
        section_id: s(args, 'section_id'),
        title: typeof args.title === 'string' ? args.title : undefined,
        body: typeof args.body === 'string' ? args.body : '',
        position: typeof args.position === 'number' ? args.position : undefined,
        reason: s(args, 'reason') || undefined,
        by: requester,
      },
      dry,
    );
    if (!r.ok) {
      await auditClose(audit, { outcome: 'refused', detail: r.message, natural_id: s(args, 'section_id') || null, guard_result: { reason: r.reason } });
      return { ...r, audit_id: audit };
    }
    const outcome = dry ? 'dry_run' : r.written ? 'updated' : 'unchanged';
    await auditClose(audit, { outcome, detail: `${r.section.section_id}: ${r.section.body.length} chars`, natural_id: r.section.section_id });
    return { ok: true, written: r.written, dry_run: dry, section_id: r.section.section_id, title: r.section.title, position: r.section.position, chars: r.section.body.length, replaced: r.previous ? r.previous.body.length : null, page: '/comp-snapshot', audit_id: audit };
  },
};

export const COMP_SNAPSHOT_WRITE_TOOLS: ToolDefinition[] = [readCompSnapshotTool, writeCompSnapshotTool];
