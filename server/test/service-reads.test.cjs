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
  const d = require(path.join(DIST, 'server/src', 'codeCheckDraft.js'));
  const parts = d.splitSections(('line of a check\n'.repeat(400)) + 'x'.repeat(7000));
  assert.ok(parts.every((p) => p.length <= d.MAX_SECTION));
  assert.equal(parts.join('\n').replace(/\n/g, '').length, ('line of a check'.repeat(400) + 'x'.repeat(7000)).length);
  ok('a long check is cut for Slack and nothing is lost');
  const card = d.cardBlocks({ codex_entry_id: 'CODEX-1', builder: 'Hardik', round: 2, draft_text: '*Code check: x*', log_url: 'https://x' });
  const buttons = card.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(buttons.slice(0, 2).map((b) => [b.action_id, b.value]), [['engine_approval_approve', 'CCD-CODEX-1'], ['engine_approval_deny', 'CCD-CODEX-1']]);
  assert.equal(d.isDraftId('CCD-CODEX-1'), true);
  ok('the card has Approve and Send notes on the ids the Front Door forwards');
  const draft = '*Code check: Hardik, CODEX-1, 2026-11-04*\n*Verdict:* Partly matches. Most of it holds.\n\n*In plain words, a real-world example*\nA parts list.\n\n*1. What the log claims vs what\'s live*\n• *PR22 merged.* Confirmed. Seen.\n• *Parity template.* Not found. No file.\n\n*4. Pay call*\nPay as logged.\n\n*Bays summary*\n*Approve:* yes\n*Why:* Real gaps.';
  const drafted = d.draftParts(draft);
  assert.equal(drafted.verdict, 'Partly matches. Most of it holds.');
  assert.deepEqual(drafted.sections.map((p) => p.heading), ['In plain words, a real-world example', "1. What the log claims vs what's live", '4. Pay call', 'Bays summary']);
  assert.ok(drafted.sections[3].body.includes('*Approve:* yes'));
  const laid = d.cardBlocks({ codex_entry_id: 'CODEX-1', builder: 'Hardik', round: 1, draft_text: draft, log_url: null, check: { verdict: 'partly', pay_call: 'as_logged', approve: 'yes' } });
  const flat = JSON.stringify(laid.blocks);
  assert.equal(laid.blocks[0].type, 'header');
  assert.ok(laid.blocks[1].fields.length >= 5);
  assert.equal(laid.blocks[2].type, 'divider');
  assert.ok(JSON.stringify(laid.blocks[3]).includes('"text":"\\n"'), 'space between parts');
  assert.ok(!/:[a-z_]+:/.test(flat.replace(/"[a-z_]+":/g, '')), 'no emoji');
  assert.ok(flat.includes('rich_text_list') && flat.includes('"text":"PR22 merged.","style":{"bold":true}'));
  assert.ok(!JSON.stringify(laid.blocks.slice(3)).includes('*'));
  assert.ok(laid.blocks.length <= 50);
  assert.deepEqual(d.richInline('see <https://x|it> and `a`'), [{ type: 'text', text: 'see ' }, { type: 'link', url: 'https://x', text: 'it' }, { type: 'text', text: ' and ' }, { type: 'text', text: 'a', style: { code: true } }]);
  const mixed = d.draftParts("*Code check: H, C, d*\n*Verdict:* Partly.\n- *Readiness:* Blocked on Stage 1\n\n*1. What the log claims vs what's live*\n*One.* Confirmed. x\n• *Two.* Partly. y\n\n*4. Pay call*\nPay as logged.\n*Follow-ups opened:* none\nHardik by 6 Nov: z");
  assert.equal(mixed.readiness, 'Blocked on Stage 1');
  const claims = d.richPart(mixed.sections[0].heading, mixed.sections[0].body)[0].elements;
  assert.equal(claims[1].type, 'rich_text_list');
  assert.equal(claims[1].elements.length, 2);
  const pay = d.richPart(mixed.sections[1].heading, mixed.sections[1].body)[0].elements.map((e) => e.type);
  assert.deepEqual(pay, ['rich_text_section', 'rich_text_section', 'rich_text_list', 'rich_text_section']);
  ok('every card renders its sections one way, with follow-ups last');
  const longPart = d.richPart('H', Array.from({ length: 40 }, (_, i) => `• *Claim ${i}.* ${'x'.repeat(200)}`).join('\n'));
  assert.ok(longPart.length > 1 && longPart.every((b) => JSON.stringify(b).length < 4800));
  assert.ok(d.threadBlocks(draft).blocks.length > 2);
  ok('the card and the thread post are rich text, with no emoji and no raw asterisks');
  const cc = require(path.join(DIST, 'server/src', 'codeChecks.js'));
  const base = { couldnt_check: 'Nothing: every claim was opened at its source.', lanes: 'VFARM_HARDWARE', gateClosed: false, draft: "*3. What I couldn't check*\nx\n*Readiness:* Passes current tests but blocked on Stage gate 1", readiness: 'blocked_on_gate', gate: 'Stage 1' };
  assert.equal(cc.gateProblem(base), null);
  assert.equal(cc.gateProblem({ ...base, couldnt_check: ' ' }).reason, 'coverage_missing');
  assert.equal(cc.gateProblem({ ...base, draft: 'blocked on x' }).reason, 'coverage_missing');
  assert.equal(cc.gateProblem({ ...base, readiness: 'no_gate' }).reason, 'gate_required');
  assert.equal(cc.gateProblem({ ...base, readiness: 'customer_ready' }).reason, 'gate_not_passed');
  assert.equal(cc.gateProblem({ ...base, readiness: 'customer_ready', gateClosed: true }), null);
  assert.equal(cc.gateProblem({ ...base, draft: `${base.draft}\nThis is customer ready.` }).reason, 'customer_ready_claimed');
  assert.equal(cc.gateProblem({ ...base, draft: `*2. What's missing before it's customer ready*\n${base.draft}` }), null);
  assert.equal(cc.gateProblem({ ...base, lanes: 'BAYS', readiness: 'no_gate' }), null);
  ok("Jason's two rules: customer ready follows the gate, and coverage is always stated");
  assert.equal(d.isNotes({ user: 'U0AEW3TBYH1', text: 'tighten it', ts: '5' }, 4), true);
  assert.equal(d.isNotes({ user: 'U0A9V97949F', text: 'x', ts: '5' }, 4), false);
  assert.equal(d.isNotes({ user: 'U0AEW3TBYH1', bot_id: 'B', text: 'x', ts: '5' }, 4), false);
  assert.equal(d.isNotes({ user: 'U0AEW3TBYH1', text: 'x', ts: '3' }, 4), false);
  ok('only a reply of his after the ask counts as notes');
  assert.ok(d.taskFor({ codex_entry_id: 'C', builder: 'B', round: 2, previous: 'old', notes: 'fix it' }).includes('fix it'));
  ok('notes go back with the check');
  console.log(`service-reads: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
