/**
 * Outage classification (13 Nov 2026, Destiny — Jason on 408M, 2 Nov: "deterministic tests that assert the exact
 * counts and durations you just reported for the 16 Oct to now window, and the November-run view").
 * The numbers are Jegan's production read of 2 Nov (C0BT41XUWG7 1793617155.681509). Pure: no database, no network.
 *
 * Run with:  npm run test:outage-class
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const oc = require(path.join(DIST, 'server/src/outageClass'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const { incidents, summary } = oc.classify(oc.REFERENCE_408M);
const sensor = incidents.filter((i) => i.path !== 'pi_only');

assert.equal(summary.sensor_path_outages, 8); ok('eight outages of the sensor path since the 16 Oct 13:01 burn-in');
assert.equal(summary.gateway, 5); assert.equal(summary.board, 3); ok('five gateway events (Pi and board stale together), three board events (Pi healthy)');

const at = (start) => incidents.find((i) => i.start === start);
const power = at('2026-10-30T16:30:00Z');
// Jegan reported 906 min; his window as posted (16:30 to 07:35) is 905 whole minutes. The 906 comes from his
// second-level records, so the posted times are kept and the minute is named here rather than adjusted.
assert.equal(power.outage_type, 'POWER_CUT'); assert.equal(power.duration_min, 905); assert.equal(power.resolved_by, 'boot_record');
ok('30 Oct is POWER_CUT, 905 min from the posted times (Jegan: 906 from the seconds), 15.1 h, read from the boot record');
const link = at('2026-11-02T05:50:00Z');
assert.equal(link.outage_type, 'GATEWAY_LINK'); assert.equal(link.duration_min, 16); assert.equal(link.resolved_by, 'boot_record_no_reboot');
ok('2 Nov is GATEWAY_LINK, 16 min: the boot record shows no reboot, so the Pi stayed up');

const early = ['2026-10-19T15:44:00Z', '2026-10-20T13:26:00Z', '2026-10-21T16:44:00Z'].map(at);
assert.deepEqual(early.map((i) => i.duration_min), [40, 45, 285]);
for (const i of early) { assert.equal(i.outage_type, null); assert.deepEqual(i.candidates, ['POWER_CUT', 'GATEWAY_LINK']); assert.match(i.needs, /Pi journal/); }
ok('19, 20 and 21 Oct gateway events (40, 45, 285 min) stay unresolved, power or link, until the Pi journal settles them');

const board = sensor.filter((i) => i.outage_type === 'BOARD_HARDWARE');
assert.equal(board.length, 2); assert.equal(board.reduce((s, i) => s + i.duration_min, 0), 499);
ok('board hardware twice on 21 Oct, 479 + 20 = 499 min (8.3 h)');
const valve = at('2026-10-28T10:53:00Z');
assert.equal(valve.outage_type, 'VALVE_COIL'); assert.equal(valve.duration_min, 15); assert.equal(valve.path, 'board');
ok('28 Oct is VALVE_COIL, 15 min, with the Pi healthy');

assert.equal(summary.by_type.DEPLOY_REBOOT.count, 3); assert.equal(summary.by_type.CLEAN_REBOOT.count, 1);
assert.ok(incidents.filter((i) => i.path === 'pi_only').every((i) => /did not go stale/.test(i.source)));
ok('three deploy reboots and one clean reboot on the boot record, none of which staled the board');

// The November-run view.
const r = summary.run;
assert.deepEqual(r.counted.map((c) => [c.start, c.outage_type, c.duration_min]), [['2026-11-02T05:50:00Z', 'GATEWAY_LINK', 16]]);
assert.equal(r.counted_minutes, 16);
ok('November run: only the 2 Nov 16-min link drop counts against it');
assert.deepEqual(r.excluded.map((e) => e.outage_type).sort(), ['CLEAN_REBOOT', 'DEPLOY_REBOOT', 'DEPLOY_REBOOT', 'DEPLOY_REBOOT', 'POWER_CUT']);
assert.match(r.excluded.find((e) => e.outage_type === 'POWER_CUT').reason, /site mains power/);
ok('November run: the 15.1 h power cut, three deploy reboots and the clean reboot are excluded, each with its reason');
assert.ok(incidents.filter((i) => Date.parse(i.start) < Date.parse('2026-10-29T00:00:00Z')).every((i) => i.counts_against_run === false));
ok('everything before the run started (29 Oct) is outside it');

// Rules that hold beyond the reference data.
const unresolvedInRun = oc.classify({ board: [{ start: '2026-11-05T10:00:00Z', end: '2026-11-05T10:30:00Z' }], pi: [], boot: [], boot_record_since: '2026-10-29T09:40:00Z', run: { name: 'run', start: '2026-10-29T00:00:00Z' } }).incidents[0];
assert.equal(unresolvedInRun.outage_type, null); assert.deepEqual(unresolvedInRun.candidates, ['BOARD_HARDWARE', 'VALVE_COIL']); assert.equal(unresolvedInRun.counts_against_run, true);
ok('a board outage with no named cause is unresolved and still counts inside a run, never guessed into an excluded kind');
const journal = oc.classify({ board: [{ start: '2026-10-19T15:44:00Z', end: '2026-10-19T16:24:00Z' }], pi: [{ start: '2026-10-19T15:44:00Z', end: '2026-10-19T16:24:00Z' }], boot: [], boot_record_since: '2026-10-29T09:40:00Z', annotations: [{ start: '2026-10-19T15:40:00Z', end: '2026-10-19T16:30:00Z', outage_type: 'GATEWAY_LINK', source: 'Pi journal' }] }).incidents[0];
assert.equal(journal.outage_type, 'GATEWAY_LINK'); assert.equal(journal.resolved_by, 'annotation');
ok('a Pi journal annotation resolves an early gateway event');
const wrongKind = oc.classify({ board: [{ start: '2026-11-05T10:00:00Z', end: '2026-11-05T10:30:00Z' }], pi: [], boot: [], boot_record_since: null, annotations: [{ start: '2026-11-05T09:00:00Z', end: '2026-11-05T11:00:00Z', outage_type: 'POWER_CUT', source: 'x' }] }).incidents[0];
assert.equal(wrongKind.outage_type, null);
ok('a board-only outage cannot be annotated as a power cut: the Pi stayed healthy, so it stays unresolved');

console.log(`outage-class: ${n} passed`);
