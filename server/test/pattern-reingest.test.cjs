/**
 * A pattern edit is sent to BHARAG again (2026-10-15, D2), in process against a local database
 * with BHARAG stood in.
 *
 *   1. create_record kind patterns keeps the BHARAG id on the row (bharag_doc_id).
 *   2. update_record that changes the text ingests the new copy, removes the old one and keeps
 *      the new id; the answer says so.
 *   3. update_record that changes only a bookkeeping field sends nothing to BHARAG.
 *   4. A pattern made before ids were kept: reingest_pattern finds its old copy by
 *      metadata.pattern_id, replaces it, and saves the id.
 *   5. BHARAG refusing the ingest leaves the old copy alone and the answer says the edit is saved
 *      but BHARAG is stale.
 *
 * Run with:  npm run test:pattern-reingest   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const docs = new Map(); // id -> {title, metadata}
let seq = 0;
let refuseIngest = false;
const bharag = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => (b += c));
  rq.on('end', () => {
    rs.setHeader('content-type', 'application/json');
    const u = new URL(rq.url, 'http://x');
    if (rq.method === 'POST' && u.pathname === '/ingest') {
      if (refuseIngest) { rs.statusCode = 503; return rs.end(JSON.stringify({ error: { message: 'down for the test' } })); }
      const body = JSON.parse(b);
      const id = `doc-${++seq}`;
      docs.set(id, { title: body.title, metadata: body.metadata, content: body.content });
      return rs.end(JSON.stringify({ document_id: id }));
    }
    if (rq.method === 'GET' && u.pathname === '/documents') {
      const list = [...docs.entries()].map(([id, d]) => ({ id, title: d.title, metadata: d.metadata }));
      return rs.end(JSON.stringify({ documents: list, pagination: { hasMore: false } }));
    }
    const del = u.pathname.match(/^\/documents\/(.+)$/);
    if (rq.method === 'DELETE' && del) {
      if (!docs.delete(decodeURIComponent(del[1]))) { rs.statusCode = 404; return rs.end('{}'); }
      return rs.end('{}');
    }
    rs.statusCode = 404;
    rs.end('{}');
  });
});

(async () => {
  await new Promise((r) => bharag.listen(0, '127.0.0.1', r));
  process.env.BHARAG_API_URL = `http://127.0.0.1:${bharag.address().port}`;
  process.env.BHARAG_BUILD_PATTERNS_KEY = 'test-key';
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const mirror = req('mirror.js');
  const w = req('mcp/writeTools.js');
  await migrate();
  const tool = (name) => w.WRITE_TOOLS.find((t) => t.name === name);
  const deps = { access: 'write' };
  const clean = async () => {
    await query(`DELETE FROM engine_build_patterns WHERE fields->>'pattern_name' LIKE 'TESTREINGEST%'`);
    await query(`DELETE FROM engine_mcp_writes WHERE tool IN ('create_record','update_record','reingest_pattern') AND arguments::text LIKE '%TESTREINGEST%'`);
  };
  const rowOf = async (id) => (await query(`SELECT fields FROM engine_build_patterns WHERE id = $1`, [id])).rows[0].fields;
  await clean();
  try {
    /* 1 */
    const c = await tool('create_record').handler({ kind: 'patterns', fields: { pattern_name: 'TESTREINGEST one', bha_system: 'BAYS', problem: 'First problem text.', solution: 'First solution.', context: 'Ctx.' }, drafted_by: 'Destiny' }, deps);
    assert.equal(c.ok, true, JSON.stringify(c));
    const id = c.id;
    const first = (await rowOf(id)).bharag_doc_id;
    assert.ok(first && docs.has(first), 'the created pattern did not keep its BHARAG id');
    ok('create_record keeps the BHARAG id on the pattern row');
    /* 2 */
    const u = await tool('update_record').handler({ kind: 'patterns', id: String(id), fields: { problem: 'Edited problem text.' } }, deps);
    assert.equal(u.ok, true); assert.equal(u.reingested_to_bharag, true, JSON.stringify(u.bharag));
    const second = (await rowOf(id)).bharag_doc_id;
    assert.notEqual(second, first); assert.ok(docs.has(second)); assert.ok(!docs.has(first), 'the old copy is still in BHARAG');
    assert.match(docs.get(second).content, /Edited problem text\./);
    ok('a text edit ingests the new copy, removes the old one and keeps the new id');
    /* 3 */
    const before = docs.size;
    const u2 = await tool('update_record').handler({ kind: 'patterns', id: String(id), fields: { doc_link: 'https://example.org/doc' } }, deps);
    assert.equal(u2.ok, true); assert.equal(u2.reingested_to_bharag, undefined); assert.equal(docs.size, before);
    ok('a bookkeeping-only edit sends nothing to BHARAG');
    /* 4 */
    const legacy = await mirror.upsert('patterns', { fields: { pattern_id: 'BP-TEST-LEGACY-0001', pattern_name: 'TESTREINGEST legacy', problem: 'Old.', solution: 'Old.', context: 'Old.' } }, 'engine');
    docs.set('doc-legacy', { title: 'Build Pattern -- TESTREINGEST legacy -- Bays', metadata: { pattern_id: 'BP-TEST-LEGACY-0001' } });
    const dry = await tool('reingest_pattern').handler({ natural_id: 'BP-TEST-LEGACY-0001', dry_run: true }, deps);
    assert.equal(dry.would_replace, 'doc-legacy'); assert.equal(dry.found_by, 'search'); assert.ok(docs.has('doc-legacy'));
    const r = await tool('reingest_pattern').handler({ natural_id: 'BP-TEST-LEGACY-0001' }, deps);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.old_id, 'doc-legacy'); assert.equal(r.old_found_by, 'search'); assert.equal(r.old_removed, true);
    assert.ok(!docs.has('doc-legacy')); assert.equal((await rowOf(legacy.id)).bharag_doc_id, r.new_id);
    ok('reingest_pattern finds a pre-id copy by pattern_id, replaces it and saves the new id');
    /* 5 */
    refuseIngest = true;
    const held = (await rowOf(id)).bharag_doc_id;
    const u3 = await tool('update_record').handler({ kind: 'patterns', id: String(id), fields: { solution: 'Edited while BHARAG is down.' } }, deps);
    assert.equal(u3.ok, true); assert.equal(u3.saved, true); assert.equal(u3.reingested_to_bharag, false);
    assert.match(u3.bharag.detail, /edit is saved, but BHARAG was not updated/);
    assert.ok(docs.has(held), 'the old copy was removed although no new one went in');
    ok('a refused ingest keeps the edit, leaves the old copy and says BHARAG is stale');
  } finally {
    await clean();
    await query(`DELETE FROM engine_build_patterns WHERE natural_id = 'BP-TEST-LEGACY-0001'`);
    await closePool();
    bharag.close();
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
