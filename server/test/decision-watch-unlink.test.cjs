/**
 * A linked record comes off a Decision Watch (3 Nov 2026, Jason on DW-1793619895309-KUQN),
 * against a local database with Slack stood in. Run with: npm run test:decision-watch-unlink
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:decision-watch-unlink writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/conversations.replies' ? { ok: true, messages: [] } : { ok: true, ts: '1.1', channel: 'C1' }));
  });
});

(async () => {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-bays';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  await req('migrations.js').migrate();
  const { query } = req('pg.js');
  const dw = req('decisionWatch.js');
  const tools = req('mcp/decisionWatchTools.js');

  const T = Date.now();
  const OWNER = 'U0OWNER0002';
  const JASON = 'U0A9V97949F';
  const CH = `C0U${String(T).slice(-7)}`;
  const TASK = `TASK-${T}-UNLINK`;
  const at = (min) => new Date(T + min * 60_000);
  const row = async (id) => (await query(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [id])).rows[0];
  const backlog = (id, status, when) =>
    query(`INSERT INTO engine_lane_backlog (airtable_record_id, natural_id, lane_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, 'CAPITAL', $2::jsonb, 'engine', $3, $3, $3)
           ON CONFLICT (airtable_record_id) DO UPDATE SET fields = EXCLUDED.fields, updated_at = EXCLUDED.updated_at`, [id, JSON.stringify({ task_id: id, status }), when.toISOString()]);
  await query(`INSERT INTO engine_builder_profiles (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', now(), now(), now()) ON CONFLICT DO NOTHING`, [OWNER, JSON.stringify({ user_id: OWNER, name: 'Owner Test' })]);
  await query(`INSERT INTO engine_channel_tracking (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, '{}'::jsonb, 'engine', now(), now(), now()) ON CONFLICT DO NOTHING`, [CH]);

  const base = { decision: 'Four parts owed.', owner_user_id: OWNER, created_by: JASON, created_via: 'test' };
  await backlog(TASK, 'Open', at(0));
  await backlog(`${TASK}2`, 'Open', at(0));
  const opened = await dw.open({ ...base, channel_id: CH, thread_ts: '1791733311.000001', record_kind: 'lane_backlog', record_id: TASK });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const L = opened.watch.watch_id;

  assert.equal((await dw.update(L, OWNER, {}, { unlinkRecord: true })).reason, 'not_permitted', 'an owner cannot remove a way their own watch closes');
  assert.equal((await row(L)).record_id, TASK);

  const un = await dw.update(L, JASON, {}, { unlinkRecord: true });
  assert.equal(un.ok, true);
  assert.equal(un.unlinked, TASK);
  const held = await row(L);
  assert.equal(held.record_id, null);
  assert.equal(held.record_kind, null);
  assert.equal(held.record_hash, null);
  assert.doesNotMatch(dw.show(held).how_it_moves, /closes when it closes/);
  assert.match(held.history.at(-1).what, /no longer linked to backlog task/);
  const again = await dw.update(L, JASON, {}, { unlinkRecord: true });
  assert.equal(again.unlinked, null, 'unlinking twice changes nothing');
  assert.equal((await row(L)).history.length, held.history.length);
  console.log('  ok  only Destiny or Jason can take a record off, and the row and its words change');

  await backlog(TASK, 'Done', at(1));
  const swept = await dw.sweep(at(2), { only: L });
  assert.deepEqual(swept.closed, []);
  assert.equal((await row(L)).status, 'watching', 'the record closing no longer closes the watch');
  assert.equal((await dw.close(L, JASON, 'answered', 'no proof here', at(3))).reason, 'proof_required');
  console.log('  ok  the record closing leaves the watch open, and it still closes only on proof');

  const N = (await dw.open({ ...base, channel_id: null, thread_ts: null, record_kind: 'lane_backlog', record_id: `${TASK}2` })).watch.watch_id;
  assert.equal((await dw.update(N, JASON, {}, { unlinkRecord: true })).reason, 'no_thread');
  assert.equal((await row(N)).record_id, `${TASK}2`);
  console.log('  ok  a watch with no thread keeps the record it reads');

  const deps = { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' };
  const Z = (await dw.open({ ...base, channel_id: CH, thread_ts: '1791733322.000001', record_kind: 'lane_backlog', record_id: `${TASK}2` })).watch.watch_id;
  let t = await tools.updateDecisionWatch.handler({ watch_id: Z, unlink_record: true, dry_run: true, requester_user_id: JASON }, deps);
  assert.equal(t.would_change.unlink_record, true);
  assert.equal((await row(Z)).record_id, `${TASK}2`, 'a dry run changes nothing');
  t = await tools.updateDecisionWatch.handler({ watch_id: Z, unlink_record: true, requester_user_id: JASON }, deps);
  assert.equal(t.ok, true);
  assert.equal(t.watch.record, null);
  const audit = await query(`SELECT outcome, detail FROM engine_mcp_writes WHERE tool = 'update_decision_watch' ORDER BY id DESC LIMIT 1`);
  assert.equal(audit.rows[0].outcome, 'applied');
  assert.match(audit.rows[0].detail, /unlinked/);
  console.log('  ok  the tool previews on a dry run, applies through Bays on Jason\'s word, and is audited');

  await query(`UPDATE engine_decision_watches SET status = 'cancelled' WHERE watch_id = ANY($1)`, [[L, N, Z]]);
  await query(`DELETE FROM engine_lane_backlog WHERE natural_id = ANY($1)`, [[TASK, `${TASK}2`]]);
  await query(`DELETE FROM engine_channel_tracking WHERE natural_id = $1`, [CH]);
  await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [OWNER]);
  srv.close();
  console.log('4 checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
