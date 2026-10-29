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
// The bundle is held in the evidence store (28 Oct 2026); its own checks are in evidence.test.cjs.
const okBundle = async (id) => ({ ok: true, record: { evidence_id: id, name: 'test-bundle', version: 1, superseded_by: null } });
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

  await rejectsWith(g.recordGate(PASS, { via: 'test', checkBundle: okBundle, checkMessage: someoneElse }), 'evidence_not_owners');
  await rejectsWith(g.recordGate(PASS, { via: 'test', checkBundle: okBundle, checkMessage: gone }), 'evidence_not_found');
  await rejectsWith(g.recordGate(PASS, { via: 'test', checkBundle: okBundle, checkMessage: blind }), 'evidence_unchecked');
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate`)).rows[0].c), 0);
  ok("a message not posted by the owner, missing, or unreadable is refused and writes nothing");

  const dry = await g.recordGate(PASS, { via: 'test', checkBundle: okBundle, dry_run: true, checkMessage: hardikSays });
  assert.equal(dry.written, false);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate`)).rows[0].c), 0);
  ok('a dry run checks Slack and writes nothing');

  await assert.rejects(query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via) VALUES ('CG-BAD','offer_approval','vfarm_stripe_live','approved','U0AEW3TBYH1','x','C','1','x','sql')`));
  ok('the table itself refuses an offer approval decided by anyone but Jason');

  const testRow = await g.recordGate({ ...PASS, test: true }, { via: 'test', checkBundle: okBundle, checkMessage: hardikSays });
  assert.equal(testRow.row.test, true);
  assert.equal(testRow.status.acceptance_pass, null);
  ok('a test row is recorded and never counts');

  const p = await g.recordGate(PASS, { via: 'test', checkBundle: okBundle, checkMessage: hardikSays });
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

  // ROQY (LOOP-1793124602015-ROQY): one decision is one row. Identity: message, kind, rail, verdict, test.
  await wipe();
  const msg = (ts) => `https://bayshorizonnetwork.slack.com/archives/C0AFPJ5S1C1/p${ts}`;
  const rows = async (link) => Number((await query(`SELECT count(*) AS c FROM engine_charge_gate WHERE ($1::text IS NULL OR evidence_link LIKE $1 || '%')`, [link ?? null])).rows[0].c);
  const events = async () => Number((await query(`SELECT count(*) AS c FROM engine_events WHERE event_type = 'charge_gate_recorded'`)).rows[0].c);
  const asHardik = { via: 'test', checkBundle: okBundle, checkMessage: hardikSays };
  const asJason = { via: 'test', checkMessage: jasonSays };

  const idx = await query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'engine_charge_gate_decision'`);
  assert.match(idx.rows[0].indexdef, /UNIQUE INDEX .* \(evidence_channel, evidence_ts, kind, rail, verdict, test\)/);
  ok('migration 105 holds the decision identity as a unique index');

  const A = { ...PASS, evidence_link: msg('1792700000000001') };
  const first = await g.recordGate(A, asHardik);
  assert.equal(first.written, true);
  assert.equal(first.duplicate, false);
  assert.equal(await rows(), 1);
  assert.equal(await events(), 1);
  ok('the first decision writes one row and one event');

  const again = await g.recordGate(A, asHardik);
  assert.equal(again.row.gate_id, first.row.gate_id);
  assert.equal(again.written, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, null);
  assert.equal(await rows(), 1);
  assert.equal(await events(), 1);
  ok('an identical retry returns the same gate_id and writes no row and no event');

  const sameDecision = await g.recordGate({ ...A, evidence_link: `${A.evidence_link}?thread_ts=1792699999.000001&cid=C0AFPJ5S1C1`, notes: 'retried', recorded_by: g.HARDIK }, asHardik);
  assert.equal(sameDecision.row.gate_id, first.row.gate_id);
  assert.equal(sameDecision.duplicate, true);
  assert.equal(sameDecision.row.recorded_by, g.DESTINY, 'the row already held is returned unchanged');
  ok("the link's query, notes and recorder are not the decision: the same gate_id comes back, unchanged");

  await assert.rejects(
    query(`INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, recorded_by, via, bundle_ref) VALUES ('CG-SQL-DUP','acceptance_pass','vfarm_stripe_live','green','U0BKT6MAW2Y','x',$1,$2,'x','sql','TEST')`, [first.row.evidence_channel, first.row.evidence_ts]),
    /duplicate key value violates unique constraint "engine_charge_gate_decision"/,
  );
  ok('the database itself refuses a second row for the same decision, whatever writes it');

  const B = { ...PASS, evidence_link: msg('1792700000000002') };
  const racers = await Promise.all(Array.from({ length: 6 }, () => g.recordGate(B, asHardik)));
  assert.equal(new Set(racers.map((r) => r.row.gate_id)).size, 1);
  assert.equal(racers.filter((r) => r.written).length, 1);
  assert.equal(racers.filter((r) => r.duplicate).length, 5);
  assert.equal(await rows(msg('1792700000000002')), 1);
  assert.equal(await events(), 2);
  ok('six concurrent identical requests land one row, one event and one gate_id');

  await rejectsWith(g.recordGate({ ...B, bundle_ref: 'TEST another bundle' }, asHardik), 'decision_conflict');
  await assert.rejects(g.recordGate({ ...B, bundle_ref: 'TEST another bundle' }, asHardik), (e) => e.extra.existing_gate_id === racers[0].row.gate_id && e.extra.differs.join() === 'bundle_ref');
  assert.equal(await rows(msg('1792700000000002')), 1);
  ok('the same message and verdict with a different bundle is decision_conflict, naming the held gate_id; nothing written');

  const O = { ...OFFER, evidence_link: msg('1792700000000003') };
  const o1 = await g.recordGate(O, asJason);
  const o2 = await g.recordGate({ ...O, conditions: { for: 'Client 2 pilot', price: 'TEST' } }, asJason);
  assert.equal(o2.row.gate_id, o1.row.gate_id);
  assert.equal(o2.duplicate, true);
  await rejectsWith(g.recordGate({ ...O, conditions: { price: 'TEST 2', for: 'Client 2 pilot' } }, asJason), 'decision_conflict');
  await rejectsWith(g.recordGate({ ...O, offer_id: 'OFFER-TEST-2' }, asJason), 'decision_conflict');
  await rejectsWith(g.recordGate({ ...O, scope: 'TEST other scope' }, asJason), 'decision_conflict');
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_events WHERE event_type = 'offer_approved'`)).rows[0].c), 1);
  ok('an offer retried with the same conditions in another key order is the same decision; other conditions, offer or scope are decision_conflict');

  await new Promise((r) => setTimeout(r, 15));
  const red = await g.recordGate({ ...B, verdict: 'red', bundle_ref: null }, asHardik);
  assert.equal(red.written, true);
  assert.notEqual(red.row.gate_id, racers[0].row.gate_id);
  assert.equal(red.status.acceptance_pass.gate_id, red.row.gate_id);
  const oldGreen = await g.recordGate(B, asHardik);
  assert.equal(oldGreen.row.gate_id, racers[0].row.gate_id);
  assert.equal(oldGreen.duplicate, true);
  assert.equal(oldGreen.status.acceptance_pass.gate_id, red.row.gate_id);
  assert.equal(oldGreen.status.acceptance_pass.verdict, 'red');
  ok('a different verdict on the same message is its own row; replaying the older green returns its old row and the newer red still counts');

  const asTest = await g.recordGate({ ...B, test: true }, asHardik);
  assert.equal(asTest.written, true);
  assert.notEqual(asTest.row.gate_id, racers[0].row.gate_id);
  ok('a test row of the same message is its own identity and never blocks or answers for the real one');

  for (const [input, opts, reason] of [
    [{ ...B, recorded_by: 'U0AF011R821' }, asHardik, 'not_permitted'],
    [{ ...B, decided_by: g.JASON }, asHardik, 'not_the_owner'],
    [B, { ...asHardik, checkMessage: someoneElse }, 'evidence_not_owners'],
    [B, { ...asHardik, checkMessage: blind }, 'evidence_unchecked'],
    [B, { ...asHardik, checkBundle: async () => ({ ok: false, reason: 'bundle_not_found', message: 'No evidence record.' }) }, 'bundle_not_found'],
    [{ ...B, bundle_ref: null }, asHardik, 'bundle_required'],
  ]) {
    await assert.rejects(g.recordGate(input, opts), (e) => e.reason === reason && !e.message.includes(racers[0].row.gate_id) && !('existing_gate_id' in e.extra));
  }
  const agentRetry = await recordChargeGate.handler({ ...B, requester_user_id: g.DESTINY }, { access: 'write', agent: 'bays' });
  assert.equal(agentRetry.reason, 'agent_not_permitted');
  assert.equal(JSON.stringify(agentRetry).includes(racers[0].row.gate_id), false);
  ok('a retry that is not authorised or not evidenced is refused before the lookup and never learns the held gate_id');

  const fresh = { ...PASS, evidence_link: msg('1792700000000004') };
  await rejectsWith(g.recordGate({ ...fresh, bundle_ref: null }, asHardik), 'bundle_required');
  await rejectsWith(g.recordGate(fresh, { ...asHardik, checkBundle: async () => ({ ok: false, reason: 'bundle_is_test', message: 'A test record.' }) }), 'bundle_is_test');
  assert.equal(await rows(msg('1792700000000004')), 0);
  ok('without its evidence a green pass writes nothing, and no acceptance_pass exists for that message');

  const dryHeld = await g.recordGate(B, { ...asHardik, dry_run: true });
  assert.equal(dryHeld.duplicate, true);
  assert.equal(dryHeld.row.gate_id, racers[0].row.gate_id);
  await rejectsWith(g.recordGate({ ...B, bundle_ref: 'TEST another bundle' }, { ...asHardik, dry_run: true }), 'decision_conflict');
  const dryNew = await g.recordGate(fresh, { ...asHardik, dry_run: true });
  assert.equal(dryNew.duplicate, false);
  assert.equal(await rows(msg('1792700000000004')), 0);
  ok('a dry run names the held gate_id or the conflict, and writes nothing');

  // A failure after the row is inserted, inside the transaction: the event insert is refused on purpose.
  const C = { ...PASS, evidence_link: msg('1792700000000005') };
  await query(`CREATE OR REPLACE FUNCTION charge_gate_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN IF NEW.source_ref = '${C.evidence_link}' THEN RAISE EXCEPTION 'charge gate test: event refused'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER charge_gate_test_fail BEFORE INSERT ON engine_events FOR EACH ROW EXECUTE FUNCTION charge_gate_test_fail()`);
  const eventsBefore = await events();
  try {
    await assert.rejects(g.recordGate(C, asHardik), /charge gate test: event refused/);
  } finally {
    await query(`DROP TRIGGER IF EXISTS charge_gate_test_fail ON engine_events`);
    await query(`DROP FUNCTION IF EXISTS charge_gate_test_fail()`);
  }
  assert.equal(await rows(msg('1792700000000005')), 0);
  assert.equal(await events(), eventsBefore);
  const retried = await g.recordGate(C, asHardik);
  assert.equal(retried.written, true);
  assert.equal(await rows(msg('1792700000000005')), 1);
  assert.equal(await events(), eventsBefore + 1);
  ok('a failure inside the transaction leaves no row and no event, and the retry writes it exactly once');

  // A lost response, then a retry from a new process (a restart): the gate_id comes from the database, not memory.
  const D = { ...PASS, evidence_link: msg('1792700000000006') };
  const lostResponse = await g.recordGate(D, asHardik);
  const { execFileSync } = require('node:child_process');
  const child = execFileSync(process.execPath, ['-e', `
    const path = require('node:path');
    const g = require(path.join(${JSON.stringify(DIST)}, 'server/src', 'chargeGate.js'));
    const { closePool } = require(path.join(${JSON.stringify(DIST)}, 'server/src', 'pg.js'));
    g.recordGate(${JSON.stringify(D)}, { via: 'test-restart', checkBundle: async (id) => ({ ok: true, record: { evidence_id: id, name: 'test-bundle', version: 1, superseded_by: null } }), checkMessage: async () => ({ ok: true, user: g.HARDIK }) })
      .then(async (r) => { process.stdout.write(JSON.stringify({ gate_id: r.row.gate_id, written: r.written, duplicate: r.duplicate })); await closePool(); })
      .catch((e) => { console.error(e); process.exit(1); });`], { env: process.env, encoding: 'utf8' });
  const restarted = JSON.parse(child.trim().split('\n').pop());
  assert.deepEqual(restarted, { gate_id: lostResponse.row.gate_id, written: false, duplicate: true });
  assert.equal(await rows(msg('1792700000000006')), 1);
  ok('after a lost response, a retry from a fresh process returns the same gate_id');

  // record_charge_gate end to end. The handler asks Slack itself, and slack.ts reads SLACK_API_URL when it
  // loads, so a fresh process runs the handler against a local stand-in on 127.0.0.1 (as codex-reject does).
  const http = require('node:http');
  const { promisify } = require('node:util');
  const execFileP = promisify(require('node:child_process').execFile);
  let author = g.JASON;
  const slackCalls = [];
  const fakeSlack = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => (body += d));
    rq.on('end', () => {
      slackCalls.push(rq.url);
      rs.setHeader('Content-Type', 'application/json');
      if (rq.url === '/__author') {
        author = body;
        return rs.end(JSON.stringify({ ok: true }));
      }
      const p = new URLSearchParams(body);
      rs.end(JSON.stringify(rq.url === '/conversations.replies' ? { ok: true, messages: [{ ts: p.get('latest'), user: author }] } : { ok: false, error: 'unknown_method' }));
    });
  });
  await new Promise((r) => fakeSlack.listen(0, '127.0.0.1', r));
  const slackUrl = `http://127.0.0.1:${fakeSlack.address().port}`;
  const M = { kind: 'offer_approval', verdict: 'approved', decided_by: g.JASON, evidence_link: msg('1792700000000007'), requester_user_id: g.DESTINY, scope: 'TEST scope', offer_id: 'OFFER-TEST-MCP', loop_id: 'LOOP-1792528168754-FVA9', conditions: { price: 'TEST' } };
  let mcp;
  try {
    const out = await execFileP(process.execPath, ['-e', `
      const path = require('node:path');
      const { recordChargeGate } = require(path.join(${JSON.stringify(DIST)}, 'server/src/mcp', 'chargeGateTools.js'));
      const { closePool } = require(path.join(${JSON.stringify(DIST)}, 'server/src', 'pg.js'));
      const M = ${JSON.stringify(M)};
      const call = (a, d = { access: 'write' }) => recordChargeGate.handler(a, d);
      (async () => {
        const s = {};
        s.first = await call(M);
        s.retry = await call(M);
        s.conflict = await call({ ...M, conditions: { price: 'TEST 2' } });
        s.not_permitted = await call({ ...M, requester_user_id: 'U0AF011R821' });
        s.agent = await call(M, { access: 'write', agent: 'bays' });
        await fetch(process.env.SLACK_API_URL + '/__author', { method: 'POST', body: 'U0AF011R821' });
        s.not_author = await call(M);
        await closePool();
        process.stdout.write('\\n' + JSON.stringify(s));
      })().catch((e) => { console.error(e); process.exit(1); });`], { env: { ...process.env, SLACK_API_URL: slackUrl, SLACK_BAYS_BOT_TOKEN: 'xoxb-local-stand-in', SLACK_NORTH_STAR_BOT_TOKEN: '' }, encoding: 'utf8' });
    mcp = JSON.parse(out.stdout.trim().split('\n').pop());
  } finally {
    fakeSlack.close();
  }
  const gid = mcp.first.row.gate_id;
  assert.equal(mcp.first.written, true);
  assert.equal(mcp.first.duplicate, false);
  assert.equal(mcp.retry.row.gate_id, gid);
  assert.equal(mcp.retry.written, false);
  assert.equal(mcp.retry.duplicate, true);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_charge_gate WHERE evidence_link = $1`, [M.evidence_link])).rows[0].c), 1);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_events WHERE event_type = 'charge_gate_recorded' AND source_ref = $1`, [M.evidence_link])).rows[0].c), 1);
  assert.equal(Number((await query(`SELECT count(*) AS c FROM engine_events WHERE event_type = 'offer_approved' AND subject_id = 'OFFER-TEST-MCP'`)).rows[0].c), 1);
  ok('record_charge_gate: a first write, then an identical retry returning the same gate_id, one row and one event of each kind');

  assert.equal(mcp.conflict.ok, false);
  assert.equal(mcp.conflict.reason, 'decision_conflict');
  assert.equal(mcp.conflict.existing_gate_id, gid);
  for (const [k, reason] of [['not_permitted', 'not_permitted'], ['agent', 'agent_not_permitted'], ['not_author', 'evidence_not_owners']]) {
    assert.equal(mcp[k].ok, false);
    assert.equal(mcp[k].reason, reason);
    assert.equal(JSON.stringify(mcp[k]).includes(gid), false, `${k} must not reveal the held gate_id`);
  }
  ok('record_charge_gate: a conflicting retry is refused naming the held gate_id; unauthorised retries are refused and never see it');

  const audits = (await query(
    `SELECT id, outcome, natural_id, guard_result->>'reason' AS reason, coalesce(detail, '') || coalesce(guard_result::text, '') AS said FROM engine_mcp_writes WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [['first', 'retry', 'conflict', 'not_permitted', 'agent', 'not_author'].map((k) => mcp[k].audit_id)],
  )).rows;
  assert.deepEqual(audits.map((a) => a.outcome), ['inserted', 'existing', 'refused', 'refused', 'refused', 'refused']);
  assert.deepEqual(audits.map((a) => a.natural_id), [gid, gid, null, null, null, null]);
  assert.deepEqual(audits.map((a) => a.reason), [null, null, 'decision_conflict', 'not_permitted', 'agent_not_permitted', 'evidence_not_owners']);
  for (const a of audits.slice(3)) assert.equal(a.said.includes(gid), false, 'an unauthorised retry is audited without the held gate_id');
  assert.deepEqual(slackCalls, ['/conversations.replies', '/conversations.replies', '/conversations.replies', '/__author', '/conversations.replies']);
  ok('record_charge_gate is audited inserted, existing, then refused for each refusal; Slack was asked only by requests that passed the rules, and only the local stand-in');

  await wipe();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
