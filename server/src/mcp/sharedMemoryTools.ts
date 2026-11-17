/**
 * Shared memory and engine awareness over MCP (17 Nov 2026, Destiny — Genie rebuild steps 7 and 8).
 * `read_shared_memory` and `read_engine_activity` are reads, on both connections and in every agent's scope;
 * `write_shared_memory` is on the write connection, in Bays' and Research Twin's scopes. The rules are in
 * `server/src/sharedMemory.ts`.
 */
import * as shared from '../sharedMemory';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const label = (access: string) => (access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET');

export const readSharedMemory: ToolDefinition = {
  name: 'read_shared_memory',
  description:
    "Shared memory across the engine: notes a person asked Genie, Bays or another agent to remember for everyone (who is away, a decision someone stated, how a person wants something done), each with who said it and where. search (words) finds the notes about something; no search gives the newest. A note is a person's word, not a record: anything with a true home (loops, Codex, pay, leads, incidents) is read from that home, and a note never overrides it. Read only.",
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Words to find notes about, e.g. a person or a project.' },
      limit: { type: 'number', description: 'At most this many notes, 1 to 50. Default 15.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read shared memory' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const r = await shared.recall(args);
    await mirror.logWrite({ endpoint: 'mcp:read_shared_memory', kind: 'shared_memory', method: 'MCP', key_label: label(deps.access), outcome: 'read', detail: `${String(args.search ?? 'newest')} → ${(r.notes as unknown[]).length} note(s)`, ms: Date.now() - t0 });
    return r;
  },
};

export const readEngineActivity: ToolDefinition = {
  name: 'read_engine_activity',
  description:
    "What every part of the engine has been doing lately, in one read: Bays', North Star's and Research Twin's latest asks, Genie's latest asks and who they went to, Media Twin's latest drafts, BHA RSS's newest outside digest, and the engine events counted by type. Use it to know what the other agents are working on before answering or acting. hours (default 24, at most 168); per_part (default 5, at most 20). A part with nothing in the window recorded nothing, which is not the same as being down. Read only.",
  inputSchema: {
    type: 'object',
    properties: {
      hours: { type: 'number', description: 'The window, 1 to 168 hours. Default 24.' },
      per_part: { type: 'number', description: 'Latest items per part, 1 to 20. Default 5.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read what the engine is doing' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const r = await shared.activity(args);
    await mirror.logWrite({ endpoint: 'mcp:read_engine_activity', kind: 'events', method: 'MCP', key_label: label(deps.access), outcome: 'read', detail: `${String(r.window_hours)}h`, ms: Date.now() - t0 });
    return r;
  },
};

export const writeSharedMemory: ToolDefinition = {
  name: 'write_shared_memory',
  description:
    "Adds a note to the engine's shared memory, or removes one. Only for what a person explicitly asked to be remembered for everyone, in their own words, with requester_user_id their Slack id and source_ref the message link. Never store a guess, a summary of a record, a secret or a number that has a true home. remove: true with id takes a note out (the person who said it, Destiny or Jason only).",
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'What to remember, in the words it was said. At most 600 characters.' },
      about: { type: 'string', description: 'Who or what it is about, a few words.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person who asked.' },
      source_ref: { type: 'string', description: 'The Slack message link it was said in.' },
      remove: { type: 'boolean', description: 'Remove the note named by id instead.' },
      id: { type: 'string', description: 'MEM-… id, to remove.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Write shared memory' },
  handler: async (args, deps) => {
    const writer = deps.agent ? String(deps.agent) : 'connector';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id : null;
    const audit = await auditOpen({ tool: 'write_shared_memory', args, access: deps.access, kind: 'shared_memory', requester, dry_run: false });
    try {
      const r = args.remove === true
        ? await shared.forget({ id: args.id, requester: args.requester_user_id })
        : await shared.remember({ note: args.note, about: args.about, said_by: args.requester_user_id, source_ref: args.source_ref, written_by: shared.WRITERS.has(writer) ? writer : 'connector' });
      await auditClose(audit, { outcome: r.ok === false ? 'refused' : 'updated', detail: `${args.remove ? 'remove' : 'add'} ${String(r.id ?? r.removed ?? r.reason ?? '')}`, natural_id: String(r.id ?? r.removed ?? '') || null });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof shared.SharedMemoryError) {
        await auditClose(audit, { outcome: 'refused', detail: e.message, guard_result: { reason: e.status === 403 ? 'not_permitted' : 'refused' } });
        return { ok: false, reason: e.status === 403 ? 'not_permitted' : 'refused', message: e.message, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const SHARED_READ_TOOLS: ToolDefinition[] = [readSharedMemory, readEngineActivity];
export const SHARED_WRITE_TOOLS: ToolDefinition[] = [writeSharedMemory];
