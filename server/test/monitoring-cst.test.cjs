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

// How a call or WhatsApp chat ended (8 Nov 2026, Jason on the 7 Nov log).
{
  const { cstEnded, endedSummary } = require(path.join(process.env.DIST || 'server-dist', 'server/src/systemFeeds.js'));
  assert.deepEqual(cstEnded({ metadata: { ended: { code: 'caller_hung_up', text: 'Caller hung up', handed_to_person: false } } }), { code: 'caller_hung_up', text: 'Caller hung up', handed_to_person: false });
  assert.deepEqual(cstEnded({ metadata: {} }), { code: null, text: null, handed_to_person: null }, 'a text or an older call has no ending, never a guess');
  assert.equal(cstEnded({ metadata: { ended: { code: 'something_new' } } }).code, 'other', 'an unknown code is kept as other');
  const t = m.endedTally([row({ ended_code: 'closed_by_genie' }), row({ ended_code: 'caller_hung_up', handed_to_person: true }), row({}), row({ channel: 'sms' })]);
  assert.deepEqual(t, { by_code: { closed_by_genie: 1, caller_hung_up: 1 }, handed_to_person: 1, calls_without_ending: 1 });
  const e = endedSummary([{ ended_code: 'went_quiet', handed_to_person: false, channel: 'whatsapp' }, { ended_code: null, handed_to_person: null, channel: 'voice' }, { ended_code: null, handed_to_person: null, channel: 'sms' }]);
  assert.equal(e.counted, 1);
  assert.equal(e.of_calls_and_chats, 2);
  assert.equal(e.mix[0].label, 'Went quiet');
  assert.match(e.note, /1 of 2/);
}
console.log('ended: ok');
