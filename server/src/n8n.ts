/**
 * The n8n public API. Read, with one write: the repair revert.
 *
 * Three endpoints are read — `GET /api/v1/executions`, `GET /api/v1/workflows`
 * and `GET /api/v1/workflows/{id}` — and exactly one writes:
 * `PUT /api/v1/workflows/{id}`, reached only from `repairs.revert`.
 *
 * **That write is a deliberate exception and the only one** (2026-09-20, on
 * Destiny's instruction, with the repair record). Until it, nothing in this
 * server could change a workflow, and this file said so. The self-healing
 * repair layer changes that in one direction only: a repair Claude Code made
 * can be *put back*, because a repair nobody can undo is a change nobody should
 * have let happen automatically. It restores the workflow as it stood before
 * the repair and it is used for nothing else — there is no method here that
 * edits, activates, deactivates or deletes a workflow, and CLAUDE.md section 3
 * still holds for every other purpose: workflows are read, never modified.
 *
 * The workflows list is read so a workflow with no registry row still appears
 * under its own name rather than as an opaque id: a workflow must never be
 * invisible because a registry row is missing.
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
 * One execution with its data, for the recovery watcher (2026-09-23).
 *
 * `includeData=true` carries `workflowData` — the workflow exactly as it ran,
 * nodes and credentials included — which is how the watcher learns what a
 * failed node depends on without asking anything else. `retrySuccessId` is
 * n8n's own statement that a retry of this run already worked. Null where n8n
 * no longer holds the run: a pruned execution is an outcome, not an error.
 */
export interface N8nExecutionDetail extends N8nExecution {
  retrySuccessId?: string | null;
  workflowData?: { id?: string; name?: string; nodes?: N8nNode[] } | null;
}

export interface N8nNode {
  name: string;
  type?: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name?: string }>;
}

export async function executionDetail(id: string): Promise<N8nExecutionDetail | null> {
  try {
    return await call<N8nExecutionDetail>(`/executions/${encodeURIComponent(id)}?includeData=true`);
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
  /**
   * What n8n says it holds in total, from the `count` on the first page.
   *
   * Kept so a pass can check itself: if this database ends up holding fewer
   * executions than n8n reports, something was not read, and saying so beats
   * a total that looks plausible. Holding *more* is expected and fine — rows
   * stay here after n8n loses them, which is why they are copied at all.
   */
  reported: number | null;
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
  let reported: number | null = null;

  for (; pages < maxPages; pages++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set('cursor', cursor);
    const r = await call<{ data: N8nExecution[]; nextCursor?: string | null; count?: number }>(`/executions?${q.toString()}`);
    const rows = r.data ?? [];
    if (reported === null && typeof r.count === 'number') reported = r.count;
    if (rows.length === 0) return { executions: out, truncated: false, stalled: false, pages: pages + 1, reported };

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
    if (crossed) return { executions: out, truncated: false, stalled: false, pages: pages + 1, reported };
    if (!advanced) return { executions: out, truncated: true, stalled: true, pages: pages + 1, reported };

    cursor = r.nextCursor ?? undefined;
    if (!cursor) return { executions: out, truncated: false, stalled: false, pages: pages + 1, reported };
  }

  // Ran out of pages before reaching the watermark. The caller still commits
  // what it read — and says so, rather than pretending it saw everything.
  return { executions: out, truncated: true, stalled: false, pages, reported };
}

/* ------------------------------------------- one workflow, and the one write */

/**
 * One workflow, whole, by id — the nodes included.
 *
 * Read for the repair revert, which needs two things from it: the current
 * `versionId`, so a workflow somebody has edited since a repair is never
 * silently overwritten, and the `name`, so a restore that carries no name of
 * its own keeps the one the workflow has now.
 */
export interface N8nWorkflowFull {
  id: string;
  name: string;
  versionId: string | null;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: unknown;
  active?: boolean;
  /** Archived in n8n (2026-09-24, the Airtable sweep): it cannot run, but it can be restored. */
  isArchived?: boolean;
  updatedAt?: string | null;
}

export async function workflow(id: string): Promise<N8nWorkflowFull> {
  const w = await call<N8nWorkflowFull>(`/workflows/${encodeURIComponent(id)}`);
  return {
    id: String(w.id),
    name: String(w.name ?? id),
    versionId: typeof w.versionId === 'string' ? w.versionId : null,
    nodes: Array.isArray(w.nodes) ? w.nodes : [],
    connections: w.connections && typeof w.connections === 'object' ? w.connections : {},
    settings: w.settings,
    active: w.active,
    isArchived: w.isArchived === true,
    updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : null,
  };
}

/**
 * **The one write in this file.** Replaces a workflow's content with the body
 * given, and is called from exactly one place: `repairs.revert`.
 *
 * `PUT /api/v1/workflows/{id}` is the only way back that the public API offers.
 * There is no endpoint that restores a historical version by its id — a version
 * id identifies a restore point without containing it — so a revert has to hand
 * n8n the nodes and connections as they stood, which is why the repair record
 * keeps the snapshot the bridge read before it edited anything.
 *
 * The restore creates a **new** version holding the old content rather than
 * bringing the old version id back, which is why the caller re-reads afterwards
 * instead of assuming which version it is now on.
 *
 * `active` is deliberately not sent. Whether a workflow is running is not a
 * fact about a repair, and a restore that switched a live workflow off — or on
 * — would be a second change nobody asked for.
 */
export async function replaceWorkflow(id: string, body: { name: string; nodes: unknown[]; connections: Record<string, unknown>; settings?: unknown }): Promise<void> {
  if (!KEY) throw new N8nError(`${N8N_API_VAR} is not set on this server, so n8n could not be asked anything.`, 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}/workflows/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'X-N8N-API-KEY': KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      // `settings` is only sent where the snapshot carried one: n8n rejects a
      // null, and inventing an empty object would be this code deciding what a
      // workflow's settings are.
      body: JSON.stringify(body.settings === undefined || body.settings === null ? { name: body.name, nodes: body.nodes, connections: body.connections } : body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new N8nError(timedOut ? `n8n did not answer within ${Math.round(TIMEOUT_MS / 1000)} seconds, so it is not known whether the restore landed.` : 'Could not reach n8n.', 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new N8nError(`n8n answered ${res.status}${text ? `: ${text.slice(0, 300)}` : '.'}`, res.status);
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
