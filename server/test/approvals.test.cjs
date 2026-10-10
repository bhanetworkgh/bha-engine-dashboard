/**
 * The approval gate (2026-10-04, 8185), pinned in process against a real
 * database and local stand-ins for Slack and Google.
 *
 *   - A person's own call (no agent token) acts at once: nothing is gated.
 *   - An agent's share_doc does nothing, stores a request, posts one card with
 *     Approve and Deny, and answers awaiting_approval. A repeat answers the
 *     same request and posts no second card.
 *   - A click by somebody who is not Destiny or Jason changes nothing and is kept.
 *   - Approve runs the tool once; a second click is told it was already decided.
 *   - Deny does nothing and says so on the card.
 *   - A refusal the tool already makes (an outside address, a wrong confirm)
 *     is still an immediate refusal, with no card.
 *   - A DM with somebody who is not an approver sends the card to the alerts
 *     channel; the answer links it, and the decision is posted back to the DM.
 *   - An expired request is marked, its card says so, and a late click is refused.
 *   - A card Slack refuses is approval_card_not_posted, and nothing is left pending.
 *   - An approved action that fails says so and asks to be raised.
 *   - unshare_doc (2026-10-10) removes the public permission and nothing else,
 *     reads Drive again before saying so, refuses a file that is not public,
 *     says still_public when Drive keeps the link, and waits for a person when
 *     an agent asks.
 *
 * Run with:  npm run test:approvals   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:approvals writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ALERTS = 'C0ALERTS001';
const DESTINY = 'U0AEW3TBYH1';
const JASON = 'U0A9V97949F';
const HARDIK = 'U0BKT6MAW2Y';

const seen = { posts: [], updates: [], ephemerals: [], google: [], deletes: [], lists: [] };
/**
 * Who each Drive file is shared with, for unshare_doc. A file whose id starts
 * PUB_ or STUCK_ begins public; STUCK_ takes a delete and keeps the permission.
 */
const drive = new Map();
const permsOf = (id) => {
  if (!drive.has(id)) {
    const base = [
      { id: 'dom1', type: 'domain', role: 'writer', domain: 'bhanetwork.org' },
      { id: 'u1', type: 'user', role: 'owner', emailAddress: 'admin@bhanetwork.org' },
    ];
    drive.set(id, /^(PUB_|STUCK_)/.test(id) ? [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }, ...base] : base);
  }
  return drive.get(id);
};
let ts = 1791000000;

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(t));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(t)));
      }
    });
  });
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const slack = http.createServer(async (req, res) => {
  const b = await readBody(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/chat.postMessage') {
    if (b.channel === 'C0REFUSES1' || (b.channel === ALERTS && slack.refuseAlerts)) return json(res, 200, { ok: false, error: 'not_in_channel' });
    const stamp = `${++ts}.000100`;
    seen.posts.push({ ...b, ts: stamp });
    return json(res, 200, { ok: true, channel: b.channel, ts: stamp });
  }
  if (u.pathname === '/chat.update') {
    seen.updates.push(b);
    return json(res, 200, { ok: true, channel: b.channel, ts: b.ts });
  }
  if (u.pathname === '/chat.postEphemeral') {
    seen.ephemerals.push(b);
    return json(res, 200, { ok: true });
  }
  return json(res, 200, { ok: false, error: 'unknown_method' });
});

const google = http.createServer(async (req, res) => {
  const b = await readBody(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/token') return json(res, 200, { access_token: 'tok', expires_in: 3600 });
  const perm = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(u.pathname);
  if (perm && req.method === 'GET') {
    seen.lists.push(perm[1]);
    return json(res, 200, { permissions: permsOf(perm[1]) });
  }
  const one = /^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/.exec(u.pathname);
  if (one && req.method === 'DELETE') {
    seen.deletes.push({ file: one[1], permission: one[2] });
    if (!one[1].startsWith('STUCK_')) drive.set(one[1], permsOf(one[1]).filter((p) => p.id !== one[2]));
    res.writeHead(204);
    return res.end();
  }
  if (perm && req.method === 'POST') {
    if (perm[1] === 'FILE_DENIED') return json(res, 403, { error: { message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }] } });
    seen.google.push({ file: perm[1], ...b });
    return json(res, 200, { id: `perm-${seen.google.length}` });
  }
  const meta = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (meta) return json(res, 200, { id: meta[1], name: `Doc ${meta[1]}`, mimeType: 'application/vnd.google-apps.document', webViewLink: `https://docs.google.com/document/d/${meta[1]}/edit` });
  return json(res, 404, { error: { message: 'not found' } });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const slackPort = await listen(slack);
  const googlePort = await listen(google);
  process.env.SLACK_API_URL = `http://127.0.0.1:${slackPort}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.GOOGLE_API_URL = `http://127.0.0.1:${googlePort}`;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh';
  process.env.QUOTA_ALERT_CHANNEL = ALERTS;

  const req = (m) => require(path.join(DIST, 'server/src', m));
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const { toolByName } = req('mcp/tools.js');
  const { callerStore } = req('mcp/caller.js');
  const approvals = req('approvals.js');

  await migrate();

  const deps = { access: 'write', startedAt: new Date().toISOString(), dispatch: async () => ({ status: 404, body: null }) };
  const asAgent = (tool, args) => callerStore.run({ agent: 'bays' }, () => toolByName(tool, 'write').handler(args, { ...deps, agent: 'bays' }));
  const asPerson = (tool, args) => toolByName(tool, 'write').handler(args, deps);
  const rowOf = async (id) => (await query('SELECT * FROM engine_approvals WHERE approval_id = $1', [id])).rows[0];
  const T = Date.now();
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log(`  ok  ${name}`);
  };

  /* 1 — a person's own call is not gated */
  {
    const before = seen.google.length;
    const r = await asPerson('share_doc', { document_id: `DOC_PERSON_${T}` });
    assert.equal(r.ok, true);
    assert.equal(seen.google.length, before + 1);
    assert.equal((await query('SELECT count(*)::int AS n FROM engine_approvals WHERE target = $1', [`DOC_PERSON_${T}`])).rows[0].n, 0);
    ok('a person’s own share_doc acts at once and stores no request');
  }

  /* 2 — an agent's call waits for a person */
  const doc = `DOC_AGENT_${T}`;
  let approvalId;
  {
    const g = seen.google.length;
    const p = seen.posts.length;
    const r = await asAgent('share_doc', { document_id: doc, requester_user_id: HARDIK, channel_id: 'C0THREAD01', thread_ts: '1791000000.000001' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'awaiting_approval');
    assert.equal(r.done, false);
    assert.equal(seen.google.length, g, 'Google must not be called before approval');
    assert.equal(seen.posts.length, p + 1);
    const card = seen.posts[seen.posts.length - 1];
    assert.equal(card.channel, 'C0THREAD01');
    assert.equal(card.thread_ts, '1791000000.000001');
    const actions = card.blocks.find((b) => b.type === 'actions');
    assert.deepEqual(actions.elements.map((e) => e.action_id), [approvals.ACTION_APPROVE, approvals.ACTION_DENY]);
    approvalId = r.approval_id;
    assert.ok(actions.elements.every((e) => e.value === approvalId));
    assert.ok(card.blocks[0].text.text.includes(`<@${DESTINY}>`) && card.blocks[0].text.text.includes(`<@${JASON}>`));
    assert.ok(String(r.card_link).includes('/archives/C0THREAD01/p'));
    const row = await rowOf(approvalId);
    assert.equal(row.status, 'pending');
    assert.equal(row.agent, 'bays');
    const audit = (await query('SELECT outcome, detail FROM engine_mcp_writes WHERE id = $1', [r.audit_id])).rows[0];
    assert.equal(audit.outcome, 'awaiting_approval');
    ok('an agent’s share_doc does nothing, posts one card in the thread and answers awaiting_approval');

    const again = await asAgent('share_doc', { document_id: doc, requester_user_id: HARDIK, channel_id: 'C0THREAD01', thread_ts: '1791000000.000001' });
    assert.equal(again.reason, 'awaiting_approval');
    assert.equal(again.already_pending, true);
    assert.equal(again.approval_id, approvalId);
    assert.equal(seen.posts.length, p + 1, 'a repeat must not post a second card');
    ok('a repeat of the same call answers the same request and posts no second card');
  }

  /* 3 — only Destiny or Jason */
  {
    const g = seen.google.length;
    const r = await approvals.decide({ approval_id: approvalId, decision: 'approve', user_id: HARDIK, channel_id: 'C0THREAD01' });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'not_an_approver');
    assert.equal(r.body.raise, false);
    assert.equal(seen.google.length, g);
    const row = await rowOf(approvalId);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts.length, 1);
    assert.equal(row.attempts[0].user_id, HARDIK);
    assert.equal(seen.ephemerals[seen.ephemerals.length - 1].user, HARDIK);
    ok('a click by somebody else changes nothing, is kept on the row, and they are told');
  }

  /* 4 — approve runs it once */
  {
    const g = seen.google.length;
    const u = seen.updates.length;
    const r = await approvals.decide({ approval_id: approvalId, decision: 'approve', user_id: DESTINY });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.done, true);
    assert.equal(r.body.raise, false);
    assert.equal(seen.google.length, g + 1);
    assert.deepEqual({ file: seen.google[g].file, role: seen.google[g].role, type: seen.google[g].type }, { file: doc, role: 'reader', type: 'anyone' });
    const row = await rowOf(approvalId);
    assert.equal(row.status, 'approved');
    assert.equal(row.decided_by, DESTINY);
    assert.equal(row.result_ok, true);
    assert.equal(seen.updates.length, u + 1);
    assert.ok(seen.updates[u].blocks.every((b) => b.type !== 'actions'), 'the settled card has no buttons');
    assert.ok(seen.updates[u].blocks[0].text.text.includes('Approved'));
    const audit = (await query(`SELECT actor, outcome FROM engine_mcp_writes WHERE tool = 'share_doc' AND natural_id = $1 ORDER BY id DESC LIMIT 1`, [doc])).rows[0];
    assert.equal(audit.outcome, 'applied');
    assert.ok(audit.actor.includes(`approved-by:${DESTINY}`) && audit.actor.includes(approvalId), audit.actor);
    const ev = (await query(`SELECT event_type FROM engine_events WHERE subject_id = $1 ORDER BY id`, [approvalId])).rows.map((x) => x.event_type);
    assert.deepEqual(ev, ['approval_requested', 'approval_decided']);
    ok('Approve by Destiny runs the tool once, signs the audit line and settles the card');

    const second = await approvals.decide({ approval_id: approvalId, decision: 'approve', user_id: JASON });
    assert.equal(second.body.ok, false);
    assert.equal(second.body.reason, 'already_approved');
    assert.equal(seen.google.length, g + 1, 'a second click must not run it again');
    ok('a second click is told it was already approved and nothing runs twice');
  }

  /* 5 — the tool's own refusals come first */
  {
    const p = seen.posts.length;
    const r = await asAgent('grant_drive_access', { file_id: `FILE_${T}`, email: 'someone@gmail.com', requester_user_id: HARDIK });
    assert.equal(r.reason, 'non_bhanetwork_email');
    assert.equal(seen.posts.filter((x) => x.blocks).length, seen.posts.slice(0, p).filter((x) => x.blocks).length, 'no approval card for a refused call');
    ok('an outside address is still refused at once, with no card');
  }

  /* 6 — no Slack origin: the alerts channel; Deny does nothing */
  {
    const g = seen.google.length;
    const r = await asAgent('grant_drive_access', { file_id: `FILE_${T}`, email: 'kavin@bhanetwork.org', role: 'commenter', requester_user_id: HARDIK });
    assert.equal(r.reason, 'awaiting_approval');
    const card = seen.posts[seen.posts.length - 1];
    assert.equal(card.channel, ALERTS);
    assert.equal(card.thread_ts, undefined);
    assert.ok(card.blocks[0].text.text.includes('kavin@bhanetwork.org') && card.blocks[0].text.text.includes('commenter'));
    const d = await approvals.decide({ approval_id: r.approval_id, decision: 'deny', user_id: JASON });
    assert.equal(d.body.ok, true);
    assert.equal(d.body.decision, 'denied');
    assert.equal(d.body.done, false);
    assert.equal(seen.google.length, g);
    assert.equal((await rowOf(r.approval_id)).status, 'denied');
    assert.ok(seen.updates[seen.updates.length - 1].blocks[0].text.text.includes('Denied'));
    ok('with no Slack origin the card goes to the alerts channel, and Deny by Jason does nothing');
  }

  /* 7 — delete_record */
  {
    const made = await asPerson('create_record', { kind: 'lane_backlog', fields: { lane: 'BAYS', task: `approval test task ${T}`, north_star_tie: 'test' } });
    assert.equal(made.ok, true, JSON.stringify(made));
    const tid = made.natural_id;
    const p = seen.posts.length;
    const wrong = await asAgent('delete_record', { kind: 'lane_backlog', natural_id: tid, confirm: 'DELETE nope', reason: 'test' });
    assert.equal(wrong.ok, false);
    assert.equal(seen.posts.length, p, 'a wrong confirm posts no card');
    const r = await asAgent('delete_record', { kind: 'lane_backlog', natural_id: tid, confirm: `DELETE ${tid}`, reason: 'test clean-up', requester_user_id: DESTINY, channel_id: 'D0DESTINY1', thread_ts: '1791000000.000002' });
    assert.equal(r.reason, 'awaiting_approval', JSON.stringify(r));
    const card = seen.posts[seen.posts.length - 1];
    assert.equal(card.channel, 'D0DESTINY1', 'an approver’s own DM is used');
    assert.ok(!card.blocks[0].text.text.includes(`<@${JASON}>`), 'an approver asking in their own thread pings nobody');
    assert.ok(card.blocks[0].text.text.includes(tid));
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_lane_backlog WHERE natural_id = $1`, [tid])).rows[0].n, 1, 'still there before approval');
    const d = await approvals.decide({ approval_id: r.approval_id, decision: 'approve', user_id: DESTINY });
    assert.equal(d.body.ok, true, JSON.stringify(d.body));
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_lane_backlog WHERE natural_id = $1`, [tid])).rows[0].n, 0);
    assert.ok((await query(`SELECT count(*)::int AS n FROM record_deletions WHERE natural_id = $1`, [tid])).rows[0].n >= 1);
    ok('delete_record waits, then deletes on approval and keeps the row in record_deletions');
  }

  /* 8 — somebody else's DM cannot hold the card */
  {
    const r = await asAgent('share_doc', { document_id: `DOC_DM_${T}`, requester_user_id: HARDIK, channel_id: 'D0HARDIK01', thread_ts: '1791000000.000003' });
    assert.equal(r.reason, 'awaiting_approval');
    const cards = seen.posts.filter((x) => x.blocks && x.blocks.some((b) => b.block_id === `approval:${r.approval_id}`));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].channel, ALERTS);
    assert.ok(String(r.card_link).includes(`/archives/${ALERTS}/p`), 'the agent is handed the card link to pass on');
    ok('a DM with a non-approver sends the card to the alerts channel, and the answer links it');

    /* 9 — expiry */
    await query(`UPDATE engine_approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`, [r.approval_id]);
    const u = seen.updates.length;
    assert.equal(await approvals.sweepExpired(), 1);
    assert.equal((await rowOf(r.approval_id)).status, 'expired');
    assert.ok(seen.updates[u].blocks[0].text.text.includes('Expired'));
    const g = seen.google.length;
    const told = seen.posts[seen.posts.length - 1];
    assert.equal(told.channel, 'D0HARDIK01', 'the asker is told in their own DM that it expired');
    assert.ok(String(told.text).includes('expired'));
    const late = await approvals.decide({ approval_id: r.approval_id, decision: 'approve', user_id: DESTINY });
    assert.equal(late.body.reason, 'already_expired');
    assert.equal(seen.google.length, g);
    ok('an undecided request expires, its card and the asker are told, and a late click does nothing');
  }

  /* 10 — a card Slack refuses */
  {
    slack.refuseAlerts = true;
    const r = await asAgent('share_doc', { document_id: `DOC_NOCARD_${T}`, requester_user_id: HARDIK, channel_id: 'C0REFUSES1' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'approval_card_not_posted');
    assert.ok(r.message.includes('not_in_channel'));
    assert.equal((await rowOf(r.approval_id)).status, 'card_failed');
    slack.refuseAlerts = false;
    const retry = await asAgent('share_doc', { document_id: `DOC_NOCARD_${T}`, requester_user_id: HARDIK, channel_id: 'C0REFUSES1' });
    assert.equal(retry.reason, 'awaiting_approval', 'a failed card does not block the next ask');
    assert.equal(seen.posts[seen.posts.length - 1].channel, ALERTS, 'falls back to the alerts channel');
    ok('a refused card is approval_card_not_posted, nothing is left pending, and the next ask falls back');
  }

  /* 11 — approved, and then it fails */
  {
    const r = await asAgent('share_doc', { document_id: 'FILE_DENIED', requester_user_id: HARDIK, channel_id: 'C0THREAD01', thread_ts: `${T}.000009`.slice(-17) });
    assert.equal(r.reason, 'awaiting_approval', JSON.stringify(r));
    const d = await approvals.decide({ approval_id: r.approval_id, decision: 'approve', user_id: DESTINY });
    assert.equal(d.body.ok, false);
    assert.equal(d.body.raise, true);
    assert.ok(String(d.body.message).includes('does not have permission'));
    const row = await rowOf(r.approval_id);
    assert.equal(row.status, 'approved');
    assert.equal(row.result_ok, false);
    assert.ok(seen.updates[seen.updates.length - 1].blocks[0].text.text.includes('but it failed'));
    await query(`DELETE FROM engine_approvals WHERE target = 'FILE_DENIED'`);
    ok('an approved action that fails says so on the card and asks to be raised');
  }

  /* 13 — unshare_doc: a person closes a public link, and only that */
  {
    const file = `PUB_PERSON_${T}`;
    const dry = await asPerson('unshare_doc', { document_id: file, dry_run: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.would.remove, [{ permission_id: 'anyoneWithLink', role: 'reader' }]);
    assert.equal(seen.deletes.length, 0, 'a dry run removes nothing');
    const r = await asPerson('unshare_doc', { document_id: file, requester_user_id: DESTINY });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.public_link_removed, true);
    assert.deepEqual(seen.deletes, [{ file, permission: 'anyoneWithLink' }]);
    assert.deepEqual(r.removed, [{ permission_id: 'anyoneWithLink', role: 'reader' }]);
    assert.deepEqual(r.still_has_access.map((a) => a.who), ['everyone at bhanetwork.org', 'admin@bhanetwork.org'], 'the domain and the named people are untouched');
    assert.equal(seen.lists.filter((f) => f === file).length, 3, 'read for the dry run, read before, and read again after');
    assert.equal((await query('SELECT count(*)::int AS n FROM engine_approvals WHERE target = $1', [file])).rows[0].n, 0);
    const audit = (await query('SELECT outcome, detail, natural_id FROM engine_mcp_writes WHERE id = $1', [r.audit_id])).rows[0];
    assert.equal(audit.outcome, 'applied');
    assert.equal(audit.natural_id, file);
    assert.ok(audit.detail.includes('read back, none left'));
    ok('a person’s unshare_doc removes the public permission only, and reads Drive again before saying so');

    const again = await asPerson('unshare_doc', { document_id: file });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'not_public');
    assert.equal(seen.deletes.length, 1, 'a file that is not public is not touched');
    ok('a file with no public link is refused not_public and nothing is removed');
  }

  /* 14 — unshare_doc: Drive takes the removal and keeps the link */
  {
    const file = `STUCK_${T}`;
    const d = seen.deletes.length;
    const r = await asPerson('unshare_doc', { document_id: file });
    assert.equal(seen.deletes.length, d + 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'still_public');
    assert.equal(r.public_link_removed, false);
    assert.equal((await query('SELECT outcome FROM engine_mcp_writes WHERE id = $1', [r.audit_id])).rows[0].outcome, 'failed');
    ok('a link Drive keeps is still_public and failed, never reported closed');
  }

  /* 15 — unshare_doc: an agent waits for a person, like share_doc */
  {
    const file = `PUB_AGENT_${T}`;
    const d = seen.deletes.length;
    const p = seen.posts.length;
    const notOpen = await asAgent('unshare_doc', { document_id: `DOC_CLOSED_${T}`, requester_user_id: HARDIK, channel_id: 'C0THREAD01' });
    assert.equal(notOpen.reason, 'not_public');
    assert.equal(seen.posts.length, p, 'a refusal posts no card');
    const r = await asAgent('unshare_doc', { document_id: file, requester_user_id: HARDIK, channel_id: 'C0THREAD01', thread_ts: '1791000000.000015' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'awaiting_approval', JSON.stringify(r));
    assert.equal(seen.deletes.length, d, 'nothing is removed before a person approves');
    assert.equal(seen.posts.length, p + 1);
    assert.ok(seen.posts[p].blocks[0].text.text.includes('turn off "anyone with the link"'));
    const u = seen.updates.length;
    const done = await approvals.decide({ approval_id: r.approval_id, decision: 'approve', user_id: JASON });
    assert.equal(done.body.ok, true, JSON.stringify(done.body));
    assert.equal(done.body.raise, false);
    assert.deepEqual(seen.deletes.slice(d), [{ file, permission: 'anyoneWithLink' }]);
    assert.ok(seen.updates[u].blocks[0].text.text.includes('The public link is off'));
    const audit = (await query(`SELECT actor, outcome FROM engine_mcp_writes WHERE tool = 'unshare_doc' AND natural_id = $1 ORDER BY id DESC LIMIT 1`, [file])).rows[0];
    assert.equal(audit.outcome, 'applied');
    assert.ok(audit.actor.includes(`approved-by:${JASON}`), audit.actor);
    ok('an agent’s unshare_doc waits for a card, and Approve closes the link once');
  }

  /* 16 — the Slack destination guard: a DM to a known builder goes out, one to anyone else waits for a person */
  {
    const known = `UKNOWN${String(T).slice(-6)}`;
    const stranger = `USTRAN${String(T).slice(-6)}`;
    await query(`INSERT INTO engine_builder_profiles (natural_id, fields, source, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', now(), now())`, [known, JSON.stringify({ user_id: known, name: 'Guard Test Builder' })]);
    let p = seen.posts.length;
    const direct = await asAgent('send_nudge', { recipients: [known, JASON], text: 'Guard test: known people.' });
    assert.equal(direct.ok, true, JSON.stringify(direct));
    assert.deepEqual(seen.posts.slice(p).map((x) => x.channel), [known, JASON], 'known people are sent to at once, with no card');
    p = seen.posts.length;
    const dry = await asAgent('send_nudge', { recipients: [stranger], text: 'Guard test.', dry_run: true });
    assert.deepEqual(dry.not_in_builder_profiles, [stranger]);
    assert.equal(dry.would_wait_for_approval, true);
    assert.equal(seen.posts.length, p, 'a dry run posts nothing');
    const held = await asAgent('send_nudge', { recipients: [known, stranger], text: `Guard test ${T}: a stranger.` });
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'awaiting_approval', JSON.stringify(held));
    assert.equal(seen.posts.length, p + 1, 'only the card is posted');
    assert.ok(!seen.posts.slice(p).some((x) => x.channel === stranger || x.channel === known), 'nobody is sent the DM before a person approves');
    assert.ok(seen.posts[p].blocks[0].text.text.includes(`<@${stranger}>`));
    const done = await approvals.decide({ approval_id: held.approval_id, decision: 'approve', user_id: DESTINY });
    assert.equal(done.body.ok, true, JSON.stringify(done.body));
    assert.deepEqual(seen.posts.filter((x) => [known, stranger].includes(x.channel) && x.text && x.text.includes(`Guard test ${T}`)).map((x) => x.channel), [known, stranger], 'Approve sends it once to each');
    p = seen.posts.length;
    const person = await asPerson('send_nudge', { recipients: [stranger], text: 'Guard test: a person asking.' });
    assert.equal(person.ok, true);
    assert.equal(seen.posts.length, p + 1, 'a person on the connector is not gated');
    p = seen.posts.length;
    const file = await asAgent('post_file', { channel_id: stranger, title: `Guard ${T}`, content: 'x' });
    assert.equal(file.reason, 'awaiting_approval', JSON.stringify(file));
    await approvals.decide({ approval_id: file.approval_id, decision: 'deny', user_id: JASON });
    await query(`DELETE FROM engine_builder_profiles WHERE natural_id = $1`, [known]);
    await query(`DELETE FROM engine_approvals WHERE target LIKE $1`, [`%${stranger}%`]);
    ok('send_nudge and post_file: a known builder is sent to at once, anyone else waits for Approve, and a person is never gated');
  }

  /* 12 — unknown id */
  {
    const r = await approvals.decide({ approval_id: 'APR-0-NONE', decision: 'approve', user_id: DESTINY });
    assert.equal(r.status, 404);
    ok('an unknown approval id is a 404');
  }

  await query(`DELETE FROM engine_approvals WHERE target LIKE $1 OR target LIKE $2`, [`%${T}%`, `lane_backlog %`]);
  console.log(`\n${passed} checks passed.`);
  slack.close();
  google.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
