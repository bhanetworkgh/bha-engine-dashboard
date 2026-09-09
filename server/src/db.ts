/**
 * SQLite through Node's built-in driver. One file under DATA_DIR.
 *
 * On Render's free instance there is no persistent disk, so this file is
 * wiped on every deploy and every spin-down; the server reports which it is on
 * /api/status and rebuilds the record tables from Airtable at boot (sync.ts).
 * Only `meta` is created here; the record schema is store.ts's, versioned
 * there, because it is the thing that changes.
 */
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), 'data');

let db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'dashboard.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function getMeta(key: string): string | null {
  const row = openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  openDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return nowIso().slice(0, 10);
}
