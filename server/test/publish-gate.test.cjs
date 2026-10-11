/**
 * The publish check (2026-10-11), against a local database with n8n and Slack
 * stood in. Run with: npm run test:publish-gate
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:publish-gate writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const seen = { runs: [], posts: [] };
let slackOk = true;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/webhook/agent-evals-run') {
      seen.runs.push({ key: req.headers['x-dashboard-key'], ...b });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/chat.postMessage') {
      if (!slackOk) return res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      seen.posts.push(b);
      return res.end(JSON.stringify({ ok: true, channel: b.channel, ts: `1.${seen.posts.length}` }));
    }
    res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
  });
});
(async () => {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  process.env.N8N_API_URL = `http://127.0.0.1:${port}/api/v1`;
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.QUOTA_ALERT_CHANNEL = 'C0ALERTS001';
  process.env.DASHBOARD_INBOUND_KEY = 'test-key';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  await req('migrations.js').migrate();
  const { query } = req('pg.js');
  const gate = req('publishGate.js');
  const T = Date.now();
  const A = `AGENT${T}`;
  let passed = 0;
  const ok = (n) => (passed++, console.log(`  ok  ${n}`));
  const at = (min) => new Date(T + min * 60_000);
  const result = (run, caseId, pass, when) =>
    query(`INSERT INTO engine_eval_runs (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', now()::text, now()::text, $3)`, [
      `${run}:${caseId}`,
      JSON.stringify({ 'Result ID': `${run}:${caseId}`, 'Run ID': run, 'Case ID': caseId, Agent: 'north_star', Passed: pass, 'Run At': when.toISOString(), 'Run Size': 2 }),
      when.toISOString(),
    ]);
  const row = async (v) => (await query(`SELECT * FROM engine_agent_versions WHERE agent_id = $1 AND version_id = $2 ORDER BY id DESC LIMIT 1`, [A, v])).rows[0];
  await query(`UPDATE engine_agent_versions SET eval_state = 'superseded' WHERE eval_state IN ('pending', 'requested')`);
  await query(`UPDATE engine_agent_versions SET requested_at = NULL`);

  // the run before the change: both cases pass
  const R0 = `EVAL-T${T}-0`;
  await result(R0, 'NS-01', true, at(-60));
  await result(R0, 'NS-02', true, at(-59));

  await gate.onVersionChange({ agent_id: A, name: 'North Star test', from: 'v1', to: 'v2', config_hash: 'h2' });
  await query(`UPDATE engine_agent_versions SET seen_at = $2 WHERE agent_id = $1`, [A, at(0).toISOString()]);
  assert.equal((await row('v2')).eval_state, 'pending');
  let r = await gate.sweep(at(1));
  assert.equal(seen.runs.length, 0, 'not asked before it has settled');
  r = await gate.sweep(at(4));
  assert.equal(r.asked, true);
  assert.equal(seen.runs.length, 1);
  assert.equal(seen.runs[0].key, 'test-key');
  assert.equal((await row('v2')).eval_state, 'requested');
  ok('a version change is recorded, and one eval run is asked for once it has settled');

  r = await gate.sweep(at(20));
  assert.equal(r.settled, 0, 'no verdict before a run has finished');
  const R1 = `EVAL-T${T}-1`;
  await result(R1, 'NS-01', true, at(10));
  await result(R1, 'NS-02', false, at(30));
  slackOk = false;
  r = await gate.sweep(at(31));
  let v2 = await row('v2');
  assert.equal(v2.eval_state, 'failed');
  assert.match(v2.eval_detail, /NS-02/);
  assert.equal(v2.alert_state, 'failed', 'an alert Slack refuses is kept as failed');
  slackOk = true;
  r = await gate.sweep(at(33));
  v2 = await row('v2');
  assert.equal(v2.alert_state, 'posted');
  assert.equal(seen.posts.length, 1);
  assert.match(seen.posts[0].text, /publish version `v1` again/);
  await gate.sweep(at(35));
  assert.equal(seen.posts.length, 1, 'one alert per change');
  ok('a case that passed before and fails after is a regression: one alert naming the version to publish again, retried until it posts');

  // rolling back to v1 is recorded as a rollback; the same failure is then known, not a regression
  await gate.onVersionChange({ agent_id: A, name: 'North Star test', from: 'v2', to: 'v1', config_hash: 'h1' });
  await query(`UPDATE engine_agent_versions SET seen_at = $2 WHERE agent_id = $1 AND version_id = 'v1'`, [A, at(40).toISOString()]);
  assert.equal((await row('v1')).is_rollback, true);
  const ev = await query(`SELECT event_type FROM engine_events WHERE subject_id = $1 ORDER BY id`, [A]);
  assert.ok(ev.rows.some((e) => e.event_type === 'agent_rolled_back'));
  await gate.sweep(at(44));
  const R2 = `EVAL-T${T}-2`;
  await result(R2, 'NS-01', true, at(50));
  await result(R2, 'NS-02', false, at(60));
  await gate.sweep(at(61));
  const v1 = await row('v1');
  assert.equal(v1.eval_state, 'passed');
  assert.match(v1.eval_detail, /already failing before/);
  assert.equal(seen.posts.length, 1);
  ok('a rollback is recorded as one, and a case already failing before the change is not called a regression');

  // no run at all
  await gate.onVersionChange({ agent_id: A, name: 'North Star test', from: 'v1', to: 'v3', config_hash: 'h3' });
  await query(`UPDATE engine_agent_versions SET seen_at = $2 WHERE agent_id = $1 AND version_id = 'v3'`, [A, at(100).toISOString()]);
  await gate.sweep(at(104));
  await gate.sweep(at(150));
  assert.equal((await row('v3')).eval_state, 'requested');
  await gate.sweep(at(195));
  assert.equal((await row('v3')).eval_state, 'no_eval');
  assert.equal(seen.posts.length, 2);
  assert.match(seen.posts[1].text, /no eval run behind it/);
  ok('a change with no finished eval run within 90 minutes is said');

  await query(`DELETE FROM engine_eval_runs WHERE natural_id LIKE $1`, [`EVAL-T${T}%`]);
  await query(`DELETE FROM engine_agent_versions WHERE agent_id = $1`, [A]);
  await query(`DELETE FROM engine_events WHERE subject_id = $1`, [A]);
  console.log(`\n${passed} checks passed.`);
  srv.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
