/**
 * The one Airtable client. Plain fetch against the REST API, no dependency,
 * nothing the browser can reach: the token lives in this process and every
 * call goes through here.
 *
 * Decision (2026-09-09, Destiny): the service runs on Render's free instance
 * with no persistent disk, so the SQLite store is wiped on every deploy and
 * every spin-down. Airtable is therefore the source of truth for every record
 * type and this dashboard is a read model plus a write-through cache. This
 * client is how the server reads from and writes through to that truth; the
 * resync in sync.ts is how the dashboard rebuilds itself after a reset.
 *
 * AIRTABLE_API_URL exists so the same code can be pointed at a local replay
 * of the API in a session that cannot reach api.airtable.com.
 */

export const AIRTABLE_URL = (process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0').replace(/\/+$/, '');
const TOKEN = process.env.AIRTABLE_API_KEY || null;

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

/** A record as the REST API returns it: fields by name, selects as their names. */
export interface AtRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** Airtable allows five requests a second per base; this keeps well under it. */
const PACE_MS = 220;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown, attempt = 0): Promise<T> {
  if (!TOKEN) throw new AirtableError('AIRTABLE_API_KEY is not set on the server.', 503);
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
    throw new AirtableError(timedOut ? 'Airtable did not answer in time.' : 'Could not reach Airtable.', 0);
  } finally {
    clearTimeout(timer);
  }
  // One retry after Airtable's documented cool-off when the rate limit trips.
  if (res.status === 429 && attempt === 0) {
    await sleep(30_000);
    return call<T>(method, path, body, 1);
  }
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new AirtableError(`Airtable answered ${res.status} with a body that was not JSON.`, res.status);
  }
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { type?: string; message?: string } | string }).error : undefined;
    const msg = typeof err === 'string' ? err : err?.message ?? err?.type ?? `Airtable answered ${res.status}.`;
    throw new AirtableError(msg, res.status);
  }
  return json as T;
}

/** Every record in a table, following `offset` until Airtable stops sending one. */
export async function listAll(base: string, table: string, opts: { fields?: string[] } = {}): Promise<AtRecord[]> {
  const out: AtRecord[] = [];
  let offset: string | undefined;
  do {
    const q = new URLSearchParams();
    q.set('pageSize', String(PAGE_SIZE));
    if (offset) q.set('offset', offset);
    for (const f of opts.fields ?? []) q.append('fields[]', f);
    const page = await call<{ records: AtRecord[]; offset?: string }>('GET', `/${base}/${table}?${q.toString()}`);
    out.push(...page.records);
    offset = page.offset;
    if (offset) await sleep(PACE_MS);
  } while (offset);
  return out;
}

export function getRecord(base: string, table: string, id: string): Promise<AtRecord> {
  return call<AtRecord>('GET', `/${base}/${table}/${encodeURIComponent(id)}`);
}

/** Writes only the fields given; everything else on the record is left alone. */
export function updateRecord(base: string, table: string, id: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('PATCH', `/${base}/${table}/${encodeURIComponent(id)}`, { fields, typecast: true });
}

export function createRecord(base: string, table: string, fields: Record<string, unknown>): Promise<AtRecord> {
  return call<AtRecord>('POST', `/${base}/${table}`, { fields, typecast: true });
}

/** The record's own page in Airtable, for "open in Airtable" on every row. */
export function recordUrl(base: string, table: string, id: string): string {
  return `https://airtable.com/${base}/${table}/${id}`;
}
