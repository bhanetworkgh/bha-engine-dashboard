/**
 * North Star's three code tools (2026-09-24), pinned end to end against the
 * real server, a local database and a stand-in for Slack's Web API, so the
 * source's caps, labels and orders are proved rather than assumed.
 *
 *   read_slack — North Star's own token, never Bays'; DMs, group DMs and
 *     archived channels never read; 72 h default and 168 h cap; channel
 *     filter; batches of ten; a channel Slack refuses is named in
 *     channels_failed; join/leave noise skipped; mentions and links cleaned as
 *     RS - Build Digest does; bot posts cut to 300 and people's to 1,200;
 *     threads expanded newest first, at most 25, replies before the window
 *     and the parent dropped; any-word keywords; newest first; missing_scope
 *     and no channel are ok:false with the source's words.
 *   read_open_loops — Closed dropped; moving / stalled / maybe done / new by
 *     the source's rules; Jason-raised first, then the label order, oldest
 *     first within each; a Slack refusal leaves the loops answered.
 *   get_priority_evidence — the clips, the lane filter on jobs and cards only,
 *     25 / 15 work logs, and the totals.
 *
 * Run with:  npm run test:north-star   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:north-star writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const TOKEN = 'ns-tools-test';
const PORT = 5079;
const T = Date.now();
const nowS = Math.floor(T / 1000);
const ts = (secondsAgo, n = 0) => `${nowS - secondsAgo}.${String(100000 + n).slice(1)}`;
const DAY = 86400;

/* ------------------------------------------------------------ Slack stand-in */

const TAG = String(T).slice(-6);
const ids = { moving: `LOOP-${T}1-MOVE`, stalled: `LOOP-${T}2-STAL`, done: `LOOP-${T}3-DONE`, fresh: `LOOP-${T}4-NEWW`, jason: `LOOP-${T}5-JASN`, closed: `LOOP-${T}6-CLSD` };

let scopeMissing = false;
const auth = [];
const calls = [];
// Twelve member channels (two batches), plus the ones the filter must drop.
const channels = [
  ...Array.from({ length: 11 }, (_, i) => ({ id: `C0${i}`, name: `chan-${i}` })),
  { id: 'CFAIL', name: 'refuses' },
  { id: 'CARCH', name: 'old', is_archived: true },
  { id: 'D0DM', name: 'dm', is_im: true },
  { id: 'G0MP', name: 'mpdm', is_mpim: true },
];
const longText = 'x'.repeat(1_500);
const history = {
  C00: [
    { ts: ts(60, 1), user: 'U0A9V97949F', text: `Hi <@U0AEW3TBYH1>, see <#C123ABC|bha-coordination> and <https://example.com|the doc> or <https://raw.example.com> <!here> — ${ids.moving} is moving` },
    { ts: ts(120, 2), user: 'U0BKT6MAW2Y', text: longText, reply_count: 3, latest_reply: ts(30) },
    { ts: ts(180, 3), bot_id: 'B1', bot_profile: { name: 'Bays' }, text: longText },
    { ts: ts(200, 4), subtype: 'channel_join', user: 'U0AF011R821', text: 'joined' },
  ],
  C01: [{ ts: ts(300, 5), user: 'UNKNOWN1', text: 'vfarm pilot update' }],
};
const replies = {
  [ts(120, 2)]: [
    { ts: ts(120, 2), user: 'U0BKT6MAW2Y', text: 'parent, repeated by Slack' },
    { ts: ts(90, 6), user: 'U0AD1V1D65N', text: 'a reply inside the window' },
    { ts: `${nowS - 400 * DAY}.000001`, user: 'U0AD1V1D65N', text: 'a reply from before the window' },
  ],
};

const slack = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  auth.push(req.headers.authorization);
  calls.push({ method: u.pathname.replace('/api/', ''), at: Date.now(), q: Object.fromEntries(u.searchParams) });
  const send = (b) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  const m = u.pathname.replace('/api/', '');
  if (m === 'users.conversations') {
    if (scopeMissing) return send({ ok: false, error: 'missing_scope' });
    return send({ ok: true, channels });
  }
  if (m === 'conversations.history') {
    const ch = u.searchParams.get('channel');
    if (ch === 'CFAIL') return send({ ok: false, error: 'not_in_channel' });
    const oldest = parseFloat(u.searchParams.get('oldest'));
    return send({ ok: true, messages: (history[ch] || []).filter((x) => parseFloat(x.ts) >= oldest) });
  }
  if (m === 'conversations.replies') return send({ ok: true, messages: replies[u.searchParams.get('ts')] || [] });
  return send({ ok: false, error: 'unknown_method' });
});

/* ------------------------------------------------------------ client */

let rpcId = 0;
function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
async function call(name, args) {
  const r = await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.error) return { rpcError: r.body.error };
  return JSON.parse(r.body.result.content[0].text);
}

(async () => {
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: TOKEN,
    MCP_WRITE_TOKEN: TOKEN,
    DASHBOARD_INBOUND_KEY: 'inbound-for-test',
    RECOVERY_ENABLED: 'false',
    SLACK_API_URL: `http://127.0.0.1:${slack.address().port}/api`,
    SLACK_NORTH_STAR_BOT_TOKEN: 'xoxb-north-star',
    SLACK_BAYS_BOT_TOKEN: 'xoxb-bays-must-not-be-used',
  };
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\//i.test(log) && (await post('/mcp/nope', {}).catch(() => null))) break;
  }
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const passed = [];
  const step = (n) => passed.push(n);
  const BUILDER = `UTEST${TAG}`;
  const LANE = `LANE-TEST-${TAG}`;
  const iso = (daysAgo) => new Date(T - daysAgo * DAY * 1000).toISOString();

  try {
    const tools = (await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t) => t.name);
    for (const t of ['read_slack', 'read_open_loops', 'get_priority_evidence']) assert.ok(tools.includes(t), `lists ${t}`);
    step('the three tools are listed');

    /* ---------------- read_slack ---------------- */
    const t0 = calls.length;
    const rs = await call('read_slack', {});
    assert.equal(rs.ok, true, JSON.stringify(rs));
    assert.equal(rs.window_hours, 72);
    assert.equal(rs.channels_read, 12, 'archived, DM and group DM dropped');
    assert.deepEqual(rs.channels_failed, ['refuses: not_in_channel']);
    const hist = calls.slice(t0).filter((c) => c.method === 'conversations.history');
    assert.equal(hist.length, 12);
    assert.ok(!hist.some((c) => ['CARCH', 'D0DM', 'G0MP'].includes(c.q.channel)));
    assert.equal(hist[0].q.limit, '50');
    assert.ok(hist[10].at - hist[9].at >= 1_400, 'the second batch of ten waits ~1.5 s');
    assert.ok(auth.slice(t0).every((a) => a === 'Bearer xoxb-north-star'), 'North Star’s own token, never Bays’');
    const lc = calls.slice(t0).find((c) => c.method === 'users.conversations').q;
    assert.deepEqual(lc, { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '999' });
    step('read_slack: channels, token, batching, failures named');

    assert.equal(rs.threads_expanded, 1);
    assert.equal(rs.threads_not_expanded, 0);
    const rep = calls.slice(t0).find((c) => c.method === 'conversations.replies').q;
    assert.equal(rep.limit, '50');
    const kinds = rs.messages.map((m) => m.kind);
    assert.deepEqual(rs.messages.map((m) => m.text.slice(0, 20)), [
      `Hi @Destiny Arupi, s`,
      'a reply inside the w',
      'x'.repeat(20),
      'x'.repeat(20),
      'vfarm pilot update',
    ]);
    assert.deepEqual(kinds, ['message', 'thread reply', 'message', 'message', 'message']);
    const first = rs.messages[0];
    assert.equal(first.text, `Hi @Destiny Arupi, see #bha-coordination and the doc (https://example.com) or https://raw.example.com @here — ${ids.moving} is moving`);
    assert.equal(first.author, 'Jason Bays');
    assert.equal(first.channel, '#chan-0');
    assert.match(first.link, /^https:\/\/bayshorizonnetwork\.slack\.com\/archives\/C00\/p\d+$/);
    assert.deepEqual(Object.keys(first).sort(), ['at', 'author', 'channel', 'kind', 'link', 'text']);
    const person = rs.messages.find((m) => m.author === 'Hardik Bhatt');
    assert.equal(person.text.length, 1_200);
    assert.equal(person.replies, 3);
    const bot = rs.messages.find((m) => m.author === 'Bays (bot)');
    assert.equal(bot.text.length, 300);
    assert.equal(rs.messages.find((m) => m.text === 'vfarm pilot update').author, 'UNKNOWN1');
    assert.match(rs.messages[1].link, /\?thread_ts=/);
    assert.ok(!rs.messages.some((m) => /joined|before the window|repeated by Slack/.test(m.text)));
    assert.equal(rs.messages_matched, 5);
    assert.equal(rs.messages_returned, 5);
    assert.equal(rs.truncated, false);
    assert.equal(rs.no_data, false);
    step('read_slack: cleaning, clips, threads, newest first');

    const kw = await call('read_slack', { keywords: 'vfarm, nothing-here', since_hours: 500 });
    assert.equal(kw.window_hours, 168, 'capped at 168');
    assert.deepEqual(kw.messages.map((m) => m.text), ['vfarm pilot update']);
    const one = await call('read_slack', { slack_channel: '#chan-1' });
    assert.equal(one.channels_read, 1);
    const none = await call('read_slack', { slack_channel: 'nope' });
    assert.equal(none.ok, false);
    assert.equal(none.message, 'North Star is not a member of a channel matching "nope".');
    scopeMissing = true;
    const scope = await call('read_slack', {});
    scopeMissing = false;
    assert.equal(scope.ok, false);
    assert.equal(scope.reason, 'missing_scope');
    assert.equal(scope.message, 'Slack refused users.conversations: missing_scope -- the North Star Slack app needs channels:read and groups:read, then a reinstall.');
    step('read_slack: keywords, 168 cap, channel filter, the source’s refusals');

    /* ---------------- read_open_loops ---------------- */
    const loop = (id, what, status, raisedBy, daysAgo) => ({ loop_id: id, What: what, Status: status, 'Raised By': raisedBy, 'Date Raised': iso(daysAgo), 'Assignee Slack User ID': BUILDER });
    const rows = [
      loop(ids.moving, 'moving loop', 'Open', 'Hardik Bhatt', 20),
      loop(ids.stalled, 'stalled loop', 'In Progress', 'Destiny Arupi', 30),
      loop(ids.done, 'maybe done loop', 'Open', 'Kavin', 12),
      loop(ids.fresh, 'new loop', 'Open', 'Kavin', 2),
      loop(ids.jason, 'Jason loop', 'Open', 'Jason Bays', 8),
      loop(ids.closed, 'closed loop', 'Closed', 'Kavin', 40),
      loop(`LOOP-${T}7-OLDR`, 'older stalled loop', 'Open', 'Kavin', 45),
    ];
    for (const f of rows) {
      await query(`INSERT INTO engine_loops (natural_id, builder_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, 'destiny', $2, $3::jsonb, 'engine', $2, $2)`, [f.loop_id, f['Date Raised'], JSON.stringify(f)]);
    }
    await query(
      `INSERT INTO engine_codex_submissions (natural_id, builder_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, 'kavin', '2099-01-01T00:00:00.000Z', $2::jsonb, 'engine', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      [`SUB-${T}`, JSON.stringify({ 'Submission ID': `SUB-${T}`, 'Builder Name': 'Kavin', 'Processed At': iso(1), 'Loops Closed': ids.done, 'Summary': `closed ${ids.done}` })],
    );
    const rol = await call('read_open_loops', { builder_id: BUILDER });
    assert.equal(rol.ok, true, JSON.stringify(rol).slice(0, 500));
    assert.equal(rol.total_open_loops, 6, 'Closed dropped');
    assert.equal(rol.slack_checked, true);
    assert.equal(rol.slack_window_hours, 168);
    assert.ok(rol.work_logs_checked >= 1 && rol.work_logs_checked <= 60);
    const lab = Object.fromEntries(rol.loops.map((l) => [l.loop_id, l.label]));
    assert.equal(lab[ids.moving], 'moving', 'a Slack mention inside 7 days');
    assert.equal(lab[ids.stalled], 'stalled');
    assert.equal(lab[ids.done], 'maybe done', 'a work log closed it');
    assert.equal(lab[ids.fresh], 'new');
    assert.deepEqual(rol.loops.map((l) => l.loop_id), [ids.jason, `LOOP-${T}7-OLDR`, ids.stalled, ids.moving, ids.done, ids.fresh]);
    assert.equal(rol.loops[0].raised_by_jason, true);
    assert.equal(rol.loops[0].owner, BUILDER);
    assert.deepEqual(rol.counts, { stalled: 3, moving: 1, 'maybe done': 1, new: 1 });
    assert.equal(rol.sorted_by, 'Jason-raised first, then stalled, moving, maybe done, new; oldest first within each');
    assert.equal(rol.loops.find((l) => l.loop_id === ids.moving).last_slack_mention.by, 'Jason Bays');
    assert.equal(rol.loops.find((l) => l.loop_id === ids.done).last_log_touch.how, 'closed');
    step('read_open_loops: labels, order, counts');

    scopeMissing = true;
    const rolNoSlack = await call('read_open_loops', { builder_id: BUILDER });
    scopeMissing = false;
    assert.equal(rolNoSlack.ok, true);
    assert.equal(rolNoSlack.slack_checked, false);
    assert.match(rolNoSlack.slack_error, /missing_scope/);
    assert.equal(rolNoSlack.loops.find((l) => l.loop_id === ids.moving).label, 'stalled', 'without Slack, only logs and age decide');
    step('read_open_loops: a Slack refusal leaves the loops answered, and says so');

    /* ---------------- get_priority_evidence ---------------- */
    for (let i = 0; i < 3; i++) {
      await query(`INSERT INTO engine_rt_jobs (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, $2, '2099-01-01T00:00:00.000Z', $3::jsonb, 'engine', $4, $4)`, [
        `JOB-${T}-${i}`, i < 2 ? LANE : 'LANE-OTHER', JSON.stringify({ 'Job ID': `JOB-${T}-${i}`, Lane: i < 2 ? LANE : 'LANE-OTHER', Status: 'Pending', Question: 'q'.repeat(500) }), new Date().toISOString(),
      ]);
    }
    await query(`INSERT INTO engine_commercial_cards (natural_id, lane_id, created_time, fields, source, first_seen_at, updated_at) VALUES ($1, $2, '2099-01-01T00:00:00.000Z', $3::jsonb, 'engine', $4, $4)`, [
      `CARD-${T}`, LANE, JSON.stringify({ card_id: `CARD-${T}`, lane_id: LANE, opportunity_title: 'Test card', next_action: 'n'.repeat(400), missing_research_count: 2 }), new Date().toISOString(),
    ]);
    const all = await call('get_priority_evidence', {});
    assert.equal(all.mode, 'global');
    assert.ok(all.recent_work_logs.length <= 25);
    assert.equal(all.recent_work_logs[0].codex_id, `SUB-${T}`);
    assert.ok(all.lanes_seen.includes(LANE) && all.lanes_seen.includes('LANE-OTHER'));
    const pe = await call('get_priority_evidence', { lane_id: LANE });
    assert.equal(pe.mode, 'single_lane');
    assert.equal(pe.lane_id, LANE);
    assert.ok(pe.recent_work_logs.length <= 15);
    assert.equal(pe.research_jobs_total, 2);
    assert.equal(pe.research_jobs[0].question.length, 403, 'question clipped to 400 + "..."');
    assert.equal(pe.commercial_cards_total, 1);
    assert.equal(pe.commercial_cards[0].next_action.length, 303);
    assert.equal(pe.commercial_cards[0].missing_research_count, 2);
    assert.equal(pe.no_data, false);
    assert.match(pe.source_note, /not filtered by lane/);
    step('get_priority_evidence: clips, lane filter on jobs and cards, 25 / 15 logs');

    const reads = await query(`SELECT endpoint, count(*)::int AS n FROM engine_writes WHERE endpoint IN ('mcp:read_slack','mcp:read_open_loops','mcp:get_priority_evidence') AND outcome = 'read' AND at > $1 GROUP BY 1`, [new Date(T).toISOString()]);
    const n = Object.fromEntries(reads.rows.map((r) => [r.endpoint, r.n]));
    assert.equal(n['mcp:read_slack'], 5);
    assert.equal(n['mcp:read_open_loops'], 2);
    assert.equal(n['mcp:get_priority_evidence'], 2);
    step('every call logged as a read');

    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.log(`test:north-star — ${passed.length} checks passed`);
  } catch (e) {
    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.error(e);
    console.error(log.split('\n').slice(-30).join('\n'));
    process.exitCode = 1;
  } finally {
    await query(`DELETE FROM engine_loops WHERE natural_id LIKE $1`, [`LOOP-${T}%`]).catch(() => {});
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id = $1`, [`SUB-${T}`]).catch(() => {});
    await query(`DELETE FROM engine_rt_jobs WHERE natural_id LIKE $1`, [`JOB-${T}%`]).catch(() => {});
    await query(`DELETE FROM engine_commercial_cards WHERE natural_id = $1`, [`CARD-${T}`]).catch(() => {});
    server.kill();
    await closePool().catch(() => {});
    slack.close();
  }
})();
