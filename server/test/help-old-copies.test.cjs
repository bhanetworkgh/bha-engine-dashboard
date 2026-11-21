/* A republished help page leaves no older copy in cst-help-manuals (21 Nov 2026). Pure: BHARAG and the
 * event log are stood in. `npm run test:help-old-copies`. */
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.SERVER_DIST || path.join(__dirname, '..', '..', 'server-dist');
const help = require(path.join(dist, 'server', 'src', 'helpPages.js'));
let n = 0;
const ok = (m) => { n++; console.log(`  ok ${n} - ${m}`); };

(async () => {
  // 1. The old copy is removed and proved gone; the kept one is never touched.
  {
    const store = new Set(['NEW', 'OLD1', 'OLD2']);
    const r = await help.retireOldCopies('what-cst-can-do', 'NEW', 'U0AEW3TBYH1', {
      find: async () => ({ ids: [...store], complete: true }),
      remove: async (id) => { store.delete(id); return { ok: true, detail: 'deleted' }; },
      exists: async (id) => store.has(id),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed.sort(), ['OLD1', 'OLD2']);
    assert.ok(store.has('NEW'));
    ok('older copies removed, the new one kept');
  }
  // 2. A delete BHARAG answers ok but the document is still there is a failure, never "removed".
  {
    const r = await help.retireOldCopies('p', 'NEW', 'U0AEW3TBYH1', {
      find: async () => ({ ids: ['NEW', 'STUCK'], complete: true }),
      remove: async () => ({ ok: true, detail: 'deleted' }),
      exists: async () => true,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.removed, []);
    assert.equal(r.failed[0].id, 'STUCK');
    ok('a copy still there after the delete is reported, not counted removed');
  }
  // 3. A workspace not read to the end is never "all removed".
  {
    const r = await help.retireOldCopies('p', 'NEW', 'U0AEW3TBYH1', {
      find: async () => ({ ids: ['NEW'], complete: false }),
      remove: async () => ({ ok: true, detail: '' }),
      exists: async () => false,
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not read to the end/);
    ok('an incomplete read is not a clean result');
  }
  // 4. A list that fails is said, and nothing is deleted.
  {
    let deleted = 0;
    const r = await help.retireOldCopies('p', 'NEW', 'U0AEW3TBYH1', {
      find: async () => { throw new Error('401'); },
      remove: async () => { deleted++; return { ok: true, detail: '' }; },
      exists: async () => false,
    });
    assert.equal(r.ok, false);
    assert.equal(deleted, 0);
    ok('a failed list deletes nothing');
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
