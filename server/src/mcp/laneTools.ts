/**
 * The weighted lane ranking over MCP (28 Sep 2026, Destiny and Jason,
 * #bha-north-star-twin 1790611246.825499).
 *
 *   rank_lanes        — read, both connections, and North Star's agent scope.
 *                       The order code computed from laneRanking.ts, with every
 *                       lane's factor scores so the maths can be checked.
 *   set_lane_profile  — write connection only. Sets or clears one lane's tags,
 *                       audited on engine_mcp_writes like every other write.
 *
 * North Star reads this order and never computes its own.
 */
import { query } from '../pg';
import * as mirror from '../mirror';
import { DEFINITIONS, WEIGHTS, ranking } from '../laneRanking';
import { laneHealth } from '../laneHealth';
import { LANES } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const TAGS = ['gates_oct31', 'blocks_others', 'engine_leverage', 'commercial_impact'] as const;

async function logRead(deps: ToolDeps, detail: string, t0: number): Promise<void> {
  await mirror.logWrite({
    endpoint: 'mcp:rank_lanes',
    kind: 'lane_profiles',
    method: 'MCP',
    key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET',
    outcome: 'read',
    detail: detail.slice(0, 400),
    ms: Date.now() - t0,
  });
}

export const rankLanes: ToolDefinition = {
  name: 'rank_lanes',
  description:
    'BHA’s lane priority order, computed in code from fixed weights so the same question always gives the same order (agreed by Jason, 28 Sep). Six factors scored 0–5: gates the Oct 31 launch (25%), blocks other people’s work (20%), engine leverage (20%), commercial impact (15%), days since it last moved (10%, stale ranks higher), effort to close (10%, less effort ranks higher). Score = Σ factor ÷ 5 × weight, 0–100; ties break on lane id. A factor nobody has set scores 0 and is named in that lane’s missing — say so rather than treating the lane as unimportant. kind: "work" (default; the loop lanes such as VFARM_HARDWARE, CST, RT) or "commercial" (the LANE-… ids on cards and research jobs) or "all". Returns weights, definitions, incomplete (lanes with a missing factor) and lanes, each {rank, lane_id, kind, score, factors, missing, sources, days_since_moved, open_items, anchors, note}; contributions per factor when detail is true.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['work', 'commercial', 'all'], description: 'Which lanes. Default work.' },
      limit: { type: 'number', description: 'Top N lanes. Default all of that kind (at most 60).' },
      detail: { type: 'boolean', description: 'Include each factor’s contribution to the score.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Lane priority ranking' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const kind = args.kind === 'commercial' || args.kind === 'all' ? args.kind : 'work';
    const limit = Math.max(1, Math.min(60, Number(args.limit) || 60));
    const r = await ranking(kind);
    const lanes = r.lanes.slice(0, limit).map((l) => {
      const { contributions, last_moved: _last, ...rest } = l;
      return args.detail === true ? { ...rest, contributions } : rest;
    });
    await logRead(deps, `${kind} → ${lanes.length} of ${r.lanes.length} lanes, ${r.incomplete} incomplete; top ${lanes.slice(0, 3).map((l) => `${l.lane_id} ${l.score}`).join(', ')}`, t0);
    return { ...r, total_lanes: r.lanes.length, returned: lanes.length, lanes };
  },
};

function score05(v: unknown, name: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error(`${name} must be a whole number 0–5, or null to clear it.`);
  return n;
}

export const setLaneProfile: ToolDefinition = {
  name: 'set_lane_profile',
  description:
    'Set or clear one lane’s ranking tags — the inputs rank_lanes cannot compute. gates_oct31, blocks_others, engine_leverage, commercial_impact: whole numbers 0–5, or null to clear. effort: small, medium or large (the owner’s estimate), or null. linked_lanes: the commercial LANE-… ids whose research belongs to this lane. anchors: the named items this lane carries (loop ids, contracts), replacing the list. note: why. Only the fields sent change. A lane id is a loop lane (VFARM_HARDWARE, CST, …) or a commercial LANE-… id; kind is inferred (LANE-… is commercial) unless given. Audited on engine_mcp_writes; dry_run shows the change without saving. Returns before, after and the lane’s new rank.',
  inputSchema: {
    type: 'object',
    properties: {
      lane_id: { type: 'string' },
      kind: { type: 'string', enum: ['work', 'commercial'] },
      gates_oct31: { type: ['number', 'null'] },
      blocks_others: { type: ['number', 'null'] },
      engine_leverage: { type: ['number', 'null'] },
      commercial_impact: { type: ['number', 'null'] },
      effort: { type: ['string', 'null'], enum: ['small', 'medium', 'large', null] },
      anchors: { type: 'array', items: { type: 'string' } },
      linked_lanes: { type: 'array', items: { type: 'string' }, description: 'Commercial LANE-… ids whose research (Research Twin jobs) belongs to this lane, replacing the list.' },
      note: { type: 'string' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking, for the audit line.' },
      dry_run: { type: 'boolean' },
    },
    required: ['lane_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Set a lane’s ranking tags' },
  handler: async (args, deps) => {
    const dry = args.dry_run === true;
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const audit = await auditOpen({ tool: 'set_lane_profile', args, access: deps.access, kind: 'lane_profiles', requester, dry_run: dry });
    try {
      const laneId = typeof args.lane_id === 'string' ? args.lane_id.trim() : '';
      if (!laneId || !/^[A-Z0-9_\-]{2,80}$/.test(laneId)) {
        await auditClose(audit, { outcome: 'refused', detail: 'bad lane_id' });
        return { ok: false, reason: 'bad_lane_id', message: 'lane_id must be an upper-case lane id such as VFARM_HARDWARE or LANE-VFARM-ZONE_MONITORING_SAAS.', known_work_lanes: LANES, audit_id: audit };
      }
      const before = (await query<Record<string, unknown>>(`SELECT * FROM engine_lane_profiles WHERE lane_id = $1`, [laneId])).rows[0] ?? null;
      const set: Record<string, unknown> = {};
      for (const t of TAGS) {
        const v = score05(args[t], t);
        if (v !== undefined) set[t] = v;
      }
      if (args.effort !== undefined) {
        if (args.effort !== null && !['small', 'medium', 'large'].includes(String(args.effort))) throw new Error('effort must be small, medium, large or null.');
        set.effort = args.effort;
      }
      if (Array.isArray(args.anchors)) set.anchors = args.anchors.map((a) => String(a).trim()).filter(Boolean).slice(0, 20);
      if (Array.isArray(args.linked_lanes)) {
        const links = args.linked_lanes.map((a) => String(a).trim()).filter(Boolean);
        const bad = links.filter((x) => !/^LANE-[A-Z0-9_\-]+$/.test(x));
        if (bad.length) throw new Error(`linked_lanes takes commercial LANE-… ids only; not one: ${bad.join(', ')}`);
        set.linked_lanes = Array.from(new Set(links)).slice(0, 20);
      }
      if (typeof args.note === 'string') set.note = args.note.trim().slice(0, 500) || null;
      const kind = args.kind === 'work' || args.kind === 'commercial' ? args.kind : (before?.kind as string) ?? (laneId.startsWith('LANE-') ? 'commercial' : 'work');
      if (Object.keys(set).length === 0 && before) {
        await auditClose(audit, { outcome: 'refused', detail: 'nothing to change', natural_id: laneId });
        return { ok: false, reason: 'nothing_to_change', message: 'Send at least one tag, effort, anchors or note.', before, audit_id: audit };
      }
      const after = { ...(before ?? { lane_id: laneId, anchors: [] }), ...set, kind };
      if (dry) {
        await auditClose(audit, { outcome: 'dry_run', detail: `would set ${Object.keys(set).join(', ') || 'a new empty profile'}`, natural_id: laneId, after });
        return { ok: true, dry_run: true, lane_id: laneId, before, after, audit_id: audit };
      }
      const cols = ['lane_id', 'kind', ...Object.keys(set), 'updated_by'];
      const vals = [laneId, kind, ...Object.values(set), requester ?? `mcp:${deps.access}`];
      const ph = cols.map((_, i) => `$${i + 1}`);
      const upd = cols.filter((c) => c !== 'lane_id').map((c) => `${c} = EXCLUDED.${c}`).concat('updated_at = now()');
      const saved = (
        await query<Record<string, unknown>>(
          `INSERT INTO engine_lane_profiles (${cols.join(', ')}) VALUES (${ph.join(', ')})
           ON CONFLICT (lane_id) DO UPDATE SET ${upd.join(', ')} RETURNING *`,
          vals,
        )
      ).rows[0];
      const r = await ranking(kind as 'work' | 'commercial');
      const placed = r.lanes.find((l) => l.lane_id === laneId) ?? null;
      await auditClose(audit, { outcome: 'applied', detail: `set ${Object.keys(set).join(', ')}; now rank ${placed?.rank ?? '?'} score ${placed?.score ?? '?'}`, natural_id: laneId, after: saved });
      return { ok: true, lane_id: laneId, before, after: saved, rank: placed?.rank ?? null, score: placed?.score ?? null, missing: placed?.missing ?? null, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'refused', detail: message });
      return { ok: false, reason: 'bad_argument', message, audit_id: audit };
    }
  },
};

export const laneHealthTool: ToolDefinition = {
  name: 'lane_health',
  description:
    'Each ranked lane’s health, as the loop Jason asked for (28 Sep): rank, score and six factors; research state (not_started, in_queue, active, answered, stale) with its gleanings — resolved Research Twin jobs as {job_id, asked, found, confidence, limits, needs_depth, resolved_at, stale} — and a re-entry signal action (first_pass, deeper_pass, none) with its reason; self-heal state (open incidents, incidents in 14 days, recurring fault signatures) for the lanes that have workflows (BAYS, NS, RT), and "not instrumented" for the rest; Codex logs touching the lane in 14 days, awaiting evaluation or evaluated (autopaid is null until the rule exists); and convergence — loops opened against closed in 14 days — as converging, steady or churning. Computed from rows the engine already keeps; nothing is written. kind work (default), commercial or all; lane_id for one lane.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['work', 'commercial', 'all'] },
      lane_id: { type: 'string', description: 'One lane, e.g. VFARM_HARDWARE or LANE-VFARM-SELF_HEALING_ENGINE.' },
      limit: { type: 'number', description: 'Top N lanes. Default 10, at most 60.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Lane health and convergence' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const kind = args.kind === 'commercial' || args.kind === 'all' ? args.kind : 'work';
    const laneId = typeof args.lane_id === 'string' && args.lane_id.trim() ? args.lane_id.trim() : undefined;
    const limit = Math.max(1, Math.min(60, Number(args.limit) || 10));
    const h = await laneHealth({ kind: laneId ? 'all' : kind, lane_id: laneId });
    const lanes = h.lanes.slice(0, limit);
    await mirror.logWrite({
      endpoint: 'mcp:lane_health',
      kind: 'lane_profiles',
      method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET',
      outcome: 'read',
      detail: `${laneId ?? kind} → ${lanes.length} of ${h.lanes.length}`,
      ms: Date.now() - t0,
    });
    if (laneId && !lanes.length) return { ok: false, reason: 'unknown_lane', message: `No ranked lane is called ${laneId}. rank_lanes kind all lists every lane id.` };
    return { total_lanes: h.lanes.length, returned: lanes.length, notes: h.notes, lanes };
  },
};

export const LANE_READ_TOOLS: ToolDefinition[] = [rankLanes, laneHealthTool];
export const LANE_WRITE_TOOLS: ToolDefinition[] = [setLaneProfile];
export { WEIGHTS, DEFINITIONS };
