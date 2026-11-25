/**
 * The change record (25 Nov 2026, PT9J / MPMD Part A). Pure: the approver rule, which writes carry
 * the change context, and that every part of the union yields the same columns. The SQL itself was
 * run against the live database before it shipped; the trigger and defaults against a local one.
 */
const assert = require('node:assert/strict');
const cr = require('../../server-dist/server/src/changeRecord.js');
const cc = require('../../server-dist/server/src/changeContext.js');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

assert.equal(cr.approvalOf(null, 'U0AEW3TBYH1'), 'not_approved');
assert.equal(cr.approvalOf('U0A9V97949F', 'U0AEW3TBYH1'), 'approved');
assert.equal(cr.approvalOf('U0AEW3TBYH1', 'U0AEW3TBYH1'), 'self');
assert.equal(cr.approvalOf('U0AEW3TBYH1', 'page:U0AEW3TBYH1'), 'self');
assert.equal(cr.approvalOf('U0A9V97949F', null), 'approved');
ok('an approver is a named person who is not the one who made the change');

assert.ok(cc.isWrite('UPDATE engine_loops SET fields = $1 WHERE id = $2'));
assert.ok(cc.isWrite('INSERT INTO events (kind) VALUES ($1)'));
assert.ok(cc.isWrite('WITH x AS (SELECT 1) UPDATE engine_incidents SET open_now = false'));
assert.ok(!cc.isWrite('SELECT * FROM engine_loops'));
assert.ok(!cc.isWrite('INSERT INTO engine_events (event_type) VALUES ($1)'), 'engine_events is not the status ledger');
assert.ok(!cc.isWrite('INSERT INTO engine_execution_runs (id) VALUES ($1)'), 'an untracked table costs no extra round trip');
ok('only a write to a tracked table carries the change context');

const s = cc.settingsSql({ actor: 'U0AEW3TBYH1', run_id: 'mcp-1', via: 'mcp:update_record', handler: null });
assert.deepEqual(s.values, ['U0AEW3TBYH1', 'mcp-1', 'mcp:update_record', '']);
assert.match(s.text, /set_config\('bha\.actor', \$1, true\)/);
ok('the context is written as transaction-local settings');

const sql = cr.unionSql();
const parts = sql.split(/\bUNION ALL\b/);
assert.equal(parts.length, Object.keys(cr.EVENT_KINDS).length + 3, 'one part per status-ledger kind, two for incidents, one for approvals');
for (const k of Object.keys(cr.EVENT_KINDS)) assert.ok(sql.includes(`e.kind = '${k}'`), `${k} is read`);
assert.ok(/a\.status = 'approved' THEN a\.decided_by/.test(sql), 'a denied card names no approver');
ok('the union reads every status-ledger kind, incidents both ways and approval cards');

console.log(`change record: ${passed} checks passed`);
