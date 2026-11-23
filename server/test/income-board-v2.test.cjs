/**
 * Income Board v2 (2026-11-23): Jason's seven sections, BLOCKS_PILOT_1 or QUALITY_OF_LIFE, dates with slips, owner
 * views, and STAGE1_PASSED read from the Stage 1 records only. Pure, no database.
 * Run with: npm run test:income-board-v2
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const b = require(path.join(DIST, 'server/src/incomeBoard'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

assert.equal(b.SECTIONS.length, 7);
assert.deepEqual(b.SECTIONS.map((s) => s.label), ['CST Gate A', 'Rover', 'Incident spine', 'Config + cabinet', 'Alerts + monitoring', 'CST + vFarm integration', 'Slack pilot + intake']);
ok("Jason's seven sections, in his order");

assert.deepEqual(b.dateState(null, true, '2026-11-23'), { date_state: 'date_to_set', days_slipped: null });
assert.deepEqual(b.dateState('2026-11-13', true, '2026-11-23'), { date_state: 'slipped', days_slipped: 10 });
assert.deepEqual(b.dateState('2026-12-05', true, '2026-11-23'), { date_state: 'set', days_slipped: null });
assert.deepEqual(b.dateState('2026-11-13', false, '2026-11-23'), { date_state: 'closed', days_slipped: null });
ok('an open item with no date is date_to_set, a past date is slipped with the days, a closed item is closed');

assert.equal(b.impactOf(null), 'BLOCKS_PILOT_1');
assert.equal(b.impactOf('QUALITY_OF_LIFE'), 'QUALITY_OF_LIFE');
ok('an item with no label counts as blocking');

const item = (id, open, impact, extra = {}) => ({ kind: 'loop', id, open, impact, owner: 'Ahad', section: 'cst_gate_a', date_state: open ? 'date_to_set' : 'closed', target_date: null, ...extra });
const gatesOk = [{ id: 'STAGE1_PASSED', open: false }, { id: 'CHARGE_GATE_OPEN', open: false }];
assert.equal(b.decide(gatesOk, [item('A', false, 'BLOCKS_PILOT_1'), item('B', true, 'QUALITY_OF_LIFE')]).ready, true);
assert.equal(b.decide(gatesOk, [item('A', true, 'BLOCKS_PILOT_1')]).ready, false);
assert.equal(b.decide([{ id: 'STAGE1_PASSED', open: true }, { id: 'CHARGE_GATE_OPEN', open: false }], [item('A', false, 'BLOCKS_PILOT_1')]).ready, false);
assert.match(b.decide([{ id: 'STAGE1_PASSED', open: true }, { id: 'CHARGE_GATE_OPEN', open: true }], [item('A', true, 'BLOCKS_PILOT_1')]).why, /STAGE1_PASSED and CHARGE_GATE_OPEN are false/);
assert.equal(b.decide(gatesOk, [item('B', false, 'QUALITY_OF_LIFE')]).ready, false);
ok('ready needs both gates and every BLOCKS_PILOT_1 item closed; quality of life never holds it at No');

const none = b.stage1Passed([]);
assert.equal(none.passed, false);
const one = b.stage1Passed([{ object_id: 'VFS1-1', status: 'passed', loop_ref: 'LOOP-1794856525804-H9KF' }]);
assert.equal(one.passed, false);
const both = b.stage1Passed([
  { object_id: 'VFS1-1', status: 'passed', loop_ref: 'LOOP-1794856525804-H9KF' },
  { object_id: 'VFS1-2', status: 'in_progress', loop_ref: 'L4WA' },
  { object_id: 'VFS1-3', status: 'passed', loop_ref: 'LOOP-1791587880697-L4WA' },
]);
assert.equal(both.passed, true);
assert.equal(b.stage1Passed([{ object_id: 'VFS1-1', status: 'passed', loop_ref: null }]).passed, false);
ok('STAGE1_PASSED only when a real passed record names each of H9KF and L4WA');

const items = [item('X', true, 'BLOCKS_PILOT_1'), item('Y', false, 'BLOCKS_PILOT_1'), item('Z', true, 'BLOCKS_PILOT_1', { section: null })];
const secs = b.bySection(items);
assert.equal(secs.length, 8);
assert.deepEqual(secs[0].remaining, ['X']);
assert.deepEqual(secs[0].done, ['Y']);
assert.ok(secs[1].empty_note);
assert.deepEqual(secs[7].remaining, ['Z']);
ok('sections list done and remaining ids, say so when empty, and catch items with no section');

const views = b.ownerViews([item('P', true, 'BLOCKS_PILOT_1', { target_date: '2026-12-05' }), item('Q', true, 'BLOCKS_PILOT_1', { target_date: '2026-11-28' }), item('R', true, 'QUALITY_OF_LIFE'), item('S', true, 'BLOCKS_PILOT_1', { owner: 'Hardik' })]);
assert.deepEqual(views.find((v) => v.key === 'ahad').blocks_pilot_1, ['Q', 'P']);
assert.deepEqual(views.find((v) => v.key === 'ahad').quality_of_life, ['R']);
assert.deepEqual(views.find((v) => v.key === 'hardik_destiny').blocks_pilot_1, ['S']);
ok('owner views: what each person owes that blocks Pilot 1, soonest first; Hardik and Destiny share one');

assert.equal(b.checkFields({ section: 'rover' }).ok, true);
assert.equal(b.checkFields({ section: 'nope' }).reason, 'bad_section');
assert.equal(b.checkFields({ impact: 'MAYBE' }).reason, 'bad_impact');
assert.equal(b.checkFields({ target_date: '5 Dec' }).reason, 'bad_target_date');
assert.deepEqual(b.checkFields({ target_date: '' }).set, { target_date: null });
assert.deepEqual(b.checkFields({}).set, {});
ok('set_income_board_item checks section, impact and date; an empty date clears to date_to_set');

console.log(`income board v2: ${n} checks passed`);
