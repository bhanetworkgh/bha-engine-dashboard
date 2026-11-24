/**
 * The end of day report (24 Nov 2026, Destiny): pure parts only, no database.
 *   - due from 17:00 New York, read in New York time whatever the server's clock (summer and winter);
 *   - tomorrow's priorities: each person's open Pilot 1 items, at most 2, late first, then soonest date, then In
 *     Progress before Open; closed items, quality-of-life items and unowned gates never appear;
 *   - the text has Jason's three sections, tags who is being waited on, and says so when nothing moved.
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
const e = require(path.join(DIST, 'server/src/eodReport.js'));
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

// 24 Nov 2026 is winter time in New York (UTC-5); 1 Jul 2026 is summer time (UTC-4).
assert.equal(e.isDue(new Date('2026-11-24T21:59:00Z')), false);
assert.equal(e.isDue(new Date('2026-11-24T22:00:00Z')), true);
assert.deepEqual(e.nyClock(new Date('2026-11-25T03:00:00Z')), { date: '2026-11-24', hour: 22 });
assert.equal(e.isDue(new Date('2026-07-01T20:59:00Z')), false);
assert.equal(e.isDue(new Date('2026-07-01T21:00:00Z')), true);
assert.equal(e.nyClock(new Date('2026-11-25T05:30:00Z')).date, '2026-11-25');
ok('due from 17:00 New York, summer and winter, and the day is the New York day');

const item = (id, owner, extra = {}) => ({
  kind: 'loop', id, title: `Item ${id}`, status: 'Open', open: true, lane: 'CST', owner, target_date: '2026-12-08',
  date_state: 'set', days_slipped: null, section: null, section_label: null, impact: 'BLOCKS_PILOT_1',
  last_change: '2026-11-20T00:00:00Z', moved_this_week: false, reason: '', link: `https://x/${id}`, ...extra,
});
const items = [
  item('LOOP-A-AAAA', 'Ahad'),
  item('LOOP-B-BBBB', 'Ahad', { status: 'In Progress' }),
  item('LOOP-C-CCCC', 'Ahad', { target_date: '2026-12-01' }),
  item('LOOP-D-DDDD', 'Ahad', { date_state: 'slipped', days_slipped: 2, target_date: '2026-11-22' }),
  item('LOOP-E-EEEE', 'Ahad', { open: false, date_state: 'closed' }),
  item('LOOP-F-FFFF', 'Jegan', { impact: 'QUALITY_OF_LIFE' }),
  item('LOOP-G-GGGG', 'Jegan'),
  { ...item('STAGE1_PASSED', null), kind: 'gate' },
];
const p = e.priorities(items);
assert.deepEqual(p.map((x) => [x.label, x.items.map((i) => i.id)]), [['Ahad', ['LOOP-D-DDDD', 'LOOP-C-CCCC']], ['Jegan', ['LOOP-G-GGGG']]]);
const p2 = e.priorities(items.filter((i) => !['LOOP-D-DDDD', 'LOOP-C-CCCC'].includes(i.id)));
assert.deepEqual(p2[0].items.map((i) => i.id), ['LOOP-B-BBBB', 'LOOP-A-AAAA']);
ok('priorities: late, then soonest, then In Progress; at most 2; closed, quality-of-life and gates left out');

const text = e.reportText({
  date: '2026-11-24', ready: 'No',
  logs: [{ builder: 'Ahad', id: 'U_1', title: 'Traces live', link: 'https://x/codex/U_1' }],
  moves: [{ id: 'LOOP-X-XXXX', kind: 'completion', title: 'Closed thing', owner: 'Jegan', changes: [], link: 'https://x/LOOP-X-XXXX' }],
  blocked: [{ person: { id: 'U0A9V97949F', name: 'Jason Bays' }, loops: [{ loop_id: 'LOOP-Y-YYYY', title: 'Needs Jason', link: 'https://x/y', late: true, days_late: 3, owner: 'Ahad' }] }],
  gates: [{ ...item('STAGE1_PASSED', null), kind: 'gate' }],
  priorities: p,
});
for (const s of ['*What moved*', '*What is blocked, and on whom*', "*Tomorrow's priorities*", 'Ahad: 1 log', 'Closed:', '<@U0A9V97949F>', '3d late', 'Gates still false: STAGE1_PASSED', '2 days late (was 2026-11-22)', 'Ready for the first paid Pilot 1 rack: *No*']) {
  assert.ok(text.includes(s), `missing: ${s}`);
}
const quiet = e.reportText({ date: '2026-11-24', ready: 'No', logs: [], moves: [], blocked: [], gates: [], priorities: [] });
assert.ok(quiet.includes('Nothing was logged or moved in the last 24 hours.'));
assert.ok(quiet.includes('No open loop is marked blocked on a person.'));
ok('the text has the three sections, tags who is waited on, and says when nothing moved');

console.log(`\neod-report: ${passed} checks passed`);
