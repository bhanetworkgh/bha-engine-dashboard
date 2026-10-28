/**
 * Research signals (2026-10-11): the guard every automatic research job goes
 * through, and the triggers BP-CONTRACT-005 listed as not yet wired. Pinned
 * against a real local database and a stand-in for the model credit read.
 *
 * The guard:
 *   - one job per signal; the same ref again changes nothing; a new ref on the
 *     same key adds a line to the open job and opens no second one;
 *   - a capped or removed job is never reopened; a resolved one reopens only
 *     where the signal re-arms, and only after its re-arm days;
 *   - five automatic jobs a day (UTC); backlog takes at most three of them;
 *   - nothing is opened under the credit floor, or when the balance cannot be read.
 * The triggers:
 *   - T5 fires only on a flagged North Star answer that ends its gaps with a
 *     Research Twin question, and not where North Star already asked;
 *   - T6 fires on needs_revision / pilot_failed, and once on missing research
 *     with no job, live signals before backlog;
 *   - T8 fires on the same red flag name on three logs in 14 days;
 *   - T4 fires on research_needed and on two needs_human repairs, and shares
 *     its key with Logstream's fault signature;
 *   - a waiting card that stops holding is let go; a waiting question is kept.
 *
 * Run with:  npm run test:research-signals   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:research-signals writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

(async () => {
  const cr = await require('./_credit.cjs').startCredit();
  const rs = req('researchSignals.js');
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  await migrate();
  const T = Date.now();
  const TAG = `RSTEST-${T}`;
  const clean = async () => {
    await query(`DELETE FROM engine_research_signals`);
    await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Question' LIKE '%RSTEST-%' OR fields->>'Context' LIKE '%RSTEST-%' OR fields->>'Card ID' LIKE 'CARD-RSTEST-%'`);
    await query(`DELETE FROM engine_ns_asks WHERE natural_id LIKE 'NS-RSTEST-%'`);
    await query(`DELETE FROM engine_commercial_cards WHERE natural_id LIKE 'CARD-RSTEST-%'`);
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'RSTEST-%'`);
    await query(`DELETE FROM engine_incidents WHERE natural_id LIKE 'INC-RSTEST-%'`);
    await query(`DELETE FROM engine_repairs WHERE repair_id LIKE 'REP-RSTEST-%'`);
  };
  await clean();
  // Other tests leave cards, asks and logs behind in a local database. This test reads whole tables,
  // so it only ever counts its own rows.
  const mine = (signals) => signals.filter((s) => /rstest/i.test(JSON.stringify(s)));
  const jobs = async (like = TAG) => (await query(`SELECT natural_id, fields FROM engine_rt_jobs WHERE fields->>'Question' LIKE $1 OR fields->>'Context' LIKE $1 ORDER BY id`, [`%${like}%`])).rows;
  const sig = async (key) => (await query(`SELECT * FROM engine_research_signals WHERE signal_key = $1`, [key])).rows[0];
  const base = (over = {}) => ({ trigger: 'T4', key: `test:${TAG}:a`, source: 'Engine signal (test)', ref: 'r1', question: `${TAG} why does the step keep failing?`, context: `${TAG} context`, rearm_days: null, ...over });

  /* ------------------------------------------------------------ pure */
  assert.equal(rs.researchQuestionOf('*What it does not yet support*\n- a gap\nResearch Twin question: What is the current approval time for A2P 10DLC registration in the US?'), 'What is the current approval time for A2P 10DLC registration in the US?');
  assert.equal(rs.researchQuestionOf('- gap\n- *Research Twin question:* none'), null);
  assert.equal(rs.researchQuestionOf('Research Twin question: None.'), null);
  assert.equal(rs.researchQuestionOf('No Research Twin question was needed this run.'), null, 'prose about a question is not the line');
  assert.equal(rs.researchQuestionOf('Research Twin question: why?'), null, 'too short to be a question');
  assert.equal(rs.researchQuestionOf('> _Research Twin question_: `Which suppliers ship the MH-Z19B sensor to India within two weeks?`'), 'Which suppliers ship the MH-Z19B sensor to India within two weeks?');
  assert.equal(rs.researchQuestionOf(null), null);
  assert.equal(rs.redFlagKey('Guessed Instead Of Research'), 'guessed_instead_of_research');
  assert.equal(rs.redFlagKey('None.'), null);
  assert.equal(rs.redFlagKey(''), null);
  ok('the North Star line and the red flag key are read exactly, and "none" is none');

  /* ------------------------------------------------------- the guard */
  let r = await rs.open(base());
  assert.equal(r.state, 'job_opened');
  let j = await jobs();
  assert.equal(j.length, 1);
  assert.equal(j[0].fields.Status, 'Pending');
  assert.equal(j[0].fields['Opened By Trigger'], 'T4');
  assert.equal(j[0].fields['Signal Key'], `test:${TAG}:a`);
  assert.equal(j[0].fields['Opened By'], 'Engine signal (test)');
  r = await rs.open(base());
  assert.equal(r.state, 'job_opened');
  assert.equal(r.job_id, j[0].natural_id);
  assert.equal((await jobs()).length, 1, 'the same signal and ref again opens nothing');
  assert.equal((await sig(`test:${TAG}:a`)).occurrences, 1);
  r = await rs.open(base({ ref: 'r2', question: `${TAG} seen once more` }));
  assert.equal(r.state, 'added_to_job');
  j = await jobs();
  assert.equal(j.length, 1, 'a repeat adds to the open job');
  assert.ok(j[0].fields.Context.includes('Seen again (T4, r2)'));
  assert.equal((await sig(`test:${TAG}:a`)).occurrences, 2);
  ok('one job per signal: a repeat of the same ref changes nothing, a new ref adds a line to the open job');

  await query(`UPDATE engine_rt_jobs SET fields = fields || '{"Status":"Capped (needs human)"}'::jsonb WHERE natural_id = $1`, [j[0].natural_id]);
  r = await rs.open(base({ ref: 'r3' }));
  assert.equal(r.state, 'not_reopened');
  assert.ok(r.reason.includes('capped'));
  await query(`UPDATE engine_rt_jobs SET fields = fields || '{"Status":"Resolved"}'::jsonb WHERE natural_id = $1`, [j[0].natural_id]);
  r = await rs.open(base({ ref: 'r4' }));
  assert.equal(r.state, 'not_reopened', 'resolved, and this signal does not re-arm');
  r = await rs.open(base({ ref: 'r5', rearm_days: 7 }));
  assert.equal(r.state, 'not_reopened', 'resolved today: inside its re-arm days');
  await query(`UPDATE engine_research_signals SET opened_at = now() - interval '8 days' WHERE signal_key = $1`, [`test:${TAG}:a`]);
  r = await rs.open(base({ ref: 'r6', rearm_days: 7 }));
  assert.equal(r.state, 'job_opened', 'resolved eight days ago and it re-arms after seven');
  assert.equal((await jobs()).length, 2);
  const again = await sig(`test:${TAG}:a`);
  assert.deepEqual(again.previous_jobs, [j[0].natural_id]);
  assert.notEqual(again.job_id, j[0].natural_id);
  await query(`DELETE FROM engine_rt_jobs WHERE natural_id = $1`, [again.job_id]);
  r = await rs.open(base({ ref: 'r7', rearm_days: 7 }));
  assert.equal(r.state, 'not_reopened');
  assert.ok(r.reason.includes('removed'));
  ok('a capped or removed job is never reopened; a resolved one reopens only after its re-arm days');

  // Two passes at once (Render overlaps instances on a deploy): one job, never two.
  await clean();
  const both = await Promise.all([rs.open(base({ key: `test:${TAG}:race` })), rs.open(base({ key: `test:${TAG}:race` }))]);
  assert.equal((await jobs()).length, 1, 'two passes at once open one job');
  assert.ok(both.some((b) => b.state === 'job_opened'));
  assert.equal((await rs.open(base({ key: `test:${TAG}:race` }))).state, 'job_opened');
  assert.equal((await jobs()).length, 1);
  ok('two passes reaching the same new signal at once open one job between them');

  // "Not yet" is told apart from "never": a resolved job inside its re-arm days is a wait.
  await clean();
  r = await rs.open(base({ key: `test:${TAG}:w`, rearm_days: 7 }));
  await query(`UPDATE engine_rt_jobs SET fields = fields || '{"Status":"Resolved"}'::jsonb WHERE natural_id = $1`, [r.job_id]);
  let again2 = await rs.open(base({ key: `test:${TAG}:w`, ref: 'next-week', rearm_days: 7 }));
  assert.equal(again2.state, 'not_reopened');
  assert.equal(again2.wait, true);
  assert.equal((await sig(`test:${TAG}:w`)).state, 'job_opened', 'the signal keeps the job it got');
  again2 = await rs.open(base({ key: `test:${TAG}:w`, ref: 'next-week' }));
  assert.equal(again2.wait, undefined, 'a signal that never re-arms is a plain no');
  // A job whose bookkeeping write was lost is found by its key, never opened twice.
  r = await rs.open(base({ key: `test:${TAG}:lost` }));
  await query(`UPDATE engine_research_signals SET state = 'failed', job_id = NULL, opened_at = NULL WHERE signal_key = $1`, [`test:${TAG}:lost`]);
  const found2 = await rs.open(base({ key: `test:${TAG}:lost` }));
  assert.equal(found2.state, 'job_opened');
  assert.equal(found2.job_id, r.job_id);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1`, [`test:${TAG}:lost`])).rows[0].n, 1);
  ok('a resolved job inside its re-arm days is a wait, not a refusal; a job whose own record was lost is found by its key and not opened twice');

  /* -------------------------------------------------------- the budget */
  await clean();
  for (let i = 1; i <= 5; i++) assert.equal((await rs.open(base({ key: `test:${TAG}:b${i}` }))).state, 'job_opened');
  r = await rs.open(base({ key: `test:${TAG}:b6` }));
  assert.equal(r.state, 'held_budget');
  assert.ok(r.reason.includes('5 automatic jobs'));
  assert.equal((await jobs()).length, 5);
  r = await rs.open(base({ key: `test:${TAG}:b6` }));
  assert.equal(r.state, 'held_budget', 'still held on the next pass');
  await query(`UPDATE engine_research_signals SET opened_at = opened_at - interval '1 day' WHERE state = 'job_opened'`);
  r = await rs.open(base({ key: `test:${TAG}:b6` }));
  assert.equal(r.state, 'job_opened', 'the next day it opens');
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'research_signal_held' AND detail->>'key' = $1`, [`test:${TAG}:b6`])).rows[0].n, 1, 'one held event, not one per pass');
  ok('five automatic jobs a day: the sixth waits, says why, and opens the next day');

  await clean();
  for (let i = 1; i <= 3; i++) assert.equal((await rs.open(base({ key: `test:${TAG}:k${i}`, priority: 2 }))).state, 'job_opened');
  r = await rs.open(base({ key: `test:${TAG}:k4`, priority: 2 }));
  assert.equal(r.state, 'held_budget');
  assert.ok(r.reason.includes('backlog'));
  assert.equal((await rs.open(base({ key: `test:${TAG}:live` }))).state, 'job_opened', 'a live signal still has room');
  ok('backlog takes at most three of the five, so a live signal still opens');

  /* -------------------------------------------------------- the credit */
  await clean();
  cr.set({ remaining: 9.5 });
  rs.forgetCredit();
  r = await rs.open(base({ key: `test:${TAG}:c1` }));
  assert.equal(r.state, 'held_credit');
  assert.ok(r.reason.includes('$9.50') && r.reason.includes('$15'));
  assert.equal((await jobs()).length, 0);
  cr.set({ status: 500 });
  rs.forgetCredit();
  r = await rs.open(base({ key: `test:${TAG}:c1` }));
  assert.equal(r.state, 'held_credit');
  assert.ok(r.reason.includes('could not be read') && r.reason.includes('500'));
  cr.set({ status: 200, remaining: 500 });
  rs.forgetCredit();
  r = await rs.open(base({ key: `test:${TAG}:c1` }));
  assert.equal(r.state, 'job_opened');
  ok('nothing is opened under the $15 floor or when the balance cannot be read; it opens once the credit is back');

  /* ------------------------------------------------------ T5 lane health */
  await clean();
  const now = new Date().toISOString();
  const ask = (id, f) => query(`INSERT INTO engine_ns_asks (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'engine', $3, $3)`, [`NS-RSTEST-${T}-${id}`, f.Lane ?? null, now, JSON.stringify({ 'Ask ID': `NS-RSTEST-${T}-${id}`, 'Asked At': now, Outcome: 'Answered', ...f })]);
  const Q = `RSTEST-${T} what is the current carrier approval time for A2P 10DLC registration?`;
  await ask('a', { Lane: 'VFARM_CORE', 'Architect Attention': 'true', Answer: `*What the evidence supports*\nx\n*What it does not yet support*\n- gap\nResearch Twin question: ${Q}` });
  await ask('b', { Lane: 'VFARM_CORE', 'Architect Attention': 'true', Answer: `*What it does not yet support*\n- RSTEST-${T} gap\nResearch Twin question: none` });
  await ask('c', { Lane: 'VFARM_CORE', 'Architect Attention': 'false', 'Claimed Lane Health': 'Healthy', Answer: `Research Twin question: RSTEST-${T} an unflagged lane asks something long enough?` });
  await ask('d', { Lane: 'VFARM_MEDIA', 'Claimed Lane Health': 'Needs Intervention', 'Linked Twin Ask': 'RT-123', Answer: `Research Twin question: RSTEST-${T} already asked Research Twin live in the thread?` });
  await ask('e', { Lane: 'VFARM_MEDIA', 'Claimed Lane Health': 'Needs Intervention', Answer: `Research Twin question: RSTEST-${T} which platforms allow an org-owned page transfer without a 30-day hold?` });
  let found = mine((await rs.detect()).signals);
  assert.deepEqual(found.map((s) => s.ref).sort(), [`NS-RSTEST-${T}-a`, `NS-RSTEST-${T}-e`]);
  assert.ok(found.every((s) => s.trigger === 'T5' && s.key.startsWith('ns_gap:')));
  assert.equal(found.find((s) => s.ref.endsWith('-a')).question, Q);
  ok('T5: only a flagged answer that names a Research Twin question, and not one North Star already asked');

  /* -------------------------------------------------------- T6 cards */
  const card = (id, f) => query(`INSERT INTO engine_commercial_cards (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'engine', $3, $3)`, [`CARD-RSTEST-${T}-${id}`, f.lane_id ?? null, now, JSON.stringify({ card_id: `CARD-RSTEST-${T}-${id}`, opportunity_title: `RSTEST-${T} card ${id}`, created_at: now, ...f })]);
  await card('rev', { lane_id: 'LANE-RSTEST-A', lane_state: 'needs_revision' });
  await card('miss', { lane_id: 'LANE-RSTEST-B', lane_state: 'research_first', missing_research_count: '2', missing_research: JSON.stringify([{ type: 'open_question', item: `RSTEST-${T} would a 60-day pilot clear procurement?` }, { type: 'unclear_claim', item: 'not a question' }, { type: 'open_question', item: 'second question' }]) });
  await card('has', { lane_id: 'LANE-RSTEST-C', lane_state: 'research_first', missing_research_count: '1', missing_research_questions: `RSTEST-${T} already being researched?` });
  await query(`INSERT INTO engine_rt_jobs (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, NULL, $2, $3::jsonb, 'engine', $2, $2)`, [`JOB-RSTEST-${T}`, now, JSON.stringify({ 'Job ID': `JOB-RSTEST-${T}`, 'Card ID': `CARD-RSTEST-${T}-has`, Status: 'Resolved', Question: `RSTEST-${T} earlier job` })]);
  await card('zero', { lane_id: 'LANE-RSTEST-D', lane_state: 'research_first', missing_research_count: '0' });
  found = mine((await rs.detect()).signals).filter((s) => s.trigger === 'T6');
  assert.deepEqual(found.map((s) => `${s.card_id.split('-').pop()}:${s.priority ?? 1}`).sort(), ['miss:2', 'rev:1']);
  const miss = found.find((s) => s.card_id.endsWith('-miss'));
  assert.equal(miss.question, `RSTEST-${T} would a 60-day pilot clear procurement?`);
  assert.ok(miss.context.includes('second question') && !miss.context.includes('not a question'));
  assert.equal(miss.lane, 'LANE-RSTEST-B');
  ok('T6: a card at needs_revision is a live signal; missing research with no job is backlog, once; a card with a job is left alone');

  /* -------------------------------------------------------- T8 red flags */
  const log = (id, name, builder = 'Test Builder') => query(`INSERT INTO engine_codex_submissions (natural_id, builder_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, 'test', $2, $3::jsonb, 'engine', $2, $2)`, [`RSTEST-${T}-${id}`, now, JSON.stringify({ 'Submission ID': `RSTEST-${T}-${id}`, 'Builder Name': builder, 'Red Flag Name': name, 'Layer1 Review ': `Verdict\nPartially Aligned\n\nRed Flags\nRSTEST guessed a cause without firing research\n\nImprovement Prompt\nx` })]);
  await log('l1', `rstest_${T}_guessed`);
  await log('l2', `RSTEST ${T} Guessed`, 'Other Builder');
  await log('l3', 'None.');
  await log('l4', '');
  await log('l5', `rstest_${T}_other`);
  assert.equal(mine((await rs.detect()).signals).filter((s) => s.trigger === 'T8').length, 0, 'two logs are not a pattern');
  await log('l6', `rstest_${T}_guessed`);
  found = mine((await rs.detect()).signals).filter((s) => s.trigger === 'T8');
  assert.equal(found.length, 1);
  assert.equal(found[0].key, `red_flag:rstest_${T}_guessed`);
  assert.ok(found[0].question.includes('3 session logs') && found[0].context.includes('never a pay decision') && found[0].context.includes('guessed a cause'));
  assert.equal(found[0].rearm_days, 14);
  ok('T8: the same red flag name on three logs in 14 days is one signal; "None." and two logs are nothing');

  /* -------------------------------------------------------- T4 incidents */
  const WF = `RSTEST Flow ${T}`;
  const incident = (id, wf, node, needed) => query(`INSERT INTO engine_incidents (natural_id, lane_id, fields, source, first_seen_at, updated_at, open_now) VALUES ($1, 'bays', $2::jsonb, 'engine', $3, $3, true)`, [`INC-RSTEST-${T}-${id}`, JSON.stringify({ entity_id: `INC-RSTEST-${T}-${id}`, occurred_at: now, payload: { workflow_or_scenario: wf, failed_node_or_component: node, error_class: 'UPSTREAM_5XX', research_needed: needed } }), now]);
  await incident('1', WF, 'Call Supplier API', true);
  await incident('2', WF, 'Other Step', false);
  await incident('3', `TEST — ${WF}`, 'Call Supplier API', true);
  const repair = (id, node) => query(`INSERT INTO engine_repairs (repair_id, outcome, workflow_name, failed_node, human_action) VALUES ($1, 'needs_human', $2, $3, 'RSTEST check the credential')`, [`REP-RSTEST-${T}-${id}`, WF, node]);
  await repair('1', 'Send Report');
  found = mine((await rs.detect()).signals).filter((s) => s.trigger === 'T4');
  assert.deepEqual(found.map((s) => s.key), [`fault:${WF} :: Call Supplier API`], 'one needs_human is not two, and a test workflow is counted in nothing');
  await repair('2', 'Send Report');
  found = mine((await rs.detect()).signals).filter((s) => s.trigger === 'T4');
  assert.deepEqual(found.map((s) => s.key).sort(), [`fault:${WF} :: Call Supplier API`, `fault:${WF} :: Send Report`]);
  assert.equal(found[0].key, `fault:${req('logstream.js').signatureOf(WF, 'Call Supplier API')}`, "the key is Logstream's own fault signature, so the two cannot open two jobs");
  ok('T4: research_needed and two needs_human repairs each raise one signal on the fault signature; tests are left out');

  // A DOCTRINE incident (SE8L's monitor) is operational and never research (SOP dc89a498, 27 Oct 2026),
  // so even one written before that day with research_needed true raises no T4 signal. Until 27 Oct this
  // pinned the opposite (2026-10-17): T4 read the shared excludedReason and opened a job for it.
  const DOC_WF = req('logstream.js').DOCTRINE_GAP_WORKFLOW;
  const DOC_NODE = `genie_ns / RSTEST-${T}:GAP`;
  await query(`INSERT INTO engine_incidents (natural_id, lane_id, fields, source, first_seen_at, updated_at, open_now) VALUES ($1, 'bays', $2::jsonb, 'engine', $3, $3, true)`, [`INC-RSTEST-${T}-DOC`, JSON.stringify({ entity_id: `INC-RSTEST-${T}-DOC`, occurred_at: now, payload: { workflow_or_scenario: DOC_WF, failed_node_or_component: DOC_NODE, error_class: 'NEEDS_EVIDENCE', research_needed: true, impact_tags: ['media', 'doctrine', 'genie_ns'] } }), now]);
  const docSignal = mine((await rs.detect()).signals).find((s) => s.trigger === 'T4' && s.ref === `INC-RSTEST-${T}-DOC`);
  assert.equal(docSignal, undefined, 'a research_needed DOCTRINE incident raises no T4 signal');
  // Out of the way again, so the pass below is about the same signals as before.
  await query(`DELETE FROM engine_incidents WHERE natural_id = $1`, [`INC-RSTEST-${T}-DOC`]);
  ok('T4: a research_needed DOCTRINE incident raises no signal: doctrine research comes only from detectDoctrineGaps');

  /* ------------------------------------------------------------ the pass */
  const before = (await query(`SELECT count(*)::int AS n FROM engine_rt_jobs`)).rows[0].n;
  const p = await rs.plan();
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_rt_jobs`)).rows[0].n, before, 'the plan opens nothing');
  assert.ok(mine(p.signals).length >= 7 && p.credit.ok === true);
  // Leave out everything that is not this test's own: each gets a row whose job is capped, which
  // the guard never reopens, so the pass below is about these rows only.
  const others = (await rs.detect()).signals.filter((s) => !/rstest/i.test(JSON.stringify(s)));
  await query(`INSERT INTO engine_rt_jobs (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, NULL, $2, $3::jsonb, 'engine', $2, $2)`, [`JOB-RSTEST-${T}-CAPPED`, now, JSON.stringify({ 'Job ID': `JOB-RSTEST-${T}-CAPPED`, Status: 'Capped (needs human)', Question: `RSTEST-${T} stand-in` })]);
  for (const s of others) await query(`INSERT INTO engine_research_signals (signal_id, signal_key, trigger_code, source, question, state, reason, job_id, refs) VALUES ($1, $2, $3, $4, 'not this test', 'job_opened', 'left out by the test', $5, $6::jsonb) ON CONFLICT DO NOTHING`, [`RSG-OTHER-${Math.random()}`, s.key, s.trigger, s.source, `JOB-RSTEST-${T}-CAPPED`, JSON.stringify([s.ref])]);
  let w = await rs.sweep();
  assert.equal(w.failed, 0);
  assert.equal(w.jobs_opened, 5, 'six live signals and one backlog: five open today');
  assert.equal(w.held, 2);
  const states = (await query(`SELECT trigger_code, priority, state FROM engine_research_signals WHERE reason IS DISTINCT FROM 'left out by the test' ORDER BY priority, id`)).rows;
  assert.ok(states.filter((s) => s.state === 'job_opened').every((s) => s.priority === 1), 'live signals took the slots before backlog');
  assert.equal(states.find((s) => s.priority === 2).state, 'held_budget');
  w = await rs.sweep();
  assert.equal(w.jobs_opened, 0, 'a second pass opens nothing');
  const cardJob = (await query(`SELECT fields FROM engine_rt_jobs WHERE fields->>'Card ID' = $1 AND fields->>'Opened By' LIKE 'Engine signal%'`, [`CARD-RSTEST-${T}-rev`])).rows[0];
  assert.equal(cardJob.fields.Lane, 'LANE-RSTEST-A');
  assert.equal(cardJob.fields['Opened By Trigger'], 'T6');
  ok('the pass: live signals before backlog, five a day, a second pass opens nothing, and the plan opens nothing');

  // A waiting card that stops holding is let go; a waiting question is kept and tried again.
  const heldLive = (await query(`SELECT signal_key, trigger_code FROM engine_research_signals WHERE state = 'held_budget' AND priority = 1`)).rows[0];
  await query(`UPDATE engine_commercial_cards SET fields = fields || '{"missing_research_count":"0"}'::jsonb WHERE natural_id = $1`, [`CARD-RSTEST-${T}-miss`]);
  await query(`UPDATE engine_ns_asks SET fields = fields || $2::jsonb WHERE natural_id LIKE $1`, [`NS-RSTEST-${T}-%`, JSON.stringify({ 'Asked At': new Date(Date.now() - 9 * 86_400_000).toISOString() })]);
  await query(`UPDATE engine_research_signals SET state = 'held_budget', job_id = NULL, opened_at = NULL WHERE signal_key LIKE 'ns_gap:%' AND reason IS DISTINCT FROM 'left out by the test'`);
  await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Engine signal (North Star lane health)' AND fields->>'Context' LIKE $1`, [`%NS-RSTEST-${T}-%`]);
  await query(`UPDATE engine_research_signals SET opened_at = opened_at - interval '1 day' WHERE opened_at IS NOT NULL`);
  w = await rs.sweep();
  const gone = await sig(`card:CARD-RSTEST-${T}-miss:missing_research`);
  assert.equal(gone.state, 'not_reopened');
  assert.ok(gone.reason.includes('stopped holding'));
  const kept = (await query(`SELECT state FROM engine_research_signals WHERE signal_key LIKE 'ns_gap:%' AND reason IS DISTINCT FROM 'left out by the test'`)).rows;
  assert.ok(kept.length === 2 && kept.every((k) => k.state === 'job_opened'), 'the questions North Star asked nine days ago still got their jobs');
  assert.ok(heldLive);
  // Let go is not forever: the card asks again later and gets its job.
  await query(`UPDATE engine_commercial_cards SET fields = fields || '{"missing_research_count":"1"}'::jsonb WHERE natural_id = $1`, [`CARD-RSTEST-${T}-miss`]);
  await rs.sweep();
  assert.equal((await sig(`card:CARD-RSTEST-${T}-miss:missing_research`)).state, 'job_opened');
  // A fixture that is waiting is never opened by the clock.
  await query(`INSERT INTO engine_research_signals (signal_id, signal_key, trigger_code, source, question, state, reason, fixture, refs) VALUES ($1, $2, 'T4', 'Engine signal (fixture)', $3, 'held_credit', 'test', true, '["x"]'::jsonb)`, [`RSG-RSTEST-${T}-FX`, `fixture:RSTEST-${T}`, `RSTEST-${T} a waiting fixture`]);
  await rs.sweep();
  assert.equal((await sig(`fixture:RSTEST-${T}`)).state, 'held_credit');
  ok('a waiting card that stops holding is let go and says so, and gets its job if it asks again; a waiting question is kept; a waiting fixture is never opened by the clock');

  // Until 27 Oct a DOCTRINE incident's T4 signal was routed through open() here. There is no such
  // signal now (SOP dc89a498); a doctrine gap reaches open() only through detectDoctrineGaps, which
  // test:se8l-episode-db drives through this same guard with three passes at once.
  assert.equal(docSignal, undefined);

  /* -------------------------------------------------------------- reads */
  const read = await rs.read({ limit: 50 });
  assert.equal(read.today.budget, 5);
  assert.ok(read.signals.length >= 7 && read.rule.words.length >= 6 && read.rule.not_built.length === 2);
  assert.equal(read.credit.read, true);
  const heldOnly = await rs.read({ held_only: true });
  assert.ok(heldOnly.signals.every((s) => ['held_budget', 'held_credit', 'failed'].includes(s.state)));
  const { runResearchSignalsTool } = req('mcp/signalTools.js');
  const dry = await runResearchSignalsTool.handler({}, { access: 'write' });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  const noReason = await runResearchSignalsTool.handler({ dry_run: false }, { access: 'write' });
  assert.equal(noReason.ok, false);
  const fx = await runResearchSignalsTool.handler({ dry_run: false, reason: 'RSTEST proving the guard', fixture: { question: `${TAG} fixture question for the guard` } }, { access: 'write' });
  assert.equal(fx.ok, true);
  assert.equal(fx.state, 'job_opened');
  const fxJob = (await query(`SELECT fields FROM engine_rt_jobs WHERE natural_id = $1`, [fx.job_id])).rows[0];
  assert.equal(fxJob.fields.Fixture, true);
  assert.ok(fxJob.fields.Question.startsWith('[FIXTURE, do not research]'));
  const fx2 = await runResearchSignalsTool.handler({ dry_run: false, reason: 'RSTEST repeat', fixture: { question: `${TAG} fixture question for the guard`, key: fx.key } }, { access: 'write' });
  assert.equal(fx2.state, 'added_to_job');
  assert.equal(fx2.job_id, fx.job_id);
  const audits = (await query(`SELECT outcome FROM engine_mcp_writes WHERE tool = 'run_research_signals' ORDER BY id DESC LIMIT 4`)).rows.map((a) => a.outcome);
  assert.deepEqual(audits, ['applied', 'applied', 'refused', 'dry_run']);
  ok('reads and the tool: the page read, the waiting-only read, a dry run, a refusal without a reason, a fixture through the real guard, all audited');

  await clean();
  cr.close();
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
