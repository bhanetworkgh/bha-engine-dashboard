/**
 * Pay determinism and the no-double-pay guard (28 Nov 2026, Destiny; Jason's ask on DW-1794338142516-6JY9):
 * the same log scores the same way every time, and a docked re-log is never paid twice on a rescore.
 *
 *   1. Ahad's 9YQU log (CODEX-20261110-ahad-vfarm-chooser-verification, Codex row 472), with the work parts the review
 *      wrote on 10 Nov. The review called three of its four parts old on one run and new on the next (25% one run,
 *      a full day the other). With the engine deciding old or new, both versions give the same answer.
 *   2. A part whose every artefact is in an earlier approved log is docked, whatever the review called it.
 *   3. A part with no artefacts is old only on a strong earlier-work match and the review's say-so; never on the
 *      review alone.
 *   4. When the earlier-work check did not run, the review's call stands (and the card already says the check failed).
 *   5. The guard: a correction can never raise what a decided log pays, and a released share cannot be re-decided.
 *
 * No database and no network. Run with:  npm run test:pay-determinism
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
const ps = require(path.join(DIST, 'server/src', 'paySuggest.js'));
const pn = require(path.join(DIST, 'server/src', 'payNote.js'));

let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

// The four parts exactly as the review wrote them on Codex row 472 (10 Nov 2026).
const PARTS_472 = [
  { what: 'Diagnosis of VFarm adapter 404s via Render CLI/logs (sensor vs relay device_type filtering)', kind: 'non_code', new_this_session: true, merged: false, integrated: true, live_event: true, silent_failure: '', evidence: "Render logs showing 404s on device/unit checks for relay devices; confirmed via /api/v1/devices device_type field and corroborated by another engineer (Jignathan) that relays don't send readings", proof_level: 2, blocker: '', needs_live_event: false },
  { what: 'CST-vFarm farm/organization/unit discovery and selection API integration', kind: 'code', new_this_session: false, merged: true, integrated: true, live_event: true, silent_failure: '', evidence: 'Render deployment dep-dbo7qjdg1s2s7387df2g (8 Nov 2026); GET /api/v1/admin/vfarm/farms 200 (83-85ms); POST /select 200 at 11:50:23 UTC (4ms); commit f08e3570d19aafa55f0066e8bdb5040ea02e3438', proof_level: 3, blocker: 'awaiting_review', needs_live_event: true },
  { what: 'Regression test suite for admin vFarm UI (admin_vfarm_e2e.test.ts)', kind: 'code', new_this_session: false, merged: true, integrated: true, live_event: false, silent_failure: '', evidence: 'tests/integration/admin_vfarm_e2e.test.ts covers farm discovery, dashboard, device listing, telemetry, layout, alerts, and vision using mocked upstream', proof_level: 1, blocker: '', needs_live_event: false },
  { what: 'Live verification procedure documentation', kind: 'non_code', new_this_session: false, merged: true, integrated: true, live_event: false, silent_failure: '', evidence: 'docs/admin-vfarm-live-e2e.md documents the authenticated UI and CLI verification procedure', proof_level: 1, blocker: '', needs_live_event: false },
];
const row = (parts, cls = 'fresh_build') => ({ 'Log Class': cls, 'Work Parts': JSON.stringify(parts) });
const flip = (parts) => parts.map((p) => ({ ...p, new_this_session: !p.new_this_session }));
const allNew = (parts) => parts.map((p) => ({ ...p, new_this_session: true }));
const shares = (s) => [s.credited_share, s.held_share, s.docked_share, s.reason_tag];

// What the engine's check found for row 472: no approved log of Ahad's before it carried any of its artefacts, and no
// strong match (another recording, no earlier log named). The known ids are unrelated earlier work.
const CHECK_472 = { matches: [], looks_like_relog: false, known_ids: ['sha:4478db2', 'dep-aaaaaaaaaaaa1234', 'execution:80767'] };

// 1. The 9YQU case: the stored review and the other run's review give the same answer.
const a = ps.suggest(row(PARTS_472), CHECK_472);
const b = ps.suggest(row(allNew(PARTS_472)), CHECK_472);
const c = ps.suggest(row(flip(PARTS_472), 'RELOG_OLD_WORK'), CHECK_472);
assert.deepEqual(shares(a), shares(b));
assert.deepEqual(shares(a), shares(c));
ok(`9YQU scores the same on every version of the review: ${ps.lineFor(a)}`);
assert.equal(a.docked_share, 0);
ok('nothing in it is docked: none of its artefacts was in an approved log before it');
assert.ok(a.flags.some((f) => /review called this old work/.test(f)));
ok('the card says where the engine overruled the review');
// The same input twice is the same output.
assert.deepEqual(shares(ps.suggest(row(PARTS_472), CHECK_472)), shares(a));
ok('the same input twice gives the same answer');

// Without the engine deciding (the check did not run), the stored review docks 75%: the variation Jason saw.
const unread = ps.suggest(row(PARTS_472), { matches: [], looks_like_relog: false, unread: 'db down' });
assert.equal(unread.docked_share, 0.75);
ok('with no earlier-work check, the review alone decides, which is the 25% run of 10 Nov');

// 2. Every artefact already in an approved log: docked, whatever the review said.
const paid = { ...CHECK_472, known_ids: [...CHECK_472.known_ids, ...ps.artefactIds(PARTS_472[1].evidence)] };
const d1 = ps.suggest(row(PARTS_472), paid);
const d2 = ps.suggest(row(allNew(PARTS_472)), paid);
assert.deepEqual(shares(d1), shares(d2));
assert.equal(d1.parts[1].status, 'already_paid');
ok('a part whose every artefact was already logged is docked on every version of the review');
const reworked = [{ ...PARTS_472[1], evidence: `${PARTS_472[1].evidence}; follow-up commit 9c1e2fa` }];
assert.equal(ps.suggest(row(reworked), paid).parts[0].status !== 'already_paid', true);
ok('one new artefact makes it new work');

// 3. No artefacts: old only on a strong match and the review's say-so.
const bare = [{ what: 'Talked through the plan', kind: 'non_code', new_this_session: false, merged: false, integrated: false, live_event: false, silent_failure: '', evidence: 'the design doc', proof_level: 1, blocker: '', needs_live_event: false }];
assert.equal(ps.suggest(row(bare), CHECK_472).parts[0].status, 'live');
ok('no artefacts and no strong match: new, whatever the review said');
const strong = { ...CHECK_472, matches: [{ submission_id: 'X', codex_entry_id: 'CODEX-1', why: 'the same recording', strength: 'strong' }] };
assert.equal(ps.suggest(row(bare, 'RELOG_OLD_WORK'), strong).parts[0].status, 'already_paid');
assert.equal(ps.suggest(row(allNew(bare)), strong).parts[0].status, 'live');
ok('no artefacts on a strong match: the review decides only there');

// The ids it reads.
const ids = ps.artefactIds('commit f08e3570d19aafa55f0066e8bdb5040ea02e3438, dep-dbo7qjdg1s2s7387df2g, PR #90, execution 80767, EV-1794342433659-9YDL, LOOP-1794168643405-SK22, added');
assert.deepEqual(ids.sort(), ['EV-1794342433659-9YDL', 'dep-dbo7qjdg1s2s7387df2g', 'execution:80767', 'pr:90', 'sha:f08e357'].sort());
ok('artefacts: sha, deploy, PR, execution and record ids; never a loop id or a plain word');

// 5. The no-double-pay guard.
const prior = { released_share: 0, credited_share: 0.25, held_share: 0, docked_share: 0.75, decided_by: 'U0A9V97949F', decided_by_name: 'Jason' };
assert.throws(() => pn.correctionGuard(prior, 1, 0), (e) => e.reason === 'dock_stays_docked');
assert.throws(() => pn.correctionGuard(prior, 0.25, 0.5), (e) => e.reason === 'dock_stays_docked');
ok('a docked re-log cannot be raised by a correction, as credit or as held pay');
pn.correctionGuard(prior, 0.25, 0);
pn.correctionGuard(prior, 0, 0.25);
ok('a correction that keeps or lowers what it pays goes ahead');
assert.throws(() => pn.correctionGuard({ ...prior, released_share: 0.25 }, 0.25, 0), (e) => e.reason === 'already_released');
ok('a log with a released share cannot be re-decided at all');

console.log(`\n${n} checks passed`);
