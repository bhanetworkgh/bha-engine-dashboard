/**
 * The code check's alert, reminders and Codex note (29 Oct 2026, Destiny — D6).
 *
 *   1. stepFor: the alert at approval, reminder 1 at 24 hours, then one every 12 hours.
 *   2. run(): one DM per step, claimed before it is sent; a repeat pass sends nothing; a DM Slack refuses
 *      gives the claim back and is retried; a dry run sends nothing and lists what would go; a late log says so.
 *   3. record_code_check on an agent token: only Bays, only for Destiny, only a Slack message Slack confirms he
 *      posted; any other agent, or Bays on write_audit_output, is refused as before.
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
const chargeGate = req('chargeGate.js');
const writeTools = req('mcp/writeTools.js');
const tools = req('mcp/codeCheckTools.js');

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const DESTINY = 'U0AEW3TBYH1';
const HOUR = 3_600_000;
const APPROVED = '2026-11-02T10:00:00.000Z';
const at = (h) => Date.parse(APPROVED) + h * HOUR;

(async () => {
  /* 1. steps */
  assert.deepEqual([0, 1, 2.9, 3, 5.9, 6, 9, 24, 49].map(watch.stepFor), [0, 0, 0, 1, 1, 2, 3, 8, 16]);
  ok('the alert at approval, then a reminder every 3 hours');

  /* 2. run() against stand-ins */
  const held = new Map();
  let nextId = 1;
  const deleted = [];
  let waitingHours = 1;
  const real = { record: events.record, query: pg.query, read: cc.read };
  events.record = async (e) => {
    if (held.has(e.dedupe_key)) return { recorded: false, id: null };
    const id = nextId++;
    held.set(e.dedupe_key, { id, e });
    return { recorded: true, id };
  };
  pg.query = async (sql, params) => {
    if (/DELETE FROM engine_events/.test(sql)) {
      deleted.push(params[0]);
      for (const [k, v] of held) if (v.id === params[0]) held.delete(k);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 1 FROM engine_events WHERE dedupe_key/.test(sql)) return { rows: held.has(params[0]) ? [{}] : [], rowCount: 0 };
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
  const okSend = async (to, text) => { sent.push({ to, text }); return { ok: true, detail: 'sent' }; };

  try {
    let r = await watch.run({ now: at(1), send: okSend });
    assert.equal(r.sent.length, 1);
    assert.equal(sent[0].to, DESTINY);
    assert.match(sent[0].text, /Code check due:\* Kavin G N, `CODEX-20261102-kavin-g-n-rover`/);
    assert.match(sent[0].text, /Due by .* Lagos \(48 hours\)/);
    assert.match(sent[0].text, /codex\/CODEX-20261102-kavin-g-n-rover\|Open the log/);
    assert.match(sent[0].text, /<#C0BN30RU3UK>/);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /no Codex ID/);
    ok('Jason approves: one DM to Destiny naming the builder, the Codex ID, the 48-hour deadline and the log; a session with no Codex ID is named as skipped');

    r = await watch.run({ now: at(2), send: okSend });
    assert.equal(r.sent.length, 0);
    assert.equal(r.already, 1);
    assert.equal(sent.length, 1);
    ok('the next pass, still at the alert step, sends nothing: the claim is held');

    waitingHours = 4;
    const failSend = async () => ({ ok: false, detail: 'channel_not_found' });
    r = await watch.run({ now: at(4), send: failSend });
    assert.equal(r.failed.length, 1);
    assert.equal(deleted.length, 1);
    assert.ok(!held.has(watch.dedupeKey('CODEX-20261102-kavin-g-n-rover', 1)));
    ok('a reminder Slack refuses gives its claim back, so it is never counted as sent');

    r = await watch.run({ now: at(4), send: okSend });
    assert.equal(r.sent.length, 1);
    assert.match(sent[1].text, /Reminder 1: code check still owed/);
    assert.match(sent[1].text, /Approved 4 hours ago/);
    ok('the next pass retries it and reminder 1 goes');

    waitingHours = 50;
    r = await watch.run({ now: at(50), dry_run: true, send: okSend });
    assert.equal(r.sent.length, 0);
    assert.equal(r.would_send.length, 1);
    assert.equal(r.would_send[0].step, 16);
    assert.match(r.would_send[0].text, /\*Late:\* approved 50 hours ago, 2 hours past the 48-hour window/);
    assert.equal(sent.length, 2);
    ok('a dry run sends nothing and lists what would go; past 48 hours the reminder says it is late; only the current step is sent, never a backlog');
  } finally {
    Object.assign(events, { record: real.record });
    Object.assign(pg, { query: real.query });
    cc.read = real.read;
  }

  /* 3. the agent guard on record_code_check */
  const audits = [];
  const realAudit = { open: writeTools.auditOpen, close: writeTools.auditClose, author: chargeGate.slackAuthor, recordCheck: cc.recordCheck, note: watch.codexNote };
  writeTools.auditOpen = async () => 77;
  writeTools.auditClose = async (_id, c) => { audits.push(c); };
  let author = { ok: true, user: DESTINY };
  chargeGate.slackAuthor = async () => author;
  let recorded = 0;
  cc.recordCheck = async (args) => { recorded++; return { ok: true, written: true, corrected: false, check: { codex_entry_id: args.codex_entry_id, verdict: 'matches', pay_call: 'as_logged' }, message: 'Recorded.' }; };
  let noted = 0;
  watch.codexNote = async () => { noted++; return { ok: true, row_id: '397', detail: 'written onto Codex row 397' }; };
  const args = { codex_entry_id: 'CODEX-20261102-kavin-g-n-rover', check_link: 'https://bayshorizonnetwork.slack.com/archives/C0BN30RU3UK/p1793300000123456?thread_ts=1793290000.000100', verdict: 'matches', verdict_reason: 'x', claims: [], pay_call: 'as_logged', requester_user_id: DESTINY };
  try {
    let a = await tools.recordCodeCheck.handler(args, { access: 'write', agent: 'north_star' });
    assert.equal(a.reason, 'agent_not_permitted');
    a = await tools.writeAuditOutput.handler({ output_id: 'x', requester_user_id: DESTINY }, { access: 'write', agent: 'bays' });
    assert.equal(a.reason, 'agent_not_permitted');
    ok('any agent but Bays is refused, and Bays still may not move a November output');

    a = await tools.recordCodeCheck.handler({ ...args, requester_user_id: 'U0BKT6MAW2Y' }, { access: 'write', agent: 'bays' });
    assert.equal(a.reason, 'not_destinys_check');
    a = await tools.recordCodeCheck.handler({ ...args, check_link: 'not a link' }, { access: 'write', agent: 'bays' });
    assert.equal(a.reason, 'check_link_required');
    author = { ok: true, user: 'U0BKT6MAW2Y' };
    a = await tools.recordCodeCheck.handler(args, { access: 'write', agent: 'bays' });
    assert.equal(a.reason, 'not_destinys_check');
    assert.match(a.message, /posted by U0BKT6MAW2Y, not Destiny/);
    author = { ok: false, reason: 'unreadable', message: 'Could not read C0BN30RU3UK.' };
    a = await tools.recordCodeCheck.handler(args, { access: 'write', agent: 'bays' });
    assert.equal(a.reason, 'check_unreadable');
    assert.equal(recorded, 0);
    ok('Bays is refused for anyone but Destiny, for a check link that is not a Slack link, for a message someone else posted, and when Slack cannot say who posted it; nothing is recorded');

    author = { ok: true, user: DESTINY };
    a = await tools.recordCodeCheck.handler(args, { access: 'write', agent: 'bays' });
    assert.equal(a.ok, true);
    assert.equal(recorded, 1);
    assert.equal(noted, 1);
    assert.equal(a.codex_note.ok, true);
    assert.match(a.message, /Written onto the log/);
    ok("Bays records Destiny's own posted check, and it is written onto the log");

    watch.codexNote = async () => ({ ok: false, row_id: null, detail: '2 Codex rows carry it' });
    a = await tools.recordCodeCheck.handler(args, { access: 'write' });
    assert.equal(a.ok, true);
    assert.match(a.message, /recorded, but it was not written onto the log: 2 Codex rows carry it/);
    ok('a note that does not land never fails the check, and the answer says so');
  } finally {
    writeTools.auditOpen = realAudit.open;
    writeTools.auditClose = realAudit.close;
    chargeGate.slackAuthor = realAudit.author;
    cc.recordCheck = realAudit.recordCheck;
    watch.codexNote = realAudit.note;
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

  console.log(`\n${n} code check watch checks passed.`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
