/**
 * The shape `GET /api/engine/:kind` answers with, pinned.
 *
 * **Why this is a test and not a comment.** n8n's update-a-loop path reads
 * `builder_id` and `table_id` off the lookup to find the owner: the builder is
 * which of the seven tables a row sits in, never a field, so a lookup that
 * stopped returning them would not fail — it would answer, and every workflow
 * downstream would quietly lose the owner. That is the class of fault this
 * dashboard exists to remove, so the contract is asserted rather than assumed.
 *
 * It also pins the two things that make the columns usable: they are present
 * on **every** row, and they are `null` rather than absent on a kind whose
 * table has not got them — a caller reading `row.table_id` must be able to
 * tell "no table" from "this route stopped sending it".
 *
 * Run with:  npm run test:lookup   (needs DATABASE_URL, migrations applied)
 */
const assert = require('node:assert/strict');
const mirror = require('../../server-dist/server/src/mirror.js');
const { query, closePool } = require('../../server-dist/server/src/pg.js');

const SUFFIX = `-shape-${Date.now()}`;
let failures = 0;

function check(name, fn) {
  return fn().then(
    () => console.log(`  ok    ${name}`),
    (e) => {
      failures++;
      console.log(`  FAIL  ${name}\n        ${e.message}`);
    },
  );
}

/** Every key the route promises, in the order the README prints them. */
const SHAPE = ['id', 'airtable_record_id', 'natural_id', 'builder_id', 'table_id', 'created_time', 'fields', 'source', 'updated_at'];

async function main() {
  // Two rows per kind, written the two ways n8n writes them: one against a
  // builder table, one against a Slack id with no table at all.
  await mirror.upsert('loops', { builder_id: 'destiny', fields: { loop_id: `LOOP${SUFFIX}`, What: 'shape test', Status: 'Open' } }, 'engine');
  await mirror.upsert('codex', { builder_id: 'destiny', fields: { 'Submission ID': `SUB${SUFFIX}`, 'Jason Status': 'Pending' } }, 'engine');

  for (const kind of ['loops', 'codex']) {
    await check(`${kind}: every row carries all ${SHAPE.length} keys`, async () => {
      const r = await mirror.lookup(kind, { filters: [], limit: 1000, order: 'created_desc' });
      assert.ok(r.rows.length > 0, `no ${kind} rows to check`);
      for (const row of r.rows) {
        assert.deepEqual(Object.keys(row).sort(), [...SHAPE].sort(), `row ${row.id} does not carry the promised keys`);
      }
    });

    await check(`${kind}: builder_id and table_id are on every row and never undefined`, async () => {
      const r = await mirror.lookup(kind, { filters: [], limit: 1000, order: 'created_desc' });
      for (const row of r.rows) {
        assert.ok('builder_id' in row, `row ${row.id} has no builder_id key`);
        assert.ok('table_id' in row, `row ${row.id} has no table_id key`);
        assert.notEqual(row.builder_id, undefined, `row ${row.id} builder_id is undefined rather than null`);
        assert.notEqual(row.table_id, undefined, `row ${row.id} table_id is undefined rather than null`);
        // The owner is never missing: it is what decides who the row belongs to.
        assert.ok(typeof row.builder_id === 'string' && row.builder_id.length > 0, `row ${row.id} has no owner`);
      }
      console.log(`        ${r.rows.length} ${kind} row(s) checked, ${r.count} held`);
    });

    await check(`${kind}: the row a builder table wrote carries that table`, async () => {
      const natural = kind === 'loops' ? `LOOP${SUFFIX}` : `SUB${SUFFIX}`;
      const r = await mirror.lookup(kind, { filters: [{ op: 'f', name: 'natural_id', value: natural }], limit: 1, order: 'created_desc' });
      assert.equal(r.count, 1, `expected exactly one ${kind} row for ${natural}`);
      assert.equal(r.rows[0].builder_id, 'destiny');
      assert.match(r.rows[0].table_id ?? '', /^tbl[A-Za-z0-9]{14}$/, 'table_id is not an Airtable table id');
    });
  }

  await check('a kind whose table has neither column answers null, not absent', async () => {
    const r = await mirror.lookup('patterns', { filters: [], limit: 5, order: 'created_desc' });
    for (const row of r.rows) {
      assert.ok('builder_id' in row && 'table_id' in row, 'the keys are missing rather than null');
      assert.equal(row.builder_id, null);
      assert.equal(row.table_id, null);
    }
  });

  await query('DELETE FROM engine_loops WHERE natural_id = $1', [`LOOP${SUFFIX}`]);
  await query('DELETE FROM engine_codex_submissions WHERE natural_id = $1', [`SUB${SUFFIX}`]);

  console.log(
    failures
      ? `\n  ${failures} check(s) failed\n`
      : '\n  the lookup shape holds: every loop and Codex row carries builder_id and table_id, and a kind without those columns answers null rather than leaving them out.\n',
  );
  await closePool();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
