/**
 * The engine client. Every network call the dashboard makes goes through here:
 * one place for base URLs, the bearer token, timeouts and error shapes.
 *
 * Nothing is hardcoded. Every URL and key is a VITE_ environment variable set
 * on the host at deploy time; when one is missing the matching feature reports
 * itself as not configured rather than pretending.
 */

const env = import.meta.env;

function read(name: string): string | null {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\/+$/, '') : null;
}

export const config = {
  /** Base URL of the engine data endpoint (phase 2). */
  apiUrl: read('VITE_ENGINE_API_URL'),
  /** Login endpoint. Defaults to <apiUrl>/auth/login when only the API is set. */
  authUrl: read('VITE_AUTH_URL') ?? (read('VITE_ENGINE_API_URL') ? `${read('VITE_ENGINE_API_URL')}/auth/login` : null),
  /** Optional overrides for the built-in team credential (see data/index.ts). */
  authEmail: read('VITE_AUTH_EMAIL'),
  authHash: read('VITE_AUTH_PASSWORD_SHA256'),

  /** The Bays front door: POST /webhook/bays on the n8n engine. */
  baysWebhookUrl: read('VITE_BAYS_WEBHOOK_URL'),
  /** The x-api-key the front door expects on an external ask. */
  baysApiKey: read('VITE_BAYS_API_KEY'),
  /** Where Bays should POST its answer. Passed through as `callback`. */
  baysCallbackUrl: read('VITE_BAYS_CALLBACK_URL'),
  /** Where the dashboard reads answers back from: GET ?session_id=… */
  baysAnswerUrl: read('VITE_BAYS_ANSWER_URL'),
  /** Optional Slack channel Bays can deliver to instead of, or as well as, the callback. */
  baysChannelId: read('VITE_BAYS_CHANNEL_ID'),
  /** Shown under the composer: the model the Bays workflow is connected to. */
  baysModelLabel: read('VITE_BAYS_MODEL_LABEL') ?? 'Claude Sonnet 5.0',
} as const;

export class EngineError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public kind: 'network' | 'http' | 'timeout' | 'parse',
  ) {
    super(message);
  }
}

let bearer: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** The session provider installs the current token and a sign-out callback here. */
export function setBearer(token: string | null, unauthorized?: () => void) {
  bearer = token;
  if (unauthorized) onUnauthorized = unauthorized;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Skip the bearer header, for endpoints outside the engine's auth. */
  anonymous?: boolean;
}

/**
 * fetch with a timeout, JSON in and out, and a consistent error. A 401 signs
 * the session out because the token is the only thing that could have expired.
 */
export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer && !opts.anonymous) headers.Authorization = `Bearer ${bearer}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError')
      throw new EngineError('The request timed out.', null, 'timeout');
    throw new EngineError('Could not reach the engine.', null, 'network');
  }
  clearTimeout(timer);

  if (res.status === 401 && !opts.anonymous) {
    onUnauthorized?.();
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new EngineError(text.slice(0, 200) || `HTTP ${res.status}`, res.status, 'http');
      data = text;
    }
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string'
        ? (data as { message: string }).message
        : null) ?? `HTTP ${res.status}`;
    throw new EngineError(msg, res.status, 'http');
  }

  return data as T;
}

/** Convenience for engine-relative paths. Throws if the engine is not configured. */
export function engine<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!config.apiUrl) return Promise.reject(new EngineError('The engine endpoint is not configured.', null, 'network'));
  return request<T>(`${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`, opts);
}
