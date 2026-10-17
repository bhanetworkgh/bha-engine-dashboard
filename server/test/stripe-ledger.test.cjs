/**
 * The Stripe to ledger rail (2026-10-17, D4), against a real local database.
 *
 *   - the signature: Stripe's own scheme verifies, under the right mode; a forged, missing,
 *     stale or other-secret signature is refused by name;
 *   - a paid Checkout session lands on its lead's stripe_payment once, with one event;
 *   - the same Stripe event again is a duplicate and changes nothing;
 *   - a declined card on a payment intent is matched through its session;
 *   - a later failed or expired event never undoes paid;
 *   - an expired link is recorded on its own lead;
 *   - a session naming no lead, an unknown lead, or the wrong buyer id is "unmatched" and
 *     writes nothing onto any lead;
 *   - the read-back returns what was stored.
 *
 * Run with:  npm run test:stripe-ledger   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHmac } = require('node:crypto');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:stripe-ledger writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
process.env.SLACK_API_URL = process.env.SLACK_API_URL || 'http://127.0.0.1:9/'; // nothing listens: alerts fail and are logged, never sent
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

(async () => {
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const sl = req('stripeLedger.js');
  await migrate();

  /* signature, pure */
  const secrets = { test: 'whsec_test_abc', live: 'whsec_live_xyz' };
  const raw = Buffer.from('{"id":"evt_1","livemode":false}');
  const sign = (secret, t, body = raw) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
  const now = 1_792_000_000;
  assert.deepEqual(sl.verify(raw, sign(secrets.test, now), now, secrets), { ok: true, mode: 'test' });
  assert.deepEqual(sl.verify(raw, sign(secrets.live, now), now, secrets), { ok: true, mode: 'live' });
  ok('a Stripe signature verifies, and the secret that did it names the mode');
  assert.equal(sl.verify(raw, sign('whsec_forged', now), now, secrets).reason, 'bad_signature');
  assert.equal(sl.verify(Buffer.from('{"id":"evt_1","livemode":true}'), sign(secrets.test, now), now, secrets).reason, 'bad_signature');
  assert.equal(sl.verify(raw, undefined, now, secrets).reason, 'no_signature');
  assert.equal(sl.verify(raw, 'garbage', now, secrets).reason, 'no_signature');
  assert.equal(sl.verify(raw, sign(secrets.test, now - 301), now, secrets).reason, 'too_old');
  assert.equal(sl.verify(raw, sign(secrets.test, now), now, { test: null, live: null }).reason, 'not_configured');
  ok('forged, tampered, missing, stale and unconfigured are each refused by name');
  assert.equal(sl.next('paid', 'failed'), 'paid');
  assert.equal(sl.next('paid', 'expired'), 'paid');
  assert.equal(sl.next('failed', 'paid'), 'paid');
  ok('paid is never undone by a later event');

  /* a lead to pay against */
  const T = Date.now();
  const BUYER = `VFBUYER-SLTEST-${T}`;
  const clean = async () => {
    await query(`DELETE FROM engine_stripe_events WHERE raw->>'sltest' = '1'`);
    await query(`DELETE FROM engine_events WHERE dedupe_key LIKE 'stripe:evt_sltest_%'`);
    await query(`DELETE FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' LIKE 'VFBUYER-SLTEST-%'`);
  };
  await clean();
  const lead = (
    await query(`INSERT INTO engine_vfarm_leads (full_name, email, source_surface, form_a) VALUES ('SL Test', 'sltest@bhanetwork.org', 'form_a', $1::jsonb) RETURNING id::text AS id`, [JSON.stringify({ buyer_intake_id: BUYER })])
  ).rows[0].id;
  const other = (
    await query(`INSERT INTO engine_vfarm_leads (full_name, email, source_surface, form_a) VALUES ('SL Other', 'slother@bhanetwork.org', 'form_a', $1::jsonb) RETURNING id::text AS id`, [JSON.stringify({ buyer_intake_id: BUYER + '-B' })])
  ).rows[0].id;

  let k = 0;
  const evt = (type, object, extra = {}) => ({ id: `evt_sltest_${T}_${++k}`, object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000), sltest: '1', data: { object }, ...extra });
  const session = (over = {}) => ({ id: `cs_test_sl_${T}`, object: 'checkout.session', client_reference_id: lead, metadata: { buyer_intake_id: BUYER }, payment_status: 'paid', payment_intent: `pi_sl_${T}`, amount_total: 100, currency: 'usd', customer_details: { email: 'sltest@bhanetwork.org' }, ...over });
  const pay = async (id) => (await query(`SELECT stripe_payment FROM engine_vfarm_leads WHERE id::text = $1`, [id])).rows[0].stripe_payment;

  /* declined first: a payment intent fails before any session event is seen */
  const declined = evt('payment_intent.payment_failed', { id: `pi_sl_${T}`, object: 'payment_intent', amount: 100, currency: 'usd', last_payment_error: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } });
  let h = await sl.handle(declined, 'test');
  assert.equal(h.outcome, 'unmatched');
  assert.equal(await pay(lead), null);
  ok('a declined card before its session is known is stored as unmatched and touches no lead');

  /* paid */
  const paid = evt('checkout.session.completed', session());
  h = await sl.handle(paid, 'test');
  assert.equal(h.status, 200);
  assert.equal(h.outcome, 'recorded');
  let p = await pay(lead);
  assert.equal(p.state, 'paid');
  assert.equal(p.mode, 'test');
  assert.equal(p.amount, 100);
  assert.equal(p.session_id, `cs_test_sl_${T}`);
  assert.ok(p.paid_at);
  const ev1 = await query(`SELECT event_type, subject_id FROM engine_events WHERE dedupe_key = $1`, [`stripe:${paid.id}`]);
  assert.equal(ev1.rows.length, 1);
  assert.equal(ev1.rows[0].event_type, 'vfarm_payment_recorded');
  assert.equal(ev1.rows[0].subject_id, BUYER);
  ok('a paid session lands on its lead once, with one vfarm_payment_recorded event');

  /* duplicate */
  h = await sl.handle(paid, 'test');
  assert.equal(h.outcome, 'duplicate');
  assert.equal(h.status, 200);
  const again = await pay(lead);
  assert.deepEqual(again, p);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_stripe_events WHERE event_id = $1`, [paid.id])).rows[0].n, 1);
  ok('the same event twice is one row, a 200 duplicate, and changes nothing');

  /* a later failure on the same intent is matched through the session and does not undo paid */
  const lateFail = evt('payment_intent.payment_failed', { id: `pi_sl_${T}`, object: 'payment_intent', amount: 100, currency: 'usd', last_payment_error: { code: 'card_declined' } });
  h = await sl.handle(lateFail, 'test');
  assert.equal(h.outcome, 'recorded');
  assert.equal(h.lead_id, lead);
  p = await pay(lead);
  assert.equal(p.state, 'paid');
  assert.equal(p.events.length, 2);
  ok('a payment intent event finds its lead through the session, and paid stays paid');

  /* expired on the other lead */
  const expired = evt('checkout.session.expired', { id: `cs_test_sl_exp_${T}`, object: 'checkout.session', client_reference_id: other, metadata: { buyer_intake_id: BUYER + '-B' }, payment_status: 'unpaid', amount_total: 100, currency: 'usd' });
  h = await sl.handle(expired, 'test');
  assert.equal(h.outcome, 'recorded');
  assert.equal((await pay(other)).state, 'expired');
  ok('an expired link is recorded on its own lead as expired, nothing paid');

  /* unmatched */
  h = await sl.handle(evt('checkout.session.completed', session({ id: `cs_test_sl_none_${T}`, client_reference_id: null, metadata: {} })), 'test');
  assert.equal(h.outcome, 'unmatched');
  h = await sl.handle(evt('checkout.session.completed', session({ id: `cs_test_sl_ghost_${T}`, client_reference_id: '00000000-0000-0000-0000-000000000000' })), 'test');
  assert.equal(h.outcome, 'unmatched');
  h = await sl.handle(evt('checkout.session.completed', session({ id: `cs_test_sl_wrong_${T}`, client_reference_id: other })), 'test');
  assert.equal(h.outcome, 'unmatched');
  assert.equal((await pay(other)).state, 'expired');
  ok('no lead, an unknown lead and the wrong buyer id are each unmatched and write onto no lead');

  /* a live event does not overwrite a test payment */
  h = await sl.handle(evt('checkout.session.completed', session({ id: `cs_live_sl_${T}` }), { livemode: true }), 'live');
  assert.equal(h.outcome, 'unmatched');
  assert.equal((await pay(lead)).mode, 'test');
  ok('a live event never overwrites a lead holding a test payment');

  /* not a payment event */
  h = await sl.handle(evt('customer.created', { id: 'cus_1' }), 'test');
  assert.equal(h.outcome, 'ignored');
  ok('an event type the ledger does not read is stored as ignored');

  /* read-back */
  const rb = await sl.readBack({ lead_id: lead });
  assert.equal(rb.payments.length, 1);
  assert.equal(rb.payments[0].buyer_intake_id, BUYER);
  assert.ok(rb.events.some((e) => e.event_id === paid.id && e.outcome === 'recorded'));
  ok('the read-back returns the stored events and the lead payment');

  await clean();
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
