/**
 * Incident -> pattern capture (2026-10-15), against a real local database.
 *
 *   - a repair the bridge traced as "none_on_record" in an engine lane writes one
 *     Proposed pattern candidate, owned by the lane's owner, and stamps the incident
 *     with canonical_id and the candidate;
 *   - the same repair again changes nothing; a repeat of the same fault adds to that
 *     candidate and never makes a second;
 *   - the simulator and a repair with no engine lane are left out;
 *   - a "matched" trace writes the bridge's pattern ids into the incident's pattern_refs;
 *   - a declined candidate is not proposed again; a registered one hands its pattern id
 *     to every incident, now and on the next repeat;
 *   - the sweep picks up a repair nothing handled.
 *
 * Run with:  npm run test:pattern-capture   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:pattern-capture writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

(async () => {
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const repairs = req('repairs.js');
  const capture = req('patternCapture.js');
  await migrate();

  const T = Date.now();
  const WF = `Bays — PCTEST Flow ${T}`;
  const clean = async () => {
    await query(`DELETE FROM engine_pattern_candidates WHERE fields->>'Fault Signature' LIKE $1`, [`%PCTEST%`]);
    await query(`DELETE FROM engine_pattern_captures WHERE signature LIKE $1`, [`%PCTEST%`]);
    await query(`DELETE FROM engine_repairs WHERE repair_id LIKE 'PCTEST-%'`);
    await query(`DELETE FROM engine_incidents WHERE natural_id LIKE 'INC-PCTEST-%'`);
    await query(`DELETE FROM engine_events WHERE event_type = 'pattern_candidate_captured' AND detail->>'signature' LIKE '%PCTEST%'`);
  };
  await clean();
  await query(
    `INSERT INTO engine_builder_profiles (natural_id, fields, source, created_time, first_seen_at, updated_at)
     SELECT 'U0AEW3TBYH1', '{"user_id":"U0AEW3TBYH1","name":"Destiny Arupi"}'::jsonb, 'engine', now()::text, now()::text, now()::text
     WHERE NOT EXISTS (SELECT 1 FROM engine_builder_profiles WHERE natural_id = 'U0AEW3TBYH1')`,
  );

  const incident = async (n) => {
    await query(
      `INSERT INTO engine_incidents (natural_id, fields, source, created_time, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', now()::text, now()::text, now()::text)`,
      [`INC-PCTEST-${T}-${n}`, JSON.stringify({ payload: { execution_id: `PC${T}${n}`, workflow_or_scenario: WF } })],
    );
    return `INC-PCTEST-${T}-${n}`;
  };
  const repair = async (n, o = {}) => {
    const id = `PCTEST-${T}-${n}`;
    await repairs.store({
      repair_id: id,
      outcome: 'needs_human',
      lane: 'lane' in o ? o.lane : 'bays',
      workflow: { id: 'wfPCTEST', name: o.workflow ?? WF },
      failed_node: o.node ?? 'Check Ledger Write',
      error_class: 'schema_validation',
      error_message: 'The value in the "JSON Body" field is not valid JSON [line 9]',
      root_cause: 'Not established. The same expression works on the stored data.',
      execution_id: o.exec ?? `PC${T}${n}`,
      trace: o.trace ?? { pattern_status: 'none_on_record', pattern_ids: [] },
    });
    return id;
  };
  const candidates = async () =>
    (await query(`SELECT id::text, natural_id, fields FROM engine_pattern_candidates WHERE fields->>'Fault Signature' = $1`, [`${WF} :: Check Ledger Write`])).rows;
  const inc = async (id) => (await query(`SELECT canonical_id, pattern_refs, pattern_candidate_id FROM engine_incidents WHERE natural_id = $1`, [id])).rows[0];

  // 1. none_on_record in the Bays lane: one candidate.
  const i1 = await incident(1);
  const r1 = await repair(1);
  let res = await capture.fromRepair(r1);
  assert.equal(res.result, 'candidate_created', JSON.stringify(res));
  let c = await candidates();
  assert.equal(c.length, 1);
  const f = c[0].fields;
  assert.equal(f.Status, 'Proposed');
  assert.equal(f.Lane, 'BAYS');
  assert.equal(f['Architect Slack ID'], 'U0AEW3TBYH1');
  assert.equal(f['Suggested Architect'], 'Destiny Arupi');
  assert.equal(f.Origin, 'incident');
  assert.equal(f['Canonical ID'], `fault:${WF} :: Check Ledger Write`);
  assert.equal(f['Incident IDs'], i1);
  assert.equal(f.Occurrences, 1);
  assert.match(f.Summary, /SCHEMA_VALIDATION: The value in the "JSON Body" field/);
  assert.match(f['Source Link'], new RegExp(`/engine-health\\?incident=${i1}$`));
  let x = await inc(i1);
  assert.equal(x.canonical_id, `fault:${WF} :: Check Ledger Write`);
  assert.equal(x.pattern_candidate_id, c[0].natural_id);
  const ev = await query(`SELECT 1 FROM engine_events WHERE event_type = 'pattern_candidate_captured' AND subject_id = $1`, [c[0].natural_id]);
  assert.equal(ev.rows.length, 1);
  ok('a failure with no pattern on record in an engine lane writes one Proposed candidate, owned by the lane owner, and stamps its incident');

  // 2. The same repair again, and a repeat of the same fault.
  res = await capture.fromRepair(r1);
  assert.equal(res.result, 'already_handled');
  const i2 = await incident(2);
  res = await capture.fromRepair(await repair(2));
  assert.equal(res.result, 'added_to_candidate', JSON.stringify(res));
  c = await candidates();
  assert.equal(c.length, 1);
  assert.equal(c[0].fields.Occurrences, 2);
  assert.equal(c[0].fields['Incident IDs'], `${i1}, ${i2}`);
  assert.equal((await inc(i2)).pattern_candidate_id, c[0].natural_id);
  ok('the same repair twice changes nothing, and a repeat of the fault adds to the candidate instead of making a second');

  // 3. Left out: the simulator, and a repair with no engine lane.
  res = await capture.fromRepair(await repair(3, { workflow: `Engine — Monitoring Twin Simulator PCTEST ${T}` }));
  assert.equal(res.result, 'excluded');
  // Deliberate alarms (LOOP-6E0K): a guard doing its job is never proposed as a pattern.
  res = await capture.fromRepair(await repair(20, { node: 'Raise If Agent Failed' }));
  assert.equal(res.result, 'excluded');
  assert.equal(res.detail, 'deliberate_alarm');
  res = await capture.fromRepair(await repair(21, { node: 'Stop On Credit Error' }));
  assert.equal(res.detail, 'deliberate_alarm');
  assert.equal(capture.deliberateAlarm('Bays — Scheduled Run Watch', 'Compare Against Schedule'), 'deliberate_alarm');
  assert.equal(capture.deliberateAlarm('Bays — Callback Receiver', 'Assert Answer Slack OK'), null, 'an Assert step still counts: it found msg_blocks_too_long');
  assert.equal(capture.deliberateAlarm('Bays — Agent Delivery', 'Check Ledger Write'), null);
  res = await capture.fromRepair(await repair(4, { lane: null, node: 'Other Step' }));
  assert.equal(res.result, 'not_a_critical_lane');
  const n = await query(`SELECT count(*)::int AS n FROM engine_pattern_candidates WHERE fields->>'Fault Signature' LIKE $1`, [`%PCTEST%`]);
  assert.equal(n.rows[0].n, 1);
  ok('the simulator, deliberate alarms (Raise If…, Stop On…, Scheduled Run Watch) and a repair with no engine lane write no candidate');

  // 4. A matched trace writes pattern_refs.
  const i5 = await incident(5);
  res = await capture.fromRepair(await repair(5, { node: 'Matched Step', trace: { pattern_status: 'matched', pattern_ids: ['BP-PCTEST-001'] } }));
  assert.equal(res.result, 'linked_pattern');
  x = await inc(i5);
  assert.deepEqual(x.pattern_refs, ['BP-PCTEST-001']);
  assert.equal(x.canonical_id, `fault:${WF} :: Matched Step`);
  ok('a matched trace writes the bridge\'s pattern id into the incident\'s pattern_refs');

  // 5. Declined is not proposed again.
  await query(`UPDATE engine_pattern_candidates SET fields = fields || '{"Status":"Declined"}'::jsonb WHERE id = $1`, [c[0].id]);
  res = await capture.fromRepair(await repair(6));
  assert.equal(res.result, 'declined_before');
  assert.equal((await candidates()).length, 1);
  ok('a declined candidate is not proposed again');

  // 6. Registered: the pattern id goes onto every incident, now and on the next repeat.
  await query(`UPDATE engine_pattern_candidates SET fields = fields || '{"Status":"Proposed"}'::jsonb WHERE id = $1`, [c[0].id]);
  await capture.linkRegistered((await candidates())[0].fields, 'BP-PCTEST-002');
  assert.deepEqual((await inc(i1)).pattern_refs, ['BP-PCTEST-002']);
  assert.deepEqual((await inc(i2)).pattern_refs, ['BP-PCTEST-002']);
  await query(`UPDATE engine_pattern_candidates SET fields = fields || '{"Status":"Registered","Pattern ID":"BP-PCTEST-002"}'::jsonb WHERE id = $1`, [c[0].id]);
  const i7 = await incident(7);
  res = await capture.fromRepair(await repair(7));
  assert.equal(res.result, 'pattern_exists');
  assert.deepEqual((await inc(i7)).pattern_refs, ['BP-PCTEST-002']);
  assert.equal((await candidates()).length, 1);
  ok('registering hands the pattern id to every incident it came from, and a later repeat is linked to it, not re-proposed');

  // 7. The sweep picks up what nothing handled.
  await repair(8, { node: 'Swept Step' });
  const s = await capture.sweep();
  const mine = s.results.find((r) => r.repair_id === `PCTEST-${T}-8`);
  assert.equal(mine && mine.result, 'candidate_created');
  ok('the sweep picks up a repair nothing handled');

  await clean();
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
