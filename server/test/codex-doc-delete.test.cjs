/**
 * delete_codex_doc (2026-11-11, Destiny): removes a Codex entry's BHARAG documents, which the Codex page's delete
 * and delete_codex_log leave behind. Pure: BHARAG and the audit table are stood in.
 * Run with: npm run test:codex-doc-delete
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
req('paySync.js');
const bharag = req('bharag.js');
const wt = req('mcp/writeTools.js');
const { deleteCodexDocTool: tool } = req('mcp/sopTools.js');
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const audits = [];
wt.auditOpen = async (a) => { audits.push({ open: a }); return audits.length; };
wt.auditClose = async (id, c) => { audits[id - 1].close = c; };
const held = new Map([['d-1', { id: 'd-1', title: 'BHA Codex — Test', raw_content: 'CODEX\nCodex Entry ID: CODEX-X', metadata: { codex_entry_id: 'CODEX-X' } }]]);
bharag.findByMetadata = async (_k, _m, v) => ({ ids: [...held.values()].filter((d) => d.metadata.codex_entry_id === v).map((d) => d.id), scanned: held.size, complete: true });
bharag.getDocument = async (_ws, id) => held.get(id) ?? null;
bharag.deleteDocument = async (_k, id) => { held.delete(id); return { ok: true, status: 200, detail: 'deleted' }; };
const D = 'U0AEW3TBYH1';
const base = { codex_entry_id: 'CODEX-X', reason: 'test log for the write-door proof', requester_user_id: D };

(async () => {
  let r = await tool.handler(base, { access: 'write', agent: 'bays' });
  assert.equal(r.reason, 'agent_not_permitted'); ok('an agent token is refused');
  r = await tool.handler({ ...base, requester_user_id: 'U0SOMEONE' }, { access: 'write' });
  assert.equal(r.reason, 'not_permitted'); ok('only Destiny or Jason');
  r = await tool.handler({ ...base, codex_entry_id: 'LOOP-1' }, { access: 'write' });
  assert.equal(r.reason, 'bad_entry'); ok('only a CODEX- id');
  r = await tool.handler({ ...base, dry_run: true }, { access: 'write' });
  assert.equal(r.dry_run, true); assert.equal(r.documents.length, 1); assert.ok(held.has('d-1')); ok('a dry run lists the document and removes nothing');
  r = await tool.handler({ ...base, confirm: 'DELETE CODEX-Y' }, { access: 'write' });
  assert.equal(r.reason, 'confirm_required'); assert.ok(held.has('d-1')); ok('a wrong confirm removes nothing');
  r = await tool.handler({ ...base, confirm: 'DELETE CODEX-X' }, { access: 'write' });
  assert.equal(r.ok, true); assert.equal(r.verified_gone, true); assert.ok(!held.has('d-1'));
  assert.equal(audits.at(-1).close.before[0].content, 'CODEX\nCodex Entry ID: CODEX-X'); ok('it removes the document, proves it gone, and keeps its text on the audit line');
  r = await tool.handler({ ...base, confirm: 'DELETE CODEX-X' }, { access: 'write' });
  assert.equal(r.reason, 'not_found'); ok('a second delete finds nothing and says so');
  console.log(`codex-doc-delete: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
