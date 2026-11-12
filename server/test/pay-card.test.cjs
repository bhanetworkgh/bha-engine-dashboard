/**
 * Pay figures on the pay review card (12 Nov 2026): the blocks and the merge, pure. No database, no network.
 * SERVER_DIST=<compiled server dir> node server/test/pay-card.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.SERVER_DIST || path.join(__dirname, '..', '..', 'dist-server');
const pc = require(path.join(dist, 'payCard.js'));

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const text = (bs) => bs.map((b) => (b.text && b.text.text) || (b.elements || []).map((e) => e.text).join(' ')).join('\n');

const base = {
  submission_id: 'U0AEW3TBYH1_1', codex_entry_id: 'CODEX-20261111-destiny-arupi-write-door-proof', builder_slack_id: 'U0AEW3TBYH1', builder: 'Destiny Arupi',
  pay_mode: 'Daily', session_date: '2026-11-11', rate: { day_rate_usd: 350, effective_from: '2026-09-01' },
  today: { note_found: true, recommendation: 'custom_fraction', credited: 0.95, held: 0.05, docked: 0, reason_tag: 'NEEDS_LIVE_EVENT', release_condition: 'a real presence alert', credited_usd: 332.5, held_usd: 17.5, docked_usd: 0 },
  releases: [{ history_id: 9, codex_entry_id: 'CODEX-20261110-destiny-arupi-pay-proof-levels', session_date: '2026-11-10', share: 0.25, rate: { day_rate_usd: 350, effective_from: '2026-09-01' }, usd: 87.5, proof_link: 'https://dashboard.bhanetwork.org/codex/x', released_at: '2026-11-11T16:42:00Z' }],
  pay_now_usd: 420, earlier: [{ codex_entry_id: 'CODEX-20261020-a', session_date: '2026-10-20', credited: 1, note_found: false, rate: { day_rate_usd: 350, effective_from: '2026-09-01' }, credited_usd: 350, releases_usd: 0, total_usd: 350 }],
  earlier_total_usd: 350, owed_total_usd: 770, still_held: [{ codex_entry_id: 'CODEX-20261111-destiny-arupi-write-door-proof', session_date: '2026-11-11', share: 0.05, usd: 17.5, condition: 'x' }], month: null, missing_rates: [],
};

ok('usd and pct format', () => {
  assert.equal(pc.usd(332.5), '$332.50');
  assert.equal(pc.usd(1234), '$1,234.00');
  assert.equal(pc.pct(0.95), '95%');
});

ok('daily card shows this session, the release, pay for the card, earlier and all owed in dollars', () => {
  const t = text(pc.blocks(base));
  assert.match(t, /95% of a day = \*\$332\.50\*/);
  assert.match(t, /Held:\* 5% \(\$17\.50\) until a real presence alert/);
  assert.match(t, /25% of a day held on `CODEX-20261110-destiny-arupi-pay-proof-levels` \(10 Nov, \$350\.00\/day\) = \*\$87\.50\*/);
  assert.match(t, /Pay for this card: \$420\.00/);
  assert.match(t, /20 Oct `CODEX-20261020-a`: 100% of a day \(no pay note, full day\) = \$350\.00/);
  assert.match(t, /All owed now: \$770\.00/);
  // The held 5% of this log is in "Held", not repeated as an earlier hold.
  assert.doesNotMatch(t, /Still held on earlier logs/);
});

ok('a paid card shows what it paid and nothing owed from earlier', () => {
  const t = text(pc.blocks(base, { paid: true }));
  assert.match(t, /Paid on this card: \$420\.00/);
  assert.doesNotMatch(t, /Owed from earlier days|All owed now/);
});

ok('a missing rate is said, never guessed', () => {
  const f = { ...base, rate: null, today: { ...base.today, credited_usd: null, held_usd: null, docked_usd: null }, pay_now_usd: null, owed_total_usd: null, missing_rates: ['2026-11-11'] };
  const t = text(pc.blocks(f));
  assert.match(t, /no day rate on record/);
  assert.match(t, /not worked out \(a day rate is missing\)/);
  assert.match(t, /No day rate on record for: 2026-11-11/);
  assert.match(t, /This session \(11 Nov\):\* 95% of a day\n/, 'no dollar figure for a session with no rate');
});

ok('monthly card is shares only, with the month so far', () => {
  const f = { ...base, pay_mode: 'Monthly', rate: null, releases: [], earlier: [], earlier_total_usd: null, owed_total_usd: null, pay_now_usd: null, month: { month: '2026-11', credited_shares: 6.5, released_shares: 0.2, held_shares: 0.3, sessions: 8 } };
  const t = text(pc.blocks(f));
  assert.match(t, /monthly builder, shares of a day/);
  assert.match(t, /2026-11 so far:\* 6\.5 day\(s\) credited across 8 log\(s\), 0\.2 released, 0\.3 still held/);
  assert.doesNotMatch(t, /\$/);
});

ok('merge puts the pay blocks before the buttons and replaces old ones', () => {
  const card = [{ type: 'header' }, { type: 'section', block_id: 'x' }, { type: 'actions', block_id: 'pay_review_actions' }];
  const pay = pc.blocks(base);
  const once = pc.merge(card, pay);
  assert.equal(once[0].type, 'header');
  assert.equal(once[once.length - 1].type, 'actions');
  assert.equal(once.length, card.length + pay.length);
  const twice = pc.merge(once, pay);
  assert.equal(twice.length, once.length, 'a second merge replaces, never stacks');
});

ok('merge on a paid card (no buttons) goes before the closing context', () => {
  const card = [{ type: 'header' }, { type: 'section' }, { type: 'context', block_id: 'paid' }];
  const m = pc.merge(card, pc.blocks(base, { paid: true }));
  assert.equal(m[m.length - 1].block_id, 'paid');
});

console.log(`${n} passed`);
