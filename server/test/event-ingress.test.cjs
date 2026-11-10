/**
 * Decision-bearing event types cannot be posted from outside (10 Nov 2026, Destiny — Hardik's finding on
 * PR #23). Pure: engineEvents.externalRefusal, no database or network.
 *   SERVER_DIST=<built server> node server/test/event-ingress.test.cjs
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
const ev = require(path.join(DIST, 'server/src', 'engineEvents.js'));

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };

for (const t of ['VFARM_SUBSCRIBER_STATE_CHANGED', 'VFARM_SUBSCRIBER_UPGRADED', 'code_check_marked_reviewed', 'acceptance_evidence_recorded']) {
  const r = ev.externalRefusal(t);
  assert.ok(r && r.startsWith(`${t} cannot be posted from outside the dashboard`), t);
  assert.ok(ev.externalRefusal(`  ${t} `), `${t} with spaces`);
}
ok('the four decision-bearing types are refused, spaces or not');

for (const t of ['empty_read_check', 'self_healer_routed', 'cst_alert_test_run', 'VFARM_LEAD_CAPTURED', 'digest_dispatch_succeeded']) assert.equal(ev.externalRefusal(t), null, t);
ok('the types n8n really posts still go through');

for (const t of [undefined, null, 42, '', 'toString', 'constructor', '__proto__']) assert.equal(ev.externalRefusal(t), null, String(t));
ok('nothing odd is refused by accident, and object built-ins are not read as reserved');

assert.ok(Object.isFrozen(ev.IN_PROCESS_ONLY));
ok('the list cannot be changed at run time');

console.log(`\nevent-ingress: ${n} passed`);
