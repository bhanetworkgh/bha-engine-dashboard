/**
 * A fix awaiting proof is announced when it settles (20 Oct 2026).
 *
 * The repair bridge reports `repaired_pending` when it changed a workflow whose failed run was
 * called by another workflow; a second report under the same repair_id settles it. That second
 * report must reach Destiny as a Bays DM, never only a quiet row change. This pins:
 *   - the first report (pending) is not a settle and sends nothing;
 *   - a repeat of the pending report is not a settle either;
 *   - the settle (pending -> repaired) is flagged settled, and the notice is a DM to Destiny
 *     naming the repair, the workflow, the failed run, the incident and the proof;
 *   - a refused DM falls back to #bha-engine-alerts with Slack's reason;
 *   - both refused is recorded as posted: null with both reasons, never silent;
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
    const isDm = String(b.channel).startsWith('U');
    const no = (isDm && refuse.has('dm')) || (!isDm && refuse.has('channel'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(no ? { ok: false, error: isDm ? 'cannot_dm_bot' : 'not_in_channel' } : { ok: true, ts: '1.2' }));
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

  // 3. The settle: pending -> repaired.
  r = await repairs.store(base('a', 'repaired', { proof_execution_id: '43120' }));
  assert.equal(r.prior_outcome, 'repaired_pending');
  assert.equal(r.settled, true, 'pending -> repaired is a settle');
  posts.length = 0;
  let n = await repairs.notifySettled(r.repair_id);
  assert.deepEqual(n, { posted: 'dm', error: null });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'U0AEW3TBYH1', 'the notice is a DM to Destiny');
  const t = posts[0].text;
  for (const want of ['Self-heal repair settled: proved', rid('a'), 'Bays — Submit Actions', 'Check Logstream Posted', `failed run ${exec('a')}`, '*Repaired*', 'Proof: execution 43120', `INC-TEST-${T} still shows open`]) {
    assert.ok(t.includes(want), `the notice says "${want}"\n${t}`);
  }

  // 4. A settle to needs_human carries the person's action; a refused DM falls back to the channel.
  await repairs.store(base('b', 'repaired_pending'));
  r = await repairs.store(base('b', 'needs_human', { human_action: 'Re-run the failed log by hand.' }));
  assert.equal(r.settled, true);
  refuse = new Set(['dm']);
  posts.length = 0;
  n = await repairs.notifySettled(r.repair_id);
  assert.deepEqual(n, { posted: 'channel', error: null });
  assert.equal(posts.length, 2, 'one refused DM, then one channel post');
  assert.equal(posts[1].channel, 'C0ASVQQ8CH3');
  assert.ok(posts[1].text.includes('the DM was refused') && posts[1].text.includes('cannot_dm_bot'), 'the fallback names Slack\'s reason');
  assert.ok(posts[1].text.includes('What a person needs to do: Re-run the failed log by hand.'));
  assert.ok(posts[1].text.includes('No incident on the board matches'), 'no matching incident is said plainly');

  // 5. Both refused: nothing posted, both reasons kept, and the event says so.
  await repairs.store(base('c', 'repaired_pending'));
  r = await repairs.store(base('c', 'not_repaired'));
  refuse = new Set(['dm', 'channel']);
  n = await repairs.notifySettled(r.repair_id);
  assert.equal(n.posted, null);
  assert.ok(n.error.includes('cannot_dm_bot') && n.error.includes('not_in_channel'));

  // 6. One event per settle, saying where each went.
  const ev = await query(`SELECT subject_id, detail FROM engine_events WHERE event_type = 'repair_settled_notified' AND subject_id = ANY($1) ORDER BY id`, [[rid('a'), rid('b'), rid('c')]]);
  assert.deepEqual(ev.rows.map((x) => [x.subject_id, x.detail.posted]), [[rid('a'), 'dm'], [rid('b'), 'channel'], [rid('c'), null]]);
  assert.equal(ev.rows[0].detail.incident_id, `INC-TEST-${T}`);

  await query(`DELETE FROM engine_repairs WHERE repair_id = ANY($1)`, [[rid('a'), rid('b'), rid('c')]]);
  await query(`DELETE FROM engine_incidents WHERE natural_id = $1`, [`INC-TEST-${T}`]);
  await query(`DELETE FROM engine_events WHERE event_type = 'repair_settled_notified' AND subject_id = ANY($1)`, [[rid('a'), rid('b'), rid('c')]]);
  await closePool();
  server.close();
  console.log('test:repair-settle: 6 checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
