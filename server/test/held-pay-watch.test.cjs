/* Held pay watch (18 Nov 2026, D7 part 2): the pure parts, no database, no Slack, no model.
 * SERVER_DIST=<compiled server dir> node server/test/held-pay-watch.test.cjs */
const path = require('path');
const assert = require('assert');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const h = require(path.join(DIST, 'server/src', 'heldPayWatch.js'));

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

const note = (over = {}) => ({
  submission_id: 'sub_1794000000000', codex_entry_id: 'CODEX-1', builder_slack_id: 'U0AHADXXX', held_share: 0.5, credited_share: 0.5,
  release_condition: 'The live Twilio call event for the voicemail path', reason_tag: 'NEEDS_LIVE_EVENT', suggested: null, released_parts: [], decided_at: '2026-11-12T10:00:00Z', ...over,
});
const item = (over = {}) => ({
  kind: 'completion', record: 'loop', id: 'LOOP-1', title: 'CST voicemail path', owner: 'Ahad', changes: ['closed by Ahad (was Open)'],
  why: 'Live call CA123 reached voicemail and the event landed', stands: 'Closed', next: null, link: 'https://dashboard.bhanetwork.org/open-loops/LOOP-1',
  keys: ['change_announce:loop_history:9'], at: '2026-11-18T10:00:00Z', author: 'U0AEW3TBYH1', owner_id: 'U0AHADXXX', ...over,
});

(async () => {
  await check('card ids', () => {
    assert.ok(h.isCardId('HPR-12'));
    assert.ok(!h.isCardId('CCR-12') && !h.isCardId('HPR-x'));
  });
  await check('an item is evidence for its author and its owner', () => {
    const e = h.fromItem(item());
    assert.deepStrictEqual(e.builders.sort(), ['U0AEW3TBYH1', 'U0AHADXXX']);
    assert.ok(e.text.includes('CA123'));
    assert.ok(e.link.startsWith('https://'));
  });
  await check('held parts are the builder\'s only', () => {
    const p = h.partsFor([note(), note({ builder_slack_id: 'U0OTHERXX', submission_id: 'sub_2' }), note({ submission_id: 'sub_3', held_share: 0 })], 'U0AHADXXX');
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].part.share, 0.5);
  });
  await check('parse keeps order and fills misses as not met', () => {
    const v = h.parse('Sure: {"parts":[{"index":1,"met":true,"confidence":"high","why":"x"}]}', 2);
    assert.strictEqual(v[0].met, false);
    assert.strictEqual(v[1].met, true);
    assert.strictEqual(h.parse('no json', 1), null);
  });
  await check('only a met part with high confidence is a match', async () => {
    const e = h.fromItem(item());
    const high = await h.judge(e, [note()], async () => '{"parts":[{"index":0,"met":true,"confidence":"high","why":"the live call is named"}]}');
    assert.strictEqual(high.length, 1);
    assert.strictEqual(high[0].submission_id, 'sub_1794000000000');
    const med = await h.judge(e, [note()], async () => '{"parts":[{"index":0,"met":true,"confidence":"medium","why":"maybe"}]}');
    assert.strictEqual(med.length, 0);
    const no = await h.judge(e, [note()], async () => '{"parts":[{"index":0,"met":false,"confidence":"high","why":"different work"}]}');
    assert.strictEqual(no.length, 0);
  });
  await check('nobody with held pay means the model is not asked', async () => {
    let asked = 0;
    const r = await h.judge(h.fromItem(item({ author: 'U0NOBODYX', owner_id: null })), [note()], async () => { asked++; return '{}'; });
    assert.strictEqual(r.length, 0);
    assert.strictEqual(asked, 0);
  });
  await check('a bad answer throws, so the evidence is asked again', async () => {
    await assert.rejects(() => h.judge(h.fromItem(item()), [note()], async () => 'I think so'));
  });
  await check('the card shows the amount, the evidence and two buttons', () => {
    const m = { submission_id: 'sub_1', codex_entry_id: 'CODEX-1', part: 'voicemail path', share: 0.5, needs: 'live call', met: true, confidence: 'high', why: 'named' };
    const c = h.cardBlocks({ match: m, builder: 'U0AHADXXX', builderName: 'Ahad', rate: 111, rateFrom: '2026-11-19', evidence: h.fromItem(item()) }, 'HPR-7');
    assert.ok(c.text.includes('$55.50'));
    const act = c.blocks.find((b) => b.type === 'actions');
    assert.strictEqual(act.elements.length, 2);
    assert.ok(act.elements.every((b) => b.value === 'HPR-7'));
    const done = h.cardBlocks({ match: m, builder: 'U0AHADXXX', builderName: 'Ahad', rate: null, rateFrom: null, evidence: h.fromItem(item()) }, null, { by: 'U0A9V97949F', at: '2026-11-18T11:00:00Z', released: true, message: 'Released.' });
    assert.ok(!done.blocks.some((b) => b.type === 'actions'));
    assert.ok(done.text.includes('no day rate'));
  });
  await check('the card shows the note first, however long the loop title', () => {
    const m = { submission_id: 'sub_1', codex_entry_id: 'CODEX-1', part: 'p', share: 0.5, needs: 'live call', met: true, confidence: 'high', why: 'named' };
    const c = h.cardBlocks({ match: m, builder: 'U0AHADXXX', builderName: 'Ahad', rate: 111, rateFrom: null, evidence: h.fromItem(item({ title: 'x'.repeat(2000) })) }, 'HPR-7');
    const ev = c.blocks.find((b) => b.text && /The evidence/.test(b.text.text));
    assert.ok(ev.text.text.includes('CA123'));
  });
  console.log(`${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
