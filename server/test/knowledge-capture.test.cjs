/**
 * Knowledge capture on the Income Board (2026-11-23): captured needs proof, a row's fields are checked, links are
 * worked out from ids, and the short blockers list agents read stays small. Pure, no database.
 * Run with: npm run test:knowledge-capture
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const kc = require(path.join(DIST, 'server/src/knowledgeCapture'));
const board = require(path.join(DIST, 'server/src/incomeBoard'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

assert.ok(kc.proofProblem(null));
assert.ok(kc.proofProblem('I wrote it down'));
assert.equal(kc.proofProblem('EV-1794387100730-42S2'), null);
assert.equal(kc.proofProblem('d796bc63-fc33-4315-8dd4-66f4ec173102'), null);
assert.equal(kc.proofProblem('https://docs.google.com/document/d/x'), null);
ok('captured needs an EV- id, a SOP id or an https link');

const base = { holder: 'U0BKT6MAW2Y', area: 'CAD API', piece: 'How a configuration becomes a CAD revision', mark: 'BLOCKS_PILOT_1' };
const v = kc.normalise({ ...base, lives_in: [{ kind: 'repo', ref: 'bhanetworkgh/cad-api' }] }, null);
assert.equal(v.status, 'not_started');
assert.equal(v.lives_in.length, 1);
assert.throws(() => kc.normalise({ ...base, mark: 'URGENT' }, null), /mark/);
assert.throws(() => kc.normalise({ ...base, holder: 'Hardik' }, null), /holder/);
assert.throws(() => kc.normalise({ ...base, status: 'captured' }, null), /proof/);
assert.throws(() => kc.normalise({ ...base, lives_in: [{ kind: 'wiki', ref: 'x' }] }, null), /kind/);
assert.throws(() => kc.normalise({ ...base, handover_date: '1 Dec' }, null), /YYYY-MM-DD/);
const kept = kc.normalise({ status: 'in_progress' }, { ...base, lives_in: [{ kind: 'loop', ref: 'LOOP-1794856066847-5DX1' }], handover_date: '2026-12-01' });
assert.equal(kept.area, 'CAD API');
assert.equal(kept.handover_date, '2026-12-01');
assert.equal(kept.lives_in.length, 1);
ok('a row is checked, and an update keeps every field it does not send');

assert.match(kc.refUrl({ kind: 'loop', ref: 'LOOP-1794856066847-5DX1' }), /\/open-loops\/LOOP-1794856066847-5DX1$/);
assert.equal(kc.refUrl({ kind: 'repo', ref: 'bhanetworkgh/bha-engine-dashboard' }), 'https://github.com/bhanetworkgh/bha-engine-dashboard');
assert.equal(kc.refUrl({ kind: 'file', ref: 'server/src/x.ts' }), null);
ok('links are worked out from ids, and a bare file path gets none');

const rows = Array.from({ length: 97 }, (_, i) => ({ loop_id: `LOOP-17950000000${String(i).padStart(2, '0')}-AAAA`, title: 'x'.repeat(400), status: 'Open', blocked_by: 'y', unblock_date: i === 5 ? '2026-11-01' : null, late: i === 5, days_late: i === 5 ? 22 : null, lane: 'CST', tag: null, why: i % 4 === 0 ? 'Stops the paid pilot.' : 'Nice to have.', owner: i % 2 ? 'Hardik' : 'Destiny', link: 'x' }));
const s = board.shortBlockers({ rows, late: 1, no_date: 96, read_at: 'now', rule: 'r' });
assert.equal(s.total, 97);
assert.equal(s.rows.length, board.SHORT_BLOCKERS);
assert.equal(s.rows[0].loop_id, rows[5].loop_id);
assert.ok(/Stops the paid pilot/.test(s.rows[1].why));
assert.equal(s.stops_paid_pilot, 25);
assert.ok(JSON.stringify(s).length < 20000, `short form is ${JSON.stringify(s).length} characters`);
ok('the short blockers list holds the counts and the 25 that matter, late first, under 20,000 characters');

console.log(`\n${n} checks passed`);
