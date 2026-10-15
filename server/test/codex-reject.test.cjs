/**
 * Rejecting a Codex log (2026-10-15), in process against a local database with Slack stood in.
 *
 *   1. A dry run changes nothing and names the cards it would rewrite.
 *   2. Refusals: no requester, not Jason or Destiny, no reason, a log already approved, a log
 *      with a Codex Entry ID. Each writes nothing.
 *   3. Jason rejects: Jason Status Rejected with who, when and why, every other field kept,
 *      stage `rejected`, the review card rewritten without its buttons, each sent-back message
 *      rewritten, one reply to the builder, and one audit line.
 *   4. Rejecting it again is refused (already_rejected).
 *   5. The row is closed to the engine: a PATCH and a POST to it are refused 409 and logged,
 *      and no engine write may set Rejected.
 *   6. A Slack message that cannot be rewritten leaves the log rejected and says so (ok: false).
 *
 * Run with:  npm run test:codex-reject   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const qs = require('node:querystring');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const DESTINY = 'U0AEW3TBYH1', JASON = 'U0A9V97949F', AHAD = 'U0AC6RFNP3P';

const calls = [];
let failUpdatesFor = null;
let history = [];
const slack = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => (b += c));
  rq.on('end', () => {
    const body = (rq.headers['content-type'] || '').includes('json') ? JSON.parse(b || '{}') : qs.parse(b);
    const method = rq.url.replace(/^\//, '');
    calls.push({ method, body });
    rs.setHeader('content-type', 'application/json');
    if (method === 'conversations.history') {
      return rs.end(JSON.stringify({ ok: true, messages: history }));
    }
    if (method === 'chat.update' && failUpdatesFor && body.ts === failUpdatesFor) return rs.end(JSON.stringify({ ok: false, error: 'message_not_found' }));
    rs.end(JSON.stringify({ ok: true, ts: method === 'chat.postMessage' ? '9999.0001' : body.ts }));
  });
});

(async () => {
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${slack.address().port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const mirror = req('mirror.js');
  const engineWrite = req('engineWrite.js');
  const { rejectCodexLogTool } = req('mcp/codexTools.js');
  await migrate();
  const call = (args) => rejectCodexLogTool.handler(args, { access: 'write' });
  const S = 'TESTREJ_1', S2 = 'TESTREJ_2', S3 = 'TESTREJ_3', S4 = 'TESTREJ_4';
  const clean = async () => {
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TESTREJ_%'`);
    await query(`DELETE FROM engine_review_returns WHERE natural_id LIKE 'TESTREJ_%'`);
    await query(`DELETE FROM engine_mcp_writes WHERE tool = 'reject_codex_log' AND arguments->>'log' LIKE 'TESTREJ_%'`);
  };
  const log = (sub, extra = {}) => ({ builder_id: 'ahad', fields: { 'Submission ID': sub, 'Builder User ID': AHAD, 'Jason Status': 'Pending', 'Session Description': 'Test session ' + sub, 'Session Url': 'https://otter.ai/u/' + sub, 'Builder Channel ID': 'CBUILDER', Timestamp: '2026-10-12T10:00:00Z', Summary: 'kept', ...extra } });
  const round = (sub, r, chaser) => mirror.upsert('review_returns', { natural_id: `${sub}::r${r}`, fields: {
    'Return ID': `${sub}::r${r}`, 'Submission ID': sub, Round: String(r), Status: 'answered',
    'Review Channel ID': 'CREVIEW', 'Review Message TS': '1000.0001', 'Builder Channel ID': 'CBUILDER', 'Chaser Message TS': chaser,
    'Review Card Blocks': JSON.stringify([{ type: 'header', text: { type: 'plain_text', text: 'Review' } }, { type: 'actions', elements: [{ type: 'button', action_id: 'approve_log' }] }]),
  } }, 'engine');
  const row = async (sub) => (await query(`SELECT id, fields FROM engine_codex_submissions WHERE natural_id = $1`, [sub])).rows[0];
  await clean();
  try {
    await mirror.upsert('codex', log(S), 'engine');
    await round(S, 1, '2000.0001');
    await round(S, 2, '2000.0002');
    // The channel holds one sent-back message no round recorded, one for another log, and one person's post.
    history = [
      { ts: '2000.0003', bot_id: 'B1', text: ':leftwards_arrow_with_hook: Jason has sent a log back to you. Session recording: https://otter.ai/u/' + S },
      { ts: '2000.0004', bot_id: 'B1', text: 'Jason has sent a log back to you. Session recording: https://otter.ai/u/OTHER' },
      { ts: '2000.0005', user: AHAD, text: 'I sent a log back https://otter.ai/u/' + S },
    ];
    /* 1 */
    calls.length = 0;
    const dry = await call({ log: S, requester_user_id: JASON, reason: 'Newer log covers it', dry_run: true });
    assert.equal(dry.ok, true); assert.equal(dry.rejected, false);
    assert.equal(dry.cards_to_rewrite.length, 4, JSON.stringify(dry.cards_to_rewrite));
    assert.ok(dry.cards_to_rewrite.some((c) => c.ts === '2000.0003'), 'the unrecorded sent-back message was not found');
    assert.equal(dry.builder_channel_read.added, 1);
    assert.equal((await row(S)).fields['Jason Status'], 'Pending');
    assert.equal(calls.filter((c) => c.method !== 'conversations.history').length, 0);
    ok('a dry run changes nothing, writes nothing to Slack, and names the review card, both recorded sent-back messages and the one only the channel holds');
    /* 2 */
    assert.equal((await call({ log: S, reason: 'x y z' })).reason, 'who_is_required');
    assert.equal((await call({ log: S, requester_user_id: AHAD, reason: 'mine' })).reason, 'not_permitted');
    assert.equal((await call({ log: S, requester_user_id: JASON, reason: ' ' })).reason, 'reason_required');
    await mirror.upsert('codex', log(S2, { 'Jason Status': 'Approved' }), 'engine');
    assert.equal((await call({ log: S2, requester_user_id: JASON, reason: 'too late' })).reason, 'already_approved');
    await mirror.upsert('codex', log(S3, { 'Codex Entry ID': 'CODEX-TESTREJ' }), 'engine');
    assert.equal((await call({ log: S3, requester_user_id: JASON, reason: 'in codex' })).reason, 'in_codex');
    assert.equal((await call({ log: 'TESTREJ_NONE', requester_user_id: JASON, reason: 'gone' })).reason, 'not_found');
    assert.equal((await row(S)).fields['Jason Status'], 'Pending');
    assert.equal(calls.filter((c) => c.method !== 'conversations.history').length, 0);
    ok('no requester, a non-admin, no reason, an approved log, a log in the Codex and an unknown log are refused, nothing written');
    /* 3 */
    const r = await call({ log: S, requester_user_id: JASON, reason: 'Your newer log covers what was asked.' });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.rejected, true); assert.equal(r.rejected_by, 'Jason');
    const f = (await row(S)).fields;
    assert.equal(f['Jason Status'], 'Rejected'); assert.equal(f['Rejected By'], 'Jason'); assert.equal(f['Rejected By Slack ID'], JASON);
    assert.equal(f['Rejected Reason'], 'Your newer log covers what was asked.'); assert.ok(f['Rejected At']); assert.equal(f.Summary, 'kept');
    assert.equal(r.entry.stage, 'rejected'); assert.equal(r.entry.rejected.by, 'Jason');
    const upd = calls.filter((c) => c.method === 'chat.update');
    assert.equal(upd.length, 4);
    const card = upd.find((c) => c.body.ts === '1000.0001');
    assert.ok(card.body.blocks.every((b) => b.type !== 'actions'), 'buttons still on the review card');
    assert.ok(card.body.blocks.some((b) => b.type === 'header'), 'review content dropped');
    const reply = calls.filter((c) => c.method === 'chat.postMessage');
    assert.equal(reply.length, 1); assert.equal(reply[0].body.thread_ts, '2000.0003'); assert.match(reply[0].body.text, /<@U0AC6RFNP3P>/);
    const a = (await query(`SELECT outcome FROM engine_mcp_writes WHERE tool = 'reject_codex_log' AND arguments->>'log' = $1 AND outcome = 'applied'`, [S])).rows;
    assert.equal(a.length, 1);
    ok('Jason rejects: status, who, when, why, other fields kept, stage rejected, the card loses its buttons, both sent-back messages rewritten, the builder told, audited');
    /* 4 */
    assert.equal((await call({ log: S, requester_user_id: DESTINY, reason: 'again' })).reason, 'already_rejected');
    ok('rejecting it again is refused');
    /* 5 */
    const ctx = { endpoint: '/api/engine/codex/test', method: 'PATCH', key_label: 'test' };
    const id = String((await row(S)).id);
    await assert.rejects(engineWrite.patchRecord('codex', id, { 'Codex Entry ID': 'CODEX-LATE' }, ctx), (e) => e.status === 409 && /log_rejected/.test(e.message));
    await assert.rejects(engineWrite.postRecord('codex', log(S, { 'Jason Status': 'Approved' }), { ...ctx, method: 'POST' }), (e) => e.status === 409);
    await mirror.upsert('codex', log(S4), 'engine');
    const id4 = String((await row(S4)).id);
    await assert.rejects(engineWrite.patchRecord('codex', id4, { 'Jason Status': 'Rejected' }, ctx), (e) => e.status === 409 && /use_reject_path/.test(e.message));
    assert.equal((await row(S)).fields['Jason Status'], 'Rejected'); assert.equal((await row(S)).fields['Codex Entry ID'], undefined);
    await engineWrite.patchRecord('codex', id4, { Summary: 'other logs still take writes' }, ctx);
    ok('a rejected log is closed to the engine: PATCH and POST refused 409, Rejected cannot be set by an engine write, other logs unaffected');
    /* 6 */
    calls.length = 0; failUpdatesFor = '1000.0001'; history = [];
    await round(S4, 1, '3000.0001');
    const r6 = await call({ log: S4, requester_user_id: DESTINY, reason: 'Test of a card that will not update.' });
    assert.equal(r6.rejected, true); assert.equal(r6.ok, false); assert.equal(r6.raise, true);
    assert.match(r6.message, /review_card \(message_not_found\)/);
    assert.equal((await row(S4)).fields['Jason Status'], 'Rejected');
    ok('a card Slack will not rewrite leaves the log rejected and answers ok: false naming it');
  } finally {
    await clean();
    await closePool();
    slack.close();
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
