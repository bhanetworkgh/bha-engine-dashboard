/** Provider usage from original n8n model nodes. Never stores prompts, keys or answers. */
import { query } from './pg';
import * as n8n from './n8n';

type Obj = Record<string, any>;
export interface Usage { provider: string; model: string | null; input: number; output: number; read: number | null; write5: number | null; write1: number | null; cost: number | null; }
const number = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;

/** Native response rates include cache writes, and Haiku's per-request long-context tier. */
export function nativeCost(model: string, input: number, output: number, read: number, write5: number, write1: number): number | null {
  let rate: number, out: number, hit: number;
  if (/haiku-5[.-]5/.test(model)) { rate = input + read + write5 + write1 > 100_000 ? 0.5 : 0.1; out = rate * 5; hit = rate * 0.1; }
  else if (/sonnet-5$/.test(model)) { rate = 2; out = 10; hit = .2; }
  else if (/opus-5[.-]5/.test(model)) { rate = 4; out = 20; hit = .2; }
  else return null;
  return (input * rate + output * out + read * hit + write5 * rate * 1.25 + write1 * rate * 2) / 1e6;
}

export function responseUsage(node: Obj, json: Obj): Usage | null {
  const u = json.usage;
  if (!u || typeof u !== 'object') return null;
  const url = String(node.parameters?.url || '');
  // Code-node response adapters and forwarded agent answers are deliberately excluded.
  if (node.type === 'n8n-nodes-base.httpRequest' && url.startsWith('https://api.anthropic.com/')) {
    const input = number(u.input_tokens), output = number(u.output_tokens);
    if (input === null || output === null) return null;
    const read = number(u.cache_read_input_tokens), totalWrite = number(u.cache_creation_input_tokens);
    const write5 = number(u.cache_creation?.ephemeral_5m_input_tokens);
    const write1 = number(u.cache_creation?.ephemeral_1h_input_tokens);
    const model = typeof json.model === 'string' ? json.model : null;
    // Unknown split is not silently priced as a five-minute write.
    const complete = read !== null && totalWrite !== null && (totalWrite === 0 || (write5 !== null && write1 !== null && write5 + write1 === totalWrite));
    const cost = complete && model ? nativeCost(model, input, output, read!, write5 ?? 0, write1 ?? 0) : null;
    const geo = json.usage.inference_geo === 'us' ? 1.1 : 1;
    // Web search is $10/1,000 requests in addition to token charges.
    const search = number(u.server_tool_use?.web_search_requests) ?? 0;
    return { provider: 'anthropic', model, input: input + (read ?? 0) + (totalWrite ?? 0), output, read, write5: totalWrite === 0 ? 0 : write5, write1: totalWrite === 0 ? 0 : write1, cost: cost === null ? null : cost * geo + search * .01 };
  }
  if (node.type === 'n8n-nodes-base.httpRequest' && /https:\/\/openrouter\.ai\//.test(url)) {
    const input = number(u.prompt_tokens), output = number(u.completion_tokens);
    if (input === null || output === null) return null;
    return { provider: 'openrouter', model: typeof json.model === 'string' ? json.model : null, input, output, read: number(u.prompt_tokens_details?.cached_tokens), write5: null, write1: null, cost: number(u.cost) };
  }
  if (node.type === 'n8n-nodes-base.messageAnAgent') {
    const input = number(u.promptTokens ?? u.inputTokens), output = number(u.completionTokens ?? u.outputTokens);
    if (input === null || output === null) return null;
    // Provider stamped by the delivery/eval graph, not guessed from today's agent name.
    const provider = json.model_provider === 'anthropic' || json.model_provider === 'openrouter' ? json.model_provider : 'unattributed';
    return { provider, model: typeof json.model === 'string' ? json.model : null, input, output, read: number(u.inputTokenDetails?.cacheReadTokens), write5: null, write1: null, cost: null };
  }
  return null;
}

export async function storeUsage(key: string, at: string, workflow: string, node: string, usage: Usage): Promise<void> {
  await query(`INSERT INTO engine_model_calls (call_key, at, workflow_id, node_name, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, estimated_usd)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (call_key) DO NOTHING`,
  [key, at, workflow, node, usage.provider, usage.model, usage.input, usage.output, usage.read, usage.write5, usage.write1, usage.cost]);
}

let busy = false;
let lastError: string | null = null;
let lastScan: string | null = null;
export async function collectUsage(): Promise<void> {
  if (busy || !n8n.n8nConfigured()) return;
  busy = true;
  try {
    const cutovers = await query<{ at: string; detail: Obj }>("SELECT at::text, detail FROM engine_events WHERE event_type='provider_migration_cutover' ORDER BY at");
    const pending = await query<{ execution_id: string }>(`SELECT e.execution_id FROM engine_execution_runs e
      LEFT JOIN engine_model_usage_scans s ON s.execution_id=e.execution_id
      WHERE e.id_epoch=0 AND e.status IN ('success','error','crashed','canceled') AND e.started_at >= '2026-11-03T00:00:00Z'
        AND s.execution_id IS NULL ORDER BY e.execution_id ASC LIMIT 40`);
    for (const row of pending.rows) {
      const execution = await n8n.executionDetail(String(row.execution_id)) as (n8n.N8nExecutionDetail & { data?: Obj }) | null;
      if (execution) {
        const nodes = execution.workflowData?.nodes ?? [];
        const runs = execution.data?.resultData?.runData ?? {};
        for (const node of nodes) {
          if (!['n8n-nodes-base.httpRequest', 'n8n-nodes-base.messageAnAgent'].includes(node.type ?? '')) continue;
          for (const [runIndex, run] of (runs[node.name] ?? []).entries()) {
            for (const [outputIndex, items] of (run.data?.main ?? []).entries()) {
              for (const [itemIndex, item] of (items ?? []).entries()) {
                const json = { ...(item.json ?? {}) };
                if (node.type === 'n8n-nodes-base.messageAnAgent') {
                  const id = (node.parameters?.agentId as Obj)?.value;
                  const binding = [...cutovers.rows].reverse().find(c => Date.parse(c.at) <= Date.parse(execution.startedAt!) && c.detail.agent_id === id);
                  if (binding) { json.model_provider = binding.detail.provider; json.model = binding.detail.model; }
                }
                const usage = responseUsage(node, json);
                if (usage) await storeUsage(`n8n:${execution.id}:${node.name}:${runIndex}:${outputIndex}:${itemIndex}`, execution.startedAt!, execution.workflowId, node.name, usage);
              }
            }
          }
        }
      }
      await query('INSERT INTO engine_model_usage_scans (execution_id, available) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.execution_id, Boolean(execution)]);
    }
    lastError = null;
    lastScan = new Date().toISOString();
  } catch (e) { lastError = e instanceof Error ? e.message : String(e); console.error('[model-usage]', lastError); }
  finally { busy = false; }
}

export async function readUsage(since: string) {
  const r = await query(`SELECT provider, count(*)::int AS calls, sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens,
    sum(cache_read_tokens)::float8 AS cache_read_tokens, sum(cache_write_5m_tokens)::float8 AS cache_write_5m_tokens,
    sum(cache_write_1h_tokens)::float8 AS cache_write_1h_tokens, count(*) FILTER (WHERE cache_read_tokens IS NULL)::int AS calls_without_cache_split,
    sum(estimated_usd)::float8 AS estimated_usd, count(*) FILTER (WHERE estimated_usd IS NULL)::int AS unpriced_calls,
    min(at) AS first_at, max(at) AS last_at FROM engine_model_calls WHERE at >= $1 GROUP BY provider ORDER BY provider`, [since]);
  return { since: '2026-11-03', primary: 'anthropic', backup: 'openrouter', last_scan_at: lastScan, last_error: lastError,
    providers: r.rows, note: 'Recorded model-node responses only. Calculated costs are partial, not account invoices. Agent outputs without cache/model details remain unpriced. Scheduled runs, previews, repair CLI and callers outside n8n may be missing. Anthropic credit balance is not available from a standard API key.' };
}
