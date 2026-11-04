/**
 * Reads of the services builders work on (4 Nov 2026, Destiny): GitHub, Render, Twilio, ElevenLabs and Stripe,
 * so the automatic code check, Bays and the dashboard can see what is really live instead of what a log says.
 *
 * Every read is a GET to a path on an allowlist. A path that is not on the list is refused here, whatever the key
 * could do, so a broad key on the service still reads only what these lists name: Render's environment variables,
 * for one, are on no list. One key per service, one environment variable per key, no defaults.
 *
 * What comes back is cut at MAX_CHARS, secrets are redacted (dataGovernance.redactSecrets), and on an agent's token
 * customers' phone numbers and emails are masked. An unset key is `not_configured`, never an empty answer.
 *
 * twilioAdmin() is the one thing here that can write. It uses a separate key and sits on the write connection,
 * refused on every agent token; see mcp/serviceTools.ts.
 */
import { redactSecrets } from './dataGovernance';

export const MAX_CHARS = 30_000;
export const TIMEOUT_MS = 20_000;
export const GITHUB_ORG = 'bhanetworkgh';

export type Service = 'github' | 'render' | 'twilio' | 'elevenlabs' | 'stripe';

const env = (k: string): string | null => process.env[k]?.trim() || null;
const seg = '[A-Za-z0-9._-]+';
const repo = `/repos/${GITHUB_ORG}/${seg}`;

/** Pure: the paths each service may be read at. Anything else is refused. */
export const ALLOWED: Record<Service, RegExp[]> = {
  github: [
    new RegExp(`^/orgs/${GITHUB_ORG}/repos$`),
    new RegExp(`^${repo}$`),
    new RegExp(`^${repo}/(commits|branches|pulls|tags|releases|deployments)$`),
    new RegExp(`^${repo}/commits/${seg}(/(status|statuses|check-runs))?$`),
    new RegExp(`^${repo}/compare/[A-Za-z0-9._/-]+\\.\\.\\.[A-Za-z0-9._/-]+$`),
    new RegExp(`^${repo}/branches/[A-Za-z0-9._/-]+$`),
    new RegExp(`^${repo}/pulls/\\d+(/(files|commits|reviews))?$`),
    new RegExp(`^${repo}/contents(/[^?#]*)?$`),
    new RegExp(`^${repo}/git/trees/${seg}$`),
    new RegExp(`^${repo}/actions/runs(/\\d+(/jobs)?)?$`),
    /^\/search\/(code|commits|issues)$/,
  ],
  render: [
    /^\/services$/,
    new RegExp(`^/services/${seg}$`),
    new RegExp(`^/services/${seg}/deploys(/${seg})?$`),
    new RegExp(`^/services/${seg}/events$`),
    /^\/logs$/,
  ],
  twilio: [
    /^\/(Calls|Messages|IncomingPhoneNumbers)\.json$/,
    /^\/(Calls|Messages|IncomingPhoneNumbers)\/[A-Za-z0-9]+\.json$/,
    /^\/Calls\/[A-Za-z0-9]+\/Recordings\.json$/,
    /^\/Recordings\.json$/,
    /^\/monitor\/v1\/(Alerts|Events)(\/[A-Za-z0-9]+)?$/,
    /^\/messaging\/v1\/Services(\/[A-Za-z0-9]+)?$/,
  ],
  elevenlabs: [
    /^\/convai\/agents(\/[A-Za-z0-9_-]+)?$/,
    /^\/convai\/conversations(\/[A-Za-z0-9_-]+)?$/,
    /^\/convai\/phone-numbers(\/[A-Za-z0-9_-]+)?$/,
    /^\/convai\/tools(\/[A-Za-z0-9_-]+)?$/,
  ],
  stripe: [
    /^\/(events|payment_intents|charges|invoices|products|prices|webhook_endpoints)(\/[A-Za-z0-9_-]+)?$/,
    /^\/checkout\/sessions(\/[A-Za-z0-9_-]+)?$/,
  ],
};

export interface Refusal { ok: false; reason: string; message: string; raise?: boolean }

/** Pure: is this path readable, and if not, why. */
export function refusal(service: Service, path: string, query: Record<string, string> = {}): Refusal | null {
  if (path.includes('..') && !path.includes('/compare/')) return { ok: false, reason: 'path_refused', message: 'A path may not climb out of its folder.' };
  if (!ALLOWED[service].some((re) => re.test(path))) return { ok: false, reason: 'path_refused', message: `${path} is not on the ${service} read list. Nothing was called.` };
  if (service === 'github' && path.startsWith('/search/') && !new RegExp(`\\b(org|repo):${GITHUB_ORG}\\b`).test(query.q ?? '')) {
    return { ok: false, reason: 'path_refused', message: `A search must name org:${GITHUB_ORG} in q. Nothing was called.` };
  }
  return null;
}

/** Pure: the host and auth for one read. Null with the missing variable named when a key is not set. */
export function target(service: Service, path: string): { url: string; headers: Record<string, string> } | { missing: string } {
  if (service === 'github') {
    const k = env('GITHUB_READ_TOKEN');
    return k ? { url: `https://api.github.com${path}`, headers: { authorization: `Bearer ${k}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'bha-engine-dashboard' } } : { missing: 'GITHUB_READ_TOKEN' };
  }
  if (service === 'render') {
    const k = env('RENDER_READ_KEY');
    return k ? { url: `https://api.render.com/v1${path}`, headers: { authorization: `Bearer ${k}`, accept: 'application/json' } } : { missing: 'RENDER_READ_KEY' };
  }
  if (service === 'elevenlabs') {
    const k = env('ELEVENLABS_READ_KEY');
    return k ? { url: `https://api.elevenlabs.io/v1${path}`, headers: { 'xi-api-key': k, accept: 'application/json' } } : { missing: 'ELEVENLABS_READ_KEY' };
  }
  if (service === 'stripe') {
    const k = env('STRIPE_READ_KEY');
    return k ? { url: `https://api.stripe.com/v1${path}`, headers: { authorization: `Bearer ${k}` } } : { missing: 'STRIPE_READ_KEY' };
  }
  const sid = env('TWILIO_READ_KEY_SID');
  const secret = env('TWILIO_READ_KEY_SECRET');
  const account = env('TWILIO_ACCOUNT_SID');
  if (!sid || !secret || !account) return { missing: !account ? 'TWILIO_ACCOUNT_SID' : !sid ? 'TWILIO_READ_KEY_SID' : 'TWILIO_READ_KEY_SECRET' };
  return { url: twilioUrl(account, path), headers: { authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}` } };
}

/** Pure: monitor/… and messaging/… have their own hosts; everything else is under the account. */
export function twilioUrl(account: string, path: string): string {
  const m = /^\/(monitor|messaging|trusthub|voice|numbers|lookups)\/(.*)$/.exec(path);
  return m ? `https://${m[1]}.twilio.com/${m[2]}` : `https://api.twilio.com/2010-04-01/Accounts/${account}${path}`;
}

/** Pure: phone numbers and emails masked, for an answer going to an agent's model. */
export function maskPeople(text: string): string {
  return text
    .replace(/\+\d{7,15}\b/g, (m) => `${m.slice(0, 2)}******${m.slice(-4)}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (/@(bhanetwork\.org|arupra\.ai)$/i.test(m) ? m : `***@${m.split('@')[1]}`));
}

/** Pure: a GitHub file comes back base64; the model gets the text. */
export function decodeContent(service: Service, body: unknown): unknown {
  const b = body as { encoding?: string; content?: string } | null;
  if (service !== 'github' || !b || Array.isArray(b) || b.encoding !== 'base64' || typeof b.content !== 'string') return body;
  return { ...b, content: Buffer.from(b.content, 'base64').toString('utf8'), encoding: 'text' };
}

/** Pure: the answer as text within the budget, saying so when it was cut. */
export function shape(body: unknown, opts: { offset?: number; mask?: boolean } = {}): { text: string; total_chars: number; offset: number; truncated: boolean; next_offset: number | null; redacted: Record<string, number> } {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const { text, found } = redactSecrets(raw);
  const clean = opts.mask ? maskPeople(text) : text;
  const offset = Math.max(0, opts.offset ?? 0);
  const part = clean.slice(offset, offset + MAX_CHARS);
  const end = offset + part.length;
  return { text: part, total_chars: clean.length, offset, truncated: end < clean.length, next_offset: end < clean.length ? end : null, redacted: found };
}

export type Fetcher = typeof fetch;

export async function read(service: Service, path: string, query: Record<string, string> = {}, opts: { offset?: number; mask?: boolean; fetcher?: Fetcher } = {}): Promise<Record<string, unknown>> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const no = refusal(service, clean, query);
  if (no) return no as unknown as Record<string, unknown>;
  const t = target(service, clean);
  if ('missing' in t) return { ok: false, reason: 'not_configured', message: `${t.missing} is not set on this service, so ${service} cannot be read. This says nothing about ${service} itself.` };
  const qs = new URLSearchParams(query).toString();
  const url = qs ? `${t.url}?${qs}` : t.url;
  try {
    const r = await (opts.fetcher ?? fetch)(url, { method: 'GET', headers: t.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = await r.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* a log line or a plain file stays text */ }
    if (!r.ok) {
      const s = shape(body, { mask: opts.mask });
      return { ok: false, reason: r.status === 401 || r.status === 403 ? 'not_authorised' : r.status === 404 ? 'not_found' : 'upstream_error', status: r.status, message: `${service} answered ${r.status} to ${clean}.`, detail: s.text.slice(0, 600), raise: r.status === 401 || r.status >= 500 };
    }
    return { ok: true, service, path: clean, status: r.status, ...shape(decodeContent(service, body), opts) };
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `${service} could not be reached: ${e instanceof Error ? e.message : String(e)}`, raise: true };
  }
}

/* --------------------------------------------------------------- Twilio admin */

export const TWILIO_ADMIN_METHODS = ['GET', 'POST', 'DELETE'] as const;
export type AdminMethod = (typeof TWILIO_ADMIN_METHODS)[number];

/** Pure: the words that must come back before a change goes to Twilio. */
export const confirmWords = (method: string, path: string): string => `${method} ${path}`;

export async function twilioAdmin(method: AdminMethod, path: string, params: Record<string, string>, fetcher: Fetcher = fetch): Promise<Record<string, unknown>> {
  const sid = env('TWILIO_ADMIN_KEY_SID');
  const secret = env('TWILIO_ADMIN_KEY_SECRET');
  const account = env('TWILIO_ACCOUNT_SID');
  if (!sid || !secret || !account) return { ok: false, reason: 'not_configured', message: `${!account ? 'TWILIO_ACCOUNT_SID' : !sid ? 'TWILIO_ADMIN_KEY_SID' : 'TWILIO_ADMIN_KEY_SECRET'} is not set on this service.` };
  const base = twilioUrl(account, path);
  const form = new URLSearchParams(params).toString();
  const url = method === 'GET' && form ? `${base}?${form}` : base;
  try {
    const r = await fetcher(url, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: form } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await r.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* an empty delete answer */ }
    return { ok: r.ok, status: r.status, path, ...(r.ok ? {} : { reason: 'twilio_refused', raise: r.status === 401 || r.status >= 500 }), ...shape(body) };
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `Twilio could not be reached: ${e instanceof Error ? e.message : String(e)}`, raise: true };
  }
}
