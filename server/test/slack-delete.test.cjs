/**
 * delete_slack_messages (10 Nov 2026): how a message is named and matched. No network. npm run test:slack-delete
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
const d = require(path.join(DIST, 'server/src', 'slackDelete.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
assert.deepEqual(d.parseRef('https://bayshorizonnetwork.slack.com/archives/C0AUKTND199/p1794295052103189'), { channel: 'C0AUKTND199', ts: '1794295052.103189', thread_ts: null }); ok('a permalink names channel and ts');
assert.equal(d.parseRef('https://x.slack.com/archives/C0AUKTND199/p1794295052103189?thread_ts=1794295000.000100&cid=C0AUKTND199').thread_ts, '1794295000.000100'); ok('a reply link carries its thread');
assert.deepEqual(d.parseRef({ channel: 'C0AUKTND199', ts: '1794295052.103189' }), { channel: 'C0AUKTND199', ts: '1794295052.103189', thread_ts: null }); ok('{channel, ts} works');
assert.equal(d.parseRef('https://evil.com/archives/C0AUKTND199/p1794295052103189'), null); assert.equal(d.parseRef({ channel: 'x', ts: '1' }), null); ok('anything else is refused');
assert.equal(d.contains({ text: 'TEST -- LogStream e2e', blocks: [] }, 'logstream'), true); assert.equal(d.contains({ text: 'x', blocks: [{ text: { text: 'TEST card' } }] }, 'test card'), true); assert.equal(d.contains({ text: 'real log' }, 'TEST'), false); ok('contains reads text and blocks, case-blind');
assert.equal(d.permalink('C0AUKTND199', '1794295052.103189'), 'https://bayshorizonnetwork.slack.com/archives/C0AUKTND199/p1794295052103189'); ok('links are built back the same way');
console.log(`slack-delete: ${n} passed`);
