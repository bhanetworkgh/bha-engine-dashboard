/** log_sop's source link (23 Nov 2026): every shape an agent sends is stored as the workspace link. No database. */
const assert = require('node:assert/strict');
const { slackSourceLink } = require(process.env.SOP_DIST || '../../server-dist/server/src/mcp/sopTools.js');
const W = 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1795439220538429';
const cases = [
  [W, W],
  [W + '?thread_ts=1795434107.741089', W + '?thread_ts=1795434107.741089'],
  ['https://slack.com/archives/C0ASMPYQLG3/p1795439220538429', W],
  ['slack://channel?id=C0ASMPYQLG3&thread_ts=1795439220.538429', W],
  ['slack://channel?team=T0A9A0BEK0B&id=C0ASMPYQLG3&message=1795439300.000100&thread_ts=1795439220.538429', 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1795439300000100?thread_ts=1795439220.538429'],
  ['C0ASMPYQLG3 1795439220.538429', W],
  ['https://example.com/x', null],
  ['', null],
  ['slack://channel?id=C0ASMPYQLG3', null],
];
let n = 0;
for (const [input, want] of cases) { assert.equal(slackSourceLink(input), want, input); n += 1; }
console.log(`sop source link: ${n} checks passed`);
