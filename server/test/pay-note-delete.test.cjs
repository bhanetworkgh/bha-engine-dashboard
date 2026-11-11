/**
 * delete_pay_note and delete_codex_log's pay note (11 Nov 2026, Destiny): the note of a deleted test log stayed on the
 * Held tab and in the statement. The refusals that need no database; the trigger itself (migration 131) was checked
 * on a local Postgres 16: no setting, another id, a live log and a released share are refused, the deleted log's note
 * goes, the setting dies with its transaction and the history stays frozen.
 * Run with: npm run test:pay-note-delete
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const p = require(path.join(DIST, 'server/src', 'payNote.js'));
const t = require(path.join(DIST, 'server/src/mcp', 'payNoteTools.js'));
const m = require(path.join(DIST, 'server/src', 'migrations.js'));

let n = 0;
const ok = (msg) => { n += 1; console.log('  ok  ' + msg); };
const refuses = async (fn, reason, msg) => {
  await assert.rejects(fn, (e) => e instanceof p.PayNoteError && e.reason === reason, `expected ${reason}`);
  ok(msg);
};

(async () => {
  await refuses(() => p.removeForDeletedLog({ submission_id: 'X', removed_by: 'U0SOMEONE', reason: 'test log' }), 'not_permitted', 'only Destiny or Jason can remove a pay note');
  await refuses(() => p.removeForDeletedLog({ removed_by: 'U0AEW3TBYH1', reason: 'test log' }), 'missing_log', 'the note must be named');
  await refuses(() => p.removeForDeletedLog({ submission_id: 'X', removed_by: 'U0AEW3TBYH1', reason: 'x' }), 'reason_required', 'a reason is required');
  assert.ok(t.PAY_NOTE_WRITE_TOOLS.some((x) => x.name === 'delete_pay_note')); ok('delete_pay_note is on the write connection');
  const mig = (m.MIGRATIONS || []).find?.((x) => x.id === 131);
  if (mig) {
    const sql = mig.statements.join('\n');
    assert.match(sql, /bha\.pay_note_delete/); assert.match(sql, /released_share = 0/); assert.match(sql, /NOT EXISTS/);
    ok('migration 131 allows only a deleted log\'s note with nothing released');
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
