/**
 * Pay notes (9 Nov 2026, Jason's DM 1794237173.152349): what each pay choice resolves to, and the
 * refusals that need no database. Shares of a day, never money.
 *
 *   1. full, half and none resolve to 1 / 0.5 / 0, with the rest held by default and docked on request.
 *   2. A custom share needs credited_share; held defaults to the rest; more than a day is refused.
 *   3. Anything less than full needs a reason tag; a held share a release condition; a dock a reason note.
 *   4. Only Destiny or Jason decide or release; a release needs an https proof link.
 *   5. Statement facts refuse a month that is not YYYY-MM.
 *
 * No database and no network. Run with:  npm run test:pay-note
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

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const refuses = async (fn, reason, m) => {
  await assert.rejects(fn, (e) => e instanceof p.PayNoteError && e.reason === reason, `expected ${reason}`);
  ok(m);
};
const JASON = 'U0A9V97949F';

(async () => {
  assert.deepEqual(p.resolve({ pay_recommendation: 'full' }), { recommendation: 'full', credited: 1, held: 0 }); ok('full is a whole day credited');
  assert.deepEqual(p.resolve({ pay_recommendation: 'half' }), { recommendation: 'half', credited: 0.5, held: 0.5 }); ok('half holds the other half by default');
  assert.deepEqual(p.resolve({ pay_recommendation: 'half', rest: 'dock' }), { recommendation: 'half', credited: 0.5, held: 0 }); ok('half with the rest docked holds nothing');
  assert.deepEqual(p.resolve({ pay_recommendation: 'none' }), { recommendation: 'none', credited: 0, held: 1 }); ok('none holds the whole day by default (LOCAL_ONLY)');
  assert.deepEqual(p.resolve({ pay_recommendation: 'custom', credited_share: '0.25' }), { recommendation: 'custom_fraction', credited: 0.25, held: 0.75 }); ok('custom takes a share and holds the rest');
  assert.deepEqual(p.resolve({ pay_recommendation: 'custom_fraction', credited_share: 0.5, held_share: 0.25 }), { recommendation: 'custom_fraction', credited: 0.5, held: 0.25 }); ok('custom can hold part and dock part');
  assert.throws(() => p.resolve({ pay_recommendation: 'custom_fraction' }), (e) => e.reason === 'missing_share'); ok('custom without a credited share is refused');
  assert.throws(() => p.resolve({ pay_recommendation: 'custom_fraction', credited_share: 0.8, held_share: 0.5 }), (e) => e.reason === 'bad_share'); ok('more than a day is refused');
  assert.throws(() => p.resolve({ pay_recommendation: 'custom_fraction', credited_share: 1.5 }), (e) => e.reason === 'bad_share'); ok('a share above 1 is refused');
  assert.throws(() => p.resolve({ pay_recommendation: 'double' }), (e) => e.reason === 'bad_recommendation'); ok('an unknown recommendation is refused');

  const base = { submission_id: 'X', decided_by: JASON };
  await refuses(() => p.set({ ...base, pay_recommendation: 'half', release_condition: 'first real event is in' }), 'missing_reason_tag', 'half without a reason tag is refused');
  await refuses(() => p.set({ ...base, pay_recommendation: 'none', reason_tag: 'LOCAL_ONLY' }), 'missing_release_condition', 'a held share without a release condition is refused');
  await refuses(() => p.set({ ...base, pay_recommendation: 'none', rest: 'dock', reason_tag: 'RELOG_OLD_WORK' }), 'missing_reason_note', 'a dock without a reason note is refused');
  await refuses(() => p.set({ ...base, pay_recommendation: 'half', reason_tag: 'NOT_A_TAG', release_condition: 'first real event is in' }), 'bad_reason_tag', 'an unknown reason tag is refused');
  await refuses(() => p.set({ submission_id: 'X', decided_by: 'U0BKT6MAW2Y', pay_recommendation: 'full' }), 'not_permitted', 'a builder cannot set a pay note');
  await refuses(() => p.release({ submission_id: 'X', released_by: JASON, proof_link: 'not a link' }), 'missing_proof', 'a release without an https proof link is refused');
  await refuses(() => p.release({ submission_id: 'X', released_by: 'U0AD1V1D65N', proof_link: 'https://x.y' }), 'not_permitted', 'a builder cannot release');
  await refuses(() => p.statementFacts({ month: 'November' }), 'bad_month', 'statement facts need YYYY-MM');

  assert.deepEqual(Object.keys(p.ledgerFields(null)), []); ok('no note lays nothing onto the ledger (counts as a full day)');
  console.log(`pay-note: ${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
