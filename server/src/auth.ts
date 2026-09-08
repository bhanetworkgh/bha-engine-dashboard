/**
 * The shared team login, verified here and never in the browser.
 *
 * Credential: AUTH_EMAIL plus either AUTH_PASSWORD_HASH (scrypt, produced by
 * `npm run hash-password`) or, less preferably, AUTH_PASSWORD in plain text.
 * Session: a signed, HttpOnly cookie carrying an id and an expiry twelve hours
 * out. Signing key: SESSION_SECRET; when unset a random one is generated at
 * boot, which means sessions do not survive a restart.
 * Lockout: five failures from one address pause that address for thirty
 * seconds; fifty failures from anywhere inside a minute pause everyone.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_HOURS = 12;
const COOKIE = 'bha_session';
const LOCK_AFTER = 5;
const LOCK_MS = 30_000;
const GLOBAL_LOCK_AFTER = 50;
const GLOBAL_WINDOW_MS = 60_000;

const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
export const sessionSecretConfigured = Boolean(process.env.SESSION_SECRET);

const expectedEmail = (process.env.AUTH_EMAIL || 'admin@bhanetwork.org').trim().toLowerCase();
const passwordHash = process.env.AUTH_PASSWORD_HASH?.trim() || null;
const passwordPlain = process.env.AUTH_PASSWORD || null;

export function authConfigured(): boolean {
  return Boolean(passwordHash || passwordPlain);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string): boolean {
  if (passwordHash) {
    const [scheme, salt, hex] = passwordHash.split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const got = scryptSync(password, salt, 64);
    const want = Buffer.from(hex, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
  if (passwordPlain) {
    const a = Buffer.from(password);
    const b = Buffer.from(passwordPlain);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

/* ------------------------------------------------------------ lockout */

const failures = new Map<string, { count: number; lockedUntil: number }>();
const globalFailures: number[] = [];

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim();
}

function lockedFor(ip: string): number {
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.lockedUntil > now) return Math.ceil((f.lockedUntil - now) / 1000);
  while (globalFailures.length && globalFailures[0] < now - GLOBAL_WINDOW_MS) globalFailures.shift();
  if (globalFailures.length >= GLOBAL_LOCK_AFTER) return Math.ceil(GLOBAL_WINDOW_MS / 1000);
  return 0;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  globalFailures.push(now);
  const f = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= LOCK_AFTER) {
    f.count = 0;
    f.lockedUntil = now + LOCK_MS;
  }
  failures.set(ip, f);
}

/* ------------------------------------------------------------ sessions */

interface SessionPayload {
  id: string;
  iat: number;
  exp: number;
}

const revoked = new Set<string>();

function sign(payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function encode(p: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function decode(token: string): SessionPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (typeof p.id !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp <= Date.now() || revoked.has(p.id)) return null;
    return p;
  } catch {
    return null;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function secure(req: IncomingMessage): boolean {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}

export function readSession(req: IncomingMessage): SessionPayload | null {
  const token = parseCookies(req)[COOKIE];
  return token ? decode(token) : null;
}

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAgeSeconds: number): void {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export type LoginResult =
  | { ok: true; expires_at: string }
  | { ok: false; status: number; message: string };

export function login(req: IncomingMessage, res: ServerResponse, email: string, password: string): LoginResult {
  if (!authConfigured()) {
    return { ok: false, status: 503, message: 'Sign-in is not configured on the server. Set AUTH_PASSWORD_HASH.' };
  }
  const ip = clientIp(req);
  const wait = lockedFor(ip);
  if (wait > 0) return { ok: false, status: 429, message: `Too many attempts. Try again in ${wait} seconds.` };

  const e = email.trim().toLowerCase();
  const emailOk = e.length === expectedEmail.length && timingSafeEqual(Buffer.from(e), Buffer.from(expectedEmail));
  const passOk = verifyPassword(password);
  if (!emailOk || !passOk) {
    recordFailure(ip);
    return { ok: false, status: 401, message: 'Email or password not recognised.' };
  }
  failures.delete(ip);

  const iat = Date.now();
  const exp = iat + SESSION_HOURS * 3600 * 1000;
  const payload: SessionPayload = { id: randomBytes(12).toString('hex'), iat, exp };
  setCookie(req, res, encode(payload), SESSION_HOURS * 3600);
  return { ok: true, expires_at: new Date(exp).toISOString() };
}

export function logout(req: IncomingMessage, res: ServerResponse): void {
  const s = readSession(req);
  if (s) revoked.add(s.id);
  setCookie(req, res, '', 0);
}

export function sessionInfo(req: IncomingMessage): { signed_in: boolean; expires_at: string | null; email: string } {
  const s = readSession(req);
  return { signed_in: Boolean(s), expires_at: s ? new Date(s.exp).toISOString() : null, email: expectedEmail };
}
