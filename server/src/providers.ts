/**
 * Which AI provider each part of the engine runs on (8 Nov 2026, Destiny — Jason on the 7 Nov log,
 * C0AFPJ5S1C1 1794079823.258049: provider inventories as canonical data, so Genie and BHARAG do not
 * rely on n8n or Render logs). One read, `read_providers`, nothing typed by hand:
 *
 *   - the n8n agents (Bays, North Star, Research Twin, Media Twin) and their backups, from
 *     engine_agent_inventory (what n8n said when the inventory was last recorded), paired by name;
 *     each with the last time its main failed over to the backup (`ai_provider_fallback`);
 *   - the eval runner: it asks each agent's main and falls back to its backup, so its provider is
 *     the agents'; what really answered on its latest run is the `eval_run_cost` event's answered_by;
 *   - the repair bridge: its own /health says its primary provider and whether a backup is set;
 *   - the CST voice and WhatsApp agents: their ElevenLabs config, read now with ELEVENLABS_READ_KEY.
 *
 * A source that cannot be read says so and why; nothing falls back to a remembered value. Every
 * part says where its answer came from and when, so a stale read is never taken for a live one.
 */
import { query } from './pg';
import * as sr from './serviceReads';

type Dict = Record<string, unknown>;

export const CST_AGENTS = [
  { part: 'CST voice agent', id: 'agent_5701m66tmyfseeyt84r3rcwrg3b7' },
  { part: 'CST WhatsApp agent', id: 'agent_4001m6xekyhzfs4vek064jvr8c8j' },
];

/** Pure: which company a model string runs through. */
export function providerOf(model: string | null | undefined): string {
  const m = String(model || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.startsWith('openrouter/') || m.includes('openrouter')) return 'OpenRouter';
  if (m.startsWith('anthropic/') || m.startsWith('claude')) return 'Anthropic';
  if (m.startsWith('openai/') || m.startsWith('gpt')) return 'OpenAI';
  if (m.startsWith('google/') || m.startsWith('gemini')) return 'Google';
  return 'other';
}

interface InvRow { agent_id: string; name: string; model: string | null; published: boolean; read_at: string | null }

/** Pure: pair each "X (Agent)" with "X (OpenRouter backup)" (or any "X (... backup)"). */
export function pairAgents(rows: InvRow[]) {
  const base = (n: string) => n.replace(/\s*\((agent|[^)]*backup)\)\s*$/i, '').trim();
  const isBackup = (n: string) => /\([^)]*backup\)\s*$/i.test(n);
  const groups = new Map<string, { main?: InvRow; backup?: InvRow }>();
  for (const r of rows) {
    const k = base(r.name);
    const g = groups.get(k) ?? {};
    if (isBackup(r.name)) g.backup = r; else g.main = r;
    groups.set(k, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, g]) => ({
      part: agent,
      kind: 'n8n agent',
      main: g.main ? { agent_id: g.main.agent_id, model: g.main.model, provider: providerOf(g.main.model), published: g.main.published } : null,
      backup: g.backup ? { agent_id: g.backup.agent_id, model: g.backup.model, provider: providerOf(g.backup.model), published: g.backup.published } : null,
      read_from: 'engine_agent_inventory (n8n, at the last record_agent_inventory)',
      read_at: [g.main?.read_at, g.backup?.read_at].filter(Boolean).sort()[0] ?? null,
    }));
}

/** Pure: the LLM an ElevenLabs agent config names. */
export function elevenLabsLlm(cfg: Dict): { model: string | null; backup: string | null } {
  const prompt = ((cfg.conversation_config as Dict)?.agent as Dict)?.prompt as Dict | undefined;
  const model = typeof prompt?.llm === 'string' ? prompt.llm : null;
  const b = prompt?.backup_llm_config as Dict | undefined;
  const backup = b && Array.isArray(b.preference) && b.preference.length ? String(b.preference[0]) : b && typeof b.llm === 'string' ? b.llm : null;
  return { model, backup };
}

async function bridgeHealth(fetcher: typeof fetch) {
  const url = `${(process.env.REPAIR_BRIDGE_URL || 'https://heal.bhanetwork.org').replace(/\/+$/, '')}/health`;
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false as const, error: `the repair bridge answered ${r.status}` };
    const b = (await r.json()) as Dict;
    return { ok: true as const, primary: String(b.primary_provider ?? 'unknown'), backup_configured: b.fallback_configured === true };
  } catch (e) {
    return { ok: false as const, error: `the repair bridge could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function elevenLabs(id: string, fetcher: typeof fetch) {
  const t = sr.target('elevenlabs', `/convai/agents/${id}`);
  if ('missing' in t) return { ok: false as const, error: `not configured: ${t.missing} is not set` };
  try {
    const r = await fetcher(t.url, { headers: t.headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false as const, error: `ElevenLabs answered ${r.status}` };
    return { ok: true as const, ...elevenLabsLlm((await r.json()) as Dict) };
  } catch (e) {
    return { ok: false as const, error: `ElevenLabs could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const NAME_BRAND: Record<string, string> = { 'claude': 'Anthropic', 'gpt': 'OpenAI', 'gemini': 'Google', 'qwen': 'Alibaba', 'glm': 'Zhipu' };
const elevenProvider = (m: string | null) => {
  if (!m) return 'unknown';
  const hit = Object.entries(NAME_BRAND).find(([k]) => m.toLowerCase().startsWith(k));
  return hit ? `${hit[1]} (through ElevenLabs)` : 'ElevenLabs';
};

export async function read(fetcher: typeof fetch = fetch) {
  const at = new Date().toISOString();
  const [inv, fallbacks, evalRun, bridge, ...cst] = await Promise.all([
    query<InvRow>(`SELECT agent_id, name, model, published, read_at FROM engine_agent_inventory ORDER BY name`),
    query<{ primary_agent: string; at: string; forced: boolean; ok: boolean }>(
      `SELECT DISTINCT ON (detail->>'primary_agent') detail->>'primary_agent' AS primary_agent,
              to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
              coalesce(detail->>'primary_error', '') ILIKE '%forced for a test%' AS forced,
              coalesce((detail->>'fallback_ok')::boolean, false) AS ok
         FROM engine_events WHERE event_type = 'ai_provider_fallback' AND detail ? 'primary_agent'
        ORDER BY detail->>'primary_agent', at DESC`,
    ),
    query<{ run_id: string; at: string; answered_by: Dict | null }>(
      `SELECT subject_id AS run_id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, detail->'answered_by' AS answered_by
         FROM engine_events WHERE event_type = 'eval_run_cost' ORDER BY at DESC LIMIT 1`,
    ),
    bridgeHealth(fetcher),
    ...CST_AGENTS.map((a) => elevenLabs(a.id, fetcher)),
  ]);
  const fb = new Map(fallbacks.rows.map((r) => [r.primary_agent, r]));
  const agents = pairAgents(inv.rows).map((a) => {
    const f = a.main ? fb.get(a.main.agent_id) : undefined;
    return {
      ...a,
      last_fallback: f ? { at: f.at, answered: f.ok, proof_type: f.forced ? 'test_forced' : 'live_natural' } : null,
    };
  });
  const latest = evalRun.rows[0];
  const parts = [
    ...agents,
    {
      part: 'Eval runner',
      kind: 'n8n workflow (Agent Evals — Runner)',
      main: { provider: 'each agent\'s main (see the agents above)' },
      backup: { provider: 'each agent\'s backup, when the main cannot answer' },
      latest_run: latest ? { run_id: latest.run_id, at: latest.at, answered_by: latest.answered_by ?? {} } : null,
      read_from: 'the agents above, and the latest eval_run_cost event for what really answered',
      read_at: latest?.at ?? null,
    },
    bridge.ok
      ? { part: 'Repair bridge', kind: 'Render service (bha-repair-bridge)', main: { provider: bridge.primary === 'openrouter' ? 'OpenRouter' : 'Anthropic' }, backup: { provider: bridge.primary === 'openrouter' ? 'Anthropic' : 'OpenRouter', configured: bridge.backup_configured }, read_from: 'the bridge\'s own /health, read now', read_at: at }
      : { part: 'Repair bridge', kind: 'Render service (bha-repair-bridge)', main: null, backup: null, unread: bridge.error, read_from: 'the bridge\'s own /health', read_at: null },
    ...CST_AGENTS.map((a, i) => {
      const r = cst[i];
      return r.ok
        ? { part: a.part, kind: `ElevenLabs agent ${a.id}`, main: { model: r.model, provider: elevenProvider(r.model) }, backup: r.backup ? { model: r.backup, provider: elevenProvider(r.backup) } : null, read_from: 'the agent\'s ElevenLabs config, read now', read_at: at }
        : { part: a.part, kind: `ElevenLabs agent ${a.id}`, main: null, backup: null, unread: r.error, read_from: 'the agent\'s ElevenLabs config', read_at: null };
    }),
  ];
  const unread = parts.filter((p) => 'unread' in p && p.unread).map((p) => p.part);
  return {
    at,
    parts,
    unread,
    note: unread.length
      ? `Not read this time: ${unread.join(', ')}. Their provider is not known from here, and nothing is filled in from memory.`
      : 'Every part was read from its own source.',
    rules: [
      'An n8n agent\'s model is what n8n said at the last record_agent_inventory; record it again after an agent publish, or this is out of date.',
      'last_fallback.proof_type says whether the newest failover was forced for a test (test_forced) or happened on its own (live_natural).',
    ],
  };
}
