/**
 * Code checks (29 Oct 2026, Destiny — Jason's yes in DM D0AF0DG8ZPY, 1793181986.036119).
 *
 *   1. cleanCheck holds the format Jason confirmed: a verdict with a reason, claims with where, result and
 *      proof, follow-ups named for pay partly or hold, and it refuses a verdict the claims disagree with, an
 *      overstated log paid as logged, and anyone but Destiny or Jason.
 *   2. summarise: what is waiting (approved on or after 1 Nov, no check), late past 48 hours, Destiny's own
 *      sessions counted apart, the catalog from partly and overstated checks only, and the time to check.
 *
 * Pure: no database and no network. Run with:  npm run test:code-checks
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
const cc = require(path.join(DIST, 'server/src', 'codeChecks.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const refused = (input, reason) => {
  assert.throws(() => cc.cleanCheck(input), (e) => e instanceof cc.CodeCheckError && e.reason === reason, `expected ${reason}`);
};

const DESTINY = 'U0AEW3TBYH1';
const JASON = 'U0A9V97949F';
const HARDIK = 'U0BKT6MAW2Y';
const LINK = 'https://bayshorizonnetwork.slack.com/archives/C0AFPJ5S1C1/p1793300000123456?thread_ts=1793290000.000100';
const base = {
  codex_entry_id: 'CODEX-20261102-hardik-bhatt-media-twin',
  check_link: LINK,
  verdict: 'matches',
  verdict_reason: 'Everything the log claims is live.',
  claims: [{ claim: 'Media Twin posts to X', where: 'Render logs', result: 'confirmed', proof: 'post 1789 at 10:02 UTC' }],
  pay_call: 'as_logged',
  requester_user_id: DESTINY,
};

// 1. the format
const c = cc.cleanCheck(base);
assert.equal(c.verdict, 'matches');
assert.equal(c.claims.length, 1);
assert.deepEqual(c.follow_ups, []);
assert.equal(c.posted_at, null);
ok('a clean check that matches: verdict, one claim with its proof, pay as logged');

assert.equal(cc.cleanCheck({ ...base, requester_user_id: JASON }).requester, JASON);
refused({ ...base, requester_user_id: HARDIK }, 'not_permitted');
refused({ ...base, requester_user_id: '' }, 'not_permitted');
ok('Destiny or Jason may record a check; a builder may not');

refused({ ...base, codex_entry_id: 'CODEX-hardik' }, 'bad_codex_id');
refused({ ...base, check_link: 'https://example.com/x' }, 'bad_check_link');
refused({ ...base, verdict: 'fine' }, 'bad_verdict');
refused({ ...base, verdict_reason: ' ' }, 'reason_required');
refused({ ...base, claims: [] }, 'claims_required');
refused({ ...base, claims: [{ claim: 'x', where: '', result: 'confirmed', proof: 'p' }] }, 'bad_claim');
refused({ ...base, claims: [{ claim: 'x', where: 'GitHub', result: 'confirmed', proof: '' }] }, 'bad_claim');
refused({ ...base, pay_call: 'paid' }, 'bad_pay_call');
refused({ ...base, missing: ['vibes'] }, 'bad_missing');
ok('every part of the format is required and named when missing');

const notFound = { claim: 'Voice agent answers calls', where: 'Twilio and Render logs', result: 'not_found', proof: 'no call reached bha-cst between 08:30 and 10:03 UTC' };
refused({ ...base, claims: [...base.claims, notFound] }, 'verdict_disagrees');
refused({ ...base, verdict: 'overstated', verdict_reason: 'x' }, 'verdict_disagrees');
refused({ ...base, verdict: 'overstated', claims: [notFound], pay_call: 'as_logged' }, 'pay_disagrees');
refused({ ...base, verdict: 'partly', claims: [...base.claims, notFound], pay_call: 'partly' }, 'follow_ups_required');
ok('a verdict the claims disagree with is refused, an overstated log is not paid as logged, pay partly names its follow-ups');

const partly = cc.cleanCheck({
  ...base,
  verdict: 'partly',
  verdict_reason: 'Texts work; the voice line does not.',
  claims: [...base.claims, notFound],
  missing: ['monitored', 'tested_for_real', 'monitored'],
  pay_call: 'partly',
  follow_ups: [{ what: 'Voice line answers a real call', who: 'Ahad', by: '2026-11-07', loop_id: 'LOOP-1793205380544-53K4' }],
  couldnt_check: 'The Twilio console itself: my connector reads documentation only.',
});
assert.deepEqual(partly.missing, ['tested_for_real', 'monitored'], 'deduplicated, in Jason\'s order');
assert.equal(partly.follow_ups[0].loop_id, 'LOOP-1793205380544-53K4');
refused({ ...base, verdict: 'partly', claims: [...base.claims, notFound], pay_call: 'hold', follow_ups: [{ what: 'x', who: 'y', by: 'z', loop_id: 'LOOP-1' }] }, 'bad_follow_ups');
ok('a partly check keeps its missing items in Jason\'s order and its follow-ups with their loop ids');

// 2. summarise
const now = Date.parse('2026-11-04T12:00:00Z');
const approvals = [
  { codex_entry_id: 'CODEX-20261030-kaiqi-yang-genie', builder: 'Kaiqi Yang', builder_slack_id: 'U0AD1V1D65N', session_date: '2026-10-30', approved_at: '2026-10-31T10:00:00Z' },
  { codex_entry_id: 'CODEX-20261102-hardik-bhatt-media-twin', builder: 'Hardik Bhatt', builder_slack_id: HARDIK, session_date: '2026-11-02', approved_at: '2026-11-02T10:00:00Z' },
  { codex_entry_id: 'CODEX-20261102-ahad-cst', builder: 'Ahad', builder_slack_id: 'U0AC6RFNP3P', session_date: '2026-11-02', approved_at: '2026-11-02T09:00:00Z' },
  { codex_entry_id: 'CODEX-20261103-jeganathan-arm', builder: 'Jeganathan', builder_slack_id: 'U0AF011R821', session_date: '2026-11-03', approved_at: '2026-11-04T02:00:00Z' },
  { codex_entry_id: 'CODEX-20261103-destiny-arupi-code-checks', builder: 'Destiny Arupi', builder_slack_id: DESTINY, session_date: '2026-11-03', approved_at: '2026-11-03T20:00:00Z' },
];
const checks = [
  { codex_entry_id: 'CODEX-20261102-hardik-bhatt-media-twin', builder_name: 'Hardik Bhatt', verdict: 'matches', pay_call: 'as_logged', claims: base.claims, missing: [], follow_ups: [], posted_at: '2026-11-03T04:00:00Z', approved_at: '2026-11-02T10:00:00Z', hours_to_check: 18 },
];
let s = cc.summarise(approvals, checks, now);
assert.equal(s.approved_since_start, 4, 'the 31 Oct approval is before the start');
assert.equal(s.own_sessions_excluded, 1);
assert.equal(s.counts.waiting, 2);
assert.deepEqual(s.waiting.map((w) => w.codex_entry_id), ['CODEX-20261102-ahad-cst', 'CODEX-20261103-jeganathan-arm'], 'oldest first');
assert.equal(s.waiting[0].late, true, 'Ahad\'s, 51 hours, is past 48');
assert.equal(s.waiting[0].hours_waiting, 51);
assert.equal(s.waiting[1].late, false);
assert.equal(s.counts.late, 1);
assert.equal(s.counts.posted, 1);
assert.equal(s.catalog.length, 0, 'a check that matched is not in the catalog');
assert.deepEqual(s.hours_to_check, { n: 1, p50: 18, p95: 18 });
assert.equal(s.counts.within_window, 1);
assert.match(s.notes.join(' '), /Destiny's own/);
ok('waiting: approved since 1 Nov with no check, oldest first, late past 48 hours; Destiny\'s own counted apart; the catalog holds no match');

s = cc.summarise(approvals, [...checks, { codex_entry_id: 'CODEX-20261102-ahad-cst', builder_name: 'Ahad', verdict: 'partly', pay_call: 'partly', claims: partly.claims, missing: partly.missing, follow_ups: partly.follow_ups, posted_at: '2026-11-04T11:00:00Z', approved_at: '2026-11-02T09:00:00Z', hours_to_check: 50 }], now);
assert.equal(s.counts.waiting, 1);
assert.equal(s.counts.late, 0);
assert.equal(s.catalog.length, 1);
assert.equal(s.catalog[0].not_confirmed.length, 1);
assert.equal(s.catalog[0].not_confirmed[0].claim, 'Voice agent answers calls');
assert.equal(s.checks[0].codex_entry_id, 'CODEX-20261102-ahad-cst', 'newest check first');
assert.equal(s.counts.within_window, 1, 'the 50-hour check is outside the window');
assert.deepEqual(s.counts.verdicts, { matches: 1, partly: 1, overstated: 0 });
ok('a partly check enters the catalog with only its unconfirmed claims, and a check outside 48 hours is counted as such');

s = cc.summarise([], [], now);
assert.match(s.notes.join(' '), /not the same as nothing waiting/);
s = cc.summarise([approvals[0]], [], Date.parse('2026-10-29T12:00:00Z'));
assert.match(s.notes.join(' '), /Nothing is owed a check before 1 November/);
ok('no approval since 1 Nov says so rather than reading as nothing waiting, and before 1 Nov says nothing is owed yet');

console.log(`\ncode-checks: ${n} checks passed`);
