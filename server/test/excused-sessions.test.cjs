// 28 Nov 2026: excused sessions for hard-block days (SOP 8996e4da). Pure parts; no database.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === 'pg') return require.resolve('./_pg-stub.cjs'); return realResolve.call(this, request, ...rest); };
const DIST = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const ex = require(path.join(DIST, 'excusedSessions.js'));
const gap = require(path.join(DIST, 'codexGap.js'));
const ls = require(path.join(DIST, 'logstream.js'));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ' + m); };
const now = new Date('2026-11-28T15:00:00Z');
const base = { builder_user_id: 'U0BNQGG020Y', block_type: 'power_outage', block_start: '2026-11-27T20:00:00Z', block_end: '2026-11-28T09:00:00Z', evidence: ['https://bayshorizonnetwork.slack.com/archives/C1/p1'], drafted_by: 'U0BNQGG020Y' };

let r = ex.checkDraft(base, now);
ok(r.ok && r.days.join() === '2026-11-27,2026-11-28', 'a block across midnight is one session per UTC day it touches');
ok(ex.checkDraft({ ...base, block_type: 'weather' }, now).reason === 'not_a_hard_block', 'weather alone is refused');
ok(ex.checkDraft({ ...base, evidence: [] }, now).reason === 'evidence_required', 'no artefact, no session');
ok(ex.checkDraft({ ...base, evidence: ['it rained'] }, now).reason === 'evidence_not_a_link', 'an artefact is a link or an EV- id');
ok(ex.checkDraft(base, new Date('2026-11-29T09:30:00Z')).reason === 'evidence_late', 'drafted more than 24 hours after the block ended is refused');
ok(ex.checkDraft({ ...base, block_end: '2026-11-28T16:00:00Z' }, now).reason === 'block_not_over', 'a block still going is refused');
ok(ex.checkDraft({ ...base, days: ['2026-11-26'] }, now).reason === 'day_outside_block', 'only days inside the block qualify');
ok(ex.checkDraft({ ...base, builder_user_id: 'U0AD1V1D65N' }, now).reason === 'former_builder', 'a former builder is refused');
ok(ex.daysIn(new Date('2026-11-27T08:00:00Z'), new Date('2026-11-28T00:00:00Z')).join() === '2026-11-27', 'a block ending at midnight does not touch the next day');

ok(ex.mayDecide({ builder_user_id: 'U0BNQGG020Y', test: false }, 'U0ADKG2A18B').reason === 'not_permitted', 'an agent or anyone else cannot approve');
ok(ex.mayDecide({ builder_user_id: 'U0AEW3TBYH1', test: false }, 'U0AEW3TBYH1').reason === 'own_session', 'Destiny cannot approve his own');
ok(ex.mayDecide({ builder_user_id: 'U0AEW3TBYH1', test: false }, 'U0A9V97949F') === null, 'Jason approves Destiny\'s');
ok(ex.mayDecide({ builder_user_id: 'U0BNQGG020Y', test: false }, 'U0AEW3TBYH1') === null, 'Destiny is the primary approver');

const rows = [{ day: '2026-11-27', block_end: new Date('2026-11-28T09:00:00Z'), status: 'approved' }, { day: '2026-11-28', status: 'pending' }];
const until = ex.coveredUntil(rows, new Date('2026-11-26T18:00:00Z'));
ok(until && until.toISOString() === '2026-11-28T00:00:00.000Z', 'only an approved day covers, to the end of that day');
const b = { user_id: 'U0BNQGG020Y', name: 'Kavin', days_logged: 8, last_log_at: '2026-11-26T18:00:00Z' };
ok(gap.findGaps([b], new Date('2026-11-28T08:00:00Z')).length === 1, 'without an excused day, 38 hours is a missed log');
ok(gap.findGaps([{ ...b, excused_until: until.toISOString() }], new Date('2026-11-28T08:00:00Z')).length === 0, 'with an approved excused day, it is not a missed log');
ok(gap.findGaps([{ ...b, excused_until: until.toISOString() }], new Date('2026-11-28T19:00:00Z')).length === 1, 'the day after the excused one counts as normal');

ok(ls.excludedReason({ workflow: ex.HARD_BLOCK_WORKFLOW, node: 'power_outage' }) === 'hard_block', 'a hard-block incident is never counted as an engine fault');
console.log(`excused sessions: ${n} checks passed`);
