/**
 * One working day is one Codex entry (14 Nov 2026, sameDay.ts): the UTC date and which log owns the day, pure.
 * No database, no network. SERVER_DIST=<compiled server dir> node server/test/same-day.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.SERVER_DIST || path.join(__dirname, '..', '..', 'server-dist', 'server', 'src');
const sd = require(path.join(dist, 'sameDay.js'));

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const row = (id, f) => ({ id: String(id), fields: { 'Builder User ID': 'U0AC6RFNP3P', ...f } });

ok('the UTC date, not Lagos or New York', () => {
  assert.equal(sd.utcDate('2026-11-12T23:12:33.805+01:00'), '2026-11-12'); // 22:12 UTC
  assert.equal(sd.utcDate('2026-11-13T00:30:00+01:00'), '2026-11-12'); // 23:30 on the 12th in UTC
  assert.equal(sd.utcDate('2026-11-14T03:30:00+01:00'), '2026-11-14'); // 02:30 on the 14th in UTC
  assert.equal(sd.utcDate('not a time'), null);
});

ok('nothing before the cutover is in a day', () => {
  assert.equal(sd.dayKey({ 'Builder User ID': 'U1', Timestamp: '2026-11-11T12:00:00Z' }), null);
  assert.deepEqual(sd.dayKey({ 'Builder User ID': 'U1', Timestamp: '2026-11-12T12:00:00Z' }), { builder: 'U1', date: '2026-11-12' });
  assert.equal(sd.dayKey({ 'Builder User ID': 'U1', Timestamp: '2026-11-12T12:00:00Z', 'Log Kind': 'Report' }), null);
});

ok("Ahad's 12 Nov: the paid log owns the day, the later one is merged, the sent-back one is in the day", () => {
  const plan = sd.planDay([
    row(496, { 'Submission ID': 'A_1', Timestamp: '2026-11-12T15:51:23.889+01:00', 'Codex Entry ID': 'CODEX-20261112-ahad-cst-truncation-fix', 'Jason Status': 'Approved', 'Jason Reviewed At': '2026-11-12T16:26:25.743+01:00', Paid: 'Yes' }),
    row(500, { 'Submission ID': 'A_2', Timestamp: '2026-11-12T19:17:46.926+01:00', 'Jason Status': 'Sent Back' }),
    row(501, { 'Submission ID': 'A_3', Timestamp: '2026-11-12T23:12:33.805+01:00', 'Codex Entry ID': 'CODEX-20261112-ahad-vfarm-failclose', 'Jason Status': 'Approved', 'Jason Reviewed At': '2026-11-13T15:15:25.322Z' }),
  ]);
  assert.equal(plan.get('496')['Merged Into Day'], false);
  assert.equal(plan.get('500')['Merged Into Day'], true);
  assert.equal(plan.get('501')['Merged Into Day'], true);
  assert.equal(plan.get('501')['Day Entry Codex ID'], 'CODEX-20261112-ahad-cst-truncation-fix');
  assert.equal(plan.get('501')['Day Logs'], 3);
  assert.equal(plan.get('501')['Day Log Number'], 3);
  assert.equal(plan.get('496')['Day Date'], '2026-11-12');
});

ok('the first log submitted owns the day, whatever is approved first', () => {
  const plan = sd.planDay([
    row(1, { 'Submission ID': 'S1', Timestamp: '2026-11-14T14:00:00Z', 'Jason Status': 'Pending' }),
    row(2, { 'Submission ID': 'S2', Timestamp: '2026-11-14T16:00:00Z', 'Jason Status': 'Approved', 'Jason Reviewed At': '2026-11-14T17:00:00Z', 'Codex Entry ID': 'CODEX-B' }),
  ]);
  assert.equal(plan.get('1')['Merged Into Day'], false);
  assert.equal(plan.get('2')['Merged Into Day'], true);
  assert.equal(plan.get('2')['Day Entry Submission ID'], 'S1');
  assert.equal(plan.get('2')['Day Entry Codex ID'], null);
  assert.equal(plan.get('2')['Day Log Number'], 2);
});

ok('a rejected log is in no day, and a single log is not merged', () => {
  const plan = sd.planDay([
    row(1, { 'Submission ID': 'S1', Timestamp: '2026-11-14T14:00:00Z', 'Jason Status': 'Rejected' }),
    row(2, { 'Submission ID': 'S2', Timestamp: '2026-11-14T16:00:00Z', 'Jason Status': 'Pending' }),
  ]);
  assert.equal(plan.has('1'), false);
  assert.equal(plan.get('2')['Merged Into Day'], false);
  assert.equal(plan.get('2')['Day Logs'], 1);
});

ok('isMerged reads true only', () => {
  assert.equal(sd.isMerged({ 'Merged Into Day': true }), true);
  assert.equal(sd.isMerged({ 'Merged Into Day': false }), false);
  assert.equal(sd.isMerged({}), false);
});

(async () => {
  const rows = [
    { id: '1', fields: { 'Builder User ID': 'U1', 'Submission ID': 'S1', Timestamp: '2026-11-13T09:00:00Z', 'Jason Status': 'Approved', 'Codex Entry ID': 'CODEX-A' } },
    { id: '2', fields: { 'Builder User ID': 'U1', 'Submission ID': 'S2', Timestamp: '2026-11-12T23:30:00Z', 'Jason Status': 'Approved' } },
    { id: '3', fields: { 'Builder User ID': 'U1', 'Submission ID': 'S3', Timestamp: '2026-11-13T05:00:00Z', 'Jason Status': 'Rejected' } },
  ];
  const db = { query: async () => ({ rows }) };
  const first = await sd.extraOfDay(db, { builder_user_id: 'U1', submission_id: 'S1', at: '2026-11-13T09:00:00Z' });
  assert.equal(first, null, 'the first log of the UTC day is not extra (the 12th and the rejected log do not count)');
  const extra = await sd.extraOfDay(db, { builder_user_id: 'U1', submission_id: 'S4', at: '2026-11-13T20:00:00Z' });
  assert.equal(extra.day_date, '2026-11-13');
  assert.equal(extra.entry_codex_id, 'CODEX-A');
  assert.equal(extra.log_number, 2);
  const before = await sd.extraOfDay(db, { builder_user_id: 'U1', at: '2026-11-11T20:00:00Z' });
  assert.equal(before, null, 'before the cutover nothing is extra');
  n++; console.log(`ok ${n} extraOfDay: a later log of the same UTC day is extra, the first is not`);
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
