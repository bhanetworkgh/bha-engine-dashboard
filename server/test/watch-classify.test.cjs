/**
 * Decision Watch closure classification (2026-11-26): every watch is closed with proof, superseded or open under
 * SOP 81cd9c04; a close with no reference and an escalation break it; an open watch is flagged stale on the record.
 * Run with: npm run test:watch-classify
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const { classify, refsIn, summarise, laneOf, laneGroup, heirFor, needsOwner, byLane } = require(path.join(DIST, 'server/src/watchClassify'));
const { idList } = require(path.join(DIST, 'server/src/mcp/decisionWatchTools'));
const { heldNote, realProblem } = require(path.join(DIST, 'server/src/decisionWatch'));

const now = new Date('2026-11-26T09:00:00Z');
const w = (o) => ({ watch_id: 'DW-1795000000000-AAAA', owner_user_id: 'U0AEW3TBYH1', owner_name: 'Destiny Arupi', status: 'watching', close_reason: null, record: null, decision: 'x', thread_link: null, closed_at: null, quiet_since: '2026-11-25T09:00:00Z', snoozed_until: null, ...o });

assert.deepEqual(refsIn('Done. Proof: https://x.slack.com/archives/C1/p1 and LOOP-1794664108482-YHGE'), ['https://x.slack.com/archives/C1/p1', 'LOOP-1794664108482-YHGE']);
console.log('  ok  a close reason gives its links and record ids');

assert.equal(classify(w({ status: 'answered', close_reason: 'Shown done. Proof: https://x/p1' }), null, now).state, 'closed_with_proof');
assert.equal(classify(w({ status: 'answered', close_reason: 'Destiny says it is done' }), null, now).state, 'closed_without_proof');
assert.equal(classify(w({ status: 'moved', record: { kind: 'loops', id: 'LOOP-1-ABCD' } }), null, now).state, 'closed_with_proof');
console.log('  ok  closed with proof, and a close with no reference breaks the SOP');

const sup = classify(w({ status: 'cancelled', close_reason: 'Folded into DW-1794598526865-OWYM, the same ask' }), null, now);
assert.equal(sup.state, 'superseded');
assert.equal(sup.successor, 'DW-1794598526865-OWYM');
assert.equal(classify(w({ status: 'cancelled', close_reason: `Folded into DW-1795000000000-AAAA` }), null, now).state, 'closed_without_proof');
console.log('  ok  superseded names its successor, and a watch is never its own successor');

assert.equal(classify(w({ status: 'escalated' }), null, now).compliant, false);
const open = classify(w({ record: { kind: 'loops', id: 'LOOP-1-ABCD' }, quiet_since: '2026-11-01T00:00:00Z' }), true, now);
assert.equal(open.state, 'open');
assert.equal(open.stale.length, 2);
assert.equal(classify(w({ owner_user_id: 'U0AD1V1D65N' }), null, now).stale[0], 'its owner has left BHA');
assert.equal(classify(w({ quiet_since: '2026-11-01T00:00:00Z', snoozed_until: '2026-11-30T00:00:00Z' }), null, now).stale.length, 0);
console.log('  ok  escalated breaks the SOP; open watches are stale on a closed loop, a former owner or 14 quiet days, never while snoozed');

const s = summarise([open, sup, classify(w({ owner_user_id: 'U0A9V97949F', owner_name: 'Jason', status: 'answered', close_reason: 'see https://x' }), null, now)]);
assert.equal(s.total, 3);
assert.equal(s.counts.open, 1);
assert.equal(s.stale_open, 1);
assert.equal(s.owners.find((o) => o.owner_user_id === 'U0A9V97949F').follows_sop, true);
assert.equal(s.owners.find((o) => o.owner_user_id === 'U0AEW3TBYH1').follows_sop, false);
console.log('  ok  the per-owner summary says who follows the SOP');

assert.deepEqual(idList('DW-1, DW-2 DW-1'), ['DW-1', 'DW-2']);
assert.equal(heldNote('held: Destiny Arupi was reminded by DW-1'), 'held: Destiny Arupi was reminded by DW-1');
assert.equal(realProblem('held: pacing'), null);
assert.equal(realProblem('conversations.replies as Bays: thread_not_found'), 'conversations.replies as Bays: thread_not_found');
console.log('  ok  an id list, and pacing is held, not a problem');

// Lanes and the aggregate (28 Nov 2026).
assert.equal(laneOf('CST', 'MEDIA'), 'CST');
assert.equal(laneOf(null, 'vfarm_hardware'), 'VFARM_HARDWARE');
assert.equal(laneOf(null, null), 'unrouted');
assert.equal(laneOf('UNASSIGNED', null), 'unrouted');
assert.equal(laneGroup('KIOSK'), 'vFarm');
assert.equal(laneGroup('GENIE'), 'Engine');
assert.equal(laneGroup('unrouted'), 'unrouted');
const viaLoop = classify(w({ lane: null, record: { kind: 'loops', id: 'LOOP-1-ABCD' } }), false, now, 'CST');
assert.equal(viaLoop.lane, 'CST');
assert.equal(viaLoop.lane_group, 'CST');
console.log('  ok  a watch takes its own lane, else its record\'s, and none or UNASSIGNED is unrouted, never guessed');

const lanes = byLane([
  classify(w({ lane: 'CST', status: 'escalated' }), null, now),
  classify(w({ lane: 'CST' }), null, now),
  classify(w({ lane: null }), null, now),
  classify(w({ lane: 'MEDIA', status: 'answered', close_reason: 'https://x' }), null, now),
]);
assert.deepEqual(lanes.map((l) => l.lane_group), ['CST', 'Media', 'unrouted']);
assert.deepEqual({ ...lanes[0], lanes: undefined }, { lane_group: 'CST', total: 2, open: 1, breaking_sop: 1, stale_open: 0, lanes: undefined });
assert.equal(summarise(lanes.length ? [classify(w({ lane: 'CST' }), null, now)] : []).lanes[0].lane_group, 'CST');
console.log('  ok  the lane aggregate counts total, open, breaking and stale per group, worst first and unrouted last');

assert.equal(heirFor('CST'), 'U0AC6RFNP3P');
assert.equal(heirFor('VFARM_HARDWARE'), 'U0AF011R821');
assert.equal(heirFor('MEDIA'), 'U0AEW3TBYH1');
assert.equal(heirFor('unrouted'), 'U0AEW3TBYH1');
assert.equal(needsOwner('open'), true);
assert.equal(needsOwner('escalated'), true);
assert.equal(needsOwner('closed_without_proof'), true);
assert.equal(needsOwner('closed_with_proof'), false);
assert.equal(needsOwner('superseded'), false);
console.log('  ok  a leaver\'s watch goes to its lane owner, else Destiny, and only open or SOP-breaking watches move');
console.log('watch-classify: all passed');
