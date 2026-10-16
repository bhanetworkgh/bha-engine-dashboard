/**
 * VRFK (LOOP-1789929222646-VRFK) over HTTP, end to end: the real server, the
 * real GET/POST /api/engine/publication-decision route behind x-dashboard-key,
 * and the Media Twin data route (/api/media-doctrine) read through
 * get_page_data, the same in-process /api router the browser is answered by.
 *
 * It pins today's behaviour and changes none of it. In particular a reused
 * decision_id with different content answers 200 with the stored row; whether
 * that should be a 409 is an open owner decision.
 *
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:vrfk-http
 * Refuses anything but a local database whose name ends in _test.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:vrfk-http starts a server that migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const PORT = 5081;
const T = Date.now();
const DOC = `VRFKH${T}`;
const INBOUND = 'inbound-for-test';
const READ = 'read-secret-for-test';
const ROUTE = '/api/engine/publication-decision';

function request(method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let body = null; try { body = b ? JSON.parse(b) : null; } catch { body = b; } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const key = { 'x-dashboard-key': INBOUND };
const post = (p, body, h = key) => request('POST', p, body, h);
const get = (p, h = key) => request('GET', p, undefined, h);
let rpcId = 0;
async function mcp(name, args) {
  const r = await post(`/mcp/${READ}`, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, {});
  if (r.body.error) throw new Error(`${name}: ${r.body.error.message}`);
  return JSON.parse(r.body.result.content[0].text);
}
const find = (v, k) => {
  if (!v || typeof v !== 'object') return undefined;
  if (k in v) return v[k];
  for (const x of Object.values(v)) { const f = find(x, k); if (f !== undefined) return f; }
  return undefined;
};
async function mediaTwin() {
  const page = await mcp('get_page_data', { path: '/media-twin', route: '/api/media-doctrine' });
  const set = find(page, 'publication_decisions');
  assert.ok(set && Array.isArray(set.decisions), 'the Media Twin data route carries publication_decisions');
  return Object.fromEntries(set.decisions.filter((d) => d.doctrine_id === DOC).map((d) => [d.claim_id, d]));
}
const held = (d) => d.decision !== 'allowed' || !d.applicable; // the page's own rule (MediaTwin/index.tsx)

const full = (claim_id) => ({
  claim_id, label: `VRFK http ${claim_id}`, maturity: 'PROVEN_NOW', allowed_wording: `Wording for ${claim_id}.`, prohibited_wording: 'Paid access is live.',
  claim_state: 'interest_only_live', config_hash: 'cfg-vrfk-http', cad_provenance: { cad_revision: 'CAD-VRFKH-1', provenance_ref: 'OWLG:VRFKH-TEST' },
  evidence_publication_status: 'PUBLISHABLE', fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: true, vfarm: false, genie_ns: true },
});
const claims = [full('READY'), { claim_id: 'GAP', label: 'VRFK http GAP', maturity: 'IN_BUILD' }];
const doctrine = (version, previous_version, changed_at) => ({
  schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-${version}`, doctrine_id: DOC, version, previous_version,
  change_type: previous_version ? 'amended' : 'created', summary: `VRFK http ${version}`, changed_at, claims, posted_by: 'test:vrfk-http',
});
const decision = (claim_id, extra = {}) => ({ decision_id: `DEC-${DOC}-${claim_id}`, doctrine_id: DOC, claim_id, surface: 'media_twin', actor: 'test:vrfk-http', source_ref: 'LOOP-1789929222646-VRFK', ...extra });
const readback = async (claim_id) => (await get(`${ROUTE}?doctrine_id=${DOC}&claim_id=${claim_id}&surface=media_twin`)).body.decisions[0];

let server;
(async () => {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: url, PORT: String(PORT), MCP_SECRET: READ, DASHBOARD_INBOUND_KEY: INBOUND, RECOVERY_ENABLED: 'false',
  };
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await request('GET', '/api/health').catch(() => null)) break;
    if (server.exitCode !== null) throw new Error(`server exited:\n${log}`);
  }

  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const rows = async (decision_id) => (await query(`SELECT count(*)::int AS n FROM engine_events WHERE dedupe_key = $1`, [`VFAM.claim_publication_decision:${decision_id}`])).rows[0].n;
  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  try {
    assert.equal((await post(ROUTE, decision('READY'), {})).status, 401);
    assert.equal((await get(`${ROUTE}?doctrine_id=${DOC}&claim_id=READY&surface=media_twin`, {})).status, 401);
    ok('without x-dashboard-key both GET and POST are 401');

    assert.equal((await post('/api/engine/media-doctrine', doctrine('v1', null, new Date(Date.now() - 60_000).toISOString()))).status, 201);

    assert.equal((await post(ROUTE, { doctrine_id: DOC, claim_id: 'READY' })).status, 422);
    assert.equal((await get(`${ROUTE}?doctrine_id=${DOC}&claim_id=READY`)).status, 422);
    assert.equal((await post(ROUTE, decision('NOPE'))).status, 404);
    assert.equal((await post(ROUTE, { ...decision('READY'), actor: '' })).status, 422);
    ok('a missing surface or actor is 422; a claim not held is 404');

    const dry = await post(ROUTE, decision('READY', { dry_run: true }));
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.recorded, false);
    assert.equal(dry.body.decision.decision, 'allowed');
    assert.equal(await rows(`DEC-${DOC}-READY`), 0);
    ok('a dry run answers the decision it would record and stores nothing');

    const missing = await readback('READY');
    assert.equal(missing.decision, 'needs_evidence');
    assert.equal(missing.reason, 'MISSING_PUBLICATION_DECISION');
    let twin = await mediaTwin();
    assert.equal(held(twin.READY), true);
    ok('before any decision, the GET reads MISSING_PUBLICATION_DECISION and Media Twin holds the claim');

    const first = await post(ROUTE, decision('READY'));
    assert.equal(first.status, 201);
    assert.equal(first.body.recorded, true);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.event_shape, 'engine.event.v1');
    assert.equal(first.body.decision.decision, 'allowed');
    assert.equal(first.body.decision.doctrine_change_id, `DOC-${DOC}-v1`);
    assert.ok(Number.isInteger(first.body.id));
    ok('POST records the server-computed decision (201) with its event id and the doctrine change it was made against');

    const back = await readback('READY');
    assert.equal(back.decision, 'allowed');
    assert.equal(back.applicable, true);
    assert.equal(back.event_id, first.body.id);
    assert.equal(back.decision_id, `DEC-${DOC}-READY`);
    ok('GET reads the same decision back: allowed, applicable, the same event id');

    const again = await post(ROUTE, decision('READY'));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.id, first.body.id);
    assert.deepEqual(again.body.differs_from_request, []);
    assert.equal(await rows(`DEC-${DOC}-READY`), 1);
    ok('an exact repeat is 200, duplicate, the same id, and still one row');

    const changed = await post(ROUTE, decision('READY', { reason: 'A different reason' }));
    assert.equal(changed.status, 200);
    assert.equal(changed.body.duplicate, true);
    assert.deepEqual(changed.body.differs_from_request, ['reason']);
    assert.equal(changed.body.decision.reason, 'T0NO_GATE_CLEARED');
    assert.equal(await rows(`DEC-${DOC}-READY`), 1);
    ok('a reused decision_id with different content is 200 with the stored row and names the field (today\'s behaviour)');

    const contra = await post(ROUTE, decision('GAP', { decision: 'allowed' }));
    assert.equal(contra.status, 409);
    assert.match(String(contra.body.message ?? contra.body.error ?? JSON.stringify(contra.body)), /contradicts the canonical T0NO result/);
    ok('a decision that contradicts T0NO is 409 and nothing is stored');

    twin = await mediaTwin();
    assert.equal(held(twin.READY), false);
    assert.equal(held(twin.GAP), true);
    assert.equal(twin.GAP.reason, 'MISSING_PUBLICATION_DECISION');
    ok('Media Twin clears only the claim with a current applicable decision and holds the one with none');

    assert.equal((await post('/api/engine/media-doctrine', doctrine('v2', 'v1', new Date().toISOString()))).status, 201);
    const stale = await readback('READY');
    assert.equal(stale.decision, 'needs_evidence');
    assert.equal(stale.applicable, false);
    assert.equal(stale.reason, 'STALE_PUBLICATION_DECISION');
    twin = await mediaTwin();
    assert.equal(held(twin.READY), true);
    assert.equal(twin.READY.reason, 'STALE_PUBLICATION_DECISION');
    ok('after a newer doctrine version the decision is STALE over GET and Media Twin holds it');

    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('vfam_claim_publication_decision', now(), $1, 'MEDIA', 'test:vrfk-http', 'LOOP-1789929222646-VRFK', $2::jsonb, $3)`,
      [`${DOC}:GAP:media_twin`, JSON.stringify({ event_name: 'VFAM.claim_publication_decision', decision_id: `DEC-${DOC}-FORGED`, doctrine_id: DOC, claim_id: 'GAP', surface: 'media_twin', decision: 'allowed', reason: 'forged', doctrine_change_id: `DOC-${DOC}-v2`, evidence_refs: [] }), `VFAM.claim_publication_decision:DEC-${DOC}-FORGED`],
    );
    const contradicted = await readback('GAP');
    assert.equal(contradicted.reason, 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO');
    twin = await mediaTwin();
    assert.equal(held(twin.GAP), true);
    ok('a stored allowed row that contradicts T0NO reads PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO and Media Twin holds it');

    const logged = (await query(`SELECT outcome, count(*)::int AS n FROM engine_writes WHERE natural_id = $1 GROUP BY outcome ORDER BY outcome`, [`DEC-${DOC}-READY`])).rows;
    assert.deepEqual(logged, [{ outcome: 'inserted', n: 1 }, { outcome: 'unchanged', n: 3 }]);
    ok('every POST is on engine_writes: one inserted, and the dry run and two repeats as unchanged');
  } finally {
    const ev = await query(`DELETE FROM engine_events WHERE subject_id LIKE $1`, [`${DOC}:%`]);
    const doc = await query(`DELETE FROM engine_media_doctrine WHERE doctrine_id = $1`, [DOC]);
    console.log(`  cleaned up ${ev.rowCount} event row(s) and ${doc.rowCount} doctrine row(s) written by this run`);
    server.kill();
    await closePool();
  }
  console.log(`\n${passed} VRFK HTTP checks passed.`);
})().catch(async (e) => {
  console.error(e);
  if (server) server.kill();
  process.exit(1);
});
