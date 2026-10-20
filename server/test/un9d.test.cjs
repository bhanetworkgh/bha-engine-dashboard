/**
 * UN9D acceptance check and the first-real-data notice (2026-10-15, D3).
 *
 *   1. test1/test2/rollUp, pure: a missing place fails, a LIVE device on a silent feed fails,
 *      no silent incident is not_yet_possible, two incidents open at once is a duplicate, and
 *      Engine health disagreeing about a close fails.
 *   2. firstRealData against a local database with the DM stood in: a simulated post sends
 *      nothing; the first real dry run sends one DM; a second real dry run sends nothing; a
 *      failed DM gives the claim back, so the next post tries again.
 *   3. check() on a seeded simulated farm: labelled simulated, NOT_SAFE_TO_CLAIM, and one
 *      un9d_acceptance_checked event recorded.
 *
 * Run with:  npm run test:un9d   (needs a LOCAL DATABASE_URL)
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
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const un9d = req('un9d.js');
  await migrate();
  const now = Date.parse('2026-10-15T12:00:00Z');
  const dev = (id, extra = {}) => ({ device_id: id, place: 'Rack / tier 1', device_type: 'soil', last_reading_at: '2026-10-15T11:59:30.000Z', last_seen_at: '2026-10-15T11:59:30.000Z', snapshot_at: '2026-10-15T11:59:40.000Z', gone: false, state: 'LIVE', ...extra });

  // 1. pure
  const fresh = { snapshot_at: '2026-10-15T11:59:40.000Z', synthetic: false };
  let t = un9d.test1(fresh, [dev('a'), dev('b')], { feed_silent: false, devices: [dev('a', { last_reading_at: '2026-10-15T11:59:30Z' }), dev('b')] }, now);
  assert.equal(t.verdict, 'pass', 'the twin read gives whole seconds; the same instant must agree');
  t = un9d.test1(fresh, [dev('a')], { feed_silent: false, devices: [dev('a', { last_reading_at: '2026-10-15T11:59:31Z' })] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'agreement').verdict, 'fail');
  t = un9d.test1(fresh, [dev('a', { place: null })], { feed_silent: false, devices: [dev('a')] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'placement').verdict, 'fail');
  assert.equal(t.verdict, 'fail');
  const old = { snapshot_at: '2026-10-09T12:50:00.000Z', synthetic: true };
  t = un9d.test1(old, [dev('a')], { feed_silent: true, devices: [dev('a')] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'freshness').verdict, 'fail');
  t = un9d.test1(old, [dev('a', { state: 'NO_FEED' })], { feed_silent: true, devices: [dev('a', { state: 'NO_FEED' })] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'freshness').verdict, 'pass');
  t = un9d.test1(fresh, [dev('a')], { feed_silent: false, devices: [dev('a', { state: 'STALE' })] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'agreement').verdict, 'fail');
  ok('test 1: placement, stale-shown-as-live and disagreement each fail; a silent feed shown as NO_FEED passes');

  // A camera reports presence and never a reading (20 Oct 2026): it has a last report, so observed_time passes.
  t = un9d.test1(fresh, [dev('cam', { last_reading_at: null })], { feed_silent: false, devices: [dev('cam', { last_reading_at: null })] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'observed_time').verdict, 'pass');
  t = un9d.test1(fresh, [dev('ghost', { last_reading_at: null, last_seen_at: null })], { feed_silent: false, devices: [dev('ghost', { last_reading_at: null, last_seen_at: null })] }, now);
  assert.equal(t.conditions.find((c) => c.id === 'observed_time').verdict, 'fail');
  ok('test 1: a presence-only device passes observed_time on its last report; one with neither time fails');

  // Device state follows vFarm's status where it is sent (20 Oct 2026).
  const twin = req('monitoringTwin.js');
  const snap = '2026-10-15T12:00:00.000Z';
  const fr = (r, st, seen) => twin.freshness(r, snap, st, seen).state;
  assert.equal(fr(null, 'online', '2026-10-15T11:59:50Z'), 'LIVE', 'an online camera with no reading is live by presence');
  assert.equal(fr(null, null, null), 'NOT_WIRED', 'no status and no reading is not wired, as before');
  assert.equal(fr(null, 'unknown', null), 'NOT_WIRED');
  assert.equal(fr('2026-10-15T11:59:50Z', 'offline', '2026-10-15T11:56:00Z'), 'OFFLINE', 'vFarm saying offline wins over a recent reading');
  assert.equal(twin.freshness('2026-10-15T11:59:50Z', snap, 'offline', '2026-10-15T11:56:00Z').age_s, 240, 'offline is aged from the last report');
  assert.equal(fr('2026-10-15T11:59:00Z', 'online', snap), 'LIVE');
  assert.equal(fr('2026-10-15T11:55:00Z', 'online', snap), 'STALE', 'a sensor whose readings slow is stale whatever its heartbeat');
  assert.equal(fr('2026-10-15T11:40:00Z', 'online', snap), 'OFFLINE', 'a sensor that stopped reading for 20 min is offline whatever its heartbeat');
  assert.equal(fr('2026-10-15T11:59:00Z', null, null), 'LIVE', 'no status: the reading rule alone, unchanged');
  ok('freshness: offline from status, an online camera live by presence, a reading sensor still aged on its readings');

  assert.equal(un9d.test2([], []).verdict, 'not_yet_possible');
  const inc = (id, dev, o, c, l) => ({ incident_id: id, device_id: dev, kind: 'offline', opened_at: o, closed_at: c, ledger_id: l, ledger_state: l ? (c ? 'closed' : 'open') : 'pending' });
  const good = [inc('I1', 'a', '2026-10-10T00:00:00.000Z', '2026-10-10T00:20:00.000Z', 'L1')];
  assert.equal(un9d.test2(good, [{ natural_id: 'L1', resolved_at: '2026-10-10T00:20:00.000Z', status: 'self_healed' }]).verdict, 'pass');
  const dup = [...good, inc('I2', 'a', '2026-10-10T00:10:00.000Z', '2026-10-10T00:30:00.000Z', 'L2')];
  assert.equal(un9d.test2(dup, [{ natural_id: 'L1', resolved_at: 'x', status: null }, { natural_id: 'L2', resolved_at: 'x', status: null }]).conditions.find((c) => c.id === 'recovers_once').verdict, 'fail');
  assert.equal(un9d.test2(good, [{ natural_id: 'L1', resolved_at: null, status: 'open' }]).conditions.find((c) => c.id === 'downstream_agrees').verdict, 'fail');
  assert.equal(un9d.test2(good, []).conditions.find((c) => c.id === 'downstream_agrees').verdict, 'fail');
  ok('test 2: nothing silent is not_yet_possible; a clean recovery passes; overlap and Engine health disagreeing fail');

  // 2. first real data
  const SIM = 'TEST-UN9D-SIM', REAL = 'TEST-UN9D-REAL';
  const clean = async () => {
    await query(`DELETE FROM meta WHERE key LIKE 'vfarm.first_real.%'`);
    await query(`DELETE FROM engine_events WHERE subject_id IN ($1,$2) OR event_type IN ('vfarm_first_real_data','vfarm_first_real_data_notice_failed')`, [SIM, REAL]);
    await query(`DELETE FROM engine_vfarm_devices WHERE farm_id = $1`, [SIM]);
    await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id = $1`, [SIM]);
    await query(`DELETE FROM engine_incidents WHERE natural_id = 'INC-TEST-UN9D-001'`);
    await query(`DELETE FROM engine_vfarm_farms WHERE farm_id = $1`, [SIM]);
  };
  await clean();
  try {
    await query(`INSERT INTO engine_vfarm_farms (farm_id, name, fields, snapshot_at, updated_at) VALUES ($1, 'Sim', '{"synthetic": true}', '2026-10-09T12:50:00Z', now())`, [SIM]);
    await query(`INSERT INTO engine_vfarm_devices (device_id, farm_id, place, device_type, last_seen_at, last_reading_at, fields, snapshot_at, updated_at) VALUES ('test-un9d-dev', $1, 'Sim rack', 'soil', '2026-10-09T12:49:50Z', '2026-10-09T12:49:50Z', '{}', '2026-10-09T12:50:00Z', now())`, [SIM]);
    const sent = [];
    let fail = false;
    un9d.setDmForTest(async (u, text) => { if (fail) return { ok: false, detail: 'channel_not_found' }; sent.push({ u, text }); return { ok: true, detail: 'sent', ts: '1.1' }; });
    const snap = (farm, syn) => ({ schema: 'vfarm.snapshot.v1', farms: [{ id: farm, ...(syn ? { synthetic: true } : {}) }], devices: [{ id: 'd1', farm_id: farm }, { id: 'd2', farm_id: farm }], open_alerts: [] });
    assert.equal((await un9d.firstRealData('snapshot', snap(SIM, true), 'stored', null)).reason, 'simulated');
    assert.equal((await un9d.firstRealData('alert', { place: { farm_id: SIM }, devices: [{ device_id: 'x' }] }, 'stored', null)).reason, 'simulated');
    assert.equal(sent.length, 0);
    ok('simulated snapshots and alerts on a simulated farm send nothing');

    fail = true;
    assert.equal((await un9d.firstRealData('snapshot', snap(REAL, false), 'dry_run', 'x')).sent, false);
    assert.equal((await query(`SELECT count(*)::int n FROM meta WHERE key = 'vfarm.first_real.dry_run'`)).rows[0].n, 0);
    fail = false;
    const r = await un9d.firstRealData('snapshot', snap(REAL, false), 'dry_run', 'snapshot …: 1 farm(s), 2 device(s)');
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].u, 'U0AEW3TBYH1');
    assert.match(sent[0].text, /dry run/);
    assert.match(sent[0].text, /TEST-UN9D-REAL/);
    assert.match(sent[0].text, /Devices in it: 2/);
    assert.equal((await un9d.firstRealData('snapshot', snap(REAL, false), 'dry_run', 'x')).reason, 'already_sent');
    assert.equal(sent.length, 1);
    const ev = await query(`SELECT count(*)::int n FROM engine_events WHERE event_type = 'vfarm_first_real_data' AND subject_id = $1`, [REAL]);
    assert.equal(ev.rows[0].n, 1);
    ok('a failed DM gives the claim back; the first real dry run DMs Destiny once with farm and device count; the second sends nothing');

    // 3. check on the simulated farm, with one ledgered silent-device incident and Engine health's copy (resolved_at is text there)
    await query(`INSERT INTO engine_monitoring_incidents (incident_id, farm_id, device_id, kind, severity, detail, synthetic, opened_at, closed_at, ledger_id, ledger_state)
                 VALUES ('INC-VFARM-TEST-UN9D', $1, 'test-un9d-dev', 'offline', 'warning', 'test', true, '2026-10-09T12:00:00Z', '2026-10-09T12:20:00Z', 'INC-TEST-UN9D-001', 'closed')`, [SIM]);
    await query(`INSERT INTO engine_incidents (natural_id, fields, source, first_seen_at, updated_at, open_now, resolved_at)
                 VALUES ('INC-TEST-UN9D-001', '{}', 'engine', '2026-10-09T12:00:00Z', '2026-10-09T12:20:00Z', false, '2026-10-09T12:20:00.000Z')`);
    const c = await un9d.check(SIM, { actor: 'test' });
    assert.equal(c.tests[1].conditions.find((x) => x.id === 'downstream_agrees').verdict, 'pass');
    assert.equal(c.tests[1].verdict, 'pass');
    assert.equal(c.simulated, true);
    assert.match(c.claim, /NOT_SAFE_TO_CLAIM/);
    assert.equal(c.tests.length, 2);
    assert.equal(c.recorded, true);
    const ce = await query(`SELECT detail FROM engine_events WHERE event_type = 'un9d_acceptance_checked' AND subject_id = $1`, [SIM]);
    assert.equal(ce.rows.length, 1);
    assert.equal(ce.rows[0].detail.simulated, true);
    await assert.rejects(un9d.check('NO-SUCH-FARM', { record: false }), (e) => e.status === 404);
    ok('check() on a simulated farm says simulated and NOT_SAFE_TO_CLAIM and records one event; an unknown farm is a 404');
  } finally {
    await clean();
    await closePool();
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
