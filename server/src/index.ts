/**
 * The dashboard server. One Node process, one dependency: `pg`.
 *
 *   /api/*   JSON, behind the session cookie (only /api/auth/*, /api/health
 *            and, with their own key, /api/engine/* and /api/inbound/* are open)
 *   /*       the built front end from dist/, with the SPA fallback
 *
 * Secrets live in this process's environment and never reach the browser:
 * the login credential, the session signing key, the Ask Bays API key, the
 * engine's inbound key and DATABASE_URL. There is no Airtable token any more —
 * step 3 of the migration (2026-09-13) removed the last Airtable read path.
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
import * as registry from './registry';
import { LOOPS_BASE_ID, OPEN_LOOPS_BASE_VAR, SUBMISSIONS_BASE_FROM_ENV, SUBMISSIONS_BASE_ID, SUBMISSIONS_BASE_VAR, airtableConfigured } from './airtable';
import * as codex from './codex';
import * as loops from './loops';
import * as mirror from './mirror';
import * as executions from './executions';
import * as health from './health';
import * as bharag from './bharag';
import { monthly } from './monthly';
import { isStatKind, stats } from './stats';
import { N8N_API_VAR, n8nBase, n8nConfigured } from './n8n';
import type { Freshness, NewLoop, RecordKind, ServerStatus } from '../../src/data/types';

/**
 * Inbound writes from n8n carry this key in x-dashboard-key. Same pattern as
 * ASK_BAYS_API_KEY but the other way round: n8n proves itself to us. Held in
 * this process only. Since step 3 of the migration these tables are where the
 * rows on the pages come from, so a push here is the record, not a copy of one.
 */
const INBOUND_KEY = process.env.DASHBOARD_INBOUND_KEY || null;

/** Every kind's row count and age, for /api/status and for the line each page prints. */
async function freshnessAll(): Promise<Record<RecordKind, Freshness>> {
  const pairs = await Promise.all(store.KINDS.map(async (k) => [k, await store.freshness(k)] as const));
  return Object.fromEntries(pairs) as Record<RecordKind, Freshness>;
}

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

  /**
   * The older inbound route, kept working for whatever in n8n still calls it.
   *
   *   POST   /api/inbound/:kind          { id, record: { id, createdTime, fields }, table?, builder?, at? }
   *   PATCH  /api/inbound/:kind/:id      the same, with the id in the path
   *   DELETE /api/inbound/:kind/:id      drop the row
   *
   * It writes to the same mirror tables as /api/engine/:kind below, which is
   * the route to use. The one thing that changed on 13 Sep is that `record`
   * is now required: this server no longer reads Airtable, so a payload that
   * only names a record has nothing to fetch it from and says so.
   */
  const inbound = p.match(/^\/api\/inbound\/(resync\/)?([^/]+)(?:\/([^/]+))?$/);
  if (inbound) {
    if (!INBOUND_KEY) throw new HttpError(503, 'DASHBOARD_INBOUND_KEY is not set on the server, so inbound writes are off.');
    if (!inboundOk(req)) throw new HttpError(401, 'The x-dashboard-key header is missing or wrong.');
    const kind = inbound[2] as RecordKind;
    if (inbound[1]) {
      throw new HttpError(410, 'There is no resync any more: the pages read the engine tables directly, so there is nothing to rebuild them from. Post the record to /api/engine/:kind instead.');
    }
    if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
    const idInPath = inbound[3] ? decodeURIComponent(inbound[3]) : null;
    try {
      if (method === 'DELETE') {
        if (!idInPath) throw new HttpError(400, 'An id is required.');
        return send(res, 200, { ok: true, removed: await store.removeInbound(kind, idInPath) });
      }
      if (method !== 'POST' && method !== 'PATCH') throw new HttpError(405, 'POST, PATCH or DELETE.');
      const body = await readJson(req, 256 * 1024);
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

  /**
   * The engine's own write surface: n8n POSTs a record here and it lands in
   * the mirror tables (see mirror.ts) — which, since step 3 of the migration,
   * are the tables every page reads. A row that arrives here is on screen on
   * the next request; there is no sync in between and nothing to rebuild.
   *
   * Authenticated by the same DASHBOARD_INBOUND_KEY in the same x-dashboard-key
   * header as /api/inbound above: one service key for the engine, already set
   * on this service and already in n8n's hands. A second key would be a second
   * thing to rotate and a second thing to get wrong.
   *
   * The key is checked here, before the router looks at the kind or reads the
   * body, so an unauthenticated request never reaches a handler.
   */
  if (p === '/api/engine' || p.startsWith('/api/engine/')) {
    const t0 = Date.now();
    const endpoint = p;
    if (!INBOUND_KEY) {
      await mirror.logWrite({ endpoint, kind: '-', method, key_label: null, outcome: 'unauthorised', detail: 'DASHBOARD_INBOUND_KEY is not set on the server' });
      throw new HttpError(503, 'DASHBOARD_INBOUND_KEY is not set on the server, so engine writes are off.');
    }
    if (!inboundOk(req)) {
      await mirror.logWrite({ endpoint, kind: '-', method, key_label: null, outcome: 'unauthorised', detail: 'missing or wrong x-dashboard-key' });
      throw new HttpError(401, 'The x-dashboard-key header is missing or wrong.');
    }

    if (p === '/api/engine/backfill') {
      throw new HttpError(
        410,
        'The backfill is gone with the Airtable client it read through (13 Sep 2026, step 3 of the migration). The engine tables are the record now; post rows to /api/engine/:kind.',
      );
    }

    const m = p.match(/^\/api\/engine\/([^/]+)$/);
    if (!m) throw new HttpError(404, `POST /api/engine/:kind, where :kind is one of: ${mirror.KIND_LIST.join(', ')}.`);
    const kind = m[1];
    if (!mirror.isKind(kind)) {
      await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: 'unknown kind' });
      throw new HttpError(404, `"${kind}" is not a kind this engine holds. One of: ${mirror.KIND_LIST.join(', ')}.`);
    }
    if (method !== 'POST') throw new HttpError(405, 'POST. An upsert, so the same row twice updates rather than duplicating.');

    const body = await readJson(req, 256 * 1024);
    try {
      const result = await mirror.upsert(kind, body as mirror.MirrorInput, 'engine');
      // The row is stored; this dates the status it left the record in. It is
      // the only place a status change is timestamped, so it happens on the
      // write rather than being noticed later, and it never fails the write.
      await store.recordEngineWrite(kind, result.id);
      await mirror.logWrite({
        endpoint,
        kind,
        method,
        key_label: 'DASHBOARD_INBOUND_KEY',
        airtable_record_id: result.airtable_record_id,
        natural_id: result.natural_id,
        outcome: result.inserted ? 'inserted' : result.changed ? 'updated' : 'unchanged',
        detail: `matched on ${result.matched_on}`,
        ms: Date.now() - t0,
      });
      return send(res, 200, {
        ok: true,
        id: result.id,
        kind: result.kind,
        airtable_record_id: result.airtable_record_id,
        natural_id: result.natural_id,
        // Said plainly so a caller can tell a real change from a repeat.
        outcome: result.inserted ? 'inserted' : result.changed ? 'updated' : 'unchanged',
        matched_on: result.matched_on,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = e instanceof mirror.MirrorError ? e.status : 500;
      await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: status >= 500 ? 'error' : 'rejected', detail: message, ms: Date.now() - t0 });
      throw new HttpError(status, message);
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
          inbound_configured: Boolean(INBOUND_KEY),
          airtable_configured: airtableConfigured(),
          airtable_base: LOOPS_BASE_ID,
          airtable_submissions_base: SUBMISSIONS_BASE_ID,
          writeback_failures: await store.writebackFailures(),
          writable: store.writable(),
          freshness: await freshnessAll(),
        };
        return send(res, 200, status);
      }
      case '/api/overview':
        return send(res, 200, await engine.getOverview(q));
      case '/api/north-star':
        return send(res, 200, engine.getNorthStar(q));
      case '/api/research-twin':
        return send(res, 200, engine.getResearchTwin(q));
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
      /**
       * How often the two twins consult each other, across both ledgers. Its
       * own route rather than a field on either page, because it is one figure
       * about the pair — a copy on each would be two drawings of one count, and
       * two drawings drift.
       */
      case '/api/twin-handoffs':
        return send(res, 200, await engine.getTwinHandoffs());
      /**
       * Engine Health. The rows it holds, and the figures over them — split the
       * same way every other page splits them, so the page can re-read the
       * figures for a different lane without re-reading every row.
       */
      /**
       * `/api/engine-health`, not `/api/health`: that one is the
       * unauthenticated liveness check the host polls, and a page's data route
       * sharing its prefix is how one of them eventually shadows the other.
       */
      case '/api/engine-health':
        return send(res, 200, await health.data());
      case '/api/engine-health/retries':
        return send(res, 200, await health.retryMetrics());
      /** One lane, or all three when `lane` is absent. */
      case '/api/engine-health/metrics': {
        const lane = url.searchParams.get('lane');
        if (lane && !health.LANE_KEYS.includes(lane)) throw new HttpError(404, `"${lane}" is not a lane this engine reports on. One of: ${health.LANE_KEYS.join(', ')}.`);
        return send(res, 200, await health.metrics(lane || null));
      }
      case '/api/clients':
        return send(res, 200, await engine.getClients());
      case '/api/ask-bays':
        return send(res, 200, engine.getAskBays(q));
      case '/api/engine-writes': {
        // The dual-write comparison surface. Behind the cookie, not the
        // service key: this is for a person looking at the page, and the
        // service key is n8n's alone.
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return send(res, 200, await mirror.writesView(Number.isFinite(limit) ? limit : 50, 24, Boolean(INBOUND_KEY)));
      }
      case '/api/registry': {
        // Everything the page shows, in one response. Five small tables; a
        // request per tab would only make the age of each one harder to state.
        //
        // Named rather than positional. It read the kinds off KIND_LIST and
        // destructured them in order, so adding or removing a kind silently
        // swapped two tabs' contents; each one now asks for itself.
        //
        // `credentials` is deliberately not among them (decision 2026-09-14,
        // Destiny): there is no credentials registry. The table is not dropped,
        // because nothing drops a table, but it is neither read nor served.
        const deleted = url.searchParams.get('deleted') === 'true';
        const [workflows, services, endpoints, bases, people, builders] = await Promise.all([
          registry.list('workflows', deleted),
          registry.list('services', deleted),
          registry.list('endpoints', deleted),
          registry.list('bases', deleted),
          registry.list('people', deleted),
          // The Builders registry is the roster with its live figures beside
          // it, read from the record tables rather than from a fixture.
          store.builderFigures(),
        ]);
        return send(res, 200, {
          workflows,
          services,
          endpoints,
          bases,
          people,
          builders,
          // Computed by the server from the rows, per CLAUDE.md section 4.
          spend: registry.spendOf(services),
          // Digest delivery health sits with the registry because the base it
          // is read from is described on the same page.
          digest_health: await mirror.digestHealth(),
          includes_deleted: deleted,
        });
      }
    }
    const metrics = p.match(/^\/api\/records\/([^/]+)\/metrics$/);
    if (metrics) {
      const kind = metrics[1] as RecordKind;
      if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
      const b = url.searchParams.get('builder');
      // The month the page is showing. Omitted is every month, which is what
      // the kinds without a month picker still ask for.
      const mon = url.searchParams.get('month');
      return send(res, 200, await store.metrics(kind, { builder: b && b !== 'all' ? b : null, month: mon || null }));
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
  }

  if (method === 'PATCH') {
    /**
     * One loop, edited. What, status, lane and the builder — which is a move,
     * not a field, because the builder is which table the row sits in.
     *
     * Airtable's own field names are not used on the wire: the browser sends
     * this dashboard's vocabulary and the server maps it in one place
     * (loops.asFields), so a field name lives in exactly one file.
     */
    const loop = p.match(/^\/api\/loops\/([^/]+)$/);
    if (loop) {
      const body = await readJson(req);
      const patch: loops.LoopPatch = {};
      if (typeof body.title === 'string') patch.title = body.title.slice(0, 4000);
      if (typeof body.status === 'string') patch.status = str(body.status, 40) as loops.LoopPatch['status'];
      if (body.lane_tag === null || typeof body.lane_tag === 'string') patch.lane_tag = body.lane_tag === null ? null : str(body.lane_tag, 40);
      if (typeof body.builder === 'string') patch.builder = str(body.builder, 40);
      try {
        return send(res, 200, await store.editLoop(decodeURIComponent(loop[1]), patch, sessionInfo(req).email));
      } catch (e) {
        if (e instanceof loops.LoopError) throw new HttpError(e.status, e.message);
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    /**
     * One Codex submission's review decision. Approve, or send it back to
     * pending; "Input Added" is the pipeline's to set and is never a button
     * here, so it is not accepted.
     */
    const codexEdit = p.match(/^\/api\/codex\/([^/]+)$/);
    if (codexEdit) {
      const body = await readJson(req);
      try {
        return send(res, 200, await store.setJasonStatus(decodeURIComponent(codexEdit[1]), str(body.jason_status, 40), sessionInfo(req).email));
      } catch (e) {
        if (e instanceof codex.CodexError) throw new HttpError(e.status, e.message);
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

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
        // Who made the change, for the write-back's `actor`. One shared login,
        // so this is that account rather than a person — which is the truth,
        // and better than a literal "dashboard" that says nothing at all.
        return send(res, 200, await store.setStatus(kind, id, status, note, sessionInfo(req).email));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
  }

  /**
   * Deleting one Codex submission, from Airtable and from here.
   *
   * The body has to carry the Codex entry id back. Mid-test there are several
   * near-identical rows on screen and the id is the only thing that tells them
   * apart, which is what a yes/no dialog would not ask about. The whole row is
   * written to the deletion log before either side lets go.
   */
  /**
   * The monthly rollup behind each record page's tracking panel.
   *
   * Every month in it carries its own coverage, because several of the date
   * fields only started being written recently and a low bar drawn for a month
   * that had no instrumentation reads as a quiet month. See monthly.ts.
   */
  /**
   * The statistics tab behind six record pages: one month against the month
   * before it. One route and one engine (stats.ts), because six pages
   * computing a month-over-month change separately would eventually disagree
   * about what "down 12%" means.
   *
   * A month still running is compared against the same elapsed stretch of the
   * previous one and says which days it used, and a comparison whose window
   * predates everything held is refused rather than reported as a collapse.
   */
  const statsRoute = p.match(/^\/api\/records\/([^/]+)\/stats$/);
  if (statsRoute && method === 'GET') {
    const kind = statsRoute[1];
    if (!isStatKind(kind)) throw new HttpError(404, `${kind} has no statistics tab.`);
    try {
      return send(res, 200, await stats(kind, url.searchParams.get('month')));
    } catch (e) {
      if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  const month = p.match(/^\/api\/records\/([^/]+)\/monthly$/);
  if (month && method === 'GET') {
    const kind = month[1] as RecordKind;
    if (!store.KINDS.includes(kind)) throw new HttpError(404, 'No such record kind.');
    try {
      return send(res, 200, await monthly(kind));
    } catch (e) {
      if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  /**
   * Executions, read from the rows this database holds rather than from n8n.
   *
   * Not because n8n discards them — that has never been observed, and the page
   * no longer says it does. The rows are here so the record does not depend on
   * another system's retention policy, and so a period can be grouped, drilled
   * into and exported without asking n8n anything.
   *
   * Nothing is refreshed on the way through: the poll runs every 45 seconds of
   * its own accord, and the page says when it last ran. A read that triggered a
   * write would make every page load a load test on n8n.
   */
  if (p === '/api/executions' && method === 'GET') {
    const grain = url.searchParams.get('grain') ?? 'week';
    if (!executions.isGrain(grain)) throw new HttpError(400, 'grain must be week, month or year.');
    return send(res, 200, await executions.read(grain, url.searchParams.get('period') ?? undefined));
  }

  /** One workflow opened up: its days inside the period, and its individual runs. */
  const execWorkflow = p.match(/^\/api\/executions\/workflow\/([^/]+)$/);
  if (execWorkflow && method === 'GET') {
    const grain = url.searchParams.get('grain') ?? 'week';
    if (!executions.isGrain(grain)) throw new HttpError(400, 'grain must be week, month or year.');
    const detail = await executions.workflow(decodeURIComponent(execWorkflow[1]), grain, url.searchParams.get('period') ?? undefined);
    if (!detail) throw new HttpError(404, 'No execution of that workflow has ever been read.');
    return send(res, 200, detail);
  }

  /**
   * Read the whole history again, by hand.
   *
   * Idempotent, because every row is keyed on n8n's own execution id: it inserts
   * what is missing, updates what changed and touches nothing else. Manual, like
   * the four record resyncs — the poll keeps the page current on its own.
   */
  if (p === '/api/executions/backfill' && method === 'POST') {
    return send(res, 200, await executions.runSync(true));
  }

  const codexDelete = p.match(/^\/api\/codex\/([^/]+)$/);
  if (codexDelete && method === 'DELETE') {
    const body = await readJson(req);
    try {
      const r = await store.deleteCodex(decodeURIComponent(codexDelete[1]), str(body.confirm, 120), sessionInfo(req).email);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // The registry: this dashboard is the system of record for these six tables,
  // so unlike every other kind here the write goes straight to Postgres and
  // there is no Airtable round trip to make first.
  const reg = p.match(/^\/api\/registry\/([^/]+)(?:\/([^/]+))?$/);
  if (reg && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    const kind = reg[1];
    if (!registry.isKind(kind)) throw new HttpError(404, 'No such registry kind.');
    const id = reg[2] ? decodeURIComponent(reg[2]) : null;
    try {
      if (method === 'POST') {
        if (id) {
          // POST to a row is the undelete: /api/registry/:kind/:id/... is not a
          // shape this router has, so the body says what to do instead.
          const body = await readJson(req);
          if (body.restore === true) return send(res, 200, await registry.setDeleted(kind, id, false));
          throw new HttpError(400, 'Send { restore: true } to restore a row.');
        }
        return send(res, 201, await registry.create(kind, await readJson(req)));
      }
      if (!id) throw new HttpError(400, 'An id is required.');
      if (method === 'DELETE') return send(res, 200, await registry.setDeleted(kind, id, true));
      return send(res, 200, await registry.update(kind, id, await readJson(req)));
    } catch (e) {
      if (e instanceof registry.RegistryError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  if (method === 'POST') {
    /**
     * Remove the copy a half-landed move left behind. Its own route rather than
     * a field on the PATCH: it is a repair to Airtable alone, it changes
     * nothing about the loop, and it must never be reachable by a save that
     * happens to carry the wrong body.
     */
    /**
     * Pull every Codex row from Airtable and make this database match it.
     *
     * Manual only — never on load, never scheduled — because it reads every
     * field of every row and it deletes. Slow by nature: the client gives it
     * its own timeout.
     */
    if (p === '/api/codex/resync') {
      return send(res, 200, await store.resyncCodex(sessionInfo(req).email));
    }

    /**
     * The same pass for the other three record pages (2026-09-15, Destiny).
     * Build patterns and Commercial are a single shared table each, so theirs
     * is one sweep; Clients reads the watched-clients index and then follows
     * the `Table ID` on each of its rows to that lane's own questions table.
     *
     * Same semantics in all four cases: insert what Airtable has and we do not,
     * update what changed there, delete what is gone, and never treat a table
     * that could not be read as a table that was emptied. Manual only.
     */
    /**
     * Engine Health reads five sources — three BHARAG lanes, each with its own
     * credential, and two Airtable tables — so it has its own pass rather than
     * the shared one, which is Airtable-shaped. It answers in the same `Resync`
     * shape, so the shared button and its toast are unchanged.
     */
    if (p === '/api/engine-health/resync') {
      return send(res, 200, await health.resync(sessionInfo(req).email));
    }
    /** One manual retry. The same path the 5-minute schedule takes. */
    const retryNow = p.match(/^\/api\/engine-health\/retry\/(.+)$/);
    if (retryNow) {
      return send(res, 200, await health.retryNow(decodeURIComponent(retryNow[1]), sessionInfo(req).email));
    }
    const sweep = p.match(/^\/api\/(patterns|commercial|clients|loops|ns|rt)\/resync$/);
    if (sweep) {
      return send(res, 200, await store.resync(sweep[1] as store.ResyncKind, sessionInfo(req).email));
    }

    const dup = p.match(/^\/api\/loops\/([^/]+)\/duplicate$/);
    if (dup) {
      try {
        return send(res, 200, await store.resolveDuplicate(decodeURIComponent(dup[1]), sessionInfo(req).email));
      } catch (e) {
        if (e instanceof store.StoreError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
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
        return send(res, 201, await store.createLoop(input, sessionInfo(req).email));
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
  // Idempotent: a row that already exists is left exactly as it is, edits and
  // soft deletes included. See registry.seedRegistry.
  const seeded = await registry.seedRegistry();

  server.listen(PORT, () => {
    console.log(`BHA engine dashboard on http://localhost:${PORT}`);
    console.log(`  database: postgres ${db.server_version} at ${db.host}:${db.port}/${db.database}${db.internal ? ' (internal network, no TLS)' : ' (TLS)'}`);
    console.log(`  schema:   ${m.applied.length ? `applied ${m.applied.length} migration(s): ${m.applied.join(', ')}` : `up to date (${MIGRATION_COUNT} migration(s))`}`);
    const newRows = Object.values(seeded).reduce((n, c) => n + c, 0);
    console.log(`  registry: ${newRows ? `seeded ${newRows} row(s): ${registry.KIND_LIST.filter((k) => seeded[k]).map((k) => `${k} ${seeded[k]}`).join(', ')}` : 'already populated'}`);
    console.log(`  sign-in:  ${authConfigured() ? 'configured' : 'NOT configured — set AUTH_PASSWORD_HASH'}`);
    console.log(`  sessions: ${sessionSecretConfigured ? 'SESSION_SECRET set' : 'random key this boot (sessions end on restart)'}`);
    // Say where the URL came from, not just what it is. The line printed the
    // retired host for as long as it was wrong and read exactly like a
    // configured one, because a URL on its own cannot tell you nobody chose it.
    console.log(`  ask bays: ${askConfigured() ? `${ASK_URL} ${ASK_URL_FROM_ENV ? '(ASK_BAYS_URL)' : '(built-in default — ASK_BAYS_URL is not set on this service)'}` : 'NOT configured — set ASK_BAYS_API_KEY'}`);
    console.log(`  inbound:  ${INBOUND_KEY ? 'DASHBOARD_INBOUND_KEY set' : 'NOT configured — set DASHBOARD_INBOUND_KEY so the engine can write'}`);
    // Said loudly and by name. Without the token a loop edited here never
    // reaches Airtable, and the 08:00 digest reads Airtable — so this is a line
    // worth reading on every boot, not a quiet default.
    console.log(
      airtableConfigured()
        ? `  airtable: loops ${LOOPS_BASE_ID ? `${LOOPS_BASE_ID} (${OPEN_LOOPS_BASE_VAR})` : `NOT SET — ${OPEN_LOOPS_BASE_VAR} is missing, so no loop edited here will reach Airtable`} · submissions ${SUBMISSIONS_BASE_ID} ${SUBMISSIONS_BASE_FROM_ENV ? `(${SUBMISSIONS_BASE_VAR})` : '(default)'}`
        : '  airtable: NOT configured — AIRTABLE_TOKEN is not set on this server. Loop and Codex edits made here will NOT reach Airtable.',
    );
    // Rows are read straight out of the engine tables, so there is nothing to
    // load at boot. What does run is the ledger catch-up: any status that
    // changed in the database while this process was not running has to be
    // written down, because nothing upstream keeps that history.
    console.log(
      n8nConfigured()
        ? `  n8n:      ${n8nBase()} (${N8N_API_VAR} set) \u2014 executions polled every ${Math.round(executions.POLL_EVERY_MS / 1000)}s, one row per execution`
        : `  n8n:      NOT configured \u2014 ${N8N_API_VAR} is not set, so no execution is ever read and the Executions page says so rather than reading zero.`,
    );
    /**
     * Named lane by lane, because a missing key is not a quiet default here:
     * the lane simply never gets asked, and an unasked lane looks exactly like
     * a healthy one on any page that does not say otherwise.
     */
    const laneKeys = bharag.configuredLanes();
    console.log(
      laneKeys.length === 3
        ? `  incidents: ${bharag.BHARAG_URL} — all three lanes keyed`
        : laneKeys.length
          ? `  incidents: ${bharag.BHARAG_URL} — ${laneKeys.join(', ')} keyed; NOT keyed: ${Object.entries(bharag.LANE_KEY_VARS).filter(([k]) => !laneKeys.includes(k)).map(([, v]) => v).join(', ')}. An unkeyed lane is never read and Engine health says so rather than showing it healthy.`
          : `  incidents: NOT configured — none of ${Object.values(bharag.LANE_KEY_VARS).join(', ')} is set, so no incident is ever read and Engine health says so rather than reading zero.`,
    );
    // Rows are read straight out of the engine tables, so there is nothing to
    // load at boot. What does run is the ledger catch-up: any status that
    // changed in the database while this process was not running has to be
    // written down, because nothing upstream keeps that history.
    void catchUp();
    executions.startPolling();
  });
}

/**
 * Brings the status ledger up to date and takes the day's observations.
 *
 * Both used to hang off a successful resync. With the sync gone they run once
 * a boot: reconcile writes down statuses that changed while this process was
 * not looking, and the observations are the two figures whose trends need a
 * history nothing else keeps. Never throws — neither is a reason not to serve.
 */
async function catchUp(): Promise<void> {
  try {
    const results = await store.reconcile();
    const noticed = results.filter((r) => r.first_seen || r.changed);
    console.log(
      noticed.length
        ? `  ledger:   ${noticed.map((r) => `${r.kind} ${r.first_seen} first seen, ${r.changed} changed`).join(' · ')}`
        : `  ledger:   up to date (${results.reduce((n, r) => n + r.rows, 0)} rows)`,
    );
    await store.recordObservations();
  } catch (e) {
    console.error('the status ledger could not be brought up to date', e);
  }
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
