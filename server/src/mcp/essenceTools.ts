/**
 * Essence markers over MCP (24 Oct 2026, Destiny — LOOP-1792428941802-0LEW). The rules and the
 * store are ../essence.ts; these tools only carry a call to it. Contract: docs/contracts/essence-markers.md.
 *
 *   `read_essence`            — read, both connections. A person's confirmed and stable markers.
 *                               In no agent's scope until Jason locks the contract as Canon.
 *   `propose_essence_marker`  — write connection, no agent's scope. One marker, its quote checked
 *                               against its source.
 *   `decide_essence_marker`   — write connection, no agent's scope, refused on any agent token.
 *                               The subject's own "That's me", "Not me", share or make private.
 *
 * Every write call is on engine_mcp_writes, kind essence, refused ones included.
 */
import * as essence from '../essence';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const readEssence: ToolDefinition = {
  name: 'read_essence',
  description:
    "How a person decides, in their own words: their CONFIRMED essence markers (decision rules, trade-offs, debugging instincts, standards, voice), each with the exact sentence it came from and where. Only markers the person themselves said \"That's me\" to are returned; proposed and rejected ones never are. `who` is a Slack id or a name. Rules travel with the answer: essence is private between the person and the engine, so never quote a marker to anyone else unless published is true; never extend a marker into a judgement of the person; markers never feed pay or any score. An empty list means nothing is confirmed yet, not that the person has no way of working. Returns {ok, subject_id, subject_name, markers, counts, readiness, rules}.",
  inputSchema: {
    type: 'object',
    properties: {
      who: { type: 'string', description: 'Slack id (U…) or the person\'s name as on their Builder Profile.' },
      include_test: { type: 'boolean', description: 'Include TEST markers. Default false.' },
    },
    required: ['who'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read a person\'s confirmed essence markers' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const who = str(args, 'who');
    const s = await essence.resolveSubject(who);
    if (!s) return { ok: false, reason: 'unknown_person', message: `No one matches "${who}". Use their Slack id, or their name as on their Builder Profile.` };
    const r = await essence.read(s.id, { include_test: args.include_test === true });
    await mirror.logWrite({ endpoint: 'mcp:read_essence', kind: 'essence', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${s.id} → ${r.markers.length} confirmed or stable`, ms: Date.now() - t0 });
    return { ok: true, ...r, subject_name: r.subject_name ?? s.name };
  },
};

export const proposeEssenceMarker: ToolDefinition = {
  name: 'propose_essence_marker',
  description: `Propose ONE essence marker for a person: one line about how they decide, with the exact sentence from their own words. HELD HERE: no quote, no marker. For source_kind codex_log, source_ref is the Codex Entry ID (or Submission ID), the log must be the subject's own, and the quote must appear word for word in that log's Transcript, the builder's own narration, never the review (quote_not_found, not_their_log, no_transcript). For review, architect_answer or doctrine_post (founder markers), source_ref is the Slack link and Slack must confirm the subject posted the message holding the quote (not_their_message, source_unreadable). At most ${essence.RULE.max_per_source} per source; a line the person rejected is refused (previously_rejected); a line already held for them adds this source to it, and a confirmed marker seen in ${essence.RULE.stable_at_sources} sources becomes stable. A proposed marker feeds nothing until the person confirms it. dry_run checks the quote and writes nothing. test: true marks a TEST marker. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      subject_id: { type: 'string', description: 'Slack id of the person the marker is about.' },
      kind: { type: 'string', enum: [...essence.KINDS] },
      line: { type: 'string', description: `The marker: one line, ${essence.RULE.line_max_chars} characters at most.` },
      quote: { type: 'string', description: 'The exact sentence from their own words, copied, not paraphrased.' },
      source_kind: { type: 'string', enum: [...essence.SOURCE_KINDS] },
      source_ref: { type: 'string', description: 'Codex Entry ID for codex_log; the Slack message link otherwise.' },
      confidence: { type: 'number', description: '0 to 1, optional.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person or process proposing it.' },
      test: { type: 'boolean' },
      dry_run: { type: 'boolean' },
    },
    required: ['subject_id', 'kind', 'line', 'quote', 'source_kind', 'source_ref', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Propose an essence marker' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id') || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'propose_essence_marker', args, access: deps.access, kind: 'essence', requester, dry_run: dry });
    try {
      const r = await essence.propose(
        {
          subject_id: str(args, 'subject_id'),
          kind: str(args, 'kind'),
          line: str(args, 'line'),
          quote: str(args, 'quote'),
          source_kind: str(args, 'source_kind'),
          source_ref: str(args, 'source_ref'),
          confidence: typeof args.confidence === 'number' ? args.confidence : null,
          proposed_by: requester ?? (deps.agent ? `agent:${deps.agent}` : 'unknown'),
          test: args.test === true,
        },
        { dry_run: dry, via: `mcp:${deps.access}` },
      );
      await auditClose(audit, { outcome: dry ? 'dry_run' : r.written ? (r.outcome === 'proposed' ? 'inserted' : 'updated') : 'unchanged', detail: r.message, natural_id: (r.marker as { marker_id?: string }).marker_id ?? null, after: r.marker });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof essence.EssenceError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was written.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was written.`, raise: true, audit_id: audit };
    }
  },
};

export const decideEssenceMarker: ToolDefinition = {
  name: 'decide_essence_marker',
  description: `The subject's own decision on one of their essence markers: confirm ("That's me"), reject ("Not me"), publish (share a confirmed marker) or unpublish. HELD HERE: requester_user_id must be the person the marker is about; nobody decides for them, Destiny and Jason included (not_the_subject). Confirm only from proposed; publish only a confirmed or stable marker; reject also makes it private. Refused on any agent token. dry_run writes nothing. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      marker_id: { type: 'string', description: 'EM-…' },
      action: { type: 'string', enum: [...essence.ACTIONS] },
      requester_user_id: { type: 'string', description: 'Slack id of the person deciding: the marker\'s subject.' },
      note: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['marker_id', 'action', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Confirm, reject or share an essence marker' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id') || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'decide_essence_marker', args, access: deps.access, kind: 'essence', requester, dry_run: dry });
    if (deps.agent) {
      const message = `An agent (${deps.agent}) may not decide an essence marker: only the person it is about can.`;
      await auditClose(audit, { outcome: 'refused', detail: `agent_not_permitted: ${message}`, guard_result: { reason: 'agent_not_permitted' } });
      return { ok: false, written: false, reason: 'agent_not_permitted', message: `${message} Nothing was changed.`, audit_id: audit };
    }
    try {
      const r = await essence.decide({ marker_id: str(args, 'marker_id'), action: str(args, 'action'), requester_user_id: requester ?? '', note: str(args, 'note') || null, dry_run: dry });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'updated', detail: r.message, natural_id: r.marker.marker_id, after: r.marker });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof essence.EssenceError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was changed.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was changed.`, raise: true, audit_id: audit };
    }
  },
};

export const ESSENCE_READ_TOOLS: ToolDefinition[] = [readEssence];
export const ESSENCE_WRITE_TOOLS: ToolDefinition[] = [proposeEssenceMarker, decideEssenceMarker];
