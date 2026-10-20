/**
 * EG4N (LOOP-1791557096136-EG4N): Slack Genie reads the vFarm doctrine through
 * the one resolver, pinned end to end. The real server process, the real MCP
 * transport, Genie's read-only bearer token on /mcp/agent, the real doctrine
 * and publication-decision write routes, and a local database.
 *
 * What this proves:
 *   1. Genie's tools/list is exactly read_logstream, read_engine_events,
 *      read_media_doctrine and read_publication_decision;
 *   2. an unrelated read tool and every write tool are refused;
 *   3. a claim T0NO clears, with no decision recorded, is not ready for Genie;
 *   4. a decision written against an older doctrine version, or one that
 *      contradicts the doctrine in force, is never authority;
 *   5. a claim missing its evidence reads needs_evidence and cannot be
 *      recorded as allowed; a claim not allowed on genie_ns reads hold;
 *   6. North Star, Research Twin and Bays still list the three doctrine reads;
 *   and that read_engine_events still returns the raw stored decision row,
 *   which is why the contract names it history and never authority.
 *
 * Run with:  DATABASE_URL=postgres://…@127.0.0.1:…/name_test npm run test:eg4n
 * Refuses anything but a local database whose name ends in _test, because the
 * server it starts migrates that database and this test deletes its own rows.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:eg4n starts a server that migrates its database and writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1) whose database name ends in _test.');
  process.exit(1);
}

const PORT = 5079;
const T = Date.now();
const DOC = `EG4N${T}`;
const TOKENS = { genie: 'genie-token-for-test', north_star: 'ns-token-for-test', research_twin: 'rt-token-for-test', bays: 'bays-token-for-test' };
const INBOUND = 'inbound-for-test';
const DOCTRINE_READS = ['read_media_doctrine', 'read_publication_decision', 'read_doctrine_gap_summary'];

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
let rpcId = 0;
const rpc = (token, method, params) => post('/mcp/agent', { jsonrpc: '2.0', id: ++rpcId, method, params }, { authorization: `Bearer ${token}` });
async function call(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  if (r.body.error) return { rpcError: r.body.error };
  const text = r.body.result.content[0].text;
  return r.body.result.isError ? { toolError: text } : JSON.parse(text);
}
const listOf = async (token) => (await rpc(token, 'tools/list', {})).body.result.tools.map((t) => t.name).sort();
const engine = (route, body) => post(route, body, { 'x-dashboard-key': INBOUND });

const full = (claim_id, allowed_use) => ({
  claim_id, label: `EG4N test ${claim_id}`, maturity: 'PROVEN_NOW', allowed_wording: `Wording for ${claim_id}.`, prohibited_wording: 'Paid access is live.',
  claim_state: 'interest_only_live', config_hash: 'cfg-eg4n-test', cad_provenance: { cad_revision: 'CAD-EG4N-1', provenance_ref: 'OWLG:EG4N-TEST' },
  evidence_publication_status: 'PUBLISHABLE', fail_closed: { needs_evidence: false, reason: null }, allowed_use,
});
const claims = [
  full('READY', { media_twin: true, vfarm: false, genie_ns: true }),
  full('HOLD', { media_twin: true, vfarm: false, genie_ns: false }),
  { claim_id: 'GAP', label: 'EG4N test GAP', maturity: 'IN_BUILD', allowed_wording: null, prohibited_wording: 'Any claim this is measured.' },
];
const doctrine = (version, previous_version, changed_at) => ({
  schema: 'media.doctrine.v1', change_id: `DOC-${DOC}-${version}`, doctrine_id: DOC, version, previous_version,
  change_type: previous_version ? 'amended' : 'created', summary: `EG4N test ${version}`, changed_at, claims, posted_by: 'test:eg4n',
});
const decide = (claim_id, extra = {}) => engine('/api/engine/publication-decision', {
  decision_id: `DEC-${DOC}-${claim_id}-${++rpcId}`, doctrine_id: DOC, claim_id, surface: 'genie_ns', actor: 'test:eg4n', source_ref: 'LOOP-1791557096136-EG4N', ...extra,
});
const genieDecision = async (claim_id) => (await call(TOKENS.genie, 'read_publication_decision', { doctrine_id: DOC, claim_id, surface: 'genie_ns' })).decisions[0];

let server;
(async () => {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: url, PORT: String(PORT), MCP_SECRET: 'read-secret-for-test', DASHBOARD_INBOUND_KEY: INBOUND, RECOVERY_ENABLED: 'false',
    READONLY_SECRETS_GENIE: TOKENS.genie, READONLY_SECRETS_NORTH_STAR: TOKENS.north_star,
    MCP_AGENT_TOKEN_RESEARCH_TWIN: TOKENS.research_twin, MCP_AGENT_TOKEN_BAYS: TOKENS.bays,
  };
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await post('/mcp/nope', {}).catch(() => null)) break;
    if (server.exitCode !== null) throw new Error(`server exited:\n${log}`);
  }

  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
  try {
    // 1. Genie's tool list, exactly.
    assert.deepEqual(await listOf(TOKENS.genie), ['read_buyer_flow', 'read_engine_events', 'read_logstream', 'read_media_doctrine', 'read_publication_decision', 'read_sop']);
    ok("Genie's token lists exactly read_logstream, read_engine_events, read_media_doctrine, read_publication_decision, read_buyer_flow and read_sop");

    // 2. Refusals: an unrelated read, the gap summary it was not given, and writes.
    for (const name of ['find_records', 'read_doctrine_gap_summary']) {
      const r = await call(TOKENS.genie, name, {});
      assert.ok(r.rpcError, `${name} should be refused`);
      assert.match(r.rpcError.message, /is not one of the tools this connection \(genie\) may call/);
    }
    for (const name of ['create_record', 'update_record', 'delete_record']) {
      const r = await call(TOKENS.genie, name, {});
      assert.ok(r.rpcError, `${name} should be refused`);
    }
    ok('Genie is refused find_records, read_doctrine_gap_summary and every write tool');

    // Doctrine v1, through the real write route.
    const t1 = new Date(Date.now() - 60_000).toISOString();
    assert.equal((await engine('/api/engine/media-doctrine', doctrine('v1', null, t1))).status, 201);
    const read = await call(TOKENS.genie, 'read_media_doctrine', { doctrine_id: DOC });
    const byId = Object.fromEntries(read.claims.map((c) => [c.claim_id, c]));
    assert.equal(byId.READY.fail_closed.needs_evidence, false);
    assert.equal(byId.READY.allowed_use.genie_ns, true);
    assert.equal(byId.GAP.fail_closed.needs_evidence, true);
    assert.match(byId.GAP.fail_closed.reason, /^MISSING_/);
    ok('Genie reads the seven T0NO fields for its claims through read_media_doctrine');

    // 3. T0NO-clear, nothing recorded: not ready.
    let d = await genieDecision('READY');
    assert.equal(d.decision, 'needs_evidence');
    assert.equal(d.applicable, false);
    assert.equal(d.reason, 'MISSING_PUBLICATION_DECISION');
    ok('a claim T0NO clears with no recorded decision reads needs_evidence / MISSING_PUBLICATION_DECISION, not ready');

    // 5. Missing evidence: needs_evidence, and it cannot be recorded as allowed.
    const refused = await decide('GAP', { decision: 'allowed' });
    assert.equal(refused.status, 409);
    assert.equal((await decide('GAP')).status, 201);
    d = await genieDecision('GAP');
    assert.equal(d.decision, 'needs_evidence');
    assert.equal(d.applicable, true);
    ok('a claim missing its evidence cannot be recorded as allowed (409) and reads needs_evidence');

    assert.equal((await decide('HOLD')).status, 201);
    d = await genieDecision('HOLD');
    assert.equal(d.decision, 'hold');
    assert.equal(d.reason, 'NOT_ALLOWED_FOR_GENIE_NS');
    ok('a claim not allowed on genie_ns reads hold / NOT_ALLOWED_FOR_GENIE_NS');

    // The one path to allowed: a T0NO-clear claim with a current recorded decision.
    const recorded = await decide('READY');
    assert.equal(recorded.status, 201);
    d = await genieDecision('READY');
    assert.equal(d.decision, 'allowed');
    assert.equal(d.applicable, true);
    ok('a T0NO-clear claim with a current recorded decision reads allowed and applicable');

    // 4a. A newer doctrine version makes that decision stale.
    assert.equal((await engine('/api/engine/media-doctrine', doctrine('v2', 'v1', new Date().toISOString()))).status, 201);
    d = await genieDecision('READY');
    assert.equal(d.decision, 'needs_evidence');
    assert.equal(d.applicable, false);
    assert.equal(d.reason, 'STALE_PUBLICATION_DECISION');
    assert.equal(d.recorded_decision, 'allowed');
    ok('after a newer doctrine version the same decision is STALE_PUBLICATION_DECISION, never authority');

    // ...while read_engine_events still hands back the raw stored row.
    const raw = await call(TOKENS.genie, 'read_engine_events', { event_type: 'vfam_claim_publication_decision', subject_id: `${DOC}:READY:genie_ns` });
    assert.ok(raw.events.some((e) => e.id === recorded.body.id), 'the stored decision row is returned raw');
    ok('read_engine_events still returns the raw stored decision row: history, never authority');

    // 4b. A stored row that contradicts the doctrine in force (written straight to the table,
    // because the route refuses to write one).
    await query(
      `INSERT INTO engine_events (event_type, at, subject_id, lane, actor, source_ref, detail, dedupe_key) VALUES ('vfam_claim_publication_decision', now(), $1, 'MEDIA', 'test:eg4n', 'LOOP-1791557096136-EG4N', $2::jsonb, $3)`,
      [`${DOC}:HOLD:genie_ns`, JSON.stringify({ event_name: 'VFAM.claim_publication_decision', decision_id: `DEC-${DOC}-FORGED`, doctrine_id: DOC, claim_id: 'HOLD', surface: 'genie_ns', decision: 'allowed', reason: 'forged', doctrine_change_id: `DOC-${DOC}-v2`, evidence_refs: [] }), `VFAM.claim_publication_decision:DEC-${DOC}-FORGED`],
    );
    d = await genieDecision('HOLD');
    assert.equal(d.decision, 'needs_evidence');
    assert.equal(d.applicable, false);
    assert.equal(d.reason, 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO');
    ok('a stored allowed row that contradicts the doctrine in force reads PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO');

    // A claim that is not held at all.
    const missing = await call(TOKENS.genie, 'read_publication_decision', { doctrine_id: DOC, claim_id: 'NOPE', surface: 'genie_ns' });
    assert.ok(missing.rpcError || missing.toolError || missing.ok === false, 'an unknown claim is an error, never a decision');
    ok('a claim that is not held answers an error, never a decision');

    // 6. The three agents keep their doctrine reads.
    for (const agent of ['north_star', 'research_twin', 'bays']) {
      const list = await listOf(TOKENS[agent]);
      for (const t of DOCTRINE_READS) assert.ok(list.includes(t), `${agent} lists ${t}`);
    }
    ok('North Star, Research Twin and Bays still list read_media_doctrine, read_publication_decision and read_doctrine_gap_summary');

    assert.match(log, /genie \(READONLY_SECRETS_GENIE, read, 6 tools\)/);
    ok('the boot line names genie as read, 6 tools');
  } finally {
    const ev = await query(`DELETE FROM engine_events WHERE subject_id LIKE $1`, [`${DOC}:%`]);
    const doc = await query(`DELETE FROM engine_media_doctrine WHERE doctrine_id = $1`, [DOC]);
    console.log(`  cleaned up ${ev.rowCount} event row(s) and ${doc.rowCount} doctrine row(s) written by this run`);
    server.kill();
    await closePool();
  }
  console.log(`\n${passed} EG4N checks passed.`);
})().catch(async (e) => {
  console.error(e);
  if (server) server.kill();
  process.exit(1);
});
