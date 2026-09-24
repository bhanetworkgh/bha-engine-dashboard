/**
 * `find_records` — one structured read for every writable kind (2026-09-24,
 * Destiny).
 *
 * The Bays agent read loops, the lane backlog, commercial cards, research jobs
 * and pattern candidates through six separate n8n tools, and the only generic
 * read on this MCP server was raw SQL, which an agent should not be writing.
 * This is the one read that replaces them: filters, a word search, an
 * open-only switch, three orders, and counts over the whole filtered set.
 *
 * **Read only, on both connections.** It is registered with the read tools, so
 * a client already connected — read URL or write URL — picks it up on its next
 * tool refresh without reconnecting.
 *
 * **The search is n8n's, not a new one.** Tokens and stopwords are
 * `RML - Format My Loops`' own (Bays — Tools Router): lower-case, anything but
 * `[a-z0-9 _-]` to a space, split on spaces, underscores and hyphens, words
 * over two characters that are not stopwords. A row scores the share of the
 * search's words found in its text (`match_score`, 0–1), rows with no word
 * found are dropped, best first. That is deliberately a different measure from
 * the duplicate gate's: a search asks "does this row mention what I asked",
 * the gate asks "is this the same work".
 *
 * **Loops are one row per `loop_id`**, the most recently written — the rule
 * `store.countOpenLoops()` follows — so a copy left behind by a move neither
 * counts twice nor answers a search with the stale copy, and the counts here
 * agree with the Open loops page.
 *
 * **Nothing is silently ignored.** A filter naming a field no row of that kind
 * carries, or a value outside a field's fixed vocabulary, is still applied —
 * it will likely match nothing — and comes back as a warning naming what was
 * expected, because a filter that quietly vanished answers a different
 * question confidently.
 *
 * Every call is logged to `engine_writes` as `read`, endpoint
 * `mcp:find_records` — the log n8n's own lookups land on — and not to
 * `engine_mcp_writes`, which is the record of changes and would bury them
 * under reads.
 */
import { query } from '../pg';
import * as mirror from '../mirror';
import * as guards from '../writeGuards';
import { McpError } from './source';

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;
/** Top-level columns a filter may name directly; each only where that kind's table has it. */
const COLUMNS = ['id', 'natural_id', 'builder_id', 'lane_id', 'table_id'] as const;

/** `RML - Format My Loops`' stopwords, verbatim. */
const STOP = new Set(['the','and','for','that','this','with','from','into','not','are','was','were','has','have','had','can','should','need','needs','via','per','you','your','our','all','any','but','its','who','how','why','what','when','then','than','also','been','will','would','each','other','same','only','over','more','some','such','they','them','their','there','here','which','while','after','before','loop','loops','open','work']);

/** `RML - Format My Loops`' `toks`, verbatim in behaviour. */
export function searchTokens(s: string): string[] {
  return [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/[\s_-]+/).filter((t) => t.length > 2 && !STOP.has(t)))];
}

interface KindShape {
  /** Where a search looks, besides the natural id. */
  search: string[];
  status: string | null;
  lane: string | null;
  /** When the thing happened, for newest/oldest and within-status age. */
  date: string | null;
  page: string | null;
}

/**
 * Per kind: what a search reads, which field is the status and the lane, which
 * date orders it, and where the page is. Loops search What, loop_id and
 * lane_tag, as the router does; the other kinds their title field and the one
 * beside it that carries the substance, plus their natural id.
 */
const SHAPE: Record<string, KindShape> = {
  loops: { search: ['What', 'lane_tag'], status: 'Status', lane: 'lane_tag', date: 'Date Raised', page: '/open-loops' },
  codex: { search: ['Builder Name', 'Summary', 'Session Description'], status: 'Jason Status', lane: null, date: 'Timestamp', page: '/codex' },
  layer0: { search: ['Builder Username', 'Session Description'], status: 'Status', lane: null, date: 'Created At', page: '/codex' },
  patterns: { search: ['pattern_name', 'problem'], status: null, lane: null, date: 'created_at', page: '/build-patterns' },
  pattern_candidates: { search: ['Candidate', 'Summary'], status: 'Status', lane: 'Lane', date: 'Date Flagged', page: '/build-patterns?view=candidates' },
  commercial: { search: ['opportunity_title', 'pain_point'], status: null, lane: 'lane_id', date: 'created_at', page: '/commercial' },
  'rt-jobs': { search: ['Question', 'Context'], status: 'Status', lane: 'Lane', date: 'Opened At', page: '/research-twin' },
  lane_backlog: { search: ['task'], status: 'status', lane: 'lane', date: null, page: null },
  builder_profiles: { search: ['name', 'role', 'lane'], status: null, lane: 'lane', date: null, page: null },
};

export const READABLE_KINDS = [...guards.WRITABLE_KINDS, 'layer0'];

/** The public address the pages are served at, for links in replies. */
function pageUrl(kind: string): string | null {
  const path = SHAPE[kind]?.page;
  if (!path) return null;
  const base = (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
  return `${base}${path}`;
}

interface Row {
  id: number;
  natural_id: string | null;
  builder_id: string | null;
  lane_id: string | null;
  table_id: string | null;
  created_time: string | null;
  updated_at: string;
  fields: Record<string, unknown>;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v) && 'name' in (v as object)) return String((v as { name: unknown }).name ?? '');
  return Array.isArray(v) ? v.map(str).join(' ') : String(v);
}

function list(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

export async function findRecords(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  if (!READABLE_KINDS.includes(kind)) throw new McpError('bad_argument', `"kind" must be one of: ${READABLE_KINDS.join(', ')}.`);
  const mk = kind as mirror.MirrorKind;
  const spec = mirror.KINDS[mk];
  const shape = SHAPE[kind];
  const selects = guards.writable(kind)?.selects ?? (kind === 'layer0' ? { Status: ['pending_builder_input', 'completed'] } : {});
  const warnings: string[] = [];

  const limitRaw = args.limit === undefined ? LIMIT_DEFAULT : Number(args.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) throw new McpError('bad_argument', `"limit" must be a whole number from 1 to ${LIMIT_MAX}.`);
  const limit = Math.min(limitRaw, LIMIT_MAX);
  if (limitRaw > LIMIT_MAX) warnings.push(`"limit" ${limitRaw} is over the maximum; ${LIMIT_MAX} were asked for instead.`);
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new McpError('bad_argument', '"offset" must be a whole number, 0 or more.');
  const order = args.order === undefined ? (typeof args.search === 'string' && args.search.trim() ? 'relevance' : 'newest') : String(args.order);
  if (!['newest', 'oldest', 'status_age', 'relevance'].includes(order)) throw new McpError('bad_argument', '"order" must be newest, oldest or status_age.');

  /* ---- the filters, as SQL: every value a bound parameter ---- */
  const cols = await mirror.columnsOf(mk);
  const where: string[] = [];
  const params: unknown[] = [];
  const filters = args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters) ? (args.filters as Record<string, unknown>) : {};
  if (args.filters !== undefined && !(args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters))) {
    throw new McpError('bad_argument', '"filters" must be an object: { "<field>": value or [values] }.');
  }
  for (const [name, raw] of Object.entries(filters)) {
    let values = list(raw);
    if (!values.length) {
      warnings.push(`Filter "${name}" had no value and was not applied.`);
      continue;
    }
    const isColumn = (COLUMNS as readonly string[]).includes(name);
    if (isColumn && !cols.has(name)) {
      warnings.push(`"${name}" is not a column ${spec.table} has (it has ${COLUMNS.filter((c) => cols.has(c)).join(', ')}), so this filter matches nothing.`);
    }
    if (!isColumn) {
      const seen = await query(`SELECT 1 FROM ${spec.table} WHERE fields ? $1 LIMIT 1`, [name]);
      if (!seen.rowCount) warnings.push(`No ${kind} row carries a field called "${name}" (field names are case- and space-exact), so this filter matches nothing.`);
      const allowed = selects[name];
      if (allowed) {
        values = values.map((v) => allowed.find((a) => a.toLowerCase() === v.toLowerCase()) ?? v);
        const bad = values.filter((v) => !allowed.includes(v));
        if (bad.length) warnings.push(`"${name}" ${bad.map((b) => `"${b}"`).join(', ')} is not one of ${allowed.join(', ')}.`);
      }
    }
    params.push(values);
    const p = `$${params.length}::text[]`;
    if (isColumn) where.push(cols.has(name) ? `${name}::text = ANY(${p})` : 'false');
    else {
      params.push(name);
      where.push(`fields->>$${params.length} = ANY(${p})`);
    }
  }

  const statusNot = list(args.status_not);
  if (statusNot.length) {
    if (!shape.status) warnings.push(`${kind} has no status field, so "status_not" was not applied.`);
    else {
      params.push(statusNot, shape.status);
      // IS DISTINCT FROM, so a row that never had a status still counts as not-closed.
      where.push(`NOT (fields->>$${params.length} = ANY($${params.length - 1}::text[]) AND fields->>$${params.length} IS NOT NULL)`);
    }
  }

  const colList = ['id', 'natural_id', ...['builder_id', 'lane_id', 'table_id'].map((c) => (cols.has(c) ? c : `NULL::text AS ${c}`)), 'created_time', 'updated_at', 'fields'].join(', ');
  const base =
    kind === 'loops'
      ? `SELECT * FROM (SELECT DISTINCT ON (COALESCE(natural_id, 'row:' || id)) ${colList} FROM ${spec.table}
           ORDER BY COALESCE(natural_id, 'row:' || id), updated_at DESC, id DESC) one`
      : `SELECT ${colList} FROM ${spec.table}`;
  const r = await query<Row>(`${base}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params);
  let rows = r.rows.map((x) => ({ ...x, id: Number(x.id) })) as (Row & { match_score?: number; matched_terms?: string[] })[];

  /* ---- the search ---- */
  const search = typeof args.search === 'string' ? args.search.trim() : '';
  const words = searchTokens(search);
  if (search && !words.length) warnings.push(`"${search}" has no word over two characters that is not a stopword, so nothing was searched for.`);
  if (words.length) {
    rows = rows
      .map((row) => {
        const hay = [...shape.search.map((f) => str(row.fields[f])), str(row.natural_id)].join(' ').toLowerCase();
        const hits = words.filter((w) => hay.includes(w));
        return { ...row, match_score: Math.round((hits.length / words.length) * 100) / 100, matched_terms: hits };
      })
      .filter((row) => row.match_score > 0);
  }

  /* ---- the order ---- */
  const dateOf = (row: Row) => (shape.date ? str(row.fields[shape.date]) : '') || row.created_time || row.updated_at || '';
  const RANK: Record<string, number> = { 'In Progress': 0, Open: 1, Closed: 2 };
  const byNewest = (a: Row, b: Row) => dateOf(b).localeCompare(dateOf(a)) || b.id - a.id;
  if (order === 'relevance' && words.length) rows.sort((a, b) => (b.match_score! - a.match_score!) || byNewest(a, b));
  else if (order === 'oldest') rows.sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.id - b.id);
  else if (order === 'status_age') {
    // The router's order: In Progress, then Open, oldest first within each.
    const rank = (row: Row) => (shape.status ? RANK[str(row.fields[shape.status]) || 'Open'] ?? 9 : 9);
    rows.sort((a, b) => rank(a) - rank(b) || dateOf(a).localeCompare(dateOf(b)) || a.id - b.id);
  } else rows.sort(byNewest);

  /* ---- counts over the whole filtered set ---- */
  const tally = (get: (row: Row) => string) => {
    const m: Record<string, number> = {};
    for (const row of rows) {
      const k = get(row) || '(none)';
      m[k] = (m[k] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };
  const counts: Record<string, Record<string, number>> = {};
  if (shape.status) counts.by_status = tally((row) => str(row.fields[shape.status!]));
  if (shape.lane) counts.by_lane = tally((row) => str(row.fields[shape.lane!]) || (row.lane_id ?? ''));
  if (cols.has('builder_id')) counts.by_builder = tally((row) => row.builder_id ?? '');

  const pageRows = rows.slice(offset, offset + limit).map((row) => ({
    id: row.id,
    natural_id: row.natural_id,
    ...(cols.has('builder_id') ? { builder_id: row.builder_id } : {}),
    ...(cols.has('lane_id') ? { lane_id: row.lane_id } : {}),
    ...(cols.has('table_id') ? { table_id: row.table_id } : {}),
    created_time: row.created_time,
    updated_at: row.updated_at,
    ...(row.match_score !== undefined ? { match_score: row.match_score, matched_terms: row.matched_terms } : {}),
    fields: row.fields,
  }));

  return {
    kind,
    total: rows.length,
    returned: pageRows.length,
    offset,
    truncated: offset + pageRows.length < rows.length,
    order: order === 'relevance' ? 'best match first, then newest' : order,
    ...(words.length ? { searched_words: words } : {}),
    counts,
    rows: pageRows,
    page_url: pageUrl(kind),
    ...(kind === 'loops' ? { note: 'One row per loop_id, the most recently written — the rule the Open loops page counts by.' } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
