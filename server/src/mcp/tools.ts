/**
 * The tools an external Claude client can call against this dashboard.
 *
 * All read-only, deliberately: v1 has no write tool of any kind, so nothing
 * reachable from here can change a loop, a Codex status or an Airtable row.
 * There is no code path from a tool to a write — not a guarded one, none.
 *
 * Two rules run through every tool below, and they are the whole reason the
 * structure tools read source rather than describing it:
 *
 *  1. **A tool that cannot answer says why.** Every failure comes back as an
 *     explicit error naming what was looked for and where. A wrong answer about
 *     structure is worse than no answer, because the reader acts on it.
 *  2. **Nothing is cut silently.** Every answer that was capped says it was
 *     capped, says what the cap was, and says how to ask for the rest.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { databaseIdentity, query as pgQuery, DATABASE_URL } from '../pg';
import * as airtable from '../airtable';
import * as bharag from '../bharag';
import * as recovery from '../recovery';
import * as n8n from '../n8n';
import * as sources from '../sources';
import { grepSource, McpError, REPO_ROOT, sourceAvailable, assertSource } from './source';
import { component, dataSources, pageByPath, pageData, pageFiles, pages, pageStructure } from './structure';
import { describeTables, DEFAULT_ROWS, MAX_ROWS, runSelect } from './sql';
import { assertKind, diff, RESYNC_ROUTE, SOURCE_OF, status as mirrorStatus } from './inventory';
import * as logs from './logs';

/** What the tools need from the server they are mounted on. */
export interface ToolDeps {
  /**
   * Runs a GET against this server's own /api router — the same function that
   * answers the browser, so `get_page_data` cannot drift from what the page
   * shows. It is the app's fetching code, not a second copy of it.
   */
  dispatch: (pathWithQuery: string) => Promise<{ status: number; body: unknown }>;
  /** The process start, for uptime. */
  startedAt: string;
}

/**
 * The hints MCP defines for a tool, and what this server means by each.
 *
 * **The spec's default for an unannotated tool is "potentially destructive"**,
 * so every tool here carries them, the seven read-only ones included — leaving
 * them off would have a client checkpoint a `SELECT`.
 *
 * They are hints, and they are honest ones, but they are not the enforcement:
 * a client uses them to decide what to auto-run and what to pause on, and the
 * server still refuses what it refuses regardless of what any client believes.
 */
export interface ToolAnnotations {
  title?: string;
  /** Reads and changes nothing. True on every tool but `resync`. */
  readOnlyHint: boolean;
  /** Could destroy or overwrite something a person would miss. */
  destructiveHint?: boolean;
  /** Running it twice leaves the same state as running it once. */
  idempotentHint?: boolean;
  /** Touches a system outside this process — Airtable, BHARAG, n8n. */
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;
}

/** A read of this repo's own files: no database, no network, nothing to undo. */
const READS_SOURCE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** A read of this process's own database. */
const READS_DB: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** A read that calls out to Airtable, BHARAG or n8n. */
const READS_WORLD: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/* --------------------------------------------------------------- helpers */

function str(args: Record<string, unknown>, key: string, required = false): string | null {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (required) throw new McpError('bad_argument', `"${key}" is required and must be a non-empty string.`);
  return null;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new McpError('bad_argument', `"${key}" must be a number.`);
  return n;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return v === true || v === 'true';
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null');
}

/**
 * What a payload is, when the payload itself is too big to return.
 *
 * Deliberately a description of the shape and nothing else: no sample rows, no
 * "first three of". A fragment of data presented without saying it is a
 * fragment is the thing this whole file is built to avoid, and a shape with the
 * counts on it is enough to decide what to ask for next.
 */
function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth > 2 ? `array(${value.length})` : { array_of: value.length, item_shape: value.length ? shapeOf(value[0], depth + 1) : 'unknown (empty)' };
  }
  if (typeof value === 'object') {
    if (depth > 2) return `object(${Object.keys(value as object).length} keys)`;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shapeOf(v, depth + 1);
    return out;
  }
  return typeof value;
}

/**
 * One value out of a payload, by dot path. `a.b.0.c` walks objects and arrays.
 *
 * Returns `found` separately from `value`, because a path that is not there and
 * a path whose value is genuinely `null` are different answers and a bare
 * `null` would collapse them. The whole point of this tool set is that it says
 * what it could not find.
 */
function pick(body: unknown, path: string): { found: boolean; value?: unknown } {
  let node: unknown = body;
  for (const step of path.split('.')) {
    if (node === null || node === undefined) return { found: false };
    if (Array.isArray(node)) {
      const i = Number(step);
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return { found: false };
      node = node[i];
      continue;
    }
    if (typeof node !== 'object') return { found: false };
    const obj = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, step)) return { found: false };
    node = obj[step];
  }
  return { found: true, value: node };
}

/* ----------------------------------------------------------------- tools */

const listPages: ToolDefinition = {
  name: 'list_pages',
  description:
    'Every route this dashboard serves: the path, the page title, the file that implements it, and a one-line description of what the page is for. Read out of the router (src/App.tsx), the sidebar (src/components/Layout.tsx) and each page’s own PageHeader, falling back to that page’s section in CLAUDE.md. Never a hand-written list. Where there is no description in source, the field is null and says so rather than being filled in.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { ...READS_SOURCE, title: 'List the routes this dashboard serves' },
  handler: async () => {
    assertSource();
    const all = pages();
    return {
      repo_root: REPO_ROOT,
      routes: all.length,
      pages: all,
      derivation:
        'Routes from the <Route> elements in src/App.tsx, with each element resolved through its import to the file that implements it. Sidebar label and group from the GROUPS array in src/components/Layout.tsx. Title and description from the page’s own <PageHeader title subtitle>; where a page has no subtitle, the description is the first sentence of that page’s section in CLAUDE.md, and the source of each is named beside it.',
    };
  },
};

const getPageStructure: ToolDefinition = {
  name: 'get_page_structure',
  description:
    'One page’s panel layout, in order: every component it renders, nested as written, each with the file it is declared in, the props that change what it shows, and the data expressions those props name. This is read by scanning the page’s own JSX, so it cannot drift from the page. Components this repo owns are opened up in place; a component passed in as a prop is listed under in_props. Raise expand_depth to go deeper, or call get_component for one part in full.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The route, as list_pages gives it — "/engine-health", "/" for the Overview.' },
      expand_depth: { type: 'number', description: 'How many levels of this repo’s own components to open up in place. Default 2, maximum 4.' },
      max_nodes: { type: 'number', description: 'Node budget for the answer. Default 400, maximum 1200. A cut answer says it was cut.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { ...READS_SOURCE, title: 'One page’s panel layout' },
  handler: async (args) => {
    assertSource();
    return pageStructure(str(args, 'path', true)!, { expand_depth: num(args, 'expand_depth'), max_nodes: num(args, 'max_nodes') });
  },
};

const getComponent: ToolDefinition = {
  name: 'get_component',
  description:
    'The full source of one named component or function, with the doc comment above it and the file and lines it occupies. If the name is declared in more than one file the call fails and names every candidate, because two components with the same name do different things and picking one would be a guess.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The component or function name, e.g. "LaneView", "PageHeader".' },
      file: { type: 'string', description: 'Repo-relative file, when the name is declared in more than one place.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: { ...READS_SOURCE, title: 'The source of one component' },
  handler: async (args) => {
    assertSource();
    return component(str(args, 'name', true)!, str(args, 'file'));
  },
};

const searchSource: ToolDefinition = {
  name: 'search_source',
  description:
    'Search the repository’s source for a string or a regular expression. Returns the file, the line number, the matching line and a couple of lines either side. Results are paged: the answer says the total and how to ask for the next page. node_modules, dist and server-dist are never searched.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A literal string, or a regular expression when regex is true.' },
      glob: { type: 'string', description: 'Limit to matching files, e.g. "src/screens/**" or "**/*.tsx".' },
      regex: { type: 'boolean', description: 'Treat the query as a regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Default false.' },
      context: { type: 'number', description: 'Lines either side of a hit. Default 2, maximum 10.' },
      limit: { type: 'number', description: 'Hits per page. Default 50, maximum 200.' },
      offset: { type: 'number', description: 'Skip this many hits, for the next page.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { ...READS_SOURCE, title: 'Search the repository' },
  handler: async (args) =>
    grepSource(str(args, 'query', true)!, {
      glob: str(args, 'glob'),
      regex: bool(args, 'regex'),
      case_sensitive: bool(args, 'case_sensitive'),
      context: num(args, 'context'),
      limit: num(args, 'limit'),
      offset: num(args, 'offset'),
    }),
};

const listDataSources: ToolDefinition = {
  name: 'list_data_sources',
  description:
    'Every external source this dashboard reads — each Airtable base and table, the BHARAG incident ledger endpoint per lane, the two n8n endpoints, and its own Postgres — with the credential each needs, whether that credential is set on this service, the engine_* table the rows land in, and which pages consume it. Read from the exported constants in server/src/sources.ts and server/src/mirror.ts as this process holds them.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { ...READS_SOURCE, title: 'Every external source and which pages read it' },
  handler: async () => {
    assertSource();
    return dataSources();
  },
};

/** 120 KB of JSON per answer. Past it a route's payload is described, not sampled. */
const MAX_DATA_BYTES = 120 * 1024;

const getPageData: ToolDefinition = {
  name: 'get_page_data',
  description:
    'The data one page would render right now, as JSON. Each of the page’s own GET routes is run through this server’s /api router — the same code that answers the browser — so this cannot drift from what the page shows. Routes that need a row id (a loop, one Codex entry) are listed as skipped with the reason rather than guessed at. A payload past the size cap is returned as its shape with the cap stated.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The route, as list_pages gives it.' },
      route: { type: 'string', description: 'Fetch only this one /api route of the page’s, e.g. "/api/engine-health".' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Dot paths to return instead of the whole payload — "sessions_owed.n", "oldest_unpaid.builder", "leads.0.email". Most questions want two numbers out of a 6 KB payload, and asking for them by name means the answer is not subject to the size cap at all. A path that is not there is reported as not found rather than as null.',
      },
      max_bytes: { type: 'number', description: `Size cap for the whole answer. Default ${MAX_DATA_BYTES}. Ignored when \`fields\` is given.` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'What a page would render right now' },
  handler: async (args, deps) => {
    assertSource();
    const page = pageByPath(str(args, 'path', true)!);
    if (!page.file) throw new McpError('no_source', page.note ?? `No file implements ${page.path}, so there is no data to read for it.`);
    const only = str(args, 'route');
    const cap = Math.max(4096, Math.min(400 * 1024, num(args, 'max_bytes') ?? MAX_DATA_BYTES));

    const wanted = Array.isArray(args.fields) ? (args.fields as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()) : null;

    const routes = pageData(pageFiles(page.file)).api_routes;
    const fetched: { api: string; status: number; bytes: number; data?: unknown; shape?: unknown; note?: string }[] = [];
    const skipped: { api: string; reason: string }[] = [];
    const bodies: { api: string; body: unknown }[] = [];
    let spent = 0;

    for (const r of routes) {
      if (r.method !== 'GET') {
        skipped.push({ api: `${r.method} ${r.path_prefix}`, reason: `Not a read: ${r.name} is a ${r.method}. This tool set has no write tool, so it is never called from here.` });
        continue;
      }
      if (r.parameterised) {
        skipped.push({ api: r.path, reason: `Needs a value filled in (${r.path.slice(r.path_prefix.length)}), so there is no single answer for the page. Ask for one row through the page’s own list route instead.` });
        continue;
      }
      if (only && r.path_prefix !== only && r.path !== only) continue;
      const answer = await deps.dispatch(r.path);
      const bytes = bytesOf(answer.body);
      bodies.push({ api: r.path, body: answer.body });
      // With `fields` the answer is a handful of values, so the byte cap that
      // exists to stop a 40 KB payload landing whole has nothing to guard.
      if (wanted) continue;
      if (spent + bytes > cap) {
        fetched.push({
          api: r.path,
          status: answer.status,
          bytes,
          shape: shapeOf(answer.body),
          note: `Cut: this payload is ${bytes} bytes and the answer’s ${cap}-byte cap was already at ${spent}. Its shape is given instead of its rows — no sample, because a fragment read as the whole is the mistake worth avoiding. Ask for this route alone with route="${r.path}", or raise max_bytes.`,
        });
        continue;
      }
      spent += bytes;
      fetched.push({ api: r.path, status: answer.status, bytes, data: answer.body });
    }

    if (only && !fetched.length) {
      throw new McpError('no_such_route', `${page.path} does not read "${only}". It reads: ${routes.map((r) => `${r.method} ${r.path_prefix}`).join(', ') || 'nothing this tool could resolve'}.`);
    }

    const derivation =
      'Each route was resolved from the src/data functions the page’s files import, then run through this server’s own /api router — the same function that answers the browser, in this process, against the same Postgres.';

    if (wanted) {
      const picked = wanted.map((path) => {
        for (const b of bodies) {
          const hit = pick(b.body, path);
          if (hit.found) return { path, route: b.api, value: hit.value };
        }
        return {
          path,
          route: null,
          found: false,
          note: `No route on this page has "${path}". Call without \`fields\` to see the shape, then ask again.`,
        };
      });
      return {
        path: page.path,
        title: page.title,
        read_at: new Date().toISOString(),
        fields: picked,
        routes_read: bodies.map((b) => b.api),
        skipped,
        derivation: `${derivation} Only the paths asked for are returned, so the size cap does not apply.`,
      };
    }

    return {
      path: page.path,
      title: page.title,
      read_at: new Date().toISOString(),
      fetched,
      skipped,
      bytes: spent,
      cap,
      derivation,
    };
  },
};

/* ---------------------------------------------------------------- health */

interface Probe {
  source: string;
  credential: string;
  configured: boolean;
  reachable: boolean | null;
  ms: number | null;
  detail: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t0, detail: 'answered' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) };
  }
}

const getHealth: ToolDefinition = {
  name: 'get_health',
  description:
    'What is deployed and whether each data source answers: the commit and branch Render built, how long this process has been up, and a live probe of Postgres, Airtable, the three BHARAG incident lanes and the n8n API. A source with no credential set is reported as not configured and never as unreachable — and never as healthy, because an unasked source and a healthy one look identical from the outside.',
  inputSchema: {
    type: 'object',
    properties: {
      probe: { type: 'boolean', description: 'Actually call each source. Default true. False reports only what is configured, and calls nothing.' },
    },
    additionalProperties: false,
  },
  annotations: { ...READS_WORLD, title: 'What is deployed, and whether each source answers' },
  handler: async (args, deps) => {
    const doProbe = bool(args, 'probe') ?? true;
    const probes: Probe[] = [];

    const db = databaseIdentity();
    const pg = doProbe && DATABASE_URL ? await timed(() => pgQuery('select 1')) : null;
    probes.push({
      source: db ? `postgres ${db.server_version} at ${db.host}/${db.database}` : 'postgres',
      credential: 'DATABASE_URL',
      configured: Boolean(DATABASE_URL),
      reachable: pg ? pg.ok : null,
      ms: pg?.ms ?? null,
      detail: DATABASE_URL ? (pg ? pg.detail : 'not probed') : 'DATABASE_URL is not set — this server does not start without it, so seeing this means something is very wrong.',
    });

    /**
     * Probed with `probeReachable`, which names no field and reads one record
     * (2026-09-20, the second fix of the day and the right one).
     *
     * This probe called `listRecordIds`, which hardcodes the field
     * `Submission ID` — present on the six builder tables and Layer 0 and
     * nowhere else. Against Build Patterns, whose id field is `pattern_id`,
     * Airtable refused the whole request with
     * `Unknown field name: "Submission ID"` and this probe reported the whole
     * of Airtable as unreachable while the token was working perfectly: 2,244ms
     * to say something false, live at 19:43 UTC. The same call also explains the
     * eight seconds seen on 18 Sep — it pages to the end, so it was walking all
     * 175 Build Patterns records to answer a yes/no question.
     *
     * The first attempt at this fix moved the probe to a table that *does*
     * carry `Submission ID`, which worked and left the trap armed: the field
     * name was still hardcoded, so the next person to repoint the probe would
     * have found it the same way. A liveness probe names no field, and this one
     * cannot break on a table's schema because it asks about no schema.
     */
    /**
     * Retired is its own answer, and deliberately neither of the other two
     * (2026-09-22). Not `reachable: true` — nothing was asked, and claiming
     * health for an unasked source is the exact failure this whole file is
     * written against. Not `reachable: false` either — that reads as a fault
     * and sends somebody to check a credential that is fine. So Airtable is
     * simply not probed, and the line says why in words.
     */
    const atRetired = airtable.retired();
    const atOk = airtable.airtableConfigured();
    const probeTable = sources.PATTERNS;
    const at = doProbe && atOk && !atRetired ? await timed(() => airtable.probeReachable(probeTable.base, probeTable.table, 8000)) : null;
    probes.push({
      source: atRetired
        ? `airtable ${airtable.AIRTABLE_URL} — retired for this engine, not probed`
        : `airtable ${airtable.AIRTABLE_URL} (probed with a one-record read of ${probeTable.label} ${probeTable.base}/${probeTable.table}, naming no field)`,
      credential: 'AIRTABLE_TOKEN',
      configured: atOk,
      reachable: atRetired ? null : at ? at.ok : null,
      ms: at?.ms ?? null,
      detail: atRetired
        ? airtable.RETIRED_REASON
        : atOk
          ? (at ? at.detail : 'not probed')
          : 'AIRTABLE_TOKEN is not set, so nothing edited here reaches Airtable and no page can resync.',
      ...(atRetired ? { retired: true } : {}),
    });

    for (const [lane, envVar] of Object.entries(bharag.LANE_KEY_VARS)) {
      const keyed = bharag.laneConfigured(lane);
      const r = doProbe && keyed ? await timed(() => bharag.openIncidents(lane)) : null;
      probes.push({
        source: `bharag incident ledger — ${lane} (${bharag.BHARAG_URL})`,
        credential: envVar,
        configured: keyed,
        reachable: r ? r.ok : null,
        ms: r?.ms ?? null,
        detail: keyed ? (r ? r.detail : 'not probed') : `${envVar} is not set, so this lane is never read. An unread lane is not a healthy lane.`,
      });
    }

    const nOk = n8n.n8nConfigured();
    const nr = doProbe && nOk ? await timed(() => n8n.workflows(1)) : null;
    probes.push({
      source: `n8n instance API ${n8n.n8nBase()} (probed with GET /workflows)`,
      credential: n8n.N8N_API_VAR,
      configured: nOk,
      reachable: nr ? nr.ok : null,
      ms: nr?.ms ?? null,
      detail: nOk ? (nr ? nr.detail : 'not probed') : `${n8n.N8N_API_VAR} is not set, so no execution is ever read and the Executions page says so rather than reading zero.`,
    });

    // What Render says it built. No guessing: absent means absent.
    const commit = process.env.RENDER_GIT_COMMIT?.trim() || null;
    const branch = process.env.RENDER_GIT_BRANCH?.trim() || null;
    const service = process.env.RENDER_SERVICE_ID?.trim() || null;
    let built: string | null = null;
    try {
      built = new Date(statSync(path.join(REPO_ROOT, 'dist', 'index.html')).mtimeMs).toISOString();
    } catch {
      built = null;
    }
    const upMs = Date.now() - new Date(deps.startedAt).getTime();

    return {
      deployed: {
        commit,
        branch,
        render_service_id: service,
        render_instance_id: process.env.RENDER_INSTANCE_ID?.trim() || null,
        front_end_built_at: built,
        node: process.version,
        note:
          commit
            ? null
            : 'RENDER_GIT_COMMIT is not set in this process, so the deployed commit cannot be read. It is not guessed at from the checkout, which may have moved since the build.',
      },
      process: {
        started_at: deps.startedAt,
        uptime_seconds: Math.round(upMs / 1000),
        uptime: `${Math.floor(upMs / 3_600_000)}h ${Math.floor((upMs % 3_600_000) / 60_000)}m`,
      },
      source_tree_readable: sourceAvailable(),
      probed: doProbe,
      sources: probes,
    };
  },
};

/* ------------------------------------------------------- the held data */

const queryPostgres: ToolDefinition = {
  name: 'query_postgres',
  description:
    'Run one read-only SELECT against this dashboard\u2019s own Postgres. Answers anything about the rows this database holds without a tool having to exist for the question. **Bind values as positional parameters** — pass sql "select * from engine_loops where fields->>\'Status\' = $1" with parameters ["Open"] rather than interpolating into the string. Only a single SELECT or WITH \u2026 SELECT is accepted; it runs inside a read-only transaction with a five-second statement timeout, so a write cannot land regardless of the SQL. Rows are capped and the cap is stated when it bites. Use describe_schema first if you are unsure of a column name.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'One SELECT, or WITH \u2026 SELECT. Use $1, $2 for values.' },
      parameters: { type: 'array', description: 'Positional parameters bound to $1, $2 \u2026', items: {} },
      row_limit: { type: 'number', description: `Rows to return. Default ${DEFAULT_ROWS}, maximum ${MAX_ROWS}.` },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'Read-only SQL against the dashboard database' },
  handler: async (args) => {
    const sql = str(args, 'sql', true)!;
    const params = Array.isArray(args.parameters) ? (args.parameters as unknown[]) : [];
    return runSelect(sql, params, num(args, 'row_limit') ?? DEFAULT_ROWS);
  },
};

const describeSchema: ToolDefinition = {
  name: 'describe_schema',
  description:
    'The real columns, types, indexes and row counts of this database\u2019s tables, read from information_schema rather than from any list in the repository. Both faults found through this server on 20 Sep 2026 were field-name mismatches — a probe asking for a column a table has not got, and a handler reading a field its input never carried — so the cheapest way to see a true name is worth its tokens. Pass a table to narrow it; with no argument it returns every table, which is large.',
  inputSchema: {
    type: 'object',
    properties: { table: { type: 'string', description: 'One table, e.g. "engine_pay_sessions". Omitted returns them all.' } },
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'The database\u2019s real column names' },
  handler: async (args) => describeTables(str(args, 'table')),
};

/* --------------------------------------------------------- the mirrors */

const getMirrorStatus: ToolDefinition = {
  name: 'get_mirror_status',
  description:
    '**Start here when a page looks empty.** For every mirror kind, or one named kind: the engine_* table, its row count, when a row last changed, how many rows arrived from the engine versus from a resync, which Airtable base and table feeds it, and which page button refills it. Each kind carries a one-sentence verdict, because "never read" and "the source really is empty" look identical in a row count and only one of them is a dashboard fault. Reads nothing external — one query per kind. This is the call that would have replaced four on 20 Sep 2026.',
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', description: 'One mirror kind, e.g. "pay_sessions". Omitted returns all eighteen.' } },
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'Has each mirror been filled, and from where' },
  handler: async (args) => {
    const k = str(args, 'kind');
    return mirrorStatus(k ? assertKind(k) : null);
  },
};

const diffSourceVsMirror: ToolDefinition = {
  name: 'diff_source_vs_mirror',
  description:
    'For one mirror kind: the row count in the upstream Airtable table, the count in the engine_* table, the difference, and up to ten record ids present on one side and absent on the other, each side labelled. **This one is slow and costs external calls** — Airtable cannot be asked for record ids alone, so it reads the source tables whole, the same read a resync does. Use get_mirror_status first; come here when the two counts need settling. A source table that could not be read is named with its error and never counted as empty.',
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', description: 'The mirror kind to compare, e.g. "pay_sessions".' } },
    required: ['kind'],
    additionalProperties: false,
  },
  annotations: { ...READS_WORLD, title: 'Compare a source table against its mirror' },
  handler: async (args) => diff(assertKind(str(args, 'kind', true)!)),
};

/* ------------------------------------------------------------- the logs */

const searchLogs: ToolDefinition = {
  name: 'search_logs',
  description:
    'Recent lines this process has logged and requests it has answered, newest first, filtered by route, status class ("2xx", "4xx", "5xx", "errors") and a time window in minutes. The buffer is **in memory only**: it starts empty at every boot and deploy and holds the last few thousand lines, so a window reaching further back is reported as not retained rather than as nothing having happened. Render holds the full log.',
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'Substring of the route or the line, e.g. "/api/pay" or "early-access".' },
      status_class: { type: 'string', description: '"2xx", "4xx", "5xx", or "errors" for both of the last two. Requests only.' },
      contains: { type: 'string', description: 'Substring anywhere in the line.' },
      minutes: { type: 'number', description: 'How far back to look. Default 60, maximum 1440.' },
      limit: { type: 'number', description: 'Lines to return. Default 50, maximum 200.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Recent requests and log lines' },
  handler: async (args) =>
    logs.search({
      route: str(args, 'route'),
      status_class: str(args, 'status_class'),
      contains: str(args, 'contains'),
      minutes: num(args, 'minutes'),
      limit: num(args, 'limit'),
    }),
};

/* ------------------------------------------------------------- the copy */

/**
 * One run per resync pass per minute.
 *
 * Keyed on the pass rather than on the kind: pressing Resync on Pay Tracker
 * reads all three of its tables, so asking for `pay_builders` a second later
 * would re-run the same sweep under a different name. In flight is reported as
 * in flight rather than queued — a queue would turn an impatient caller into a
 * pile-up on Airtable's rate limit.
 */
const RESYNC_COOLDOWN_MS = 60_000;
const lastResync = new Map<string, { startedAt: number; finishedAt: number | null }>();

const resyncTool: ToolDefinition = {
  name: 'resync',
  description:
    'Fill a mirror from its source, by running exactly the resync the page\u2019s own button runs. Reports rows before, rows after, rows changed and how long it took. This is the one tool here that is not a read — and it copies rows that already exist from a source this dashboard already reads, so it destroys nothing and needs no confirmation. Several kinds share one pass (the three pay tables are one sweep, as are the three Engine health sources), and the answer names the siblings it also filled. One run per pass per 60 seconds: a second call inside that is refused with how long ago the last one ran, never queued.',
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', description: 'The mirror kind to fill, e.g. "pay_sessions".' } },
    required: ['kind'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Fill a mirror from its source' },
  handler: async (args) => {
    const kind = assertKind(str(args, 'kind', true)!);
    // Retired before anything else: the one tool here that acts must not act on
    // a source the engine no longer depends on (2026-09-22). **Only where that
    // source is Airtable** — incidents come from BHARAG, and refusing them with
    // the rest is how the ledger went unread from 17 Sep.
    if (airtable.retired() && SOURCE_OF[kind].system === 'airtable') throw new McpError('airtable_retired', airtable.RETIRED_REASON);
    const route = RESYNC_ROUTE[kind];
    if (!route) {
      throw new McpError(
        'no_resync',
        `Nothing resyncs "${kind}". It is filled only by the engine posting to /api/engine/${kind}, so an empty table means those posts are not arriving — which is an n8n question, not one this tool can answer. get_mirror_status("${kind}") says what is held.`,
      );
    }

    const held = lastResync.get(route.label);
    const now = Date.now();
    if (held && held.finishedAt === null) {
      throw new McpError('already_running', `"${route.label}" is already running — it started ${Math.round((now - held.startedAt) / 1000)}s ago. Wait for it rather than starting a second sweep of the same tables.`);
    }
    if (held && held.finishedAt !== null && now - held.finishedAt < RESYNC_COOLDOWN_MS) {
      const ago = Math.round((now - held.finishedAt) / 1000);
      throw new McpError(
        'too_soon',
        `"${route.label}" ran ${ago}s ago and the cooldown is ${RESYNC_COOLDOWN_MS / 1000}s. It is refused rather than queued. If the rows still are not there, the gap is upstream — run diff_source_vs_mirror("${kind}") to see whether the source has them at all.`,
      );
    }

    const before = await mirrorStatus(kind);
    lastResync.set(route.label, { startedAt: now, finishedAt: null });
    const t0 = Date.now();
    try {
      const result = await route.run('mcp');
      const after = await mirrorStatus(kind);
      const rowsBefore = before.kinds[0].rows;
      const rowsAfter = after.kinds[0].rows;
      return {
        kind,
        pass: route.label,
        also_fills: route.fills.filter((k) => k !== kind),
        rows_before: rowsBefore,
        rows_after: rowsAfter,
        rows_added: rowsAfter - rowsBefore,
        ms: Date.now() - t0,
        /** The resync's own report: inserted, updated, deleted, refused, per table. */
        resync: result,
        verdict:
          rowsAfter === rowsBefore
            ? `No change: ${rowsBefore} row(s) before and after. Either the mirror was already current, or the source has nothing more — diff_source_vs_mirror("${kind}") is what tells those apart.`
            : `${rowsBefore} → ${rowsAfter} row(s).`,
      };
    } finally {
      lastResync.set(route.label, { startedAt: now, finishedAt: Date.now() });
    }
  },
};

/* -------------------------------------------------------- recovery */

const getRecoveryStatus: ToolDefinition = {
  name: 'get_recovery_status',
  description:
    'The engine recovery watcher (2026-09-23): which open incidents are waiting on a dependency that was down (OpenRouter, Slack, Google, BHARAG), which were passed over and why, what the next five-minute tick would do, the last dependency probe, and the last recovery batch with the outcomes its Slack summary carried. **Calls nothing** — the same plan GET /api/engine/recovery/plan answers, read from what this database holds, plus the last batch. Use it to see whether a waiting failure will be re-run, and why not.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { ...READS_DB, title: 'What the recovery watcher is waiting on, and what it did last' },
  handler: async () => ({ ...(await recovery.plan()), last_batch: await recovery.lastBatch() }),
};

export const TOOLS: ToolDefinition[] = [
  // The reads, in the order the instructions suggest reaching for them.
  listPages,
  getPageStructure,
  getComponent,
  searchSource,
  listDataSources,
  getPageData,
  getHealth,
  getMirrorStatus,
  diffSourceVsMirror,
  queryPostgres,
  describeSchema,
  searchLogs,
  getRecoveryStatus,
  // The one that is not a read.
  resyncTool,
];

export function toolByName(name: string): ToolDefinition | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * The catalogue as `tools/list` returns it: no handlers, just the contract.
 *
 * The annotations go out with it. The spec's default for a tool without them is
 * "potentially destructive", so a client seeing this list unannotated would
 * offer to checkpoint before a `SELECT`.
 */
export function toolCatalogue(): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }[] {
  return TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

/** Kept honest in one place: the source tree is what every structure tool needs. */
export function sourceWarning(): string | null {
  return sourceAvailable() ? null : `The source tree is not readable from ${REPO_ROOT}, so list_pages, get_page_structure, get_component, search_source and list_data_sources will all fail. get_health and get_page_data still work.`;
}
