/**
 * SOP-aware LogStream, first pass (11 Nov 2026, sopCheck.ts). Pure; no database and no network.
 * Run with:  npm run test:sop-check
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
const s = require(path.join(DIST, 'server/src', 'sopCheck.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const hw = (t) => ({ 'Lanes Touched': 'VFARM_HARDWARE', Transcript: t, 'Builder User ID': 'U0BNQGG020Y', 'Session Description': 'Arm work' });

// A real line from Jegan's 28 Oct log: a part replaced, no service entry.
let v = s.evaluate(hw("3 hours for the Uno's USB failure and replacement, and 15 minutes on October 28, the drain valve coil spike day."));
assert.equal(v.result, 'conflict');
assert.match(v.evidence, /Uno's USB failure and replacement/);
ok('a part replaced with no service entry is a conflict, quoting the sentence');

v = s.evaluate(hw("The J2 elbow servo was swapped. Service entry: old part DS3218 v1, new part DS3218 v2, reason: failure."));
assert.equal(v.result, 'ok');
ok('a swap with a service entry passes');

// Real lines that talk about a swap that has not happened: planned, ordered, or not done.
for (const t of [
  'the soil sensor replacement and the remote restart path are both mapped with a clear next step each.',
  'One, an industrial grade replacement probe ordered today with model, vendor, and ETA on the loop.',
  'Every print since october 15, from part to STL to slicer to the Cobra, recorded reprint not done.',
]) assert.equal(s.evaluate(hw(t)).result, 'ok', t);
ok('a planned, ordered or not-done swap is not counted');

assert.equal(s.evaluate({ 'Lanes Touched': 'CST, GENIE', Transcript: 'I replaced the sensor.' }).result, 'not_applicable');
assert.equal(s.evaluate({ 'Lanes Touched': 'CST', Transcript: `On ${s.SOP.arm_loop} I replaced the wrist bracket.` }).result, 'conflict');
ok('applies only to VFARM_HARDWARE logs or the arm loop');

assert.equal(s.evaluate(hw('I replaced the old function with a cleaner one.')).result, 'ok');
ok('a code change worded as a replacement is not a part swap');

const p = s.promptText(hw('x'), { evidence: 'I swapped the servo.' }, 'https://dashboard.bhanetwork.org/codex/X');
assert.match(p, /^<@U0BNQGG020Y> You are diverging from SOP -- vFarm Hardware Modularity and Swapability \(d796bc63-fc33-4315-8dd4-66f4ec173102\)\. Please state why/);
assert.match(p, /does not block pay/);
ok("the question tags the author with Jason's wording and says it does not block pay");
console.log(`sop-check: ${n} passed`);
