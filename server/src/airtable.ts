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
 * Scope: the Open Loops base and the BHA Submissions base, and nothing else.
 * Every other record kind still reaches this dashboard only through
 * `/api/engine/:kind`, and nothing here reads Airtable to build a page — the
 * pages read Postgres, as they have since the migration. These are write paths
 * with reads on them (the source row of a move; the record ids a Codex
 * reconciliation compares against), not a return of the sync.
 *
 * Every call names its base. One token covers both.
 */
import type { AtRecord } from './sources';

export const AIRTABLE_URL = (process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0').replace(/\/+$/, '');

/** The loops base. Env first; the constant is the base this dashboard has always meant. */
export const LOOPS_BASE_ID = process.env.AIRTABLE_BASE_ID?.trim() || 'appUVlBSGGPHw6DGh';
export const BASE_ID_FROM_ENV = Boolean(process.env.AIRTABLE_BASE_ID?.trim());

/**
 * BHA Submissions & Logs — the Codex base. Its own variable rather than
 * overloading AIRTABLE_BASE_ID, which is the loops base and is already set.
 */
export const SUBMISSIONS_BASE_ID = process.env.AIRTABLE_SUBMISSIONS_BASE_ID?.trim() || 'appEmdKshNVTl64Zf';
export const SUBMISSIONS_BASE_FROM_ENV = Boolean(process.env.AIRTABLE_SUBMISSIONS_BASE_ID?.trim());

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
const TIMEOUT_MS = 15_000;

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

export function getRecord(base: string, table: string, id: string): Promise<AtRecord> {
  return call<AtRecord>('GET', `/${base}/${table}/${encodeURIComponent(id)}`);
}

/**
 * Writes only the fields given; everything else on the record is left alone.
 * `typecast` so a select value arrives as its name rather than an option id.
 */
export function updateRecord(base: string, table: string, id: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('PATCH', `/${base}/${table}/${encodeURIComponent(id)}`, { fields, typecast: true });
}

export function createRecord(base: string, table: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('POST', `/${base}/${table}`, { fields, typecast: true });
}

export function deleteRecord(base: string, table: string, id: string): Promise<{ id: string; deleted: boolean }> {
  return call<{ id: string; deleted: boolean }>('DELETE', `/${base}/${table}/${encodeURIComponent(id)}`);
}

/** Airtable allows five requests a second per base; this keeps well under it. */
const PACE_MS = 220;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every record id in a table, and nothing else.
 *
 * `fields[]=` with no field named asks Airtable for the ids alone, so a
 * reconciliation over seven tables moves a few kilobytes rather than every
 * transcript in the base. Follows `offset` to the end: a partial read would
 * look exactly like a table someone had emptied, which is the one mistake this
 * must never make.
 */
export async function listRecordIds(base: string, table: string): Promise<string[]> {
  const out: string[] = [];
  let offset: string | undefined;
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    q.append('fields[]', '');
    if (offset) q.set('offset', offset);
    const page = await call<{ records: { id: string }[]; offset?: string }>('GET', `/${base}/${table}?${q.toString()}`);
    for (const r of page.records) out.push(r.id);
    offset = page.offset;
    if (offset) await sleep(PACE_MS);
  } while (offset);
  return out;
}
