/**
 * The Sovereign Context Layer's reads (11 Nov 2026, Destiny; Jason's thread C0ASMPYQLG3 1794180025.573569).
 *
 *   `read_true_home`       read, both connections, in every agent's scope. Where a kind of fact lives: its one
 *                          true home, the door every change goes through, who writes it and which places are
 *                          only views or copies. From the System Registry's true-home register (registry_truth),
 *                          so an agent checks where a fact lives before it acts on it (Grounding, SOP a8b26955).
 *   `read_record_history`  read, both connections, in every agent's scope. The earlier versions of one engine
 *                          record, newest first, with the fields each change touched. Kept by a database trigger
 *                          on every write to the record tables (migration 130), so no door can skip it
 *                          (Versioning, SOP cb5206c2).
 *
 * `copyNote` (below) is what the transport adds to an answer built from a copy: which store is the original,
 * when the dashboard last read it, and that the original wins.
 */
import * as registry from '../registry';
import * as mirror from '../mirror';
import { query } from '../pg';
import type { ToolDefinition } from './tools';

const READS_DB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}/registry`;

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

/** The rule every answer carries, so an agent never has to remember it. */
export const RULE =
  'One true home per kind of fact. Every change goes through that home or its own door; a view or a copy never holds its own authoritative version. Act only on what you can cite by its record id from its true home. A copy says it is a copy, and where it disagrees with its true home, the true home wins.';

/** Words in a fact's row that a question can match. Pure. */
export function words(t: string): string[] {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

/** Scores rows against a question, best first; rows with no word matched are dropped. Pure. */
export function match<T extends Record<string, unknown>>(rows: T[], q: string): T[] {
  const ws = words(q);
  if (!ws.length) return rows;
  const scored = rows.map((r) => {
    const hay = words([r.fact, r.store, r.home, r.views, r.notes, r.id].map((v) => String(v ?? '')).join(' '));
    const hit = ws.filter((w) => hay.some((h) => h === w || h.startsWith(w) || w.startsWith(h))).length;
    return { r, s: hit / ws.length };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r);
}

const brief = (r: registry.RegistryRow) => ({
  id: r.id,
  fact: r.fact,
  home: r.home,
  relation: r.relation,
  store: r.store,
  written_through: r.written_through,
  writers: r.writers,
  views: r.views,
  owner: r.owner,
  notes: r.notes,
  updated_at: r.updated_at,
});

export const readTrueHome: ToolDefinition = {
  name: 'read_true_home',
  description:
    'Where a kind of fact lives, before you act on it: its one true home (the dashboard, BHARAG, vFarm, n8n or Slack), the door every change to it goes through, who writes it, and which places are only views or copies. From the System Registry\'s true-home register, the Sovereign Context Layer\'s map. Ask with `fact` in plain words ("pay notes", "farm readings", "SOPs"), or filter by `home` or `relation` (true home, copy, read live); with nothing, every row. A relation of copy means the place you are reading is not the original: the original wins. Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The kind of fact, in plain words.' },
      home: { type: 'string', description: 'dashboard, bharag, vfarm, n8n or slack.' },
      relation: { type: 'string', enum: [...registry.TRUTH_RELATION] },
    },
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'Read where a fact lives' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    let rows = await registry.list('truth');
    const home = str(args, 'home').toLowerCase();
    const relation = str(args, 'relation').toLowerCase();
    if (home) rows = rows.filter((r) => String(r.home ?? '').toLowerCase() === home);
    if (relation) rows = rows.filter((r) => String(r.relation ?? '').toLowerCase() === relation);
    const fact = str(args, 'fact');
    const hit = fact ? match(rows, fact) : rows;
    const answer: Record<string, unknown> = { ok: true, rule: RULE, count: hit.length, held: rows.length, rows: hit.slice(0, 40).map(brief), page: `${PAGE}?tab=true-homes` };
    if (fact && !hit.length) {
      answer.note = `No row in the register matches "${fact}". ${rows.length} are held. Do not guess a home: ask Destiny or Jason, and say the register has no row for it.`;
    }
    await mirror
      .logWrite({ endpoint: 'mcp:read_true_home', kind: 'registry', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${hit.length}/${rows.length}${fact ? ` "${fact}"` : ''}`, ms: Date.now() - t0 })
      .catch(() => undefined);
    return answer;
  },
};

/** Record kinds whose table keeps history (migration 130), by kind name. */
function tableFor(kind: string): string | null {
  if (!mirror.isKind(kind)) return null;
  return mirror.KINDS[kind].table;
}

export const readRecordHistory: ToolDefinition = {
  name: 'read_record_history',
  description:
    'The earlier versions of one engine record, newest first: each version is the record as it stood before a change, with the fields that change touched and when. Kept on every write to the record tables by the database itself, so no door can skip it. kind is a record kind (loops, codex, layer0, patterns, commercial, rt-jobs, pay_sessions, channel_tracking, incidents and the others find_records names); give the row `id` or its `natural_id` (a loop_id, a Submission ID, a pattern_id). History starts on 11 Nov 2026: a record changed only before then has none. Read only.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      id: { type: 'string', description: "The row's own id." },
      natural_id: { type: 'string', description: 'Or its natural id: LOOP-..., a Submission ID, a pattern_id.' },
      limit: { type: 'number', description: 'Versions to return. Default 10, at most 50.' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'Read a record\'s earlier versions' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const kind = str(args, 'kind');
    const table = tableFor(kind);
    if (!table) return { ok: false, reason: 'unknown_kind', message: `"${kind}" is not a record kind. One of: ${mirror.KIND_LIST.join(', ')}.` };
    const id = str(args, 'id');
    const natural = str(args, 'natural_id');
    if (!id && !natural) return { ok: false, reason: 'id_required', message: 'Give the row id or its natural_id.' };
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
    const r = await query<{ op: string; row_id: string; natural_id: string | null; before_fields: Record<string, unknown>; changed_keys: string[]; changed_at: string }>(
      `SELECT op, row_id, natural_id, before_fields, changed_keys, to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed_at
         FROM engine_record_history
        WHERE table_name = $1 AND (($2 <> '' AND row_id = $2) OR ($3 <> '' AND natural_id = $3))
        ORDER BY changed_at DESC, id DESC LIMIT $4`,
      [table, id, natural, limit],
    );
    const versions = r.rows.map((v, i) => ({
      version_before_change: r.rows.length - i,
      op: v.op,
      changed_at: v.changed_at,
      changed_keys: v.changed_keys,
      before: Object.fromEntries(Object.entries(v.before_fields ?? {}).map(([k, val]) => [k, typeof val === 'string' && val.length > 600 ? `${val.slice(0, 600)}… (${val.length} characters)` : val])),
    }));
    await mirror
      .logWrite({ endpoint: 'mcp:read_record_history', kind, method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${id || natural} ${versions.length}`, ms: Date.now() - t0 })
      .catch(() => undefined);
    return {
      ok: true,
      kind,
      table,
      record: id || natural,
      versions,
      note: versions.length ? `${versions.length} earlier version(s), newest first. The current version is the record itself (find_records).` : 'No earlier version is held: the record has not changed since history began on 11 Nov 2026, or it is not held.',
    };
  },
};

/* ------------------------------------------------------------- copy labels */

/** Which tools answer from a copy, and of what. */
export const COPY_TOOLS: Record<string, Array<'incidents' | 'farm'>> = {
  read_self_healing: ['incidents'],
  read_logstream: ['incidents'],
  read_monitoring_twin: ['farm', 'incidents'],
  read_vfarm_history: ['farm'],
  get_vfarm_gates: ['farm'],
};

/** When the dashboard last read each lane of the incident ledger: the oldest successful read is the honest one. */
async function ledgerReadAt(): Promise<string | null> {
  const r = await query<{ v: string }>(`SELECT value AS v FROM meta WHERE key LIKE 'health.lane.%'`);
  const ats = r.rows
    .map((x) => {
      try {
        const p = JSON.parse(x.v) as { read?: boolean; at?: string | null };
        return p.read && p.at ? p.at : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x)
    .sort();
  return ats[0] ?? null;
}

async function farmReadAt(): Promise<string | null> {
  const r = await query<{ at: string | null }>(`SELECT to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM engine_vfarm_snapshots ORDER BY taken_at DESC LIMIT 1`);
  return r.rows[0]?.at ?? null;
}

/** What an answer built from a copy carries: the original, when it was last copied, and that the original wins. */
export async function copyNote(tool: string): Promise<Array<Record<string, unknown>> | null> {
  const which = COPY_TOOLS[tool];
  if (!which) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const w of which) {
    if (w === 'incidents') {
      out.push({
        fact: 'Incidents',
        true_home: 'BHARAG incident ledger',
        this_is: "the dashboard's copy (engine_incidents)",
        copied_at: await ledgerReadAt().catch(() => null),
        rule: 'Where this copy and the ledger disagree, the ledger wins. Read again before acting on an incident that may have changed since copied_at.',
      });
    } else {
      out.push({
        fact: 'Farm state',
        true_home: 'vFarm (its Postgres behind the vFarm API)',
        this_is: "the dashboard's copy of vFarm's last snapshot (engine_vfarm_*)",
        copied_at: await farmReadAt().catch(() => null),
        rule: 'Where this copy and vFarm disagree, vFarm wins. A copied_at older than a few minutes means the copy may be stale.',
      });
    }
  }
  return out;
}

export const TRUE_HOME_READ_TOOLS: ToolDefinition[] = [readTrueHome, readRecordHistory];
