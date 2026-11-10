/**
 * Rewriting the pay part of a review card in place (10 Nov 2026, reviewCard.ts). No database and no
 * network. Run with:  npm run test:review-card
 *
 *   1. The Suggested pay blocks are replaced and nothing above or below them changes.
 *   2. Each button keeps its first three value parts and gets the new suggestion as the fourth.
 *   3. A card from before LogStream gets a pay part above its buttons.
 *   4. A card with no buttons is refused.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const c = require(path.join(DIST, 'server/src', 'reviewCard.js'));
const p = require(path.join(DIST, 'server/src', 'paySuggest.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const sec = (t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
const oldSug = '|' + JSON.stringify({ r: 'none', s: 'hold', c: 0, h: 1, t: 'LOCAL_ONLY', n: 'old | with a pipe', k: 'merged', l: 'old line' });
const btn = (id) => ({ type: 'button', action_id: id, text: { type: 'plain_text', text: id }, value: 'SUB_1|hardik|' + oldSug });
const card = [
  { type: 'header', text: { type: 'plain_text', text: 'Builder Log Review' } },
  sec('*Verdict: Aligned*'),
  { type: 'divider' },
  sec('*Suggested pay* (from this review, you decide on Approve)\n0 of a day now, 1 held (LOCAL_ONLY)'),
  sec(':red_circle: old flag'),
  sec('*Held until:* old'),
  { type: 'divider' },
  { type: 'actions', block_id: 'review_actions', elements: [btn('approve_log'), btn('add_input_log'), btn('send_back_log')] },
];
const sug = { pay_recommendation: 'custom_fraction', rest: 'hold', credited_share: 0.6, held_share: 0.4, reason_tag: 'PARTIAL_SCOPE', reason_note: 'Credited: finding', release_condition: 'PR 23 merged', line: '0.6 of a day now, 0.4 held (PARTIAL_SCOPE)', flags: [], parts: [{ what: 'finding', status: 'live', missing: [] }], log_class: 'fresh_build' };

const out = c.rebuild(card, sug, 'Scored again.');
assert.deepEqual(out.slice(0, 3), card.slice(0, 3));
const payText = out[3].text.text;
assert.match(payText, /60% of a day now, 40% held \(PARTIAL_SCOPE\)/); assert.ok(!payText.includes('0.6 of a day')); assert.match(payText, /_Scored again\._/);
assert.ok(!JSON.stringify(out).includes('old flag')); assert.equal(out[out.length - 2].type, 'divider');
ok('the Suggested pay part is replaced and the review above it is untouched');

for (const el of out[out.length - 1].elements) {
  assert.ok(el.value.startsWith('SUB_1|hardik||'));
  const parts = el.value.slice('SUB_1|hardik|'.length + 1);
  const j = JSON.parse(parts);
  assert.equal(j.c, 0.6); assert.equal(j.t, 'PARTIAL_SCOPE'); assert.match(j.l, /^60% of a day now/);
}
assert.equal(c.head3('SUB_1|hardik||' + JSON.stringify({ n: 'a|b' })), 'SUB_1|hardik|');
ok('each button keeps its first three parts and opens on the new suggestion');

const before = [card[0], card[1], { type: 'divider' }, card[7]];
const out2 = c.rebuild(before, sug, 'Scored again.');
assert.match(out2[3].text.text, /^\*Suggested pay/); assert.equal(out2[out2.length - 2].type, 'divider'); assert.equal(out2[out2.length - 1].type, 'actions');
ok('a card from before LogStream gets a pay part above its buttons');

assert.throws(() => c.rebuild(card.slice(0, 7), sug, 'x'), (e) => e.reason === 'no_buttons');
ok('a card with no buttons is refused');

assert.equal(p.lineFor({ pay_recommendation: 'custom_fraction', credited_share: 0.8, held_share: 0.2, reason_tag: 'PARTIAL_SCOPE' }), '80% of a day now, 20% held (PARTIAL_SCOPE)');
assert.equal(p.lineFor({ pay_recommendation: 'none', credited_share: 0, docked_share: 1, reason_tag: 'RELOG_OLD_WORK' }), '0% of a day now, 100% docked (RELOG_OLD_WORK)');
assert.equal(p.pct(1 / 3), '33.3%');
ok('shares read as percentages of a day, redrawn from the numbers so an old stored line shows them too');

{
  // 10 Nov 2026: a long review leaves little room; the pay part shrinks in steps until the card fits.
  const big = Array.from({ length: 4 }, (_, i) => sec('x'.repeat(2400) + i));
  const parts = Array.from({ length: 8 }, (_, i) => ({ what: 'part ' + i, new_this_session: true, merged: false, integrated: false, live_event: false, silent_failure: '', evidence: '', proof_level: 0 }));
  const sug = p.suggest({ 'Log Class': 'fresh_build', 'Work Parts': JSON.stringify(parts) });
  const card = [...big, { type: 'divider' }, sec('*Suggested pay* old'), { type: 'divider' }, { type: 'actions', elements: [{ type: 'button', value: 'S|u|' }] }];
  const out = c.fitCard(card, sug, 'why', 'S1');
  assert.ok(out && JSON.stringify(out).length <= 12000);
  assert.ok(out.some((b) => b.type === 'section' && /\*Suggested pay/.test(b.text.text)));
  assert.match(out.find((b) => b.type === 'actions').elements[0].value, /INSUFFICIENT_PROOF/);
  ok('a long card keeps a shorter pay part and the new button suggestion instead of being refused');
}
console.log(`review-card: ${n} passed`);
