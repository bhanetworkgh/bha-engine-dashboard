/** read_providers and the proof-type rule, pure parts (8 Nov 2026, Jason on the 7 Nov log). `npm run test:providers`. */
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.DIST || 'server-dist';
const p = require(path.join(dist, 'server/src/providers.js'));
const pt = require(path.join(dist, 'server/src/proofType.js'));

assert.equal(p.providerOf('anthropic/claude-haiku-5-5'), 'Anthropic');
assert.equal(p.providerOf('openrouter/anthropic/claude-sonnet-5'), 'OpenRouter');
assert.equal(p.providerOf(null), 'unknown');

const pairs = p.pairAgents([
  { agent_id: 'A', name: 'Bays (Agent)', model: 'anthropic/claude-haiku-5-5', published: true, read_at: '2026-11-06T09:00:00Z' },
  { agent_id: 'B', name: 'Bays (OpenRouter backup)', model: 'openrouter/anthropic/claude-haiku-5.5', published: true, read_at: '2026-11-06T09:01:00Z' },
  { agent_id: 'C', name: 'North Star (Agent)', model: 'anthropic/claude-sonnet-5', published: true, read_at: null },
]);
assert.equal(pairs.length, 2);
assert.equal(pairs[0].part, 'Bays');
assert.equal(pairs[0].main.provider, 'Anthropic');
assert.equal(pairs[0].backup.provider, 'OpenRouter');
assert.equal(pairs[0].read_at, '2026-11-06T09:00:00Z', 'the older of the two reads is the one stated');
assert.equal(pairs[1].backup, null, 'an agent with no backup recorded says none, never a guess');

assert.deepEqual(p.elevenLabsLlm({ conversation_config: { agent: { prompt: { llm: 'claude-sonnet-4-5', backup_llm_config: { preference: ['gemini-2.5-flash'] } } } } }), { model: 'claude-sonnet-4-5', backup: 'gemini-2.5-flash' });
assert.deepEqual(p.elevenLabsLlm({}), { model: null, backup: null });

assert.equal(pt.parseProofType('test_forced'), 'test_forced');
assert.equal(pt.parseProofType(' LIVE_NATURAL '), 'live_natural');
assert.equal(pt.parseProofType(undefined), null);
assert.throws(() => pt.parseProofType('kind of live'), /test_forced .* or live_natural/);
assert.equal(pt.proofLabel(null), 'how it was proven is not stated');
assert.match(pt.PROOF_RULE, /never "live"/);
console.log('providers and proof type: all checks passed');
