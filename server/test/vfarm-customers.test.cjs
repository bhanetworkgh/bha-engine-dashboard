/**
 * vFarm customer events (LOOP-1789326230248-ZX0W, 2026-10-11), in process
 * against a real database: the five event types are enforced, a lead writes
 * its event once, and the catalog answers who the subscribers are, their
 * state, lane and spec, when they levelled up, whether a newer config exists
 * and what they last received.
 *
 * Run with:  npm run test:vfarm-customers   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:vfarm-customers writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));

(async () => {
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const ev = req('engineEvents.js');
  const cust = req('vfarmCustomerEvents.js');
  const early = req('earlyAccess.js');
  await migrate();
  let passed = 0;
  const ok = (name) => (passed++, console.log(`  ok  ${name}`));
  const t = Date.now();
  const CAMPAIGN = `test_campaign_${t}`;
  const BUYER = `VFBUYER-TEST-${t}`;
  const SUB = `VFSUB-TEST-${t}`;
  const SUB2 = `VFSUB-TEST-${t}-B`;
  const refused = (e, re) => assert.rejects(() => ev.record(e), (x) => x instanceof ev.EventError && re.test(x.message));

  try {
    await refused({ event_type: 'VFARM_SUBSCRIBER_RENEWED', subject_id: SUB, detail: {} }, /not a vFarm customer event/);
    await refused({ event_type: 'VFARM_LEAD_CAPTURED', subject_id: BUYER, detail: { buyer_intake_id: BUYER } }, /needs detail\.source_campaign, detail\.source_surface/);
    await refused({ event_type: 'VFARM_BUYER_STATE_CHANGED', subject_id: BUYER, detail: { buyer_intake_id: BUYER, new_state: 'paid', source_campaign: CAMPAIGN } }, /"paid" is not one of/);
    await refused({ event_type: 'VFARM_SUBSCRIBER_STATE_CHANGED', subject_id: SUB, detail: { subscriber_id: SUB, new_state: 'active', subscription_lane: 'L' } }, /needs detail\.config_hash, detail\.cad_revision/);
    await refused({ event_type: 'VFARM_SUBSCRIBER_DELIVERY', subject_id: 'someone-else', detail: { subscriber_id: SUB, delivered: 'x', channel: 'email' } }, /subject_id must be/);
    assert.equal((await query(`SELECT 1 FROM engine_events WHERE subject_id = ANY($1)`, [[BUYER, SUB, 'someone-else']])).rowCount, 0);
    ok('a sixth type, a missing field, a value outside the vocabulary and a wrong subject are refused, and nothing is written');

    // Another event family is untouched by the check.
    assert.equal((await ev.record({ event_type: 'VFARM_CHECK_UPDATED', subject_id: `gate-${t}`, detail: {}, dedupe_key: `test-gate-${t}` })).recorded, true);
    ok('other events, the vFarm gate events included, are not held to the customer shapes');

    const lead = await early.storeFormA({ name: 'Test Person', email: `test-${t}@example.org`, buyer_intake_id: BUYER, early_access_lead_id: `VFLEAD-TEST-${t}`, source_campaign: CAMPAIGN, answers: {} });
    await early.storeFormA({ name: 'Test Person', email: `test-${t}@example.org`, buyer_intake_id: BUYER, source_campaign: CAMPAIGN, answers: {} });
    const leadEvents = (await query(`SELECT detail FROM engine_events WHERE event_type = 'VFARM_LEAD_CAPTURED' AND subject_id = $1`, [BUYER])).rows;
    assert.equal(leadEvents.length, 1);
    assert.equal(leadEvents[0].detail.source_campaign, CAMPAIGN);
    assert.equal(JSON.stringify(leadEvents[0].detail).includes('example.org'), false);
    assert.equal(await cust.backfillLeads().then(() => query(`SELECT count(*)::int AS n FROM engine_events WHERE subject_id = $1`, [BUYER])).then((r) => r.rows[0].n), 1);
    ok('a lead writes one VFARM_LEAD_CAPTURED with its campaign and no name or email; a repeat and the backfill add none');

    const rec = (event_type, subject_id, detail, mins) => ev.record({ event_type, subject_id, detail, at: new Date(t - mins * 60e3).toISOString() });
    await rec('VFARM_BUYER_STATE_CHANGED', BUYER, { buyer_intake_id: BUYER, new_state: 'reserved', old_state: 'qualified', source_campaign: CAMPAIGN }, 50);
    await rec('VFARM_SUBSCRIBER_STATE_CHANGED', SUB, { subscriber_id: SUB, new_state: 'active', subscription_lane: 'LANE-VFARM-TEST', buyer_intake_id: BUYER, config_hash: 'sha256:aaa', cad_revision: 'R3' }, 40);
    await rec('VFARM_SUBSCRIBER_DELIVERY', SUB, { subscriber_id: SUB, delivered: 'Week 1 harvest report', channel: 'email' }, 30);
    await rec('VFARM_SUBSCRIBER_STATE_CHANGED', SUB2, { subscriber_id: SUB2, new_state: 'active', subscription_lane: 'LANE-VFARM-TEST', source_campaign: CAMPAIGN, config_hash: 'sha256:aaa', cad_revision: 'R3' }, 25);
    await rec('VFARM_SUBSCRIBER_UPGRADED', SUB2, { subscriber_id: SUB2, from_config_hash: 'sha256:aaa', to_config_hash: 'sha256:bbb', cad_revision: 'R4' }, 20);

    const cat = await cust.catalog({ campaign: CAMPAIGN });
    assert.equal(cat.leads.total, 1);
    assert.equal(cat.leads.by_campaign[CAMPAIGN], 1);
    const a = cat.subscribers.rows.find((x) => x.subscriber_id === SUB);
    const b = cat.subscribers.rows.find((x) => x.subscriber_id === SUB2);
    assert.equal(a.state, 'active');
    assert.equal(a.subscription_lane, 'LANE-VFARM-TEST');
    assert.equal(a.source_campaign, CAMPAIGN, 'attribution follows the lead');
    assert.equal(a.config_hash, 'sha256:aaa');
    assert.equal(a.cad_revision, 'R3');
    assert.equal(a.last_received.delivered, 'Week 1 harvest report');
    assert.equal(a.newer_config_available, 'sha256:bbb');
    assert.equal(b.config_hash, 'sha256:bbb');
    assert.equal(b.cad_revision, 'R4');
    assert.equal(b.upgrades, 1);
    assert.ok(b.levelled_up_at);
    assert.equal(b.newer_config_available, null);
    assert.equal(b.last_received, null);
    ok('the catalog answers who, state, lane, spec, level-up, a newer config and what was last received');

    const one = await cust.catalog({ subscriber_id: SUB });
    assert.equal(one.subscribers.total, 1);
    assert.equal(JSON.stringify(one).includes('example.org'), false);
    ok('one subscriber can be asked for, and no name or email is in the answer');
  } finally {
    await query(`DELETE FROM engine_events WHERE subject_id = ANY($1) OR dedupe_key = $2`, [[BUYER, SUB, SUB2], `test-gate-${t}`]);
    await query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1`, [BUYER]);
  }
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((e) => (console.error(e), process.exit(1)));
