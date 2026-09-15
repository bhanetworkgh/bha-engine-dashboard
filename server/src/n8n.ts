/**
 * The n8n public API, read only.
 *
 * Two endpoints are read — `GET /api/v1/executions` and `GET /api/v1/workflows`
 * — and nothing here ever writes. CLAUDE.md section 3 is explicit that
 * workflows are read and never modified, and this client has no method that
 * could. The workflows read exists so a workflow with no registry row still
 * appears under its own name rather than as an opaque id: a workflow must never
 * be invisible because a registry row is missing.
 *
 * **Why the executions are copied into Postgres rather than queried live.**
 * Not because n8n discards them — that has never been observed here, and this
 * file used to assert it. The instance's history runs back to 12 Sep 2026
 * because that is when it was migrated, not because anything expired. The
 * reason is simpler and does not depend on a retention policy nobody has
 * confirmed: a chart of the engine's history should not be at the mercy of what
 * another system decides to keep. Every execution is copied here, keyed on its
 * own id, so the record survives whatever n8n retains — and if n8n does start
 * pruning, the rows already here are unaffected.
 *
 * `N8N_API_KEY` is a different credential from `ASK_BAYS_API_KEY`: that one is
 * the header a webhook expects, this one is an instance API key. Without it
 * nothing is ever read, the pages say so, and nothing is drawn from nothing.
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
  /** How it was started — webhook, trigger, integrated, manual, error. Stored, because it says what kind of run it was. */
  mode?: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

/** One workflow, for the name and nothing else. The registry owns everything else about it. */
export interface N8nWorkflow {
  id: string;
  name: string;
  active?: boolean;
}

/**
 * Statuses that mean the execution is over and its outcome will not change.
 * One that is not terminal is stored with the status it has and read again on a
 * later pass — the row itself is the list of what still needs resolving.
 */
export const TERMINAL = new Set(['success', 'error', 'crashed', 'canceled']);

/** The ones that count as a failure. `canceled` is a person stopping it, not a fault. */
export const FAILED = new Set(['error', 'crashed']);

const TIMEOUT_MS = 20_000;
/** n8n allows 250; 200 is its documented maximum for this endpoint. */
const PAGE = 200;
/**
 * Enough pages for a full backfill without running forever.
 *
 * The instance held 3,895 executions on 15 Sep 2026, which is 20 pages, and
 * runs roughly 1,300 a day. 400 pages is 80,000 executions — two months of
 * history read in one pass — and a walk that hits this ceiling says so rather
 * than reporting what it managed as though it were everything.
 */
const MAX_PAGES = 400;

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
 * Every execution newer than `afterId`, newest first. `afterId` of 0 reads the
 * whole history the instance holds.
 *
 * **The page cursor is `cursor`, and carries `nextCursor` verbatim.** The
 * version of this that shipped on 15 Sep sent it as `lastId`, which the public
 * API does not accept and silently ignores, so every page of the walk was the
 * same newest 200 executions. Sixty pages of the same 200 rows is how the live
 * page came to read 11,760 executions where n8n held 196 for the week, why
 * failures read nought (the pages holding them were never reached) and why
 * seven workflows of thirty-one appeared. The bug was invisible because a
 * counter cheerfully adds the same row twice.
 *
 * So this walk now proves it is moving. Every page must contain an id lower
 * than the lowest seen so far; one that does not is reported as stalled rather
 * than followed, and the caller says so loudly. Storage is keyed on the
 * execution id as well, so even a stalled walk cannot inflate a figure — but a
 * reader that cannot page is a broken reader whether or not it corrupts
 * anything, and it says so.
 */
export interface ExecutionRead {
  executions: N8nExecution[];
  /** True where the walk ran out of pages before reaching `afterId` — there is more above it. */
  truncated: boolean;
  /** True where a page failed to move below the previous one, which means the cursor is not working. */
  stalled: boolean;
  pages: number;
}

export async function executionsAfter(afterId: number, maxPages = MAX_PAGES): Promise<ExecutionRead> {
  const out: N8nExecution[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let lowest = Number.POSITIVE_INFINITY;
  let pages = 0;

  for (; pages < maxPages; pages++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set('cursor', cursor);
    const r = await call<{ data: N8nExecution[]; nextCursor?: string | null }>(`/executions?${q.toString()}`);
    const rows = r.data ?? [];
    if (rows.length === 0) return { executions: out, truncated: false, stalled: false, pages: pages + 1 };

    let crossed = false;
    let advanced = false;
    for (const e of rows) {
      const id = Number(e.id);
      if (id < lowest) {
        lowest = id;
        advanced = true;
      }
      if (id <= afterId) {
        crossed = true;
        break;
      }
      // Belt and braces: the same execution twice in one walk is dropped here as
      // well as being a no-op on the way into the table.
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    if (crossed) return { executions: out, truncated: false, stalled: false, pages: pages + 1 };
    if (!advanced) return { executions: out, truncated: true, stalled: true, pages: pages + 1 };

    cursor = r.nextCursor ?? undefined;
    if (!cursor) return { executions: out, truncated: false, stalled: false, pages: pages + 1 };
  }

  // Ran out of pages before reaching the watermark. The caller still commits
  // what it read — and says so, rather than pretending it saw everything.
  return { executions: out, truncated: true, stalled: false, pages };
}

/**
 * Every workflow the instance has, for names only.
 *
 * Paged the same way and with the same proof of movement, keyed on the id so a
 * repeated page cannot double anything.
 */
export async function workflows(maxPages = 20): Promise<{ workflows: N8nWorkflow[]; truncated: boolean }> {
  const byId = new Map<string, N8nWorkflow>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set('cursor', cursor);
    const r = await call<{ data: N8nWorkflow[]; nextCursor?: string | null }>(`/workflows?${q.toString()}`);
    const rows = r.data ?? [];
    const before = byId.size;
    for (const w of rows) byId.set(String(w.id), { id: String(w.id), name: String(w.name ?? w.id), active: w.active });
    cursor = r.nextCursor ?? undefined;
    // No cursor, an empty page, or a page that added nothing new: done either
    // way, and never a loop that reads the same page until it runs out of turns.
    if (!cursor || rows.length === 0 || byId.size === before) return { workflows: [...byId.values()], truncated: false };
  }
  return { workflows: [...byId.values()], truncated: true };
}
