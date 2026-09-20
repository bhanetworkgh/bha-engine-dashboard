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

/**
 * One variable per base, each named for its base (decision 2026-09-14,
 * Destiny), so that the next base to arrive cannot be mistaken for one of
 * these two.
 *
 * **No built-in default on the loops base.** A default is a guess about which
 * base this server writes to, and a wrong guess writes real loops into the
 * wrong Airtable base rather than failing. Missing is missing: the boot line
 * names the variable, and every loop edit is refused and marked, naming it
 * again.
 */
export const OPEN_LOOPS_BASE_VAR = 'AIRTABLE_OPEN_LOOPS_BASE_ID';
export const LOOPS_BASE_ID: string | null = process.env.AIRTABLE_OPEN_LOOPS_BASE_ID?.trim() || null;

/** BHA Submissions & Logs — the Codex base, named the same way. */
export const SUBMISSIONS_BASE_VAR = 'AIRTABLE_SUBMISSIONS_BASE_ID';
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
 * The loops base, or the refusal that names the variable. Every loop write
 * goes through this rather than reading the constant, so there is one sentence
 * for a missing base and it cannot be half-applied.
 */
export function loopsBase(): string {
  if (!LOOPS_BASE_ID) throw new AirtableError(`${OPEN_LOOPS_BASE_VAR} is not set on this server, so there is no Open Loops base to write to.`, 503);
  return LOOPS_BASE_ID;
}

/**
 * Fifteen seconds for a write. A single-record read, create, update or delete
 * is one round trip to api.airtable.com; a move is four of them in sequence,
 * and a person is waiting on the save.
 *
 * A read done on a page load passes something shorter — see `listRecordIds`.
 * Seven tables at fifteen seconds each is a page that hangs for a minute and a
 * half, which is not a wait anybody should be asked to sit through for a
 * housekeeping pass.
 */
const TIMEOUT_MS = 15_000;

async function call<T>(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (!TOKEN) throw new AirtableError('AIRTABLE_TOKEN is not set on this server, so nothing could be sent to Airtable.', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    throw new AirtableError(timedOut ? `Airtable did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'Could not reach Airtable.', 0);
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
 * Every record id in a table, and as little else as Airtable will allow.
 *
 * **There is no way to ask for ids alone.** This sent `fields[]=` — no field
 * named — on the belief that an empty list meant "none of them". Airtable reads
 * it as a request for a field whose name is the empty string and refuses the
 * whole request with `Unknown field name: ""`, which is what every one of the
 * seven tables answered in production while this read as a permissions problem.
 * Asking for one small real field is the way to keep the payload down: an id
 * and a short string per record rather than every transcript in the base.
 *
 * `Submission ID` is the field, and it is the one spelling that exists in all
 * six builder tables *and* in the Layer 0 table — checked against the live
 * schema, not assumed, which is the habit that should have caught the original.
 *
 * Follows `offset` to the end: a partial read would look exactly like a table
 * someone had emptied, which is the one mistake this must never make.
 */
export const ID_PROBE_FIELD = 'Submission ID';

export async function listRecordIds(base: string, table: string, timeoutMs?: number): Promise<string[]> {
  const out: string[] = [];
  let offset: string | undefined;
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    q.append('fields[]', ID_PROBE_FIELD);
    if (offset) q.set('offset', offset);
    const page = await call<{ records: { id: string }[]; offset?: string }>('GET', `/${base}/${table}?${q.toString()}`, undefined, timeoutMs);
    for (const r of page.records) out.push(r.id);
    offset = page.offset;
    if (offset) await sleep(PACE_MS);
  } while (offset);
  return out;
}

/**
 * Is Airtable answering? One request, no field named, one record at most.
 *
 * **Deliberately not `listRecordIds`, for two reasons.** That function names a
 * field — `Submission ID`, which exists on the six builder tables and on Layer
 * 0 and nowhere else — so pointed at any other table it asks for a column that
 * table has not got and Airtable refuses the whole request with
 * `Unknown field name: "…"`. Against Build Patterns that is exactly what
 * happened: the liveness probe reported Airtable as unreachable while the token
 * was working perfectly, which is the worst direction for a health check to
 * fail in, because it sends somebody to check a credential that is fine. And it
 * pages to the end at a hundred records a page with a pace delay between pages,
 * which is 175 records of Build Patterns walked to answer a yes/no question.
 *
 * So a liveness probe **names no field at all**: any field name it hardcodes is
 * a field that can be absent from whichever table it is later pointed at, and
 * the next person to repoint it would rediscover this the same way. `maxRecords=1`
 * keeps the answer to one record, and there is no `offset` to follow — a probe
 * that pages is a probe whose cost depends on the size of the table it happens
 * to be aimed at.
 *
 * Returns how many records came back (0 or 1). The number is not the point;
 * having got an answer at all is.
 */
export async function probeReachable(base: string, table: string, timeoutMs?: number): Promise<number> {
  const page = await call<{ records: { id: string }[] }>('GET', `/${base}/${table}?maxRecords=1`, undefined, timeoutMs);
  return page.records.length;
}

/**
 * Every record in a table, whole.
 *
 * The counterpart of `listRecordIds`: that one asks for as little as Airtable
 * allows because it only needs to know what exists, and this one needs the
 * fields themselves because it is what a resync writes into Postgres. It costs
 * what it costs — transcripts included — which is why it runs on a button and
 * not on a page load.
 *
 * Same rule about `offset`: followed to the end or not trusted at all. A
 * half-read table would look like a table with rows missing, and the caller
 * would delete the ones it did not see.
 */
export async function listRecords(base: string, table: string, timeoutMs?: number): Promise<AtRecord[]> {
  const out: AtRecord[] = [];
  let offset: string | undefined;
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    const page = await call<{ records: AtRecord[]; offset?: string }>('GET', `/${base}/${table}?${q.toString()}`, undefined, timeoutMs);
    for (const r of page.records) out.push(r);
    offset = page.offset;
    if (offset) await sleep(PACE_MS);
  } while (offset);
  return out;
}
