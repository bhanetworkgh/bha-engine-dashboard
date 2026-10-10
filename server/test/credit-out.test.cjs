/**
 * The credit-out alert (2026-10-10), pinned against a real local database and
 * a Slack stand-in.
 *
 *   - nothing failing on credit posts nothing;
 *   - a Failed ask whose error is a credit refusal posts one alert, naming it;
 *   - more credit failures while the alert stands post nothing more;
 *   - a Failed ask with another error, and an Answered ask that only talks
 *     about credits, are not credit failures;
 *   - an incident classed BILLING_QUOTA and an eval result carrying the error both count;
 *   - an alert Slack refuses is kept as failed with the reason and lands on the next look;
 *   - after 60 quiet minutes the episode is over, and a new failure alerts again.
 *
 * Run with:  npm run test:credit-out   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:credit-out writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

const posts = [];
let refuse = false;
const slack = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (refuse) return res.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
    posts.push(body);
    res.end(JSON.stringify({ ok: true, channel: body.channel, ts: `17917${posts.length}.000100` }));
  });
});

const CREDIT = 'Agent execution failed: This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.';

(async () => {
  const port = await new Promise((r) => slack.listen(0, '127.0.0.1', () => r(slack.address().port)));
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.QUOTA_ALERT_CHANNEL = 'C0ALERTS001';
  process.env.QUOTA_ALERT_MENTIONS = 'U0AEW3TBYH1,U0A9V97949F';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const creditOut = req('creditOut.js');
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  await migrate();

  const T = Date.now();
  const clean = async () => {
    for (const t of ['engine_bays_asks', 'engine_ns_asks', 'engine_rt_asks', 'engine_eval_runs', 'engine_incidents']) await query(`DELETE FROM ${t} WHERE natural_id LIKE 'CREDTEST-%'`);
    await query(`DELETE FROM meta WHERE key = $1`, [creditOut.STATE_KEY]);
    await query(`DELETE FROM engine_events WHERE event_type = 'openrouter_credit_out' AND subject_id LIKE 'CREDTEST-%'`);
  };
  await clean();
  // The clock the test runs on: every row and every look is placed against it.
  let now = new Date();
  const row = async (table, id, fields, minsAgo = 1) => {
    const at = new Date(now.getTime() - minsAgo * 60_000).toISOString();
    await query(`INSERT INTO ${table} (natural_id, fields, source, created_time, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', $3, $3, $3)`, [`CREDTEST-${T}-${id}`, JSON.stringify(fields), at]);
  };

  let r = await creditOut.check(now);
  assert.equal(r.outcome, 'quiet');
  assert.equal(posts.length, 0);
  ok('nothing failing on credit posts nothing');

  await row('engine_bays_asks', 'other', { Outcome: 'Failed', Error: 'Agent execution failed: tool timed out', Source: 'slack_direct' });
  await row('engine_bays_asks', 'talk', { Outcome: 'Answered', Error: '', Question: 'what does exceed your available credits mean', Answer: 'It means payment required.' });
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'quiet');
  assert.equal(posts.length, 0);
  ok('another error, and an answered ask that only talks about credits, are not credit failures');

  await row('engine_bays_asks', 'a1', { Outcome: 'Failed', Error: CREDIT, Source: 'slack_direct' });
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'alerted');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C0ALERTS001');
  assert.match(posts[0].text, /OpenRouter credit is out/);
  assert.match(posts[0].text, /<@U0AEW3TBYH1> <@U0A9V97949F>/);
  assert.match(posts[0].text, new RegExp(`bays ask CREDTEST-${T}-a1 \\(slack_direct\\)`));
  const ev = await query(`SELECT source_ref FROM engine_events WHERE event_type = 'openrouter_credit_out' AND subject_id = $1`, [`CREDTEST-${T}-a1`]);
  assert.equal(ev.rows.length, 1);
  ok('a failed ask whose error is a credit refusal posts one alert, tags both people, and writes one event');

  await row('engine_ns_asks', 'a2', { Outcome: 'Failed', Error: 'Payment required - perhaps check your payment details?' });
  await row('engine_incidents', 'i1', { payload: { error_class: 'BILLING_QUOTA', workflow_or_scenario: 'Bays — Submit Actions' } });
  await row('engine_eval_runs', 'e1', { 'Run ID': 'EVAL-TEST', Passed: false, Checks: JSON.stringify([{ name: 'answered', ok: false, detail: CREDIT }]) });
  const found = await creditOut.hits(new Date(now.getTime() - 15 * 60_000).toISOString());
  const mine = found.filter((h) => h.id.startsWith(`CREDTEST-${T}-`)).map((h) => h.source).sort();
  assert.deepEqual(mine, ['bays ask', 'eval result', 'incident', 'north star ask']);
  ok('a BILLING_QUOTA incident, a North Star ask and an eval result all count');

  r = await creditOut.check(now);
  assert.equal(r.outcome, 'standing');
  assert.equal(posts.length, 1);
  assert.equal(r.state.failures, 4);
  ok('more credit failures while the alert stands post nothing more');

  // 61 minutes later, nothing new: the episode is over.
  now = new Date(now.getTime() + 61 * 60_000);
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'episode_over');
  assert.equal(r.state, null);
  ok('60 quiet minutes ends the episode');

  // A new failure, and Slack refuses the post.
  refuse = true;
  await row('engine_rt_asks', 'a3', { Outcome: 'Failed', Error: CREDIT });
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'failed');
  assert.match(r.state.error, /not_in_channel/);
  assert.equal(posts.length, 1);
  ok('an alert Slack refuses is kept as failed, with Slack\'s reason');

  // Twenty minutes on the failure is out of the window, and the alert is still owed.
  refuse = false;
  now = new Date(now.getTime() + 20 * 60_000);
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'alerted');
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, new RegExp(`research twin ask CREDTEST-${T}-a3`));
  r = await creditOut.check(now);
  assert.equal(r.outcome, 'standing');
  assert.equal(posts.length, 2);
  ok('the owed alert lands on the next look, once, and a new episode alerts again');

  await clean();
  console.log(`\n${passed} checks passed.`);
  slack.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
