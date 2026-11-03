const assert = require('node:assert/strict');
const { responseUsage, nativeCost } = require('../../server-dist/server/src/modelUsage.js');
const node = { type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.anthropic.com/v1/messages' } };
const usage = { input_tokens: 106, output_tokens: 673, cache_creation_input_tokens: 11267,
  cache_read_input_tokens: 2809, cache_creation: { ephemeral_5m_input_tokens: 8458, ephemeral_1h_input_tokens: 2809 }, server_tool_use: { web_search_requests: 1 } };
const r = responseUsage(node, { model: 'claude-haiku-5-5', usage });
assert.equal(r.input, 14182);
assert.equal(r.read, 2809);
assert.equal(r.write1, 2809);
assert.ok(Math.abs(r.cost - (106*.1 + 673*.5 + 8458*.125 + 2809*.2 + 2809*.01)/1e6 - .01) < 1e-12);
assert.equal(responseUsage({ type: 'n8n-nodes-base.code', parameters: {} }, { model: 'claude-haiku-5-5', usage }), null, 'adapter does not double count');
assert.equal(responseUsage(node, { model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 2 } }).cost, null, 'unknown cache split is not zero');
assert.equal(nativeCost('claude-haiku-5-5', 0, 100, 100001, 0, 0), (100*2.5 + 100001*.05)/1e6, 'cache reads count toward long-context tier');
assert.equal(nativeCost('claude-haiku-5-5', 100000, 0, 0, 0, 0), .01);
assert.equal(nativeCost('claude-sonnet-5', 100, 100, 100, 100, 100), .00187);
assert.equal(nativeCost('unknown-model', 100, 100, 0, 0, 0), null);
console.log('Provider usage: cache accounting, real response fixture, long prompt threshold and adapter dedupe passed');
