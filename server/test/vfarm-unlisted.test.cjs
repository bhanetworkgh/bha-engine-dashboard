/**
 * A farm or device vFarm stops listing is "not listed", never a silent feed or a recovery (D2, 24 Oct 2026).
 *
 * On 21 Oct 2026 Vfarm_01 left vFarm's snapshot at 06:36 UTC while v-farm kept arriving every three
 * minutes, and the twin held a critical FEED_SILENT incident (INC-BAYS.MONITORING-031) on it for two
 * days. And a device vFarm removes would have closed its OFFLINE incident as "cleared on the next
 * snapshot", which the self-healing scorecard counts as the engine fixing itself.
 *
 *   1. closeReason and retryEnvelope, pure.
 *   2. Against a local database: two real farms, then a real snapshot naming only one. The other is
 *      marked not listed (migration 90), its feed-silent incident closes as not listed, a device the
 *      snapshot dropped closes its offline incident as not listed, nothing new is opened on the
 *      unlisted farm, the read says listed: false with an absent evidence status, and a later
 *      snapshot naming the farm again lists it again.
 *
 * Run with:  npm run test:vfarm-unlisted   (needs a LOCAL DATABASE_URL)
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
  const twin = req('monitoringTwin.js');
  const sf = req('systemFeeds.js');
  const ev = req('vfarmEvidence.js');

  // 1. pure
  const farms = new Set(['F2']);
  const gone = new Set(['F1|dev_gone']);
  assert.equal(twin.closeReason({ farm_id: 'F2', device_id: null }, 'snapshot', farms, gone), twin.NOT_LISTED_FARM);
  assert.equal(twin.closeReason({ farm_id: 'F2', device_id: 'x' }, 'snapshot', farms, gone), twin.NOT_LISTED_FARM);
  assert.equal(twin.closeReason({ farm_id: 'F1', device_id: 'dev_gone' }, 'tick', farms, gone), twin.NOT_LISTED_DEVICE);
  assert.equal(twin.closeReason({ farm_id: 'F1', device_id: 'dev_ok' }, 'snapshot', farms, gone), 'cleared on the next snapshot');
  assert.equal(twin.closeReason({ farm_id: 'F1', device_id: 'dev_ok' }, 'tick', farms, gone), 'cleared on the next check');
  ok('closeReason: a farm or device vFarm stopped listing did not recover; anything else cleared');
  const env = twin.retryEnvelope({ closed_at: '2026-10-24T00:00:00Z', close_reason: twin.NOT_LISTED_DEVICE, opened_at: '2026-10-21T00:00:00Z' }, undefined, Date.parse('2026-10-24T00:01:00Z'));
  assert.equal(env.state, 'not_listed');
  ok('retryEnvelope: a not-listed close is not_listed, never self_healed');

  // 2. the database
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  await migrate();
  const clean = async () => {
    for (const t of ['engine_monitoring_incidents', 'engine_monitoring_device_state', 'engine_vfarm_devices', 'engine_vfarm_open_alerts', 'engine_vfarm_readings', 'engine_monitoring_watch']) {
      await query(`DELETE FROM ${t} WHERE farm_id IN ('UNL-A', 'UNL-B')`);
    }
    await query(`DELETE FROM engine_vfarm_farms WHERE farm_id IN ('UNL-A', 'UNL-B')`);
    await query(`DELETE FROM meta WHERE key = $1`, [twin.OWNER_KEY]);
  };
  await clean();
  // Earlier runs leave newer real snapshots; this run's times must be later than any held.
  const newest = await query(`SELECT max(taken_at) AS t FROM engine_vfarm_snapshots WHERE synthetic = false`);
  let t = Math.max(Date.now() - 4 * 60_000, newest.rows[0].t ? new Date(newest.rows[0].t).getTime() + 1000 : 0);
  const iso = () => { t += 60_000; return new Date(t).toISOString(); };
  const dev = (farm, id, at, extra = {}) => ({ id, farm_id: farm, status: 'online', device_type: 'temp_humidity_sensor', last_seen_at: at, last_reading_at: at, latest: { temperature: { unit: 'celsius', value: 24, status: 'ok' } }, ...extra });

  let at = iso();
  let r = await sf.storeVfarmSnapshot({
    schema: 'vfarm.snapshot.v1', taken_at: at,
    farms: [{ id: 'UNL-A', code: 'unl-a', name: 'Unlisted test A' }, { id: 'UNL-B', code: 'unl-b', name: 'Unlisted test B' }],
    devices: [dev('UNL-A', 'dev_ok', at), dev('UNL-A', 'dev_gone', at, { status: 'offline', last_seen_at: new Date(t - 3_600_000).toISOString(), last_reading_at: new Date(t - 3_600_000).toISOString() }), dev('UNL-B', 'b_dev', at)],
    open_alerts: [],
  });
  assert.equal(r.farms_unlisted, 0);
  await twin.evaluate('snapshot');
  let inc = await query(`SELECT incident_id, kind, device_id FROM engine_monitoring_incidents WHERE farm_id = 'UNL-A' AND closed_at IS NULL`);
  assert.deepEqual(inc.rows.map((x) => [x.kind, x.device_id]), [['offline', 'dev_gone']]);
  // A feed-silent incident on B, as the twin held on Vfarm_01 before this change.
  await query(
    `INSERT INTO engine_monitoring_incidents (incident_id, farm_id, device_id, kind, metric, severity, detail, first_value, last_value, range_min, range_max, stage, synthetic, opened_at, last_seen_at)
     VALUES ('INC-VFARM.FEED-UNLTEST', 'UNL-B', NULL, 'feed_silent', NULL, 'critical', 'test', 700, 700, NULL, 600, NULL, false, now(), now())`,
  );
  ok('setup: two real farms held, an offline device on A, a feed-silent incident on B');

  at = iso();
  r = await sf.storeVfarmSnapshot({
    schema: 'vfarm.snapshot.v1', taken_at: at,
    farms: [{ id: 'UNL-A', code: 'unl-a', name: 'Unlisted test A' }],
    devices: [dev('UNL-A', 'dev_ok', at)],
    open_alerts: [],
  });
  assert.equal(r.devices_gone >= 1, true);
  assert.equal(r.farms_unlisted >= 1, true);
  const fb = await query(`SELECT unlisted_at IS NOT NULL AS unlisted FROM engine_vfarm_farms WHERE farm_id = 'UNL-B'`);
  assert.equal(fb.rows[0].unlisted, true);
  ok('a real snapshot that leaves B out marks B not listed and A\'s dropped device gone');

  // Put B's snapshot far in the past, as Vfarm_01's was: it must still not read as silent.
  await query(`UPDATE engine_vfarm_farms SET snapshot_at = now() - interval '2 days' WHERE farm_id = 'UNL-B'`);
  await twin.evaluate('snapshot');
  const closed = await query(`SELECT incident_id, close_reason FROM engine_monitoring_incidents WHERE farm_id IN ('UNL-A', 'UNL-B') AND closed_at IS NOT NULL ORDER BY incident_id`);
  const reasons = Object.fromEntries(closed.rows.map((x) => [x.incident_id, x.close_reason]));
  assert.equal(reasons['INC-VFARM.FEED-UNLTEST'], twin.NOT_LISTED_FARM);
  const goneInc = closed.rows.find((x) => x.incident_id !== 'INC-VFARM.FEED-UNLTEST');
  assert.equal(goneInc.close_reason, twin.NOT_LISTED_DEVICE);
  const openB = await query(`SELECT count(*)::int AS n FROM engine_monitoring_incidents WHERE farm_id = 'UNL-B' AND closed_at IS NULL`);
  assert.equal(openB.rows[0].n, 0);
  ok('B\'s feed-silent incident and A\'s gone device close as not listed, and nothing new opens on B though its last snapshot is two days old');

  const data = await twin.monitoringData();
  const b = data.farms.find((f) => f.farm_id === 'UNL-B');
  assert.equal(b.listed, false);
  assert.equal(b.feed.silent, false);
  assert.equal(b.devices.every((d) => d.state === 'GONE'), true);
  const es = ev.evidenceStatus(b);
  assert.equal(es.state, 'absent');
  assert.match(es.fallback, /no longer lists/);
  assert.equal(data.farms.find((f) => f.farm_id === 'UNL-A').listed, true);
  ok('the read: B listed false, feed not silent, devices GONE, evidence absent with "no longer lists"; A listed');

  at = iso();
  await sf.storeVfarmSnapshot({
    schema: 'vfarm.snapshot.v1', taken_at: at,
    farms: [{ id: 'UNL-A', code: 'unl-a', name: 'Unlisted test A' }, { id: 'UNL-B', code: 'unl-b', name: 'Unlisted test B' }],
    devices: [dev('UNL-A', 'dev_ok', at), dev('UNL-B', 'b_dev', at)],
    open_alerts: [],
  });
  const back = await query(`SELECT unlisted_at FROM engine_vfarm_farms WHERE farm_id = 'UNL-B'`);
  assert.equal(back.rows[0].unlisted_at, null);
  ok('a snapshot naming B again lists it again');

  await clean();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
