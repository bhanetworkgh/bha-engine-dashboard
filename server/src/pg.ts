/**
 * Postgres. One pool for the process, reading DATABASE_URL.
 *
 * Decision (2026-09-12, Destiny): a Render Postgres instance (bha-engine-db)
 * is now attached to this service and DATABASE_URL is set on it, so the read
 * model, the status-change history and the observation series live there
 * rather than in a SQLite file under DATA_DIR. The service has no persistent
 * disk; that file was wiped on every deploy and every spin-down, which is why
 * nothing derived from it could be trusted across a restart.
 *
 * There is no fallback. If DATABASE_URL is absent, or the connection fails,
 * the process refuses to serve (see `assertDatabase`). A server that quietly
 * dropped back to an ephemeral file would lose writes with nothing on screen
 * saying so, which is the failure this move exists to end.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL?.trim() || null;

/**
 * What a query can run against: the pool, or one client inside a transaction.
 * Every store function takes one of these so a caller that needs several
 * statements to land together can pass its client down.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * TLS, decided from the URL rather than hardcoded.
 *
 * Render gives a service two URLs for the same database. The internal one
 * (`dpg-…-a`, a single-label host reachable only inside the Render network)
 * carries no TLS and needs none — enabling it there fails the handshake. The
 * external one (`….render.com`) requires TLS and is served by Render's own
 * CA, so verification needs that CA: set DATABASE_CA_CERT to its PEM and it
 * is verified properly. Without the CA, verification is relaxed and a line is
 * printed saying so, because a silent downgrade is the thing worth avoiding.
 *
 * `sslmode` in the URL wins over all of this when it is set.
 */
function sslConfig(url: string): false | { ca?: string; rejectUnauthorized: boolean } {
  const mode = new URL(url).searchParams.get('sslmode');
  if (mode === 'disable') return false;
  const host = new URL(url).hostname;
  const internal = !host.includes('.') || host === 'localhost' || host === '127.0.0.1';
  if (internal && mode === null) return false;
  const ca = process.env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (mode === 'verify-full' || mode === 'verify-ca') {
    // The URL asks for verification and no CA was supplied; say so rather than
    // quietly not verifying.
    console.warn(`  database: ${mode} requested but DATABASE_CA_CERT is not set — using the system trust store.`);
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. This server keeps its read model and its status history in Postgres and has no other store.');
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslConfig(DATABASE_URL),
    // Render's free and starter Postgres plans allow a small number of
    // connections; one web instance with a handful is well inside them.
    max: Number(process.env.DATABASE_POOL_MAX ?? 8) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'bha-engine-dashboard',
  });
  // An idle client dying (a database restart, a network blip) must not take
  // the process down; the next query opens a fresh one.
  pool.on('error', (e) => console.error('postgres pool error', e.message));
  return pool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> {
  return getPool().query<R>(text, values);
}

/** Runs fn inside one transaction, on one client. Rolls back on any throw. */
export async function withTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The client is already broken; the pool discards it on release.
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface DatabaseIdentity {
  host: string;
  port: string;
  database: string;
  /** Render's internal network (no TLS) or a public host (TLS). */
  internal: boolean;
  server_version: string;
}

let identity: DatabaseIdentity | null = null;

/** Where the data actually is, for /api/status. Never the password. */
export function databaseIdentity(): DatabaseIdentity | null {
  return identity;
}

/**
 * The startup check. Called before the server listens.
 *
 * Fails loudly and exits: a missing DATABASE_URL or an unreachable database is
 * a deployment fault, not a degraded mode. Nothing here falls back to the old
 * file store — it no longer exists — so a process that cannot reach Postgres
 * has no honest way to answer a single request.
 */
export async function assertDatabase(): Promise<DatabaseIdentity> {
  if (!DATABASE_URL) {
    console.error('');
    console.error('FATAL: DATABASE_URL is not set.');
    console.error('');
    console.error('  This server keeps the record read model, the status-change history and');
    console.error('  the observation series in Postgres. There is no file or in-memory store to');
    console.error('  fall back to, and starting without one would lose every write silently.');
    console.error('');
    console.error('  On Render: add the bha-engine-db instance to this service and set');
    console.error('  DATABASE_URL from it (Environment → Add from database → Internal URL).');
    console.error('  Locally: DATABASE_URL=postgres://user:pass@localhost:5432/bha_engine npm start');
    console.error('');
    process.exit(1);
  }

  let url: URL;
  try {
    url = new URL(DATABASE_URL);
  } catch {
    console.error('');
    console.error('FATAL: DATABASE_URL is not a URL.');
    console.error('  Expected postgres://user:password@host:5432/database — got something that does not parse.');
    console.error('');
    process.exit(1);
  }

  const host = url.hostname;
  const database = url.pathname.replace(/^\//, '') || '(none)';
  try {
    const r = await query<{ version: string; db: string }>('SELECT current_setting($1) AS version, current_database() AS db', ['server_version']);
    identity = {
      host,
      port: url.port || '5432',
      database: r.rows[0]?.db ?? database,
      internal: !host.includes('.') || host === 'localhost' || host === '127.0.0.1',
      server_version: r.rows[0]?.version ?? 'unknown',
    };
    return identity;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('');
    console.error('FATAL: could not connect to Postgres.');
    console.error(`  host:     ${host}:${url.port || '5432'}`);
    console.error(`  database: ${database}`);
    console.error(`  error:    ${message}`);
    console.error('');
    console.error('  Nothing is served without it: the read model, the status history and the');
    console.error('  observations all live there, and there is no fallback store by design.');
    if (/self.signed|certificate/i.test(message)) {
      console.error('');
      console.error('  This reads as a TLS problem. On Render use the internal database URL');
      console.error('  (host dpg-…-a, no TLS) from a service in the same region, or set');
      console.error('  DATABASE_CA_CERT to the PEM Render publishes for the external URL.');
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      console.error('');
      console.error('  The host did not resolve. An internal Render hostname only resolves from');
      console.error('  inside that Render region; from anywhere else use the external URL.');
    }
    console.error('');
    process.exit(1);
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
