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
const slack = { threads: {}, dms: {}, posts: [], unreadable: new Set(), refusePost: false, calls: [] };
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
      return send({ ok: true, messages: (slack.threads[`${b.channel}:${b.ts}`] || []).filter((m) => Number(m.ts) > Number(b.oldest || 0)) });
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
  await query(`INSERT INTO engine_channel_tracking (airtable_record_id, natural_id, fields, source, first_seen_at, updated_at, created_time) VALUES ($1, $1, '{}'::jsonb, 'engine', $2, $2, $2) ON CONFLICT DO NOTHING`, [CH, at(0).toISOString()]);
  const deps = (agent) => ({ access: 'write', agent, dispatch: async () => ({ status: 200, body: {} }), startedAt: '' });
  const open = (args, agent = null) => tools.openDecisionWatch.handler(args, deps(agent));
  let t = await open({ decision: 'Test watch for the build proof', owner_user_id: OWNER, requester_user_id: JASON, thread_link: `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733400000100?thread_ts=1791733300.000002&cid=${CH}`, fixture: true, wait_minutes: 1 }, 'bays');
  assert.equal(t.reason, 'fixture_not_for_agents');
  t = await open({ decision: 'Test watch for the build proof', owner_user_id: `<@${OWNER}>`, requester_user_id: JASON, thread_link: `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733400000100?thread_ts=1791733300.000002&cid=${CH}`, fixture: true, wait_minutes: 1 });
  assert.equal(t.ok, true);
  assert.equal(t.watch.thread_link, `https://bayshorizonnetwork.slack.com/archives/${CH}/p1791733300000002`);
  assert.equal(t.watch.wait_minutes, 1);
  assert.ok(t.audit_id > 0);
  const F = t.watch_id;
  slack.threads[`${CH}:1791733300.000002`] = [];
  r = await only(F, new Date(Date.now() + 2 * 60_000));
  assert.match(slack.posts.at(-1).text, /^TEST\. /);
  assert.equal((await dw.read()).watches.some((w) => w.watch_id === F), false, 'a fixture is not on the page');
  assert.equal((await dw.read({ fixtures: true })).watches.some((w) => w.watch_id === F), true);
  t = await open({ decision: 'Agent ask with a short wait', owner_user_id: OWNER, requester_user_id: JASON, channel_id: CH, thread_ts: '1791733300.000003', wait_hours: 0.1 }, 'bays');
  assert.equal(t.reason, 'bad_wait');
  t = await open({ decision: 'A dry run', owner_user_id: OWNER, requester_user_id: JASON, record_id: 'LOOP-123', dry_run: true }, 'bays');
  assert.equal(t.dry_run, true);
  t = await tools.closeDecisionWatch.handler({ watch_id: F, outcome: 'cancelled', reason: 'test over', requester_user_id: JASON }, deps('bays'));
  assert.equal(t.ok, true);
  const list = await tools.listDecisionWatches.handler({ open_only: true }, deps('bays'));
  assert.equal(list.watches.every((w) => w.status === 'watching'), true);
  const audit = await query(`SELECT outcome, kind FROM engine_mcp_writes WHERE tool = 'open_decision_watch' ORDER BY id DESC LIMIT 4`);
  assert.deepEqual(audit.rows.map((x) => x.outcome), ['dry_run', 'refused', 'applied', 'refused']);
  await query(`DELETE FROM engine_channel_tracking WHERE natural_id = $1`, [CH]);
  await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [OWNER]);
  assert.equal(audit.rows[0].kind, 'decision_watch');
  ok('the tools audit every call, refuse a test watch to an agent, and keep fixtures off the page');

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
