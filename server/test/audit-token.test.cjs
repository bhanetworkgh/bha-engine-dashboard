/**
 * Hardik's look-only audit key (22 Oct 2026). Starts the real server against a LOCAL _test database
 * and checks over MCP: the key lists exactly its ten read tools, every write tool and every read
 * outside the list is refused, and query_postgres answers but cannot write.
 * Run with:  npm run test:audit-token   (after the server build; needs a local _test DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test$/.test(new URL(url).pathname)) {
  console.error('test:audit-token starts a server that migrates its database, so it only runs against a local DATABASE_URL whose name ends in _test.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const PORT = 5083;
const TOKEN = 'audit-token-for-test';
const WRITE = 'write-secret-for-test';
const EXPECTED = ['describe_schema', 'get_health', 'get_page_data', 'get_page_structure', 'list_pages', 'query_postgres', 'read_buyer_flow', 'read_engine_events', 'read_sop', 'search_logs'];

function post(pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
let id = 0;
const viaPath = (method, params) => post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: ++id, method, params });
const viaBearer = (method, params) => post('/mcp/agent', { jsonrpc: '2.0', id: ++id, method, params }, { authorization: `Bearer ${TOKEN}` });

let server;
(async () => {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_PATH: process.env.NODE_PATH || '',
    DATABASE_URL: url, PORT: String(PORT), MCP_SECRET: WRITE, MCP_WRITE_TOKEN: WRITE, DASHBOARD_INBOUND_KEY: 'inbound-for-test', RECOVERY_ENABLED: 'false',
    READONLY_SECRETS_HARDIK_AUDIT: TOKEN,
  };
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(DIST, 'server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await post('/mcp/nope', {}).catch(() => null)) break;
    if (server.exitCode !== null) throw new Error(`server exited:\n${log}`);
  }
  let n = 0;
  const ok = (m) => { n += 1; console.log('  ok  ' + m); };
  try {
    for (const rpc of [viaPath, viaBearer]) {
      const names = (await rpc('tools/list', {})).body.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, EXPECTED);
    }
    ok('the key lists exactly its ten read tools, as a connector URL and as a bearer token');

    const writeList = (await post(`/mcp/${WRITE}`, { jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })).body.result.tools.map((t) => t.name);
    assert.ok(writeList.includes('create_record'), 'the shared URL still carries the write tools');
    for (const name of ['create_record', 'update_record', 'delete_record', 'write_media_post_log', 'close_incidents', 'log_sop', 'find_records', 'read_slack']) {
      const r = await viaPath('tools/call', { name, arguments: {} });
      assert.ok(r.body.error, `${name} should be refused`);
    }
    ok('every write tool, and every read outside the ten, is refused on the key (the shared URL keeps its write tools)');

    const q = await viaPath('tools/call', { name: 'query_postgres', arguments: { sql: 'SELECT max(id) AS last FROM schema_migrations' } });
    assert.ok(!q.body.result.isError, q.body.result.content[0].text);
    assert.ok(JSON.parse(q.body.result.content[0].text).rows[0].last >= 88);
    const w = await viaPath('tools/call', { name: 'query_postgres', arguments: { sql: 'DELETE FROM engine_events' } });
    assert.ok(w.body.result.isError || /refused|only|SELECT/i.test(w.body.result.content[0].text), 'a write through query_postgres is refused');
    ok('query_postgres answers a SELECT and refuses anything else');

    assert.match(log, /hardik_audit \(READONLY_SECRETS_HARDIK_AUDIT, read, 10 tools\)/);
    ok('the boot line names hardik_audit as read, 10 tools');
  } finally {
    server.kill();
  }
  console.log(`\n${n} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  if (server) server.kill();
  process.exit(1);
});
