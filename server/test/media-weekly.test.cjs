/**
 * The Media Twin weekly readiness report (2026-11-09): a report logged in the Codex has its own stage and never goes on
 * pay, and the automatic checks question 3 names come from the claim check's own rules. Pure, no database; the facts
 * read and the log run live on the dashboard (proof in BUILD_LOG).
 * Run with: npm run test:media-weekly
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const pay = require(path.join(DIST, 'server/src/paySync'));
const sources = require(path.join(DIST, 'server/src/sources'));
const weekly = require(path.join(DIST, 'server/src/mediaWeekly'));
const media = require(path.join(DIST, 'server/src/mediaPosts'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

assert.equal(pay.isReport({ 'Log Kind': 'Report' }), true);
assert.equal(pay.isReport({ 'Log Kind': { name: 'report' } }), true);
assert.equal(pay.isReport({ 'Session Type': 'Media' }), false); ok('a Log Kind of Report is a report, and nothing else is');

const rec = (f) => ({ id: 'recX', createdTime: '2026-11-14T08:00:00Z', fields: { 'Submission ID': 'MTWR-2026-11-13', 'Codex Entry ID': 'CODEX-20261113-destiny-arupi-media-twin-readiness', ...f } });
const r = sources.mapCodex(rec({ 'Log Kind': 'Report' }), 'destiny', null, new Set());
assert.equal(r.stage, 'report'); assert.equal(r.log_kind, 'report'); ok('a report sits in the Reports stage, not Awaiting approval');
assert.equal(sources.mapCodex(rec({ 'Log Kind': 'Report', 'Jason Status': 'Rejected' }), 'destiny', null, new Set()).stage, 'rejected'); ok('a rejected report is still rejected');
assert.equal(sources.mapCodex(rec({}), 'destiny', null, new Set()).stage, 'awaiting'); ok('an ordinary log with no decision still waits on Jason');

const checks = weekly.automaticChecks().map((c) => c.id);
for (const b of media.BLOCKED) assert.ok(checks.includes(b.id));
for (const f of media.FLAGGED) assert.ok(checks.includes(f.id));
ok('every blocked and flagged claim rule is named as an automatic check');

console.log(`media-weekly: ${n} passed`);
