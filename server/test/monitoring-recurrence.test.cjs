/**
 * The Monitoring Twin's recurrence rule (2026-10-04), pinned in process
 * against a real database:
 *
 *   - a pattern is subsystem + place (the farm) + incident class (Canon v1, 4 Oct);
 *   - two incidents of a class on one farm are routine: nothing is recorded;
 *   - the third in 7 days, on any device of that farm, is a pattern: one row,
 *     one Research Twin job, one event;
 *   - an incident the healer or the recovery watcher closed does not count;
 *   - a feed that goes silent on a real farm opens one incident and closes it;
 *   - a second pass, and a fourth incident, open no second job;
 *   - an incident older than 7 days does not count;
 *   - a simulated farm's pattern is recorded and opens no job.
 *
 * Run with:  npm run test:monitoring-recurrence   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:monitoring-recurrence writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));

(async () => {
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const rec = req('monitoringRecurrence.js');
  await migrate();

  const T = Date.now();
  const FARM = `TEST-FARM-${T}`;
  const SIM = `TEST-SIM-${T}`;
  let n = 0;
  const incident = (farm, device, kind, metric, agoHours, synthetic = false) =>
    query(
      `INSERT INTO engine_monitoring_incidents (incident_id, farm_id, device_id, kind, metric, severity, detail, synthetic, opened_at, last_seen_at, closed_at, close_reason)
       VALUES ($1, $2, $3, $4, $5, 'warning', $6, $7, now() - ($8 || ' hours')::interval, now(), now() - ($8 || ' hours')::interval + interval '1 minute', 'cleared on the next snapshot')`,
      [`INC-TEST-${T}-${++n}`, farm, device, kind, metric, `test incident ${n}`, synthetic, String(agoHours)],
    ).then(() => `INC-TEST-${T}-${n}`);
  const rows = async (farm) => (await query(`SELECT * FROM engine_monitoring_recurrences WHERE farm_id = $1 ORDER BY id`, [farm])).rows;
  const jobs = async () => (await query(`SELECT natural_id, fields FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Monitoring Twin' AND fields->>'Context' LIKE $1`, [`%${FARM}%`])).rows;
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ok  ${name}`);
  };

  await incident(FARM, 'dev-a', 'offline', null, 50);
  await incident(FARM, 'dev-a', 'offline', null, 30);
  await incident(FARM, 'dev-a', 'offline', null, 24 * 9); // nine days ago: outside the window
  await incident(FARM, 'dev-b', 'out_of_range', 'humidity', 10); // another incident class: its own pattern
  // A third offline, but one the recovery watcher closed: it does not count.
  const healed = await incident(FARM, 'dev-a', 'offline', null, 20);
  await query(`UPDATE engine_monitoring_incidents SET ledger_id = $2 WHERE incident_id = $1`, [healed, `INC-TEST-LEDGER-${T}`]);
  await query(
    `INSERT INTO engine_recovery (incident_id, dependency, status, first_seen_at, updated_at) VALUES ($1, 'bharag', 'recovered', now()::text, now()::text)`,
    [`INC-TEST-LEDGER-${T}`],
  );
  await rec.sweep();
  assert.equal((await rows(FARM)).length, 0);
  assert.equal((await jobs()).length, 0);
  ok('two incidents in the window are not a pattern: one older, one of another class and one the recovery watcher closed do not count');

  await incident(FARM, 'dev-b', 'offline', null, 2); // another device, same farm, same class
  const first = await rec.sweep();
  assert.equal(first.detected >= 1, true);
  let r = await rows(FARM);
  assert.equal(r.length, 1);
  assert.equal(r[0].job_state, 'opened');
  assert.equal(r[0].incidents, 3);
  assert.equal(r[0].subsystem, 'MONITORING');
  assert.equal(r[0].pattern_key, `MONITORING|${FARM}|offline`);
  assert.deepEqual([...r[0].device_ids].sort(), ['dev-a', 'dev-b']);
  assert.equal(r[0].device_id, null, 'no single device: the pattern spans two');
  let j = await jobs();
  assert.equal(j.length, 1);
  assert.equal(j[0].natural_id, r[0].job_id);
  assert.equal(j[0].fields.Status, 'Pending');
  assert.ok(j[0].fields.Question.includes('3 times in the last 7 days'));
  assert.ok(j[0].fields.Question.includes('dev-a') && j[0].fields.Question.includes('dev-b'));
  assert.ok(j[0].fields.Context.includes('Subsystem: MONITORING') && j[0].fields.Context.includes('Product: vFarm'));
  assert.equal((j[0].fields.Context.match(/INC-TEST-/g) || []).length, 3, 'the context lists the three incidents, not the nine-day-old one or the recovered one');
  const ev = (await query(`SELECT detail FROM engine_events WHERE event_type = 'monitoring_recurrence_detected' AND subject_id = $1`, [r[0].pattern_key])).rows;
  assert.equal(ev.length, 1);
  ok('the third incident in 7 days on the farm, on any device, opens one Research Twin job with the incidents in its context, and one event');

  await rec.sweep();
  await incident(FARM, 'dev-a', 'offline', null, 1);
  await rec.sweep();
  r = await rows(FARM);
  assert.equal(r.length, 1, 'still one pattern row');
  assert.equal(r[0].incidents, 4, 'its count follows the incidents');
  assert.equal((await jobs()).length, 1, 'never a second job for the same pattern');
  ok('a second pass and a fourth incident raise the count and open no second job');

  for (const h of [5, 4, 3]) await incident(SIM, 'sim-a', 'out_of_range', 'humidity', h, true);
  const before = (await query(`SELECT count(*)::int AS n FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Monitoring Twin'`)).rows[0].n;
  await rec.sweep();
  r = await rows(SIM);
  assert.equal(r.length, 1);
  assert.equal(r[0].job_state, 'not_opened_simulated');
  assert.equal(r[0].job_id, null);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Monitoring Twin'`)).rows[0].n, before);
  ok('a simulated farm’s pattern is recorded and opens no job');

  const shown = await rec.recent();
  assert.ok(shown.patterns.some((p) => p.farm_id === FARM && p.job_state === 'opened'));
  assert.ok(shown.rule.includes('3 or more times in 7 days'));
  ok('the read shows the rule and the patterns');

  // A real farm whose snapshots stop: one feed_silent incident, closed when a snapshot arrives.
  const twin = req('monitoringTwin.js');
  const REAL = `TEST-REAL-${T}`;
  await query(`INSERT INTO engine_vfarm_farms (farm_id, name, fields, snapshot_at) VALUES ($1, 'Test real farm', '{}'::jsonb, now() - interval '11 minutes')`, [REAL]);
  await twin.evaluate('tick');
  await twin.evaluate('tick');
  let fs = (await query(`SELECT kind, device_id, severity, synthetic, closed_at FROM engine_monitoring_incidents WHERE farm_id = $1`, [REAL])).rows;
  assert.equal(fs.length, 1, 'one incident, however many checks see the silence');
  assert.equal(fs[0].kind, 'feed_silent');
  assert.equal(fs[0].device_id, null);
  assert.equal(fs[0].severity, 'critical');
  assert.equal(fs[0].closed_at, null);
  await query(`UPDATE engine_vfarm_farms SET snapshot_at = now() WHERE farm_id = $1`, [REAL]);
  await twin.evaluate('snapshot');
  fs = (await query(`SELECT closed_at, close_reason FROM engine_monitoring_incidents WHERE farm_id = $1`, [REAL])).rows;
  assert.equal(fs.length, 1);
  assert.ok(fs[0].closed_at, 'closed when a snapshot arrives');
  ok('a real farm whose feed goes silent for over 10 minutes opens one feed_silent incident, and a new snapshot closes it');
  await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id = $1`, [REAL]);
  await query(`DELETE FROM engine_monitoring_watch WHERE farm_id = $1`, [REAL]);
  await query(`DELETE FROM engine_vfarm_farms WHERE farm_id = $1`, [REAL]);
  await query(`DELETE FROM engine_recovery WHERE incident_id = $1`, [`INC-TEST-LEDGER-${T}`]);

  await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id IN ($1, $2)`, [FARM, SIM]);
  await query(`DELETE FROM engine_monitoring_recurrences WHERE farm_id IN ($1, $2)`, [FARM, SIM]);
  await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Monitoring Twin' AND fields->>'Context' LIKE $1`, [`%${FARM}%`]);
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
