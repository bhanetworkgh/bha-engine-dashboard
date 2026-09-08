/**
 * The dashboard server. One Node process, no dependencies beyond Node itself.
 *
 *   /api/*   JSON, behind the session cookie (only /api/auth/login and
 *            /api/status/health are open)
 *   /*       the built front end from dist/, with the SPA fallback
 *
 * Secrets live in this process's environment and never reach the browser:
 * the login credential, the session signing key and the Ask Bays API key.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { ask, ASK_URL, askConfigured, MODEL_LABEL } from './ask';
import { authConfigured, login, logout, readSession, sessionInfo, sessionSecretConfigured } from './auth';
import { DATA_DIR, openDb } from './db';
import * as engine from './engine';
import * as store from './store';
import type { LoopStatus, NewLoop, ServerStatus } from '../../src/data/types';

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

  // Everything else needs the cookie.
  if (!readSession(req)) throw new HttpError(401, 'Sign in to continue.');

  if (method === 'GET') {
    switch (p) {
      case '/api/status': {
        const held: Record<string, number> = {};
        for (const k of store.KINDS) held[k] = store.metrics(k).by_status.reduce((n, s) => n + s.n, 0);
        const status: ServerStatus = {
          auth_configured: authConfigured(),
          session_secret_configured: sessionSecretConfigured,
          ask_bays_configured: askConfigured(),
          ask_bays_url: ASK_URL,
          model_label: MODEL_LABEL,
          data_dir: DATA_DIR,
          history_since: store.historySince(),
          records_held: held,
          started_at: STARTED_AT,
        };
        return send(res, 200, status);
      }
      case '/api/overview':
        return send(res, 200, engine.getOverview(q));
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
        return send(res, 200, engine.getOpenLoops(q));
      case '/api/codex':
        return send(res, 200, engine.getCodexEntries(q));
      case '/api/build-patterns':
        return send(res, 200, engine.getBuildPatterns(q));
      case '/api/commercial':
        return send(res, 200, engine.getCommercial(q));
      case '/api/builders':
        return send(res, 200, engine.getBuilders(q));
      case '/api/ask-bays':
        return send(res, 200, engine.getAskBays(q));
    }
    const builder = p.match(/^\/api\/builders\/([^/]+)$/);
    if (builder) {
      const d = engine.getBuilder(decodeURIComponent(builder[1]), q);
      if (!d) throw new HttpError(404, 'No builder with that id.');
      return send(res, 200, d);
    }
    const metrics = p.match(/^\/api\/records\/([^/]+)\/metrics$/);
    if (metrics) {
      const kind = metrics[1] as store.RecordKind;
      if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const b = url.searchParams.get('builder');
      return send(
        res,
        200,
        store.metrics(kind, { builder: b && b !== 'all' ? b : null, lanes: q.lane === 'all' ? null : [q.lane] }),
      );
    }
  }

  if (method === 'PATCH') {
    const m = p.match(/^\/api\/records\/([^/]+)\/([^/]+)$/);
    if (m) {
      const kind = m[1] as store.RecordKind;
      if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const body = await readJson(req);
      const status = str(body.status, 40);
      if (!status) throw new HttpError(400, 'A status is required.');
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined;
      try {
        return send(res, 200, store.setStatus(kind, decodeURIComponent(m[2]), status, note));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // Older path kept for the loop screen.
    const loop = p.match(/^\/api\/loops\/([^/]+)$/);
    if (loop) {
      const body = await readJson(req);
      try {
        return send(res, 200, store.setStatus('loops', decodeURIComponent(loop[1]), str(body.status, 40) as LoopStatus, typeof body.note === 'string' ? body.note : undefined));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
  }

  if (method === 'POST') {
    if (p === '/api/records/loops' || p === '/api/loops') {
      const body = await readJson(req);
      const input: NewLoop = {
        title: str(body.title, 400),
        owner: str(body.owner, 40),
        lane: str(body.lane, 40) as NewLoop['lane'],
        note: typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined,
      };
      try {
        return send(res, 201, store.createLoop(input));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
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

openDb();
store.seed();

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

server.listen(PORT, () => {
  console.log(`BHA engine dashboard on http://localhost:${PORT}`);
  console.log(`  data:     ${DATA_DIR}`);
  console.log(`  sign-in:  ${authConfigured() ? 'configured' : 'NOT configured — set AUTH_PASSWORD_HASH'}`);
  console.log(`  sessions: ${sessionSecretConfigured ? 'SESSION_SECRET set' : 'random key this boot (sessions end on restart)'}`);
  console.log(`  ask bays: ${askConfigured() ? ASK_URL : 'NOT configured — set ASK_BAYS_API_KEY'}`);
});
