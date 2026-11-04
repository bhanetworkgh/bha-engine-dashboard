/**
 * Reads of GitHub, Render, Twilio, ElevenLabs and Stripe (4 Nov 2026). Pure, with fetch stood in: no database, no network.
 * Run with:  npm run test:service-reads   (builds the server first)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const sr = require(path.join(DIST, 'server/src', 'serviceReads.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

(async () => {
  for (const [s, p] of [['github', '/repos/bhanetworkgh/bhavfarm/commits'], ['github', '/repos/bhanetworkgh/bhavfarm/compare/main...feat/x'], ['github', '/repos/bhanetworkgh/bhavfarm/contents/vfarm/app/main.py'], ['render', '/services/srv-1/deploys'], ['twilio', '/Messages.json'], ['twilio', '/monitor/v1/Alerts'], ['elevenlabs', '/convai/conversations/conv_1'], ['stripe', '/events'], ['stripe', '/checkout/sessions/cs_1']]) {
    assert.equal(sr.refusal(s, p, {}), null, p);
  }
  ok('the paths a check needs are on the lists');
  for (const [s, p] of [['render', '/services/srv-1/env-vars'], ['render', '/services/srv-1/env-vars/KEY'], ['render', '/services/srv-1/secret-files'], ['render', '/owners'], ['github', '/repos/someone/else/commits'], ['github', '/user'], ['github', '/repos/bhanetworkgh/x/contents/../../../user'], ['twilio', '/Keys.json'], ['twilio', '/Accounts.json'], ['stripe', '/balance'], ['stripe', '/payouts'], ['stripe', '/customers'], ['elevenlabs', '/user']]) {
    assert.equal(sr.refusal(s, p, {})?.reason, 'path_refused', p);
  }
  ok('secrets, other owners and anything not named are refused');
  assert.equal(sr.refusal('github', '/search/code', { q: 'token' })?.reason, 'path_refused');
  assert.equal(sr.refusal('github', '/search/code', { q: 'token org:bhanetworkgh' }), null);
  ok('a search must stay inside the organisation');

  assert.equal(sr.twilioUrl('AC1', '/Calls.json'), 'https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json');
  assert.equal(sr.twilioUrl('AC1', '/monitor/v1/Alerts'), 'https://monitor.twilio.com/v1/Alerts');
  ok('Twilio paths land on the right host');

  delete process.env.GITHUB_READ_TOKEN;
  let called = 0;
  const count = async () => { called += 1; return new Response('[]'); };
  const none = await sr.read('github', '/repos/bhanetworkgh/bhavfarm/commits', {}, { fetcher: count });
  assert.equal(none.reason, 'not_configured');
  assert.equal(called, 0);
  ok('an unset key says so and calls nothing');
  const refused = await sr.read('render', '/services/srv-1/env-vars', {}, { fetcher: count });
  assert.equal(refused.reason, 'path_refused');
  assert.equal(called, 0);
  ok('a refused path calls nothing, even with no key');

  process.env.GITHUB_READ_TOKEN = 'k';
  let seen = null;
  const r = await sr.read('github', 'repos/bhanetworkgh/bhavfarm/contents/a.txt', { ref: 'main' }, { fetcher: async (u, i) => { seen = [u, i.method]; return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('hello ghp_abcdefghijklmnopqrstuvwxyz123456').toString('base64') })); } });
  assert.deepEqual(seen, ['https://api.github.com/repos/bhanetworkgh/bhavfarm/contents/a.txt?ref=main', 'GET']);
  assert.ok(r.text.includes('hello'));
  assert.ok(!r.text.includes('ghp_abc'));
  assert.equal(r.redacted['github token'], 1);
  ok('a file comes back as text, by GET, with secrets redacted');

  const denied = await sr.read('github', '/repos/bhanetworkgh/x', {}, { fetcher: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
  assert.equal(denied.reason, 'not_authorised');
  assert.equal(denied.raise, true);
  const gone = await sr.read('github', '/repos/bhanetworkgh/x', {}, { fetcher: async () => new Response('{}', { status: 404 }) });
  assert.equal(gone.reason, 'not_found');
  const down = await sr.read('github', '/repos/bhanetworkgh/x', {}, { fetcher: async () => { throw new Error('boom'); } });
  assert.equal(down.reason, 'unreachable');
  ok('a refusal, a miss and an outage each say which they are');

  const long = sr.shape('x'.repeat(sr.MAX_CHARS + 10));
  assert.equal(long.truncated, true);
  assert.equal(long.next_offset, sr.MAX_CHARS);
  assert.equal(sr.shape('x'.repeat(sr.MAX_CHARS + 10), { offset: long.next_offset }).text.length, 10);
  ok('a long answer says it was cut and where to go on');

  const masked = sr.maskPeople('+15551234567 buyer@gmail.com destiny@bhanetwork.org');
  assert.ok(!masked.includes('5551234567') && masked.includes('4567'));
  assert.ok(!masked.includes('buyer@') && masked.includes('destiny@bhanetwork.org'));
  ok('people are masked for an agent, the team is not');

  assert.equal(sr.confirmWords('POST', '/Messages.json'), 'POST /Messages.json');
  process.env.TWILIO_ACCOUNT_SID = 'AC1'; process.env.TWILIO_ADMIN_KEY_SID = 'SK1'; process.env.TWILIO_ADMIN_KEY_SECRET = 's';
  let sent = null;
  const w = await sr.twilioAdmin('POST', '/Messages.json', { To: '+1', Body: 'hi' }, async (u, i) => { sent = [u, i.method, i.body]; return new Response('{"sid":"SM1"}', { status: 201 }); });
  assert.equal(w.ok, true);
  assert.deepEqual(sent, ['https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', 'POST', 'To=%2B1&Body=hi']);
  ok('a confirmed Twilio change is sent as a form to the account');
  console.log(`service-reads: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
