/**
 * `read_providers` (8 Nov 2026, Destiny — Jason on the 7 Nov log). Which AI provider every part of the
 * engine runs on, main and backup, each read from its own source now: the n8n agents' inventory, the eval
 * runner's latest run, the repair bridge's /health and the CST voice and WhatsApp agents' ElevenLabs
 * config. `providers.read` holds the rules. A read.
 */
import * as mirror from '../mirror';
import * as providers from '../providers';
import type { ToolDefinition } from './tools';

export const readProviders: ToolDefinition = {
  name: 'read_providers',
  description:
    'Which AI provider every part of the engine runs on, main and backup: the n8n agents (Bays, North Star, Research Twin, Media Twin) with the last time each failed over to its backup and whether that was forced for a test or happened on its own; the eval runner and what really answered on its latest run; the repair bridge (its own health check, read now); and the CST voice and WhatsApp agents (their ElevenLabs config, read now). A part that could not be read is named in unread with the reason, never filled in. Answer "what does X run on" or "what is the backup for X" from this. Read only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Which AI provider each part runs on' },
  handler: async (_args, deps) => {
    const t0 = Date.now();
    const r = await providers.read();
    await mirror.logWrite({
      endpoint: 'mcp:read_providers', kind: 'providers', method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read',
      detail: `${r.parts.length} parts, unread: ${r.unread.join(', ') || 'none'}`.slice(0, 400), ms: Date.now() - t0,
    });
    return { ok: true, ...r };
  },
};

export const PROVIDER_READ_TOOLS: ToolDefinition[] = [readProviders];
