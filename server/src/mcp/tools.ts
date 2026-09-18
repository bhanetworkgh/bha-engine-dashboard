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
import * as n8n from '../n8n';
import * as sources from '../sources';
import { grepSource, McpError, REPO_ROOT, sourceAvailable, assertSource } from './source';
import { component, dataSources, pageByPath, pageData, pageFiles, pages, pageStructure } from './structure';

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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;
}

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

/* ----------------------------------------------------------------- tools */

const listPages: ToolDefinition = {
  name: 'list_pages',
  description:
    'Every route this dashboard serves: the path, the page title, the file that implements it, and a one-line description of what the page is for. Read out of the router (src/App.tsx), the sidebar (src/components/Layout.tsx) and each page’s own PageHeader, falling back to that page’s section in CLAUDE.md. Never a hand-written list. Where there is no description in source, the field is null and says so rather than being filled in.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
      max_bytes: { type: 'number', description: `Size cap for the whole answer. Default ${MAX_DATA_BYTES}.` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, deps) => {
    assertSource();
    const page = pageByPath(str(args, 'path', true)!);
    if (!page.file) throw new McpError('no_source', page.note ?? `No file implements ${page.path}, so there is no data to read for it.`);
    const only = str(args, 'route');
    const cap = Math.max(4096, Math.min(400 * 1024, num(args, 'max_bytes') ?? MAX_DATA_BYTES));

    const routes = pageData(pageFiles(page.file)).api_routes;
    const fetched: { api: string; status: number; bytes: number; data?: unknown; shape?: unknown; note?: string }[] = [];
    const skipped: { api: string; reason: string }[] = [];
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

    return {
      path: page.path,
      title: page.title,
      read_at: new Date().toISOString(),
      fetched,
      skipped,
      bytes: spent,
      cap,
      derivation: 'Each route was resolved from the src/data functions the page’s files import, then run through this server’s own /api router — the same function that answers the browser, in this process, against the same Postgres.',
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

    const atOk = airtable.airtableConfigured();
    const at = doProbe && atOk ? await timed(() => airtable.listRecordIds(sources.PATTERNS.base, sources.PATTERNS.table, 8000)) : null;
    probes.push({
      source: `airtable ${airtable.AIRTABLE_URL} (probed with a read of Build Patterns ${sources.PATTERNS.base}/${sources.PATTERNS.table})`,
      credential: 'AIRTABLE_TOKEN',
      configured: atOk,
      reachable: at ? at.ok : null,
      ms: at?.ms ?? null,
      detail: atOk ? (at ? at.detail : 'not probed') : 'AIRTABLE_TOKEN is not set, so nothing edited here reaches Airtable and no page can resync.',
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

export const TOOLS: ToolDefinition[] = [listPages, getPageStructure, getComponent, searchSource, listDataSources, getPageData, getHealth];

export function toolByName(name: string): ToolDefinition | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/** The catalogue as `tools/list` returns it: no handlers, just the contract. */
export function toolCatalogue(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Kept honest in one place: the source tree is what every structure tool needs. */
export function sourceWarning(): string | null {
  return sourceAvailable() ? null : `The source tree is not readable from ${REPO_ROOT}, so list_pages, get_page_structure, get_component, search_source and list_data_sources will all fail. get_health and get_page_data still work.`;
}
