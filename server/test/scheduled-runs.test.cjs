/**
 * The Scheduled runs read (2026-10-09, K9B7), in process against a local database.
 *
 *   1. dueTimes reads a five-field cron in its own time zone: daily, every 3 days, every 6 hours, Saturdays.
 *   2. A due time with a closed row is finished, and carries its start, finish and seconds.
 *   3. A due time whose row is still at started is "started, not finished".
 *   4. A due time with no row is "never started" after the run log began and "no record" before it.
 *   5. A row recorded as failed is failed; a finish-only row from before the log is marked so.
 *   6. A run no due time accounts for (a re-run) is listed as unscheduled, never dropped.
 *   7. A due time inside the grace window is "due soon", not a miss.
 *
 * Run with:  npm run test:scheduled-runs   (needs a LOCAL DATABASE_URL)
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
  const sr = req('scheduledRuns.js');
  await migrate();
  const clean = async () => {
    await query(`DELETE FROM engine_agent_inventory WHERE agent_id = 'TEST-SCHED-AGENT'`);
    await query(`DELETE FROM engine_bays_asks WHERE fields->>'Task Name' LIKE 'TESTSCHED%'`);
  };
  await clean();
  try {
    /* 1 */
    const D = (s) => Date.parse(s);
    // 08:15 New York is 12:15 UTC in October (EDT).
    assert.deepEqual(sr.dueTimes('15 8 * * *', 'America/New_York', D('2026-10-08T00:00:00Z'), D('2026-10-09T23:59:00Z')).map((t) => new Date(t).toISOString()), ['2026-10-08T12:15:00.000Z', '2026-10-09T12:15:00.000Z']);
    assert.equal(sr.dueTimes('0 */6 * * *', 'America/New_York', D('2026-10-09T04:00:00Z'), D('2026-10-10T03:59:00Z')).length, 4);
    assert.deepEqual(sr.dueTimes('0 9 */3 * *', 'America/New_York', D('2026-10-01T00:00:00Z'), D('2026-10-08T00:00:00Z')).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-10-01', '2026-10-04', '2026-10-07']);
    assert.deepEqual(sr.dueTimes('0 8 * * 6', 'America/New_York', D('2026-10-05T00:00:00Z'), D('2026-10-12T00:00:00Z')).map((t) => new Date(t).toISOString()), ['2026-10-10T12:00:00.000Z']);
    assert.deepEqual(sr.dueTimes('not a cron', 'UTC', 0, 60_000), []);
    ok('dueTimes reads daily, every-6-hours, every-3-days and Saturday crons in New York time');

    /* seed: a task due daily at 10:00 UTC, and "now" pinned after the run log began */
    const LOG = Date.parse(sr.RUN_LOG_SINCE);
    const day = 86_400_000;
    const d0 = Math.floor(LOG / day) * day + 3 * day; // a UTC midnight three days after the log began
    const now = d0 + 4 * day + 10 * 3_600_000 + 20 * 60_000; // 10:20 on the fifth day: today's 10:00 is inside the grace window
    await query(
      `INSERT INTO engine_agent_inventory (agent_id, name, tasks, autonomy_tier, tier_reason, read_from, read_at, first_seen_at, updated_at)
       VALUES ('TEST-SCHED-AGENT', 'Test Agent', $1::jsonb, 'T0', 'test', 'test', $2, $2, $2)`,
      [JSON.stringify([{ id: 't1', name: 'TESTSCHED digest (daily 10:00 UTC)', cron: '0 10 * * *', timezone: 'UTC', enabled: true }, { id: 't2', name: 'TESTSCHED off', cron: '0 11 * * *', timezone: 'UTC', enabled: false }]), new Date(now).toISOString()],
    );
    const at = (dayIndex, h, m = 0) => new Date(d0 + dayIndex * day + h * 3_600_000 + m * 60_000).toISOString();
    const put = (id, fields) => query(`INSERT INTO engine_bays_asks (natural_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, $2, $3::jsonb, 'engine', $2, $2)`, [id, fields['Asked At'], JSON.stringify({ 'Ask ID': id, Source: 'scheduled', 'Task Name': 'TESTSCHED digest', ...fields })]);
    // day 0: started and finished. day 1: started only. day 2: nothing. day 3: failed, plus a re-run later the same day.
    await put('TS-0', { 'Asked At': at(0, 10, 0), 'Started At': at(0, 10, 0), 'Finished At': at(0, 10, 2), 'Task Outcome': 'completed', 'Response Seconds': 120.5, Answer: 'Posted.', 'Slack Link': 'https://x/p1' });
    await put('TS-1', { 'Asked At': at(1, 10, 1), 'Started At': at(1, 10, 1), 'Task Outcome': 'started', Answer: 'Started.' });
    await put('TS-3', { 'Asked At': at(3, 10, 0), 'Started At': at(3, 10, 0), 'Finished At': at(3, 10, 1), 'Task Outcome': 'failed', Error: 'Slack refused' });
    await put('TS-3b', { 'Asked At': at(3, 15, 30), 'Task Outcome': 'completed', Answer: 'Re-run by Scheduled Run Watch.' });

    const data = await sr.scheduledRuns(now);
    const mine = data.agent.runs.filter((r) => r.task.startsWith('TESTSCHED'));
    const on = (i) => mine.find((r) => r.due_at === at(i, 10, 0));
    assert.equal(data.agent.tasks.filter((t) => t.task.startsWith('TESTSCHED')).length, 1, 'a disabled task is not on the schedule');

    /* 2 */
    assert.equal(on(0).state, 'finished');
    assert.equal(on(0).started_at, at(0, 10, 0));
    assert.equal(on(0).finished_at, at(0, 10, 2));
    assert.equal(on(0).seconds, 120.5);
    assert.equal(on(0).finish_only, false);
    ok('a due time with a closed row is finished, with its start, finish and seconds');
    /* 3 */
    assert.equal(on(1).state, 'started_not_finished');
    assert.equal(on(1).finished_at, null);
    ok('a row still at started is "started, not finished"');
    /* 4 */
    assert.equal(on(2).state, 'never_started');
    assert.equal(on(2).ask_id, null);
    const early = await sr.scheduledRuns(LOG - 2 * day + 12 * 3_600_000);
    const before = early.agent.runs.filter((r) => r.task.startsWith('TESTSCHED') && r.due_at && Date.parse(r.due_at) < LOG && r.state !== 'due_soon');
    assert.ok(before.length > 0 && before.every((r) => r.state === 'no_record'), 'before the run log a missing row is "no record"');
    ok('no row is "never started" after the run log began and "no record" before it');
    /* 5 */
    assert.equal(on(3).state, 'failed');
    assert.equal(on(3).error, 'Slack refused');
    ok('a row recorded as failed is failed, with its error');
    /* 6 */
    const extra = mine.find((r) => r.ask_id === 'TS-3b');
    assert.equal(extra.state, 'unscheduled');
    assert.equal(extra.due_at, null);
    assert.equal(extra.finish_only, true);
    ok('a run no due time accounts for is listed as unscheduled, and a finish-only row says so');
    /* 7 */
    assert.equal(on(4).state, 'due_soon');
    ok('a due time inside the grace window is "due soon", not a miss');

    assert.ok(Array.isArray(data.timers.list) && data.timers.list.length >= 9);
    assert.ok(data.notes.length >= 4);
    console.log(`\n${n} checks passed.`);
  } catch (e) {
    console.error('\nFAILED:', e);
    process.exitCode = 1;
  } finally {
    await clean();
    await closePool();
  }
})();
