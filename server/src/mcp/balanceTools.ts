/**
 * `check_service_balances` (28 Oct 2026, Destiny): the OpenRouter and Twilio balances, read now.
 * Read only, both connections, in Bays' scope. The read and the floors are ../serviceBalances.ts.
 */
import * as balances from '../serviceBalances';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';

export const checkServiceBalances: ToolDefinition = {
  name: 'check_service_balances',
  description: `The two balances the engine pays to keep running, read now: OpenRouter (the model credit every agent runs on) and Twilio (the Customer Service Twin's calls and texts). Use it when someone asks how much credit is left, whether to top up, or why an agent or CST is failing on credit. Each comes back as status ok (above its floor), low (under it: say it needs a top-up) or unreadable (with the reason: say it could not be read, never guess a number). The floors are the SOP Critical Service Credits: OpenRouter $${balances.FLOORS_USD.openrouter}, Twilio $${balances.FLOORS_USD.twilio}. summary is one sentence per service, ready to quote. Both reads are free and spend nothing. Read only: it never tops anything up.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Check the OpenRouter and Twilio balances' },
  handler: async (_args, deps) => {
    const t0 = Date.now();
    const out = await balances.check();
    const fmt = (b: balances.ServiceBalance) => `${b.service} ${b.status}${b.remaining_usd !== null ? ` $${b.remaining_usd}` : ''}`;
    await mirror.logWrite({ endpoint: 'mcp:check_service_balances', kind: 'service_balances', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${fmt(out.openrouter)}, ${fmt(out.twilio)}${out.reason ? ` (${out.reason})` : ''}`, ms: Date.now() - t0 });
    return out;
  },
};

export const BALANCE_READ_TOOLS: ToolDefinition[] = [checkServiceBalances];
