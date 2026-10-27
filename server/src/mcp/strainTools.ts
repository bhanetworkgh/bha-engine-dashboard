/**
 * `read_engine_strain` (27 Oct 2026, Destiny — 7RZT). Whether the engine is running short of AI credit or answering
 * on its backup, and what each audience may be told: the team, a pilot operator, an early buyer, the Media Twin and
 * Slack Genie. Genie answers "is the engine under strain?" from this, never from raw events or its own guess.
 * The rule and the audience lines are `engineStrain.assess`, so the page and this tool cannot word it differently.
 */
import * as mirror from '../mirror';
import * as strain from '../engineStrain';
import type { ToolDefinition } from './tools';

export const readEngineStrain: ToolDefinition = {
  name: 'read_engine_strain',
  description:
    'Is the engine under strain right now, and what may each audience be told? Reads the three states that mean the engine is running short or around a fault: OpenRouter credit refusals and the runs held until the balance can pay; answers that came from the Anthropic backup (and whether each was a real answer); and parked Codex logs voided. Returns state (normal, strained: something in the last hour or runs held now, recovering: earlier in the window only), a one-sentence summary, the reasons with their numbers, and audiences: the exact line for the team, a pilot operator, an early buyer, the Media Twin and Slack Genie. Outside the team the line is the effect in plain words (slower, nothing lost, a person answers), never the mechanics and never "down". Answer a strain question from audiences, word for word in substance. hours sets the window (default 24, at most 168). Read only.',
  inputSchema: {
    type: 'object',
    properties: { hours: { type: 'number', description: 'How many hours back to read. Default 24, at most 168.' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Engine strain and what each audience is told' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const r = await strain.read(Number(args.hours) || 24);
    await mirror.logWrite({
      endpoint: 'mcp:read_engine_strain', kind: 'engine_strain', method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read',
      detail: `${r.counts.hours}h → ${r.state}`.slice(0, 400), ms: Date.now() - t0,
    });
    return { ok: true, ...r };
  },
};

export const STRAIN_READ_TOOLS: ToolDefinition[] = [readEngineStrain];
