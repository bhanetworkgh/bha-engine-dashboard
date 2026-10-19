/**
 * A fix awaiting proof is announced when it settles (20 Oct 2026).
 *
 * The repair bridge reports `repaired_pending` when it changed a workflow whose failed run was
 * called by another workflow; a second report under the same repair_id settles it. That second
 * report must be answered in the repair card's own thread in #bha-self-healing, never only a
 * quiet row change. This pins:
 *   - the first report (pending) is not a settle, nor is a repeat of it;
 *   - n8n's report link is validated, refused for an unknown repair, and survives later reports;
 *   - the settle is a reply in the card's thread tagging Destiny, naming the repair, the
 *     workflow, the failed run, the incident and the proof;
 *   - a refused thread reply, or no card recorded, posts in the channel with the reason;
 *   - both refused is recorded as posted: null with the reasons, never silent;
 *   - every settle writes one repair_settled_notified event.
 *
 * Run with:  npm run test:repair-settle   (local DATABASE_URL only)
 */
const assert = require('node:assert/strict');
const http = require('node:http');

const posts = [];
let refuse = new Set();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    posts.push(b);
    const isThread = Boolean(b.thread_ts);
    const no = (isThread && refuse.has('thread')) || (!isThread && refuse.has('channel'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(no ? { ok: false, error: isThread ? 'thread_not_found' : 'not_in_channel' } : { ok: true, ts: '1.2' }));
  });
});

(async () => {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
    console.error('test:repair-settle writes repair rows, so it only runs against a local DATABASE_URL.');
    process.exit(2);
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  const { migrate } = require('../../server-dist/server/src/migrations.js');
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const repairs = require('../../server-dist/server/src/repairs.js');
  await migrate();

  const T = Date.now();
  const rid = (k) => `REP-TEST-${T}-${k}`;
  const exec = (k) => `${T}${k}`;
  const base = (k, outcome, extra = {}) => ({
    repair_id: rid(k), outcome, workflow: { id: 'wf1', name: 'Bays — Submit Actions' }, failed_node: 'Check Logstream Posted',
    error_class: 'schema_validation', error_message: 'Slack refused the LogStream post (invalid_blocks).', execution_id: exec(k),
    version_before: 'v1', version_after: 'v2', ...extra,
  });
  await query(
    `INSERT INTO engine_incidents (natural_id, fields, source, first_seen_at, updated_at, open_now) VALUES ($1, $2::jsonb, 'engine', now(), now(), true)`,
    [`INC-TEST-${T}`, JSON.stringify({ payload: { execution_id: exec('a') } })],
  );

  // 1. The first report is pending: stored, not a settle.
  let r = await repairs.store(base('a', 'repaired_pending'));
  assert.equal(r.inserted, true);
  assert.equal(r.prior_outcome, null);
  assert.equal(r.settled, false, 'a first pending report is not a settle');

  // 2. The same pending report again (n8n retry): still not a settle.
  r = await repairs.store(base('a', 'repaired_pending'));
  assert.equal(r.settled, false, 'a repeated pending report is not a settle');

  // 3. n8n records the card: validated, refused for an unknown repair, kept through later reports.
  const CH = 'C0TESTSELF1';
  await assert.rejects(repairs.recordReportLink({ repair_id: rid('a'), channel: 'U0AEW3TBYH1', ts: '1792451761.123456' }), /channel id/);
  await assert.rejects(repairs.recordReportLink({ repair_id: rid('a'), channel: CH, ts: 'yesterday' }), /message ts/);
  await assert.rejects(repairs.recordReportLink({ repair_id: rid('zz'), channel: CH, ts: '1792451761.123456' }), (e) => e.status === 404);
  const linked = await repairs.recordReportLink({ repair_id: rid('a'), channel: CH, ts: '1792451761.123456' });
  assert.equal(linked.report_link.ts, '1792451761.123456');
  await repairs.store(base('a', 'repaired_pending', { trace: { pattern_status: 'none_on_record' } })); // n8n's trace re-post
  let held = await query(`SELECT payload->'report_link'->>'ts' AS ts, payload->'trace'->>'pattern_status' AS ps FROM engine_repairs WHERE repair_id = $1`, [rid('a')]);
  assert.deepEqual(held.rows[0], { ts: '1792451761.123456', ps: 'none_on_record' }, 'the link survives a whole-record re-post');

  // 4. The settle: pending -> repaired, answered in the card's thread.
  r = await repairs.store(base('a', 'repaired', { proof_execution_id: '43120' }));
  assert.equal(r.prior_outcome, 'repaired_pending');
  assert.equal(r.settled, true, 'pending -> repaired is a settle');
  held = await query(`SELECT payload->'report_link'->>'ts' AS ts FROM engine_repairs WHERE repair_id = $1`, [rid('a')]);
  assert.equal(held.rows[0].ts, '1792451761.123456', 'the link survives the settle report');
  posts.length = 0;
  let n = await repairs.notifySettled(r.repair_id);
  assert.deepEqual(n, { posted: 'thread', error: null });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, CH);
  assert.equal(posts[0].thread_ts, '1792451761.123456', 'the notice is a reply in the card\'s thread');
  const t = posts[0].text;
  assert.ok(t.startsWith('<@U0AEW3TBYH1>'), 'it tags Destiny');
  for (const want of ['Self-heal repair settled: proved', rid('a'), 'Bays — Submit Actions', 'Check Logstream Posted', `failed run ${exec('a')}`, '*Repaired*', 'Proof: execution 43120', `INC-TEST-${T} still shows open`]) {
    assert.ok(t.includes(want), `the notice says "${want}"\n${t}`);
  }

  // 5. A refused thread reply posts in the channel with Slack's reason; a needs_human settle says what to do.
  await repairs.store(base('b', 'repaired_pending'));
  await repairs.recordReportLink({ repair_id: rid('b'), channel: CH, ts: '1792451762.000100' });
  r = await repairs.store(base('b', 'needs_human', { human_action: 'Re-run the failed log by hand.' }));
  assert.equal(r.settled, true);
  refuse = new Set(['thread']);
  posts.length = 0;
  n = await repairs.notifySettled(r.repair_id);
  assert.deepEqual(n, { posted: 'channel', error: null });
  assert.equal(posts.length, 2, 'one refused thread reply, then one channel post');
  assert.equal(posts[1].channel, CH);
  assert.equal(posts[1].thread_ts, undefined);
  assert.ok(posts[1].text.includes('thread was refused') && posts[1].text.includes('thread_not_found'), 'the fallback names Slack\'s reason');
  assert.ok(posts[1].text.includes('What a person needs to do: Re-run the failed log by hand.'));
  assert.ok(posts[1].text.includes('No incident on the board matches'), 'no matching incident is said plainly');

  // 6. No card recorded: posted in #bha-self-healing saying so. Both refused: nothing posted, reasons kept.
  await repairs.store(base('c', 'repaired_pending'));
  r = await repairs.store(base('c', 'not_repaired'));
  refuse = new Set();
  posts.length = 0;
  n = await repairs.notifySettled(r.repair_id);
  assert.deepEqual(n, { posted: 'channel', error: null });
  assert.equal(posts[0].channel, 'C0C3AGDQWDS');
  assert.ok(posts[0].text.includes('was not recorded'));
  await repairs.store(base('d', 'repaired_pending'));
  await repairs.recordReportLink({ repair_id: rid('d'), channel: CH, ts: '1792451763.000100' });
  r = await repairs.store(base('d', 'not_repaired'));
  refuse = new Set(['thread', 'channel']);
  n = await repairs.notifySettled(r.repair_id);
  assert.equal(n.posted, null);
  assert.ok(n.error.includes('thread_not_found') && n.error.includes('not_in_channel'));

  // 7. One event per settle, saying where each went.
  const ev = await query(`SELECT subject_id, detail FROM engine_events WHERE event_type = 'repair_settled_notified' AND subject_id = ANY($1) ORDER BY id`, [[rid('a'), rid('b'), rid('c'), rid('d')]]);
  assert.deepEqual(ev.rows.map((x) => [x.subject_id, x.detail.posted]), [[rid('a'), 'thread'], [rid('b'), 'channel'], [rid('c'), 'channel'], [rid('d'), null]]);
  assert.equal(ev.rows[0].detail.incident_id, `INC-TEST-${T}`);
  assert.equal(ev.rows[0].detail.thread_ts, '1792451761.123456');

  await query(`DELETE FROM engine_repairs WHERE repair_id = ANY($1)`, [[rid('a'), rid('b'), rid('c'), rid('d')]]);
  await query(`DELETE FROM engine_incidents WHERE natural_id = $1`, [`INC-TEST-${T}`]);
  await query(`DELETE FROM engine_events WHERE event_type = 'repair_settled_notified' AND subject_id = ANY($1)`, [[rid('a'), rid('b'), rid('c'), rid('d')]]);
  await closePool();
  server.close();
  console.log('test:repair-settle: 7 checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
