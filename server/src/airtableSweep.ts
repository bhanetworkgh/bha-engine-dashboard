/**
 * The hidden Airtable writer sweep (2026-09-24, Destiny — LOOP-1790034076667-8HOF).
 *
 * Airtable was cut out of the engine after the API cap hit on 20 Sep, and these
 * tables became the only record. A workflow that still writes to Airtable is a
 * write that lands nowhere anyone reads — or, worse, one that a later final
 * import could carry back over a newer row here. This reads every workflow on
 * the instance, active and inactive (an inactive one can be switched back on),
 * and names every node that touches Airtable:
 *
 *   - a node whose type is Airtable (`airtable`, `airtableTool`,
 *     `airtableTrigger`, the AI-agent tool variants);
 *   - a node using an Airtable credential type;
 *   - a node whose parameters — a URL, an expression, a Code node's source —
 *     mention `airtable`, `api.airtable.com`, a base id `app…` or a table id
 *     `tbl…`.
 *
 * Each finding says whether the node **calls Airtable** (an Airtable node type,
 * an Airtable credential, or `api.airtable.com`) or only **names** an id or the
 * word (a dashboard URL carrying `table_id=tbl…` is a reference, not a call);
 * whether it reads or writes, and how that was decided; and whether the table
 * is one this dashboard now owns. It changes nothing: it is a read of workflow
 * JSON and nothing else.
 *
 * `classifyWorkflow` is pure, so the same code runs over workflow JSON from any
 * source: the n8n API with `N8N_API_KEY` (`sweep()`, the MCP tool
 * `sweep_airtable_nodes`, `scripts/airtable-sweep.cjs`), or files on disk.
 */
import * as sources from './sources';
import { DIGESTS } from './mirror';

export interface OwnedTable {
  base: string;
  /** A table id, or `*` where every table in the base is one this dashboard owns (one per builder or lane). */
  table: string;
  label: string;
}

/**
 * Every Airtable table whose rows this dashboard now holds as the record.
 * Read from `sources.ts` (and `mirror.ts` for the digests), never re-typed, so
 * a kind added there is owned here the same day. Loops, Codex and the watched
 * clients are one table per builder or lane, so their whole base counts —
 * a builder table added next month is still the dashboard's.
 */
export function ownedTables(): OwnedTable[] {
  const t = (x: { base: string; table: string; label: string }): OwnedTable => ({ base: x.base, table: x.table, label: x.label });
  return [
    { base: sources.LOOPS_BASE, table: '*', label: 'Open loops (one table per builder)' },
    { base: sources.CODEX_BASE, table: '*', label: 'BHA Submissions & Logs (Codex tables, Layer 0, Review Returns)' },
    { base: sources.CLIENTS_INDEX.base, table: '*', label: 'BHA Client Research Loop (index, questions, requests)' },
    t(sources.PATTERNS),
    t(sources.PATTERN_CANDIDATES),
    t(sources.BUILDER_PROFILES),
    t(sources.LANE_BACKLOG),
    t(sources.DEEP_THINK_LOG),
    t(sources.CHANNEL_TRACKING),
    t(sources.COMMERCIAL),
    t(sources.NORTH_STAR),
    t(sources.RESEARCH_TWIN),
    t(sources.RESEARCH_JOBS),
    t(sources.ERROR_COUNTS),
    t(sources.RETRY_ATTEMPTS),
    t(sources.PAY_BUILDERS),
    t(sources.PAY_SESSIONS),
    t(sources.PAY_STATEMENTS),
    t(DIGESTS),
    // The per-builder and per-lane tables by id too: a node often names only
    // the table (the base comes from a variable), and it is still ours.
    ...sources.LOOP_TABLES.map((x) => ({ base: sources.LOOPS_BASE, table: x.table, label: `Open loops — ${x.label}` })),
    ...sources.CODEX_TABLES.map((x) => ({ base: sources.CODEX_BASE, table: x.table, label: `Codex — ${x.label}` })),
    t(sources.CODEX_LAYER0),
    t(sources.REVIEW_RETURNS),
    t(sources.CLIENTS_INDEX),
    t(sources.CLIENT_REQUESTS),
  ];
}

export type Access = 'write' | 'read' | 'trigger' | 'unknown' | 'none';

export interface Finding {
  workflow_id: string;
  workflow_name: string;
  active: boolean;
  archived: boolean;
  node: string;
  node_type: string;
  node_disabled: boolean;
  /** `call`: the node talks to Airtable. `reference`: it only names an id or the word. */
  contact: 'call' | 'reference';
  /** What made it a finding: node type, credential, api.airtable.com, an id, the word. */
  matched: string[];
  access: Access;
  /** How `access` was decided, in words — the operation, the HTTP method, or why it could not be. */
  access_basis: string;
  bases: string[];
  tables: string[];
  /** Table names a v1 Airtable node carries instead of ids. */
  table_names: string[];
  owned: string[];
  /** Base owned per-builder/lane, table not resolvable from the node. */
  owned_base_only: string[];
  credentials: Array<{ type: string; id: string | null; name: string | null }>;
  /** Up to three short excerpts around what matched, for a Code node or expression. */
  evidence: string[];
}

const WRITE_OPS = /^(create|append|update|upsert|delete|deleterecord|createorupdate|replace)$/i;
const READ_OPS = /^(get|getall|list|search|read|getschema|getmany)$/i;
const APP_RE = /\bapp[A-Za-z0-9]{14}\b/g;
const TBL_RE = /\btbl[A-Za-z0-9]{14}\b/g;

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function excerpts(text: string, re: RegExp, max = 3): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) && out.length < max) {
    const a = Math.max(0, m.index - 60);
    out.push(text.slice(a, m.index + m[0].length + 60).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** The value of an n8n resource-locator parameter (`{ __rl, value, mode }`) or a plain string. */
function rl(v: unknown): string {
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).value ?? '');
  return typeof v === 'string' ? v : '';
}

function httpAccess(params: Record<string, unknown>, text: string): { access: Access; basis: string } {
  const method = typeof params.method === 'string' ? params.method : null;
  if (!method) return { access: 'read', basis: 'HTTP node with no method set: n8n defaults to GET' };
  if (method.startsWith('=')) return { access: 'unknown', basis: `method is an expression (${method.slice(0, 60)})` };
  if (/^(POST|PATCH|PUT|DELETE)$/i.test(method)) return { access: 'write', basis: `HTTP ${method.toUpperCase()}` };
  if (/^(GET|HEAD)$/i.test(method)) return { access: 'read', basis: `HTTP ${method.toUpperCase()}` };
  void text;
  return { access: 'unknown', basis: `HTTP method ${method}` };
}

function codeAccess(code: string): { access: Access; basis: string } {
  const near = code.match(/method\s*:\s*['"`](POST|PATCH|PUT|DELETE|GET)['"`]/gi) ?? [];
  const writes = near.filter((m) => !/GET/i.test(m));
  if (writes.length) return { access: 'write', basis: `Code node sends ${uniq(writes.map((m) => m.replace(/.*['"`](\w+)['"`].*/, '$1').toUpperCase())).join(', ')}` };
  if (/this\.helpers\.(httpRequest|request)|fetch\(|\$http/i.test(code) && near.length) return { access: 'read', basis: 'Code node requests with GET only' };
  return { access: 'unknown', basis: 'Code node mentions Airtable; no request method could be read from it' };
}

/** Every Airtable touch in one workflow's JSON. Pure. */
export function classifyWorkflow(wf: { id?: unknown; name?: unknown; active?: unknown; isArchived?: unknown; nodes?: unknown }, owned: OwnedTable[] = ownedTables()): Finding[] {
  const nodes = Array.isArray(wf.nodes) ? (wf.nodes as Array<Record<string, unknown>>) : [];
  const out: Finding[] = [];
  const wholeBases = new Map(owned.filter((o) => o.table === '*').map((o) => [o.base, o.label]));
  const byTable = new Map(owned.filter((o) => o.table !== '*').map((o) => [o.table, o.label]));
  for (const n of nodes) {
    const type = String(n.type ?? '');
    if (/stickyNote$/i.test(type)) continue;
    const params = (n.parameters && typeof n.parameters === 'object' ? n.parameters : {}) as Record<string, unknown>;
    const text = JSON.stringify(params);
    const creds = Object.entries((n.credentials && typeof n.credentials === 'object' ? n.credentials : {}) as Record<string, unknown>)
      .filter(([k]) => /airtable/i.test(k))
      .map(([k, v]) => ({ type: k, id: v && typeof v === 'object' ? String((v as Record<string, unknown>).id ?? '') || null : null, name: v && typeof v === 'object' ? String((v as Record<string, unknown>).name ?? '') || null : null }));
    const isAirtableType = /airtable/i.test(type);
    // A Code node can call Airtable through a credential by name
    // (httpRequestWithAuthentication('airtableTokenApi', …)) without spelling the host.
    const hitsApi = /api\.airtable\.com|['"`]airtable(Token|OAuth2)?Api['"`]/i.test(text);
    const hitsWord = /airtable/i.test(text);
    const bases = uniq(text.match(APP_RE) ?? []);
    const tables = uniq(text.match(TBL_RE) ?? []);
    const credType = typeof params.nodeCredentialType === 'string' && /airtable/i.test(params.nodeCredentialType) ? [String(params.nodeCredentialType)] : [];
    if (!isAirtableType && !creds.length && !credType.length && !hitsApi && !hitsWord && !bases.length && !tables.length) continue;

    const matched: string[] = [];
    if (isAirtableType) matched.push(`node type ${type}`);
    if (creds.length) matched.push(`credential ${creds.map((c) => c.type).join(', ')}`);
    if (credType.length) matched.push(`nodeCredentialType ${credType.join(', ')}`);
    if (hitsApi) matched.push('api.airtable.com');
    if (hitsWord && !hitsApi && !isAirtableType) matched.push('the word "airtable"');
    if (bases.length) matched.push(`base id${bases.length > 1 ? 's' : ''}`);
    if (tables.length) matched.push(`table id${tables.length > 1 ? 's' : ''}`);
    const contact: Finding['contact'] = isAirtableType || creds.length || credType.length || hitsApi ? 'call' : 'reference';

    let access: Access = 'unknown';
    let basis = '';
    const tableNames: string[] = [];
    if (isAirtableType) {
      const base = rl(params.base) || rl(params.application);
      const table = rl(params.table);
      if (base && !bases.includes(base) && !base.startsWith('=')) bases.push(base);
      if (table) (/^tbl[A-Za-z0-9]{14}$/.test(table) ? (tables.includes(table) ? null : tables.push(table)) : tableNames.push(table));
      if (/trigger/i.test(type)) {
        access = 'trigger';
        basis = 'Airtable Trigger polls the table';
      } else {
        const op = typeof params.operation === 'string' ? params.operation : '';
        if (!op) {
          access = 'unknown';
          basis = `operation not set on the node (typeVersion ${String(n.typeVersion ?? '?')}): n8n's default applies`;
        } else if (op.startsWith('=')) {
          access = 'unknown';
          basis = `operation is an expression (${op.slice(0, 60)})`;
        } else if (WRITE_OPS.test(op)) {
          access = 'write';
          basis = `operation ${op}`;
        } else if (READ_OPS.test(op)) {
          access = 'read';
          basis = `operation ${op}`;
        } else {
          access = 'unknown';
          basis = `operation ${op}`;
        }
      }
    } else if (/httpRequest/i.test(type)) {
      if (contact === 'call') ({ access, basis } = httpAccess(params, text));
      else {
        access = 'none';
        basis = 'does not call Airtable: names an Airtable id or the word (e.g. a dashboard URL carrying table_id)';
      }
    } else if (/\.code$|\.function(Item)?$/i.test(type)) {
      const code = String(params.jsCode ?? params.functionCode ?? params.pythonCode ?? '');
      if (contact === 'call') ({ access, basis } = codeAccess(code));
      else {
        access = 'none';
        basis = 'does not call Airtable: the Code node names an Airtable id or the word (a comment, a table map, a reshape)';
      }
    } else if (contact === 'call') {
      access = 'unknown';
      basis = `a ${type} node with an Airtable credential`;
    } else {
      access = 'none';
      basis = 'does not call Airtable: names an Airtable id or the word only';
    }

    const ownedHits = uniq(tables.map((x) => byTable.get(x)).filter((x): x is string => Boolean(x)));
    const ownedBase = uniq(bases.map((b) => wholeBases.get(b)).filter((x): x is string => Boolean(x)));
    const evidence = excerpts(text, /api\.airtable\.com|airtable|\bapp[A-Za-z0-9]{14}\b|\btbl[A-Za-z0-9]{14}\b/i);
    out.push({
      workflow_id: String(wf.id ?? ''),
      workflow_name: String(wf.name ?? ''),
      active: wf.active === true,
      archived: wf.isArchived === true,
      node: String(n.name ?? ''),
      node_type: type,
      node_disabled: n.disabled === true,
      contact,
      matched,
      access,
      access_basis: basis,
      bases,
      tables,
      table_names: tableNames,
      owned: ownedHits,
      owned_base_only: ownedBase,
      credentials: creds,
      evidence,
    });
  }
  return out;
}

export interface SweepReport {
  swept_at: string;
  workflows: number;
  workflows_active: number;
  workflows_read_failed: Array<{ id: string; name: string; error: string }>;
  /** Live and would run: an active, unarchived workflow, the node enabled, calling Airtable to write (or unknown). */
  active_writers: Finding[];
  /** Would write if switched back on: inactive or archived workflow, or a disabled node. */
  inactive_writers: Finding[];
  /** Calls Airtable to read (or is an Airtable trigger), active or not. */
  reads: Finding[];
  /** Names an Airtable id or the word without calling Airtable. */
  references: Finding[];
  /** Every Airtable credential a node names, with the workflows using it. */
  credentials_in_use: Array<{ type: string; id: string | null; name: string | null; workflows: string[] }>;
  owned_tables: OwnedTable[];
}

/** Sorts a flat list of findings into the four buckets the report is read in. */
export function report(findings: Finding[], meta: { workflows: number; workflows_active: number; failed: SweepReport['workflows_read_failed'] }): SweepReport {
  const live = (f: Finding) => f.active && !f.archived && !f.node_disabled;
  const calls = findings.filter((f) => f.contact === 'call');
  const writes = calls.filter((f) => f.access === 'write' || f.access === 'unknown');
  const creds = new Map<string, { type: string; id: string | null; name: string | null; workflows: Set<string> }>();
  for (const f of findings)
    for (const c of f.credentials) {
      const k = `${c.type}|${c.id}|${c.name}`;
      if (!creds.has(k)) creds.set(k, { ...c, workflows: new Set() });
      creds.get(k)!.workflows.add(`${f.workflow_id} ${f.workflow_name}`);
    }
  return {
    swept_at: new Date().toISOString(),
    workflows: meta.workflows,
    workflows_active: meta.workflows_active,
    workflows_read_failed: meta.failed,
    active_writers: writes.filter(live),
    inactive_writers: writes.filter((f) => !live(f)),
    reads: calls.filter((f) => f.access === 'read' || f.access === 'trigger'),
    references: findings.filter((f) => f.contact === 'reference'),
    credentials_in_use: [...creds.values()].map((c) => ({ type: c.type, id: c.id, name: c.name, workflows: [...c.workflows].sort() })),
    owned_tables: ownedTables(),
  };
}

/**
 * The sweep over a source of workflows. `list` gives every id; `get` gives one
 * workflow's JSON. A workflow that cannot be read is named in the report, never
 * skipped silently — a sweep that quietly missed one would be claiming a clean
 * bill it had not checked.
 */
export async function sweep(
  list: () => Promise<Array<{ id: string; name: string; active?: boolean }>>,
  get: (id: string) => Promise<{ id?: unknown; name?: unknown; active?: unknown; isArchived?: unknown; nodes?: unknown }>,
): Promise<SweepReport> {
  const ids = await list();
  const owned = ownedTables();
  const findings: Finding[] = [];
  const failed: SweepReport['workflows_read_failed'] = [];
  let active = 0;
  for (const w of ids) {
    try {
      const wf = await get(w.id);
      if (wf.active === true) active++;
      findings.push(...classifyWorkflow({ ...wf, active: wf.active ?? w.active }, owned));
    } catch (e) {
      failed.push({ id: w.id, name: w.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report(findings, { workflows: ids.length, workflows_active: active, failed });
}
