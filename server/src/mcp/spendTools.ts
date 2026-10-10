/**
 * What each agent spends, read from its own ask ledger (10 Oct 2026, Destiny —
 * agent maturity re-score: "no per-agent spend or token field on any of the
 * three ask ledgers").
 *
 * From 10 Oct the three Agent Delivery workflows write, on every ask row, what
 * the agent node itself reported: Prompt Tokens, Completion Tokens, Total
 * Tokens, Tool Call Count and Tool Calls (the tool names, in order). This tool
 * adds them up per agent. It is tokens, not money: no price is stored here, and
 * a currency figure would be an estimate dressed as a fact. An ask written
 * before the fields existed, a scheduled run (which never passes through a
 * delivery workflow) and a failed run carry no tokens, and are counted apart,
 * never as nought.
 */
import { query } from '../pg';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';

const LEDGERS: Array<{ agent: string; table: string }> = [
  { agent: 'bays', table: 'engine_bays_asks' },
  { agent: 'north_star', table: 'engine_ns_asks' },
  { agent: 'research_twin', table: 'engine_rt_asks' },
];

export const TOKENS_SINCE = '2026-10-10';

export async function spend(days: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const l of LEDGERS) {
    const r = await query<Record<string, unknown>>(
      `WITH a AS (
         SELECT nullif(fields->>'Total Tokens', '')::numeric AS total,
                nullif(fields->>'Prompt Tokens', '')::numeric AS prompt,
                nullif(fields->>'Completion Tokens', '')::numeric AS completion,
                nullif(fields->>'Tool Call Count', '')::numeric AS calls
           FROM ${l.table}
          WHERE first_seen_at::timestamptz > now() - make_interval(days => $1::int)
       )
       SELECT count(*)::int AS asks,
              count(total)::int AS asks_with_tokens,
              coalesce(sum(prompt), 0)::bigint AS prompt_tokens,
              coalesce(sum(completion), 0)::bigint AS completion_tokens,
              coalesce(sum(total), 0)::bigint AS total_tokens,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY total)::bigint AS tokens_per_ask_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY total)::bigint AS tokens_per_ask_p95,
              max(total)::bigint AS tokens_per_ask_max,
              coalesce(sum(calls), 0)::int AS tool_calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY calls)::numeric AS tool_calls_per_ask_p50
         FROM a`,
      [days],
    );
    const tools = await query<{ tool: string; n: number }>(
      `SELECT t AS tool, count(*)::int AS n
         FROM ${l.table}, unnest(string_to_array(fields->>'Tool Calls', ' > ')) AS t
        WHERE first_seen_at::timestamptz > now() - make_interval(days => $1::int) AND coalesce(fields->>'Tool Calls', '') <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`,
      [days],
    );
    const daily = await query<{ day: string; asks: number; total_tokens: string }>(
      `SELECT to_char(first_seen_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS asks,
              coalesce(sum(nullif(fields->>'Total Tokens', '')::numeric), 0)::bigint AS total_tokens
         FROM ${l.table}
        WHERE first_seen_at::timestamptz > now() - make_interval(days => $1::int) AND nullif(fields->>'Total Tokens', '') IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC`,
      [days],
    );
    const row = r.rows[0] ?? {};
    out.push({ agent: l.agent, ...row, asks_without_tokens: Number(row.asks ?? 0) - Number(row.asks_with_tokens ?? 0), top_tools: tools.rows, by_day: daily.rows });
  }
  return out;
}

export const getAgentSpend: ToolDefinition = {
  name: 'get_agent_spend',
  description:
    `Tokens and tool calls per agent (Bays, North Star, Research Twin), added up from each agent's own ask ledger. For each agent over the window: asks, how many carried a token count, prompt, completion and total tokens, tokens per ask as p50, p95 and max, tool calls, the tools called most, and tokens by day. Tokens, not money: no price is stored. The fields were first written on ${TOKENS_SINCE}; an older ask, a scheduled task run and a failed run carry none and are counted as asks_without_tokens, never as nought. Read only.`,
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'number', description: 'How many days back to read. Default 7, at most 90.' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Tokens and tool calls per agent' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const days = Math.max(1, Math.min(90, Math.floor(Number(args.days)) || 7));
    const agents = await spend(days);
    await mirror.logWrite({ endpoint: 'mcp:get_agent_spend', kind: 'agent_spend', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${days}d → ${agents.map((a) => `${a.agent} ${a.total_tokens}`).join(', ')}`.slice(0, 400), ms: Date.now() - t0 });
    return {
      ok: true,
      window_days: days,
      tokens_recorded_since: TOKENS_SINCE,
      agents,
      notes: [
        'Tokens are what the agent node reported for the whole run of one ask, prompt and completion, cached prompt tokens included.',
        'No price is stored, so there is no currency figure. The OpenRouter balance is on get_recovery_status and the hourly credit check.',
        'asks_without_tokens are asks from before the fields existed, scheduled task runs and failed runs. They are not nought tokens.',
      ],
    };
  },
};

export const SPEND_READ_TOOLS: ToolDefinition[] = [getAgentSpend];
