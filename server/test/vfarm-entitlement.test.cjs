/**
 * vFarm entitlement (2026-10-31), in process against a local database.
 *
 *   1. A farm with no record answers found: false, plan null, status pending, the floor named.
 *   2. Refusals write nothing: not Destiny or Jason, an unknown farm or lead, a real lead not at Stage 5.
 *   3. A plan needs Jason's newest approved offer to name it: refused with no offer, no approved
 *      offer, an offer naming no plan, another plan, or an older offer.
 *   4. A dry run writes nothing; a set writes the offer's plan, pilot, dates and limits (a limit not
 *      sent stays null, "not set") and one vfarm_entitlement_set event.
 *   5. A later set changes only what it sends and keeps the record id; bad dates and limits refused.
 *   6. A farm linked to one lead is refused to another; a team test lead's record is marked test.
 *   7. Status is the newest VFARM_SUBSCRIBER_STATE_CHANGED naming the farm.
 *
 * The charge gate's status is stood in (its own test pins it): only the offer it returns matters here.
 * Run with:  npm run test:vfarm-entitlement   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const DESTINY = 'U0AEW3TBYH1';

(async () => {
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const chargeGate = req('chargeGate.js');
  const E = req('vfarmEntitlement.js');
  await migrate();
  let offer = null;
  chargeGate.status = async () => ({ offer_approval: offer });
  const refused = (p, reason) => assert.rejects(p, (e) => e instanceof E.EntitlementError && e.reason === reason, reason);
  const clean = async () => {
    await query(`DELETE FROM engine_vfarm_entitlements WHERE farm_id LIKE 'TESTENT-%'`);
    await query(`DELETE FROM engine_events WHERE subject_id LIKE 'TESTENT-%' OR detail->>'farm_id' LIKE 'TESTENT-%'`);
    await query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' LIKE 'TESTENT-%'`);
    await query(`DELETE FROM engine_vfarm_farms WHERE farm_id LIKE 'TESTENT-%'`);
  };
  const lead = (buyer, email, stage) =>
    query(`INSERT INTO engine_vfarm_leads (full_name, email, source_surface, form_a, stage) VALUES ('Test', $1, 'test', $2::jsonb, $3)`, [email, JSON.stringify({ buyer_intake_id: buyer }), stage]);
  await clean();
  try {
    for (const f of ['TESTENT-A', 'TESTENT-B']) await query(`INSERT INTO engine_vfarm_farms (farm_id, fields, snapshot_at) VALUES ($1, '{}', now())`, [f]);
    await lead('TESTENT-REAL-1', 'buyer1@example.com', 1);
    await lead('TESTENT-TEAM', 'tester@bhanetwork.org', 1);
    await lead('TESTENT-REAL-5', 'buyer5@example.com', 5);

    // 1
    let r = await E.read('TESTENT-A');
    assert.equal(r.found, false); assert.equal(r.plan, null); assert.equal(r.status, 'pending'); assert.deepEqual(r.floor, { plan: 'Monitor', status: 'pending' });
    ok('a farm with no record: found false, plan null, status pending, the floor named');

    // 2
    await refused(E.read(''), 'farm_id_required');
    await refused(E.set({ farm_id: 'TESTENT-A', buyer_intake_id: 'TESTENT-REAL-5', requester_user_id: 'U0AF011R821' }), 'not_permitted');
    await refused(E.set({ farm_id: 'TESTENT-Z', buyer_intake_id: 'TESTENT-REAL-5', requester_user_id: DESTINY }), 'unknown_farm');
    await refused(E.set({ farm_id: 'TESTENT-A', buyer_intake_id: 'TESTENT-NOPE', requester_user_id: DESTINY }), 'unknown_lead');
    await refused(E.set({ farm_id: 'TESTENT-A', buyer_intake_id: 'TESTENT-REAL-1', requester_user_id: DESTINY }), 'not_a_customer');
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_vfarm_entitlements WHERE farm_id LIKE 'TESTENT-%'`)).rows[0].n, 0);
    ok('refused with nothing written: not Destiny or Jason, unknown farm, unknown lead, a real lead not at Stage 5');

    // 3
    const base = { farm_id: 'TESTENT-A', buyer_intake_id: 'TESTENT-REAL-5', requester_user_id: DESTINY };
    await refused(E.set({ ...base, plan: 'Monitor' }), 'offer_required');
    await refused(E.set({ ...base, plan: 'Monitor', offer_id: 'OFFER-1' }), 'no_approved_offer');
    offer = { verdict: 'approved', offer_id: 'OFFER-1', conditions: 'five racks at the agreed price' };
    await refused(E.set({ ...base, plan: 'Monitor', offer_id: 'OFFER-1' }), 'plan_not_on_offer');
    offer = { verdict: 'approved', offer_id: 'OFFER-1', conditions: { plan: 'Monitor' } };
    await refused(E.set({ ...base, plan: 'Automate', offer_id: 'OFFER-1' }), 'plan_mismatch');
    await refused(E.set({ ...base, plan: 'Monitor', offer_id: 'OFFER-0' }), 'not_newest_offer');
    ok('a plan is refused unless Jason\'s newest approved offer names it');

    // 4
    const full = { ...base, plan: 'monitor', offer_id: 'OFFER-1', pilot: true, start_at: '2026-11-15', limits: { racks: 5, devices: null } };
    r = await E.set({ ...full, dry_run: true });
    assert.equal(r.written, false);
    r = await E.set(full);
    assert.equal(r.created, true);
    const e1 = r.entitlement;
    assert.equal(e1.plan, 'Monitor'); assert.equal(e1.pilot, true); assert.deepEqual(e1.limits, { racks: 5, devices: null, users: null }); assert.match(e1.record_id, /^ENT-\d+-[0-9A-F]{4}$/); assert.equal(e1.test, false);
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'vfarm_entitlement_set' AND subject_id = 'TESTENT-A'`)).rows[0].n, 1);
    ok('a dry run writes nothing; the set writes the offer\'s plan, pilot, dates and limits, and one event');

    // 5
    r = await E.set({ ...base, renew_at: '2027-02-15' });
    assert.equal(r.created, false); assert.equal(r.entitlement.record_id, e1.record_id); assert.equal(r.entitlement.plan, 'Monitor'); assert.equal(r.entitlement.limits.racks, 5);
    await refused(E.set({ ...base, renew_at: '2026-01-01' }), 'bad_date');
    await refused(E.set({ ...base, limits: { racks: 0 } }), 'bad_limit');
    ok('a later set changes only what it sends and keeps the record id; bad dates and limits are refused');

    // 6
    await refused(E.set({ farm_id: 'TESTENT-A', buyer_intake_id: 'TESTENT-TEAM', requester_user_id: DESTINY }), 'farm_taken');
    r = await E.set({ farm_id: 'TESTENT-B', buyer_intake_id: 'TESTENT-TEAM', requester_user_id: DESTINY });
    assert.equal(r.entitlement.test, true); assert.equal(r.entitlement.plan, null);
    ok('a farm linked to one lead is refused to another; a team test lead\'s record is marked test');

    // 7
    await query(`INSERT INTO engine_events (event_type, subject_id, lane, actor, detail, at) VALUES ('VFARM_SUBSCRIBER_STATE_CHANGED', 'TESTENT-SUB', 'VFARM', 'test', '{"subscriber_id":"TESTENT-SUB","new_state":"paused","farm_id":"TESTENT-A","subscription_lane":"test"}', now())`);
    r = await E.read('TESTENT-A');
    assert.equal(r.status, 'paused'); assert.equal(r.status_recorded, true);
    ok('status is the newest subscriber state naming the farm');
  } finally {
    await clean();
    await closePool();
  }
  console.log(`\nvfarm-entitlement: ${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
