/**
 * The charge gate (2026-10-22, Jason on the 22 Oct log): Hardik's acceptance pass and Jason's
 * live-offer approval, the two records "can we charge real buyers" waits on.
 * Part 1 checks every rule with no database or Slack. Part 2 records against a LOCAL database
 * (localhost or 127.0.0.1, name ending _test), reads it back through read_buyer_flow and the
 * tools, and deletes what it wrote. Slack is stood in by the checkMessage argument.
 * Run with:  npm run test:charge-gate   (after the server build; part 2 needs DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const g = require(path.join(DIST, 'server/src', 'chargeGate.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const LINK = 'https://bayshorizonnetwork.slack.com/archives/C0AFPJ5S1C1/p1792686055908889?thread_ts=1792680780.486439&cid=C0AFPJ5S1C1';
const PASS = { kind: 'acceptance_pass', verdict: 'green', decided_by: g.HARDIK, evidence_link: LINK, recorded_by: g.DESTINY, bundle_ref: 'TEST honest gate bundle' };
const OFFER = { kind: 'offer_approval', verdict: 'approved', decided_by: g.JASON, evidence_link: LINK, recorded_by: g.DESTINY, scope: 'TEST scope', offer_id: 'OFFER-TEST-1', loop_id: 'LOOP-1792528168754-FVA9', conditions: { price: 'TEST', for: 'Client 2 pilot' } };
const refused = (input, reason) => assert.throws(() => g.check(input), (e) => { assert.equal(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.message}`); return true; });

(async () => {
  // ---------------------------------------------------------------- part 1, pure
  const l = g.parseLink(LINK);
  assert.deepEqual(l, { channel: 'C0AFPJ5S1C1', ts: '1792686055.908889', thread_ts: '1792680780.486439' });
  assert.equal(g.parseLink('https://evil.example/archives/C0AFPJ5S1C1/p1792686055908889'), null);
  assert.equal(g.parseLink('not a link'), null);
  ok('a Slack message link parses to channel, ts and thread; anything else does not');

  assert.equal(g.check(PASS).verdict, 'green');
  assert.equal(g.check(OFFER).rail, 'vfarm_stripe_live');
  refused({ ...PASS, kind: 'payment' }, 'unknown_kind');
  refused({ ...PASS, verdict: 'approved' }, 'unknown_verdict');
  refused({ ...OFFER, verdict: 'green' }, 'unknown_verdict');
  refused({ ...PASS, rail: 'crypto' }, 'unknown_rail');
  ok('kinds, verdicts and rails outside the lists are refused');

  refused({ ...PASS, decided_by: g.JASON }, 'not_the_owner');
  refused({ ...OFFER, decided_by: g.HARDIK }, 'not_the_owner');
  refused({ ...OFFER, decided_by: g.DESTINY }, 'not_the_owner');
  ok("the pass is Hardik's alone and the offer Jason's alone; Destiny cannot decide either");

  assert.equal(g.check({ ...PASS, recorded_by: g.HARDIK }).recorded_by, g.HARDIK);
  assert.equal(g.check({ ...OFFER, recorded_by: g.JASON }).recorded_by, g.JASON);
  refused({ ...PASS, recorded_by: 'U0AF011R821' }, 'not_permitted');
  refused({ ...OFFER, recorded_by: g.HARDIK }, 'not_permitted');
  ok('the owner or Destiny records it; nobody else');

  refused({ ...PASS, evidence_link: '' }, 'evidence_required');
  refused({ ...PASS, evidence_link: 'https://bhanetwork.org/x' }, 'evidence_required');
  refused({ ...OFFER, scope: '' }, 'scope_required');
  assert.equal(g.check({ ...OFFER, verdict: 'withdrawn', scope: '' }).scope, null);
  ok('a Slack link is required, and an approved offer must say what is approved');

  refused({ ...OFFER, offer_id: '' }, 'offer_id_required');
  refused({ ...OFFER, verdict: 'withdrawn', scope: '', offer_id: '' }, 'offer_id_required');
  refused({ ...OFFER, loop_id: 'FVA9' }, 'loop_id_required');
  refused({ ...OFFER, conditions: {} }, 'conditions_required');
  refused({ ...OFFER, conditions: '' }, 'conditions_required');
  refused({ ...PASS, bundle_ref: '' }, 'bundle_required');
  assert.equal(g.check({ ...PASS, verdict: 'red', bundle_ref: '' }).bundle_ref, null);
  assert.equal(g.check({ ...OFFER, verdict: 'withdrawn', scope: '', loop_id: '', conditions: null }).loop_id, null);
  ok("Jason's offer_approved fields: offer_id always, loop_id and a conditions snapshot on approval; a green pass names its bundle");

  const row = (kind, verdict, at = '2026-10-22T10:00:00.000Z') => ({ gate_id: 'X', kind, rail: 'vfarm_stripe_live', verdict, decided_by: g.OWNER[kind], evidence_link: LINK, evidence_channel: 'C', evidence_ts: '1', scope: kind === 'offer_approval' ? 'TEST scope' : null, notes: null, recorded_by: g.DESTINY, via: 't', test: false, offer_id: kind === 'offer_approval' ? 'OFFER-TEST-1' : null, loop_id: kind === 'offer_approval' ? 'LOOP-1792528168754-FVA9' : null, conditions: kind === 'offer_approval' ? { price: 'TEST' } : null, bundle_ref: kind === 'acceptance_pass' ? 'TEST bundle' : null, created_at: at });
  assert.equal(g.decide('vfarm_stripe_live', null, null).can_charge_live, false);
  assert.match(g.decide('vfarm_stripe_live', null, null).answer, /Hardik's acceptance pass \(on an acceptance bundle\) has not been recorded; Jason's offer_approved event has not been recorded/);
  assert.equal(g.decide('vfarm_stripe_live', row('acceptance_pass', 'green'), null).can_charge_live, false);
  assert.equal(g.decide('vfarm_stripe_live', null, row('offer_approval', 'approved')).can_charge_live, false);
  assert.equal(g.decide('vfarm_stripe_live', row('acceptance_pass', 'red'), row('offer_approval', 'approved')).can_charge_live, false);
  assert.equal(g.decide('vfarm_stripe_live', row('acceptance_pass', 'green'), row('offer_approval', 'withdrawn')).can_charge_live, false);
  const yes = g.decide('vfarm_stripe_live', row('acceptance_pass', 'green'), row('offer_approval', 'approved'));
  assert.equal(yes.can_charge_live, true);
  assert.match(yes.answer, /^Yes, within what Jason approved: offer OFFER-TEST-1, "TEST scope"/);
  assert.equal(g.decide('vfarm_stripe_live', { ...row('acceptance_pass', 'green'), bundle_ref: null }, row('offer_approval', 'approved')).can_charge_live, false);
  assert.equal(g.decide('vfarm_stripe_live', row('acceptance_pass', 'green'), { ...row('offer_approval', 'approved'), conditions: null }).can_charge_live, false);
  assert.match(g.decide('vfarm_stripe_live', null, null).answer, /^No\. The offer is not approved for live charging yet\./);
  ok('yes only with a green pass AND an approved offer; every other combination is no, with the reason');

  // ---------------------------------------------------------------- part 2, local database
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  const wipe = async () => {
    await query(`DELETE FROM engine_events WHERE event_type IN ('charge_gate_recorded', 'offer_approved', 'offer_withdrawn')`);
    await query(`DELETE FROM engine_charge_gate`);
  };
  await wipe();

  const hardikSays = async () => ({ ok: true, user: g.HARDIK });
  const jasonSays = async () => ({ ok: true, user: g.JASON });
  const someoneElse = async () => ({ ok: true, user: 'U0AF011R821' });
  const gone = async () => ({ ok: false, reason: 'not_found', message: 'Slack has no message.' });
  const blind = async () => ({ ok: false, reason: 'unreadable', message: 'Could not read.' });
  const rejectsWith = (p, reason) => assert.rejects(p, (e) => { assert.equal(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.message}`); return true; });

  await rejectsWith(g.recordGate(PASS, { via: 'test', checkMessage: someoneElse }), 'evidence_not_owners');
  await rejectsWith(g.recordGate(PASS, { via: 'test', checkMessage: gone }), 'evidence_not_found');
  await rejectsWith(g.recordGate(PASS, { via: 'test', checkMessage: blind }), 'evidence_unchecked');
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate`)).rows[0].c), 0);
  ok("a message not posted by the owner, missing, or unreadable is refused and writes nothing");

  const dry = await g.recordGate(PASS, { via: 'test', dry_run: true, checkMessage: hardikSays });
  assert.equal(dry.written, false);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate`)).rows[0].c), 0);
  ok('a dry run checks Slack and writes nothing');

  await assert.rejects(query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via) VALUES ('CG-BAD','offer_approval','vfarm_stripe_live','approved','U0AEW3TBYH1','x','C','1','x','sql')`));
  ok('the table itself refuses an offer approval decided by anyone but Jason');

  const testRow = await g.recordGate({ ...PASS, test: true }, { via: 'test', checkMessage: hardikSays });
  assert.equal(testRow.row.test, true);
  assert.equal(testRow.status.acceptance_pass, null);
  ok('a test row is recorded and never counts');

  const p = await g.recordGate(PASS, { via: 'test', checkMessage: hardikSays });
  assert.equal(p.written, true);
  assert.equal(p.status.can_charge_live, false);
  assert.equal(p.status.acceptance_pass.gate_id, p.row.gate_id);
  const ev = await query(`SELECT detail FROM engine_events WHERE event_type = 'charge_gate_recorded' AND dedupe_key = $1`, [`charge_gate:${p.row.gate_id}`]);
  assert.equal(ev.rows.length, 1);
  ok('a green pass alone is recorded, with its one event, and still answers no');

  const o = await g.recordGate(OFFER, { via: 'test', checkMessage: jasonSays });
  assert.equal(o.status.can_charge_live, true);
  const oa = await query(`SELECT subject_id, actor, detail FROM engine_events WHERE event_type = 'offer_approved' AND dedupe_key = $1`, [`offer:${o.row.gate_id}`]);
  assert.equal(oa.rows.length, 1);
  assert.equal(oa.rows[0].subject_id, 'OFFER-TEST-1');
  for (const k of ['offer_id', 'loop_id', 'approver_id', 'timestamp', 'conditions']) assert.ok(oa.rows[0].detail[k], `offer_approved carries ${k}`);
  assert.equal(oa.rows[0].detail.approver_id, g.JASON);
  await assert.rejects(query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via) VALUES ('CG-BAD2','offer_approval','vfarm_stripe_live','approved','U0A9V97949F','x','C','1','x','sql')`));
  ok("a green pass and an approved offer answer yes, with one offer_approved event in Jason's fields; the table refuses an approval without them");

  await new Promise((r) => setTimeout(r, 15));
  const w = await g.recordGate({ ...OFFER, verdict: 'withdrawn', scope: '' }, { via: 'test', checkMessage: jasonSays });
  assert.equal(w.status.can_charge_live, false);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate WHERE test = false`)).rows[0].c), 3);
  ok('withdrawing is a new row; the newest row counts and the answer goes back to no');

  const { readBuyerFlow } = require(path.join(DIST, 'server/src/mcp', 'buyerFlowTools.js'));
  const bf = await readBuyerFlow.handler({}, { access: 'read', agent: 'genie' });
  assert.equal(bf.charge_gate.ok, true);
  assert.equal(bf.charge_gate.can_charge_live, false);
  assert.match(bf.charge_gate.answer, /Jason's newest offer approval is withdrawn/);
  ok('read_buyer_flow carries the charge gate, so Genie reads it with the flow');

  const { readChargeGate, recordChargeGate } = require(path.join(DIST, 'server/src/mcp', 'chargeGateTools.js'));
  const rc = await readChargeGate.handler({}, { access: 'read' });
  assert.equal(rc.can_charge_live, false);
  assert.equal(rc.history.length, 3);
  const agentTry = await recordChargeGate.handler({ ...PASS, requester_user_id: g.DESTINY }, { access: 'write', agent: 'bays' });
  assert.equal(agentTry.reason, 'agent_not_permitted');
  ok('read_charge_gate gives the answer and history; an agent token cannot record');

  await wipe();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
