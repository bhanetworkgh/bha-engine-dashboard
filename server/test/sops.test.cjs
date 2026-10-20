/**
 * The SOPs tab on Codex: SOPs read from BHARAG's codex workspace (2026-10-13).
 *
 * No database and no BHARAG: `dataGovernance.js` is replaced in the require
 * cache (bharag.ts imports it for the ingest guard, which this never calls) and
 * BHARAG is a local HTTP stand-in. What is pinned:
 *
 *   - with no BHARAG_CODEX_KEY nothing is asked and the answer names the variable;
 *   - every page is read with the workspace key, and only titles starting "SOP" are kept
 *     ("SOPHISTICATED" is not one), newest first, with source link and requester;
 *   - two SOPs with one title are counted on both;
 *   - a complete read is held; a page failing part-way is ok but `complete: false`
 *     with a note, and is not held;
 *   - one SOP's text is read; a document that is not an SOP, a missing one and a
 *     malformed id are refused with a reason.
 *
 * Run with:  npm run test:sops
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
require.cache[require.resolve(path.join(DIST, 'server/src/dataGovernance.js'))] = {
  id: 'dataGovernance', filename: 'dataGovernance', loaded: true,
  exports: { guard: async () => ({ allow: true }) },
};
// 250 documents, newest first; every 10th is an SOP, two share a title, one is "sop:" lower-case.
const docs = [];
for (let i = 0; i < 250; i++) {
  const sop = i % 10 === 0;
  docs.push({ id: `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`, title: sop ? (i===20||i===30 ? 'SOP -- Same Rule' : i===40 ? 'sop: lower case one' : `SOP -- Rule ${i}`) : `BHA Codex — log ${i}`,
    status: 'indexed', created_at: new Date(Date.UTC(2026,9,12) - i*3600e3).toISOString(), metadata: sop ? { source_link: `https://slack.example/t${i}`, requested_by: 'U0A9V97949F' } : {} });
}
docs.push({ id: '00000000-0000-0000-0000-999999999999', title: 'SOPHISTICATED log', status:'indexed', created_at:'2026-01-01T00:00:00Z' });
let seenKey = null, failAt = null;
const srv = http.createServer((req,res) => {
  seenKey = req.headers['x-api-key'];
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/v1\/documents\/([^/]+)$/);
  res.setHeader('content-type','application/json');
  if (m) { const d = docs.find(x=>x.id===m[1]); if (!d) { res.statusCode=404; return res.end(JSON.stringify({error:{message:'Document not found',code:'NOT_FOUND'}})); }
    return res.end(JSON.stringify({ success:true, document: { ...d, raw_content: u.searchParams.get('include_content')==='true' ? `Body of ${d.title}` : undefined } })); }
  const limit = +u.searchParams.get('limit'), offset = +u.searchParams.get('offset');
  if (failAt !== null && offset >= failAt) { res.statusCode = 500; return res.end(JSON.stringify({error:{message:'boom'}})); }
  const page = docs.slice(offset, offset+limit);
  res.end(JSON.stringify({ success:true, documents: page, pagination:{limit,offset,count:page.length,hasMore:page.length===limit} }));
});
srv.listen(0, async () => {
  process.env.BHARAG_API_URL = `http://127.0.0.1:${srv.address().port}/api/v1`;
  delete process.env.BHARAG_CODEX_KEY;
  let sops = require(path.join(DIST, 'server/src/sops.js'));
  const none = await sops.read({fresh:true});
  assert.equal(none.ok, false); assert.match(none.error, /Neither BHARAG_SOPS_KEY nor BHARAG_CODEX_KEY is set/);
  process.env.BHARAG_CODEX_KEY = 'ws-key';
  const r = await sops.read({fresh:true});
  assert.equal(r.ok, true); assert.equal(r.complete, true); assert.equal(seenKey, 'ws-key'); assert.equal(r.key_variable, 'BHARAG_CODEX_KEY');
  assert.equal(r.documents_scanned, 251); assert.equal(r.pages_read, 3);
  assert.equal(r.sops.length, 25, 'every 10th of 250, and not SOPHISTICATED');
  assert.ok(r.sops.every(s => /^sop/i.test(s.title)));
  assert.equal(r.sops.find(s=>s.title==='SOP -- Same Rule').same_title, 2);
  assert.equal(r.sops[0].title, 'SOP -- Rule 0', 'newest first');
  assert.equal(r.sops[0].source_link, 'https://slack.example/t0');
  assert.equal(r.sops[0].requested_by, 'U0A9V97949F');
  // held: a second read does not walk again
  failAt = 0; const held = await sops.read(); assert.equal(held.ok, true); failAt = null;
  // a page failing part-way is ok but incomplete, and is not held
  failAt = 200; const part = await sops.read({fresh:true});
  assert.equal(part.ok, true); assert.equal(part.complete, false); assert.match(part.note, /stopped answering after 2 pages/);
  failAt = 0; const fail = await sops.read(); assert.equal(fail.ok, false, 'a partial read is not held'); assert.match(fail.error, /could not be read/); failAt = null;
  // the SOP key wins over the codex key when set
  process.env.BHARAG_SOPS_KEY = 'sops-key'; const k = await sops.read({fresh:true}); assert.equal(seenKey, 'sops-key'); assert.equal(k.key_variable, 'BHARAG_SOPS_KEY');
  // doc
  const d = await sops.doc(docs[10].id); assert.equal(d.ok, true); assert.equal(d.sop.content, 'Body of SOP -- Rule 10');
  const notSop = await sops.doc(docs[1].id); assert.equal(notSop.ok, false); assert.equal(notSop.status, 404); assert.match(notSop.reason, /not an SOP/);
  const gone = await sops.doc('00000000-0000-0000-0000-123456789012'); assert.equal(gone.status, 404); assert.match(gone.reason, /no document/);
  const bad = await sops.doc('../etc'); assert.equal(bad.status, 400);
  console.log('sops: 22 checks passed'); srv.close();
});
