/**
 * The Airtable client, restored (2026-09-14, Destiny).
 *
 * It was deleted on 13 September when the dashboard moved onto Postgres, and
 * this morning a loop's status went back to Airtable through n8n instead. That
 * hop is now retired: the loop panel edits What, Status, lane_tag and the
 * builder in one save, and routing four fields and a two-table move through a
 * webhook — with no way to see where a half-completed move stopped — costs more
 * than it saves. The token is back in this process, on Destiny's instruction,
 * and this is the only code that holds it.
 *
 * **`AIRTABLE_TOKEN`, not `AIRTABLE_API_KEY`.** The deleted client read
 * `AIRTABLE_API_KEY`; the variable set on the service is `AIRTABLE_TOKEN`. This
 * reads the one that is actually set. See the note in README.
 *
 * Scope: the Open Loops base and nothing else. Every other record kind still
 * reaches this dashboard only through `/api/engine/:kind`, and nothing here
 * reads Airtable to build a page — the pages read Postgres, as they have since
 * the migration. This is a write path with one read on it (the source row of a
 * move), not a return of the sync.
 */
import type { AtRecord } from './sources';

export const AIRTABLE_URL = (process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0').replace(/\/+$/, '');

/** The loops base. Env first; the constant is the base this dashboard has always meant. */
export const LOOPS_BASE_ID = process.env.AIRTABLE_BASE_ID?.trim() || 'appUVlBSGGPHw6DGh';
export const BASE_ID_FROM_ENV = Boolean(process.env.AIRTABLE_BASE_ID?.trim());

/**
 * No fallback and no default. A guessed token comes back as a 401, which reads
 * on the page like Airtable refusing the loop rather than like this server
 * being misconfigured.
 */
const TOKEN = process.env.AIRTABLE_TOKEN?.trim() || null;

export function airtableConfigured(): boolean {
  return Boolean(TOKEN);
}

export class AirtableError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'AirtableError';
  }
}

/**
 * Ten seconds. A single-record read, create, update or delete is one round trip
 * to api.airtable.com; a move is four of them in sequence, and a person is
 * waiting on the save.
 */
const TIMEOUT_MS = 10_000;

async function call<T>(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!TOKEN) throw new AirtableError('AIRTABLE_TOKEN is not set on this server, so nothing could be written to Airtable.', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${AIRTABLE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new AirtableError(timedOut ? 'Airtable did not answer within ten seconds.' : 'Could not reach Airtable.', 0);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new AirtableError(`Airtable answered ${res.status} with a body that was not JSON.`, res.status);
  }
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { type?: string; message?: string } | string }).error : undefined;
    const msg = typeof err === 'string' ? err : (err?.message ?? err?.type ?? `Airtable answered ${res.status}.`);
    throw new AirtableError(msg, res.status);
  }
  return json as T;
}

export function getRecord(table: string, id: string): Promise<AtRecord> {
  return call<AtRecord>('GET', `/${LOOPS_BASE_ID}/${table}/${encodeURIComponent(id)}`);
}

/**
 * Writes only the fields given; everything else on the record is left alone.
 * `typecast` so a select value arrives as its name rather than an option id.
 */
export function updateRecord(table: string, id: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('PATCH', `/${LOOPS_BASE_ID}/${table}/${encodeURIComponent(id)}`, { fields, typecast: true });
}

export function createRecord(table: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('POST', `/${LOOPS_BASE_ID}/${table}`, { fields, typecast: true });
}

export function deleteRecord(table: string, id: string): Promise<{ id: string; deleted: boolean }> {
  return call<{ id: string; deleted: boolean }>('DELETE', `/${LOOPS_BASE_ID}/${table}/${encodeURIComponent(id)}`);
}
