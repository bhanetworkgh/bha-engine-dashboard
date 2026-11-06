/** The CST section of the Monitoring Twin, pure parts. `npm run test:monitoring-cst`. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { cstTestReason } = require(path.join(process.env.DIST || 'server-dist', 'server/src/systemFeeds.js'));
const m = require(path.join(process.env.DIST || 'server-dist', 'server/src/monitoringCst.js'));

const now = Date.parse('2026-11-06T12:00:00Z');
const row = (o) => ({ turn_id: 't', channel: 'voice', at: '2026-11-06T11:00:00Z', status: 'ok', intent: 'default', delivery_status: null, delivery_error: null, duration_ms: 1000, ...o });

const s = m.summarise([row({}), row({ at: '2026-11-02T11:00:00Z', status: 'error' }), row({ channel: 'sms', delivery_status: 'undelivered' })], new Map([['voice', '2026-11-06T11:00:00Z'], ['sms', '2026-11-06T11:00:00Z']]), now);
assert.deepEqual(s.channels.find((c) => c.channel === 'voice'), { channel: 'voice', last_24h: 1, last_7d: 2, failed_7d: 1, last_at: '2026-11-06T11:00:00Z' });
assert.equal(s.failed_7d, 2);
assert.equal(s.turns_7d, 3);
assert.equal(s.recent[2].failed, true);
for (const k of ['message', 'reply', 'phone_e164', 'customer_name']) assert.ok(!(k in s.recent[0]), `${k} must not be on the twin`);

const quiet = m.summarise([], new Map([['voice', '2026-10-30T19:18:14Z']]), now);
assert.equal(quiet.channels[0].last_7d, 0);
assert.equal(quiet.channels[0].last_at, '2026-10-30T19:18:14Z');
assert.match(quiet.note, /quiet line is not a fault/);

assert.equal(cstTestReason('conv_8801k9abc0def', { channel: 'voice' }), null, 'an ElevenLabs conversation id is real');
assert.match(cstTestReason('conv_8801k9abc0def', { phone_e164: '+15550000000' }), /555/, 'a console test call has no phone and stays a test');
assert.match(cstTestReason('conv_nested real', {}), /hand-made/);
console.log('monitoring-cst: all checks passed');
