/**
 * The twin envelope (LOOP-1789426955094-3FP4, 2026-10-11), pinned in process
 * against a real database. The Monitoring Twin's read must carry, explicitly:
 * farm_id, cabinet_id, config_hash, burn-in state (not_started / burn_in /
 * passed), worker health (healthy / unhealthy) and the retry envelope
 * (self_healed / retrying / needs_human).
 *
 *   - a farm that sends none of the three identity fields reads null, and says "not sent";
 *   - a farm that sends them reads them; a device falls back to its farm, and its own value wins;
 *   - alert_pipeline.status "ok" is healthy, anything else unhealthy, none sent is null;
 *   - an incident that cleared is self_healed; an open one is retrying; open over an hour,
 *     or one the healer exhausted, needs_human;
 *   - a burn_in_state outside the three is refused with 422 and nothing is written.
 *
 * Run with:  npm run test:twin-envelope   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:twin-envelope writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));

(async () => {
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const twin = req('monitoringTwin.js');
  const feeds = req('systemFeeds.js');
  await migrate();
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ok  ${name}`);
  };

  // Pure rules first.
  assert.equal(twin.burnInState('Burn-In'), 'burn_in');
  assert.equal(twin.burnInState('done'), null);
  assert.equal(twin.workerHealth({ status: 'ok' }).state, 'healthy');
  assert.equal(twin.workerHealth({ status: 'lagging' }).state, 'unhealthy');
  assert.equal(twin.workerHealth(null).state, null);
  const t = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(twin.retryEnvelope({ opened_at: iso(t - 60e3), closed_at: iso(t), close_reason: 'cleared on the next snapshot' }).state, 'self_healed');
  assert.equal(twin.retryEnvelope({ opened_at: iso(t - 60e3), closed_at: null, close_reason: null }, {}, t).state, 'retrying');
  assert.equal(twin.retryEnvelope({ opened_at: iso(t - 2 * 3600e3), closed_at: null, close_reason: null }, {}, t).state, 'needs_human');
  assert.equal(twin.retryEnvelope({ opened_at: iso(t - 60e3), closed_at: null, close_reason: null }, { retry_status: 'Exhausted' }, t).state, 'needs_human');
  assert.equal(twin.retryEnvelope({ opened_at: iso(t - 60e3), closed_at: null, close_reason: null }, { recovery_status: 'failed_again' }, t).state, 'needs_human');
  ok('the three small rules: burn-in words, worker health, the retry envelope');

  const BARE = `TEST-ENV-BARE-${t}`;
  const FULL = `TEST-ENV-FULL-${t}`;
  // Simulated farms, so the test never orders against a real snapshot. Far in the future so it is the newest simulated one.
  const takenAt = iso(t + 365 * 86400e3);
  const snapshot = (extra = {}) => ({
    schema: 'vfarm.snapshot.v1',
    taken_at: takenAt,
    farms: [
      { id: BARE, name: 'Envelope test, bare', synthetic: true },
      { id: FULL, name: 'Envelope test, full', synthetic: true, cabinet_id: 'CAB-P1-001', config_hash: 'sha256:abc123', burn_in_state: 'burn_in', ...extra },
    ],
    devices: [
      { id: `${BARE}-d1`, farm_id: BARE, last_reading_at: takenAt },
      { id: `${FULL}-d1`, farm_id: FULL, last_reading_at: takenAt },
      { id: `${FULL}-d2`, farm_id: FULL, last_reading_at: takenAt, cabinet_id: 'CAB-P1-002', burn_in_state: 'passed' },
    ],
    open_alerts: [],
    alert_pipeline: { status: 'ok', lag: 0, last_processed_age_s: 5 },
  });

  await assert.rejects(() => feeds.storeVfarmSnapshot(snapshot({ burn_in_state: 'almost' })), (e) => e.status === 422 && /burn_in_state "almost"/.test(e.message));
  assert.equal((await query(`SELECT 1 FROM engine_vfarm_farms WHERE farm_id = ANY($1)`, [[BARE, FULL]])).rowCount, 0);
  ok('a fourth burn-in state is refused with 422 and nothing is written');

  try {
    await feeds.storeVfarmSnapshot(snapshot());
    await query(
      `INSERT INTO engine_monitoring_incidents (incident_id, farm_id, device_id, kind, severity, detail, synthetic, opened_at, last_seen_at, closed_at, close_reason)
       VALUES ($1,$2,$3,'offline','warning','test, cleared',true, now() - interval '3 hours', now(), now() - interval '2 hours', 'cleared on the next snapshot'),
              ($4,$2,$3,'offline','warning','test, just opened',true, now() - interval '2 minutes', now(), NULL, NULL),
              ($5,$2,$3,'out_of_range','warning','test, open two hours',true, now() - interval '2 hours', now(), NULL, NULL)`,
      [`INC-TEST-ENV-${t}-1`, FULL, `${FULL}-d1`, `INC-TEST-ENV-${t}-2`, `INC-TEST-ENV-${t}-3`],
    );
    const out = await twin.monitoringData();
    const bare = out.farms.find((f) => f.farm_id === BARE);
    const full = out.farms.find((f) => f.farm_id === FULL);

    assert.deepEqual(out.envelope.fields, ['farm_id', 'cabinet_id', 'config_hash', 'burn_in_state', 'worker_health', 'retry_envelope']);
    for (const k of out.envelope.fields) assert.ok(k in bare.envelope, `bare farm carries ${k}`);
    assert.equal(bare.envelope.cabinet_id, null);
    assert.equal(bare.envelope.config_hash, null);
    assert.equal(bare.envelope.burn_in_state, null);
    assert.match(bare.envelope.sources.cabinet_id, /not sent/);
    ok('a farm that sends no identity carries all six fields, three of them null and saying "not sent"');

    assert.equal(full.envelope.cabinet_id, 'CAB-P1-001');
    assert.equal(full.envelope.config_hash, 'sha256:abc123');
    assert.equal(full.envelope.burn_in_state, 'burn_in');
    assert.equal(full.envelope.worker_health.state, 'healthy');
    ok('a farm that sends them reads them, and the alert worker reads healthy');

    const d1 = full.devices.find((d) => d.device_id === `${FULL}-d1`);
    const d2 = full.devices.find((d) => d.device_id === `${FULL}-d2`);
    assert.equal(d1.cabinet_id, 'CAB-P1-001');
    assert.equal(d1.identity_sources.cabinet_id, 'snapshot (farm)');
    assert.equal(d2.cabinet_id, 'CAB-P1-002');
    assert.equal(d2.burn_in_state, 'passed');
    assert.equal(d2.config_hash, 'sha256:abc123');
    assert.equal(d2.identity_sources.cabinet_id, 'snapshot (device)');
    ok('a device falls back to its farm, and its own value wins');

    const state = (id) => [...full.open_incidents, ...full.recent_incidents].find((i) => i.incident_id === id).retry_envelope.state;
    assert.equal(state(`INC-TEST-ENV-${t}-1`), 'self_healed');
    assert.equal(state(`INC-TEST-ENV-${t}-2`), 'retrying');
    assert.equal(state(`INC-TEST-ENV-${t}-3`), 'needs_human');
    assert.deepEqual(
      { s: full.envelope.retry_envelope.self_healed, r: full.envelope.retry_envelope.retrying, n: full.envelope.retry_envelope.needs_human },
      { s: 1, r: 1, n: 1 },
    );
    ok('each incident carries its retry state, and the farm counts them');
  } finally {
    await query(`DELETE FROM engine_monitoring_incidents WHERE incident_id LIKE $1`, [`INC-TEST-ENV-${t}-%`]);
    await query(`DELETE FROM engine_monitoring_device_state WHERE device_id LIKE $1 OR device_id LIKE $2`, [`${BARE}-%`, `${FULL}-%`]);
    await query(`DELETE FROM engine_vfarm_devices WHERE farm_id = ANY($1)`, [[BARE, FULL]]);
    await query(`DELETE FROM engine_vfarm_farms WHERE farm_id = ANY($1)`, [[BARE, FULL]]);
    await query(`DELETE FROM engine_monitoring_watch WHERE farm_id = ANY($1)`, [[BARE, FULL]]);
    await query(`DELETE FROM engine_vfarm_snapshots WHERE taken_at = $1 AND synthetic`, [takenAt]);
  }
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
