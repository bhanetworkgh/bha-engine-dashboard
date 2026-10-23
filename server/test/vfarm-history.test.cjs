/**
 * Everything vFarm records reaches the dashboard (D5, 24 Oct 2026, migration 91).
 *
 *   1. roverSignals, pure: heartbeat age, runs against the schedule, durations against a budget
 *      only when one is sent, limit hits only when marked, stops with no frame, the upload backlog.
 *   2. Against a local database: a real snapshot carrying history, layout and rover_config is
 *      stored section by section, every reading lands in engine_vfarm_readings, a re-sent window
 *      changes nothing, a changed row is updated, a row naming a farm the snapshot does not list
 *      is refused and counted, a layout item no longer sent is marked gone, the snapshot row
 *      records what was truncated and what failed, and the twin read and read_vfarm_history
 *      return it.
 *
 * Run with:  npm run test:vfarm-history   (needs a LOCAL DATABASE_URL)
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
  const vh = req('vfarmHistory.js');
  const now = Date.parse('2026-10-24T12:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();

  // 1. pure
  let s = vh.roverSignals({
    now,
    rovers: [{ device_id: 'vfarm-rover-01', status: 'online', last_seen_at: ago(1) }],
    runs: [
      { run_id: 'r1', status: 'complete', started_at: ago(120), ended_at: ago(110) },
      { run_id: 'r2', status: 'failed', started_at: ago(60), ended_at: ago(58) },
      { run_id: 'r3', status: 'recording', started_at: ago(2) },
    ],
    stops: [
      { run_id: 'r1', seq: 1, arrived_at: ago(119), left_at: ago(118), snapshot_key: 'k1' },
      { run_id: 'r1', seq: 2, arrived_at: ago(117), left_at: ago(116), snapshot_key: null },
      { run_id: 'r3', seq: 1, arrived_at: ago(1), left_at: null, snapshot_key: null },
    ],
    videos: [{ run_id: 'r1', upload_state: 'pending', created_at: ago(30) }, { run_id: 'r2', upload_state: 'failed', created_at: ago(58) }],
    schedules: [{ device_id: 'vfarm-rover-01', interval_minutes: 240, enabled: true }],
  });
  assert.equal(s.heartbeat_age_s.value[0].age_s, 60);
  assert.deepEqual(s.runs_24h.value, { expected: 6, started: 3, completed: 1, failed: 1, in_progress: 1 });
  assert.equal(s.run_duration_vs_expected.value.median_s, 600);
  assert.equal(s.run_duration_vs_expected.value.expected_s, null);
  assert.match(s.run_duration_vs_expected.note, /not sent by vFarm yet/);
  assert.equal(s.limit_hit_24h.value, null);
  assert.match(s.limit_hit_24h.note, /not sent by vFarm yet/);
  assert.deepEqual(s.stops_without_frame_24h.value, { stops: 2, without_frame: 1 });
  assert.deepEqual(s.upload_backlog.value, { waiting: 1, failed: 1, oldest_age_s: 1800 });
  ok('roverSignals: heartbeat, runs against 6 scheduled, a duration with no budget compared to nothing, limit hits unknown, one stop with no frame, one video waiting 30 min');
  s = vh.roverSignals({ now, rovers: [], runs: [{ run_id: 'r9', status: 'complete', started_at: ago(30), ended_at: ago(10), meta: { time_budget_s: 900, end_reason: 'time budget' } }], stops: [], videos: [], schedules: [] });
  assert.equal(s.run_duration_vs_expected.value.expected_s, 900);
  assert.equal(s.run_duration_vs_expected.value.over_expected, 1);
  assert.equal(s.limit_hit_24h.value, 1);
  assert.equal(s.runs_24h.value.expected, null);
  assert.equal(s.heartbeat_age_s.value, null);
  ok('roverSignals: a run with its budget is compared and its end on the budget counted; no schedule means expected unknown, no rover means no heartbeat');

  // 2. the database
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const sf = req('systemFeeds.js');
  const twin = req('monitoringTwin.js');
  await migrate();
  const clean = async () => {
    await query(`DELETE FROM engine_vfarm_history WHERE farm_id IN ('HIS-A', 'HIS-X') OR source_id LIKE 'his-%'`);
    await query(`DELETE FROM engine_vfarm_readings WHERE farm_id IN ('HIS-A')`);
    for (const t of ['engine_monitoring_incidents', 'engine_monitoring_device_state', 'engine_vfarm_devices', 'engine_vfarm_open_alerts', 'engine_monitoring_watch']) await query(`DELETE FROM ${t} WHERE farm_id IN ('HIS-A')`);
    await query(`DELETE FROM engine_vfarm_farms WHERE farm_id IN ('HIS-A')`);
  };
  await clean();
  const newest = await query(`SELECT max(taken_at) AS t FROM engine_vfarm_snapshots WHERE synthetic = false`);
  let t = Math.max(Date.now() - 4 * 60_000, newest.rows[0].t ? new Date(newest.rows[0].t).getTime() + 1000 : 0);
  const iso = () => { t += 60_000; return new Date(t).toISOString(); };
  const at = iso();
  const base = t;
  const body = (taken, extra = {}) => ({
    schema: 'vfarm.snapshot.v1', taken_at: taken,
    farms: [{ id: 'HIS-A', code: 'his-a', name: 'History test A' }],
    devices: [{ id: 'rover', farm_id: 'HIS-A', status: 'online', device_type: 'rover', last_seen_at: taken }],
    open_alerts: [],
    history: {
      until: taken,
      sections: {
        readings: { since: ago(10), next_since: at, truncated: false, rows: [
          { device_id: 'dht', farm_id: 'HIS-A', reading_ts: new Date(base - 30_000).toISOString(), values: { temperature: { value: 24.5, unit: 'celsius' }, humidity: 61 } },
          { device_id: 'dht', farm_id: 'HIS-A', reading_ts: new Date(base - 27_000).toISOString(), values: { temperature: 24.6 } },
        ] },
        rover_runs: { since: ago(10), next_since: at, truncated: true, rows: [
          { run_id: 'his-run-1', farm_id: 'HIS-A', device_id: 'rover', status: 'recording', started_at: new Date(base - 60_000).toISOString(), at: new Date(base - 60_000).toISOString() },
          { run_id: 'his-run-x', farm_id: 'HIS-X', device_id: 'rover', status: 'recording', at: new Date(t - 60_000).toISOString() },
          { farm_id: 'HIS-A', status: 'recording' },
        ] },
        automation_events: { since: ago(10), next_since: at, truncated: false, rows: [
          { id: 'his-ae-1', farm_id: 'HIS-A', workflow: 'drain', step: 1, channel: 3, state: 'on', at: new Date(base - 40_000).toISOString() },
        ] },
      },
      errors: { device_events: 'statement timeout' },
    },
    layout: {
      zones: [{ id: 'his-z1', farm_id: 'HIS-A', name: 'Room' }],
      locations: [{ id: 'his-l1', farm_id: 'HIS-A', zone_id: 'his-z1', name: 'Rack 1' }],
      sublocations: [{ id: 'his-s1', farm_id: 'HIS-A', location_id: 'his-l1', name: 'Tray A' }, { id: 'his-s2', farm_id: 'HIS-A', location_id: 'his-l1', name: 'Rail' }],
    },
    rover_config: { schedules: [{ device_id: 'rover', farm_id: 'HIS-A', interval_minutes: 240, enabled: true }], settings: [], rail_map: [] },
    ...extra,
  });
  let r = await sf.storeVfarmSnapshot(body(at));
  const h = r.history.sections;
  assert.equal(h.readings.stored_new, 3);
  assert.equal(h.rover_runs.stored_new, 1);
  assert.equal(h.rover_runs.refused, 2);
  assert.equal(h.rover_runs.truncated, true);
  assert.equal(h.automation_events.stored_new, 1);
  assert.equal(h.layout_sublocations.stored_new, 2);
  assert.equal(h.rover_schedules.stored_new, 1);
  assert.equal(r.history.errors.device_events, 'statement timeout');
  const rd = await query(`SELECT count(*)::int AS n FROM engine_vfarm_readings WHERE farm_id = 'HIS-A'`);
  assert.equal(rd.rows[0].n, 3);
  ok('a snapshot with history: 3 metric readings, a run, an automation step, the layout and the schedule stored; a run on an unlisted farm and one with no key refused and counted; the truncation and the failed section kept');

  const at2 = iso();
  const again = body(at2);
  again.history.sections.rover_runs.rows[0] = { ...again.history.sections.rover_runs.rows[0], status: 'complete', ended_at: at2 };
  again.layout.sublocations = again.layout.sublocations.slice(0, 1);
  r = await sf.storeVfarmSnapshot(again);
  assert.equal(r.history.sections.readings.stored_new, 0);
  assert.equal(r.history.sections.readings.unchanged, 3);
  assert.equal(r.history.sections.rover_runs.updated, 1);
  assert.equal(r.history.sections.automation_events.unchanged, 1);
  assert.equal(r.history.sections.layout_sublocations.gone, 1);
  const run = await query(`SELECT row->>'status' AS s FROM engine_vfarm_history WHERE section = 'rover_runs' AND source_id = 'his-run-1'`);
  assert.equal(run.rows[0].s, 'complete');
  ok('the same window again changes nothing; the run that finished is updated; the tray vFarm stopped sending is marked gone, not deleted');

  const snap = await query(`SELECT history FROM engine_vfarm_snapshots WHERE taken_at = $1`, [at]);
  assert.equal(snap.rows[0].history.sections.rover_runs.truncated, true);
  ok('the snapshot row records what each section carried, stored and refused');

  const data = await twin.monitoringData();
  const fa = data.farms.find((f) => f.farm_id === 'HIS-A');
  const secs = Object.fromEntries(fa.feed_history.sections.map((x) => [x.section, x.rows]));
  assert.equal(secs.rover_runs, 1);
  assert.equal(secs.layout_sublocations, 1);
  assert.deepEqual(fa.rover.rover_devices, ['rover']);
  assert.equal(fa.rover.runs_24h.value.expected, 6);
  assert.equal(fa.rover.runs_24h.value.completed, 1);
  ok('the twin read carries the feed history per section and the rover signals');

  const tools = req('mcp/tools.js');
  const tool = tools.TOOLS.find((x) => x.name === 'read_vfarm_history');
  let out = await tool.handler({ section: 'readings', farm_id: 'his-a', limit: 2 }, { access: 'read' });
  assert.equal(out.ok, true);
  assert.equal(out.matched, 3);
  assert.equal(out.returned, 2);
  assert.equal(out.capped, true);
  out = await tool.handler({ section: 'layout_sublocations', farm_id: 'History test A', include_gone: true }, { access: 'read' });
  assert.equal(out.matched, 2);
  out = await tool.handler({ section: 'rover_runs', farm_id: 'no-such-farm' }, { access: 'read' });
  assert.equal(out.rows.length, 0);
  assert.match(out.evidence_status.fallback, /don't hold a farm called/);
  ok('read_vfarm_history: readings by farm code with a cap that says so, gone setup on request, an unknown farm named');

  // A section name that is not one is refused before anything is written.
  await assert.rejects(() => sf.storeVfarmSnapshot({ ...body(iso()), history: { sections: { 'Bad Name': { rows: [] } } } }), /not a section name/);
  ok('a bad section name refuses the whole snapshot, so nothing half-lands');

  await clean();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
