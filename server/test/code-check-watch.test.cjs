/**
 * The code check's alert, reminders and Codex note (29 Oct 2026, Destiny — D6); the channel card and
 * Mark reviewed (2 Nov 2026).
 *
 *   1. stepFor: the alert at approval, reminder 1 at 24 hours, then one every 12 hours.
 *   2. run(): one DM per step, claimed before it is sent; a repeat pass sends nothing; a DM Slack refuses
 *      gives the claim back and is retried; a dry run sends nothing and lists what would go; a late log says so.
 *   3. record_code_check is refused on every agent token, and a check recorded through the connector is
 *      written onto the log.
 *   4. codexNote writes the check onto the one Codex row that carries the id, and refuses to pick between two.
 *
 * No database and no network: pg, the events table, Slack and the audit lines are stood in.
 * Run with:  npm run test:code-check-watch
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
const pg = req('pg.js');
const events = req('engineEvents.js');
const cc = req('codeChecks.js');
const watch = req('codeCheckWatch.js');
const engineWrite = req('engineWrite.js');
const writeTools = req('mcp/writeTools.js');
const tools = req('mcp/codeCheckTools.js');
const slackMod = req('slack.js');

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const DESTINY = 'U0AEW3TBYH1';
const HOUR = 3_600_000;
const APPROVED = '2026-11-02T10:00:00.000Z';
const at = (h) => Date.parse(APPROVED) + h * HOUR;

/* 3 Nov 2026: the card opens the posted log; a sent check records itself. */
async function sendItAndTheRest() {
  const CX = 'CODEX-20261102-kavin-g-n-vfarm-incident-fix';
  const post = { ts: '1793640704.876389', bot_id: 'B1', text: `:book: Bays — Codex Entry *Codex ID:* \`${CX}\`` };
  assert.equal(watch.isLogPost(post, CX), true);
  assert.equal(watch.isLogPost({ ...post, bot_id: undefined }, CX), false);
  assert.equal(watch.isLogPost({ ...post, ts: '2', thread_ts: '1' }, CX), false);
  assert.equal(watch.isLogPost(post, 'CODEX-20261102-kavin'), false);
  assert.equal(watch.isLogPost({ ts: '3', bot_id: 'B1', text: `Code review for ${CX}` }, CX), false);
  ok('only Bays\' top-level post for that exact id is the log');
  assert.match(watch.threadUrl('C0BN30RU3UK', post.ts), /archives\/C0BN30RU3UK\/p1793640704876389\?thread_ts=1793640704\.876389&cid=C0BN30RU3UK$/);
  const due = { codex_entry_id: CX, builder: 'Kavin', session_date: null, approved_at: APPROVED, hours_waiting: 1, late: false, step: 0, channel_id: 'C1' };
  const url = (d) => watch.messageFor(d).blocks.find((b) => b.type === 'actions').elements[0].url;
  assert.match(url({ ...due, log_url: 'https://x.slack.com/a' }), /x\.slack\.com/);
  assert.match(url(due), /\/codex\//);
  assert.match(JSON.stringify(watch.messageFor(due).blocks), /was not found/);
  ok('Open the log goes to the post, else the dashboard and the card says so');

  const after = 1000;
  const m = { ts: '1001.5', user: DESTINY, text: `*Code check: Kavin, ${CX}, 3 Nov*\n*Verdict:* Matches the log` };
  assert.equal(watch.isSentCheck(m, CX, DESTINY, after), true);
  assert.equal(watch.isSentCheck({ ...m, user: 'U999' }, CX, DESTINY, after), false);
  assert.equal(watch.isSentCheck({ ...m, ts: '999' }, CX, DESTINY, after), false);
  assert.equal(watch.isSentCheck({ ...m, text: `I will do the code check for ${CX}` }, CX, DESTINY, after), false);
  assert.equal(watch.isSentCheck({ ...m, text: '*Code check: Kavin, CODEX-other*' }, CX, DESTINY, after), false);
  assert.equal(watch.isSentCheck({ ...m, bot_id: 'B1' }, CX, DESTINY, after), false);
  ok('only his own message opening the check, naming the log, after the save, counts');
  assert.equal(cc.cleanCheck({ codex_entry_id: 'CODEX-20261102-UNKNOWN-hardik-bhatt-hero-bay-freshness-fix', check_link: 'https://x.slack.com/archives/C0AF7AGC2UV/p1793640525750039', verdict: 'matches', verdict_reason: 'r', claims: [{ claim: 'c', where: 'w', result: 'confirmed', proof: 'p' }], pay_call: 'as_logged', requester_user_id: DESTINY }).verdict, 'matches');
  ok('a Codex ID with capitals in it is a Codex ID');
  const d = `*Verdict:* Partly matches, x\n*4. Pay call*\nPay partly`;
  assert.deepEqual(watch.compareSent(d, d.replace(/\*/g, ''), 'partly', 'partly'), { same: true, conflict: null });
  assert.equal(watch.compareSent(d, d + ' more', 'partly', 'partly').same, false);
  assert.match(watch.compareSent(d, d.replace('Partly matches', 'Overstated'), 'partly', 'partly').conflict, /verdict/);
  assert.match(watch.compareSent(d, d.replace('Pay partly', 'Hold'), 'partly', 'partly').conflict, /pay call/);
  ok('changed wording is noted; a changed verdict or pay call stops it');

  const realQ = pg.query;
  const rows = [{ codex_entry_id: CX, check_input: { verdict: 'matches', pay_call: 'as_logged' }, draft_text: `Code check: ${CX} Matches the log. Pay as logged`, channel: 'C1', thread_ts: post.ts, state: 'ready', prepared_by: DESTINY, prepared_at: 'x', epoch: '1000' }];
  const sqls = [];
  pg.query = async (sql, p) => {
    sqls.push({ sql, p });
    if (/SELECT codex_entry_id, check_input/.test(sql)) return { rows: rows.filter((r) => r.state === 'ready') };
    if (/SET state = 'recording'/.test(sql)) { const r = rows[0]; if (r.state !== 'ready') return { rows: [] }; r.state = 'recording'; return { rows: [{}] }; }
    if (/SET state = \$2/.test(sql)) { rows[0].state = p[1]; return { rows: [] }; }
    return { rows: [] };
  };
  const posts = []; const recorded = [];
  const sentMsg = { ts: '1500.25', user: DESTINY, text: `*Code check: Kavin, ${CX}*\nMatches the log\nPay as logged` };
  const deps = {
    post: async (c, text, b, ts) => { posts.push({ c, text, ts }); return { ok: true, detail: 'posted', ts: '9' }; },
    read: async () => ({ ok: true, read_as: 'Bays', messages: [sentMsg] }),
    record: async (i) => { recorded.push(i); return { check: { codex_entry_id: CX } }; },
    after: async () => ({ codex_note: { ok: true, detail: '' }, bharag_note: { ok: true, detail: '' }, review_card: { ok: true, detail: '' } }),
  };
  let r = await watch.recordSent(deps);
  assert.deepEqual(r.recorded, [CX]);
  assert.equal(recorded[0].requester_user_id, DESTINY);
  assert.match(recorded[0].check_link, /archives\/C1\/p150025/);
  assert.equal(recorded[0].posted_at, new Date(1500250).toISOString());
  assert.equal(posts.length, 1);
  assert.equal(posts[0].ts, post.ts);
  assert.match(posts[0].text, /Codex, BHARAG, the review card/);
  r = await watch.recordSent(deps);
  assert.equal(recorded.length, 1);
  ok('a sent check records once, from his own message, and confirms in the thread');

  rows[0].state = 'ready'; recorded.length = 0; posts.length = 0;
  r = await watch.recordSent({ ...deps, read: async () => ({ ok: true, read_as: 'Bays', messages: [{ ...sentMsg, text: `*Code check: ${CX}* Overstated. Hold` }] }) });
  assert.deepEqual(r.stopped, [CX]);
  assert.equal(recorded.length, 0);
  assert.equal(rows[0].state, 'stopped');
  ok('a changed verdict is not recorded and is raised');

  rows[0].state = 'ready';
  r = await watch.recordSent({ ...deps, read: async () => ({ ok: false, error: 'not_in_channel' }) });
  assert.deepEqual(r.unread, [CX]);
  assert.equal(rows[0].state, 'ready');
  ok('a thread that cannot be read stays ready');
  pg.query = realQ;
}

/* 3 Nov 2026: drafting the check marks the card; a draft left unsent says so once. */
async function draftMarksTheCard() {
  const CX = 'CODEX-20261103-kaiqi-yang-front-door-human-gate';
  const realQ = pg.query;
  const realRecord = events.record;
  const saved = []; const evs = new Set(); const posts = [];
  pg.query = async (sql, p) => {
    if (/INSERT INTO engine_code_check_prepared/.test(sql)) saved.push(p);
    if (/SELECT codex_entry_id, check_input/.test(sql)) return { rows: [{ codex_entry_id: CX, check_input: {}, draft_text: 'x', channel: 'C1', thread_ts: '1.1', state: 'ready', prepared_by: DESTINY, prepared_at: 'x', epoch: '1000' }] };
    if (/DELETE FROM engine_events/.test(sql)) { evs.delete(p[0]); return { rows: [] }; }
    if (/INSERT INTO engine_events/.test(sql)) { const k = p.find((x) => typeof x === 'string' && x.startsWith('code_check_unsent:')); if (evs.has(k)) return { rows: [] }; evs.add(k); return { rows: [{ id: 1 }] }; }
    if (/SELECT id::text, detail FROM engine_events/.test(sql)) return { rows: [{ id: '1', detail: { channel: 'C0CARD', ts: '7.7', due: {} } }] };
    return { rows: [] };
  };
  try {
    const marked = [];
    const args = { codex_entry_id: CX, draft_text: `Code check: Kaiqi, ${CX}\nMatches the log\nPay as logged`, channel_id: 'C1', thread_ts: '1.1', verdict: 'matches', pay_call: 'as_logged', requester_user_id: DESTINY };
    const deps = { dryRecord: async () => ({ check: { codex_entry_id: CX, recorded_by: DESTINY, verdict: 'matches', pay_call: 'as_logged' } }), mark: async (c, via) => { marked.push({ id: c.codex_entry_id, via }); return { ok: true, detail: 'Marked reviewed.' }; } };
    let r = await watch.prepare(args, { ...deps, dry_run: true });
    assert.equal(marked.length, 0);
    assert.equal(saved.length, 0);
    ok('a dry run marks nothing');
    r = await watch.prepare(args, deps);
    assert.equal(saved.length, 1);
    assert.deepEqual(marked, [{ id: CX, via: 'check drafted' }]);
    assert.match(r.message, /marked reviewed/);
    ok('saving the drafted check marks its card reviewed');
    r = await watch.prepare(args, { ...deps, mark: async () => ({ ok: false, detail: 'chat.update refused' }) });
    assert.equal(r.written, true);
    assert.match(r.message, /could not be marked: chat\.update refused/);
    ok('a card that cannot be marked never loses the saved check, and says so');
    const pass = { post: async (c, text, b, ts) => { posts.push({ c, text, ts }); return { ok: true, detail: 'posted' }; }, read: async () => ({ ok: true, read_as: 'Bays', messages: [] }) };
    await watch.recordSent({ ...pass, now: 1000 * 1000 + 5 * HOUR });
    assert.equal(posts.length, 0);
    await watch.recordSent({ ...pass, now: 1000 * 1000 + 6.1 * HOUR });
    await watch.recordSent({ ...pass, now: 1000 * 1000 + 9 * HOUR });
    assert.equal(posts.length, 1);
    assert.match(posts[0].text, /has not been sent/);
    ok('a draft left unsent says so once in the card thread after 6 hours');
  } finally {
    pg.query = realQ;
    events.record = realRecord;
  }
}

(async () => {
  /* 1. steps */
  assert.deepEqual([0, 1, 2.9, 3, 5.9, 6, 9, 24, 49].map(watch.stepFor), [0, 0, 0, 1, 1, 2, 3, 8, 16]);
  ok('the alert at approval, then a reminder every 3 hours');

  assert.equal(watch.alertsFrom({ on: false, from: null }), cc.START);
  assert.equal(watch.alertsFrom({ on: true, from: '2026-10-29T05:20:00.000Z' }), '2026-10-29T05:20:00.000Z');
  assert.equal(watch.alertsFrom({ on: true, from: '2026-11-05T00:00:00.000Z' }), cc.START);
  assert.equal(watch.alertsFrom({ on: false, from: '2026-10-29T05:20:00.000Z' }), cc.START);
  const trialSummary = cc.summarise([{ codex_entry_id: 'CODEX-T', builder: 'Kavin G N', builder_slack_id: 'U0BNQGG020Y', session_date: '2026-10-29', approved_at: '2026-10-29T08:00:00.000Z' }], [], Date.parse('2026-10-29T09:00:00.000Z'), '2026-10-29T05:20:00.000Z');
  assert.equal(trialSummary.waiting.length, 1);
  assert.equal(cc.summarise([{ codex_entry_id: 'CODEX-T', builder: 'K', builder_slack_id: 'U0BNQGG020Y', session_date: null, approved_at: '2026-10-29T08:00:00.000Z' }], [], Date.parse('2026-10-29T09:00:00.000Z')).waiting.length, 0);
  ok('the trial moves the alert start earlier, never later; off, or after 1 Nov, alerts start at 1 Nov; a 29 Oct approval waits only while the trial is on');

  /* 2. run() against stand-ins: one card in the channel, reminders in its thread, Mark reviewed */
  const held = new Map();
  let nextId = 1;
  const deleted = [];
  let waitingHours = 1;
  const real = { record: events.record, query: pg.query, read: cc.read, botCall: slackMod.botCall };
  events.record = async (e) => {
    if (held.has(e.dedupe_key)) return { recorded: false, id: null };
    const id = nextId++;
    held.set(e.dedupe_key, { id, e: { ...e, detail: { ...(e.detail || {}) } } });
    return { recorded: true, id };
  };
  const byId = (id) => [...held.values()].find((v) => v.id === Number(id));
  pg.query = async (sql, params) => {
    if (/DELETE FROM engine_events/.test(sql)) {
      deleted.push(params[0]);
      for (const [k, v] of held) if (v.id === params[0]) held.delete(k);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE engine_events SET detail/.test(sql)) { Object.assign(byId(params[0]).e.detail, JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/SELECT 1 FROM engine_events WHERE dedupe_key/.test(sql)) return { rows: held.has(params[0]) ? [{}] : [], rowCount: 0 };
    if (/SELECT id::text, detail FROM engine_events/.test(sql)) { const v = held.get(params[0]); return { rows: v ? [{ id: String(v.id), detail: v.e.detail }] : [] }; }
    if (/SELECT actor FROM engine_events/.test(sql)) { const v = held.get(params[0]); return { rows: v ? [{ actor: v.e.actor }] : [] }; }
    if (/code_check_marked_reviewed/.test(sql)) return { rows: [...held.values()].filter((v) => v.e.event_type === 'code_check_marked_reviewed' && params[0].includes(v.e.subject_id)).map((v) => ({ subject_id: v.e.subject_id })) };
    if (/Builder Channel ID/.test(sql)) return { rows: [{ cid: 'CODEX-20261102-kavin-g-n-rover', ch: 'C0BN30RU3UK' }], rowCount: 1 };
    throw new Error('unexpected query: ' + sql.slice(0, 80));
  };
  cc.read = async () => ({
    waiting: [
      { codex_entry_id: 'CODEX-20261102-kavin-g-n-rover', builder: 'Kavin G N', builder_slack_id: 'U0BNQGG020Y', session_date: '2026-11-02', approved_at: APPROVED, hours_waiting: waitingHours, late: waitingHours > cc.WINDOW_HOURS },
      { codex_entry_id: null, builder: 'Ahad', builder_slack_id: 'U0X', session_date: null, approved_at: APPROVED, hours_waiting: waitingHours, late: false },
    ],
  });
  const sent = [];
  let tsN = 100;
  const okPost = async (channel, text, blocks, thread_ts) => { sent.push({ channel, text, blocks, thread_ts, json: JSON.stringify(blocks || null) }); return { ok: true, detail: 'posted', ts: `1793.${tsN++}` }; };
  const calls = [];
  slackMod.botCall = async (method, body) => { calls.push({ method, body }); return { ok: true, http_status: 200 }; };

  try {
    let r = await watch.run({ find: async () => null, now: at(1), post: okPost });
    assert.equal(r.sent.length, 1);
    assert.equal(sent[0].channel, 'C0CDRV4TMCP');
    assert.equal(sent[0].thread_ts, undefined);
    assert.match(sent[0].text, /Code check due: Kavin G N, CODEX-20261102-kavin-g-n-rover/);
    assert.equal(sent[0].blocks[0].text.text, 'A log is ready for your code check');
    assert.match(sent[0].json, /Due by/);
    assert.match(sent[0].json, /codex\/CODEX-20261102-kavin-g-n-rover/);
    assert.match(sent[0].json, /<#C0BN30RU3UK>/);
    assert.match(sent[0].json, /"value":"CCR-CODEX-20261102-kavin-g-n-rover","action_id":"engine_approval_approve"/);
    assert.match(sent[0].json, /Mark reviewed/);
    assert.equal(held.get(watch.cardKey('CODEX-20261102-kavin-g-n-rover')).e.detail.ts, '1793.100');
    assert.equal(r.skipped.length, 1);
    ok('Jason approves: one card in #bha-code-reviews with Open the log, Code checks and Mark reviewed; its ts is kept on the claim');

    r = await watch.run({ find: async () => null, now: at(2), post: okPost });
    assert.equal(r.sent.length, 0);
    assert.equal(r.already, 1);
    assert.equal(sent.length, 1);
    ok('the next pass, still at the alert step, sends nothing: the claim is held');

    waitingHours = 4;
    r = await watch.run({ find: async () => null, now: at(4), post: async () => ({ ok: false, detail: 'not_in_channel' }) });
    assert.equal(r.failed.length, 1);
    assert.ok(!held.has(watch.dedupeKey('CODEX-20261102-kavin-g-n-rover', 1)));
    ok('a reminder Slack refuses gives its claim back, so it is never counted as sent');

    r = await watch.run({ find: async () => null, now: at(4), post: okPost });
    assert.equal(r.sent.length, 1);
    assert.equal(sent[1].thread_ts, '1793.100');
    assert.match(sent[1].text, /<@U0AEW3TBYH1> Reminder 1 of 4: Kavin G N's log was approved 4 hours ago/);
    ok('the next pass retries it and reminder 1 goes in the card\'s thread, tagging Destiny');

    waitingHours = 12.5;
    r = await watch.run({ find: async () => null, now: at(12.5), dry_run: true, post: okPost });
    assert.equal(r.would_send.length, 1);
    assert.match(r.would_send[0].text, /Last reminder/);
    assert.equal(sent.length, 2);
    ok('a dry run posts nothing and lists what would go');

    let m = await watch.markReviewed({ id: 'CCR-CODEX-20261102-kavin-g-n-rover', user_id: 'U0BNQGG020Y' });
    assert.equal(m.body.reason, 'not_allowed');
    assert.equal(calls[0].method, 'chat.postEphemeral');
    m = await watch.markReviewed({ id: 'CCR-CODEX-20261102-kavin-g-n-rover', user_id: DESTINY });
    assert.equal(m.body.ok, true);
    const upd = calls.find((c) => c.method === 'chat.update');
    assert.equal(upd.body.ts, '1793.100');
    assert.equal(upd.body.channel, 'C0CDRV4TMCP');
    assert.doesNotMatch(JSON.stringify(upd.body.blocks), /Mark reviewed/);
    assert.match(JSON.stringify(upd.body.blocks), /Marked reviewed by <@U0AEW3TBYH1>/);
    m = await watch.markReviewed({ id: 'CCR-CODEX-20261102-kavin-g-n-rover', user_id: 'U0A9V97949F' });
    assert.equal(m.body.reason, 'already_reviewed');
    ok('only Destiny or Jason can mark reviewed (anyone else is told privately); the card is rewritten without the button; a second click changes nothing');

    r = await watch.run({ find: async () => null, now: at(12.5), post: okPost });
    assert.equal(r.waiting, 0);
    assert.equal(sent.length, 2);
    ok('a reviewed log gets no more reminders');

    // A log past every reminder that was only ever DM'd gets its card, once.
    held.clear();
    waitingHours = 30;
    r = await watch.run({ find: async () => null, now: at(30), post: okPost });
    assert.equal(r.sent.length, 1);
    assert.equal(sent[2].blocks[0].text.text, 'Code check still owed');
    r = await watch.run({ find: async () => null, now: at(31), post: okPost });
    assert.equal(sent.length, 3);
    ok('a log past its reminders with no card gets one card and nothing after');
  } finally {
    Object.assign(events, { record: real.record });
    Object.assign(pg, { query: real.query });
    cc.read = real.read;
    slackMod.botCall = real.botCall;
  }

  /* 3. record_code_check: refused on every agent token; a recorded check is written onto the log */
  const audits = [];
  const realAudit = { open: writeTools.auditOpen, close: writeTools.auditClose, recordCheck: cc.recordCheck, note: watch.codexNote, rag: watch.bharagNote, card: watch.reviewedByCheck };
  watch.bharagNote = async () => ({ ok: true, documents: [], edited: [], detail: 'stood in' });
  watch.reviewedByCheck = async () => ({ ok: true, detail: 'stood in' });
  writeTools.auditOpen = async () => 77;
  writeTools.auditClose = async (_id, c) => { audits.push(c); };
  let recorded = 0;
  cc.recordCheck = async (args) => { recorded++; return { ok: true, written: true, corrected: false, check: { codex_entry_id: args.codex_entry_id, verdict: 'matches', pay_call: 'as_logged' }, message: 'Recorded.' }; };
  let noted = 0;
  watch.codexNote = async () => { noted++; return { ok: true, row_id: '397', detail: 'written onto Codex row 397' }; };
  const realAfter = watch.afterRecord;
  watch.afterRecord = async (c) => ({ codex_note: await watch.codexNote(c), bharag_note: await watch.bharagNote(c), review_card: await watch.reviewedByCheck(c) });
  const args = { codex_entry_id: 'CODEX-20261102-kavin-g-n-rover', check_link: 'https://bayshorizonnetwork.slack.com/archives/C0BN30RU3UK/p1793300000123456?thread_ts=1793290000.000100', verdict: 'matches', verdict_reason: 'x', claims: [], pay_call: 'as_logged', requester_user_id: DESTINY };
  try {
    for (const agent of ['bays', 'north_star', 'genie']) {
      const a = await tools.recordCodeCheck.handler(args, { access: 'write', agent });
      assert.equal(a.reason, 'agent_not_permitted');
    }
    assert.equal(recorded, 0);
    ok('every agent token is refused, Bays included: Destiny records his checks through the connector');

    let a = await tools.recordCodeCheck.handler(args, { access: 'write' });
    assert.equal(a.ok, true);
    assert.equal(noted, 1);
    assert.equal(a.codex_note.ok, true);
    assert.match(a.message, /Written onto the log/);
    ok('a check recorded through the connector is written onto the log');

    watch.codexNote = async () => ({ ok: false, row_id: null, detail: '2 Codex rows carry it' });
    a = await tools.recordCodeCheck.handler(args, { access: 'write' });
    assert.equal(a.ok, true);
    assert.match(a.message, /recorded, but it was not written onto the log: 2 Codex rows carry it/);
    ok('a note that does not land never fails the check, and the answer says so');
  } finally {
    writeTools.auditOpen = realAudit.open;
    writeTools.auditClose = realAudit.close;
    cc.recordCheck = realAudit.recordCheck;
    watch.codexNote = realAudit.note;
    watch.bharagNote = realAudit.rag;
    watch.reviewedByCheck = realAudit.card;
  }

  /* 4. codexNote */
  const realPatch = engineWrite.patchRecord;
  const patches = [];
  engineWrite.patchRecord = async (kind, id, fields) => { patches.push({ kind, id, fields }); return { ok: true }; };
  let rows = [{ id: '397' }];
  pg.query = async () => ({ rows, rowCount: rows.length });
  try {
    const check = { codex_entry_id: 'CODEX-x', verdict: 'partly', pay_call: 'partly', verdict_reason: 'one claim not found', check_link: 'https://x', posted_at: '2026-11-03T09:00:00.000Z', recorded_by: DESTINY };
    let r = await watch.codexNote(check);
    assert.equal(r.ok, true);
    assert.deepEqual(patches[0], { kind: 'codex', id: '397', fields: { 'Code Check Verdict': 'partly', 'Code Check Pay Call': 'partly', 'Code Check Reason': 'one claim not found', 'Code Check Link': 'https://x', 'Code Check At': '2026-11-03T09:00:00.000Z', 'Code Check By': DESTINY } });
    rows = [{ id: '1' }, { id: '2' }];
    r = await watch.codexNote(check);
    assert.equal(r.ok, false);
    assert.match(r.detail, /2 Codex rows carry CODEX-x \(ids 1, 2\); none was picked/);
    rows = [];
    r = await watch.codexNote(check);
    assert.match(r.detail, /no Codex row carries CODEX-x/);
    assert.equal(patches.length, 1);
    ok('the note goes onto the one Codex row carrying the id, as new fields merged in; two rows or none, nothing is written and it says why');
  } finally {
    engineWrite.patchRecord = realPatch;
    pg.query = real.query;
  }

  await sendItAndTheRest();
  await draftMarksTheCard();

  console.log(`\n${n} code check watch checks passed.`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
