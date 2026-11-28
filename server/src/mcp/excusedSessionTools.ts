/**
 * Excused sessions over MCP (28 Nov 2026, Destiny — Jason's SOP 8996e4da). ../excusedSessions.ts holds the rule.
 *   draft_excused_session   write connection, in Genie's and Bays' scopes: draft one session per day of a hard block,
 *                           opening its incident in the ledger. An agent may draft; nothing is excused until decided.
 *   decide_excused_session  write connection, no agent's scope, refused on any agent token: Destiny (primary) or
 *                           Jason approves, declines or withdraws, and says whether that day's watch penalty is suppressed.
 *   read_excused_sessions   read, both connections, Genie's scope.
 */
import * as ex from '../excusedSessions';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/[\s,]+/) : []);

export const draftExcusedSession: ToolDefinition = {
  name: 'draft_excused_session',
  description:
    `Draft an excused session for a builder who could not work at all because of a hard block (${ex.RULE.sop}): block_type is power_outage, internet_outage, access_blocked (rack or site physically closed) or medical_emergency. Weather on its own, a busy day or work that ran long never counts: refuse those. Pass the builder's Slack id, the block's start and end (ISO with zone, the block must be over and ended within the last 24 hours), and at least one artefact (an https link to an outage notice, a screenshot or photo in Slack, or for a medical emergency a link to a one-line note to Jason or Destiny; or an EV- id). One session per UTC day inside the block (or the days named), all tied to one hard-block incident opened in the ledger (or incident_id if one is already held). It pays 0% and is never a work day; nothing is excused until Destiny or Jason decides it, and Destiny is told. requester_user_id is the person asking. Audited on engine_mcp_writes (kind excused_session).`,
  inputSchema: {
    type: 'object',
    properties: {
      builder_user_id: { type: 'string', description: 'Slack id (U…) of the builder who was blocked.' },
      block_type: { type: 'string', enum: [...ex.RULE.block_types] },
      block_start: { type: 'string', description: 'When the block began, ISO with zone.' },
      block_end: { type: 'string', description: 'When it ended, ISO with zone.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'https links or EV- ids. At least one.' },
      note: { type: 'string', description: 'One line on what happened, in the builder\'s words. No medical details.' },
      days: { type: 'array', items: { type: 'string' }, description: 'YYYY-MM-DD days to excuse, each inside the block. Default: every day the block touches.' },
      incident_id: { type: 'string', description: 'A hard-block incident already held. Leave out and one is opened.' },
      requester_user_id: { type: 'string' },
      test: { type: 'boolean', description: 'A marked test, for proving the path. Destiny or Jason only.' },
      dry_run: { type: 'boolean' },
    },
    required: ['builder_user_id', 'block_type', 'block_start', 'block_end', 'evidence', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Draft an excused session for a hard-block day' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : '';
    const audit = await auditOpen({ tool: 'draft_excused_session', args, access: deps.access, kind: 'excused_session', requester: requester || null, dry_run: args.dry_run === true });
    const done = async (r: Record<string, unknown> & { ok: boolean }) => {
      await auditClose(audit, { outcome: !r.ok ? 'refused' : args.dry_run === true ? 'dry_run' : 'applied', detail: String(r.ok ? r.message ?? '' : r.reason ?? '') });
      return { ...r, audit_id: audit };
    };
    if (!/^U[A-Z0-9]+$/.test(requester)) return done({ ok: false, reason: 'requester_required', message: 'requester_user_id must be the Slack id of the person asking.' });
    if (args.test === true && !ex.DECIDERS.includes(requester)) return done({ ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason may draft a marked test.' });
    const r = await ex.draft(
      {
        builder_user_id: String(args.builder_user_id ?? '').trim(),
        block_type: String(args.block_type ?? ''),
        block_start: String(args.block_start ?? ''),
        block_end: String(args.block_end ?? ''),
        evidence: strs(args.evidence),
        note: typeof args.note === 'string' ? args.note.trim().slice(0, 600) : null,
        days: Array.isArray(args.days) ? args.days.map(String) : null,
        incident_id: typeof args.incident_id === 'string' && args.incident_id.trim() ? args.incident_id.trim() : null,
        drafted_by: requester,
        drafted_via: deps.agent ? `mcp:${deps.agent}` : 'mcp',
        test: args.test === true,
      },
      { dry_run: args.dry_run === true },
    );
    return done(r as Record<string, unknown> & { ok: boolean });
  },
};

export const decideExcusedSession: ToolDefinition = {
  name: 'decide_excused_session',
  description:
    `Approve, decline or withdraw drafted excused sessions (EXS-…). Destiny (the primary approver) or Jason only, as requester_user_id, never on an agent token, and never the builder on their own day (a marked test excepted). Approve only against the evidence and the incident. suppress_penalty: true also lifts a Decision Watch pay penalty that escalated on that UTC day, that day only. Approved, the day pays 0%, is not a missed log, and never counts as a work session; no past log is touched. withdrawn is for a test or a draft made in error. The hard-block incident closes once none of its sessions is waiting. Audited on engine_mcp_writes (kind excused_session).`,
  inputSchema: {
    type: 'object',
    properties: {
      session_ids: { type: 'array', items: { type: 'string' } },
      decision: { type: 'string', enum: ['approved', 'declined', 'withdrawn'] },
      reason: { type: 'string', description: 'Why, in a sentence: what the evidence showed.' },
      suppress_penalty: { type: 'boolean' },
      requester_user_id: { type: 'string' },
    },
    required: ['session_ids', 'decision', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Decide excused sessions' },
  handler: async (args, deps) => {
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : '';
    if (deps.agent) return { ok: false, reason: 'not_on_agent_token', message: 'A person decides an excused session, never an agent.' };
    const audit = await auditOpen({ tool: 'decide_excused_session', args, access: deps.access, kind: 'excused_session', requester: requester || null, dry_run: false });
    const decision = String(args.decision ?? '');
    if (!['approved', 'declined', 'withdrawn'].includes(decision)) {
      await auditClose(audit, { outcome: 'refused', detail: 'bad_decision' });
      return { ok: false, reason: 'bad_decision', message: 'decision is approved, declined or withdrawn.', audit_id: audit };
    }
    const r = await ex.decide(strs(args.session_ids), requester, decision as 'approved', String(args.reason ?? ''), { suppress_penalty: args.suppress_penalty === true });
    await auditClose(audit, { outcome: r.ok ? 'applied' : 'refused', detail: r.ok ? r.message : r.reason });
    return { ...r, audit_id: audit };
  },
};

export const readExcusedSessions: ToolDefinition = {
  name: 'read_excused_sessions',
  description: `Excused sessions for hard-block days (${ex.RULE.sop}): each with its builder, day, incident, block, evidence, status and what it does (pay 0%, missed log, watch penalty). Filter by builder_user_id or status (pending, approved, declined, withdrawn). Read only.`,
  inputSchema: { type: 'object', properties: { builder_user_id: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read excused sessions' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const r = await ex.read({ builder: typeof args.builder_user_id === 'string' ? args.builder_user_id.trim() : null, status: typeof args.status === 'string' ? args.status.trim() : null, limit: typeof args.limit === 'number' ? args.limit : undefined });
    await mirror.logWrite({ endpoint: 'mcp:read_excused_sessions', kind: 'excused_session', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${r.count} rows`, ms: Date.now() - t0 }).catch(() => undefined);
    return { ok: true, ...r };
  },
};

export const EXCUSED_READ_TOOLS: ToolDefinition[] = [readExcusedSessions];
export const EXCUSED_WRITE_TOOLS: ToolDefinition[] = [draftExcusedSession, decideExcusedSession];
