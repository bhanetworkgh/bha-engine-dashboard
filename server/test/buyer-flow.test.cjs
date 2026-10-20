/**
 * The Engine Surfaces Contract (2026-10-18), against a real local database.
 *
 *   - a stage move, a close and a reopen each write one vfarm_flow_* event, dated, naming the lead
 *     by its buyer_intake_id and never by the person's name;
 *   - the proposal's Accept writes the 3 -> 4 move as an event too, with actor "buyer";
 *   - read_buyer_flow answers position, payment state and mode, and returns no name, email,
 *     organisation or answer anywhere in its JSON;
 *   - the tool is in North Star's, Research Twin's, Bays' and Genie's scopes, with read_sop.
 *
 * Run with:  npm run test:buyer-flow   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:buyer-flow writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
process.env.INTAKE2_LINK_SECRET = process.env.INTAKE2_LINK_SECRET || 'test-secret-buyer-flow';
process.env.SLACK_API_URL = process.env.SLACK_API_URL || 'http://127.0.0.1:9/';
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

(async () => {
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const ea = req('earlyAccess.js');
  const prop = req('proposal.js');
  const { readBuyerFlow } = req('mcp/buyerFlowTools.js');
  await migrate();

  const T = Date.now();
  const BUYER = `VFBUYER-BFTEST-${T}`;
  const clean = async () => {
    await query(`DELETE FROM engine_events WHERE subject_id LIKE 'VFBUYER-BFTEST-%'`);
    await query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' LIKE 'VFBUYER-BFTEST-%'`);
  };
  await clean();
  const id = (
    await query(`INSERT INTO engine_vfarm_leads (full_name, email, organization_name, source_surface, source_campaign, form_a, stage) VALUES ('Zed Secretname', 'zed.secret@bhanetwork.org', 'Hidden Orchard', 'form_a', 'vfarm_flagship_1031', $1::jsonb, 1) RETURNING id::text AS id`, [
      JSON.stringify({ buyer_intake_id: BUYER, answers: { 'Full name': 'Zed Secretname' } }),
    ])
  ).rows[0].id;
  const events = async () => (await query(`SELECT event_type, actor, detail FROM engine_events WHERE subject_id = $1 AND event_type LIKE 'vfarm_flow_%' ORDER BY id`, [BUYER])).rows;

  await ea.moveStage({ id }, 2, 'Destiny', 'cleared by Jason', 'page');
  let ev = await events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_type, 'vfarm_flow_stage_moved');
  assert.deepEqual([ev[0].detail.from_stage, ev[0].detail.to_stage, ev[0].detail.via, ev[0].detail.lead_id], [1, 2, 'page', id]);
  ok('a stage move writes one vfarm_flow_stage_moved event naming the buyer id');

  await assert.rejects(ea.moveStage({ id }, 3, 'Destiny', null, 'page'));
  assert.equal((await events()).length, 1);
  ok('a refused move writes no event');

  await ea.close(id, 'timing', null, 'Destiny');
  await ea.reopen(id, 'Destiny');
  ev = await events();
  assert.deepEqual(ev.map((e) => e.event_type), ['vfarm_flow_stage_moved', 'vfarm_flow_closed', 'vfarm_flow_reopened']);
  assert.equal(ev[1].detail.closed_reason, 'timing');
  ok('close and reopen each write one event');

  await query(`UPDATE engine_vfarm_leads SET intake_2_completed_at = now() WHERE id::text = $1`, [id]);
  await ea.moveStage({ id }, 3, 'Destiny', 'five checks cleared', 'page');
  const made = await prop.create(id, { setup_name: 'One rack', summary: 'A single rack for the room described.', inclusions: ['Rack'], price_amount: 450000, currency: 'usd', timeline: null }, 'Destiny');
  await prop.act(made.proposal.link.split('/proposal/')[1], 'accept', null);
  ev = await events();
  const last = ev[ev.length - 1];
  assert.equal(last.event_type, 'vfarm_flow_stage_moved');
  assert.deepEqual([last.detail.from_stage, last.detail.to_stage, last.actor, last.detail.via], [3, 4, 'buyer', 'buyer']);
  assert.ok(!JSON.stringify(ev).includes('Secretname'), "no event carries the buyer's name");
  ok("the buyer's Accept writes the 3 -> 4 move, actor buyer, with no name");

  await query(`UPDATE engine_vfarm_leads SET stripe_payment = $2::jsonb WHERE id::text = $1`, [id, JSON.stringify({ state: 'paid', mode: 'test', amount: 100, currency: 'usd', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })]);
  const out = await readBuyerFlow.handler({ buyer_intake_id: BUYER }, { access: 'read' });
  assert.equal(out.ok, true);
  assert.equal(out.leads.length, 1);
  const l = out.leads[0];
  assert.deepEqual([l.stage, l.position, l.payment.state, l.payment.mode, l.proposal.test], [4, 'agreement', 'paid', 'test', true]);
  assert.ok(out.counts.payments.paid_test >= 1);
  const text = JSON.stringify(out);
  for (const s of ['Secretname', 'zed.secret', 'Hidden Orchard', 'Full name', 'One rack']) assert.ok(!text.includes(s), `read_buyer_flow leaked "${s}"`);
  assert.ok(out.rules.length >= 5);
  ok('read_buyer_flow answers stage, position, payment and mode, and no personal field');

  const bad = await readBuyerFlow.handler({ position: 'paying' }, { access: 'read' });
  assert.equal(bad.reason, 'unknown_position');
  const all = await readBuyerFlow.handler({}, { access: 'read' });
  assert.ok(all.counts.total >= 1 && typeof all.counts.by_position.agreement === 'number');
  ok('an unknown position is refused by name; no arguments gives counts');

  const idx = fs.readFileSync(path.join(__dirname, '../src/mcp/index.ts'), 'utf8');
  for (const agent of ['north_star', 'research_twin', 'bays', 'genie']) {
    const block = idx.slice(idx.indexOf(`agent: '${agent}'`)).split(/\n\s*\},\n\s*\{/)[0];
    assert.ok(block.includes("'read_buyer_flow'"), `${agent} has read_buyer_flow`);
    assert.ok(block.includes("'read_sop'"), `${agent} has read_sop`);
  }
  ok('read_buyer_flow and read_sop are in all four agent scopes');

  await clean();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
