/**
 * Model spend's pure parts (2 Nov 2026): the counter between readings, a day's figure only where
 * a reading is near both edges, and eval windows merged so a dollar is counted once. No database.
 */
const assert = require('node:assert');
const m = require('../../server-dist/server/src/modelSpend.js');

let n = 0;
const ok = (cond, what) => { assert(cond, what); n++; console.log(`ok ${n} - ${what}`); };
const r = (at, usd) => ({ at, total_usage_usd: usd, total_credits_usd: null, origin: 'hourly' });
const H = 3600_000;

const readings = [r('2026-10-30T23:00:00Z', 100), r('2026-10-31T01:00:00Z', 110), r('2026-10-31T23:00:00Z', 200), r('2026-11-01T01:00:00Z', 210)];
ok(m.usageAt(readings, Date.parse('2026-10-31T00:00:00Z')) === 105, 'the counter at midnight is the straight line between the readings either side');
ok(m.usageAt(readings, Date.parse('2026-10-31T12:00:00Z'), 6 * H) === null, 'a point more than 6 hours from a reading is not guessed');
const days = m.dailySpend(readings, '2026-10-31', '2026-10-31');
ok(days.length === 1 && days[0].measured && days[0].spent_usd === 100, 'a day with readings near both edges is measured: 205 - 105 = 100');
const gap = m.dailySpend([r('2026-10-31T01:00:00Z', 110)], '2026-10-31', '2026-10-31');
ok(gap[0].measured === false && gap[0].spent_usd === null, 'a day without readings near both edges is not measured, never nought');
ok(m.spendBetween(readings, Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-11-02T00:00:00Z')).spent_usd === 110, 'spend between two instants is the last reading less the first');
const merged = m.mergedEvalSpend([
  { start: 0, end: 10, before: 100, after: 120 },
  { start: 5, end: 12, before: 105, after: 130 },
  { start: 20, end: 30, before: 140, after: 150 },
]);
ok(merged === 40, 'overlapping eval windows are counted once: (130 - 100) + (150 - 140)');
console.log(`\n${n} checks passed`);
