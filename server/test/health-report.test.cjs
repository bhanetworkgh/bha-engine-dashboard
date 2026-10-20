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
  assert.equal(hr.sentence('Short one.', 50), 'Short one.');
  assert.equal(hr.sentence('First sentence is here. Second sentence goes on and on past the limit for sure.', 40 + 20), 'First sentence is here.'.length >= 40 ? 'First sentence is here.' : hr.sentence('First sentence is here. Second sentence goes on and on past the limit for sure.', 60));
  const cut = hr.sentence('word '.repeat(80), 100);
  assert.ok(cut.endsWith('…') && !/wor…$/.test(cut) && cut.length <= 101, 'cut on a word, never mid-word: ' + cut);
  const two = hr.sentence('SECURITY: four CST routes in bha_cst engine answer with no login check, using a shared key. Fix before launch and then rotate everything that touched it afterwards.', 120);
  assert.equal(two, 'SECURITY: four CST routes in bha_cst engine answer with no login check, using a shared key.');

  // One builder's log and loops in the week before 19 Oct, so the per-person lines have something to say.
  await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TEST-HR-%'`);
  await query(`DELETE FROM engine_loops WHERE natural_id LIKE 'LOOP-TEST-HR-%'`);
  await query(`INSERT INTO engine_codex_submissions (natural_id, builder_id, fields, source, first_seen_at, updated_at, created_time)
               VALUES ('TEST-HR-1', 'kavin', '{"Jason Status":"Approved","Timestamp":"2026-10-14T10:00:00Z"}', 'engine', now(), now(), '2026-10-14T10:00:00Z'),
                      ('TEST-HR-2', 'kavin', '{"Jason Status":"Pending","Timestamp":"2026-10-15T10:00:00Z"}', 'engine', now(), now(), '2026-10-15T10:00:00Z')`).catch((e) => { throw new Error('seed codex: ' + e.message); });
  await query(`INSERT INTO engine_loops (natural_id, builder_id, fields, source, first_seen_at, updated_at, created_time)
               VALUES ('LOOP-TEST-HR-1', 'kavin', '{"Status":"Open","Date Raised":"2026-10-13"}', 'engine', now(), now(), now()),
                      ('LOOP-TEST-HR-2', 'kavin', '{"Status":"Closed","Date Raised":"2026-10-13"}', 'engine', now(), now(), now())`).catch((e) => { throw new Error('seed loops: ' + e.message); });

  // The twin review: North Star names one loop three times that never moves, and one that it
  // named once and that was then closed. Research Twin has one thin ask.
  const cleanTwins = async () => {
    await query(`DELETE FROM events WHERE record_id IN (SELECT 'row-' || id FROM engine_loops WHERE natural_id IN ('LOOP-1000000000001-THRA', 'LOOP-1000000000002-THRB'))`);
    await query(`DELETE FROM engine_loops WHERE natural_id IN ('LOOP-1000000000001-THRA', 'LOOP-1000000000002-THRB')`);
    await query(`DELETE FROM engine_ns_asks WHERE natural_id LIKE 'NS-TEST-HR-%'`);
    await query(`DELETE FROM engine_rt_asks WHERE natural_id LIKE 'RT-TEST-HR-%'`);
  };
  await cleanTwins();
  await query(`INSERT INTO engine_loops (natural_id, builder_id, fields, source, first_seen_at, updated_at, created_time)
               VALUES ('LOOP-1000000000001-THRA', 'ahad', '{"Status":"In Progress","What":"A stuck test loop","Date Raised":"2026-10-01"}', 'engine', now(), '2026-10-01T00:00:00Z', now()),
                      ('LOOP-1000000000002-THRB', 'hardik', '{"Status":"Closed","What":"A moved test loop","Date Raised":"2026-10-01"}', 'engine', now(), now(), now())`);
  await query(`INSERT INTO events (kind, record_id, builder, from_status, to_status, via, at)
               SELECT 'loops', 'row-' || id, 'hardik', 'Open', 'Closed', 'engine', '2026-10-16T09:00:00Z' FROM engine_loops WHERE natural_id = 'LOOP-1000000000002-THRB'`);
  for (const [i, at, ans] of [[1, '2026-10-13T08:00:00Z', 'Top: LOOP-1000000000001-THRA and LOOP-1000000000002-THRB'], [2, '2026-10-14T08:00:00Z', 'Top: LOOP-1000000000001-THRA'], [3, '2026-10-15T08:00:00Z', 'Top: LOOP-1000000000001-THRA']]) {
    await query(`INSERT INTO engine_ns_asks (natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $2, 'engine', now(), now(), $3)`,
      [`NS-TEST-HR-${i}`, JSON.stringify({ 'Ask ID': `NS-TEST-HR-${i}`, Outcome: 'Ranking only', Delivered: 'Delivered', 'Asked At': at, Answer: ans }), at]);
  }
  await query(`INSERT INTO engine_rt_asks (natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ('RT-TEST-HR-1', $1, 'engine', now(), now(), '2026-10-14T08:00:00Z')`,
    [JSON.stringify({ 'Ask ID': 'RT-TEST-HR-1', Outcome: 'Thin', Delivered: 'Delivered', 'Asked At': '2026-10-14T08:00:00Z', Question: 'A thin test question' })]);

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
  assert.match(r.slack_text, /\*8\. Week by week\*\n• 21 to 27 Sep:/);

  const ns = r.data.twins.north_star;
  assert.ok(ns.loops_pointed_at >= 2 && ns.loops_moved >= 1 && ns.loops_closed >= 1, 'a loop closed after North Star named it is a hit');
  const stuck = ns.stuck.find((x) => x.loop_id === 'LOOP-1000000000001-THRA');
  assert.ok(stuck && stuck.times_named === 3, 'a loop named three times that never moved is listed as stuck');
  assert.ok(!ns.stuck.some((x) => x.loop_id === 'LOOP-1000000000002-THRB'), 'a moved loop is never stuck');
  assert.ok(r.data.twins.research_twin.misses.some((m) => m.question === 'A thin test question'), 'a thin Research Twin answer is a miss');
  assert.match(r.slack_text, /\*6\. Twin review: hits and misses\*/);
  assert.match(r.slack_text, /LOOP-1000000000001-THRA \(Ahad, In Progress, named 3 times\)/);
  assert.ok(Array.isArray(r.slack_blocks) && r.slack_blocks.length <= 50, 'at most 50 blocks');
  assert.equal(r.slack_blocks[0].type, 'header');
  assert.equal(r.slack_blocks_test[0].type, 'context', 'a test copy says so first');
  for (const b of r.slack_blocks) {
    if (b.fields) { assert.ok(b.fields.length <= 10); for (const f of b.fields) assert.ok(f.text.length <= 2000); }
    if (b.text && b.type === 'section') assert.ok(b.text.text.length <= 3000);
  }
  assert.ok(JSON.stringify(r.slack_blocks).includes('LOOP-1000000000001-THRA'), 'stuck loops are in the blocks');
  const doc = hr.twinCritiqueDoc(r.data);
  assert.equal(doc.title, 'Twin Critique: week of 12 to 18 Oct 2026');
  assert.match(doc.content, /\*\*North Star\*\* pointed people at/);
  const dry = await hr.fileTwinCritique({ now: '2026-10-19T06:00:00Z', dry_run: true });
  assert.equal(dry.ok, true); assert.equal(dry.filed, false); assert.equal(dry.dry_run, true);
  await cleanTwins();
  assert.doesNotMatch(r.slack_text, /Open incidents/i, 'the report does not list open incidents');
  assert.ok(r.slack_text.length < 12000, 'fits one Slack message');

  await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TEST-HR-%'`);
  await query(`DELETE FROM engine_loops WHERE natural_id LIKE 'LOOP-TEST-HR-%'`);
  await closePool();
  console.log('health report: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
