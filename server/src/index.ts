/**
 * The dashboard server. One Node process, one dependency: `pg`.
 *
 *   /api/*   JSON, behind the session cookie (only /api/auth/*, /api/health
 *            and, with its own key, /api/inbound/* are open)
 *   /*       the built front end from dist/, with the SPA fallback
 *
 * Secrets live in this process's environment and never reach the browser:
 * the login credential, the session signing key, the Ask Bays API key, the
 * Airtable token and DATABASE_URL.
 *
 * `pg` (2026-09-12, on Destiny's instruction) is the one dependency past Node
 * itself. Until then the store was SQLite through node:sqlite, under a
 * DATA_DIR that Render wipes on every deploy and every spin-down; the state is
 * in Postgres now and there is no other store to fall back to. The process
 * refuses to start without it — see boot() at the bottom of this file.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { ask, ASK_URL, ASK_URL_FROM_ENV, askConfigured, MODEL_LABEL } from './ask';
import { authConfigured, login, logout, readSession, sessionInfo, sessionSecretConfigured } from './auth';
import { databaseIdentity } from './db';
import { migrate, MIGRATION_COUNT } from './migrations';
import { assertDatabase, closePool, DATABASE_URL } from './pg';
import * as engine from './engine';
import * as store from './store';
import * as sync from './sync';
import { airtableConfigured, AIRTABLE_URL } from './airtable';
import type { NewLoop, RecordKind, ServerStatus } from '../../src/data/types';

/**
 * Inbound writes from n8n carry this key in x-dashboard-key. Same pattern as
 * ASK_BAYS_API_KEY but the other way round: n8n proves itself to us. Held in
 * this process only. Airtable stays authoritative; a push here is additive.
 */
const INBOUND_KEY = process.env.DASHBOARD_INBOUND_KEY || null;

function inboundOk(req: IncomingMessage): boolean {
  if (!INBOUND_KEY) return false;
  const given = req.headers['x-dashboard-key'];
  const v = Array.isArray(given) ? given[0] : given;
  return typeof v === 'string' && v.length === INBOUND_KEY.length && v === INBOUND_KEY;
}

const PORT = Number(process.env.PORT || 8787);
const DIST = path.resolve(process.cwd(), 'dist');
const STARTED_AT = new Date().toISOString();

/* -------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'The request body was not JSON.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'The request body could not be read.')));
  });
}

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/* ------------------------------------------------------------------ api */

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const p = url.pathname.replace(/\/+$/, '') || '/api';
  const q = { lane: engine.parseLane(url.searchParams.get('lane')) };

  // Open routes.
  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const email = str(body.email, 320);
    const password = str(body.password, 1024);
    if (!email || !password) return send(res, 400, { ok: false, message: 'Enter an email address and a password.' });
    const r = login(req, res, email, password);
    if (!r.ok) return send(res, r.status, { ok: false, message: r.message });
    return send(res, 200, { ok: true, session: { expires_at: r.expires_at, email: sessionInfo(req).email } });
  }
  if (p === '/api/auth/session' && method === 'GET') {
    const s = sessionInfo(req);
    return send(res, 200, { signed_in: s.signed_in, session: s.signed_in ? { expires_at: s.expires_at, email: s.email } : null });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    logout(req, res);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/health' && method === 'GET') {
    return send(res, 200, { ok: true, started_at: STARTED_AT });
  }

  // Inbound from n8n: authenticated by DASHBOARD_INBOUND_KEY, not the cookie.
  //   POST   /api/inbound/:kind          { id, table?, builder?, record?, at? }  upsert (create or update)
  //   PATCH  /api/inbound/:kind/:id      { table?, builder?, record?, at? }      same, id in the path
  //   DELETE /api/inbound/:kind/:id                                               drop the held row
  //   POST   /api/inbound/resync/:kind                                            full rebuild of that kind
  // `record` is the Airtable record as n8n wrote it ({ id, createdTime, fields }); when absent the
  // server reads the record from Airtable itself. Airtable stays authoritative either way.
  const inbound = p.match(/^\/api\/inbound\/(resync\/)?([^/]+)(?:\/([^/]+))?$/);
  if (inbound) {
    if (!INBOUND_KEY) throw new HttpError(503, 'DASHBOARD_INBOUND_KEY is not set on the server, so inbound writes are off.');
    if (!inboundOk(req)) throw new HttpError(401, 'The x-dashboard-key header is missing or wrong.');
    const kind = inbound[2] as RecordKind;
    if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
    if (inbound[1]) {
      if (method !== 'POST') throw new HttpError(405, 'POST to resync.');
      if (!airtableConfigured()) throw new HttpError(503, 'AIRTABLE_API_KEY is not set on the server, so there is nothing to resync from.');
      const r = await sync.resync(kind);
      return send(res, r.ok ? 200 : 502, r);
    }
    const idInPath = inbound[3] ? decodeURIComponent(inbound[3]) : null;
    try {
      if (method === 'DELETE') {
        if (!idInPath) throw new HttpError(400, 'An id is required.');
        return send(res, 200, { ok: true, removed: await store.removeInbound(kind, idInPath) });
      }
      if (method !== 'POST' && method !== 'PATCH') throw new HttpError(405, 'POST, PATCH or DELETE.');
      const body = await readJson(req);
      const record = body.record && typeof body.record === 'object' && !Array.isArray(body.record) ? (body.record as { id: string; createdTime: string; fields: Record<string, unknown> }) : undefined;
      if (record && (typeof record.fields !== 'object' || record.fields === null)) throw new HttpError(400, 'record.fields must be an object.');
      // The id can come from the path, the body, or the record itself — n8n's Airtable node returns the record with its id inside.
      const id = idInPath ?? (str(body.id, 40) || (record ? str(record.id, 40) : ''));
      const builder = str(body.builder, 40);
      const tableFromBuilder = builder ? (kind === 'codex' ? engine.codexTableFor(builder) : engine.loopTableFor(builder)) : null;
      const table = str(body.table, 40) || tableFromBuilder || undefined;
      const result = await store.applyInbound(kind, { id, table, record, at: str(body.at, 40) || undefined });
      return send(res, result.inserted ? 201 : 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Everything else needs the cookie.
  if (!readSession(req)) throw new HttpError(401, 'Sign in to continue.');

  if (method === 'GET') {
    switch (p) {
      case '/api/status': {
        const db = databaseIdentity();
        const status: ServerStatus = {
          auth_configured: authConfigured(),
          session_secret_configured: sessionSecretConfigured,
          ask_bays_configured: askConfigured(),
          ask_bays_url: ASK_URL,
          model_label: MODEL_LABEL,
          // Where the rows actually are. Host and database only — the URL
          // carries the password and this response reaches the browser.
          data_dir: db ? `postgres ${db.server_version} · ${db.host}/${db.database}${db.internal ? ' (internal)' : ''}` : 'postgres (not connected)',
          history_since: await store.historySince(),
          records_held: await store.held(),
          started_at: STARTED_AT,
          airtable_configured: airtableConfigured(),
          airtable_url: AIRTABLE_URL,
          inbound_configured: Boolean(INBOUND_KEY),
          resync_minutes: sync.RESYNC_MINUTES,
          sync: Object.fromEntries(await Promise.all(store.KINDS.map(async (k) => [k, await store.syncInfo(k)] as const))) as ServerStatus['sync'],
        };
        return send(res, 200, status);
      }
      case '/api/overview':
        return send(res, 200, await engine.getOverview(q));
      case '/api/engine-status':
        return send(res, 200, engine.getEngineStatus(q));
      case '/api/north-star':
        return send(res, 200, engine.getNorthStar(q));
      case '/api/research-twin':
        return send(res, 200, engine.getResearchTwin(q));
      case '/api/vfarm':
        return send(res, 200, engine.getVFarm(q));
      case '/api/engine-health':
        return send(res, 200, engine.getEngineHealth(q));
      case '/api/open-loops':
        return send(res, 200, await engine.getOpenLoops(q));
      case '/api/codex':
        return send(res, 200, await engine.getCodexEntries(q));
      case '/api/build-patterns':
        return send(res, 200, await engine.getBuildPatterns(q));
      case '/api/commercial':
        return send(res, 200, await engine.getCommercial(q));
      case '/api/ns-telemetry':
        return send(res, 200, await engine.getNorthStarTelemetry());
      case '/api/rt-telemetry':
        return send(res, 200, await engine.getResearchTwinTelemetry());
      case '/api/clients':
        return send(res, 200, await engine.getClients());
      case '/api/builders':
        return send(res, 200, await engine.getBuilders(q));
      case '/api/ask-bays':
        return send(res, 200, engine.getAskBays(q));
    }
    const builder = p.match(/^\/api\/builders\/([^/]+)$/);
    if (builder) {
      const d = await engine.getBuilder(decodeURIComponent(builder[1]), q);
      if (!d) throw new HttpError(404, 'No builder with that id.');
      return send(res, 200, d);
    }
    const metrics = p.match(/^\/api\/records\/([^/]+)\/metrics$/);
    if (metrics) {
      const kind = metrics[1] as RecordKind;
      if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const b = url.searchParams.get('builder');
      return send(res, 200, await store.metrics(kind, { builder: b && b !== 'all' ? b : null }));
    }
    if (p === '/api/build-patterns/search') {
      return send(res, 200, { patterns: await store.searchPatterns(url.searchParams.get('q') ?? '') });
    }
    const patternDetail = p.match(/^\/api\/build-patterns\/([^/]+)$/);
    if (patternDetail) {
      const d = await store.patternDetail(decodeURIComponent(patternDetail[1]));
      if (!d) throw new HttpError(404, 'That pattern is not held by this dashboard.');
      return send(res, 200, d);
    }
    // The full Codex entry (Orchestrator Layer2 Review) is thousands of words,
    // so it is fetched one entry at a time rather than carried on the list.
    const codexDetail = p.match(/^\/api\/codex\/([^/]+)$/);
    if (codexDetail) {
      const d = await engine.getCodexDetail(decodeURIComponent(codexDetail[1]));
      if (!d) throw new HttpError(404, 'That Codex entry is not held by this dashboard.');
      return send(res, 200, d);
    }
    if (p === '/api/resync') {
      return send(res, 200, {
        running: store.KINDS.filter((k) => sync.isRunning(k)),
        sync: Object.fromEntries(await Promise.all(store.KINDS.map(async (k) => [k, await store.syncInfo(k)] as const))),
      });
    }
  }

  if (method === 'PATCH') {
    const m = p.match(/^\/api\/records\/([^/]+)\/([^/]+)$/);
    if (m) {
      const kind = m[1] as RecordKind;
      if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const body = await readJson(req);
      const id = decodeURIComponent(m[2]);
      try {
        // Two shapes: { status, note? } changes state; { fields: {...} } edits the record's own fields.
        if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
          return send(res, 200, await store.updateFields(kind, id, body.fields as Record<string, unknown>));
        }
        const status = str(body.status, 40);
        if (!status) throw new HttpError(400, 'A status, or a fields object, is required.');
        const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined;
        return send(res, 200, await store.setStatus(kind, id, status, note));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
  }

  if (method === 'POST') {
    if (p === '/api/records/loops') {
      const body = await readJson(req);
      const input: NewLoop = {
        title: str(body.title, 400),
        owner: str(body.owner, 40),
        lane_tag: str(body.lane_tag, 40) as NewLoop['lane_tag'],
        raised_by: typeof body.raised_by === 'string' ? body.raised_by.slice(0, 120) : undefined,
        note: typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined,
      };
      try {
        return send(res, 201, await store.createLoop(input));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // Rebuild one kind, or all, from Airtable. Session cookie or inbound key; n8n may call it too.
    const resyncMatch = p.match(/^\/api\/resync(?:\/([^/]+))?$/);
    if (resyncMatch) {
      if (!airtableConfigured()) throw new HttpError(503, 'AIRTABLE_API_KEY is not set on the server, so there is nothing to resync from.');
      const kind = resyncMatch[1] as RecordKind | undefined;
      if (kind && !store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const results = kind ? [await sync.resync(kind)] : await sync.resyncAll();
      return send(res, results.every((r) => r.ok) ? 200 : 502, { ok: results.every((r) => r.ok), results });
    }
    if (p === '/api/ask') {
      const body = await readJson(req);
      const message = str(body.message, 8000).trim();
      const sessionId = str(body.session_id, 120).trim();
      const builderId = str(body.builder_id, 40).trim() || 'admin';
      if (!message) throw new HttpError(400, 'A message is required.');
      if (!sessionId) throw new HttpError(400, 'A session_id is required.');
      return send(res, 200, await ask(message, sessionId, builderId));
    }
  }

  throw new HttpError(404, 'No such route.');
}

/* --------------------------------------------------------------- static */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveFile(res: ServerResponse, file: string, cache: string): void {
  const ext = path.extname(file).toLowerCase();
  const st = statSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache,
  });
  createReadStream(file).pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: 'Method not allowed.' });
  if (!existsSync(DIST)) return send(res, 503, { message: 'The front end has not been built. Run npm run build.' });
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(DIST, rel);
  if (rel && file.startsWith(DIST + path.sep) && existsSync(file) && statSync(file).isFile()) {
    const hashed = rel.startsWith('assets/');
    return serveFile(res, file, hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  }
  return serveFile(res, path.join(DIST, 'index.html'), 'no-cache');
}

/* ----------------------------------------------------------------- boot */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { ok: false, message: e.message });
      console.error(e);
      return send(res, 500, { ok: false, message: 'The server hit an error handling that request.' });
    });
    return;
  }
  serveStatic(req, res, url);
});

/**
 * Nothing is served until Postgres answers and the migrations have run.
 *
 * The order matters and the first step is the point of it: `assertDatabase`
 * exits the process if DATABASE_URL is missing or the database is
 * unreachable. There is deliberately no fallback store — a server that
 * started anyway would accept writes it could not keep and show figures it
 * could not stand behind, which is exactly how data goes missing without
 * anyone noticing.
 */
async function boot(): Promise<void> {
  const db = await assertDatabase();
  const m = await migrate();
  await store.initStore();

  server.listen(PORT, () => {
    console.log(`BHA engine dashboard on http://localhost:${PORT}`);
    console.log(`  database: postgres ${db.server_version} at ${db.host}:${db.port}/${db.database}${db.internal ? ' (internal network, no TLS)' : ' (TLS)'}`);
    console.log(`  schema:   ${m.applied.length ? `applied ${m.applied.length} migration(s): ${m.applied.join(', ')}` : `up to date (${MIGRATION_COUNT} migration(s))`}`);
    console.log(`  sign-in:  ${authConfigured() ? 'configured' : 'NOT configured — set AUTH_PASSWORD_HASH'}`);
    console.log(`  sessions: ${sessionSecretConfigured ? 'SESSION_SECRET set' : 'random key this boot (sessions end on restart)'}`);
    // Say where the URL came from, not just what it is. The line printed the
    // retired host for as long as it was wrong and read exactly like a
    // configured one, because a URL on its own cannot tell you nobody chose it.
    console.log(`  ask bays: ${askConfigured() ? `${ASK_URL} ${ASK_URL_FROM_ENV ? '(ASK_BAYS_URL)' : '(built-in default — ASK_BAYS_URL is not set on this service)'}` : 'NOT configured — set ASK_BAYS_API_KEY'}`);
    console.log(`  inbound:  ${INBOUND_KEY ? 'DASHBOARD_INBOUND_KEY set' : 'NOT configured — set DASHBOARD_INBOUND_KEY for n8n dual-write'}`);
    void sync.startBootSync();
  });
}

// Render sends SIGTERM on deploy and on spin-down; drain the pool so an
// in-flight transaction is not cut mid-statement.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => void closePool().finally(() => process.exit(0)));
  });
}

void boot().catch((e: unknown) => {
  // assertDatabase and migrate report their own failures and exit; anything
  // reaching here is unexpected, and still not a reason to serve.
  console.error('');
  console.error('FATAL: the server could not start.');
  console.error(`  ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  if (!DATABASE_URL) console.error('  DATABASE_URL is not set.');
  console.error('');
  process.exit(1);
});
