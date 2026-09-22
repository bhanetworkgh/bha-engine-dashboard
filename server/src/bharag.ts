/**
 * The BHARAG incident ledger, read only (2026-09-17, on Destiny's instruction).
 *
 * This is the **second external read path** this server has, after Airtable,
 * and it is here for the same reason that one is: the browser never talks to
 * BHARAG, so the server is the only thing that can. It adds no dependency past
 * Node itself — `fetch`, the same way `airtable.ts` works.
 *
 * **Each lane needs its own credential.** That is not an oversight in the
 * ledger's design and it cannot be collapsed into one call: the three error
 * handlers each hold their own BHARAG key, and a key for one lane is refused
 * for another. So this reads three times, with three keys, and reports on each
 * separately — which is also what makes "this lane was not read" expressible
 * rather than looking like "this lane has no incidents".
 *
 * **One write, from 2026-09-22 (Destiny): a person closing an incident.** The
 * handlers create incidents and `BHA — Self Healer Reports` closes the ones it
 * healed, with `POST /incidents/{id}/status` and `resolution_status:
 * 'self_healed'`. Nothing closed the ones a person fixed by hand, so 37 stayed
 * open for days after the fix. `closeIncident` uses the same route with the
 * ledger's own state for that case, `manually_resolved` — read off BHARAG's
 * `core/incidents/lifecycle.ts`, where `open -> manually_resolved` and
 * `retrying -> manually_resolved` are legal and a terminal state has no way
 * back. BHARAG's `/close` route is the one meant for a person, but it demands
 * a control-plane session and refuses a workspace key; this server only holds
 * the three lane keys, so `/status` is the route it can use.
 *
 * **The ledger decides who resolved it, not this dashboard** (2026-09-22,
 * after a live refusal). The person who clicked is recorded here, in
 * `record_writes`; the ledger stores the lane — it answered "bays",
 * "north_star" and "research_twin" when the 37 were closed. Nothing on the
 * page promises that the login sent is what BHARAG keeps.
 */

/** The ledger's REST base. One host, configured once. */
export const BHARAG_URL = (process.env.BHARAG_API_URL || 'https://bharag2.duckdns.org/api/v1').replace(/\/+$/, '');

/**
 * One environment variable per lane, each named for its lane, on the same rule
 * section 4 sets for the Airtable base ids: a variable is named for the thing
 * it addresses, so the next one to arrive cannot be mistaken for one of these.
 *
 * **No defaults.** A guessed key is a 401, which reads on the page like the
 * ledger refusing the lane rather than like this server being unconfigured.
 * Missing is missing, and the page says which.
 */
export const LANE_KEY_VARS: Record<string, string> = {
  bays: 'BHARAG_BAYS_KEY',
  north_star: 'BHARAG_NORTH_STAR_KEY',
  research_twin: 'BHARAG_RESEARCH_TWIN_KEY',
};

function keyFor(lane: string): string | null {
  const v = LANE_KEY_VARS[lane];
  return v ? (process.env[v]?.trim() || null) : null;
}

export function laneConfigured(lane: string): boolean {
  return Boolean(keyFor(lane));
}

/** Which lanes this server can read at all, for the boot line and the page. */
export function configuredLanes(): string[] {
  return Object.keys(LANE_KEY_VARS).filter(laneConfigured);
}

export class BharagError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'BharagError';
  }
}

/**
 * Twenty seconds. This runs on a button a person is waiting behind, three times
 * in sequence, so the whole pass is bounded by the resync's own budget rather
 * than by this alone.
 */
const TIMEOUT_MS = 20_000;

/** One incident as the ledger returns it. Read whole; nothing is renamed. */
export interface LedgerIncident {
  entity_id?: string;
  type?: string;
  subsystem?: string;
  source?: string;
  severity?: string;
  summary?: string;
  resolution_status?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

async function call<T>(path: string, key: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BHARAG_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-api-key': key, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new BharagError(timedOut ? `BHARAG did not answer within ${Math.round(TIMEOUT_MS / 1000)} seconds.` : 'Could not reach BHARAG.', 0);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new BharagError(`BHARAG answered ${res.status} with a body that was not JSON.`, res.status);
  }
  if (!res.ok) {
    const raw = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    // BHARAG nests its error as `{ error: { message, code } }`; older answers were flat.
    const err = (raw.error && typeof raw.error === 'object' ? raw.error : raw) as { error?: unknown; message?: unknown; detail?: unknown; code?: unknown };
    const msg =
      (typeof err.message === 'string' && err.message) ||
      (typeof err.detail === 'string' && err.detail) ||
      (typeof err.error === 'string' && err.error) ||
      `BHARAG answered ${res.status}.`;
    throw new BharagError(typeof err.code === 'string' ? `${msg} (${err.code})` : msg, res.status);
  }
  return json as T;
}

/**
 * Every open incident for one lane.
 *
 * The ledger has answered with a bare array and with `{ items: [...] }` at
 * different times, so both are read rather than one being assumed — and
 * anything else is an error naming what came back, not an empty lane. That
 * distinction is the whole point of this page: a shape this code does not
 * understand must never render as "nothing is wrong".
 */
export async function openIncidents(lane: string): Promise<LedgerIncident[]> {
  const key = keyFor(lane);
  if (!key) throw new BharagError(`${LANE_KEY_VARS[lane] ?? `a key for ${lane}`} is not set on this server, so this lane's incidents were never asked for.`, 503);
  const q = new URLSearchParams({ status: 'open', source: lane });
  const body = await call<unknown>(`/incidents?${q.toString()}`, key);
  if (Array.isArray(body)) return body as LedgerIncident[];
  if (body && typeof body === 'object') {
    for (const k of ['items', 'incidents', 'results', 'data']) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as LedgerIncident[];
    }
  }
  throw new BharagError('BHARAG answered with a shape this server does not recognise — neither a list of incidents nor an object carrying one.', 0);
}

/**
 * Close one incident as fixed by a person: `POST /incidents/{id}/status` with
 * the lane's own key and **exactly** `{ resolution_status, payload_patch }`.
 *
 * Nothing else goes at the top level (2026-09-22). The first live close through
 * n8n that also sent a top-level `resolved_by` was refused:
 * `400 LEDGER_PAYLOAD_SCHEMA_MISMATCH "/ must NOT have additional properties"`.
 * The incidents schema is `additionalProperties: false`, and `payload_patch`
 * carries only keys that schema defines — `resolved_at` and `resolved_by`.
 * On a terminal transition the ledger overwrites both with its own clock and
 * its own principal, so the values sent here are a courtesy, not a record:
 * `resolved_by` comes back as the lane. Returns the ledger's own copy of the
 * incident; throws with BHARAG's code on a refusal.
 */
export async function closeIncident(lane: string, entityId: string, resolvedBy: string, at: string): Promise<LedgerIncident> {
  const key = keyFor(lane);
  if (!key) throw new BharagError(`${LANE_KEY_VARS[lane] ?? `a key for ${lane}`} is not set on this server, so this lane's incidents cannot be closed from here.`, 503);
  return call<LedgerIncident>(`/incidents/${encodeURIComponent(entityId)}/status`, key, {
    resolution_status: 'manually_resolved',
    payload_patch: { resolved_at: at, resolved_by: resolvedBy },
  });
}

/* ------------------------------------------------------------- the healer */

/**
 * The self-healing webhook, in n8n.
 *
 * **A manual retry is the same mechanism as an automatic one.** It posts to the
 * same webhook the 5-minute schedule posts to, which calls n8n's own retry
 * endpoint with `loadWorkflow: true` — resuming from the failed node rather
 * than replaying the run — and records the attempt in the same table against
 * the same cap. The only thing that differs is `triggered_by`, which is why the
 * button must not be drawn or described as a different thing.
 */
export const HEAL_URL = (process.env.ENGINE_HEAL_URL || 'https://bayshorizonnetwork.app.n8n.cloud/webhook/engine-heal').trim();
export const HEAL_VAR = 'ENGINE_HEAL_URL';

export function healConfigured(): boolean {
  return Boolean(HEAL_URL);
}

export interface HealRequest {
  incident_id: string;
  execution_id: string;
  lane: string;
  workflow: string;
  failed_node: string;
  error_class: string;
  attempts_before: number;
}

/**
 * Asks the healer to retry one incident.
 *
 * Sixty seconds, because the healer calls n8n and waits for the retried run to
 * be created. It answers with whatever it answers; this reports that back
 * rather than interpreting it, because **a retry that ran is not a retry that
 * worked** — the outcome is decided by the retried execution and recorded in
 * `retry_attempts`, which reaches this dashboard on the next resync.
 */
export async function heal(body: HealRequest): Promise<{ status: number; body: string }> {
  if (!HEAL_URL) throw new BharagError(`${HEAL_VAR} is not set on this server, so there is nothing to ask for a retry.`, 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(HEAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, body: (await res.text()).slice(0, 500) };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new BharagError(timedOut ? 'The healer did not answer within a minute. It may still have started the retry; the next resync will say.' : 'Could not reach the healer webhook.', 0);
  } finally {
    clearTimeout(timer);
  }
}
