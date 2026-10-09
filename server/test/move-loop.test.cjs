/**
 * move_loop (2026-10-09), in process against a local database, on throwaway loops.
 *
 *   1. A dry run moves nothing and says what would move.
 *   2. Destiny moves a loop from his table to Jason's: one row, same loop_id, Jason's table and
 *      table id, the assignee set from the destination, every other field kept, and an audit line.
 *   3. Moving it there again is refused (already_there).
 *   4. An unknown builder, a missing requester and an unknown loop are refused.
 *   5. Somebody who is not an admin, the table's owner or the assignee is refused; the assignee is allowed.
 *   6. A loop held twice under one loop_id is refused and both rows are named.
 *
 * Run with:  npm run test:move-loop   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('This test writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const DESTINY = 'U0AEW3TBYH1', JASON = 'U0A9V97949F', JEGAN = 'U0AF011R821', KAVIN = 'U0BNQGG020Y';

(async () => {
  const { migrate } = req('migrations.js');
  const { query, closePool } = req('pg.js');
  const { moveLoopTool } = req('mcp/loopTools.js');
  await migrate();
  const call = (args) => moveLoopTool.handler(args, { access: 'write' });
  const clean = async () => {
    await query(`DELETE FROM engine_loops WHERE natural_id LIKE 'LOOP-TESTMOVE-%'`);
    await query(`DELETE FROM engine_mcp_writes WHERE tool = 'move_loop' AND natural_id LIKE 'LOOP-TESTMOVE-%'`);
  };
  const put = (id, builder, table, assignee) => query(
    `INSERT INTO engine_loops (natural_id, builder_id, table_id, created_time, fields, source, first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'engine', $4, $4)`,
    [id, builder, table, new Date().toISOString(), JSON.stringify({ loop_id: id, What: 'Test move ' + id, Status: 'Open', lane_tag: 'BAYS', 'Raised By': 'Test', 'Date Raised': '2026-10-09', 'Assignee Slack User ID': assignee })],
  );
  const rows = async (id) => (await query(`SELECT builder_id, table_id, fields FROM engine_loops WHERE natural_id = $1 ORDER BY id`, [id])).rows;
  await clean();
  try {
    const A = 'LOOP-TESTMOVE-A';
    await put(A, 'destiny', 'tblBJekl3ROpNZxQW', JASON);
    /* 1 */
    const dry = await call({ loop_id: A, to_builder: 'jason', requester_user_id: DESTINY, dry_run: true });
    assert.equal(dry.ok, true); assert.equal(dry.moved, false); assert.equal(dry.from_builder, 'destiny'); assert.equal(dry.assignee_becomes, JASON);
    assert.equal((await rows(A))[0].builder_id, 'destiny');
    ok('a dry run moves nothing and says what would move');
    /* 2 */
    const m = await call({ loop_id: A, to_builder: 'Jason', requester_user_id: DESTINY, reason: 'assigned to Jason' });
    assert.equal(m.ok, true, JSON.stringify(m)); assert.equal(m.moved, true); assert.equal(m.to_builder, 'jason');
    const after = await rows(A);
    assert.equal(after.length, 1);
    assert.equal(after[0].builder_id, 'jason');
    assert.equal(after[0].table_id, 'tblVOLhWULskNiIUt');
    assert.equal(after[0].fields['Assignee Slack User ID'], JASON);
    assert.equal(after[0].fields.loop_id, A);
    assert.equal(after[0].fields.What, 'Test move ' + A);
    assert.equal(after[0].fields.lane_tag, 'BAYS');
    const audit = (await query(`SELECT outcome, detail, requester_user_id FROM engine_mcp_writes WHERE id = $1`, [m.audit_id])).rows[0];
    assert.equal(audit.outcome, 'updated'); assert.equal(audit.requester_user_id, DESTINY); assert.match(audit.detail, /from destiny to jason/);
    ok('a move lands as one row on the new table, same loop_id, assignee from the destination, fields kept, audited');
    /* 3 */
    assert.equal((await call({ loop_id: A, to_builder: 'jason', requester_user_id: DESTINY })).reason, 'already_there');
    ok('moving it where it already is is refused');
    /* 4 */
    assert.equal((await call({ loop_id: A, to_builder: 'nobody', requester_user_id: DESTINY })).reason, 'unknown_builder');
    assert.equal((await call({ loop_id: A, to_builder: 'jegan', requester_user_id: '' })).reason, 'who_is_required');
    assert.equal((await call({ loop_id: 'LOOP-TESTMOVE-NONE', to_builder: 'jegan', requester_user_id: DESTINY })).reason, 'not_found');
    ok('an unknown builder, a missing requester and an unknown loop are refused');
    /* 5 */
    const B = 'LOOP-TESTMOVE-B';
    await put(B, 'destiny', 'tblBJekl3ROpNZxQW', JEGAN);
    const no = await call({ loop_id: B, to_builder: 'kavin', requester_user_id: KAVIN });
    assert.equal(no.reason, 'not_permitted'); assert.equal((await rows(B))[0].builder_id, 'destiny');
    const yes = await call({ loop_id: B, to_builder: 'jegan', requester_user_id: JEGAN });
    assert.equal(yes.moved, true, JSON.stringify(yes)); assert.equal((await rows(B))[0].builder_id, 'jegan');
    ok('a stranger is refused; the assignee may move it');
    /* 6 */
    const C = 'LOOP-TESTMOVE-C';
    await put(C, 'destiny', 'tblBJekl3ROpNZxQW', DESTINY);
    await put(C, 'hardik', 'tblaloC4JIRdBq5EM', DESTINY);
    const twice = await call({ loop_id: C, to_builder: 'jason', requester_user_id: DESTINY });
    assert.equal(twice.reason, 'held_twice'); assert.equal(twice.rows.length, 2);
    assert.deepEqual((await rows(C)).map((r) => r.builder_id), ['destiny', 'hardik']);
    ok('a loop held twice is refused and both rows are named');
    console.log(`\n${n} checks passed.`);
  } catch (e) {
    console.error('\nFAILED:', e);
    process.exitCode = 1;
  } finally {
    await clean();
    await closePool();
  }
})();
