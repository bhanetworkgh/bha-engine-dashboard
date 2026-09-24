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
import { assertDatabase, closePool, DATABASE_URL, query } from './pg';
import * as engine from './engine';
import * as store from './store';
import * as registry from './registry';
import * as airtable_ from './airtable';
import { LOOPS_BASE_ID, OPEN_LOOPS_BASE_VAR, RETIRED_VAR, SUBMISSIONS_BASE_FROM_ENV, SUBMISSIONS_BASE_ID, SUBMISSIONS_BASE_VAR, WRITEBACK_VAR, airtableConfigured, retired as airtableRetired, writebackEnabled as airtableWritebackEnabled } from './airtable';
import { IMPORT_GROUPS, finalImport as runFinalImport, isImportGroup } from './finalImport';
import * as codex from './codex';
import * as loops from './loops';
import * as mirror from './mirror';
import * as engineWrite from './engineWrite';
import * as events from './events';
import * as paySync from './paySync';
import * as executions from './executions';
import * as health from './health';
import * as repairs from './repairs';
import * as recovery from './recovery';
import * as pay from './pay';
import * as bharag from './bharag';
import { monthly } from './monthly';
import { isStatKind, stats } from './stats';
import { N8N_API_VAR, n8nBase, n8nConfigured } from './n8n';
import * as slack from './slack';
import * as google from './google';
import { handleMcp, mcpConfigured, mcpMountPath, mcpWriteConfigured, MCP_SECRET_VAR, MCP_WRITE_TOKEN_VAR, MCP_ONE_URL } from './mcp';
import * as mcpLogs from './mcp/logs';
import * as earlyAccess from './earlyAccess';
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

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extra,
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

/**
 * `internal` is only ever true for a call this process made to itself — see
 * dispatchApi below, which is how the MCP server reads a page's data through
 * the same handlers the browser hits. It cannot be set from outside: nothing
 * about a request sets it, and the only caller that passes it is in this file.
 */
async function api(req: IncomingMessage, res: ServerResponse, url: URL, internal = false): Promise<void> {
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
   * The vFarm Early Access form (2026-09-20, on Destiny's instruction).
   *
   * **The one public write route in this application.** It is here, among the
   * open routes and above the cookie guard, because the static site at
   * bhanetwork.org calls it and has no session. Everything past the guard is
   * unchanged; nothing else was opened up to make this work.
   *
   * What it will say back is `{ ok: true }` and a status code, and that is the
   * whole of it: never the stored row, never a count, never whether the address
   * was already on file. It records an expression of interest — no subscriber,
   * payment, entitlement, reservation or delivery state is set, read or implied
   * anywhere in this handler.
   *
   * The order matters. Origin, then method, then rate, then shape, then the
   * write: a refused origin never reaches the body, and a flood is turned away
   * before it costs a database round trip.
   */
  /*
   * SUPERSEDED (2026-09-23): kept, but the site no longer posts here. Form A
   * leads arrive at POST /api/engine/vfarm-leads from Hardik's n8n tracker —
   * see earlyAccess.ts.
   */
  if (p === '/api/public/vfarm-early-access') {
    const origin = earlyAccess.originOf(req);
    const cors = earlyAccess.corsHeaders(origin);

    // The preflight. Answered for an allowed origin and refused for anything
    // else, so a browser on another site never gets as far as the POST.
    if (method === 'OPTIONS') {
      if (!earlyAccess.originAllowed(origin)) {
        console.log(`[early-access] preflight refused for origin ${origin ?? '(none)'}`);
        return send(res, 403, { ok: false, message: 'Origin not allowed.' });
      }
      res.writeHead(204, { 'Content-Length': '0', 'Cache-Control': 'no-store', ...cors });
      res.end();
      return;
    }
    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify({ ok: false, message: 'POST a submission.' }));
      return;
    }

    /**
     * An Origin that is present and not on the list is refused outright, not
     * merely left without a CORS header.
     *
     * Said plainly because it is easy to overstate: **CORS is a browser
     * mechanism and cannot be an authorization boundary.** A request with no
     * Origin at all — curl, a server, anything not a browser — is allowed
     * through, because Origin is unauthenticated and refusing its absence would
     * only inconvenience honest callers. What actually protects this route is
     * the validation and the rate limit below, and the fact that it can answer
     * with nothing.
     */
    if (origin && !earlyAccess.originAllowed(origin)) {
      console.log(`[early-access] refused a submission from origin ${origin}`);
      return send(res, 403, { ok: false, message: 'Origin not allowed.' }, cors);
    }

    const ipHash = earlyAccess.hashIp(earlyAccess.clientIp(req));
    const rate = earlyAccess.checkRate(ipHash);
    if (!rate.ok) {
      // The reason is logged, never sent: how close somebody is to a limit is
      // information about the limit.
      console.log(`[early-access] rate limited (${rate.reason})`);
      return send(res, 429, { ok: false, message: 'Too many submissions. Try again later.' }, { ...cors, 'Retry-After': String(rate.retry_after_seconds ?? 600) });
    }

    let submission: earlyAccess.Submission;
    try {
      submission = earlyAccess.readSubmission(await readJson(req, 32 * 1024));
    } catch (e) {
      if (e instanceof earlyAccess.SubmissionError) return send(res, e.status, { ok: false, message: e.message }, cors);
      if (e instanceof HttpError) return send(res, e.status, { ok: false, message: e.message }, cors);
      throw e;
    }

    const ua = req.headers['user-agent'];
    const stored = await earlyAccess.store(submission, ipHash, (Array.isArray(ua) ? ua[0] : ua)?.slice(0, 500) ?? null);
    console.log(`[early-access] stored ${stored.id}${stored.is_repeat_email ? ' (repeat address)' : ''} from ${submission.source_page ?? 'an unstated page'}`);

    /**
     * The notification is started and not awaited. The lead is already stored,
     * and Slack being down is not a reason to hold a browser open or to answer
     * anything other than 201.
     */
    void earlyAccess.notify(stored, submission);

    return send(res, 201, { ok: true }, cors);
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
  /**
   * The one path under `/api/engine` that is NOT the service key's, and it is
   * spelled out here rather than left to be discovered (2026-09-22).
   *
   * `POST /api/engine/final-import/:group` is a button on a page, so it is
   * behind the session cookie like every other resync, and it is handled far
   * below with them. It lives under this prefix because it is the last act of
   * the engine cutover and belongs beside the routes that made it — but a
   * prefix that means "service key" with one exception in it is a trap unless
   * the exception is named where the rule is, which is what this is.
   */
  const FINAL_IMPORT = /^\/api\/engine\/final-import\/([^/]+)$/;
  if ((p === '/api/engine' || p.startsWith('/api/engine/')) && !FINAL_IMPORT.test(p)) {
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

    /**
     * The repair bridge's result (2026-09-20). Not a mirror kind: the row is
     * born of this engine's own repair loop rather than copied out of Airtable,
     * so it has its own table and its own shape.
     *
     * It is here, inside the engine block, so it carries exactly the same
     * authentication as every other engine write — one service key, already in
     * n8n's hands — and lands on the same write log, so a repair that was
     * refused is visible on the Engine writes tab beside everything else.
     *
     * An upsert on the bridge's own `repair_id`: it posts once when a run
     * finishes and n8n retries a failed HTTP node, so the same result arriving
     * twice must update one row rather than add a second.
     */
    if (p === '/api/engine/repair' || p === '/api/engine/repairs') {
      if (method !== 'POST') throw new HttpError(405, 'POST. An upsert on repair_id, so the same result twice updates rather than duplicating.');
      const body = await readJson(req, 1024 * 1024);
      try {
        const result = await repairs.store(body);
        await mirror.logWrite({
          endpoint,
          kind: 'repairs',
          method,
          key_label: 'DASHBOARD_INBOUND_KEY',
          natural_id: result.repair_id,
          outcome: result.inserted ? 'inserted' : 'updated',
          detail: `repair reported as ${result.outcome}`,
          ms: Date.now() - t0,
        });
        return send(res, result.inserted ? 201 : 200, { ok: true, repair_id: result.repair_id, outcome: result.outcome, stored: result.inserted ? 'inserted' : 'updated' });
      } catch (e) {
        if (e instanceof repairs.RepairError) {
          await mirror.logWrite({ endpoint, kind: 'repairs', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: e.message, ms: Date.now() - t0 });
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }

    /**
     * One vFarm Early Access lead from Hardik's Form A tracker (2026-09-23).
     * Not a mirror kind — the row lives in engine_vfarm_leads beside the
     * Early Access tab's own status and notes — so it is handled here, with
     * the same key and the same write log as every other engine write. An
     * upsert on buyer_intake_id. It posts nothing to Slack: the tracker does.
     */
    /**
     * The pay ledger brought into line with every approved session log
     * (2026-09-23). The sync runs on every log write already; this is the
     * backfill, and the thing to run if a write ever reports that its pay row
     * did not land. Safe to repeat: a second run straight after the first
     * reports every session unchanged.
     */
    if (p === '/api/engine/pay/reconcile') {
      if (method !== 'POST') throw new HttpError(405, 'POST to bring the pay ledger into line with the session logs. It takes no body.');
      const r = await paySync.reconcile();
      await mirror.logWrite({
        endpoint,
        kind: 'pay_sessions',
        method,
        key_label: 'DASHBOARD_INBOUND_KEY',
        outcome: r.created || r.updated || r.statements_closed ? 'updated' : 'unchanged',
        detail: `reconcile: ${r.checked} checked, ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.statements_closed} statement(s) closed${r.failed.length ? `, ${r.failed.length} failed` : ''}`,
        ms: r.ms,
      });
      return send(res, 200, { ok: r.failed.length === 0, ...r });
    }

    if (p === '/api/engine/vfarm-leads') {
      if (method !== 'POST') throw new HttpError(405, 'POST one lead. An upsert on buyer_intake_id, so the same submission twice updates one row.');
      const body = await readJson(req, 256 * 1024);
      try {
        const w = await earlyAccess.storeFormA(body as Record<string, unknown>);
        await mirror.logWrite({
          endpoint,
          kind: 'vfarm_leads',
          method,
          key_label: 'DASHBOARD_INBOUND_KEY',
          natural_id: w.buyer_intake_id,
          outcome: w.inserted ? 'inserted' : 'updated',
          detail: `${w.answers} answers${w.missing_questions.length ? `, ${w.missing_questions.length} Form A questions not sent` : ''}${w.unexpected_questions.length ? `, ${w.unexpected_questions.length} unexpected` : ''}`,
          ms: Date.now() - t0,
        });
        return send(res, w.inserted ? 201 : 200, { ok: true, stored: w.inserted ? 'inserted' : 'updated', ...w });
      } catch (e) {
        if (e instanceof earlyAccess.SubmissionError) {
          await mirror.logWrite({ endpoint, kind: 'vfarm_leads', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: e.message, ms: Date.now() - t0 });
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }

    /**
     * The recovery plan (2026-09-23): what the next five-minute tick would do,
     * read from what is held and calling nothing. Above the kind routes,
     * because `recovery/plan` would otherwise read as kind + row id.
     */
    if (p === '/api/engine/recovery/plan') {
      if (method !== 'GET') throw new HttpError(405, 'GET the plan. It calls nothing; the watcher itself runs on its own clock.');
      const plan = await recovery.plan();
      await mirror.logWrite({ endpoint, kind: 'recovery', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'read', detail: `plan: ${plan.waiting.length} waiting, ${plan.replaying.length} replaying`, ms: Date.now() - t0 });
      return send(res, 200, plan);
    }

    const one = p.match(/^\/api\/engine\/([^/]+)$/);
    const withId = p.match(/^\/api\/engine\/([^/]+)\/([^/]+)$/);

    /**
     * The lookup: GET /api/engine/:kind (2026-09-21, Destiny).
     *
     * BHA's Airtable workspace hit its monthly API cap on 20 Sep at about
     * 23:00 UTC and every n8n workflow that reads or writes Airtable is
     * failing, so Airtable is being cut out of the engine: every Airtable node
     * becomes an HTTPS call to this dashboard, and these tables become the
     * only record. n8n could already write a whole record here. It could not
     * read one back, which an Airtable node does constantly — so this exists,
     * and **it is the only readable thing under /api/engine.**
     *
     * The 403 that used to cover the whole prefix still covers everything
     * else, on every other method and on the internal loopback (see
     * dispatchApi), which refuses this prefix by name whatever the method.
     *
     * Same key, same header, same log. A lookup lands on engine_writes as
     * `read` rather than as one of the write outcomes, so a reader counting
     * what the engine actually wrote can leave the reads out — which is why it
     * is its own outcome rather than a detail on an existing one.
     */
    if (method === 'GET') {
      const kind = one?.[1] ?? null;
      if (!kind || !mirror.isKind(kind)) {
        const detail = withId ? 'a row id in the path' : kind ? 'unknown kind' : 'no kind';
        await mirror.logWrite({ endpoint, kind: kind ?? '-', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail, ms: Date.now() - t0 });
        throw new HttpError(
          404,
          withId
            ? `GET /api/engine/${withId[1]} reads rows; a row id is a query parameter rather than a path segment — GET /api/engine/${withId[1]}?id=${withId[2]}. The path with an id on it is PATCH only.`
            : `"${kind ?? ''}" is not a kind this engine holds. One of: ${mirror.KIND_LIST.join(', ')}.`,
        );
      }

      /**
       * Every filter, in the order it arrived, all ANDed (2026-09-22).
       *
       * Two spellings, and both end up in the same list. A bare reserved column
       * name — `natural_id=…`, `builder_id=…` — is an equality filter, which is
       * what it has always been. A prefixed one is an operator: `f.` equals,
       * `nf.` does not (and matches a row missing the field), `c.` contains,
       * `in.` any of, `gte.`/`lte.` string comparison. The prefix form works on
       * a reserved column too, which is what makes `c.natural_id=LOOP-17880`
       * possible.
       *
       * The names are Airtable's own, spaces and all, so they arrive
       * percent-encoded and `URLSearchParams` has already decoded them:
       * `f.Jason%20Status` is the key `Jason Status`, and `f.Layer1%20Review%20`
       * keeps the trailing space that field really has. A field name goes into
       * the statement as a bound parameter, never concatenated — see
       * mirror.lookup.
       *
       * Anything else in the query string is left alone: `limit`, `order` and
       * `lane` are read below, and an unprefixed name that is not a reserved
       * column is not a filter, so a stray parameter cannot silently narrow a
       * result.
       */
      const filters: mirror.LookupFilter[] = [];
      const reserved = new Set<string>(mirror.LOOKUP_FILTER_COLUMNS);
      for (const [k, v] of url.searchParams) {
        const dot = k.indexOf('.');
        if (dot > 0 && mirror.isLookupOperator(k.slice(0, dot))) {
          const name = k.slice(dot + 1);
          if (!name) {
            throw new HttpError(400, `A filter needs a name after "${k.slice(0, dot)}." — f.Jason%20Status=Approved. Airtable itself refuses a request that names an empty field, and so does this.`);
          }
          filters.push({ op: k.slice(0, dot) as mirror.LookupOperator, name, value: v });
          continue;
        }
        if (reserved.has(k)) filters.push({ op: 'f', name: k, value: v });
      }

      const orderParam = url.searchParams.get('order');
      if (orderParam !== null && orderParam !== 'created_asc' && orderParam !== 'created_desc') {
        throw new HttpError(400, `"order": "${orderParam}" is not an order. One of: created_desc (the default), created_asc.`);
      }
      const limitParam = url.searchParams.get('limit');
      if (limitParam !== null && !/^\d+$/.test(limitParam.trim())) {
        throw new HttpError(400, `"limit": "${limitParam}" is not a number. Between 1 and ${mirror.LOOKUP_LIMIT_MAX}; the default is ${mirror.LOOKUP_LIMIT_DEFAULT}.`);
      }

      try {
        const r = await mirror.lookup(kind, {
          filters,
          limit: limitParam === null ? mirror.LOOKUP_LIMIT_DEFAULT : Number(limitParam),
          order: orderParam === 'created_asc' ? 'created_asc' : 'created_desc',
        });
        const named = filters.map((f) => mirror.describeFilter(f));
        await mirror.logWrite({
          endpoint,
          kind,
          method,
          key_label: 'DASHBOARD_INBOUND_KEY',
          outcome: 'read',
          // What was asked and what came back, so an empty answer on the log
          // can be told apart from a filter nobody sent.
          detail: `${named.length ? named.join(' AND ') : 'no filter'} → ${r.rows.length} of ${r.count}`,
          ms: Date.now() - t0,
        });
        // Loops also carry the one open-loop total (2026-09-23), so a workflow
        // asking "how many loops are open" gets the figure Home prints rather
        // than whatever its own filter happened to count.
        return send(res, 200, { kind: r.kind, count: r.count, rows: r.rows, ...(kind === 'loops' ? { open_loops: await store.countOpenLoops() } : {}) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = e instanceof mirror.MirrorError ? e.status : 500;
        await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: status >= 500 ? 'error' : 'rejected', detail: message, ms: Date.now() - t0 });
        throw new HttpError(status, message);
      }
    }

    /**
     * The partial update: PATCH /api/engine/:kind/:id (2026-09-21, Destiny).
     *
     * The other half of what an Airtable node does that a whole-record POST
     * cannot: set one field and leave the rest of the row alone. `fields` is
     * merged into the stored blob, keys not sent are untouched, and a key sent
     * as null is removed. The promoted columns are re-derived from the merged
     * blob so they cannot drift from it — see mirror.patchFields, which is
     * also where the single-statement merge and the `changed` comparison live.
     *
     * The id in the path is this table's own bigint id, which is what the
     * lookup above returns. Not the Airtable record id: a row the engine wrote
     * before Airtable had it has no record id at all, and after the cut there
     * will be rows that never have one.
     */
    if (method === 'PATCH') {
      /**
       * Two paths, one merge (2026-09-22).
       *
       *   PATCH /api/engine/:kind/:id
       *   PATCH /api/engine/:kind/by-natural/:natural_id
       *
       * The second exists because n8n holds `loop_id` and `Submission ID`, not
       * this database's bigint id. Making every workflow look the id up first
       * and feed it back in is two calls for one change with a race in between,
       * which is the shape an Airtable node never had.
       *
       * `by-natural` resolves to exactly one row or refuses — 404 for none, 409
       * naming both ids for more than one — and everything after that point is
       * the ordinary path, so the two cannot merge differently.
       */
      const byNatural = p.match(/^\/api\/engine\/([^/]+)\/by-natural\/(.+)$/);
      if (!withId && !byNatural) {
        await mirror.logWrite({ endpoint, kind: one?.[1] ?? '-', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: 'no row id in the path', ms: Date.now() - t0 });
        throw new HttpError(
          404,
          `PATCH /api/engine/:kind/:id, where :id is the row id GET /api/engine/:kind returns — or PATCH /api/engine/:kind/by-natural/:natural_id to name the row by its own id instead. :kind is one of: ${mirror.KIND_LIST.join(', ')}.`,
        );
      }
      const kind = byNatural ? byNatural[1] : withId![1];
      if (!mirror.isKind(kind)) {
        await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: 'unknown kind', ms: Date.now() - t0 });
        throw new HttpError(404, `"${kind}" is not a kind this engine holds. One of: ${mirror.KIND_LIST.join(', ')}.`);
      }
      /**
       * Resolved before the body is read, so a natural id that names no row —
       * or two — costs nothing and is refused with the same shape whether the
       * body was valid or not.
       */
      let rowId: string;
      const naturalKey = byNatural ? decodeURIComponent(byNatural[2]) : null;
      const ctx: engineWrite.WriteCtx = { endpoint, method, key_label: 'DASHBOARD_INBOUND_KEY', t0 };
      if (naturalKey !== null) {
        try {
          rowId = await engineWrite.resolveRow(kind, naturalKey, ctx);
        } catch (e) {
          throw new HttpError(e instanceof mirror.MirrorError ? e.status : 500, e instanceof Error ? e.message : String(e));
        }
      } else {
        rowId = decodeURIComponent(withId![2]);
      }
      const body = await readJson(req, 256 * 1024);
      const patch = body.fields;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: '"fields" was missing or not an object', ms: Date.now() - t0 });
        throw new HttpError(422, '"fields" is required and must be an object holding only the keys to change — { "fields": { "Status": "Closed" } }. Send null for a key to remove it; a key not sent is left exactly as it is.');
      }
      try {
        // The same function the MCP write tools call (engineWrite.ts): the
        // merge, the status dating and the log line, in one place. `r`
        // carries `changed`, decided by Postgres, beside the whole row.
        return send(res, 200, await engineWrite.patchRecord(kind, rowId, patch as Record<string, unknown>, ctx, naturalKey));
      } catch (e) {
        throw new HttpError(e instanceof mirror.MirrorError ? e.status : 500, e instanceof Error ? e.message : String(e));
      }
    }

    const m = one;
    if (!m) throw new HttpError(404, `POST /api/engine/:kind, where :kind is one of: ${mirror.KIND_LIST.join(', ')}.`);
    const kind = m[1];
    /**
     * The pay ledger posts to one route and says which of its tables the row
     * belongs to in the body, rather than to three kind-named routes.
     *
     * That is what n8n was given, so it is what this accepts. The body's `kind`
     * is read before anything else looks at it and mapped onto the mirror kind;
     * everything after this point is the ordinary path, so a pay row lands with
     * the same envelope, the same auth and the same write log as any other. The
     * three kind-named routes work too — this only adds a name for them.
     */
    if (kind === 'pay' && method === 'POST') {
      const peek = await readJson(req, 256 * 1024);
      const said = typeof peek.kind === 'string' ? peek.kind.trim().toLowerCase() : '';
      const PAY_KINDS: Record<string, mirror.MirrorKind> = { session: 'pay_sessions', sessions: 'pay_sessions', statement: 'pay_statements', statements: 'pay_statements', builder: 'pay_builders', builders: 'pay_builders' };
      const mapped = PAY_KINDS[said];
      if (!mapped) {
        await mirror.logWrite({ endpoint, kind: 'pay', method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: `kind was ${said ? `"${said}"` : 'absent'}` });
        throw new HttpError(422, `"kind" is required on /api/engine/pay and must be "session" or "statement" — it decides which of the ledger's tables the row belongs to, and there is no safe default. Got ${said ? `"${said}"` : 'nothing'}.`);
      }
      try {
        const result = await mirror.upsert(mapped, peek as mirror.MirrorInput, 'engine');
        await mirror.logWrite({
          endpoint,
          kind: mapped,
          method,
          key_label: 'DASHBOARD_INBOUND_KEY',
          airtable_record_id: result.airtable_record_id,
          natural_id: result.natural_id,
          outcome: result.inserted ? 'inserted' : result.changed ? 'updated' : 'unchanged',
          detail: `via /api/engine/pay as "${said}", matched on ${result.matched_on}`,
          ms: Date.now() - t0,
        });
        return send(res, 200, {
          ok: true,
          id: result.id,
          kind: result.kind,
          airtable_record_id: result.airtable_record_id,
          natural_id: result.natural_id,
          outcome: result.inserted ? 'inserted' : result.changed ? 'updated' : 'unchanged',
          matched_on: result.matched_on,
        });
      } catch (e) {
        if (e instanceof mirror.MirrorError) {
          await mirror.logWrite({ endpoint, kind: mapped, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: e.message, ms: Date.now() - t0 });
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }
    if (!mirror.isKind(kind)) {
      await mirror.logWrite({ endpoint, kind, method, key_label: 'DASHBOARD_INBOUND_KEY', outcome: 'rejected', detail: 'unknown kind' });
      throw new HttpError(404, `"${kind}" is not a kind this engine holds. One of: ${mirror.KIND_LIST.join(', ')}.`);
    }
    if (method !== 'POST') throw new HttpError(405, 'POST to upsert a whole record — the same row twice updates rather than duplicating. GET /api/engine/:kind to read rows back, PATCH /api/engine/:kind/:id to change part of one.');

    const body = await readJson(req, 256 * 1024);
    try {
      // The same function the MCP write tools call (engineWrite.ts). The
      // outcome is said plainly so a caller can tell a real change from a repeat.
      return send(res, 200, await engineWrite.postRecord(kind, body as mirror.MirrorInput, { endpoint, method, key_label: 'DASHBOARD_INBOUND_KEY', t0 }));
    } catch (e) {
      throw new HttpError(e instanceof mirror.MirrorError ? e.status : 500, e instanceof Error ? e.message : String(e));
    }
  }

  // Everything else needs the cookie. An internal call has no browser and no
  // cookie to carry; it is authenticated by whatever let it into the process.
  if (!internal && !readSession(req)) throw new HttpError(401, 'Sign in to continue.');

  /**
   * The live pages' change stream (2026-09-23): Server-Sent Events, one
   * `{kind, id, at}` per stored change, behind the same cookie as every page
   * route. It carries what changed, never the row — a page re-reads through
   * its own route. A comment every 25 seconds keeps Render's router from
   * closing an idle connection, and `X-Accel-Buffering: no` stops a proxy from
   * holding events back until a buffer fills.
   */
  if (p === '/api/events' && method === 'GET' && !internal) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n: connected ${new Date().toISOString()}\n\n`);
    const off = events.onChange((e) => {
      res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const beat = setInterval(() => res.write(`: keep-alive ${new Date().toISOString()}\n\n`), 25_000);
    const close = () => {
      clearInterval(beat);
      off();
    };
    req.on('close', close);
    res.on('error', close);
    return;
  }

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
          airtable_writeback: airtableWritebackEnabled(),
          airtable_retired: airtableRetired(),
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
      case '/api/open-loops':
        return send(res, 200, await engine.getOpenLoops(q));
      case '/api/codex':
        return send(res, 200, await engine.getCodexEntries(q));
      case '/api/build-patterns':
        return send(res, 200, await engine.getBuildPatterns(q));
      /** The Candidates tab on /build-patterns. Behind the cookie like every page route; read only. */
      case '/api/pattern-candidates':
        return send(res, 200, await engine.getPatternCandidates());
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
      /** The recovery watcher: what waits on a dependency, the last probe, the last batch. */
      case '/api/engine-health/recovery':
        return send(res, 200, await recovery.data());
      /**
       * The MCP write tools' audit (2026-09-24): the last hundred calls to
       * create, update, archive or delete a record over MCP, refusals and dry
       * runs included. The gate's own rows (no kind) are left out.
       */
      case '/api/engine-health/mcp-writes': {
        const r = await query<Record<string, unknown>>(
          `SELECT id::int AS id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, access, tool, kind, record_id, natural_id, outcome, detail, dry_run, requester_user_id,
                  guard_result->>'reason' AS reason
             FROM engine_mcp_writes WHERE kind IS NOT NULL OR tool IN ('create_record','update_record','archive_record','delete_record')
            ORDER BY id DESC LIMIT 100`,
        );
        return send(res, 200, { writes: r.rows, write_configured: mcpWriteConfigured() });
      }
      /**
       * The repair record. Newest first, with the summary computed over the
       * same rows the list holds, so the strip above the table can never
       * disagree with the table under it.
       */
      case '/api/repairs':
        return send(res, 200, await repairs.list());
      /** Pay Tracker: the ledger's rows, and the figures over them. */
      case '/api/pay':
        return send(res, 200, await pay.data());
      case '/api/pay/metrics': {
        // The month the page is showing; omitted is every month. A value that
        // is not a month is refused rather than read as "every month", which
        // would answer a different question without saying so.
        const mon = url.searchParams.get('month');
        if (mon && !/^\d{4}-\d{2}$/.test(mon)) throw new HttpError(400, `month must be YYYY-MM, not "${mon}".`);
        return send(res, 200, await pay.metrics(mon || null));
      }
      /** One lane, or all three when `lane` is absent. */
      case '/api/engine-health/metrics': {
        const lane = url.searchParams.get('lane');
        if (lane && !health.LANE_KEYS.includes(lane)) throw new HttpError(404, `"${lane}" is not a lane this engine reports on. One of: ${health.LANE_KEYS.join(', ')}.`);
        return send(res, 200, await health.metrics(lane || null));
      }
      case '/api/clients':
        return send(res, 200, await engine.getClients());
      /**
       * The Early Access leads, for the tab on /vfarm. Behind the cookie like
       * every other page route — the public endpoint above writes these rows
       * and can never read one back.
       */
      case '/api/vfarm/leads':
        return send(res, 200, await earlyAccess.leads());
      case '/api/ask-bays':
        return send(res, 200, engine.getAskBays(q));
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
    /**
     * The Codex entry behind a pay session, for the Open button on Pay
     * Tracker (2026-09-23). Resolved here, never guessed in the client.
     */
    const payCodex = p.match(/^\/api\/pay\/sessions\/([^/]+)\/codex$/);
    if (payCodex) {
      try {
        const r = await store.codexForPaySession(decodeURIComponent(payCodex[1]));
        if (!r) throw new HttpError(404, 'No Codex entry is held for this session.');
        return send(res, 200, r);
      } catch (e) {
        if (e instanceof store.AmbiguousCodex) throw new HttpError(409, e.message);
        throw e;
      }
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
     * One lead's status, or its notes, or both. Nothing else about a lead is
     * editable: the rest of the row is what a person told the site about
     * themselves, and a record somebody can quietly rewrite is not a record.
     */
    const lead = p.match(/^\/api\/vfarm\/leads\/([^/]+)$/);
    if (lead) {
      const body = await readJson(req);
      const changes: { status?: string; notes?: string | null } = {};
      if (typeof body.status === 'string') changes.status = body.status.trim();
      if (body.notes === null || typeof body.notes === 'string') changes.notes = body.notes === null ? null : String(body.notes);
      try {
        return send(res, 200, await earlyAccess.patch(decodeURIComponent(lead[1]), changes));
      } catch (e) {
        if (e instanceof earlyAccess.SubmissionError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

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
    /**
     * Every route that reads Airtable answers 410 once it is retired
     * (2026-09-22). Checked in one place, above all of them, so a route cannot
     * be added later that quietly still reads.
     *
     * **410 rather than 404**: the route was here, it did something, and it is
     * finished. A 404 would read as a typo to whoever is re-running a saved
     * request, and send them looking for a path that never existed.
     */
    /**
     * **Engine health is not in this list** (2026-09-22). Its resync reads the
     * incident ledger from BHARAG, which is not Airtable, and refusing it with
     * the rest stopped every incident after 17 Sep reaching this page. The
     * pass itself skips its two Airtable tables when Airtable is retired.
     */
    if (/^\/api\/(codex|patterns|commercial|clients|loops|ns|rt|pay|builders)\/resync$/.test(p) || FINAL_IMPORT.test(p)) {
      if (airtableRetired()) throw new HttpError(410, airtable_.RETIRED_REASON);
    }

    /**
     * The final import (2026-09-22, Destiny): the last read of Airtable, and
     * the one that must not lose anything.
     *
     * Not a flag on the resync, deliberately. A resync is Airtable-wins by
     * design, which is right while Airtable is the record and wrong the moment
     * the engine is writing here — it would take a loop Bays closed after the
     * cutover and reopen it. This keeps what this database has changed since
     * then, names it, and deletes nothing. See server/src/finalImport.ts.
     */
    const finalImport = p.match(FINAL_IMPORT);
    if (finalImport) {
      const group = finalImport[1];
      if (!isImportGroup(group)) {
        throw new HttpError(404, `"${group}" is not a group the final import knows. One of: ${IMPORT_GROUPS.join(', ')}. Incidents are not among them: they come from BHARAG rather than Airtable, so there is no Airtable copy to import.`);
      }
      return send(res, 200, await runFinalImport(group, sessionInfo(req).email));
    }

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
    if (p === '/api/pay/resync') {
      return send(res, 200, await pay.resync(sessionInfo(req).email));
    }
    if (p === '/api/engine-health/resync') {
      return send(res, 200, await health.resync(sessionInfo(req).email));
    }
    /**
     * Close incidents a person fixed (2026-09-22, Destiny). Written to the
     * BHARAG ledger first, one at a time with the incident's own lane key; a
     * row here is marked closed only once the ledger has accepted it, and a
     * refusal comes back per incident with BHARAG's own reason.
     */
    if (p === '/api/engine-health/incidents/close') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
      if (!ids.length) throw new HttpError(400, 'Send `ids`: the incident ids to close, as the page lists them.');
      if (ids.length > 500) throw new HttpError(400, `${ids.length} incidents in one request is more than the 500 this closes at once.`);
      // The confirm step's own count, checked here too: a selection that changed
      // between the dialog and the request is not the one somebody agreed to.
      if (body.expected !== ids.length) throw new HttpError(400, `The confirmation named ${String(body.expected)} incident(s) and the request carries ${ids.length}. Nothing was closed; reopen the dialog.`);
      return send(res, 200, await health.closeIncidents([...new Set(ids)], sessionInfo(req).email));
    }
    /**
     * Put one repair back (2026-09-20). The only thing in this application that
     * changes a workflow, and it changes it in one direction: back to how it
     * was before an automated repair.
     *
     * Every guard is on the server — the outcome, the restore point, whether it
     * has already been reverted, and whether the workflow has been edited since
     * — and the answer names which one refused it. A guard that lives only in
     * the button is not a guard.
     */
    const revert = p.match(/^\/api\/repairs\/([^/]+)\/revert$/);
    if (revert) {
      return send(res, 200, await repairs.revert(decodeURIComponent(revert[1]), sessionInfo(req).email));
    }

    /**
     * The recovery switch (2026-09-23). Stored in Postgres so it flips without a
     * deploy; RECOVERY_ENABLED=false on the service still overrides it. Every
     * flip is logged with who made it.
     */
    if (p === '/api/engine-health/recovery/toggle') {
      const body = await readJson(req);
      if (typeof body.on !== 'boolean') throw new HttpError(400, 'Send { on: true } or { on: false }.');
      return send(res, 200, await recovery.setEnabled(body.on, sessionInfo(req).email));
    }
    /** Re-run now: one waiting incident, through the same steps a batch takes, ignoring the probe. */
    const rerun = p.match(/^\/api\/engine-health\/recovery\/rerun\/(.+)$/);
    if (rerun) {
      return send(res, 200, await recovery.rerun(decodeURIComponent(rerun[1]), sessionInfo(req).email));
    }

    /** One manual retry. The same path the 5-minute schedule takes. */
    const retryNow = p.match(/^\/api\/engine-health\/retry\/(.+)$/);
    if (retryNow) {
      return send(res, 200, await health.retryNow(decodeURIComponent(retryNow[1]), sessionInfo(req).email));
    }
    /**
     * `builders` has no button on any page (2026-09-23): nothing in the
     * interface reads Builder Profiles yet, and a control that filled a table
     * no screen shows would be one nobody could check the result of. The route
     * exists because the MCP `resync` tool and the final import need it, and
     * because a kind with no way to be filled is the fault mcp/inventory.ts
     * was written to stop.
     */
    const sweep = p.match(/^\/api\/(patterns|commercial|clients|loops|ns|rt|builders)\/resync$/);
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

/* ----------------------------------------------------------- in-process GET */

/**
 * Runs one GET through this server's own /api router, in this process.
 *
 * This is what the MCP server's `get_page_data` reads through, and the reason
 * it is a loopback rather than a second set of queries: it is literally the
 * function that answers the browser, against the same Postgres, so the tool
 * cannot report something the page would not show. A copy of the read logic
 * would be right until the first time one of them changed.
 *
 * GET only, and /api only. Every write route in the router above sits behind a
 * POST, PATCH or DELETE, so a GET cannot reach one — and the two service-key
 * routes are refused by name as well, because "unreachable by construction" is
 * a claim worth making twice on a path that skips the cookie.
 */
async function dispatchApi(pathWithQuery: string): Promise<{ status: number; body: unknown }> {
  const url = new URL(pathWithQuery, 'http://localhost');
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    throw new HttpError(400, `"${pathWithQuery}" is not an /api route, so it cannot be read this way.`);
  }
  if (url.pathname === '/api/events') {
    throw new HttpError(400, '/api/events is a stream that stays open, so it cannot be read as one answer. It carries only which kinds changed; read the page route instead.');
  }
  if (url.pathname.startsWith('/api/engine/') || url.pathname.startsWith('/api/inbound/')) {
    throw new HttpError(403, 'The engine write routes are not readable. Nothing in this process reads a page through them.');
  }
  const req = {
    method: 'GET',
    url: pathWithQuery,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: () => undefined,
  } as unknown as IncomingMessage;
  let status = 200;
  let text = '';
  const res = {
    setHeader: () => undefined,
    getHeader: () => undefined,
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    write: () => true,
    end: (chunk?: unknown) => {
      if (typeof chunk === 'string') text = chunk;
      return res;
    },
  } as unknown as ServerResponse;

  try {
    await api(req, res, url, true);
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ok: false, message: e.message } };
    throw e;
  }
  try {
    return { status, body: text ? (JSON.parse(text) as unknown) : null };
  } catch {
    return { status, body: { ok: false, message: 'That route answered with something that was not JSON.' } };
  }
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

  /**
   * Every request, into the MCP server's in-memory ring, so `search_logs` can
   * answer "what has this process been serving" without somebody opening
   * Render.
   *
   * **The path is redacted for /mcp.** The MCP secret is a path segment, so
   * logging the pathname verbatim would put the credential into a buffer a
   * tool reads back — which is the one thing this must not do. Render's own
   * request log already carries it, and that is a separate problem noted in
   * the README; this buffer will not add a second copy.
   */
  const startedAtMs = Date.now();
  res.on('finish', () => {
    const shown = url.pathname === '/mcp' || url.pathname.startsWith('/mcp/') ? '/mcp/<secret>' : url.pathname;
    mcpLogs.recordRequest(req.method ?? 'GET', shown, res.statusCode, Date.now() - startedAtMs);
  });
  /**
   * The MCP server, for an external Claude client (2026-09-18). Ahead of
   * /api and of the SPA fallback, and it never touches either: a request that
   * is not exactly /mcp/<MCP_SECRET> gets the same 404 an unknown route gets.
   */
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
    handleMcp(req, res, url, { dispatch: dispatchApi, startedAt: STARTED_AT }).catch((e: unknown) => {
      console.error('[mcp] unhandled', e);
      return send(res, 500, { ok: false, message: 'The server hit an error handling that request.' });
    });
    return;
  }
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
  // First, so the boot lines below are in the buffer too: which credentials are
  // configured is exactly what somebody asks search_logs about later.
  mcpLogs.install();
  const db = await assertDatabase();
  const m = await migrate();
  await store.initStore();
  // Idempotent: a row that already exists is left exactly as it is, edits and
  // soft deletes included. See registry.seedRegistry.
  const seeded = await registry.seedRegistry();

  /**
   * The pay ledger brought into line once per boot (2026-09-23), in the
   * background so it never delays serving. The sync runs on every log write;
   * this catches anything written while the process was down, and it is the
   * same idempotent pass as POST /api/engine/pay/reconcile. Its counts go to
   * engine_writes like the route's, so the first run is on the record.
   */
  void paySync
    .reconcile()
    .then((r) => {
      console.log(`  pay:      reconciled at boot — ${r.checked} checked, ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.statements_closed} statement(s) closed${r.failed.length ? `, ${r.failed.length} FAILED` : ''} (${r.ms}ms)`);
      return mirror.logWrite({
        endpoint: 'boot',
        kind: 'pay_sessions',
        method: 'RECONCILE',
        key_label: null,
        outcome: r.created || r.updated || r.statements_closed ? 'updated' : 'unchanged',
        detail: `reconcile: ${r.checked} checked, ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.statements_closed} statement(s) closed${r.failed.length ? `, ${r.failed.length} failed: ${r.failed.map((f) => `${f.codex_entry_id} (${f.reason})`).join('; ').slice(0, 800)}` : ''}`,
        ms: r.ms,
      });
    })
    .catch((e: unknown) => console.error(`  pay:      boot reconcile failed: ${e instanceof Error ? e.message : String(e)}`));

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
    /**
     * The write-back first, because when it is off nothing below it applies
     * (2026-09-21). Off is the default and is not a warning: the workspace is
     * over its monthly API cap and these tables are the record. The line says
     * which state the server is in either way, because a server that silently
     * stopped writing to Airtable is exactly the kind of quiet this dashboard
     * exists to remove.
     */
    if (airtableRetired()) {
      console.log(`  airtable: RETIRED (${RETIRED_VAR}) — nothing here reads or writes Airtable. The resync and final-import routes answer 410 and Engine health reports it as retired rather than probing it.`);
    } else {
      console.log(
        airtableWritebackEnabled()
          ? `  airtable write-back: ON (${WRITEBACK_VAR}) — loop and Codex edits made here are also sent to Airtable.`
          : `  airtable write-back: off — ${WRITEBACK_VAR} is not set, so loop and Codex edits are saved to this database only. The resync buttons still read Airtable.`,
      );
    }
    // Said loudly and by name. Without the token a loop edited here never
    // reaches Airtable, and the 08:00 digest reads Airtable — so this is a line
    // worth reading on every boot, not a quiet default. Skipped entirely once
    // Airtable is retired: a token that is not used is not news.
    if (!airtableRetired()) console.log(
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
    // Said by name, like every other credential line: with MCP_SECRET unset the
    // endpoint answers 404 to everything, which is indistinguishable from it
    // not being deployed at all.
    console.log(
      mcpConfigured()
        ? `  mcp:      ${mcpMountPath()} — read-only tools over streamable HTTP, ${MCP_SECRET_VAR} set`
        : `  mcp:      NOT configured — ${MCP_SECRET_VAR} is not set, so /mcp/* answers 404 to everything.`,
    );
    console.log(
      MCP_ONE_URL
        ? `  mcp:      ONE URL — ${MCP_WRITE_TOKEN_VAR} equals ${MCP_SECRET_VAR}, so /mcp/<${MCP_SECRET_VAR}> is the write connection: every read tool plus create, update, archive and delete behind the Tools Router guards`
        : mcpWriteConfigured()
          ? `  mcp:      /mcp/<${MCP_WRITE_TOKEN_VAR}> — the write connection: every read tool plus create, update, archive and delete behind the Tools Router guards`
          : `  mcp:      write connection OFF — ${MCP_WRITE_TOKEN_VAR} is not set, so no MCP client can write.`,
    );
    // The Slack and Google credentials the file and Doc tools need (2026-09-24).
    console.log(
      slack.slackConfigured()
        ? `  slack:    ${slack.SLACK_TOKEN_VAR} set — read_slack_file and the domain-guard DM work`
        : `  slack:    ${slack.SLACK_TOKEN_VAR} NOT set — read_slack_file answers not_configured and a refused grant_drive_access cannot DM Destiny`,
    );
    console.log(
      slack.northStarToken()
        ? `  slack:    ${slack.NS_TOKEN_VAR} set — read_slack and read_open_loops read Slack as North Star`
        : `  slack:    ${slack.NS_TOKEN_VAR} NOT set — read_slack answers not_configured and read_open_loops labels from work logs alone`,
    );
    console.log(
      slack.researchTwinToken()
        ? `  slack:    ${slack.RT_TOKEN_VAR} set — create_client_report_doc posts the weekly report as Research Twin`
        : `  slack:    ${slack.RT_TOKEN_VAR} NOT set — create_client_report_doc builds the report and answers not_configured instead of uploading it`,
    );
    console.log(
      bharag.ingestConfigured('research_twin')
        ? `  bharag:   ${bharag.INGEST_KEY_VARS.research_twin} set — update_watched_client_question ingests each answer into Research Twin's workspace`
        : `  bharag:   ${bharag.INGEST_KEY_VARS.research_twin} NOT set — update_watched_client_question writes the row and says ingested_to_bharag:false`,
    );
    console.log(
      google.googleMode()
        ? `  google:   ${google.googleMode() === 'oauth' ? 'OAuth refresh token' : 'service account'} — share_doc, grant_drive_access, create_doc and pattern Docs work`
        : `  google:   NOT configured — ${google.notConfiguredMessage()}`,
    );
    /**
     * The one public write route, said out loud at boot.
     *
     * Three things are worth a line each: notifications being off means leads
     * arrive silently and are only seen by somebody opening the page; a salt
     * that is not set means the stored digests do not compare across a restart;
     * and the origin list decides whose browser can post at all.
     */
    console.log(
      earlyAccess.notifyConfigured()
        ? `  early access: notifying #vfarm-early-access via ${earlyAccess.NOTIFY_URL_VAR}`
        : `  early access: notifications OFF — ${earlyAccess.NOTIFY_URL_VAR} is not set, so a lead is stored and nothing is announced. The endpoint still works.`,
    );
    console.log(
      `                origins ${earlyAccess.ALLOWED_ORIGINS.join(', ')} ${earlyAccess.ORIGINS_FROM_ENV ? `(${earlyAccess.ALLOWED_ORIGINS_VAR})` : '(built-in default)'}`,
    );
    if (!earlyAccess.SALT_FROM_ENV) {
      console.log(`                ${earlyAccess.SALT_VAR} is not set — a random salt was generated for this process, so stored ip_hash values will not compare across a restart.`);
    }
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
    console.log(recovery.describe());
    void catchUp();
    executions.startPolling();
    recovery.startWatching();
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
