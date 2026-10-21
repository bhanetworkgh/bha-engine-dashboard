/**
 * Only the newest server instance judges the Monitoring Twin (LOOP-1792602989664-YRKG).
 *
 * On 21 Oct 2026, during a Render deploy, the outgoing instance ran one more judging pass
 * under the old relay rule at 14:28:02 UTC and reopened 8 relay incidents the new instance
 * had closed. The advisory lock stopped two passes at once, not an old pass after a new one.
 *
 *   1. mayJudge, pure: no owner, the owner itself, a newer start, and a stale owner judge;
 *      an older instance while the owner is fresh stands down.
 *   2. The overlap, with two real processes against a local database: instance A (older)
 *      judges and opens an incident under rule "old"; instance B (newer) judges under rule
 *      "new" and closes it; A runs once more, as at 14:28:02, and stands down, so the incident
 *      stays closed and no second one is opened.
 *
 * Run with:  npm run test:monitoring-owner   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

// A worker: one server instance. "old" judges the relay on its September reading (offline);
// "new" judges it on presence (live). That is the rule change the deploy carried.
if (process.argv[2] === 'worker') {
  const rule = process.argv[3];
  const twin = req('monitoringTwin.js');
  const { query } = req('pg.js');
  process.on('message', async (msg) => {
    if (msg === 'exit') process.exit(0);
    if (rule === 'old') await query(`UPDATE engine_vfarm_devices SET device_type = 'sensor' WHERE farm_id = 'OWN-TEST' AND device_id = 'relay_1'`);
    else await query(`UPDATE engine_vfarm_devices SET device_type = 'relay' WHERE farm_id = 'OWN-TEST' AND device_id = 'relay_1'`);
    const r = await twin.evaluate('tick');
    process.send({ skipped: r.skipped, opened: r.opened, closed: r.closed });
  });
  process.send('ready');
  return;
}

const start = (rule) => new Promise((resolve) => {
  const c = fork(__filename, ['worker', rule], { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  c.once('message', () => resolve(c));
});
const ask = (c) => new Promise((resolve) => { c.once('message', resolve); c.send('pass'); });

(async () => {
  const twin = req('monitoringTwin.js');
  // 1. pure
  const me = { instance: 'b', started_at: 2000 };
  assert.equal(twin.mayJudge(null, me, 5000).judge, true);
  assert.equal(twin.mayJudge({ instance: 'b', started_at: 2000, last_pass_at: 4000 }, me, 5000).judge, true);
  assert.equal(twin.mayJudge({ instance: 'a', started_at: 1000, last_pass_at: 4900 }, me, 5000).judge, true);
  const old = twin.mayJudge({ instance: 'c', started_at: 3000, last_pass_at: 4900 }, me, 5000);
  assert.equal(old.judge, false);
  assert.match(old.reason, /stands down/);
  assert.equal(twin.mayJudge({ instance: 'c', started_at: 3000, last_pass_at: 5000 - twin.OWNER_STALE_MS - 1 }, me, 5000).judge, true);
  ok('mayJudge: a newer or same instance judges; an older one stands down while the owner is fresh, and takes over after 3 min of silence');

  // 2. the overlap
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  await migrate();
  await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_monitoring_device_state WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_vfarm_devices WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_vfarm_farms WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM meta WHERE key = $1`, [twin.OWNER_KEY]);
  await query(`INSERT INTO engine_vfarm_farms (farm_id, name, snapshot_at, fields) VALUES ('OWN-TEST', 'owner test', now(), '{"synthetic": true}')`);
  await query(
    `INSERT INTO engine_vfarm_devices (farm_id, device_id, device_type, status, last_reading_at, last_seen_at, latest, fields, snapshot_at)
     VALUES ('OWN-TEST', 'relay_1', 'relay', 'online', now() - interval '40 days', now(), '{}', '{}', now())`,
  );

  const a = await start('old');
  await new Promise((r) => setTimeout(r, 50));
  let r = await ask(a);
  assert.equal(r.skipped, null);
  assert.equal(r.opened >= 1, true, 'the old rule opens the relay incident');
  const b = await start('new');
  r = await ask(b);
  assert.equal(r.skipped, null, 'the newer instance judges');
  assert.equal(r.closed >= 1, true, 'the new rule closes it');
  r = await ask(a);
  assert.match(r.skipped || '', /stands down/, 'the older instance stands down');
  const inc = await query(`SELECT closed_at IS NULL AS open FROM engine_monitoring_incidents WHERE farm_id = 'OWN-TEST' AND device_id = 'relay_1'`);
  assert.equal(inc.rows.length, 1, 'no second incident was opened');
  assert.equal(inc.rows[0].open, false, 'the incident stays closed');
  ok('overlap: the old instance opens, the new one closes, the old one runs again and stands down; one incident, still closed');

  r = await ask(b);
  assert.equal(r.skipped, null);
  ok('the newer instance keeps judging');

  a.send('exit');
  b.send('exit');
  await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_monitoring_device_state WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_vfarm_devices WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM engine_vfarm_farms WHERE farm_id = 'OWN-TEST'`);
  await query(`DELETE FROM meta WHERE key = $1`, [twin.OWNER_KEY]);
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
