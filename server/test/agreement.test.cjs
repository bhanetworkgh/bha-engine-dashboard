/**
 * Stage 4's signed agreement (28 Nov 2026, LOOP-1792401352885-08KI). The pure parts: who gets a test or a
 * real agreement, the v1 text, and what Stage 5 needs from it. No database, no network.
 * Run with:  npm run test:agreement   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ag = require(path.join(DIST, 'server/src', 'agreement.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const V = ag.AGREEMENT_VERSION;
let r = ag.rule('destiny@bhanetwork.org', null);
assert.equal(r.team_test, true); assert.equal(r.can_make_real, false);
ok('a team test lead gets a test agreement, whatever the gate says');

r = ag.rule('shibu@example.com', null);
assert.equal(r.can_make_real, false); assert.match(r.reason, /not approved a live offer/);
ok('a real buyer with no approved offer gets no agreement');

r = ag.rule('shibu@example.com', null, true);
assert.equal(r.can_make_real, false); assert.match(r.reason, /could not be read/);
ok('a charge gate that cannot be read is no');

r = ag.rule('shibu@example.com', { verdict: 'approved', offer_id: 'OFFER-1', conditions: { plan: 'pilot' } });
assert.equal(r.can_make_real, false); assert.match(r.reason, /agreement_version/);
ok('an approved offer that does not name this text version is not Jason\'s yes to it');

r = ag.rule('shibu@example.com', { verdict: 'approved', offer_id: 'OFFER-1', conditions: { agreement_version: V } });
assert.equal(r.can_make_real, false); assert.match(r.reason, /monthly_price_cents/);
ok('an approved offer naming the version but no monthly price is refused');

r = ag.rule('shibu@example.com', { verdict: 'approved', offer_id: 'OFFER-1', conditions: { agreement_version: V, monthly_price_cents: 75000 } });
assert.equal(r.can_make_real, true); assert.equal(r.monthly_cents, 75000); assert.equal(r.offer_id, 'OFFER-1');
ok('an approved offer naming the version and the monthly price makes a real agreement');

r = ag.rule('shibu@example.com', { verdict: 'withdrawn', offer_id: 'OFFER-1', conditions: { agreement_version: V, monthly_price_cents: 75000 } });
assert.equal(r.can_make_real, false);
ok('a withdrawn offer is no');

const p = { setup_name: 'Five greens racks', summary: 'Five NFT racks at the Utica site.', inclusions: ['Install', 'Monitoring'], price_amount: 9000000, currency: 'usd', timeline: null };
const t = ag.termsFor(p, { name: 'Shibu Kamath', organisation: 'Kamath Commercial Properties' }, 75000);
assert.equal(t.deposit_cents, 4500000);
assert.match(t.text, /90,000\.00 USD/); assert.match(t.text, /Deposit at signing: 45,000\.00 USD/); assert.match(t.text, /Balance: 45,000\.00 USD/);
assert.match(t.text, /750\.00 USD for the site/); assert.match(t.text, /Bays Horizon Network LLC/); assert.match(t.text, new RegExp(V));
assert.ok(!/—/.test(t.text), 'no em dashes in the agreement text');
ok('the v1 text states the price, half as deposit, half at commissioning, and the monthly price, with no em dash');

const odd = ag.termsFor({ ...p, price_amount: 101 }, { name: 'A B', organisation: null }, null);
assert.equal(odd.deposit_cents + 50, 101); assert.match(odd.text, /not set \(no approved offer names it\)/);
ok('an odd price splits into whole cents, and a missing monthly price says so rather than guessing');

assert.equal(ag.sha(t.text), ag.sha(ag.termsFor(p, { name: 'Shibu Kamath', organisation: 'Kamath Commercial Properties' }, 75000).text));
ok('the same inputs give the same text and the same fingerprint');

assert.equal(ag.stage5Agreement(null, false).ok, false);
assert.equal(ag.stage5Agreement({ signed: null, test: false }, false).ok, false);
assert.equal(ag.stage5Agreement({ signed: { name: 'x', at: 'y' }, test: true }, false).ok, false);
assert.equal(ag.stage5Agreement({ signed: { name: 'x', at: 'y' }, test: true }, true).ok, true);
assert.equal(ag.stage5Agreement({ signed: { name: 'x', at: 'y' }, test: false }, false).ok, true);
ok('Stage 5 needs a signed agreement; a test agreement counts only for a team test lead');

assert.equal(ag.subscriberIdFor('VFBUYER-FORMA-L42AC9'), 'VFSUB-FORMA-L42AC9');
ok('the subscriber id follows the buyer id');

console.log(`\n${n} checks passed`);
