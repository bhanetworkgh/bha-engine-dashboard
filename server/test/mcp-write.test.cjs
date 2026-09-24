/**
 * The MCP write tools (2026-09-24), pinned end to end: the real server process,
 * the real MCP transport, both tokens, a local database, and a stand-in for
 * BHARAG's /ingest so the ingest can be seen landing and failing.
 *
 * What this proves — the brief's "done means", plus the ways a guarded write
 * goes wrong quietly:
 *   1. list_writable_kinds returns the real kinds;
 *   2. a loop is created (lane BAYS, assignee Destiny) and is on the lookup;
 *   3. the same loop again is refused possible_duplicate, and nothing is written;
 *   4. a MEDIA loop assigned to Destiny is refused lane_owner_mismatch;
 *   5. update_record to In Progress lands;
 *   6. archive_record closes it and the row is still there;
 *   7. every call is on engine_mcp_writes, refusals and dry runs included;
 *   8. on the read token none of the write tools are listed or callable.
 * And: a non-admin cannot change somebody else's loop; dry_run writes nothing;
 * delete needs the exact confirm; codex cannot be deleted; a pattern create is
 * ingested, and one whose BHARAG key is missing says saved:true,
 * ingested_to_bharag:false; the POST route still answers as before.
 *
 * Run with:  npm run test:mcp-write   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:mcp-write writes and deletes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const READ = 'read-secret-for-test';
const WRITE = 'write-token-for-test';
const PORT = 5077;
const T = Date.now();
const ingests = [];

const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    ingests.push({ path: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, document_id: `doc-${ingests.length}` }));
  });
});

let server;
let rpcId = 0;
function post(pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
async function rpc(token, method, params) {
  const r = await post(`/mcp/${token}`, { jsonrpc: '2.0', id: ++rpcId, method, params });
  return r;
}
async function call(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  if (r.body.error) return { rpcError: r.body.error };
  return JSON.parse(r.body.result.content[0].text);
}

(async () => {
  await new Promise((r) => bharag.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: READ,
    MCP_WRITE_TOKEN: WRITE,
    DASHBOARD_INBOUND_KEY: 'inbound-for-test',
    BHARAG_API_URL: `http://127.0.0.1:${bharag.address().port}/api/v1`,
    BHARAG_BUILD_PATTERNS_KEY: 'bp-key',
    RECOVERY_ENABLED: 'false',
  };
  delete env.BHARAG_COMMERCIAL_KEY;
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\/|port/i.test(log) && (await post('/mcp/nope', {}).catch(() => null))) break;
  }

  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const results = [];
  const ok = (name, fn) => results.push([name, fn]);
  let loopRow;

  try {
    // 8. The read token lists no write tool, and cannot call one.
    const readList = (await rpc(READ, 'tools/list', {})).body.result.tools.map((t) => t.name);
    const writeList = (await rpc(WRITE, 'tools/list', {})).body.result.tools.map((t) => t.name);
    for (const w of ['list_writable_kinds', 'create_record', 'update_record', 'archive_record', 'delete_record']) {
      assert.ok(!readList.includes(w), `read token must not list ${w}`);
      assert.ok(writeList.includes(w), `write token lists ${w}`);
    }
    assert.ok(writeList.includes('query_postgres'), 'the write token keeps every read tool');
    const sneaky = await call(READ, 'create_record', { kind: 'loops', fields: { What: 'x' } });
    assert.ok(sneaky.rpcError, 'a write tool on the read token is no such tool');
    assert.equal((await post('/mcp/wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 404);
    ok('8 read token: no write tools', () => true);

    // 1. list_writable_kinds
    const kinds = await call(WRITE, 'list_writable_kinds', {});
    assert.deepEqual(kinds.kinds.map((k) => k.kind).sort(), ['builder_profiles', 'codex', 'commercial', 'lane_backlog', 'loops', 'pattern_candidates', 'patterns', 'rt-jobs']);
    const lk = kinds.kinds.find((k) => k.kind === 'loops');
    assert.equal(lk.table, 'engine_loops');
    assert.ok(lk.columns.includes('natural_id'));
    assert.deepEqual(lk.allowed_values.lane_tag, ['RT', 'NS', 'VFARM_HARDWARE', 'KIOSK', 'CAD_API', 'MEDIA', 'GENIE', 'CST', 'BAYS', 'UNASSIGNED']);
    ok('1 list_writable_kinds', () => true);

    const WHAT = `MCP write test ${T}: verify the recovery watcher summary lands in the self healing channel`;
    // dry run writes nothing
    const dry = await call(WRITE, 'create_record', { kind: 'loops', dry_run: true, fields: { What: WHAT, 'Raised By': 'Destiny Arupi', lane_tag: 'bays', 'Assignee Slack User ID': 'U0AEW3TBYH1' } });
    assert.equal(dry.ok, true);
    assert.equal(dry.written, false);
    assert.equal(dry.would_write.fields.lane_tag, 'BAYS');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_loops WHERE natural_id = $1`, [dry.natural_id])).rows[0].n, 0, 'dry run wrote nothing');

    // 2. create
    const created = await call(WRITE, 'create_record', { kind: 'loops', requester_user_id: 'U0AEW3TBYH1', fields: { What: WHAT, 'Raised By': 'Destiny Arupi', lane_tag: 'BAYS', 'Assignee Slack User ID': 'U0AEW3TBYH1' } });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.match(created.natural_id, /^LOOP-\d+-[A-Z0-9]{4}$/);
    assert.equal(created.row.builder_id, 'destiny');
    assert.equal(created.row.fields.Status, 'Open');
    loopRow = created;
    const onLookup = await query(`SELECT source FROM engine_loops WHERE natural_id = $1`, [created.natural_id]);
    assert.equal(onLookup.rows[0].source, 'engine', 'written through the same path as the engine');
    const log1 = await query(`SELECT endpoint, key_label, outcome FROM engine_writes WHERE natural_id = $1 ORDER BY at DESC LIMIT 1`, [created.natural_id]);
    assert.deepEqual(log1.rows[0], { endpoint: 'mcp:create_record', key_label: 'MCP_WRITE_TOKEN', outcome: 'inserted' });
    ok('2 create loop', () => true);

    // 3. the same again
    const before = (await query(`SELECT count(*)::int n FROM engine_loops`)).rows[0].n;
    const dup = await call(WRITE, 'create_record', { kind: 'loops', fields: { What: WHAT, 'Raised By': 'Destiny Arupi', lane_tag: 'BAYS', 'Assignee Slack User ID': 'U0AEW3TBYH1' } });
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'possible_duplicate');
    assert.equal(dup.detail.candidates[0].loop_id, created.natural_id);
    assert.equal((await query(`SELECT count(*)::int n FROM engine_loops`)).rows[0].n, before, 'nothing written');
    ok('3 duplicate refused', () => true);

    // 4. MEDIA assigned to Destiny
    const media = await call(WRITE, 'create_record', { kind: 'loops', fields: { What: `A media render task ${T}`, 'Raised By': 'Destiny Arupi', lane_tag: 'MEDIA', 'Assignee Slack User ID': 'U0AEW3TBYH1' } });
    assert.equal(media.reason, 'lane_owner_mismatch');
    assert.equal(media.detail.lane_owner, 'U0BKT6MAW2Y');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_loops`)).rows[0].n, before, 'nothing written');
    ok('4 lane owner mismatch refused', () => true);

    // permission: Kavin cannot change Destiny's loop
    const denied = await call(WRITE, 'update_record', { kind: 'loops', natural_id: created.natural_id, requester_user_id: 'U0BNQGG020Y', fields: { Status: 'In Progress' } });
    assert.equal(denied.reason, 'not_permitted');
    const noReq = await call(WRITE, 'update_record', { kind: 'loops', natural_id: created.natural_id, fields: { Status: 'In Progress' } });
    assert.equal(noReq.reason, 'not_permitted');
    const badLane = await call(WRITE, 'update_record', { kind: 'loops', natural_id: created.natural_id, requester_user_id: 'U0AEW3TBYH1', fields: { lane_tag: 'MARKETING' } });
    assert.equal(badLane.reason, 'invalid_value');

    // 5. update to In Progress
    const upd = await call(WRITE, 'update_record', { kind: 'loops', natural_id: created.natural_id, requester_user_id: 'U0AEW3TBYH1', fields: { Status: 'in progress' } });
    assert.equal(upd.ok, true, JSON.stringify(upd));
    assert.equal(upd.row.fields.Status, 'In Progress');
    assert.equal(upd.row.fields.What, WHAT, 'fields not sent are untouched');
    ok('5 update to In Progress', () => true);

    // 6. archive
    const arch = await call(WRITE, 'archive_record', { kind: 'loops', id: String(created.id), requester_user_id: 'U0AEW3TBYH1', reason: 'MCP write test' });
    assert.equal(arch.ok, true, JSON.stringify(arch));
    assert.equal(arch.row.fields.Status, 'Closed');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_loops WHERE natural_id = $1`, [created.natural_id])).rows[0].n, 1, 'row still present');
    const noArchive = await call(WRITE, 'archive_record', { kind: 'patterns', natural_id: 'BP-X', reason: 'x' });
    assert.equal(noArchive.ok, false);
    ok('6 archive keeps the row', () => true);

    // delete: wrong confirm, codex refused, right confirm
    const wrong = await call(WRITE, 'delete_record', { kind: 'loops', natural_id: created.natural_id, confirm: 'DELETE it', reason: 'test', requester_user_id: 'U0AEW3TBYH1' });
    assert.equal(wrong.ok, false);
    const codexDel = await call(WRITE, 'delete_record', { kind: 'codex', natural_id: 'x', confirm: 'DELETE x', reason: 'test' });
    assert.equal(codexDel.ok, false);
    assert.equal(codexDel.reason, 'not_writable');

    // patterns: ingested, BP- id
    const pat = await call(WRITE, 'create_record', { kind: 'patterns', requester_user_id: 'Destiny', fields: { pattern_name: `Test pattern ${T}`, problem: 'p', solution: 's', context: 'c', bha_system: 'bharag', implementation_checklist: ['one', 'two'] } });
    assert.equal(pat.ok, true, JSON.stringify(pat));
    assert.match(pat.natural_id, /^BP-BHARAG-\d+-[A-Z0-9]{4}$/);
    assert.equal(pat.row.fields.implementation_checklist, 'one | two');
    assert.equal(pat.row.fields.reusability, 'Moderate');
    assert.equal(pat.ingested_to_bharag, true);
    assert.equal(ingests.at(-1).key, 'bp-key');
    assert.deepEqual(ingests.at(-1).body.project_tags, ['build-pattern', 'log-engine']);
    assert.equal(ingests.at(-1).body.metadata.pattern_id, pat.natural_id);

    // commercial with no key: saved, not ingested, and says so
    const card = await call(WRITE, 'create_record', { kind: 'commercial', fields: { opportunity_title: `Test card ${T}`, confidence: 'high' } });
    assert.equal(card.saved, true);
    assert.equal(card.ingested_to_bharag, false);
    assert.match(card.note, /not full success/);
    assert.equal(card.row.fields.confidence, 'High');

    // candidates: Proposed, CAND- id, duplicate by name
    const cand = await call(WRITE, 'create_record', { kind: 'pattern_candidates', fields: { Candidate: `Test Candidate ${T}`, Summary: 's', Status: 'Registered', Lane: 'bays' } });
    assert.equal(cand.ok, true, JSON.stringify(cand));
    assert.equal(cand.row.fields.Status, 'Proposed');
    assert.match(cand.natural_id, /^CAND-/);
    const cand2 = await call(WRITE, 'create_record', { kind: 'pattern_candidates', fields: { Candidate: `test candidate ${T}!`, Summary: 's' } });
    assert.equal(cand2.reason, 'possible_duplicate');

    // delete the test rows with the exact confirm
    for (const [kind, n] of [['patterns', pat.natural_id], ['commercial', card.natural_id], ['pattern_candidates', cand.natural_id], ['loops', created.natural_id]]) {
      const d = await call(WRITE, 'delete_record', { kind, natural_id: n, confirm: `DELETE ${n}`, reason: 'MCP write test cleanup', requester_user_id: 'U0AEW3TBYH1' });
      assert.equal(d.deleted, true, JSON.stringify(d));
    }
    assert.equal((await query(`SELECT count(*)::int n FROM record_deletions WHERE natural_id = $1`, [created.natural_id])).rows[0].n, 1, 'kept in record_deletions');

    // 7. the audit
    const audit = await query(`SELECT tool, outcome, access, dry_run FROM engine_mcp_writes WHERE at > now() - interval '5 minutes' ORDER BY id`);
    const seen = audit.rows.map((r) => `${r.tool}:${r.outcome}`);
    for (const want of ['create_record:dry_run', 'create_record:inserted', 'create_record:refused', 'update_record:refused', 'update_record:updated', 'archive_record:archived', 'delete_record:refused', 'delete_record:deleted']) {
      assert.ok(seen.includes(want), `audit holds ${want}: ${seen.join(', ')}`);
    }
    assert.ok(audit.rows.every((r) => r.access === 'write'));
    assert.equal(audit.rows.filter((r) => r.outcome === 'pending').length, 0, 'every audit line was closed');
    ok('7 every call audited', () => true);

    // the route n8n uses still answers as before
    const routeLoop = `LOOP-${T}-ZZZZ`;
    const r = await post('/api/engine/loops', { builder_id: 'destiny', fields: { loop_id: routeLoop, What: 'route check', Status: 'Open' } }, { 'x-dashboard-key': 'inbound-for-test' });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'inserted');
    const p = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api/engine/loops/by-natural/${routeLoop}`, method: 'PATCH', headers: { 'content-type': 'application/json', 'x-dashboard-key': 'inbound-for-test' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      });
      req.end(JSON.stringify({ fields: { Status: 'Closed' } }));
    });
    assert.equal(p.status, 200);
    assert.equal(p.body.fields.Status, 'Closed');
    await query(`DELETE FROM engine_loops WHERE natural_id = $1`, [routeLoop]);

    for (const [name] of results) console.log(`  ok  ${name}`);
    console.log('mcp-write: all assertions passed');
  } catch (e) {
    console.error(e);
    console.error('--- server log tail ---\n' + log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    server.kill();
    bharag.close();
    await closePool();
  }
})();
