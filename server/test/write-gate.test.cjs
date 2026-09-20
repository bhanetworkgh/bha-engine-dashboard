/**
 * The write gate, exercised end to end against a real database.
 *
 * No destructive tool ships through the gate yet — this is the scaffolding's
 * own test, and the "tool" below exists only in this file. It proves the five
 * behaviours the gate is for:
 *
 *   1. A call without a token changes nothing and returns a preview.
 *   2. The token works, once.
 *   3. A replay of the same token is refused, and named as a replay.
 *   4. An expired token is refused, and named as expired.
 *   5. A token whose record changed underneath it is refused, and named so.
 *
 * And that every one of those outcomes — the refusals included — lands in
 * engine_mcp_writes.
 *
 * Run with:  npm run test:gate   (needs DATABASE_URL, migrations applied)
 */
const assert = require('node:assert/strict');
const gate = require('../../server-dist/server/src/mcp/gate.js');
const { query, closePool } = require('../../server-dist/server/src/pg.js');

const TOOL = 'test_set_lead_status';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The record the fake tool operates on, read fresh every time. */
async function readLead(id) {
  const r = await query('SELECT id, full_name, email, status, notes FROM engine_vfarm_leads WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

function operation(record, proposed) {
  return {
    tool: TOOL,
    target: `lead ${record.id}`,
    changes: [{ field: 'status', current: record.status, proposed }],
    record,
  };
}

/**
 * The shape every mutating tool through this gate will have: no token means
 * preview, a token means verify against a fresh read, act once, audit.
 */
async function setStatus(id, proposed, token, ttlMs) {
  const record = await readLead(id);
  if (!record) throw new Error(`no lead ${id}`);
  const op = operation(record, proposed);

  if (!token) return gate.preview(op, ttlMs);

  let redeemed;
  try {
    redeemed = gate.redeem(token, op);
  } catch (e) {
    await gate.audit({ tool: TOOL, args: { id, proposed, token }, digest: gate.digestOf(op), token, target: op.target, before: record, outcome: 'refused', detail: `${e.code}: ${e.message}` });
    throw e;
  }
  await query('UPDATE engine_vfarm_leads SET status = $2 WHERE id = $1', [id, proposed]);
  const after = await readLead(id);
  await gate.audit({ tool: TOOL, args: { id, proposed }, digest: redeemed.digest, token, target: op.target, before: record, after, outcome: 'applied' });
  return { status: 'applied', changes: redeemed.changes, after };
}

async function main() {
  const fail = [];
  const ok = (name) => console.log(`  ok    ${name}`);
  const check = async (name, fn) => {
    try {
      await fn();
      ok(name);
    } catch (e) {
      fail.push(`${name}: ${e.message}`);
      console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
  };

  gate.resetTokens();
  const seeded = await query(
    `INSERT INTO engine_vfarm_leads (full_name, email, source_surface, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Gate Test', `gate-${Date.now()}@example.com`, 'write_gate_test', 'new'],
  );
  const id = seeded.rows[0].id;
  const auditBefore = Number((await query('SELECT count(*)::text AS n FROM engine_mcp_writes')).rows[0].n);
  console.log(`\n  seeded lead ${id}\n`);

  let token;
  await check('a call with no token changes nothing and returns a preview', async () => {
    const p = await setStatus(id, 'contacted', undefined);
    assert.equal(p.status, 'preview');
    assert.ok(p.token, 'a token is issued');
    assert.deepEqual(p.changes, [{ field: 'status', current: 'new', proposed: 'contacted' }]);
    assert.equal((await readLead(id)).status, 'new', 'the record is untouched');
    token = p.token;
  });

  await check('the token works', async () => {
    const r = await setStatus(id, 'contacted', token);
    assert.equal(r.status, 'applied');
    assert.equal((await readLead(id)).status, 'contacted');
  });

  await check('a replay of the same token is refused as a replay', async () => {
    await assert.rejects(() => setStatus(id, 'archived', token), (e) => {
      assert.equal(e.code, 'token_used');
      assert.match(e.message, /already been spent/);
      return true;
    });
    assert.equal((await readLead(id)).status, 'contacted', 'and nothing changed');
  });

  await check('an expired token is refused as expired', async () => {
    const p = await setStatus(id, 'qualified', undefined, 700);
    await wait(900);
    await assert.rejects(() => setStatus(id, 'qualified', p.token), (e) => {
      assert.equal(e.code, 'token_expired');
      return true;
    });
    assert.equal((await readLead(id)).status, 'contacted', 'and nothing changed');
  });

  await check('a token whose record changed underneath it is refused', async () => {
    const p = await setStatus(id, 'qualified', undefined);
    // Somebody else edits the row in the gap between preview and confirm.
    await query('UPDATE engine_vfarm_leads SET notes = $2 WHERE id = $1', [id, 'edited by somebody else']);
    await assert.rejects(() => setStatus(id, 'qualified', p.token), (e) => {
      assert.equal(e.code, 'record_changed');
      assert.match(e.message, /changed since the preview/);
      return true;
    });
    assert.equal((await readLead(id)).status, 'contacted', 'and the status is still what it was');
  });

  await check('an unknown token is refused', async () => {
    await assert.rejects(() => setStatus(id, 'archived', '00000000-0000-4000-8000-000000000000'), (e) => {
      assert.equal(e.code, 'token_unknown');
      return true;
    });
  });

  await check('every outcome, refusals included, reached engine_mcp_writes', async () => {
    const rows = await query(
      `SELECT outcome, count(*)::text AS n FROM engine_mcp_writes WHERE tool = $1 GROUP BY outcome ORDER BY 1`,
      [TOOL],
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.outcome, Number(r.n)]));
    console.log(`        engine_mcp_writes for ${TOOL}: ${JSON.stringify(by)}`);
    assert.equal(by.applied, 1, 'one applied');
    assert.equal(by.refused, 4, 'four refusals recorded');
    const total = Number((await query('SELECT count(*)::text AS n FROM engine_mcp_writes')).rows[0].n);
    assert.equal(total - auditBefore, 5, 'five rows added in total');
    const applied = await query(`SELECT before, after FROM engine_mcp_writes WHERE tool = $1 AND outcome = 'applied'`, [TOOL]);
    assert.equal(applied.rows[0].before.status, 'new', 'the before value is recorded');
    assert.equal(applied.rows[0].after.status, 'contacted', 'and the after value');
  });

  await check('an idempotency key is claimed once and replays its first result', async () => {
    const key = `k-${Date.now()}`;
    const first = await gate.claim('test_create_thing', key, { a: 1 }, 'digest-1');
    assert.equal(first.fresh, true);
    await gate.settle(first.id, 'applied', { created: 'thing-1' });
    const second = await gate.claim('test_create_thing', key, { a: 1 }, 'digest-1');
    assert.equal(second.fresh, false, 'the second claim is not fresh');
    assert.deepEqual(second.original.after, { created: 'thing-1' }, 'and it hands back the first result');
  });

  // Leave nothing behind but the audit rows, which are the record.
  await query('DELETE FROM engine_vfarm_leads WHERE id = $1', [id]);
  await closePool();

  console.log('');
  if (fail.length) {
    console.log(`  ${fail.length} check(s) failed`);
    process.exit(1);
  }
  console.log('  the write gate holds: preview changes nothing, the token works once, and expired, replayed and stale-record tokens are each refused by name.');
}

main().catch((e) => {
  console.error('the test itself failed:', e);
  process.exit(1);
});
