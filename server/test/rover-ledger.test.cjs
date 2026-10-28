/**
 * Rover passes and refused ledger writes (28 Oct 2026, D3 — Kavin's rover log of 26 Oct).
 *
 *   1. roverSignals reads the rover's pass summaries when vFarm sends passes and no run rows:
 *      runs and durations from the passes, stops with no photo from snapshot_failed, photos not sent,
 *      and the newest passes listed newest first with vFarm's own facts. Run rows still win.
 *   2. parseLedgerWrites keeps a good row, counts a bad one with its reason and refuses a bad block.
 *   3. ledgerFaults opens one fault per lane and farm with a refused entry, none for a clean lane,
 *      keeps an open one whose lane stopped reporting, and never judges a farm vFarm no longer lists
 *      or a real farm from a simulated report.
 *
 * Pure: no database and no network. Run with:  npm run test:rover-ledger
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
// The modules import pg for their database halves; nothing here touches it.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const vh = req('vfarmHistory.js');
const sf = req('systemFeeds.js');
const twin = req('monitoringTwin.js');

const now = Date.parse('2026-10-28T10:00:00Z');
const ago = (min) => new Date(now - min * 60_000).toISOString();

// 1. passes
const passes = [
  { id: 'p1', device_id: 'vfarm-rover-01', place: 'Zone A', status: 'complete', started_at: ago(200), ended_at: ago(180), stops_done: 3, stops_planned: 3, distance_mm: 1800, images_taken: 3, images_sent: 3, images_not_sent: [], failed_stops: [], position_mm: 0, position_known: true, returned_home: true, needs_manual_check: false, edge_version: '0.6.0' },
  { id: 'p2', device_id: 'vfarm-rover-01', place: 'Zone A', status: 'failed', started_at: ago(60), ended_at: ago(50), stops_done: 1, stops_planned: 3, distance_mm: 600, images_taken: 1, images_sent: 0, images_not_sent: [1], failed_stops: [{ seq: 2, reason: 'snapshot_failed' }, { seq: 3, reason: 'move_failed' }], position_mm: null, position_known: false, returned_home: false, needs_manual_check: true, edge_version: '0.6.0' },
  { id: 'p0', device_id: 'vfarm-rover-01', status: 'complete', started_at: ago(60 * 24 * 10), ended_at: ago(60 * 24 * 10 - 20), stops_done: 3, stops_planned: 3 },
];
let s = vh.roverSignals({ now, rovers: [{ device_id: 'vfarm-rover-01', status: 'online', last_seen_at: ago(1) }], runs: [], stops: [], videos: [], schedules: [], passes });
assert.equal(s.run_source, 'passes');
assert.deepEqual(s.runs_24h.value, { expected: null, started: 2, completed: 1, failed: 1, in_progress: 0 });
assert.match(s.runs_24h.note, /pass summaries/);
assert.equal(s.run_duration_vs_expected.value.median_s, 1200);
assert.deepEqual(s.stops_without_frame_24h.value, { stops: 1 + 1 + 3, without_frame: 1 });
assert.equal(s.upload_backlog.value.waiting, 1);
assert.equal(s.upload_backlog.value.oldest_age_s, 50 * 60);
assert.equal(s.passes.value.length, 2, 'a pass older than 8 days is not listed');
assert.equal(s.passes.value[0].id, 'p2', 'newest first');
assert.equal(s.passes.value[0].duration_s, 600);
assert.equal(s.passes.value[0].position_known, false);
assert.equal(s.passes.value[0].needs_manual_check, true);
assert.deepEqual(s.passes.value[0].failed_stops, [{ seq: 2, reason: 'snapshot_failed' }, { seq: 3, reason: 'move_failed' }]);
assert.equal(s.passes.value[1].distance_mm, 1800);
ok('passes stand in for run rows: 2 runs (1 failed), median 20 min, 1 stop with no photo of 5 reached, 1 photo not sent, newest pass first with its own facts');

s = vh.roverSignals({ now, rovers: [], runs: [{ run_id: 'r1', status: 'complete', started_at: ago(30), ended_at: ago(25) }], stops: [], videos: [], schedules: [], passes });
assert.equal(s.run_source, 'runs');
assert.deepEqual(s.runs_24h.value, { expected: null, started: 1, completed: 1, failed: 0, in_progress: 0 });
assert.doesNotMatch(s.runs_24h.note, /pass summaries/);
assert.equal(s.passes.value.length, 2, 'passes are still listed beside run rows');
s = vh.roverSignals({ now, rovers: [], runs: [], stops: [], videos: [], schedules: [] });
assert.equal(s.run_source, 'none');
assert.equal(s.passes.value, null);
assert.match(s.passes.note, /not sent by vFarm yet/);
ok('run rows win where vFarm sends them; with neither, the passes card says they are not sent yet');

// 2. parseLedgerWrites
const farms = ['F1', 'F2'];
assert.equal(sf.parseLedgerWrites({}, farms), null);
let w = sf.parseLedgerWrites({ ledger_writes: { lanes: [
  { lane: 'bharag_ledger', farm_id: 'F1', corpus: 'vfarm.sensor', sent: 8, written: 0, refused: 8, reasons: [{ code: 'schema_mismatch', count: 8 }], last_pass_at: ago(2) },
  { lane: 'rover_ledger', farm_id: 'F1', sent: 2, written: 2, refused: 0 },
  { lane: 'rover_ledger', farm_id: 'F1', sent: 1, written: 1, refused: 0 },
  { lane: 'alert_ledger', farm_id: 'F9', sent: 1, written: 1, refused: 0 },
  { lane: 'alert_ledger', farm_id: 'F2', sent: 1, written: 1, refused: 1 },
  { lane: 'Bad Lane', farm_id: 'F2', sent: 1, written: 1, refused: 0 },
] } }, farms);
assert.equal(w.lanes.length, 2);
assert.equal(w.lanes[0].refused, 8);
assert.deepEqual(w.lanes[0].reasons, [{ code: 'schema_mismatch', count: 8 }]);
assert.deepEqual(w.refused_rows.map((r) => r.index), [2, 3, 4, 5]);
assert.match(w.refused_rows[0].reason, /second row/);
assert.match(w.refused_rows[1].reason, /not in this snapshot/);
assert.match(w.refused_rows[2].reason, /more than sent/);
assert.throws(() => sf.parseLedgerWrites({ ledger_writes: { lanes: 'x' } }, farms), /needs lanes/);
ok('parseLedgerWrites keeps good rows, counts a duplicate, a foreign farm, impossible counts and a bad lane name, and refuses a malformed block');

// 3. ledgerFaults
const report = { taken_at: '2026-10-28T09:57:00Z', synthetic: false, lanes: w.lanes };
const fs = [{ farm_id: 'F1', synthetic: false, unlisted: false }, { farm_id: 'F2', synthetic: false, unlisted: false }];
let faults = twin.ledgerFaults([report], fs, []);
assert.equal(faults.length, 1);
assert.equal(faults[0].kind, 'ledger_refused');
assert.equal(faults[0].metric, 'bharag_ledger');
assert.equal(faults[0].farm_id, 'F1');
assert.equal(faults[0].severity, 'critical');
assert.match(faults[0].detail, /refused 8 of 8 bharag_ledger \(vfarm\.sensor\)/);
ok('a refused lane is one critical fault naming the lane and the counts; a clean lane is none');

faults = twin.ledgerFaults([{ ...report, lanes: [{ lane: 'bharag_ledger', farm_id: 'F1', corpus: null, sent: 8, written: 8, refused: 0, reasons: [] }] }], fs, [{ farm_id: 'F1', metric: 'bharag_ledger' }]);
assert.equal(faults.length, 0, 'a later report writing everything clears it');
faults = twin.ledgerFaults([{ ...report, lanes: [] }], fs, [{ farm_id: 'F1', metric: 'bharag_ledger' }]);
assert.equal(faults.length, 1);
assert.match(faults[0].detail, /has not reported since/);
ok('the fault clears once the lane writes everything, and stays open, saying so, while the lane is silent');

faults = twin.ledgerFaults([report], [{ farm_id: 'F1', synthetic: false, unlisted: true }, fs[1]], [{ farm_id: 'F1', metric: 'bharag_ledger' }]);
assert.equal(faults.length, 0, 'a farm vFarm stopped listing is not judged');
faults = twin.ledgerFaults([{ ...report, synthetic: true }], fs, []);
assert.equal(faults.length, 0, 'a simulated report never judges a real farm');
ok('a farm vFarm no longer lists, and a real farm under a simulated report, are not judged');

console.log(`\n${n} checks passed.`);
