/**
 * `read_genie_builder` (9 Nov 2026, Destiny — the Logstream side of the genie-slack-n8n rail,
 * #bha-coordination 1793566544.600759). Every Genie Builder interaction Genie has reported, one row
 * per interaction_id with its four stages, and the figures the rev 5 proof is read from: how often
 * Genie's work was accepted, modified or rejected, the average usefulness rating, how many were left
 * unreviewed, and test_forced kept apart from live_natural. genieBuilder.read holds the rules. A read.
 */
import * as mirror from '../mirror';
import * as genieBuilder from '../genieBuilder';
import type { ToolDefinition } from './tools';

export const readGenieBuilder: ToolDefinition = {
  name: 'read_genie_builder',
  description:
    'Genie Builder interactions as Genie reported them (rail genie-slack-n8n first): one row per interaction_id with what was asked and by whom, whether it touched anything live and why, who approved and the two-builder check, what n8n built and its debrief, live_effect, and the builder\'s decision and 1 to 5 rating; plus the summary the proof is read from (accepted / modified / rejected, average rating, awaiting review, failed feedback loops), split into live_natural and test_forced. Only a reviewed interaction counts toward the proof, and a test_forced one is never real use. Filter by rail_id or interaction_id. Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      rail_id: { type: 'string', description: 'e.g. genie-slack-n8n.' },
      interaction_id: { type: 'string', description: 'One interaction, Genie\'s request_id.' },
      limit: { type: 'number', description: 'Rows to return, newest first. Default 50, at most 200. The summary is always over every row.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Genie Builder interactions and their proof figures' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
    const r = await genieBuilder.read({
      rail_id: typeof args.rail_id === 'string' ? args.rail_id.trim() || null : null,
      interaction_id: typeof args.interaction_id === 'string' ? args.interaction_id.trim() || null : null,
      limit,
    });
    await mirror.logWrite({
      endpoint: 'mcp:read_genie_builder', kind: 'genie_builder', method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read',
      detail: `${r.returned} of ${r.held} interaction(s); ${r.summary.all.counted_toward_proof} counted toward the proof`, ms: Date.now() - t0,
    });
    return {
      ok: true,
      ...r,
      ...(r.held === 0 ? { note: 'No Genie Builder interaction has arrived yet. Genie sends them to POST /api/engine/genie-builder once Kaiqi wires the rail (due Wed 18 Nov); nothing here is a guess.' } : {}),
    };
  },
};

export const GENIE_BUILDER_READ_TOOLS: ToolDefinition[] = [readGenieBuilder];
