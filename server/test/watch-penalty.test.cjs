/**
 * The Decision Watch pay penalty (2026-11-23): Jason's approved rule, pure parts. No database.
 * Run with: npm run test:watch-penalty
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const wp = require(path.join(DIST, 'server/src/watchPenalty'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const ts = (iso) => String(new Date(iso).getTime() / 1000);

const posted = new Date('2026-11-23T10:00:00Z'); // a Monday
assert.equal(wp.newDate('blocked: new date 2026-11-27', posted), '2026-11-27');
assert.equal(wp.newDate('waiting on the relay board, new date 28 Nov', posted), '2026-11-28');
assert.equal(wp.newDate('waiting on Jegan, Friday', posted), '2026-11-27');
assert.equal(wp.newDate('blocked till tomorrow', posted), '2026-11-24');
assert.equal(wp.newDate('blocked, no idea when', posted), null);
ok('a new date is read from ISO, day month, a weekday or tomorrow');

assert.deepEqual(wp.classify('Done: https://github.com/x/y/pull/9', posted), { kind: 'evidence' });
assert.deepEqual(wp.classify('closed in LOOP-1794856525804-H9KF', posted), { kind: 'evidence' });
assert.deepEqual(wp.classify('blocked: the relay board arrives Thursday, new date Friday', posted), { kind: 'blocker', new_date: '2026-11-27' });
assert.equal(wp.classify('on it, will look today', posted), null);
ok('evidence and a blocker with a new date are clean; "on it" is not');

const opened = new Date('2026-11-10T00:00:00Z');
const esc = new Date('2026-11-23T00:00:00Z');
assert.equal(wp.silence([], opened, esc).clean, false);
assert.equal(wp.silence([], opened, esc).silence_from.toISOString(), opened.toISOString());
assert.equal(wp.silence([{ ts: ts('2026-11-12T09:00:00Z'), text: 'on it' }], opened, esc).clean, false);
ok('no reply, or a reply that is neither evidence nor a blocker, is silence from when the watch opened');

assert.equal(wp.silence([{ ts: ts('2026-11-21T09:00:00Z'), text: 'blocked: waiting on Jegan, new date 2026-11-30' }], opened, esc).clean, true);
ok('Kavin: a blocker on time with a date not yet passed is never penalized');

const late = wp.silence([{ ts: ts('2026-11-12T09:00:00Z'), text: 'blocked on the board, new date 2026-11-14' }], opened, esc);
assert.equal(late.clean, false);
assert.equal(late.silence_from.toISOString(), '2026-11-14T23:59:59.000Z');
assert.equal(wp.silence([{ ts: ts('2026-11-12T09:00:00Z'), text: 'blocked on the board, new date 2026-11-14' }, { ts: ts('2026-11-15T09:00:00Z'), text: 'still waiting, update tomorrow' }], opened, esc).clean, true);
ok('missing your own new date with silence is a new miss from the end of that date; speaking again after it is not');

assert.equal(wp.silence([{ ts: ts('2026-11-21T09:00:00Z'), text: 'here it is https://dashboard.bhanetwork.org/evidence/EV-1' }], opened, esc).clean, true);
ok('evidence posted before it escalated is clean');

const d = (s) => new Date(s);
assert.equal(wp.levelFor([], d('2026-11-23')), 1);
assert.equal(wp.levelFor([d('2026-11-10')], d('2026-11-23')), 2);
assert.equal(wp.levelFor([d('2026-11-01'), d('2026-11-10')], d('2026-11-23')), 3);
assert.equal(wp.levelFor([d('2026-09-01'), d('2026-11-10')], d('2026-11-23')), 2);
assert.equal(wp.levelFor([d('2026-10-01')], d('2026-11-23')), 1);
assert.deepEqual([1, 2, 3, 4].map(wp.shareFor), [0.1, 0.25, 0.5, 0.5]);
ok('10%, then 25%, then 50% from the third, reset after 30 days with no escalation');

assert.deepEqual(wp.takeOff(1, 0, 0.1), { credited: 0.9, held: 0, taken: 0.1 });
assert.deepEqual(wp.takeOff(0.2, 0.5, 0.5), { credited: 0, held: 0.2, taken: 0.5 });
assert.deepEqual(wp.takeOff(0, 0, 0.25), { credited: 0, held: 0, taken: 0 });
ok('the penalty comes off the credited share first, then the held share, never below nought');

assert.equal(wp.inScopeLane('cst'), true);
assert.equal(wp.inScopeLane('VFARM'), true);
assert.equal(wp.inScopeLane('KIOSK'), true);
for (const l of ['VFARM_HARDWARE', 'CAPITAL', 'BAYS', 'ENGINE', 'NS', 'RT', 'GENIE', 'MEDIA']) assert.equal(wp.inScopeLane(l), false);
assert.equal(wp.inScopeLane('CAD_API'), false);
assert.equal(wp.inScopeLane(null), false);
assert.equal(wp.pushGroup('BAYS', 'Stripe 2KG0 live checkout'), 'Stripe 2KG0 / V52V and charge gate');
assert.equal(wp.pushGroup('VFARM_HARDWARE', 'rover pass on the rack'), 'Pilot 1 racks and hardware');
assert.equal(wp.pushGroup('CST', 'Monitoring Twin checklist'), 'Monitoring Twin');
assert.equal(wp.pushGroup('CST', 'Content-Type check'), 'CST');
ok('scope is vFarm, KIOSK and CST only (25 Nov); the 30-day push groups watches by what they block');

assert.match(wp.cardFlag({ watch_id: 'DW-1-ABCD', share: 0.1, penalty_id: 'WP-1-ABCD', level: 1 }), /^Watch penalty: DW-1-ABCD 10%/);
ok('the review card names the penalty by watch id');

console.log(`watch penalty: ${n} checks passed`);
