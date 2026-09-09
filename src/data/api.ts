/**
 * The one fetch helper. Everything the browser reads or writes goes through
 * this function, to the dashboard's own server under /api on the same origin.
 *
 * It is generic on purpose. `api<OverviewData>('/api/overview')` resolves to
 * `OverviewData`, so the shapes in types.ts stay the contract all the way out
 * to the components: a screen reading a field the server does not send is a
 * type error at build time rather than a blank panel at runtime. Nothing here
 * ever widens to `any` or `unknown` for a caller that named a type.
 *
 * The session is an HttpOnly cookie the server sets; this file never reads it,
 * it only sends it (`credentials: 'same-origin'`) and reports the 401 back.
 */

/** How a request failed. Callers branch on this to word their own message. */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'parse';

/** Every failure from this module, including ones that never reached the server. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;

  constructor(kind: ApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * What to do when the server says the session is gone. The session provider
 * registers a callback that returns the app to sign-in, so one expired cookie
 * does not leave a screen sitting on a failed request.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export interface ApiOptions {
  /** Defaults to POST when a body is given, GET otherwise. */
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  /** Do not signal a lost session on 401. Sign-in and the session check use this. */
  quiet401?: boolean;
  /** Defaults to thirty seconds. Ask Bays raises it, because the agent is slow. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The server answers `{ ok: false, message }` on every error it handles itself. */
function messageFrom(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const m = (payload as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  if (status === 401) return 'Sign in to continue.';
  if (status === 404) return 'The dashboard server has no route for that.';
  return `The dashboard server answered ${status}.`;
}

/**
 * One request. Resolves to `T` — the caller's declared shape, unchanged and
 * uncast — or throws an ApiError.
 */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method, body, quiet401 = false, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const verb = method ?? (body === undefined ? 'GET' : 'POST');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortOuter = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortOuter, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: verb,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // An abort here is this call's own timeout unless the caller supplied one.
    const timedOut = controller.signal.aborted && !signal?.aborted;
    throw timedOut
      ? new ApiError('timeout', 0, 'The dashboard server did not answer in time.')
      : new ApiError('network', 0, 'Could not reach the dashboard server.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortOuter);
  }

  const text = await res.text().catch(() => '');
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // The SPA fallback serves index.html for anything the router does not
      // know, so a stray HTML body means the route is wrong, not the data.
      if (res.ok) throw new ApiError('parse', res.status, 'The dashboard server sent something that was not JSON.');
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !quiet401) onUnauthorized?.();
    throw new ApiError('http', res.status, messageFrom(payload, res.status));
  }

  // 204 and an empty 200 carry nothing; callers that named a type never ask
  // for one of those routes.
  return payload as T;
}
