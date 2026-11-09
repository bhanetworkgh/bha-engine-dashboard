/**
 * The review notice goes once a parked log is completed (2026-11-09): only a write that turns Status to completed
 * fires it. The Slack delete runs live (proof in BUILD_LOG).
 * Run with: npm run test:layer0-notice
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { becameComplete } = require(path.join(DIST, 'server/src/layer0Notice'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
assert.equal(becameComplete({ Status: 'completed', 'Proof Type Answer': 'x' }, true), true); ok('a write that completes the row fires');
assert.equal(becameComplete({ Status: 'completed' }, false), false); ok('a repeat that changes nothing does not fire again');
assert.equal(becameComplete({ Status: 'pending_builder_input' }, true), false); ok('a row still waiting keeps its notice');
assert.equal(becameComplete({ Status: 'voided' }, true), false); ok('a voided row keeps its notice');
assert.equal(becameComplete({ 'Mission Fit Answer': 'x' }, true), false); ok('a write that does not set Status does not fire');
console.log(`layer0-notice: ${n} passed`);
