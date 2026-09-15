/**
 * The n8n public API, read only.
 *
 * One endpoint is used — `GET /api/v1/executions` — and nothing here ever
 * writes. CLAUDE.md section 3 is explicit that workflows are read and never
 * modified, and this client has no method that could.
 *
 * **Why this exists rather than the n8n API being queried from the page.**
 * n8n's execution history does not persist. Read on 15 Sep 2026 the instance
 * held 3,673 executions, the oldest of them from 12 Sep — three days. A
 * monthly chart that asked this API about August would be told, truthfully,
 * that August held nothing, and would draw an empty bar for a month that was
 * in fact busy. So this feeds a snapshot table (see executions.ts) and the
 * pages read that.
 *
 * `N8N_API_KEY` is a different credential from `ASK_BAYS_API_KEY`: that one is
 * the header a webhook expects, this one is an instance API key. Without it the
 * snapshot does not run, the pages say so, and nothing is drawn from nothing.
 */

/** The instance's REST base. Derived from N8N_BASE_URL so one host is configured once. */
const BASE = (process.env.N8N_API_URL || `${process.env.N8N_BASE_URL || 'https://bayshorizonnetwork.app.n8n.cloud'}/api/v1`).replace(/\/+$/, '');

const KEY = process.env.N8N_API_KEY?.trim() || null;

export const N8N_API_VAR = 'N8N_API_KEY';

export function n8nConfigured(): boolean {
  return Boolean(KEY);
}

export function n8nBase(): string {
  return BASE;
}

/** The instance itself, without the API path — where an execution link points. */
export function n8nHost(): string {
  return BASE.replace(/\/api\/v1$/, '');
}

/** The execution's own page, for a failure somebody needs to open. */
export function executionUrl(workflowId: string, executionId: string): string {
  const host = BASE.replace(/\/api\/v1$/, '');
  return `${host}/workflow/${workflowId}/executions/${executionId}`;
}

export class N8nError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'N8nError';
  }
}

/** One execution, as the API reports it. Only the fields the snapshot counts. */
export interface N8nExecution {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

/**
 * Statuses that mean the execution is over and its outcome will not change.
 * An execution still running is deliberately not counted yet — see the
 * watermark rule in executions.ts.
 */
export const TERMINAL = new Set(['success', 'error', 'crashed', 'canceled']);

/** The ones that count as a failure. `canceled` is a person stopping it, not a fault. */
export const FAILED = new Set(['error', 'crashed']);

const TIMEOUT_MS = 20_000;
/** n8n allows 250; 200 is its documented maximum for this endpoint. */
const PAGE = 200;
/** Enough pages to catch up after a long outage without running forever. */
const MAX_PAGES = 60;

async function call<T>(path: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (!KEY) throw new N8nError(`${N8N_API_VAR} is not set on this server, so n8n could not be asked anything.`, 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'X-N8N-API-KEY': KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new N8nError(timedOut ? `n8n did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'Could not reach n8n.', 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new N8nError(`n8n answered ${res.status}${text ? `: ${text.slice(0, 200)}` : '.'}`, res.status);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new N8nError(`n8n answered ${res.status} with a body that was not JSON.`, res.status);
  }
}

/**
 * One execution by id, for resolving one that was still running last time.
 *
 * Returns null where n8n no longer has it: an execution can age off while it is
 * on the deferred list, and a record that is gone is an outcome rather than an
 * error. It is then never counted, which is the honest result — nothing knows
 * how it ended.
 */
export async function execution(id: string): Promise<N8nExecution | null> {
  try {
    return await call<N8nExecution>(`/executions/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof N8nError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Every execution newer than `afterId`, newest first.
 *
 * The API pages backwards from the newest with a `lastId` cursor, so this walks
 * down until it crosses the watermark and stops. That is what makes the
 * snapshot cheap on every run after the first: a job that ran an hour ago reads
 * one page and stops.
 *
 * Ids are n8n's own sequence and increase, which is what the watermark relies
 * on. Nothing here parses a date to decide what is new.
 */
export async function executionsAfter(afterId: number): Promise<{ executions: N8nExecution[]; truncated: boolean }> {
  const out: N8nExecution[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set('lastId', cursor);
    const r = await call<{ data: N8nExecution[]; nextCursor?: string | null }>(`/executions?${q.toString()}`);
    const rows = r.data ?? [];
    if (rows.length === 0) return { executions: out, truncated: false };
    let crossed = false;
    for (const e of rows) {
      if (Number(e.id) <= afterId) {
        crossed = true;
        break;
      }
      out.push(e);
    }
    if (crossed) return { executions: out, truncated: false };
    cursor = r.nextCursor ?? rows[rows.length - 1]?.id;
    if (!cursor) return { executions: out, truncated: false };
  }
  // Ran out of pages before reaching the watermark. The caller still commits
  // what it read — and says so, rather than pretending it saw everything.
  return { executions: out, truncated: true };
}
