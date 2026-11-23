/**
 * read_slack's thread mode (23 Nov 2026): one thread read whole, each person's
 * message in full, so a decision can be copied word for word. Against a Slack
 * stand-in; no database (readSlackThread logs nothing itself).
 *
 * Run with:  npm run test:slack-thread
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = '1795434107.741089';
const long = 'Decision: ' + 'word '.repeat(700) + 'END'; // ~3,500 chars, past the 1,200 search cut
const msgs = [
  { ts: ROOT, user: 'U0A9V97949F', text: 'Locking two decisions <@U0ADAEB9JTH>', thread_ts: ROOT, reply_count: 3 },
  { ts: '1795434200.000100', user: 'U0A9V97949F', text: long, thread_ts: ROOT },
  { ts: '1795434300.000100', bot_id: 'B1', bot_profile: { name: 'Genie' }, text: 'b'.repeat(6_000), thread_ts: ROOT },
  { ts: '1795434400.000100', subtype: 'channel_join', user: 'U1', text: 'joined', thread_ts: ROOT },
];
const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const q = new URLSearchParams(req.url.split('?')[1] || body);
    calls.push({ path: req.url.split('?')[0], ts: q.get('ts'), channel: q.get('channel') });
    res.setHeader('content-type', 'application/json');
    if (q.get('channel') === 'CNOTIN') return res.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
    if (q.get('ts') === '1795434200.000100') return res.end(JSON.stringify({ ok: true, messages: [msgs[1]] }));
    res.end(JSON.stringify({ ok: true, messages: msgs }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SLACK_NORTH_STAR_BOT_TOKEN = 'xoxb-test';
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x@127.0.0.1:1/x';
  const ns = require(process.env.NS_DIST || path.join(__dirname, '../../server-dist/server/src/mcp/northStarTools.js'));
  let n = 0;
  const ok = (name) => console.log(`  ok ${++n} ${name}`);

  assert.deepEqual(ns.parseThreadRef('https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1795434107741089'), { channel: 'C0ASMPYQLG3', ts: ROOT });
  assert.deepEqual(ns.parseThreadRef('https://x.slack.com/archives/C0ASMPYQLG3/p1795434200000100?thread_ts=1795434107.741089&cid=C0ASMPYQLG3'), { channel: 'C0ASMPYQLG3', ts: ROOT });
  assert.deepEqual(ns.parseThreadRef('C0ASMPYQLG3 1795434107.741089'), { channel: 'C0ASMPYQLG3', ts: ROOT });
  assert.equal(ns.parseThreadRef('hello'), null);
  ok('a link, a reply link and "channel ts" are understood; anything else is not');

  const r = await ns.readSlackThread('https://x.slack.com/archives/C0ASMPYQLG3/p1795434107741089', 40_000);
  assert.equal(r.ok, true);
  assert.equal(r.messages_in_thread, 3, 'channel_join is skipped');
  assert.equal(r.messages[1].text, long, 'a person\'s long message comes back whole');
  assert.ok(r.messages[1].text.endsWith('END'));
  assert.equal(r.messages[0].text, 'Locking two decisions @U0ADAEB9JTH', 'mentions are cleaned');
  assert.equal(r.messages[2].text.length, 4_000, 'bot posts are held to 4,000');
  assert.equal(r.truncated, false);
  ok('a thread is read root first, each person\'s message whole');

  calls.length = 0;
  const viaReply = await ns.readSlackThread('C0ASMPYQLG3 1795434200.000100', 40_000);
  assert.equal(viaReply.thread_ts, ROOT);
  assert.equal(calls.length, 2, 'a reply link reads again from the root');
  assert.equal(viaReply.messages_in_thread, 3);
  ok('a link to a reply reads the whole thread from its root');

  const tight = await ns.readSlackThread('C0ASMPYQLG3 1795434107.741089', 5_000);
  assert.equal(tight.truncated, true);
  assert.ok(tight.result_chars <= 5_000 || tight.messages.length === 2);
  assert.ok(tight.messages.every((m) => !m.is_bot || m.text.length <= 301), 'bots cut to 300 first');
  assert.ok(tight.messages.filter((m) => !m.is_bot).every((m) => m.text === long || m.text === 'Locking two decisions @U0ADAEB9JTH'), 'a person\'s message shown is never cut');
  assert.match(tight.note, /whole/);
  ok('over budget: bots cut first, then oldest replies left out, people never cut, and it says so');

  const kw = await ns.readSlackThread('C0ASMPYQLG3 1795434107.741089', 40_000, 'decision, END');
  assert.equal(kw.messages.length, 2, 'the root plus the matching message');
  ok('keywords keep only matching messages, with the root');

  assert.equal((await ns.readSlackThread('CNOTIN 1795434107.741089', 40_000)).reason, 'not_in_channel');
  assert.equal((await ns.readSlackThread('D0DM 1795434107.741089', 40_000)).reason, 'bad_thread');
  assert.equal((await ns.readSlackThread('https://x.slack.com/archives/D0DM/p1795434107741089', 40_000)).reason, 'dm_not_read');
  ok('a channel it is not in, and a DM, are refused by name');

  server.close();
  console.log(`\nslack thread read: ${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
