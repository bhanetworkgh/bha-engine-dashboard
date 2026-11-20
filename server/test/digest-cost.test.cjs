// The cost line at the foot of the outside digest (20 Nov 2026). Pure; no database, no network.
const assert = require('node:assert');
const path = require('node:path');
const DIST = path.join(__dirname, '..', '..', 'server-dist');
const dc = require(path.join(DIST, 'server/src', 'digestCost.js'));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const usage = { usageCycle: { startAt: '2026-10-20T00:00:00.000Z', endAt: '2026-11-19T23:59:59.999Z' }, dailyServiceUsages: [
  { date: '2026-11-17T00:00:00.000Z', totalUsageCreditsUsd: 0.0000035 },
  { date: '2026-11-18T00:00:00.000Z', totalUsageCreditsUsd: 0.0000034 },
  { date: '2026-11-19T00:00:00.000Z', totalUsageCreditsUsd: 0.08004 } ] };
const limits = { monthlyUsageCycle: { startAt: '2026-10-20T00:00:00.000Z' }, limits: { maxMonthlyUsageUsd: 5 } };
const a = dc.apifyPart('2026-11-19', usage, limits);
ok(Math.abs(a.day_usd - 0.08004) < 1e-9, 'the day is its own line');
ok(Math.abs(a.cycle_to_day_usd - 0.0800469) < 1e-6, 'the cycle sums to the day');
ok(a.cap_usd === 5, 'the cap is given in the same cycle');
const b = dc.apifyPart('2026-11-18', usage, { monthlyUsageCycle: { startAt: '2026-11-20T00:00:00.000Z' }, limits: { maxMonthlyUsageUsd: 19 } });
ok(b.cap_usd === null, 'another cycle\'s cap is not used');
ok(dc.apifyPart('2026-11-16', { ...usage, dailyServiceUsages: [] }, null).day_usd === 0, 'a day Apify left out billed nothing');
ok(dc.apifyPart('2026-11-25', usage, null).day_usd === null, 'a day outside the cycle is not read as nought');
const c = dc.combine('2026-11-19', a, 0.0123);
ok(Math.abs(c.total_usd - 0.09234) < 1e-4, 'total adds both parts');
ok(dc.combine('2026-11-19', a, null).total_usd === null, 'no total without the model part');
const line = dc.costLine(c);
ok(line.includes('$0.08 Apify') && line.includes('$0.01 writing the digest') && line.includes('= *$0.09*') && line.includes('of $5.00'), line);
ok(dc.costLine(dc.combine('2026-11-19', a, null)).includes('digest writing not reported'), 'a missing part is said');
ok(dc.costLine(null).includes('not read'), 'no cost is said');
console.log(`digest-cost: ${n} checks passed`);
