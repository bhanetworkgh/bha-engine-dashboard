/**
 * Genie's ledger skip warning gets a reader (LOOP-1793889625530-M5YH). Part 1: the parser and the rule,
 * no database, on the two real lines from Genie's log (31 Oct and 5 Nov 2026). Part 2: against a LOCAL
 * _test database with Render and Slack stood in: one event per request, the cursor, one alert per window,
 * a refused alert retried, a failed read moving nothing.
 *   npm run test:genie-skip-warn
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
// Part 1 needs no database: stand pg in when it is not installed; part 2 needs the real one.
if (!process.env.DATABASE_URL) {
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'pg') return require.resolve('./_pg-stub.cjs');
    return realResolve.call(this, request, ...rest);
  };
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const g = require(path.join(DIST, 'server/src', 'genieSkipWarn.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

(async () => {
  const real5 = { id: '2db554c4-9570-424c-af26-099e15cbe1bd', timestamp: '2026-11-05T03:03:13.673939821Z', message: 'bha_ledger_query: ledger GET not configured for "rss-feed"; using ask_agent requestId=a38727b3-f43c-4ebb-9847-abfc129d7a40' };
  const real31 = { id: '3f738bc8-37c6-452d-9d1b-52634f71921c', timestamp: '2026-10-31T04:45:29.151497724Z', message: 'bha_ledger_query: ledger GET not configured for "rss-feed"; using ask_agent' };
  const [a] = g.parse(real5);
  assert.equal(a.workspace, 'rss-feed');
  assert.equal(a.fallback, 'ask_agent');
  assert.equal(a.request_id, 'a38727b3-f43c-4ebb-9847-abfc129d7a40');
  const [b] = g.parse(real31);
  assert.equal(b.request_id, null);
  assert.equal(g.dedupeKey(b), 'genie_ledger_skip_warn:log:3f738bc8-37c6-452d-9d1b-52634f71921c');
  ok('the real 5 Nov and 31 Oct lines parse; a line without a request id is keyed on its log line');

  const rec = { id: 'L3', timestamp: '2026-11-10T10:00:00Z', message: JSON.stringify({ msg: 'builder run record', builderRun: { requestId: 'r-1', skipWarns: [{ workspace: 'vfarm' }, 'bha_ledger_query: ledger GET not configured for "codex"; using ask_agent'] } }) };
  const ws = g.parse(rec);
  assert.deepEqual(ws.map((w) => [w.workspace, w.request_id, w.source]), [['vfarm', 'r-1', 'run_record'], ['codex', 'r-1', 'run_record']]);
  assert.equal(g.parse({ id: 'L4', timestamp: 'x', message: JSON.stringify({ msg: 'builder run record', builderRun: { requestId: 'r-2', skipWarns: [] } }) }).length, 0);
  assert.equal(g.parse({ id: 'L5', timestamp: 'x', message: 'planner tool transition' }).length, 0);
  ok("a run record's skipWarns are read, an empty one and an unrelated line give nothing");

  assert.equal(g.dedupeKey({ ...a, log_id: 'other' }), g.dedupeKey(a));
  ok('the warn line and its run record count once per request and workspace');

  assert.deepEqual(g.crossings([{ workspace: 'a', n: 2, request_ids: [] }, { workspace: 'b', n: 3, request_ids: ['x'] }]).map((c) => c.workspace), ['b']);
  assert.match(g.alertText({ workspace: 'rss-feed', n: 3, request_ids: ['x', 'y'] }), /"rss-feed" 3 times.*\n.*`x`, `y`/s);
  ok('only 3 or more in 7 days crosses, and the alert names the workspace and the requests');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\ngenie-skip-warn: ${n} passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  process.env.RENDER_READ_KEY = 'test-key';
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  const wipe = async () => {
    await query(`DELETE FROM engine_events WHERE event_type IN ('genie_ledger_skip_warn', 'genie_skip_warn_alerted')`);
    await query(`DELETE FROM meta WHERE key = $1`, [g.CURSOR_KEY]);
  };
  await wipe();
  let logs = [real31, real5];
  let failRead = false;
  const asked = [];
  const fetcher = async (u) => {
    const q = new URL(u).searchParams;
    asked.push({ text: q.get('text'), start: q.get('startTime') });
    if (failRead) return { ok: false, status: 503, json: async () => ({}) };
    const pat = q.get('text');
    const hit = logs.filter((l) => (pat.includes('ledger GET') ? l.message.includes('ledger GET not configured') : l.message.includes('"skipWarns":[{')));
    return { ok: true, status: 200, json: async () => ({ hasMore: false, logs: hit }) };
  };
  const posts = [];
  let refuse = false;
  const post = async (t) => (refuse ? { ok: false, error: 'channel_not_found' } : (posts.push(t), { ok: true, channel: 'C1', ts: String(posts.length) }));
  const now = new Date('2026-11-10T12:00:00Z');

  let r = await g.pass({ now, fetcher, post });
  assert.equal(r.ok, true);
  assert.equal(r.recorded, 2);
  assert.equal(asked[0].start, new Date(now.getTime() - 29 * 86_400_000).toISOString());
  assert.equal(asked.length, 2 * 29);
  const ev = (await query(`SELECT subject_id, lane, detail FROM engine_events WHERE event_type = 'genie_ledger_skip_warn' ORDER BY at`)).rows;
  assert.deepEqual(ev.map((e) => [e.subject_id, e.lane, e.detail.workspace]), [['render-log:3f738bc8-37c6-452d-9d1b-52634f71921c', 'GENIE', 'rss-feed'], ['a38727b3-f43c-4ebb-9847-abfc129d7a40', 'GENIE', 'rss-feed']]);
  assert.equal(posts.length, 0);
  ok('the first pass reads 29 days back, records both real lines as GENIE events, and two is not an alert');

  asked.length = 0;
  r = await g.pass({ now: new Date(now.getTime() + 60_000), fetcher, post });
  assert.equal(r.recorded, 0);
  assert.equal(r.already, 2);
  assert.equal(asked[0].start, now.toISOString());
  ok('the next pass reads from where the last stopped, and a line read twice is held once');

  logs = [real31, real5, { ...rec, message: JSON.stringify({ msg: 'builder run record', builderRun: { requestId: 'r-9', skipWarns: [{ workspace: 'rss-feed' }] } }) }];
  refuse = true;
  r = await g.pass({ now: new Date(now.getTime() + 120_000), fetcher, post });
  assert.deepEqual(r.alert_failed, ['rss-feed']);
  assert.equal((await query(`SELECT count(*)::int AS c FROM engine_events WHERE event_type = 'genie_skip_warn_alerted'`)).rows[0].c, 0);
  ok('a third fallback crosses; an alert Slack refuses gives its claim back');

  refuse = false;
  r = await g.pass({ now: new Date(now.getTime() + 180_000), fetcher, post });
  assert.deepEqual(r.alerted, ['rss-feed']);
  r = await g.pass({ now: new Date(now.getTime() + 240_000), fetcher, post });
  assert.deepEqual(r.alerted, []);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /"rss-feed" 3 times/);
  ok('the next pass posts the alert once, and it is not posted again in the same window');

  const before = (await query(`SELECT value FROM meta WHERE key = $1`, [g.CURSOR_KEY])).rows[0].value;
  failRead = true;
  r = await g.pass({ now: new Date(now.getTime() + 300_000), fetcher, post });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
  assert.equal((await query(`SELECT value FROM meta WHERE key = $1`, [g.CURSOR_KEY])).rows[0].value, before);
  ok('a read Render refuses moves no cursor, so that span is read again');

  await wipe();
  await closePool();
  console.log(`\ngenie-skip-warn: ${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
