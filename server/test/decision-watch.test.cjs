/**
 * Decision Watch (2026-10-11), against a local database with Slack stood in.
 * Run with: npm run test:decision-watch
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:decision-watch writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');

/** The stand-in Slack: threads and DMs are arrays of messages; posts are kept. */
const slack = { threads: {}, replyOf: {}, dms: {}, posts: [], unreadable: new Set(), refusePost: false, calls: [], channels: {}, registers: [], onRegister: null };
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const b = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const send = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    slack.calls.push({ url: req.url, token: req.headers.authorization, ...b });
    if (req.url === '/chat.postMessage') {
      if (slack.refusePost) return send({ ok: false, error: 'channel_not_found' });
      const ts = `${Math.floor(Date.now() / 1000) + slack.posts.length}.00000${slack.posts.length % 10}`;
      const channel = /^U/.test(b.channel) ? `D${b.channel.slice(1)}` : b.channel;
      slack.posts.push({ ...b, channel, ts });
      return send({ ok: true, channel, ts });
    }
    if (req.url === '/conversations.replies') {
      if (slack.unreadable.has(b.channel)) return send({ ok: false, error: 'channel_not_found' });
      // The open-time check (no oldest): as Slack does, a reply names its thread, an unknown ts is thread_not_found.
      if (b.oldest === undefined) {
        const key = `${b.channel}:${b.ts}`;
        if (slack.replyOf[key]) return send({ ok: true, messages: [{ ts: slack.replyOf[key], thread_ts: slack.replyOf[key] }, { ts: b.ts, thread_ts: slack.replyOf[key] }] });
        if (key in slack.threads) return send({ ok: true, messages: [{ ts: b.ts }] });
        return send({ ok: false, error: 'thread_not_found' });
      }
      return send({ ok: true, messages: (slack.threads[`${b.channel}:${b.ts}`] || []).filter((m) => Number(m.ts) > Number(b.oldest || 0)) });
    }
    if (req.url === '/conversations.info') {
      const c = slack.channels[b.channel];
      return send(c ? { ok: true, channel: { id: b.channel, ...c } } : { ok: false, error: 'channel_not_found' });
    }
    // The stand-in n8n: Bays — Channel Register.
    if (req.url === '/webhook/channel-register') {
      slack.registers.push({ key: req.headers['x-dashboard-key'], ...b });
      return Promise.resolve(slack.onRegister ? slack.onRegister(b.channel_id) : null).then(() => send({ ok: true, channel_id: b.channel_id }));
    }
    if (req.url === '/conversations.history') return send({ ok: true, messages: (slack.dms[b.channel] || []).filter((m) => Number(m.ts) > Number(b.oldest || 0)) });
    send({ ok: false, error: 'unknown_method' });
  });
});

(async () => {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-bays';
  process.env.SLACK_NORTH_STAR_BOT_TOKEN = 'xoxb-ns';
  process.env.QUOTA_ALERT_CHANNEL = 'C0ALERTS001';
  process.env.N8N_API_URL = `http://127.0.0.1:${port}/api/v1`;
  process.env.DASHBOARD_INBOUND_KEY = 'test-inbound-key';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  await req('migrations.js').migrate();
  const { query } = req('pg.js');
  const dw = req('decisionWatch.js');
  const tools = req('mcp/decisionWatchTools.js');

  const T = Date.now();
  const OWNER = 'U0OWNER0001';
  const OTHER = 'U0OTHER0001';
  const JASON = 'U0A9V97949F';
  const CH = `C0T${String(T).slice(-7)}`;
  const at = (min) => new Date(T + min * 60_000);
  const ts = (min) => (at(min).getTime() / 1000).toFixed(6);
  const row = async (id) => (await query(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [id])).rows[0];
  const only = (id, when, dry) => dw.sweep(when, { only: id, dry });
  let passed = 0;
  const ok = (n) => (passed++, console.log(`  ok  ${n}`));
  // Leftovers from an earlier run must not be swept or counted.
  // Their posts must not count against this run's daily cap either (the cap is read from history).
  await query(`UPDATE engine_decision_watches SET status = 'cancelled', history = '[]'::jsonb`);
  await query(`DELETE FROM engine_events WHERE event_type LIKE 'decision_watch_%'`);
  // Most checks below put several watches on one OWNER close together in time; the one-reminder-
  // per-person spacing (22 Oct 2026) has its own check (12e), so it is switched off until then.
  const OWNER_GAP = dw.RULE.owner_gap_hours;
  dw.RULE.owner_gap_hours = 0;

  /* 1. open, and a second ask for the same thread and owner */
  const base = { decision: 'Confirm whether the decision watch method is right, or propose adjustments.', owner_user_id: OWNER, channel_id: CH, thread_ts: '1791733223.226019', sop_refs: 'SOP -- Bays Enforces SOPs (BHARAG 9528e006)', next_step: 'Reply with the method.', created_by: JASON, created_via: 'bays' };
  const a = await dw.open(base);
  assert.equal(a.ok && a.created, true);
  const A = a.watch.watch_id;
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [A, at(0).toISOString()]);
  const again = await dw.open(base);
  assert.equal(again.ok && again.created, false);
  assert.equal(again.watch.watch_id, A);
  assert.equal((await dw.open({ ...base, owner_user_id: 'hardik' })).reason, 'owner_required');
  assert.equal((await dw.open({ ...base, channel_id: null, thread_ts: null })).reason, 'nothing_to_watch');
  assert.equal((await dw.open({ ...base, thread_ts: '1.000001', wait_minutes: 5 })).reason, 'bad_wait');
  ok('a watch opens once per thread and owner, and refuses what it cannot watch');

  /* 2. not due: nothing posted. A dry run says so and changes nothing. */
  const key = `${CH}:1791733223.226019`;
  slack.threads[key] = [];
  let r = await only(A, at(60), true);
  assert.match(r.would[0].action, /not due/);
  assert.equal((await row(A)).last_checked_at, null, 'a dry run writes nothing');
  r = await only(A, at(60));
  assert.equal(slack.posts.length, 0);
  ok('nothing is posted before the wait is up');

  /* 3. someone else replies: the wait starts again; a bot post is not movement */
  slack.threads[key].push({ user: OTHER, ts: ts(600), text: 'adding context' }, { bot_id: 'B1', ts: ts(900), text: 'bot noise' });
  r = await only(A, at(24 * 60 + 5));
  assert.equal(slack.posts.length, 0, 'the other reply restarted the wait');
  assert.equal(new Date((await row(A)).quiet_since).getTime(), Math.round(Number(ts(600)) * 1000));
  ok('a reply from someone else restarts the wait; a bot post does not');

  /* 4. quiet past the wait: one reminder, in the thread, with the references */
  r = await only(A, at(600 + 24 * 60 + 1));
  assert.deepEqual(r.reminded, [A]);
  assert.equal(slack.posts.length, 1);
  const p1 = slack.posts[0];
  assert.equal(p1.channel, CH);
  assert.equal(p1.thread_ts, '1791733223.226019');
  assert.match(p1.text, new RegExp(`<@${OWNER}>`));
  assert.match(p1.text, /SOP -- Bays Enforces SOPs/);
  assert.match(p1.text, /Reminder 1 of 3/);
  assert.doesNotMatch(p1.text, /—/, 'no em dash in a post');
  assert.equal((await row(A)).reminders_sent, 1);
  r = await only(A, at(600 + 24 * 60 + 10));
  assert.equal(slack.posts.length, 1, 'no second reminder inside the wait');
  ok('quiet past the wait posts one reminder in the thread');

  /* 5. a thread nobody can read is never reminded on */
  slack.unreadable.add(CH);
  r = await only(A, at(600 + 48 * 60 + 10));
  assert.deepEqual(r.unread, [A]);
  assert.equal(slack.posts.length, 1);
  assert.match((await row(A)).last_error, /could not read/);
  assert.ok(slack.calls.some((c) => c.url === '/conversations.replies' && c.token === 'Bearer xoxb-ns'), 'North Star was tried after Bays');
  slack.unreadable.delete(CH);
  ok('an unread thread is held with the reason, never reminded on');

  /* 6. the owner replies: answered */
  slack.threads[key].push({ user: OWNER, ts: ts(600 + 48 * 60 + 20), text: 'yes, that method' });
  r = await only(A, at(600 + 48 * 60 + 30));
  assert.deepEqual(r.closed, [A]);
  assert.equal((await row(A)).status, 'answered');
  assert.equal((await row(A)).last_error, null);
  r = await only(A, at(600 + 96 * 60));
  assert.equal(r.looked_at, 0, 'a closed watch is not swept');
  ok('a reply from the owner closes the watch');

  /* 7. three reminders, then one escalation, then it stops; a failed post is retried */
  const b = await dw.open({ ...base, thread_ts: '1791733299.000001', ns_refs: 'CAPITAL ranked first' });
  const B = b.watch.watch_id;
  slack.threads[`${CH}:1791733299.000001`] = [];
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [B, at(0).toISOString()]);
  const before = slack.posts.length;
  slack.refusePost = true;
  r = await only(B, at(24 * 60 + 1));
  assert.deepEqual(r.failed, [B]);
  assert.match((await row(B)).last_error, /reminder 1 not posted: chat.postMessage: channel_not_found/);
  assert.equal((await row(B)).reminders_sent, 0);
  slack.refusePost = false;
  let clock = 24 * 60 + 2;
  for (const n of [1, 2, 3]) {
    r = await only(B, at(clock));
    assert.deepEqual(r.reminded, [B], `reminder ${n}`);
    assert.match(slack.posts.at(-1).text, new RegExp(`Reminder ${n} of 3`));
    clock += 24 * 60 + 1;
  }
  r = await only(B, at(clock));
  assert.deepEqual(r.escalated, [B]);
  const esc = slack.posts.at(-1);
  assert.match(esc.text, /<@U0A9V97949F> <@U0AEW3TBYH1>/);
  assert.match(esc.text, /North Star:\* CAPITAL ranked first/);
  assert.equal(esc.thread_ts, '1791733299.000001');
  assert.equal((await row(B)).status, 'escalated');
  assert.equal(slack.posts.length - before, 4);
  ok('a refused post is retried; three reminders, one escalation, then it stops');

  /* 8. a watch on a backlog task with no thread: DM the owner, and the task being done closes it */
  const TASK = `TASK-${T}-TEST`;
  const backlog = (id, fields, when) =>
    query(`INSERT INTO engine_lane_backlog (airtable_record_id, natural_id, lane_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2, $3::jsonb, 'engine', $4, $4, $4)
           ON CONFLICT (airtable_record_id) DO UPDATE SET fields = EXCLUDED.fields, updated_at = EXCLUDED.updated_at`, [id, fields.lane, JSON.stringify({ task_id: id, ...fields }), when.toISOString()]);
  await backlog(TASK, { lane: 'GENIE', task: 'Wire the read call', status: true }, at(-10));
  assert.equal((await dw.open({ ...base, channel_id: null, thread_ts: null, record_kind: 'lane_backlog', record_id: 'TASK-NOPE' })).reason, 'record_not_found');
  const c = await dw.open({ ...base, channel_id: null, thread_ts: null, record_kind: 'lane_backlog', record_id: TASK });
  const C = c.watch.watch_id;
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [C, at(0).toISOString()]);
  r = await only(C, at(24 * 60 + 1));
  assert.deepEqual(r.reminded, [C]);
  assert.equal(slack.calls.filter((x) => x.url === '/chat.postMessage').at(-1).channel, OWNER, 'sent as a DM to the owner');
  assert.equal((await row(C)).channel_id, `D${OWNER.slice(1)}`, 'the DM channel is kept, to read the answer in');
  // a write that changes nothing is not movement: the second reminder still goes
  await backlog(TASK, { lane: 'GENIE', task: 'Wire the read call', status: true }, at(30 * 60));
  r = await only(C, at(48 * 60 + 5));
  assert.deepEqual(r.reminded, [C], 'a no-op write did not restart the wait');
  await backlog(TASK, { lane: 'GENIE', task: 'Wire the read call', status: true, note: 'half done' }, at(60 * 60));
  r = await only(C, at(72 * 60 + 10));
  assert.equal(r.reminded.length, 0, 'the task changed, so the wait started again');
  await backlog(TASK, { lane: 'GENIE', task: 'Wire the read call', status: false }, at(73 * 60));
  r = await only(C, at(73 * 60 + 1));
  assert.deepEqual(r.closed, [C]);
  assert.equal((await row(C)).status, 'moved');
  // two passes at the same moment post one reminder, not two
  await backlog(`${TASK}3`, { lane: 'GENIE', task: 'Third task', status: true }, at(-10));
  const g = await dw.open({ ...base, channel_id: null, thread_ts: null, record_kind: 'lane_backlog', record_id: `${TASK}3` });
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [g.watch.watch_id, at(0).toISOString()]);
  const n0 = slack.posts.length;
  const both = await Promise.all([only(g.watch.watch_id, at(24 * 60 + 1)), only(g.watch.watch_id, at(24 * 60 + 1))]);
  assert.equal(slack.posts.length - n0, 1, 'one reminder from two overlapping passes');
  assert.equal(both[0].reminded.length + both[1].reminded.length, 1);
  await dw.close(g.watch.watch_id, JASON, 'cancelled', 'test');
  // and an owner's DM reply closes a threadless watch
  await backlog(`${TASK}2`, { lane: 'GENIE', task: 'Second task', status: true }, at(-10));
  const d = await dw.open({ ...base, channel_id: null, thread_ts: null, record_kind: 'lane_backlog', record_id: `${TASK}2` });
  const D = d.watch.watch_id;
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [D, at(0).toISOString()]);
  await only(D, at(24 * 60 + 1));
  const dmChannel = (await row(D)).channel_id;
  const remTs = (await row(D)).last_reminder_ts;
  // a message in the DM that is not under the reminder is not an answer to this watch
  slack.dms[dmChannel] = [{ user: OWNER, ts: String(Number(remTs) + 30), text: 'unrelated question for Bays' }];
  r = await only(D, at(24 * 60 + 35));
  assert.equal(r.closed.length, 0, 'an unrelated DM does not close the watch');
  slack.threads[`${dmChannel}:${remTs}`] = [{ user: OWNER, ts: String(Number(remTs) + 60), text: 'on it, blocked by keys' }];
  await query(`UPDATE engine_decision_watches SET last_checked_at = NULL WHERE watch_id = $1`, [D]);
  r = await only(D, at(24 * 60 + 40));
  assert.deepEqual(r.closed, [D]);
  assert.equal((await row(D)).status, 'answered');
  ok('a threadless watch reminds by DM, follows its task, and closes on the owner\'s DM reply');

  /* 9. the daily cap holds a post, and says so */
  const e = await dw.open({ ...base, thread_ts: '1791733300.000001' });
  const E = e.watch.watch_id;
  slack.threads[`${CH}:1791733300.000001`] = [];
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [E, at(0).toISOString()]);
  const capDay = at(24 * 60 + 1);
  // twelve posts already made that day, on other watches' own histories
  await query(`INSERT INTO engine_decision_watches (watch_id, decision, owner_user_id, status, history) VALUES ($1, 'cap filler', $2, 'cancelled', $3::jsonb)`, [
    `DW-CAP-${T}`,
    OWNER,
    JSON.stringify(Array.from({ length: dw.RULE.daily_cap }, () => ({ at: capDay.toISOString(), what: 'reminder posted', post: 'true' }))),
  ]);
  const posts = slack.posts.length;
  r = await only(E, capDay);
  assert.deepEqual(r.held_cap, [E]);
  assert.equal(slack.posts.length, posts);
  assert.match((await row(E)).last_error, /held/);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'decision_watch_held' AND subject_id = $1`, [E])).rows[0].n, 1, 'a cap hold is an engine event');
  await query(`DELETE FROM engine_decision_watches WHERE watch_id = $1`, [`DW-CAP-${T}`]);
  ok('the daily cap holds a reminder rather than posting it');

  /* 10. who may close */
  assert.equal((await dw.close(E, OTHER, 'cancelled', 'not mine')).reason, 'not_permitted');
  assert.equal((await dw.close(E, JASON, 'answered', 'answered on a call')).ok, true);
  assert.equal((await dw.close(E, JASON, 'answered', 'again')).reason, 'already_closed');
  ok('only the requester, the owner, Destiny or Jason close a watch');

  /* 11. PX07: every open CAPITAL task with a nameable owner is watched once */
  const HARDIK = `U0H${String(T).slice(-8)}`;
  await query(`INSERT INTO engine_builder_profiles (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', $3, $3, $3)`, [HARDIK, JSON.stringify({ user_id: HARDIK, name: `Hardik Test ${T}` }), at(0).toISOString()]);
  await backlog(`TASK-${T}-CAP1`, { lane: 'CAPITAL', task: 'Connect the checkout and run test transactions', owner: `hardik test ${T}`, status: true }, at(-5000));
  await backlog(`TASK-${T}-CAP2`, { lane: 'CAPITAL', task: 'Propose the first capital target', owner: 'North Star and Research Twin, for Jason\'s approval', status: true }, at(-5000));
  await backlog(`TASK-${T}-CAP3`, { lane: 'CAPITAL', task: 'Already finished', owner: `Hardik Test ${T}`, status: false }, at(-5000));
  assert.equal(await dw.autoCapital(), 1, 'one owner is a person, one is not, one task is done');
  assert.equal(await dw.autoCapital(), 0, 'never a second watch for the same task');
  const cap = (await query(`SELECT * FROM engine_decision_watches WHERE auto_key = $1`, [`capital:TASK-${T}-CAP1`])).rows[0];
  assert.equal(cap.owner_user_id, HARDIK);
  assert.match(cap.sop_refs, /CAPITAL Lane Live-Client Ownership/);
  assert.ok(Date.now() - new Date(cap.quiet_since).getTime() < 60_000, 'the wait starts when the watch is made, not from the task\'s old date');
  r = await only(cap.watch_id, new Date());
  assert.equal(r.reminded.length, 0, 'switching it on reminds nobody about the past');
  await dw.close(cap.watch_id, JASON, 'cancelled', 'test');
  assert.equal(await dw.autoCapital(), 0, 'a closed watch is not reopened by the rule');
  ok('the CAPITAL rule watches each open task once, from now');

  /* 12. the tools: a fixture is refused to an agent, a link is parsed, the read hides fixtures */
  await query(`INSERT INTO engine_builder_profiles (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', $3, $3, $3) ON CONFLICT DO NOTHING`, [OWNER, JSON.stringify({ user_id: OWNER, name: 'Owner Test' }), at(0).toISOString()]);
  let t0 = await tools.openDecisionWatch.handler({ decision: 'A stranger is asked something', owner_user_id: 'U0STRANGER1', requester_user_id: JASON, channel_id: CH, thread_ts: '1791733300.000009' }, { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  assert.equal(t0.reason, 'unknown_owner', 'a person with no Builder Profile is never reminded');
  t0 = await tools.openDecisionWatch.handler({ decision: 'A channel nobody approved', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791733300.000009' }, { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  assert.equal(t0.reason, 'unknown_destination', 'an agent cannot aim reminders at a channel the engine does not know');

  /* 12c. a channel Bays is in but the engine never set up is set up on the first watch (Jason's ask 1, 14 Oct) */
  const reg = (c) => `C0R${String(T).slice(-6)}${c}`;
  const [RIN, ROUT, RNAME, RFAIL] = ['1', '2', '3', '4'].map(reg);
  for (const c of [RIN, ROUT, RNAME, RFAIL]) slack.threads[`${c}:1791733300.000020`] = [];
  slack.channels[RIN] = { name: 'bha-new-lane', is_member: true };
  slack.channels[ROUT] = { name: 'bha-elsewhere', is_member: false };
  slack.channels[RNAME] = { name: 'test-scratch', is_member: true };
  slack.channels[RFAIL] = { name: 'bha-broken', is_member: true };
  slack.onRegister = async (c) => {
    if (c === RFAIL) return; // answers 200 and writes nothing
    await query(`INSERT INTO engine_channel_tracking (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', now(), now(), now()) ON CONFLICT DO NOTHING`, [c, JSON.stringify({ channel_id: c })]);
  };
  const regArgs = (c, extra = {}) => ({ decision: 'Register test', owner_user_id: OWNER, requester_user_id: JASON, channel_id: c, thread_ts: '1791733300.000020', ...extra });
  const regDeps = { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' };
  let rg = await tools.openDecisionWatch.handler(regArgs(RIN, { dry_run: true }), regDeps);
  assert.equal(rg.ok, true);
  assert.match(rg.channel_setup, /would set it up/, 'a dry run says the channel would be set up');
  assert.equal(slack.registers.length, 0, 'a dry run calls nothing');
  rg = await tools.openDecisionWatch.handler(regArgs(RIN), regDeps);
  assert.equal(rg.ok, true, `an untracked channel Bays is in is set up and watched: ${rg.message}`);
  assert.match(rg.channel_setup, /it is now/);
  assert.equal(slack.registers.length, 1);
  assert.equal(slack.registers[0].key, 'test-inbound-key', 'the webhook carries the inbound key');
  assert.equal(slack.registers[0].channel_id, RIN);
  const regWatch = rg.watch_id;
  rg = await tools.openDecisionWatch.handler(regArgs(ROUT), regDeps);
  assert.equal(rg.reason, 'bays_not_in_channel');
  assert.match(rg.message, /\/invite @Bays/, 'the refusal says how to fix it');
  rg = await tools.openDecisionWatch.handler(regArgs('C0C24D5PZQE'), regDeps);
  assert.equal(rg.reason, 'channel_excluded', '#bha-pay-reviews is never set up');
  rg = await tools.openDecisionWatch.handler(regArgs(RNAME), regDeps);
  assert.equal(rg.reason, 'channel_excluded', 'a test channel is never set up');
  rg = await tools.openDecisionWatch.handler(regArgs(RFAIL), regDeps);
  assert.equal(rg.reason, 'register_failed', 'a 200 with no tracking row is not a setup');
  assert.equal(slack.registers.length, 2, 'only the two channels that passed every check reached n8n');
  // A person on the connector: the watch opens either way, and an untracked channel is still set up.
  const RPERSON = reg('5');
  slack.channels[RPERSON] = { name: 'bha-person-lane', is_member: true };
  slack.threads[`${RPERSON}:1791733300.000020`] = [];
  rg = await tools.openDecisionWatch.handler(regArgs(RPERSON), { ...regDeps, agent: null });
  assert.equal(rg.ok, true);
  assert.match(rg.channel_setup, /it is now/, 'a person opening a watch also gets the channel set up');
  assert.equal(slack.registers.length, 3);
  const personWatch = rg.watch_id;
  rg = await tools.openDecisionWatch.handler(regArgs(ROUT), { ...regDeps, agent: null });
  assert.equal(rg.ok, true, 'a person may watch where Bays is not set up');
  assert.match(rg.channel_setup, /not a member/, 'and is told why the channel was not set up');
  await dw.close(personWatch, JASON, 'cancelled', 'test');
  await dw.close(rg.watch_id, JASON, 'cancelled', 'test');
  await dw.close(regWatch, JASON, 'cancelled', 'test');
  await query(`DELETE FROM engine_channel_tracking WHERE natural_id = ANY($1)`, [[RIN, ROUT, RNAME, RFAIL, RPERSON]]);
  ok('an untracked channel Bays is in is set up on the first watch; the rest are refused with steps');
  await query(`INSERT INTO engine_channel_tracking (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, '{}'::jsonb, 'engine', $2, $2, $2) ON CONFLICT DO NOTHING`, [CH, at(0).toISOString()]);
  const deps = (agent) => ({ access: 'write', agent, dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  const open = (args, agent = null) => tools.openDecisionWatch.handler(args, deps(agent));
  slack.threads[`${CH}:1791733300.000002`] = [];
  slack.threads[`${CH}:1791733300.000003`] = [];
  let t = await open({ decision: 'Test watch for the build proof', owner_user_id: OWNER, requester_user_id: JASON, thread_link: `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733400000100?thread_ts=1791733300.000002&cid=${CH}`, fixture: true, wait_minutes: 1 }, 'bays');
  assert.equal(t.reason, 'fixture_not_for_agents');
  t = await open({ decision: 'Test watch for the build proof', owner_user_id: `<@${OWNER}>`, requester_user_id: JASON, thread_link: `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733400000100?thread_ts=1791733300.000002&cid=${CH}`, fixture: true, wait_minutes: 1 });
  assert.equal(t.ok, true);
  assert.equal(t.watch.thread_link, `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733300000002`);
  assert.equal(t.watch.wait_minutes, 1);
  assert.ok(t.audit_id > 0);
  const F = t.watch_id;
  r = await only(F, new Date(Date.now() + 2 * 60_000));
  assert.match(slack.posts.at(-1).text, /^TEST\. /);
  assert.equal((await dw.read()).watches.some((w) => w.watch_id === F), false, 'a fixture is not on the page');
  assert.equal((await dw.read({ fixtures: true })).watches.some((w) => w.watch_id === F), true);
  t = await open({ decision: 'Agent ask with a short wait', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791733300.000003', wait_hours: 0.1 }, 'bays');
  assert.equal(t.reason, 'bad_wait');
  ok('the tools audit every call, refuse a test watch to an agent, and keep fixtures off the page');
  /* 12b. the thread is checked at open (14 Oct 2026, DW-1791991788784-OSK0) */
  const auditBefore = (await query(`SELECT count(*)::int AS n FROM engine_mcp_writes WHERE tool = 'open_decision_watch'`)).rows[0].n;
  t = await open({ decision: 'A ts no message carries', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791991699.614149', fixture: true, wait_minutes: 1 });
  assert.equal(t.reason, 'thread_not_found', 'a ts Slack has no message for is refused');
  t = await open({ decision: 'A ts no message carries, dry run', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791991699.614149', dry_run: true });
  assert.equal(t.reason, 'thread_not_found', 'a dry run checks the thread too');
  slack.replyOf[`${CH}:1791733300.000077`] = '1791733300.000002';
  t = await open({ decision: 'Test watch for the build proof', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791733300.000077', fixture: true, wait_minutes: 1 });
  assert.equal(t.ok && t.created, false, 'a reply ts given as a thread_ts matches the watch already on its thread');
  assert.equal(t.watch_id, F);
  const CH2 = `C0U${String(T).slice(-7)}`;
  slack.unreadable.add(CH2);
  t = await open({ decision: 'A place no bot can read', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH2, thread_ts: '1791733300.000005', fixture: true, wait_minutes: 1 });
  assert.equal(t.reason, 'thread_not_readable', 'a place no bot can read is refused');
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_mcp_writes WHERE tool = 'open_decision_watch'`)).rows[0].n, auditBefore + 4, 'every check is audited');
  ok('a watch is opened only on a thread that exists and can be read, on its root');
  t = await open({ decision: 'A dry run', owner_user_id: OWNER, requester_user_id: JASON, record_id: 'LOOP-123', dry_run: true }, 'bays');
  assert.equal(t.dry_run, true);
  t = await tools.closeDecisionWatch.handler({ watch_id: F, outcome: 'cancelled', reason: 'test over', requester_user_id: JASON }, deps('bays'));
  assert.equal(t.ok, true);
  const list = await tools.listDecisionWatches.handler({ open_only: true }, deps('bays'));
  assert.equal(list.watches.every((w) => w.status === 'watching'), true);
  const audit = await query(`SELECT outcome, kind FROM engine_mcp_writes WHERE tool = 'open_decision_watch' ORDER BY id DESC LIMIT 4`);
  assert.deepEqual(audit.rows.map((x) => x.outcome), ['dry_run', 'refused', 'unchanged', 'refused']);
  await query(`DELETE FROM engine_channel_tracking WHERE natural_id = $1`, [CH]);
  await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [OWNER]);
  assert.equal(audit.rows[0].kind, 'decision_watch');

  /* 12b. a reference is attached to a watch opened before the SOP existed, and the reminder carries it */
  const u0 = await dw.open({ ...base, thread_ts: '1791733301.000001', sop_refs: null, ns_refs: null, next_step: null });
  const U = u0.watch.watch_id;
  slack.threads[`${CH}:1791733301.000001`] = [];
  await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [U, at(0).toISOString()]);
  assert.equal((await dw.update(U, OTHER, { sop_refs: 'x' })).reason, 'not_permitted');
  let up = await dw.update(U, JASON, { sop_refs: 'SOP -- Delivery update standard (BHARAG f0673993)' });
  assert.deepEqual(up.changed.map((c) => [c.field, c.from]), [['sop_refs', null]]);
  up = await dw.update(U, JASON, { sop_refs: 'SOP -- Critical-path narration (BHARAG e874c3de)' }, { append: true });
  assert.equal(up.watch.sop_refs, 'SOP -- Delivery update standard (BHARAG f0673993); SOP -- Critical-path narration (BHARAG e874c3de)');
  up = await dw.update(U, JASON, { sop_refs: 'SOP -- Critical-path narration (BHARAG e874c3de)' }, { append: true });
  assert.equal(up.changed.length, 0, 'a reference already held is not added twice');
  t = await tools.updateDecisionWatch.handler({ watch_id: U, ns_refs: 'CAPITAL ranked first', requester_user_id: OWNER }, { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  assert.equal(t.ok, true);
  assert.equal(t.changed[0].field, 'ns_refs');
  t = await tools.updateDecisionWatch.handler({ watch_id: U, requester_user_id: OWNER }, { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  assert.equal(t.reason, 'nothing_to_change');
  r = await only(U, at(24 * 60 + 1));
  assert.match(slack.posts.at(-1).text, /SOP:\* SOP -- Delivery update standard \(BHARAG f0673993\); SOP -- Critical-path narration/);
  assert.match(slack.posts.at(-1).text, /North Star:\* CAPITAL ranked first/);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type = 'decision_watch_updated' AND subject_id = $1`, [U])).rows[0].n, 3);
  assert.equal((await row(U)).history.filter((h) => /^updated by/.test(h.what)).length, 3);
  await dw.close(U, JASON, 'cancelled', 'test');
  assert.equal((await dw.update(U, JASON, { sop_refs: 'late' })).reason, 'already_closed');
  ok('a watch takes an SOP written after it was opened, logs each change, and its reminder carries it');

  /* 12b. snooze (18 Oct 2026): reminders pause until a date, the watch stays open, a reply still counts */
  {
    const D = 30 * 24 * 60; // a month out, so no other check's posts share the day's cap
    const DAY = 24 * 60;
    const sth = '1791733400.000001';
    slack.threads[`${CH}:${sth}`] = [];
    const s1 = await dw.open({ ...base, thread_ts: sth, created_by: JASON });
    const S = s1.watch.watch_id;
    await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [S, at(D).toISOString()]);
    // who, and which dates
    assert.equal((await dw.snooze(S, OTHER, at(D + 3 * DAY), 'not mine', at(D + 5))).reason, 'not_permitted');
    assert.equal((await dw.snooze(S, OWNER, at(D + 1), null, at(D + 5))).reason, 'not_in_future');
    assert.equal((await dw.snooze(S, OWNER, at(D + 5 + 14 * DAY + 1), null, at(D + 5))).reason, 'too_long');
    assert.equal((await dw.snooze(S, OWNER, at(D + 5 + 14 * DAY), null, at(D + 5))).ok, true, 'exactly fourteen days is allowed');
    // the owner asks for the snooze in the thread itself: that message is not the answer
    slack.threads[`${CH}:${sth}`].push({ user: OWNER, ts: (at(D + 6).getTime() / 1000 - 3).toFixed(6), text: '@Bays snooze this until the 3rd please' });
    // the owner snoozes it for three days (a later snooze replaces the first)
    let sz = await dw.snooze(S, OWNER, at(D + 3 * DAY), 'heads-down on the 10/31 deadline', at(D + 6));
    assert.equal(sz.ok && sz.changed, true);
    let held = await row(S);
    assert.equal(held.status, 'watching', 'a snoozed watch stays open');
    assert.equal(new Date(held.snoozed_until).getTime(), at(D + 3 * DAY).getTime());
    assert.equal(held.snoozed_by, OWNER);
    assert.match(held.history.at(-1).what, /snoozed by U0OWNER0001 until .* \(was .*\): heads-down/);
    const shown = dw.show(held, at(D + DAY + 10));
    assert.match(shown.state, /^snoozed until /);
    assert.equal(shown.next_action_at, at(D + 4 * DAY).toISOString(), 'the next action is a full wait after the snooze ends');
    assert.equal(shown.overdue, false);
    assert.equal(shown.snoozed_until, at(D + 3 * DAY).toISOString());
    // past its wait but inside the snooze: nothing posted, and a dry run says why
    const before = slack.posts.length;
    r = await only(S, at(D + DAY + 10), true);
    assert.match(r.would[0].action, /snoozed until/);
    r = await only(S, at(D + DAY + 10));
    assert.deepEqual(r.reminded, []);
    assert.deepEqual(r.closed, [], 'the owner asking for the snooze did not close the watch');
    assert.equal((await row(S)).status, 'watching');
    assert.equal(slack.posts.length, before, 'nothing is posted while snoozed');
    assert.equal((await row(S)).reminders_sent, 0);
    // the snooze ends: nothing goes the moment it lifts (22 Oct 2026); a full wait later, reminder 1
    r = await only(S, at(D + 3 * DAY + 1), true);
    assert.match(r.would[0].action, /not due until/);
    r = await only(S, at(D + 3 * DAY + 1));
    assert.deepEqual(r.reminded, [], 'no reminder the moment a snooze runs out');
    assert.equal(slack.posts.length, before);
    r = await only(S, at(D + 4 * DAY + 1));
    assert.deepEqual(r.reminded, [S]);
    assert.match(slack.posts.at(-1).text, /Reminder 1 of 3/);
    assert.equal(dw.show(await row(S), at(D + 4 * DAY + 2)).snoozed_until, null, 'a snooze that has run out is not shown');
    // clear ends a snooze early and the wait restarts from then; clearing nothing changes nothing
    await dw.snooze(S, JASON, at(D + 7 * DAY), null, at(D + 6 * DAY));
    sz = await dw.snooze(S, JASON, null, 'back now', at(D + 6 * DAY + 6));
    assert.equal(sz.ok && sz.changed, true);
    const cleared = await row(S);
    assert.equal(cleared.snoozed_until, null);
    assert.equal(new Date(cleared.quiet_since).getTime(), at(D + 6 * DAY + 6).getTime(), 'clearing restarts the wait from now');
    assert.match(cleared.history.at(-1).what, /the wait starts again from now/);
    r = await only(S, at(D + 6 * DAY + 7));
    assert.deepEqual(r.reminded, [], 'clearing a snooze never reminds on the spot');
    sz = await dw.snooze(S, JASON, null, null, at(D + 6 * DAY + 8));
    assert.equal(sz.ok && !sz.changed, true);
    // a cap hold's problem is cleared by a snooze, so the page does not show a stale one
    await query(`UPDATE engine_decision_watches SET last_error = 'held: today''s 12 Decision Watch posts are used; tried again on the next pass' WHERE watch_id = $1`, [S]);
    await dw.snooze(S, OWNER, at(D + 9 * DAY), null, at(D + 6 * DAY + 9));
    assert.equal((await row(S)).last_error, null);
    // a reply from the owner still closes a snoozed watch
    slack.threads[`${CH}:${sth}`].push({ user: OWNER, ts: (at(D + 7 * DAY).getTime() / 1000).toFixed(6), text: 'done' });
    r = await only(S, at(D + 7 * DAY + 1));
    assert.deepEqual(r.closed, [S]);
    assert.equal((await row(S)).status, 'answered');
    assert.equal((await dw.snooze(S, OWNER, at(D + 8 * DAY), null, at(D + 7 * DAY + 2))).reason, 'already_closed');
    const sev = await query(`SELECT event_type, count(*)::int AS n FROM engine_events WHERE subject_id = $1 AND event_type LIKE 'decision_watch_%snoozed' GROUP BY 1`, [S]);
    const sn = Object.fromEntries(sev.rows.map((x) => [x.event_type, x.n]));
    assert.equal(sn.decision_watch_snoozed, 4);
    assert.equal(sn.decision_watch_unsnoozed, 1);
    // the tool: how a date is read, and what it refuses
    assert.equal(tools.parseUntil('2026-10-30').toISOString(), '2026-10-30T00:00:00.000Z');
    assert.equal(tools.parseUntil('2026-10-30T09:00:00+01:00').toISOString(), '2026-10-30T08:00:00.000Z');
    assert.equal(tools.parseUntil('2026-10-30T09:00'), null, 'a time without its zone is not guessed');
    assert.equal(tools.parseUntil('Oct 30'), null);
    const deps = { access: 'write', agent: 'bays', dispatch: async () => ({ status: 200, body: {} }), startedAt: '' };
    const s2 = await dw.open({ ...base, thread_ts: '1791733400.000002', created_by: JASON });
    slack.threads[`${CH}:1791733400.000002`] = [];
    const S2 = s2.watch.watch_id;
    let st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, requester_user_id: OWNER }, deps);
    assert.equal(st.reason, 'until_required');
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, until: 'next week', requester_user_id: OWNER }, deps);
    assert.equal(st.reason, 'bad_until');
    const far = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, until: far, requester_user_id: OWNER, dry_run: true }, deps);
    assert.equal(st.ok, false);
    assert.equal(st.reason, 'too_long');
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, until: far, requester_user_id: OWNER }, deps);
    assert.equal(st.reason, 'too_long');
    assert.match(st.message, /at most 14 days/);
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, until: soon, reason: 'busy', requester_user_id: OWNER }, deps);
    assert.equal(st.ok, true);
    assert.equal(st.snoozed_until, `${soon}T00:00:00.000Z`);
    assert.match(st.message, /stays open/);
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, until: soon, requester_user_id: OWNER }, deps);
    assert.equal(st.ok && st.changed, false, 'the same date again changes nothing');
    st = await tools.snoozeDecisionWatch.handler({ watch_id: S2, clear: true, requester_user_id: OTHER }, deps);
    assert.equal(st.reason, 'not_permitted');
    const audit = await query(`SELECT outcome FROM engine_mcp_writes WHERE tool = 'snooze_decision_watch' AND arguments::text LIKE $1 ORDER BY id`, [`%${S2}%`]);
    assert.deepEqual(audit.rows.map((x) => x.outcome), ['refused', 'refused', 'dry_run', 'refused', 'applied', 'unchanged', 'refused']);
    const listed = (await dw.read()).watches.find((w) => w.watch_id === S2);
    assert.match(listed.state, /^snoozed until/);
    assert.equal((await dw.read()).counts.snoozed >= 1, true);
    await dw.close(S2, JASON, 'cancelled', 'test');
    ok('a watch snoozes up to 14 days, stays open, posts nothing until the date, and a reply still closes it');
  }

  /* 12c. the reminder says what really closes the watch (19 Oct 2026, LOOP-1792136810976-BBGL) */
  {
    const base = { watch_id: 'DW-TEST-TEXT', owner_user_id: HARDIK, decision: 'Pick the card rail', quiet_since: new Date(Date.now() - 26 * 3600_000).toISOString(), max_reminders: 3, thread_ts: '1.2', sop_refs: null, ns_refs: null, record_id: null, record_kind: null, next_step: null, fixture: false };
    const single = dw.reminderText({ ...base, close_on_reply: true }, 1, new Date());
    assert.match(single, /A reply from you in this thread closes this watch\./);
    const multi = dw.reminderText({ ...base, close_on_reply: false, record_id: 'LOOP-1', record_kind: 'loops' }, 2, new Date());
    assert.doesNotMatch(multi, /closes this watch/);
    assert.match(multi, /more than one part, so a reply from you in this thread restarts the wait/);
    assert.match(multi, /or the tracked item closes/);
    assert.match(multi, /snooze it until then/);
    ok('a multi-part watch\'s reminder says a reply restarts the wait; a single-part one says it closes');
  }

  /* 12d. every listed watch says, in words, where a reply counts (19 Oct 2026, Kaiqi's JSUX) */
  {
    const now = new Date('2026-10-19T08:00:00Z');
    const row = { watch_id: 'DW-TEST-MOVES', status: 'watching', owner_user_id: HARDIK, owner_name: 'Kaiqi', decision: 'x', quiet_since: new Date('2026-10-18T14:42:00Z'), wait_minutes: 1440, max_reminders: 3, reminders_sent: 0, thread_ts: '1792332426.914229', channel_id: 'C1', thread_link: 'https://bayshorizonnetwork.slack.com/archives/C1/p1792332426914229', record_id: null, record_kind: null, snoozed_until: null, close_on_reply: false, last_error: null, history: [] };
    const multi = dw.show(row, now).how_it_moves;
    assert.match(multi, /This watch is on https:\/\/bayshorizonnetwork\.slack\.com\/archives\/C1\/p1792332426914229\. Only messages in that thread count/);
    assert.match(multi, /a reply from Kaiqi restarts the wait \(the decision has more than one part/);
    assert.match(multi, /A message anywhere else \(another thread, a channel, a DM\) does not count\./);
    assert.match(multi, /reminder 1 of 3 goes at Mon 19 Oct, 15:42 Lagos \(14:42 UTC\)/);
    const single = dw.show({ ...row, close_on_reply: true, record_id: 'LOOP-9', record_kind: 'loops' }, now).how_it_moves;
    assert.match(single, /a reply from Kaiqi closes it;/);
    assert.match(single, /restarts when loop LOOP-9 changes, and closes when it closes/);
    const dm = dw.show({ ...row, thread_ts: null, thread_link: null, channel_id: null }, now).how_it_moves;
    assert.match(dm, /no thread: reminders go to Kaiqi by DM/);
    const snoozed = dw.show({ ...row, snoozed_until: new Date('2026-10-25T00:00:00Z') }, now).how_it_moves;
    assert.match(snoozed, /Snoozed until .*a reply still counts/);
    assert.equal(dw.show({ ...row, status: 'answered' }, now).how_it_moves, 'Closed (answered). Nothing moves it any more.');
    const listed = (await dw.read()).watches;
    assert.ok(listed.length && listed.every((w) => typeof w.how_it_moves === 'string' && w.how_it_moves.length > 20));
    ok('every listed watch says where a reply counts, what it does, and when the next reminder goes');
  }

  /* 12e. one reminder per person, and the owner's other watches are named on open (22 Oct 2026, Jason:
     an unsnoozed watch nudged Kaiqi at once, on top of a new watch on the same ask in another thread) */
  {
    dw.RULE.owner_gap_hours = OWNER_GAP;
    const E = 60 * 24 * 60; // two months out, clear of every other check
    const P = `U0PAIR${String(T).slice(-6)}`; // one per run, so an earlier run's reminders never count
    slack.threads[`${CH}:1791733500.000003`] = [];
    const th1 = '1791733500.000001';
    const th2 = '1791733500.000002';
    slack.threads[`${CH}:${th1}`] = [];
    slack.threads[`${CH}:${th2}`] = [];
    const w1 = await dw.open({ ...base, owner_user_id: P, thread_ts: th1, decision: 'Wire Genie to the Engine Surfaces Contract.' });
    assert.deepEqual(w1.others, [], 'nobody else is watching this person yet');
    const w2 = await dw.open({ ...base, owner_user_id: P, thread_ts: th2, decision: 'Register the six new MCP tools in Genie.' });
    assert.equal(w2.others.length, 1);
    assert.equal(w2.others[0].watch_id, w1.watch.watch_id, 'opening a second watch on a person names the first');
    for (const w of [w1, w2]) await query(`UPDATE engine_decision_watches SET created_at = $2, quiet_since = $2 WHERE watch_id = $1`, [w.watch.watch_id, at(E).toISOString()]);
    // both due in the same pass: one reminder, the other held
    const before = slack.posts.length;
    let rr = await dw.sweep(at(E + 24 * 60 + 5));
    const fromPair = [...rr.reminded].filter((id) => [w1.watch.watch_id, w2.watch.watch_id].includes(id));
    assert.equal(fromPair.length, 1, 'one reminder per person per pass');
    assert.equal(rr.held_owner.filter((id) => [w1.watch.watch_id, w2.watch.watch_id].includes(id)).length, 1);
    assert.equal(slack.posts.length, before + 1);
    // inside the gap, the other is still held, and a dry run says why
    const heldId = [w1.watch.watch_id, w2.watch.watch_id].find((id) => id !== fromPair[0]);
    rr = await only(heldId, at(E + 24 * 60 + 6 * 60), true);
    assert.match(rr.would.at(-1).action, /one reminder per person per 12 hours/);
    rr = await only(heldId, at(E + 24 * 60 + 6 * 60));
    assert.deepEqual(rr.reminded, []);
    // once the gap has passed, it goes
    rr = await only(heldId, at(E + 24 * 60 + 12 * 60 + 10));
    assert.deepEqual(rr.reminded, [heldId]);
    // the tool hands owner_other_open back and says to keep one
    await query(`INSERT INTO engine_builder_profiles (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, $2::jsonb, 'engine', $3, $3, $3) ON CONFLICT DO NOTHING`, [P, JSON.stringify({ user_id: P, name: 'Pair Test' }), at(0).toISOString()]);
    const t3 = await tools.openDecisionWatch.handler({ decision: 'A third ask of the same person', owner_user_id: P, requester_user_id: JASON, channel_id: CH, thread_ts: '1791733500.000003' }, { access: 'write', agent: null, dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
    assert.equal(t3.ok, true, JSON.stringify(t3));
    assert.equal(t3.owner_other_open.length, 2);
    assert.match(t3.message, /2 other open watches \(owner_other_open\): if one is the same ask, keep one, not both/);
    await dw.close(t3.watch_id, JASON, 'cancelled', 'test');
    for (const w of [w1, w2]) await dw.close(w.watch.watch_id, JASON, 'cancelled', 'test');
    await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [P]);
    ok('a person gets one reminder per 12 hours across all their watches, and opening another names the ones already open');
  }

  /* 13. events */
  const ev = await query(`SELECT event_type, count(*)::int AS n FROM engine_events WHERE subject_id = ANY($1) GROUP BY 1`, [[A, B]]);
  const n = Object.fromEntries(ev.rows.map((x) => [x.event_type, x.n]));
  assert.equal(n.decision_watch_opened, 2);
  assert.equal(n.decision_watch_reminded, 4);
  assert.equal(n.decision_watch_escalated, 1);
  assert.equal(n.decision_watch_closed, 1);
  assert.equal(n.decision_watch_unread, 1);
  ok('every open, reminder, close, escalation and unread thread is an engine event');

  await query(`DELETE FROM engine_lane_backlog WHERE natural_id LIKE $1`, [`TASK-${T}-%`]);
  await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [HARDIK]);
  console.log(`\n${passed} checks passed`);
  srv.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
