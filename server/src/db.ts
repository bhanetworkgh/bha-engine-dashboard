/**
 * The small key/value state, and the two date helpers everything uses.
 *
 * Until 2026-09-12 this opened a SQLite file under DATA_DIR. It is Postgres
 * now (see pg.ts and migrations.ts): the service has no persistent disk, so
 * that file was wiped on every deploy and every spin-down, and anything
 * derived from it — the status-change history above all — could not be
 * trusted across a restart. The schema lives in migrations.ts, forward-only;
 * nothing here creates or drops a table.
 */
import { query, type Queryable } from './pg';
import { getPool } from './pg';

/** Where the rows live, for /api/status. Host and database only, never the password. */
export { databaseIdentity } from './pg';

function db(on?: Queryable): Queryable {
  return on ?? getPool();
}

export async function getMeta(key: string, on?: Queryable): Promise<string | null> {
  const r = await db(on).query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string, on?: Queryable): Promise<void> {
  await db(on).query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}

/**
 * Sets a key only if it is not already there, and returns what the key holds
 * afterwards. `history_since` needs exactly this: the first boot against a
 * fresh database stamps it, every later boot leaves it alone, and two
 * instances booting together cannot race to two different answers.
 */
export async function setMetaIfAbsent(key: string, value: string, on?: Queryable): Promise<string> {
  const r = await db(on).query<{ value: string }>(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = meta.value
     RETURNING value`,
    [key, value],
  );
  return r.rows[0].value;
}

export { query };

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return nowIso().slice(0, 10);
}
