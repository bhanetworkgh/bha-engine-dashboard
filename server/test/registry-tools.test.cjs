/**
 * read_registry and write_registry (30 Oct 2026, Destiny: "tell it from Slack to register it in the
 * dashboard"). The secret guard, who may write, the refusals, and a create, update, remove and restore
 * against an in-memory stand-in for the registry table. No database, no network.
 *   npm run test:registry-tools
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
process.env.DATABASE_URL = 'postgres://stub@localhost/stub_test';

// The stand-in: just enough SQL for the registry, the audit line and the read log.
const rows = new Map(); // id -> row
const audits = [];
const profiles = { U0HARDIK01: 'Hardik Bhatt' };
const { Pool } = require('./_pg-stub.cjs');
Pool.prototype.query = async function (text, values = []) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO engine_mcp_writes/.test(t)) { audits.push({ tool: values[0], outcome: 'pending' }); return { rows: [{ id: String(audits.length) }], rowCount: 1 }; }
  if (/^UPDATE engine_mcp_writes/.test(t)) { audits[Number(values[0]) - 1].outcome = values[1]; audits[Number(values[0]) - 1].detail = values[2]; return { rows: [], rowCount: 1 }; }
  if (/engine_builder_profiles/.test(t)) return { rows: profiles[values[0]] ? [{ name: profiles[values[0]] }] : [], rowCount: 0 };
  if (/^INSERT INTO engine_writes/.test(t)) return { rows: [], rowCount: 1 };
  if (/^SELECT .* FROM registry_services/.test(t)) {
    const all = [...rows.values()].filter((r) => !/WHERE deleted_at IS NULL/.test(t) || !r.deleted_at);
    if (/WHERE id = \$1/.test(t)) return { rows: all.filter((r) => r.id === values[0]), rowCount: 1 };
    return { rows: all, rowCount: all.length };
  }
  if (/^INSERT INTO registry_services/.test(t)) {
    const cols = t.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim());
    if (rows.has(values[0])) throw new Error('duplicate key value violates unique constraint');
    const r = { deleted_at: null };
    cols.forEach((c, i) => { r[c] = values[i]; });
    rows.set(r.id, r);
    return { rows: [r], rowCount: 1 };
  }
  if (/^UPDATE registry_services SET deleted_at/.test(t)) {
    const r = rows.get(values[0]); if (!r) return { rows: [], rowCount: 0 };
    r.deleted_at = values[1]; r.updated_at = values[2]; return { rows: [r], rowCount: 1 };
  }
  if (/^UPDATE registry_services SET/.test(t)) {
    const r = rows.get(values[0]); if (!r) return { rows: [], rowCount: 0 };
    const sets = t.match(/SET (.+) WHERE/)[1].split(',').map((s) => s.trim().split(' = ')[0]);
    sets.forEach((c, i) => { r[c] = values[i + 1]; });
    return { rows: [r], rowCount: 1 };
  }
  throw new Error(`stand-in has no answer for: ${t.slice(0, 120)}`);
};

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const rt = require(path.join(DIST, 'server/src/mcp/registryTools.js'));
const tools = require(path.join(DIST, 'server/src/mcp/tools.js'));

const DESTINY = 'U0AEW3TBYH1';
const deps = { access: 'write', agent: null };
const write = (args) => rt.writeRegistry.handler(args, deps);
let n = 0;
const ok = (name) => { n++; console.log(`ok ${n} - ${name}`); };

(async () => {
  // The guard is pure.
  assert.deepEqual(rt.secretsIn({ notes: 'Login in Bitwarden, shared with Jason.' }), []);
  // Built at run time so no fake key sits in the source for a secret scanner to flag.
  const hex32 = '0123456789abcdef'.repeat(2);
  const fakes = [['sk', 'live', 'X'.repeat(20)].join('_'), ['whsec', 'Y'.repeat(18)].join('_'), ['sk', hex32 + 'ab12cd34'].join('_'), ['xoxb', '1234567890', 'abcdefghij'].join('-'), 'pass' + 'word: ' + 'h'.repeat(14), 'S' + 'K' + hex32, ['sk', 'or', 'v1', 'z'.repeat(24)].join('-')];
  for (const s of fakes) {
    assert.equal(rt.secretsIn({ notes: `key ${s}` }).length, 1, s);
  }
  assert.equal(rt.secretsIn({ url: 'https://dashboard.stripe.com', notes: 'Twilio account AC is public' }).length, 0);
  ok('secret shapes are caught (Stripe, ElevenLabs, Twilio, Slack, OpenRouter, an assigned password); plain notes and urls are not');

  // Wiring: read on both connections, write on the write connection only.
  assert.ok(tools.toolByName('read_registry', 'read'));
  assert.ok(tools.toolByName('read_registry', 'write'));
  assert.equal(tools.toolByName('write_registry', 'read'), null);
  assert.ok(tools.toolByName('write_registry', 'write'));
  ok('read_registry is on both connections, write_registry only on the write connection');

  // Refusals write nothing.
  const before = rows.size;
  assert.equal((await write({ action: 'create', fields: { name: 'X' }, requester_user_id: 'U0NOBODY01' })).reason, 'not_permitted');
  assert.equal((await write({ action: 'create', kind: 'credentials', fields: { name: 'X' }, requester_user_id: DESTINY })).reason, 'not_served');
  assert.equal((await write({ action: 'create', fields: { name: 'Stripe', notes: 'key ' + fakes[0] }, requester_user_id: DESTINY })).reason, 'secret_refused');
  assert.equal((await write({ action: 'create', fields: { name: 'Stripe', price: 3 }, requester_user_id: DESTINY })).reason, 'unknown_field');
  assert.equal(rows.size, before);
  assert.ok(audits.every((a) => a.outcome === 'refused'));
  ok('not permitted, credentials, a secret and an unknown field are refused, audited, and write nothing');

  // A dry run writes nothing.
  const dry = await write({ action: 'create', fields: { name: 'Stripe', category: 'other' }, requester_user_id: 'U0HARDIK01', dry_run: true });
  assert.equal(dry.ok, true); assert.equal(dry.written, false); assert.equal(rows.size, 0);
  ok('a dry run checks and writes nothing');

  // Create, then the same name is refused.
  const c = await write({ action: 'create', fields: { name: 'Stripe', category: 'other', url: 'https://dashboard.stripe.com', notes: 'Secret key in Bitwarden.' }, requester_user_id: 'U0HARDIK01' });
  assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.row.id, 'stripe'); assert.equal(c.row.status, 'active');
  assert.equal((await write({ action: 'create', fields: { name: 'stripe ' }, requester_user_id: DESTINY })).reason, 'already_held');
  ok('a builder with a profile can add a tool; the same name again is refused already_held');

  // Update.
  const u = await write({ action: 'update', id: 'stripe', fields: { plan: 'Standard', billing_owner: 'BHA' }, requester_user_id: DESTINY });
  assert.equal(u.ok, true); assert.equal(rows.get('stripe').plan, 'Standard');
  assert.equal((await write({ action: 'update', id: 'nope', fields: { plan: 'x' }, requester_user_id: DESTINY })).reason, 'not_found');
  ok('update changes only the named fields; an unknown id is not_found');

  // Remove and restore are Destiny's or Jason's.
  assert.equal((await write({ action: 'remove', id: 'stripe', requester_user_id: 'U0HARDIK01' })).reason, 'not_permitted');
  assert.equal((await write({ action: 'remove', id: 'stripe', requester_user_id: DESTINY })).ok, true);
  assert.ok(rows.get('stripe').deleted_at);
  assert.equal((await write({ action: 'remove', id: 'stripe', requester_user_id: DESTINY })).reason, 'already_removed');
  assert.equal((await write({ action: 'restore', id: 'stripe', requester_user_id: DESTINY })).ok, true);
  assert.equal(rows.get('stripe').deleted_at, null);
  ok('remove and restore are Destiny\'s or Jason\'s, and a row is never hard-deleted');

  // Read.
  const r = await rt.readRegistry.handler({ search: 'stripe' }, deps);
  assert.equal(r.ok, true); assert.equal(r.count, 1); assert.equal(r.rows[0].name, 'Stripe');
  assert.equal((await rt.readRegistry.handler({ kind: 'credentials' }, deps)).reason, 'unknown_kind');
  ok('read_registry finds by words and does not serve credentials');

  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
