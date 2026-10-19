/**
 * The weekly engine health report (19 Oct 2026, D2.7).
 *
 * Pins the arithmetic a reader will quote (the reduction, the change, the week labels) and that a
 * report builds on a local database whatever it holds, says when SOPs could not be read rather than
 * printing nought, and names every builder and agent with what each figure is out of.
 *
 * Run with:  npm run test:health-report   (local DATABASE_URL only)
 */
const assert = require('node:assert/strict');

(async () => {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
    console.error('test:health-report only runs against a local DATABASE_URL.');
    process.exit(2);
  }
  const { migrate } = require('../../server-dist/server/src/migrations.js');
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const hr = require('../../server-dist/server/src/healthReport.js');
  await migrate();

  assert.equal(hr.reduction(3.1, 0.3), 90.3);
  assert.equal(hr.reduction(0, 0.3), null, 'no base, no reduction');
  assert.equal(hr.change(10, 15), 50);
  assert.equal(hr.change(0, 4), null);
  assert.equal(hr.weekLabel('2026-09-21'), '21 to 27 Sep');
  assert.equal(hr.weekLabel('2026-09-28'), '28 Sep to 4 Oct');
  assert.equal(hr.pct(1, 3), 33.3);

  // One builder's log and loops in the week before 19 Oct, so the per-person lines have something to say.
  await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TEST-HR-%'`);
  await query(`DELETE FROM engine_loops WHERE natural_id LIKE 'LOOP-TEST-HR-%'`);
  await query(`INSERT INTO engine_codex_submissions (natural_id, builder_id, fields, source, first_seen_at, updated_at, created_time)
               VALUES ('TEST-HR-1', 'kavin', '{"Jason Status":"Approved","Timestamp":"2026-10-14T10:00:00Z"}', 'engine', now(), now(), '2026-10-14T10:00:00Z'),
                      ('TEST-HR-2', 'kavin', '{"Jason Status":"Pending","Timestamp":"2026-10-15T10:00:00Z"}', 'engine', now(), now(), '2026-10-15T10:00:00Z')`).catch((e) => { throw new Error('seed codex: ' + e.message); });
  await query(`INSERT INTO engine_loops (natural_id, builder_id, fields, source, first_seen_at, updated_at, created_time)
               VALUES ('LOOP-TEST-HR-1', 'kavin', '{"Status":"Open","Date Raised":"2026-10-13"}', 'engine', now(), now(), now()),
                      ('LOOP-TEST-HR-2', 'kavin', '{"Status":"Closed","Date Raised":"2026-10-13"}', 'engine', now(), now(), now())`).catch((e) => { throw new Error('seed loops: ' + e.message); });

  const r = await hr.build({ now: '2026-10-19T06:00:00Z' });
  assert.equal(r.ok, true);
  assert.equal(r.data.period.week, '2026-10-12');
  assert.equal(r.data.period.label, '12 to 18 Oct');
  assert.equal(r.data.period.weeks.length, 4, 'four full weeks since 21 Sep');
  const k = r.data.logs.find((b) => b.builder === 'Kavin');
  assert.ok(k && k.submitted >= 2 && k.last_week >= 2, 'Kavin is counted by when the logs were submitted');
  assert.match(r.slack_text, /Kavin: \d+ submitted, \d+ approved \(/);
  const kl = r.data.loops.find((b) => b.builder === 'Kavin');
  assert.ok(kl && kl.open >= 1 && kl.closed >= 1);
  assert.match(r.slack_text, /\*4\. Open loops, per person\*/);
  assert.match(r.slack_text, /SOPs: /);
  assert.match(r.slack_text, /\*7\. Week by week\*\n• 21 to 27 Sep:/);
  assert.doesNotMatch(r.slack_text, /Open incidents/i, 'the report does not list open incidents');
  assert.ok(r.slack_text.length < 12000, 'fits one Slack message');

  await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TEST-HR-%'`);
  await query(`DELETE FROM engine_loops WHERE natural_id LIKE 'LOOP-TEST-HR-%'`);
  await closePool();
  console.log('health report: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
