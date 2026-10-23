/**
 * CST test traffic is kept apart from real customers (D8, 24 Oct 2026, migration 92).
 *
 *   1. cstTestReason, pure: test: true, a +1 555 number anywhere on the event, a hand-made turn id;
 *      a Twilio SID or a channel id with a real number is real.
 *   2. Against a local database: the backfill marks rows already held (when this database had not
 *      run migration 92 yet), every new write is marked by the same rule, a delivery for a test turn
 *      is a test row too, and cstData leaves test rows out of every figure while listing them.
 *
 * Run with:  npm run test:cst-test-traffic   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

(async () => {
  const sf = req('systemFeeds.js');
  const SID = 'CA' + 'a'.repeat(32);
  assert.equal(sf.cstTestReason(SID, { phone_e164: '+923001234567' }), null);
  assert.equal(sf.cstTestReason('sms_0f8fad5b-d9cb-469f-a165-70867728950e', { phone_e164: '+14155550123' }), null);
  assert.equal(sf.cstTestReason(SID, { phone_e164: '+15551234567' }), 'a fake +1 555 number');
  assert.equal(sf.cstTestReason('voice_0f8fad5b-d9cb-469f-a165-70867728950e', { customer: { person_id: 'opaque_unresolved_15559999999' } }), 'a fake +1 555 number');
  assert.equal(sf.cstTestReason('SM_PROBE_002', { phone_e164: '+923001234567' }), 'a hand-made turn id, not a Twilio or channel id');
  assert.equal(sf.cstTestReason(SID, { test: true }), 'sent as a test');
  assert.equal(sf.cstTestReason(SID, { phone_e164: '+441555123456789' }), null);
  ok('cstTestReason: test: true, a +1 555 number and a hand-made id are tests; a SID or channel id with a real number is real; 1555 inside a longer number is not');

  const { query, closePool } = req('pg.js');
  const { migrate } = req('migrations.js');
  const col = await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'engine_cst_turns' AND column_name = 'test'`).catch(() => ({ rows: [] }));
  const before = col.rows.length === 0;
  const ids = ['TT_HAND_001', 'CA' + 'b'.repeat(32), 'CA' + 'c'.repeat(32), 'CA' + 'd'.repeat(32), 'CA' + 'e'.repeat(32)];
  const clean = () => query(`DELETE FROM engine_cst_turns WHERE turn_id = ANY($1::text[])`, [ids]).catch(() => undefined);
  await clean();
  if (before) {
    // Rows as they were held before migration 92: no test column yet.
    await query(`INSERT INTO engine_cst_turns (turn_id, status, intent, channel, occurred_at, turn_payload) VALUES ('TT_HAND_001', 'ok', 'status', 'sms', now(), '{"phone_e164": "+923001234567"}')`);
    await query(`INSERT INTO engine_cst_turns (turn_id, status, intent, channel, occurred_at, turn_payload) VALUES ($1, 'ok', 'status', 'sms', now(), '{"phone_e164": "+15550001111"}')`, [ids[1]]);
  }
  await migrate();
  if (before) {
    const b = await query(`SELECT turn_id, test, test_reason FROM engine_cst_turns WHERE turn_id = ANY($1::text[]) ORDER BY turn_id`, [ids]);
    const m = Object.fromEntries(b.rows.map((r) => [r.turn_id, r]));
    assert.equal(m.TT_HAND_001.test, true);
    assert.match(m.TT_HAND_001.test_reason, /hand-made/);
    assert.equal(m[ids[1]].test, true);
    assert.match(m[ids[1]].test_reason, /555/);
    ok('the backfill marks a hand-made id and a +1 555 row held before migration 92');
  } else {
    ok('migration 92 already applied here; the backfill was not re-checked (the rule is the same one checked above)');
  }
  await clean();

  const turn = (turn_id, phone, extra = {}) => ({ schema: 'cst.event.v1', event_type: 'cst.turn', turn_id, channel: 'sms', status: 'ok', intent: 'status', occurred_at: new Date().toISOString(), message: 'status', reply: 'ok', duration_ms: 900, phone_e164: phone, ...extra });
  await sf.storeCst({ events: [turn(ids[2], '+923001234567'), turn(ids[3], '+15551234567'), turn(ids[4], '+923001234567', { test: true })] });
  await sf.storeCst({ schema: 'cst.event.v1', event_type: 'cst.delivery', turn_id: ids[3], status: 'delivered', at: new Date().toISOString(), phone_e164: '+15551234567' });
  const r = await query(`SELECT turn_id, test, test_reason FROM engine_cst_turns WHERE turn_id = ANY($1::text[]) ORDER BY turn_id`, [ids]);
  const m = Object.fromEntries(r.rows.map((x) => [x.turn_id, x]));
  assert.equal(m[ids[2]].test, false);
  assert.equal(m[ids[3]].test, true);
  assert.equal(m[ids[4]].test, true);
  assert.equal(m[ids[4]].test_reason, 'sent as a test');
  ok('new writes are marked by the same rule; a real SID with a real number stays real');

  const d = await sf.cstData();
  const listed = d.turns.filter((t) => ids.includes(t.turn_id));
  assert.equal(listed.length, 3);
  assert.equal(listed.filter((t) => t.test).length, 2);
  assert.ok(d.meta.test_rows >= 2);
  const realIds = new Set(d.turns.filter((t) => t.status !== null && !t.test).map((t) => t.turn_id));
  assert.equal(realIds.has(ids[2]), true);
  assert.equal(realIds.has(ids[3]), false);
  assert.equal(d.summary.turns, realIds.size);
  ok('cstData lists test rows, marks them, and counts only the real turns');

  await clean();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
