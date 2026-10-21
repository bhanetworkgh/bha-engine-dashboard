/**
 * NJP4, the sensor side: a reading outside an unconfirmed range goes to Research Twin as a question.
 * Pure parts only (the sweep's SQL is proved against the live database read-only). No database, no network.
 * Run with:  npm run test:range-doubt   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const rd = require(path.join(DIST, 'server/src', 'rangeDoubt.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const PH = { min: 5.5, max: 6.5, unit: 'pH', source: 'Common hydroponic/substrate tomato guidance; to be confirmed against the Coimbatore growing medium' };
const CO2 = { min: 400, max: 1000, unit: 'ppm', source: 'Ambient to moderate enrichment; general greenhouse guidance, not yet tied to one reference' };
const TEMP = { min: 18.5, max: 29.5, unit: 'C', source: 'Shamshiri et al. 2018 (USDA ARS review): day 21-29.5 C' };
const SOIL = { min: null, max: null, unit: '%', source: null, note: 'OWNER_THRESHOLD_REQUIRED: depends on the probe calibration' };

assert.equal(rd.rangeConfirmed(PH).confirmed, false);
assert.equal(rd.rangeConfirmed(CO2).confirmed, false);
ok('pH and EC ("to be confirmed") and CO2 ("not yet tied") are unconfirmed, as the profile says');
assert.equal(rd.rangeConfirmed(TEMP).confirmed, true);
ok('a range citing a published source is confirmed');
assert.equal(rd.rangeConfirmed(SOIL).confirmed, false);
assert.equal(rd.rangeConfirmed({ min: 1, max: 2 }).confirmed, false);
assert.equal(rd.rangeConfirmed(null).confirmed, false);
ok('no source, an owner-threshold note or no target is never confirmed');
assert.equal(rd.rangeConfirmed({ ...PH, confirmed: true }).confirmed, true);
assert.equal(rd.rangeConfirmed({ ...TEMP, confirmed: false }).confirmed, false);
ok('an explicit confirmed flag on the target wins over the source text');

const q = rd.question({ farm_name: 'v-farm', metric: 'ph', stage: 'flowering', value: 4, min: 5.5, max: 6.5, unit: 'pH', source: PH.source });
assert.match(q, /ph read 4 pH, outside the flowering-stage range of 5.5 to 6.5 pH/);
assert.match(q, /not confirmed for this cabinet/);
assert.match(q, /real fault, or is the range wrong/);
ok('the question names the reading, the range, its doubtful source, and asks fault-or-range');
console.log(`\n${n} checks passed`);
