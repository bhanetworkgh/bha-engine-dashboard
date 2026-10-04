/**
 * The Monitoring Twin's recurrence rule (2026-10-04), pinned in process
 * against a real database:
 *
 *   - two incidents of a class on one device are routine: nothing is recorded;
 *   - the third in 7 days is a pattern: one row, one Research Twin job, one event;
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
    );
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
  await incident(FARM, 'dev-b', 'offline', null, 10); // another device: its own pattern
  await rec.sweep();
  assert.equal((await rows(FARM)).length, 0);
  assert.equal((await jobs()).length, 0);
  ok('two incidents in the window (and one older, and one on another device) are not a pattern');

  await incident(FARM, 'dev-a', 'offline', null, 2);
  const first = await rec.sweep();
  assert.equal(first.detected >= 1, true);
  let r = await rows(FARM);
  assert.equal(r.length, 1);
  assert.equal(r[0].job_state, 'opened');
  assert.equal(r[0].incidents, 3);
  assert.equal(r[0].device_id, 'dev-a');
  let j = await jobs();
  assert.equal(j.length, 1);
  assert.equal(j[0].natural_id, r[0].job_id);
  assert.equal(j[0].fields.Status, 'Pending');
  assert.ok(j[0].fields.Question.includes('3 times in the last 7 days'));
  assert.ok(j[0].fields.Question.includes('dev-a'));
  assert.equal((j[0].fields.Context.match(/INC-TEST-/g) || []).length, 3, 'the context lists the three incidents, not the nine-day-old one');
  const ev = (await query(`SELECT detail FROM engine_events WHERE event_type = 'monitoring_recurrence_detected' AND subject_id = $1`, [r[0].pattern_key])).rows;
  assert.equal(ev.length, 1);
  ok('the third incident in 7 days opens one Research Twin job, with the incidents in its context, and one event');

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

  await query(`DELETE FROM engine_monitoring_incidents WHERE farm_id IN ($1, $2)`, [FARM, SIM]);
  await query(`DELETE FROM engine_monitoring_recurrences WHERE farm_id IN ($1, $2)`, [FARM, SIM]);
  await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Monitoring Twin' AND fields->>'Context' LIKE $1`, [`%${FARM}%`]);
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
