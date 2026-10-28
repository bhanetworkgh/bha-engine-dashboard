/**
 * check_service_balances (28 Oct 2026): the floors, the three states, and every way the n8n read can
 * fail coming back unreadable with a reason, never a number. No database, no network.
 *   npm run test:service-balances
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const sb = require(path.join(__dirname, '..', '..', 'server-dist', 'server', 'src', 'serviceBalances.js'));

let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log(`ok ${n} - ${name}`); });
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

(async () => {
  await ok('floors are the SOP numbers', () => assert.deepEqual({ ...sb.FLOORS_USD }, { openrouter: 15, twilio: 10 }));
  await ok('above the floor is ok', () => {
    const r = sb.fromAnswer({ checked_at: 'x', openrouter: { ok: true, remaining_usd: 28.42, total_credits_usd: 100, total_usage_usd: 71.58, currency: 'USD' }, twilio: { ok: true, remaining_usd: 42.3, currency: 'USD' } });
    assert.equal(r.ok, true); assert.equal(r.openrouter.status, 'ok'); assert.equal(r.twilio.status, 'ok');
    assert.match(r.summary, /OpenRouter: \$28\.42, above the \$15 floor\. Twilio: \$42\.30, above the \$10 floor\./);
  });
  await ok('under the floor is low and says top up', () => {
    const r = sb.fromAnswer({ openrouter: { ok: true, remaining_usd: 1.9 }, twilio: { ok: true, remaining_usd: 9.99 } });
    assert.equal(r.openrouter.status, 'low'); assert.equal(r.twilio.status, 'low'); assert.match(r.summary, /Top it up/);
    assert.equal(r.ok, true);
  });
  await ok('exactly at the floor is ok', () => assert.equal(sb.judge('twilio', { ok: true, remaining_usd: 10 }).status, 'ok'));
  await ok('a failed read is unreadable with its reason and no number', () => {
    const r = sb.fromAnswer({ openrouter: { ok: false, remaining_usd: null, detail: 'The balance could not be read: status 401' }, twilio: { ok: true, remaining_usd: 20 } });
    assert.equal(r.ok, false); assert.equal(r.openrouter.status, 'unreadable'); assert.equal(r.openrouter.remaining_usd, null);
    assert.match(r.summary, /could not be read \(The balance could not be read: status 401\)/);
  });
  await ok('a service missing from the answer is unreadable', () => assert.equal(sb.fromAnswer({ twilio: { ok: true, remaining_usd: 20 } }).openrouter.status, 'unreadable'));
  await ok('a non-USD balance is not judged', () => assert.equal(sb.judge('twilio', { ok: true, remaining_usd: 50, currency: 'GBP' }).status, 'unreadable'));
  process.env.DASHBOARD_INBOUND_KEY = 'k';
  await ok('n8n refusing is unreadable on both', async () => { const r = await sb.check(answer(403, 'Authorization data is wrong!')); assert.equal(r.reason, 'webhook_refused'); assert.equal(r.openrouter.status, 'unreadable'); assert.equal(r.twilio.status, 'unreadable'); });
  await ok('n8n answering garbage is unreadable', async () => assert.equal((await sb.check(answer(200, '<html>'))).reason, 'bad_answer'));
  await ok('n8n unreachable is unreadable', async () => assert.equal((await sb.check(async () => { throw new Error('ECONNREFUSED'); })).reason, 'unreachable'));
  await ok('the key and path are sent', async () => {
    let seen;
    const r = await sb.check(async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify({ openrouter: { ok: true, remaining_usd: 30 }, twilio: { ok: true, remaining_usd: 30 } }) }; });
    assert.ok(seen.url.endsWith('/webhook/engine-service-balances')); assert.equal(seen.init.headers['x-dashboard-key'], 'k'); assert.equal(r.ok, true);
  });
  delete process.env.DASHBOARD_INBOUND_KEY;
  await ok('no key is not_configured and calls nothing', async () => { let called = false; const r = await sb.check(async () => { called = true; }); assert.equal(r.reason, 'not_configured'); assert.equal(called, false); });
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
