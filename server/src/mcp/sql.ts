/**
 * Read-only SQL against this dashboard's own database, for the MCP server.
 *
 * `get_page_data` answers "what would the page show"; this answers anything
 * else about the rows this database holds, without a tool having to exist for
 * each question. Two of the faults found through this MCP on 20 Sep 2026 were
 * questions a `SELECT` answers in one call — "how many pay sessions are there"
 * and "what are this table's real column names" — and neither had a tool.
 *
 * **Three layers stop a write, not one.** They are deliberately redundant,
 * because each one alone has a hole:
 *
 *  1. The statement is parsed enough to insist it is a single `SELECT` or
 *     `WITH … SELECT`. A string check alone is the weakest of the three — SQL
 *     is not a regular language and somebody will eventually find a shape this
 *     misses — which is why it is not the only one.
 *  2. It runs inside `BEGIN TRANSACTION READ ONLY`. Postgres itself refuses an
 *     `INSERT`, `UPDATE`, `DELETE`, `CREATE` or `COPY TO` inside one, so a
 *     write that got past the parser dies at the server rather than landing.
 *  3. The transaction is rolled back at the end whatever happened, so even a
 *     side effect Postgres permits in a read-only transaction does not persist.
 *
 * And a `statement_timeout`, because a read-only query can still take the
 * database down by running for an hour.
 */
import { getPool, query } from '../pg';
import { McpError } from './source';

/** Five seconds. Long enough for any honest question about a table this size. */
const STATEMENT_TIMEOUT_MS = 5000;

export const DEFAULT_ROWS = 100;
export const MAX_ROWS = 1000;

/**
 * Strips comments and string literals so the shape of the statement can be
 * checked without a quoted semicolon or a commented-out `--; delete` fooling it.
 */
function skeleton(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === q && sql[i + 1] === q) {
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          i++;
          break;
        }
        i++;
      }
      // A literal becomes a placeholder so it cannot contribute a keyword.
      out += ' ? ';
      continue;
    }
    if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      // A dollar-quoted body. Skip it whole.
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out += ' ? ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Statements this refuses by name, so the reason names the word it found. */
const FORBIDDEN = [
  'insert',
  'update',
  'delete',
  'truncate',
  'drop',
  'create',
  'alter',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'vacuum',
  'analyze',
  'reindex',
  'cluster',
  'refresh',
  'comment',
  'security',
  'listen',
  'notify',
  'lock',
  'set',
  'reset',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'prepare',
  'execute',
  'deallocate',
  'discard',
  'import',
];

/**
 * Insists the statement is one read.
 *
 * Refused before execution, with the reason naming what was found — a caller
 * who gets "no semicolon-joined statements" can fix their call, and one who
 * gets a bare "rejected" cannot.
 */
export function assertSingleSelect(sql: string): void {
  const bare = skeleton(sql).trim();
  if (!bare) throw new McpError('bad_sql', 'No statement was given.');

  // One statement. A trailing semicolon is fine; a second statement is not.
  const withoutTrailing = bare.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new McpError('bad_sql', 'Only one statement is allowed, and this one contains a semicolon with something after it. Send a single SELECT.');
  }

  const first = /^[a-z]+/i.exec(withoutTrailing.trimStart())?.[0]?.toLowerCase() ?? '';
  if (first !== 'select' && first !== 'with' && first !== '(') {
    throw new McpError('bad_sql', `A statement here must start with SELECT or WITH. This one starts with "${first || withoutTrailing.slice(0, 12)}".`);
  }

  /**
   * A `WITH` can carry a writable CTE — `WITH x AS (DELETE … RETURNING *)` is
   * valid Postgres and is a write. The read-only transaction would refuse it,
   * but refusing it here means the caller is told what was wrong with their
   * SQL rather than being handed a transaction error.
   */
  const words = withoutTrailing.toLowerCase().match(/[a-z_]+/g) ?? [];
  for (const w of words) {
    if (FORBIDDEN.includes(w)) {
      // `select … for update` is the one case where a forbidden word is not a
      // second statement, and it still takes a row lock, so it is still out.
      throw new McpError('bad_sql', `"${w}" is not allowed here. This tool runs one read: a single SELECT or WITH … SELECT, inside a read-only transaction.`);
    }
  }
}

export interface SqlResult {
  sql: string;
  parameters: unknown[];
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  row_count: number;
  capped: boolean;
  cap: number;
  ms: number;
  note: string | null;
}

/** Postgres type oids are numbers on the wire; these are the ones worth naming. */
function typeName(oid: number): string {
  const known: Record<number, string> = {
    16: 'bool', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 700: 'float4', 701: 'float8',
    1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric',
    2950: 'uuid', 3802: 'jsonb',
  };
  return known[oid] ?? `oid:${oid}`;
}

/**
 * Runs one read.
 *
 * The transaction is opened `READ ONLY` and rolled back at the end regardless
 * of the outcome — there is nothing to commit, and a rollback on the success
 * path means the code has exactly one exit for both.
 */
export async function runSelect(sql: string, params: unknown[], rowCap: number): Promise<SqlResult> {
  assertSingleSelect(sql);
  const cap = Math.max(1, Math.min(MAX_ROWS, rowCap));
  const client = await getPool().connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    /**
     * Wrapped in an outer LIMIT of one past the cap.
     *
     * Reading the whole result set and slicing it would report an exact total —
     * and would pull a million rows into this process to do it, on a tool whose
     * whole point is to be cheap. So the fetch is bounded, and where the bound
     * is hit the answer says the count is a floor rather than a total. A
     * cap-plus-one read cannot tell you how many there were; it can tell you
     * there were more, which is the honest half.
     */
    const r = await client.query({
      text: `SELECT * FROM (${sql}) AS mcp_query LIMIT ${cap + 1}`,
      values: params,
      rowMode: 'array' as const,
    });
    const fields = r.fields.map((f) => ({ name: f.name, type: typeName(f.dataTypeID) }));
    const all = r.rows as unknown[][];
    const capped = all.length > cap;
    const rows = all.slice(0, cap).map((row) => {
      const o: Record<string, unknown> = {};
      fields.forEach((f, i) => (o[f.name] = row[i]));
      return o;
    });
    return {
      sql,
      parameters: params,
      columns: fields,
      rows,
      row_count: rows.length,
      capped,
      cap,
      ms: Date.now() - t0,
      note: capped
        ? `Cut at the ${cap}-row cap, and there is at least one more — this is not a total. Raise row_limit (maximum ${MAX_ROWS}), add your own ORDER BY so the rows you get are the rows you meant, or ask for count(*) instead.`
        : null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Postgres reports the timeout by name; say which of the two it was.
    if (/statement timeout|canceling statement due to statement timeout/i.test(message)) {
      throw new McpError('query_timeout', `The query was cut off after ${STATEMENT_TIMEOUT_MS}ms by the statement timeout. Narrow it, add an index-friendly filter, or ask for a count rather than the rows.`);
    }
    if (/read-only transaction/i.test(message)) {
      throw new McpError('read_only', `Postgres refused that inside a read-only transaction: ${message}. This tool cannot write, by construction rather than by policy.`);
    }
    throw new McpError('query_failed', message);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/* -------------------------------------------------------------- the schema */

export interface TableSchema {
  table: string;
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
  indexes: string[];
  row_count: number;
}

/**
 * The real columns of the `engine_*` tables, read from `information_schema`.
 *
 * Not from a list in this repo, which is the point. **Both faults found on
 * 20 Sep were field-name mismatches** — a health probe asking Airtable for a
 * column that table does not have, and a handler reading a field its input
 * never carried — so the cheapest possible way to see a true name earns its
 * tokens.
 */
export async function describeTables(only: string | null): Promise<{ tables: TableSchema[]; note: string }> {
  const cols = await query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ($1::text IS NULL OR table_name = $1)
      ORDER BY table_name, ordinal_position`,
    [only],
  );
  if (!cols.rows.length) {
    throw new McpError(
      'not_found',
      only
        ? `There is no table called "${only}" in this database. Call describe_schema with no table to see what there is.`
        : 'information_schema returned no columns for the public schema, which should be impossible on a migrated database.',
    );
  }

  const idx = await query<{ tablename: string; indexname: string; indexdef: string }>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND ($1::text IS NULL OR tablename = $1)`,
    [only],
  );
  const counts = new Map<string, number>();
  const names = [...new Set(cols.rows.map((r) => r.table_name))];
  for (const t of names) {
    // Identifier interpolated, not parameterised — a table name cannot be a
    // bind parameter. It came from information_schema, so it exists and is
    // quoted; nothing a caller typed reaches this.
    const c = await query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.replace(/"/g, '""')}"`);
    counts.set(t, Number(c.rows[0]?.n ?? 0));
  }

  const tables: TableSchema[] = names.map((t) => ({
    table: t,
    columns: cols.rows
      .filter((r) => r.table_name === t)
      .map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', default: r.column_default })),
    indexes: idx.rows.filter((r) => r.tablename === t).map((r) => r.indexdef),
    row_count: counts.get(t) ?? 0,
  }));

  return {
    tables,
    note: 'Read from information_schema.columns and pg_indexes in this database, not from any list in this repository — so a column renamed by a migration shows its new name here immediately.',
  };
}
