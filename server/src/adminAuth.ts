/**
 * The admin login (5 Nov 2026, Destiny): a second gate behind the shared team login, for what is Destiny's and
 * Jason's alone. The agreements, the Stage 1 page, Pay Tracker, the Tools tab's costs and cards, and the actions
 * only those two take on a page.
 *
 * One password, held in Bitwarden, shared by the two of them; who is signing in is said at sign-in and goes on
 * the cookie, and it is declared, not proved, like every name under one shared login. The hash lives in
 * `engine_admin_auth` and is set once through the page with `ADMIN_SETUP_CODE`, so nobody but the person setting
 * it ever sees the password. `ADMIN_PASSWORD_HASH` overrides it, for a reset. Unset, the gate stays shut: this
 * fails closed, because a gate that opens when it is misconfigured is no gate.
 *
 * An agent's token never passes it. Its loopback is marked AGENT_MARK by get_page_data, which also keeps it off
 * the Early Access leads, read by the team on the page and by no agent.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientIp, hashPassword, lockedFor, matchesHash, parseCookies, recordFailure, secure, sign } from './auth';
import { query } from './pg';

export const AGENT_MARK = '__agent';
export const NEEDED = 'This is behind the admin login. Sign in at /admin.';
export const ADMIN_HOURS = 8;
const COOKIE = 'bha_admin';
const PEOPLE: Record<string, string> = { destiny: 'U0AEW3TBYH1', jason: 'U0A9V97949F' };
export const MIN_PASSWORD = 16;
export const slackId = (by: string | undefined): string => (by ? (PEOPLE[by] ?? '') : '');

const COST_FIELDS = ['cost_amount', 'cost_currency', 'billing_cycle', 'renewal_date', 'billing_owner', 'paid_with'] as const;

/** A Tools row with its cost and card details taken off. */
export function withoutCosts<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const f of COST_FIELDS) delete out[f];
  return out as T;
}
export const touchesCosts = (body: Record<string, unknown>): boolean => COST_FIELDS.some((f) => f in body);

/** Pure: does this route need the admin login? */
export function gated(path: string, method: string, agentLoopback: boolean): boolean {
  if (path === '/api/pay' || path.startsWith('/api/pay/')) return true;
  if (path === '/api/code-checks' || path.startsWith('/api/code-checks/')) return true;
  if (path === '/api/agreements' || path.startsWith('/api/agreements/')) return true;
  if (path === '/api/comp-snapshot') return true;
  if (agentLoopback && (path === '/api/vfarm/leads' || path.startsWith('/api/vfarm/leads/'))) return true;
  if (method === 'POST' && /^\/api\/codex\/[^/]+\/reject$/.test(path)) return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/codex\/[^/]+$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/media-posts\/[^/]+\/approve$/.test(path)) return true;
  return false;
}

let cached: string | null = null;
async function storedHash(): Promise<string | null> {
  const env = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (env) return env;
  if (cached) return cached;
  const r = await query<{ password_hash: string }>(`SELECT password_hash FROM engine_admin_auth WHERE id = 1`);
  cached = r.rows[0]?.password_hash ?? null;
  return cached;
}

interface AdminPayload {
  id: string;
  by: string;
  exp: number;
}

function encode(p: AdminPayload): string {
  const body = Buffer.from(JSON.stringify({ ...p, scope: 'admin' })).toString('base64url');
  return `${body}.${sign(`admin:${body}`)}`;
}

export function readAdmin(req: IncomingMessage): AdminPayload | null {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(`admin:${body}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as AdminPayload & { scope?: string };
    if (p.scope !== 'admin' || typeof p.exp !== 'number' || p.exp <= Date.now() || !PEOPLE[p.by]) return null;
    return p;
  } catch {
    return null;
  }
}

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number): void {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function start(req: IncomingMessage, res: ServerResponse, by: string): void {
  const exp = Date.now() + ADMIN_HOURS * 3600 * 1000;
  setCookie(req, res, encode({ id: randomBytes(12).toString('hex'), by, exp }), ADMIN_HOURS * 3600);
}

export type AdminResult = { ok: true; by: string } | { ok: false; status: number; message: string };

export async function status(req: IncomingMessage): Promise<{ admin: boolean; by: string | null; configured: boolean; setup_open: boolean }> {
  const a = readAdmin(req);
  const configured = Boolean(await storedHash());
  return { admin: Boolean(a), by: a?.by ?? null, configured, setup_open: !configured && Boolean(process.env.ADMIN_SETUP_CODE) };
}

export async function login(req: IncomingMessage, res: ServerResponse, who: string, password: string): Promise<AdminResult> {
  const hash = await storedHash();
  if (!hash) return { ok: false, status: 503, message: 'The admin password has not been set yet.' };
  const ip = clientIp(req);
  const wait = lockedFor(ip);
  if (wait > 0) return { ok: false, status: 429, message: `Too many attempts. Try again in ${wait} seconds.` };
  if (!PEOPLE[who] || !matchesHash(password, hash)) {
    recordFailure(ip);
    return { ok: false, status: 401, message: 'That did not match.' };
  }
  start(req, res, who);
  return { ok: true, by: who };
}

/** Sets the password once. The code is one-time in effect: with a hash held, this refuses. */
export async function setup(req: IncomingMessage, res: ServerResponse, code: string, who: string, password: string): Promise<AdminResult> {
  if (await storedHash()) return { ok: false, status: 409, message: 'The admin password is already set.' };
  const want = process.env.ADMIN_SETUP_CODE ?? '';
  const ip = clientIp(req);
  const wait = lockedFor(ip);
  if (wait > 0) return { ok: false, status: 429, message: `Too many attempts. Try again in ${wait} seconds.` };
  const a = Buffer.from(code);
  const b = Buffer.from(want);
  if (!want || a.length !== b.length || !timingSafeEqual(a, b) || !PEOPLE[who]) {
    recordFailure(ip);
    return { ok: false, status: 401, message: 'That setup code did not match.' };
  }
  if (password.length < MIN_PASSWORD) return { ok: false, status: 422, message: `Use at least ${MIN_PASSWORD} characters. Generate it in Bitwarden.` };
  await query(`INSERT INTO engine_admin_auth (id, password_hash, set_by) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`, [hashPassword(password), who]);
  cached = null;
  start(req, res, who);
  return { ok: true, by: who };
}

export function logout(req: IncomingMessage, res: ServerResponse): void {
  setCookie(req, res, '', 0);
}
