/* The admin gate's pure rules, the agreement seal and the agent SQL refusal. No database, no network. */
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const a = require('../../server-dist/adminAuth.js');
const g = require('../../server-dist/agreements.js');
const { assertAgentSql } = require('../../server-dist/mcp/sql.js');

for (const [p, m] of [['/api/pay', 'GET'], ['/api/pay/metrics', 'GET'], ['/api/code-checks', 'GET'], ['/api/agreements', 'GET'], ['/api/agreements/AG-1/file', 'GET'], ['/api/codex/x/reject', 'POST'], ['/api/codex/x', 'PATCH'], ['/api/codex/x', 'DELETE'], ['/api/media-posts/MTP-1/approve', 'POST']]) assert.equal(a.gated(p, m, false), true, p);
for (const [p, m] of [['/api/codex', 'GET'], ['/api/codex/x', 'GET'], ['/api/vfarm/leads', 'GET'], ['/api/registry', 'GET'], ['/api/media-posts', 'GET']]) assert.equal(a.gated(p, m, false), false, p);
assert.equal(a.gated('/api/vfarm/leads', 'GET', true), true);
assert.deepEqual(Object.keys(a.withoutCosts({ name: 'x', cost_amount: 5, paid_with: 'card', plan: 'p' })), ['name', 'plan']);

const k = randomBytes(32);
const plain = Buffer.from('an agreement');
const sealed = g.seal(plain, k);
assert.ok(!sealed.cipher.includes(plain));
assert.deepEqual(g.unseal(sealed, k), plain);
assert.throws(() => g.unseal(sealed, randomBytes(32)));
const rows = [
  { person_id: 'kaiqi-yang', person_name: 'Kaiqi Yang', status: 'unsigned', uploaded_at: '2026-11-06' },
  { person_id: 'kaiqi-yang', person_name: 'Kaiqi Yang', status: 'signed', uploaded_at: '2026-11-05' },
];
assert.equal(g.bestFor(rows, 'kaiqi').status, 'signed');
assert.equal(g.bestFor(rows, 'ahad'), null);

for (const q of ['select * from engine_pay_sessions', 'SELECT * FROM ENGINE_VFARM_LEADS', 'select * from engine_agreements', "select query_to_xml('select 1', true, true, '')", 'select * from registry_services']) assert.throws(() => assertAgentSql(q), q);
assertAgentSql('select count(*) from engine_loops');
console.log('ok: admin gate');
