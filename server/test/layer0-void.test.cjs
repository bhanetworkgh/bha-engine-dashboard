/**
 * Voiding a parked log (2026-10-25), in process against a local database with Slack stood in.
 *
 *   1. The recording key ignores the tracking query a URL was pasted with.
 *   2. A dry run changes nothing, finds the Codex log for the same recording and names it as
 *      the replacement.
 *   3. Refusals: no requester, another builder, no reason, a replacement that is not held.
 *      Each writes nothing.
 *   4. The builder voids their own: Status voided with who, when, why and what replaced it,
 *      every other field kept, one reply in the "Log parked" thread, no builder notice, one
 *      audit line, one event. The row is closed, not open, on the page's mapping.
 *   5. Voiding it again is refused (already_voided).
 *   6. The row is closed to the engine: a PATCH is refused 409 log_voided, and no engine
 *      write may set Status voided (use_void_path).
 *   7. Destiny voids another builder's: the builder is told in their log channel.
 *   8. A completed parked log is refused (already_completed).
 *   9. Auto-retire: a Codex log for the same builder and recording voids the parked copy,
 *      replaced by it; another recording's parked log is left alone.
 *  10. A review channel that cannot be read leaves the log voided and says so (ok: false).
 *  11. On an agent token nothing is voided without confirmed: true; the answer asks for the yes.
 *
 * Run with:  npm run test:layer0-void   (needs a LOCAL DATABASE_URL)
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
const DESTINY = 'U0AEW3TBYH1', KAIQI = 'U0AD1V1D65N', AHAD = 'U0AC6RFNP3P';
const REVIEW = 'C0AUKTND199';

const calls = [];
let history = [];
let historyFails = false;
const slack = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => (b += c));
  rq.on('end', () => {
    const body = (rq.headers['content-type'] || '').includes('json') ? JSON.parse(b || '{}') : qs.parse(b);
    const method = rq.url.replace(/^\//, '');
    calls.push({ method, body });
    rs.setHeader('content-type', 'application/json');
    if (method === 'conversations.history') {
      if (historyFails) return rs.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
      return rs.end(JSON.stringify({ ok: true, messages: history }));
    }
    rs.end(JSON.stringify({ ok: true, ts: '9999.' + String(calls.length).padStart(4, '0') }));
  });
});
const tick = () => new Promise((r) => setTimeout(r, 400));

(async () => {
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${slack.address().port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  delete process.env.SLACK_NORTH_STAR_BOT_TOKEN;
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const mirror = req('mirror.js');
  const engineWrite = req('engineWrite.js');
  const layer0Void = req('layer0Void.js');
  const { mapLayer0 } = req('sources.js');
  const { voidParkedLogTool } = req('mcp/layer0Tools.js');
  await migrate();
  const call = (args) => voidParkedLogTool.handler(args, { access: 'write' });
  const URL1 = 'https://otter.ai/u/TESTVOID-rec1';
  const clean = async () => {
    await query(`DELETE FROM engine_layer0_holds WHERE natural_id LIKE 'TESTVOID_%'`);
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE 'TESTVOID_%'`);
    await query(`DELETE FROM engine_mcp_writes WHERE tool = 'void_parked_log' AND (arguments->>'log' LIKE 'TESTVOID_%' OR arguments->>'log' ~ '^[0-9]+$')`);
    await query(`DELETE FROM engine_events WHERE event_type = 'layer0_log_voided' AND subject_id LIKE 'TESTVOID_%'`);
  };
  const park = async (sub, who, url, extra = {}) => {
    const r = await mirror.upsert('layer0', { fields: { 'Submission ID': sub, 'Builder User ID': who, 'Builder Username': 'test builder', Status: 'pending_builder_input', 'Session URL': url, 'Channel ID': 'CBUILDER', 'Session Description': 'Test session ' + sub, 'Missing Fields': '["commercial"]', 'Created At': '2026-10-25T03:34:11.000Z', 'Full Transcript': 'kept', ...extra } }, 'engine');
    return String(r.id);
  };
  const codex = (sub, who, url) => ({ builder_id: who === KAIQI ? 'kaiqi' : 'ahad', fields: { 'Submission ID': sub, 'Builder User ID': who, 'Jason Status': 'Pending', 'Session Url': url, 'Session Description': 'Corrected ' + sub, Timestamp: '2026-10-25T03:44:00Z' } });
  const row = async (id) => (await query(`SELECT id, fields FROM engine_layer0_holds WHERE id = $1`, [id])).rows[0];
  const parkedPost = (id) => ({ ts: `1792899253.${String(id).padStart(6, '0')}`, bot_id: 'BBAYS', text: `<@U0A9V97949F> <@U0AEW3TBYH1> — :hourglass_flowing_sand: *Log parked — waiting on builder input*\n\n*Builder:* <@${KAIQI}>\n*Row:* \`${id}\`` });
  await clean();
  try {
    // 1
    assert.equal(layer0Void.recordingKey('https://otter.ai/u/9XZ2Mm?utm_source=copy_url'), 'otter.ai/u/9XZ2Mm');
    assert.equal(layer0Void.recordingKey('https://Otter.ai/u/9XZ2Mm/'), 'otter.ai/u/9XZ2Mm');
    ok('the recording key ignores the query string, a trailing slash and the host case');

    const A = await park('TESTVOID_1', KAIQI, URL1 + '?utm_source=copy_url');
    await mirror.upsert('codex', codex('TESTVOID_1b', KAIQI, URL1), 'engine');
    await tick(); // the codex upsert above went straight to the mirror, so nothing retired
    history = [parkedPost(A), { ts: '1792899000.000001', bot_id: 'BBAYS', text: '*Log parked* *Row:* `999999`' }];

    // 2
    let r = await call({ log: 'TESTVOID_1', requester_user_id: KAIQI, reason: 'Resubmitted with the commercial note', dry_run: true });
    assert.equal(r.dry_run, true);
    assert.equal(r.replaced_by, 'TESTVOID_1b');
    assert.equal(r.same_recording_in_codex.length, 1);
    assert.equal((await row(A)).fields.Status, 'pending_builder_input');
    ok('a dry run changes nothing and finds the Codex log for the same recording');

    // 3
    for (const [args, reason] of [
      [{ log: A, requester_user_id: '', reason: 'x'.repeat(10) }, 'who_is_required'],
      [{ log: A, requester_user_id: AHAD, reason: 'not mine to void' }, 'not_permitted'],
      [{ log: A, requester_user_id: KAIQI, reason: 'no' }, 'reason_required'],
      [{ log: A, requester_user_id: KAIQI, reason: 'replaced', replaced_by: 'TESTVOID_nope' }, 'replacement_not_found'],
      [{ log: 'TESTVOID_missing', requester_user_id: KAIQI, reason: 'replaced' }, 'not_found'],
    ]) {
      r = await call(args);
      assert.equal(r.ok, false, reason);
      assert.equal(r.reason, reason);
    }
    assert.equal((await row(A)).fields.Status, 'pending_builder_input');
    ok('no requester, another builder, no reason, a missing replacement and an unknown log are refused, nothing written');

    // 4
    calls.length = 0;
    r = await call({ log: A, requester_user_id: KAIQI, reason: 'Resubmitted with the commercial note' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.voided, true);
    const f = (await row(A)).fields;
    assert.equal(f.Status, 'voided');
    assert.equal(f['Status Before Void'], 'pending_builder_input');
    assert.equal(f['Voided By Slack ID'], KAIQI);
    assert.equal(f['Voided Reason'], 'Resubmitted with the commercial note');
    assert.equal(f['Replaced By'], 'TESTVOID_1b');
    assert.ok(f['Voided At']);
    assert.equal(f['Full Transcript'], 'kept');
    const posts = calls.filter((c) => c.method === 'chat.postMessage');
    assert.equal(posts.length, 1, 'only the review-thread reply, no builder notice for their own void');
    assert.equal(posts[0].body.channel, REVIEW);
    assert.equal(posts[0].body.thread_ts, parkedPost(A).ts);
    assert.match(posts[0].body.text, /Voided by/);
    assert.match(posts[0].body.text, /TESTVOID_1b/);
    const audit = await query(`SELECT outcome FROM engine_mcp_writes WHERE tool = 'void_parked_log' AND id = $1`, [r.audit_id]);
    assert.equal(audit.rows[0].outcome, 'applied');
    const ev = await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'layer0_log_voided' AND subject_id = 'TESTVOID_1'`);
    assert.equal(ev.rows[0].n, 1);
    const mapped = mapLayer0({ id: A, createdTime: '', fields: f });
    assert.equal(mapped.open, false);
    assert.equal(mapped.pending_builder_input, false);
    ok('the builder voids their own: fields written, row kept, one thread reply, audited, one event, closed on the page');

    // 5
    r = await call({ log: A, requester_user_id: KAIQI, reason: 'again please' });
    assert.equal(r.reason, 'already_voided');
    ok('voiding it again is refused');

    // 6
    const ctx = { endpoint: '/api/engine/layer0/:id', method: 'PATCH', key_label: 'test' };
    await assert.rejects(engineWrite.patchRecord('layer0', A, { 'Commercial Answer': 'late', Status: 'completed' }, ctx), (e) => e.status === 409 && /log_voided/.test(e.message));
    const B = await park('TESTVOID_2', AHAD, 'https://otter.ai/u/TESTVOID-rec2');
    await assert.rejects(engineWrite.patchRecord('layer0', B, { Status: 'voided' }, ctx), (e) => e.status === 409 && /use_void_path/.test(e.message));
    assert.equal((await row(A)).fields.Status, 'voided');
    ok('a voided row is closed to engine writes, and no engine write may set voided');

    // 7
    history = [parkedPost(B)];
    calls.length = 0;
    r = await call({ log: 'TESTVOID_2', requester_user_id: DESTINY, reason: 'Duplicate of a log already approved' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.voided_by, 'Destiny');
    assert.equal(r.replaced_by, null);
    const told = calls.filter((c) => c.method === 'chat.postMessage' && c.body.channel === 'CBUILDER');
    assert.equal(told.length, 1);
    assert.match(told[0].body.text, new RegExp(`<@${AHAD}>`));
    ok('Destiny voids another builder\'s parked log and the builder is told in their log channel');

    // 8
    const C = await park('TESTVOID_3', AHAD, 'https://otter.ai/u/TESTVOID-rec3', { Status: 'completed' });
    r = await call({ log: C, requester_user_id: DESTINY, reason: 'tidy up' });
    assert.equal(r.reason, 'already_completed');
    ok('a completed parked log is refused');

    // 9
    const D = await park('TESTVOID_4', KAIQI, 'https://otter.ai/u/TESTVOID-rec4?utm_source=copy_url');
    const E = await park('TESTVOID_5', KAIQI, 'https://otter.ai/u/TESTVOID-other');
    history = [parkedPost(D)];
    await engineWrite.postRecord('codex', codex('TESTVOID_4b', KAIQI, 'https://otter.ai/u/TESTVOID-rec4'), { endpoint: '/api/engine/codex', method: 'POST', key_label: 'test' });
    await tick();
    const dRow = (await row(D)).fields;
    assert.equal(dRow.Status, 'voided');
    assert.equal(dRow['Replaced By'], 'TESTVOID_4b');
    assert.match(dRow['Voided By'], /auto-retire/);
    assert.equal((await row(E)).fields.Status, 'pending_builder_input');
    ok('a Codex log for the same recording retires the parked copy; another recording is left alone');

    // 10
    historyFails = true;
    r = await call({ log: E, requester_user_id: KAIQI, reason: 'Session merged into another log' });
    assert.equal(r.voided, true);
    assert.equal(r.ok, false);
    assert.equal(r.raise, true);
    assert.match(r.message, /not_in_channel/);
    assert.equal((await row(E)).fields.Status, 'voided');
    historyFails = false;
    ok('a review channel that cannot be read leaves the log voided and says so');

    // 11
    const F = await park('TESTVOID_6', KAIQI, 'https://otter.ai/u/TESTVOID-rec6');
    history = [parkedPost(F)];
    const asAgent = (args) => voidParkedLogTool.handler(args, { access: 'write', agent: 'bays' });
    calls.length = 0;
    r = await asAgent({ log: F, requester_user_id: DESTINY, reason: 'Resent and went through' });
    assert.equal(r.voided, false);
    assert.equal(r.needs_confirmation, true);
    assert.match(r.note, /confirmed: true/);
    assert.equal((await row(F)).fields.Status, 'pending_builder_input');
    assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0);
    r = await asAgent({ log: F, requester_user_id: DESTINY, reason: 'Resent and went through', confirmed: true });
    assert.equal(r.voided, true, JSON.stringify(r));
    assert.equal((await row(F)).fields.Status, 'voided');
    ok('on an agent token nothing is voided until confirmed: true, and the first answer asks for the yes');

  } finally {
    await clean();
    await closePool();
    slack.close();
  }
  console.log(`\nlayer0-void: ${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
