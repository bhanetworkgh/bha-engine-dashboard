/**
 * The self-healing scorecard (19 Oct 2026, D2.5), pinned against a local
 * database holding one week of known rows.
 *
 * What this proves, because each is a way the number quoted to a buyer goes wrong:
 *   - manual runs, the healer's own retries and the error handlers' runs are not workload;
 *   - a test and a guard refusal are counted apart, an alarm-raised fault is real;
 *   - an incident fixed two ways (closed self_healed and a recovery re-run) is one fix;
 *   - a healer retry with no incident (RUN-…) is a fix, counted as without an incident;
 *   - a standing repair is matched to its incident by execution id; a reverted one is not a fix;
 *   - a close the ledger did upstream counts as the engine's only where a fix is recorded;
 *   - policy closes stay out of the engine share and are named;
 *   - time to fix is p50/p95, engine and person apart.
 *
 * Run with:  npm run test:self-healing   (local DATABASE_URL only; it empties the tables it reads)
 */
const assert = require('node:assert/strict');

(async () => {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
    console.error('test:self-healing empties the tables it reads, so it only runs against a local DATABASE_URL.');
    process.exit(2);
  }
  const { migrate } = require('../../server-dist/server/src/migrations.js');
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const engineEvents = require('../../server-dist/server/src/engineEvents.js');
  const selfHealing = require('../../server-dist/server/src/selfHealing.js');
  await migrate();
  for (const t of ['engine_incidents', 'engine_execution_runs', 'engine_retry_attempts', 'engine_repairs', 'engine_recovery']) await query(`DELETE FROM ${t}`);
  await query(`DELETE FROM engine_events WHERE event_type IN ('polling_one_off_closed', 'self_healer_routed')`);

  // Last week, so a Monday-morning run never splits the fixture across two weeks.
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const lastWeek = new Date(monday.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const base = monday.getTime() - 3 * 86_400_000 + 12 * 3600_000; // Friday noon of last week
  const at = (min) => new Date(base + min * 60_000).toISOString();

  let n = 0;
  async function run(mode, status) {
    n++;
    await query(`INSERT INTO engine_execution_runs (execution_id, workflow_id, workflow_name, status, mode, day, started_at, first_seen_at, updated_at) VALUES ($1, 'wf', 'W', $2, $3, $4, $5, now(), now())`, [String(800000 + n), status, mode, at(0).slice(0, 10), at(n)]);
  }
  for (let i = 0; i < 10; i++) await run('webhook', 'success');
  await run('webhook', 'error');
  await run('trigger', 'crashed');
  for (let i = 0; i < 3; i++) await run('manual', 'error');
  await run('retry', 'error');
  await run('error', 'success');

  async function inc(id, { wf = 'Bays — Agent Delivery', node = 'Build Card', exec = null, rs = 'open', open = false, resolvedAfter = null, by = null }) {
    await query(
      `INSERT INTO engine_incidents (natural_id, fields, source, first_seen_at, updated_at, open_now, resolved_at, resolved_by)
       VALUES ($1, $2::jsonb, 'engine', $3, now(), $4, $5, $6)`,
      [id, JSON.stringify({ entity_id: id, occurred_at: at(0), resolution_status: rs, payload: { workflow_or_scenario: wf, failed_node_or_component: node, execution_id: exec } }), at(0), open, resolvedAfter === null ? null : at(resolvedAfter), by],
    );
  }
  await inc('INC-A', { rs: 'self_healed', resolvedAfter: 30, by: 'the ledger' });
  await inc('INC-B', { rs: 'manually_resolved', resolvedAfter: 120, by: 'mcp:write (U0AEW3TBYH1) — fixed' });
  await inc('INC-C', { wf: 'Bays — Submit Actions', node: 'Raise Refused Click', resolvedAfter: 5, by: 'mcp:write — guard' });
  await inc('INC-D', { wf: 'TEST — Something', resolvedAfter: 5, by: 'mcp:write — test' });
  await inc('INC-E', { node: 'Raise If Agent Failed', open: true });
  await inc('INC-F', { rs: 'wont_fix', resolvedAfter: 10, by: 'recovery:chat_not_rerun' });
  await inc('INC-G', { resolvedAfter: 60, by: 'the ledger (closed upstream by the healer or a person)' });
  await inc('INC-H', { exec: '5005', resolvedAfter: 90, by: 'the ledger (closed upstream by the healer or a person)' });
  await inc('INC-J', { resolvedAfter: 40, by: 'the ledger (closed upstream by the healer or a person)' });

  const retry = (id, status, minutes) => query(`INSERT INTO engine_retry_attempts (natural_id, fields, source, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', now(), now())`, [id, JSON.stringify({ incident_id: id, status, workflow: 'W', last_attempt_at: at(minutes) })]);
  await retry('INC-G', 'Recovered', 55);
  await retry('RUN-7777', 'Recovered', 200);
  await retry('INC-B', 'Exhausted', 100);
  await query(`INSERT INTO engine_repairs (repair_id, outcome, execution_id, workflow_name, version_after, finished_at) VALUES ('R1', 'repaired', '5005', 'W', 'v2', $1), ('R2', 'repaired', '6006', 'W', 'v3', $1), ('R3', 'needs_human', '6007', 'W', null, $1)`, [at(80)]);
  await query(`UPDATE engine_repairs SET reverted_at = $1 WHERE repair_id = 'R2'`, [at(85)]);
  await query(`INSERT INTO engine_recovery (incident_id, dependency, status, first_seen_at, updated_at) VALUES ('INC-A', 'openrouter', 'recovered', now(), $1)`, [at(25)]);
  await engineEvents.record({ event_type: 'polling_one_off_closed', at: at(300), subject_id: 'INC-I', lane: 'BAYS', actor: 'recovery', detail: { workflow: 'Form A' }, dedupe_key: 'test-one-off-I' });

  const s = await selfHealing.scorecard({ weeks: 2 });
  const w = s.weeks.find((x) => x.week_start === lastWeek);
  assert.ok(w, 'last week is in the window');

  assert.equal(w.runs, 12, 'webhook, trigger and sub-workflow runs only');
  assert.equal(w.failed_runs, 2);
  assert.equal(w.failure_rate.pct, 16.7);

  assert.equal(w.incidents, 9);
  assert.equal(w.real_faults, 7, 'A B E F G H J are real');
  assert.deepEqual(w.counted_apart, { refused_click: 1, test: 1 });
  assert.equal(w.real_faults_raised_by_alarm, 1, 'INC-E');

  assert.equal(w.automatic_fixes.total, 5, 'A once, G, H by execution id, RUN-7777, I');
  assert.equal(w.automatic_fixes.without_incident, 1, 'RUN-7777');
  assert.ok(!s.recent_fixes.some((f) => f.key === 'EXEC-6006'), 'a reverted repair is not a fix');
  assert.ok(s.recent_fixes.some((f) => f.key === 'INC-H' && f.kind === 'repair_standing'), 'the standing repair is matched to its incident');

  assert.deepEqual(w.closed_real_faults, { engine: 3, cleared_itself: 0, person: 1, policy: 1, not_recorded: 1 }, 'J closed upstream with no fix recorded is not recorded');
  assert.equal(w.still_open, 1);

  assert.deepEqual(s.totals.fixed_by_engine_share, { n: 3, of: 4, pct: 75 });
  assert.equal(s.totals.time_to_fix.engine.n, 3);
  assert.equal(s.totals.time_to_fix.engine.p50_minutes, 60);
  assert.equal(s.totals.time_to_fix.engine.p95_minutes, 90);
  assert.equal(s.totals.time_to_fix.person.p50_minutes, 120);
  assert.equal(s.open_real_faults[0].incident_id, 'INC-E');
  assert.match(s.healer_routes.note, /19 Oct 2026/);

  // Pure: the closer rules.
  const none = new Set();
  assert.equal(selfHealing.closerOf({ incident_id: 'x', resolution_status: 'open', resolved_by: 'monitoring-twin (cleared on the next snapshot)', open_now: false }, none), 'cleared_itself');
  assert.equal(selfHealing.closerOf({ incident_id: 'x', resolution_status: 'open', resolved_by: 'recovery (one-off polling error)', open_now: false }, none), 'engine');
  assert.equal(selfHealing.closerOf({ incident_id: 'x', resolution_status: 'open', resolved_by: 'not recorded (closed before 2 Oct 2026)', open_now: false }, none), 'not_recorded');
  assert.equal(selfHealing.closerOf({ incident_id: 'x', resolution_status: 'open', resolved_by: null, open_now: true }, none), null);

  for (const t of ['engine_incidents', 'engine_execution_runs', 'engine_retry_attempts', 'engine_repairs', 'engine_recovery']) await query(`DELETE FROM ${t}`);
  await query(`DELETE FROM engine_events WHERE dedupe_key = 'test-one-off-I'`);
  await closePool();
  console.log('self-healing scorecard: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
