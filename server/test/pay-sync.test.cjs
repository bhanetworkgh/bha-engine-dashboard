/**
 * The pay ledger kept in step with the session logs at write time
 * (2026-09-23), pinned.
 *
 * What this proves, because each is a way a builder ends up paid twice or not
 * at all:
 *   - a log marked paid flips its pay row inside the same request;
 *   - a late `Paid: false` from Bays — Pay Tracking cannot undo a payment;
 *   - Pay Mode is frozen at the first write;
 *   - every copy of a pre-cutover session is brought to the same Paid state;
 *   - a Sent statement closes on its last paid session, and not before;
 *   - the reconcile is safe to repeat;
 *   - every one of those writes is announced to the live pages.
 *
 * Run with:  npm run test:pay   (needs DATABASE_URL, migrations applied)
 */
const assert = require('node:assert/strict');
const mirror = require('../../server-dist/server/src/mirror.js');
const paySync = require('../../server-dist/server/src/paySync.js');
const events = require('../../server-dist/server/src/events.js');
const { query, closePool } = require('../../server-dist/server/src/pg.js');

const T = Date.now();
const SLACK = `UTEST${T}`;
const MONTH = '2031-01';
const E1 = `CODEX-TEST-${T}-one`;
const E2 = `CODEX-TEST-${T}-two`;
const S1 = `SUB-TEST-${T}-one`;
const S2 = `SUB-TEST-${T}-two`;
const STATEMENT = `STMT-TEST-${T}`;

let failures = 0;
const heard = [];
const off = events.onChange((e) => heard.push(e));

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

async function payRows(entry) {
  const r = await query('SELECT id, airtable_record_id, fields FROM engine_pay_sessions WHERE natural_id = $1 ORDER BY id', [entry]);
  return r.rows;
}

function log(sub, entry, extra = {}) {
  return {
    builder_id: 'destiny',
    fields: {
      'Submission ID': sub,
      'Codex Entry ID': entry,
      'Builder User ID': SLACK,
      'Builder Name': 'Test Builder (log)',
      Timestamp: `${MONTH}-15T23:30:00.000-02:00`, // 16 Jan in UTC: the date is UTC, as the node had it
      'Processed At': `${MONTH}-16T10:00:00.000Z`,
      'Jason Reviewed At': `${MONTH}-17T09:00:00.000Z`,
      'Session Url': `https://otter.ai/u/${T}`,
      'Jason Status': 'Approved',
      Paid: 'No',
      ...extra,
    },
  };
}

async function main() {
  await mirror.upsert('pay_builders', { fields: { 'Slack User ID': SLACK, Builder: 'Test Builder', 'Pay Mode': 'Monthly' } }, 'engine');

  await check('an approved log creates its pay row, unpaid, with the roster’s mode and the work date in UTC', async () => {
    await mirror.upsert('codex', log(S1, E1), 'engine');
    const rows = await payRows(E1);
    assert.equal(rows.length, 1);
    const f = rows[0].fields;
    assert.equal(f.Paid, false);
    assert.equal(f['Pay Mode'], 'Monthly');
    assert.equal(f.Builder, 'Test Builder');
    assert.equal(f['Builder Slack ID'], SLACK);
    assert.equal(f['Session Date'], `${MONTH}-16`);
    assert.equal(f.Month, MONTH);
    assert.equal(f['Approved At'], `${MONTH}-17T09:00:00.000Z`);
    assert.equal(f['Codex Link'], `https://otter.ai/u/${T}`);
    assert.equal(f['Paid At'], null);
  });

  await check('a log with no Codex Entry ID writes no pay row', async () => {
    const sub = `SUB-TEST-${T}-none`;
    await mirror.upsert('codex', { builder_id: 'destiny', fields: { 'Submission ID': sub, 'Builder User ID': SLACK, Paid: 'Yes' } }, 'engine');
    const r = await query(`SELECT count(*)::int AS n FROM engine_pay_sessions WHERE fields->>'Builder Slack ID' = $1`, [SLACK]);
    assert.equal(r.rows[0].n, 1);
    await query('DELETE FROM engine_codex_submissions WHERE natural_id = $1', [sub]);
  });

  // A second copy of the same session, as the Airtable resync left one.
  const rec = `rec${String(T).slice(-14).padStart(14, '0')}`;
  // Written straight in: through upsert the natural id would adopt the engine
  // copy rather than sit beside it, which is how the live pairs came about.
  await query(
    `INSERT INTO engine_pay_sessions (airtable_record_id, natural_id, fields, source, updated_at, first_seen_at)
     VALUES ($1, $2, $3::jsonb, 'airtable', $4, $4)`,
    [rec, E1, JSON.stringify({ 'Codex Entry ID': E1, 'Builder Slack ID': SLACK, Month: MONTH, 'Pay Mode': 'Monthly', Paid: false, 'Slack Card Link': 'https://slack.test/card' }), new Date().toISOString()],
  );

  // Moving the builder to Daily must not rewrite a session already held.
  await mirror.upsert('pay_builders', { fields: { 'Slack User ID': SLACK, Builder: 'Test Builder', 'Pay Mode': 'Daily' } }, 'engine');

  await check('marking the log paid flips every copy within the same request, and Pay Mode stays frozen', async () => {
    heard.length = 0;
    const id = (await query('SELECT id FROM engine_codex_submissions WHERE natural_id = $1', [S1])).rows[0].id;
    await mirror.patchFields('codex', String(id), { Paid: 'Yes' }, 'engine');
    const rows = await payRows(E1);
    assert.equal(rows.length, 2, 'both copies are still there');
    for (const r of rows) {
      assert.equal(r.fields.Paid, true, `row ${r.id} is not paid`);
      assert.equal(r.fields['Paid By'], 'Jason');
      assert.ok(r.fields['Paid At'], `row ${r.id} has no Paid At`);
      assert.equal(r.fields['Pay Mode'], 'Monthly', `row ${r.id} Pay Mode moved`);
    }
    assert.equal(rows[0].fields['Paid At'], rows[1].fields['Paid At'], 'the two copies disagree about when it was paid');
    assert.equal(rows.find((r) => r.airtable_record_id === rec).fields['Slack Card Link'], 'https://slack.test/card', 'the Slack Card Link was dropped');
    await tick();
    assert.ok(heard.some((e) => e.kind === 'codex'), 'no codex event');
    assert.ok(heard.some((e) => e.kind === 'pay_sessions'), 'no pay_sessions event');
  });

  await check('a late Paid:false from Pay Tracking leaves the row paid, keeping its other fields', async () => {
    const before = (await payRows(E1)).find((r) => !r.airtable_record_id).fields['Paid At'];
    await mirror.upsert(
      'pay_sessions',
      { fields: { 'Codex Entry ID': E1, 'Builder Slack ID': SLACK, Month: MONTH, 'Pay Mode': 'Monthly', Paid: false, 'Paid At': null, 'Paid By': null, 'Slack Card Link': 'https://slack.test/late' } },
      'engine',
    );
    const row = (await payRows(E1)).find((r) => !r.airtable_record_id);
    assert.equal(row.fields.Paid, true);
    assert.equal(row.fields['Paid By'], 'Jason');
    assert.equal(row.fields['Paid At'], before, 'Paid At moved');
    assert.equal(row.fields['Slack Card Link'], 'https://slack.test/late', 'the incoming field was not kept');
  });

  await check('a PATCH setting Paid false on the pay row is corrected from the log', async () => {
    const row = (await payRows(E1)).find((r) => !r.airtable_record_id);
    await mirror.patchFields('pay_sessions', String(row.id), { Paid: false, 'Paid By': null }, 'engine');
    const after = (await payRows(E1)).find((r) => r.id === row.id);
    assert.equal(after.fields.Paid, true);
    assert.equal(after.fields['Paid By'], 'Jason');
  });

  await check('a Sent statement stays open until its last session is paid, then closes itself', async () => {
    await mirror.upsert('pay_statements', { fields: { 'Statement ID': STATEMENT, 'Builder Slack ID': SLACK, Month: MONTH, Status: 'Sent' } }, 'engine');
    await mirror.upsert('codex', log(S2, E2), 'engine');
    let st = (await query('SELECT fields FROM engine_pay_statements WHERE natural_id = $1', [STATEMENT])).rows[0].fields;
    assert.equal(st.Status, 'Sent', 'closed while a session was unpaid');

    heard.length = 0;
    await mirror.upsert('codex', log(S2, E2, { Paid: 'Yes' }), 'engine');
    st = (await query('SELECT fields FROM engine_pay_statements WHERE natural_id = $1', [STATEMENT])).rows[0].fields;
    assert.equal(st.Status, 'Payment Sent');
    assert.equal(st['Confirmed By'], 'Marked paid on the session cards');
    assert.equal(st.Notes, 'Closed automatically: all 2 session(s) in this statement are marked paid.');
    assert.ok(st['Payment Sent At']);
    await tick();
    assert.ok(heard.some((e) => e.kind === 'pay_statements'), 'no pay_statements event');
  });

  await check('unpaying the log clears Paid At and Paid By', async () => {
    await mirror.upsert('codex', log(S2, E2, { Paid: 'No' }), 'engine');
    const f = (await payRows(E2))[0].fields;
    assert.equal(f.Paid, false);
    assert.equal(f['Paid At'], null);
    assert.equal(f['Paid By'], null);
  });

  await check('the reconcile run twice reports nothing changed the second time', async () => {
    await paySync.reconcile();
    const second = await paySync.reconcile();
    assert.equal(second.failed.length, 0, JSON.stringify(second.failed));
    assert.equal(second.created, 0, `created ${second.created}`);
    assert.equal(second.updated, 0, `updated ${second.updated}`);
    assert.equal(second.unchanged, second.checked);
  });

  await check('nothing is announced for a write that rolled back', async () => {
    heard.length = 0;
    await mirror.upsert('codex', { builder_id: 'nobody-at-all', fields: { 'Submission ID': 'x' } }, 'engine').catch(() => undefined);
    await tick();
    assert.equal(heard.length, 0);
  });
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    off();
    await query('DELETE FROM engine_codex_submissions WHERE natural_id = ANY($1)', [[S1, S2]]);
    await query('DELETE FROM engine_pay_sessions WHERE natural_id = ANY($1)', [[E1, E2]]);
    await query('DELETE FROM engine_pay_statements WHERE natural_id = $1', [STATEMENT]);
    await query('DELETE FROM engine_pay_builders WHERE natural_id = $1', [SLACK]);
    await closePool();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
