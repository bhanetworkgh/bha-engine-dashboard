/**
 * Stage 3, the proposal (2026-10-17), against a real local database.
 *
 *   - a proposal is made only for a lead in Stage 3 with Form 2 in, and is always a test;
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
  ok('a proposal is always a test, and only the hash of its link is stored');

  const html = await prop.page(token);
  assert.ok(html.includes('Test proposal'));
  assert.ok(html.includes('One rack, leafy greens'));
  assert.ok(html.includes('4,500.00 USD'));
  assert.ok(!/stripe/i.test(html), 'no payment link on the proposal page');
  assert.equal(await prop.page('x'.repeat(43)), null);
  assert.ok((await query(`SELECT proposal->>'opened_at' AS o FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].o);
  ok('the page opens on its link, says test, shows no payment link; a wrong link opens nothing');

  assert.equal((await prop.act(token, 'question', '')).flash.startsWith('Write your question'), true);
  await prop.act(token, 'question', 'Does it need a drain?');
  let r = await prop.act(token, 'accept', null);
  assert.ok(r.flash.includes('accepted'));
  let lead = (await query(`SELECT stage, proposal FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0];
  assert.equal(lead.stage, 4);
  assert.ok(lead.proposal.accepted_at);
  assert.deepEqual(lead.proposal.actions.map((a) => a.kind), ['question', 'accepted']);
  r = await prop.act(token, 'accept', null);
  assert.ok(r.flash.includes('already'));
  assert.equal((await query(`SELECT jsonb_array_length(proposal->'actions') AS n FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].n, 2);
  ok('a question is recorded; Accept moves the lead to Stage 4 once, and a second changes nothing');

  await assert.rejects(ea.moveStage({ id }, 5, 'Destiny', null, 'page'), /paid/);
  await query(`UPDATE engine_vfarm_leads SET stripe_payment = '{"state":"paid","mode":"test"}'::jsonb WHERE id::text = $1`, [id]);
  await ea.moveStage({ id }, 5, 'Destiny', 'agreement and payment in', 'page');
  ok('Stage 5 needs a paid payment on the lead');

  await ea.moveStage({ id }, 3, 'Destiny', 'test the replace', 'page');
  const again = await prop.create(id, { ...input, price_amount: 400000 }, 'Destiny');
  assert.equal(again.replaced, `VFPROP-PRTEST-${T}-1`);
  assert.equal(await prop.page(token), null);
  assert.ok(await prop.page(again.proposal.link.split('/proposal/')[1]));
  ok('a replaced proposal\'s old link stops working and the new one opens');

  await clean();
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
