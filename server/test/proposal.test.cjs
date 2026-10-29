/**
 * Stage 3, the proposal (2026-10-17), against a real local database.
 *
 *   - a proposal is made only for a lead in Stage 3 with Form 2 in; a team test lead's is a test;
 *   - a real buyer's proposal is refused until Jason's live offer is approved, then made real
 *     (no test banner, no [Test proposal] tag, the offer_id carried) (29 Oct 2026);
 *   - the page opens on its link, says "Test proposal" and shows no payment link;
 *   - a wrong link and a replaced link open nothing;
 *   - Accept moves the lead to Stage 4 once; a second Accept changes nothing;
 *   - a question needs text and is recorded;
 *   - the stage gates: 3 needs Form 2, 4 needs an accepted proposal, 5 a paid payment.
 *
 * Run with:  npm run test:proposal   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:proposal writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
process.env.INTAKE2_LINK_SECRET = process.env.INTAKE2_LINK_SECRET || 'test-secret-proposal';
process.env.SLACK_API_URL = process.env.SLACK_API_URL || 'http://127.0.0.1:9/';
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

(async () => {
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const prop = req('proposal.js');
  const ea = req('earlyAccess.js');
  await migrate();

  const T = Date.now();
  const BUYER = `VFBUYER-PRTEST-${T}`;
  const clean = () => query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' LIKE 'VFBUYER-PRTEST-%'`);
  await clean();
  const id = (
    await query(`INSERT INTO engine_vfarm_leads (full_name, email, organization_name, source_surface, form_a, stage) VALUES ('Ada Test', 'ada@bhanetwork.org', 'Ada Farms', 'form_a', $1::jsonb, 2) RETURNING id::text AS id`, [
      JSON.stringify({ buyer_intake_id: BUYER, answers: {} }),
    ])
  ).rows[0].id;
  const input = { setup_name: 'One rack, leafy greens', summary: 'A single rack that fits the 3 by 2 metre room you described.', inclusions: ['Rack', 'Monitoring'], price_amount: 450000, currency: 'usd', timeline: 'Six weeks' };

  await assert.rejects(prop.create(id, input, 'Destiny'), (e) => e.reason === 'not_stage_3');
  await assert.rejects(ea.moveStage({ id }, 3, 'Destiny', null, 'page'), /Form 2/);
  await query(`UPDATE engine_vfarm_leads SET intake_2_completed_at = now() WHERE id::text = $1`, [id]);
  await ea.moveStage({ id }, 3, 'Destiny', 'five checks cleared', 'page');
  await assert.rejects(ea.moveStage({ id }, 4, 'Destiny', null, 'page'), /accepted/);
  ok('a proposal needs Stage 3, Stage 3 needs Form 2, Stage 4 needs an accepted proposal');

  await assert.rejects(prop.create(id, { ...input, price_amount: 5 }, 'Destiny'), (e) => e.reason === 'price_amount');
  const made = await prop.create(id, input, 'Destiny');
  assert.equal(made.proposal.test, true);
  assert.equal(made.proposal.proposal_id, `VFPROP-PRTEST-${T}-1`);
  const token = made.proposal.link.split('/proposal/')[1];
  const row = (await query(`SELECT proposal FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].proposal;
  assert.ok(!JSON.stringify(row).includes(token), 'the token itself is never stored');
  ok('a team test lead\'s proposal is a test, and only the hash of its link is stored');

  const html = await prop.page(token);
  assert.ok(html.includes('Test proposal'));
  assert.ok(html.includes('One rack, leafy greens'));
  assert.ok(html.includes('4,500.00 USD'));
  assert.ok(!/stripe/i.test(html), 'no payment link on the proposal page');
  assert.equal(await prop.page('x'.repeat(43)), null);
  assert.ok((await query(`SELECT proposal->>'opened_at' AS o FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].o);
  ok('the page opens on its link, says test, shows no payment link; a wrong link opens nothing');

  assert.equal((await prop.act(token, 'question', '')).flash.startsWith('Write your question'), true);
  const asked = await prop.act(token, 'question', 'Does it need a drain?');
  assert.equal(asked.flash, "We've received your question. A member of the team will reply by email. For now this is manual and not instant.");
  let r = await prop.act(token, 'accept', null);
  assert.ok(r.flash.includes('accepted'));
  let lead = (await query(`SELECT stage, proposal FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0];
  assert.equal(lead.stage, 4);
  assert.ok(lead.proposal.accepted_at);
  assert.deepEqual(lead.proposal.actions.map((a) => a.kind), ['question', 'accepted']);
  r = await prop.act(token, 'accept', null);
  assert.ok(r.flash.includes('already'));
  assert.equal((await query(`SELECT jsonb_array_length(proposal->'actions') AS n FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].n, 2);
  assert.deepEqual(lead.proposal.actions[0].assignee, { slack_id: 'U0AEW3TBYH1', name: 'Destiny Arupi', backstop_slack_id: 'U0A9V97949F', backstop_name: 'Jason Bays' });
  assert.equal(lead.proposal.actions[1].assignee, undefined);
  const qev = (await query(`SELECT detail FROM engine_events WHERE event_type = 'vfarm_proposal_question' AND detail->>'lead_id' = $1`, [id])).rows[0].detail;
  assert.equal(qev.assignee, 'U0AEW3TBYH1');
  assert.equal(qev.backstop, 'U0A9V97949F');
  ok('a question is recorded with a named owner (Destiny, Jason backstop) and the buyer is told it is manual; Accept moves the lead to Stage 4 once, and a second changes nothing');

  await assert.rejects(ea.moveStage({ id }, 5, 'Destiny', null, 'page'), /paid/);
  await query(`UPDATE engine_vfarm_leads SET stripe_payment = '{"state":"paid","mode":"test"}'::jsonb WHERE id::text = $1`, [id]);
  // A real buyer's address: a test-mode payment never makes them a customer (SOP c14e9e54).
  await query(`UPDATE engine_vfarm_leads SET email = 'ada@example.org' WHERE id::text = $1`, [id]);
  await assert.rejects(ea.moveStage({ id }, 5, 'Destiny', null, 'page'), /needs a live Stripe payment/);
  await query(`UPDATE engine_vfarm_leads SET stripe_payment = '{"state":"paid","mode":"live"}'::jsonb WHERE id::text = $1`, [id]);
  // A live payment is not enough on its own: the charge gate must say yes (Jason, 23 Oct).
  await query(`DELETE FROM engine_charge_gate WHERE gate_id LIKE 'CG-PROPTEST-%'`);
  await assert.rejects(ea.moveStage({ id }, 5, 'Destiny', null, 'page'), /not approved for live charging/);
  await query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via, bundle_ref, created_at)
               VALUES ('CG-PROPTEST-1','acceptance_pass','vfarm_stripe_live','green','U0BKT6MAW2Y','x','C','1','t','test','TEST bundle', now() + interval '1 day')`);
  await query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via, scope, offer_id, loop_id, conditions, created_at)
               VALUES ('CG-PROPTEST-2','offer_approval','vfarm_stripe_live','approved','U0A9V97949F','x','C','1','t','test','TEST','OFFER-TEST','LOOP-1792528168754-FVA9','{"price":"TEST"}', now() + interval '1 day')`);
  let moved5 = await ea.moveStage({ id }, 5, 'Destiny', 'agreement and payment in', 'page');
  await query(`DELETE FROM engine_charge_gate WHERE gate_id LIKE 'CG-PROPTEST-%'`);
  assert.equal(moved5.stage, 5);
  await ea.moveStage({ id }, 4, 'Destiny', 'back for the team-test case', 'page');
  // A team test lead may move on a test-mode payment, and the move says it grants nothing.
  await query(`UPDATE engine_vfarm_leads SET email = 'ada@bhanetwork.org', stripe_payment = '{"state":"paid","mode":"test"}'::jsonb WHERE id::text = $1`, [id]);
  await ea.moveStage({ id }, 5, 'Destiny', 'internal walk', 'page');
  const hist = (await query(`SELECT stage_history FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].stage_history;
  const last = hist[hist.length - 1];
  assert.deepEqual(last.test_payment, { mode: 'test', team_test: true, grants: 'nothing' });
  assert.match(last.reason, /grants no entitlement or reservation/);
  const sev = (await query(`SELECT detail FROM engine_events WHERE event_type = 'vfarm_flow_stage_moved' AND detail->>'lead_id' = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0].detail;
  assert.equal(sev.test_payment, true);
  assert.equal(sev.grants, 'nothing');
  assert.equal(ea.stage5Payment('paid', 'test', false).ok, false);
  assert.equal(ea.stage5Payment('paid', 'live', false).ok, false);
  assert.match(ea.stage5Payment('paid', 'live', false).message, /^The offer is not approved for live charging yet\./);
  assert.equal(ea.stage5Payment('paid', 'live', false, true).ok, true);
  assert.equal(ea.stage5Payment('paid', 'test', false, true).ok, false);
  assert.equal(ea.stage5Payment('paid', null, true).ok, false);
  ok('Stage 5 needs a paid live payment and the charge gate at yes for a real buyer; a team test lead may move on a test payment, marked on the move and its event as granting nothing');

  await ea.moveStage({ id }, 3, 'Destiny', 'test the replace', 'page');
  const again = await prop.create(id, { ...input, price_amount: 400000 }, 'Destiny');
  assert.equal(again.replaced, `VFPROP-PRTEST-${T}-1`);
  assert.equal(await prop.page(token), null);
  assert.ok(await prop.page(again.proposal.link.split('/proposal/')[1]));
  ok('a replaced proposal\'s old link stops working and the new one opens');

  // 29 Oct 2026: a real buyer never gets a test proposal.
  assert.equal(prop.rule('ada@BHANETWORK.org', null).team_test, true);
  assert.equal(prop.rule('shibu@example.com', null).can_make_real, false);
  assert.equal(prop.rule('shibu@example.com', { verdict: 'withdrawn', offer_id: 'OFFER-1' }).can_make_real, false);
  assert.equal(prop.rule('shibu@example.com', { verdict: 'approved', offer_id: 'OFFER-1' }, true).can_make_real, false);
  assert.deepEqual(prop.rule('shibu@example.com', { verdict: 'approved', offer_id: 'OFFER-1' }), { team_test: false, can_make_real: true, offer_id: 'OFFER-1', reason: "A real proposal, made under Jason's approved offer OFFER-1. It takes no payment." });
  ok('the rule: a team address is a test; a real buyer needs an approved offer with its id, and an unread gate is no');

  const RB = `VFBUYER-PRTEST-${T}-REAL`;
  const realId = (
    await query(`INSERT INTO engine_vfarm_leads (full_name, email, organization_name, source_surface, form_a, stage, intake_2_completed_at) VALUES ('Real Buyer', 'real.buyer@example.com', 'Real Farms', 'form_a', $1::jsonb, 3, now()) RETURNING id::text AS id`, [
      JSON.stringify({ buyer_intake_id: RB, answers: {} }),
    ])
  ).rows[0].id;
  const gateRow = (gid, verdict, offer) =>
    query(
      `INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via, test, offer_id, loop_id, conditions, created_at)
       VALUES ($1,'offer_approval','vfarm_stripe_live',$2,'U0A9V97949F','https://x.slack.com/archives/C1/p1','C1','1.1','test','test',false,$3,'LOOP-1793000000000-TEST','{}'::jsonb, now() + interval '1 hour' * $4)`,
      [gid, verdict, offer, verdict === 'withdrawn' ? 1 : 2],
    );
  const GW = `CG-PRTEST-${T}-W`, GA = `CG-PRTEST-${T}-A`;
  try {
    await gateRow(GW, 'withdrawn', 'OFFER-PRTEST');
    await assert.rejects(prop.create(realId, input, 'Destiny'), (e) => e.reason === 'no_approved_offer' && /never a test/.test(e.message));
    assert.equal((await query(`SELECT proposal FROM engine_vfarm_leads WHERE id::text = $1`, [realId])).rows[0].proposal, null);
    const listed = (await ea.leads()).leads.find((l) => l.id === realId);
    assert.equal(listed.proposal_rule.can_make_real, false);
    ok('a real buyer gets no proposal while no live offer is approved, and the lead says why');

    await gateRow(GA, 'approved', 'OFFER-PRTEST');
    const real = await prop.create(realId, input, 'Destiny');
    assert.equal(real.proposal.test, false);
    assert.equal(real.proposal.offer_id, 'OFFER-PRTEST');
    const rhtml = await prop.page(real.proposal.link.split('/proposal/')[1]);
    assert.ok(!/Test proposal/i.test(rhtml), 'no test banner for a real buyer');
    assert.ok(rhtml.includes('4,500.00 USD'));
    const ev = (await query(`SELECT detail FROM engine_events WHERE event_type = 'vfarm_proposal_made' AND subject_id = $1`, [RB])).rows[0].detail;
    assert.equal(ev.test, false);
    assert.equal(ev.offer_id, 'OFFER-PRTEST');
    ok('with Jason\'s offer approved, a real buyer\'s proposal is real: no test banner, its event says test false and names the offer');
  } finally {
    await query(`DELETE FROM engine_charge_gate WHERE gate_id IN ($1, $2)`, [GW, GA]);
    await query(`DELETE FROM engine_events WHERE subject_id = $1`, [RB]);
  }

  await clean();
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
