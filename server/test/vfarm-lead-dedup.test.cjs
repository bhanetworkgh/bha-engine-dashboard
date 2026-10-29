/**
 * vFarm Early Access deduplication (29 Oct 2026, Jason: "we should also have a duplication
 * blocker"; Destiny: on email only, because two people can share a name). In process against a
 * local database: a second Form A from an email already held makes no new lead, goes onto that
 * lead whole, and puts one line on its timeline saying what changed; the same repeat posted again
 * changes nothing more; the same name with another email is a separate lead; and the lead event
 * is written once.
 *
 * Run with:  npm run test:vfarm-lead-dedup   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:vfarm-lead-dedup writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const req = (m) => require(path.join(DIST, 'server/src', m));

(async () => {
  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  const early = req('earlyAccess.js');
  await migrate();
  let passed = 0;
  const ok = (name) => (passed++, console.log(`  ok  ${name}`));
  const t = Date.now();
  const email = `dedup-${t}@example.org`;
  const ids = [];
  const post = (buyer, over = {}) =>
    early.storeFormA({
      name: 'Pat Example',
      email,
      organisation: 'First Org',
      buyer_intake_id: buyer,
      early_access_lead_id: `VFLEAD-TEST-${t}`,
      source_campaign: 'test_dedup',
      submitted_at: '10/28/2026 17:33:54',
      answers: { 'Full name': 'Pat Example', 'Email address': email, 'Organization / household name': 'First Org', City: 'Utica' },
      ...over,
    });

  try {
    const first = await post(`VFBUYER-DEDUP-${t}-A`);
    ids.push(first.id);
    assert.equal(first.stored, 'inserted');
    assert.equal(first.merged_into, null);
    ok('a first sign-up makes a new lead');

    const again = await post(`VFBUYER-DEDUP-${t}-B`, {
      email: email.toUpperCase(),
      organisation: 'Second Org',
      answers: { 'Full name': 'Pat Example', 'Email address': email, 'Organization / household name': 'Second Org', City: 'Utica' },
    });
    assert.equal(again.stored, 'merged');
    assert.equal(again.id, first.id);
    assert.equal(again.merged_into.id, first.id);
    const rows = (await query(`SELECT id::text, form_a, activity, organization_name FROM engine_vfarm_leads WHERE lower(email) = $1`, [email])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].organization_name, 'First Org');
    assert.equal(rows[0].form_a.answers['Organization / household name'], 'First Org');
    assert.equal(rows[0].form_a.resubmissions.length, 1);
    assert.equal(rows[0].form_a.resubmissions[0].organisation, 'Second Org');
    const line = rows[0].activity.filter((a) => a.kind === 'resubmitted');
    assert.equal(line.length, 1);
    assert.match(line[0].text, /Filled in Form A again .* as Pat Example, Second Org\. Changed:\nOrganization \/ household name: First Org → Second Org/);
    assert.doesNotMatch(line[0].text, /City/);
    ok('the same email again (any case) makes no new lead: the sign-up is kept whole on the first lead, which keeps its own answers, with one timeline line naming what changed');

    const twice = await post(`VFBUYER-DEDUP-${t}-B`, { organisation: 'Second Org' });
    assert.equal(twice.stored, 'merged');
    const r2 = (await query(`SELECT form_a, activity FROM engine_vfarm_leads WHERE id::text = $1`, [first.id])).rows[0];
    assert.equal(r2.form_a.resubmissions.length, 1);
    assert.equal(r2.activity.filter((a) => a.kind === 'resubmitted').length, 1);
    ok('the same repeat posted twice (an n8n retry) adds nothing more');

    const same = await post(`VFBUYER-DEDUP-${t}-A`);
    assert.equal(same.stored, 'updated');
    const r3 = (await query(`SELECT form_a FROM engine_vfarm_leads WHERE id::text = $1`, [first.id])).rows[0];
    assert.equal(r3.form_a.resubmissions.length, 1);
    ok('a retry of the first sign-up updates it and keeps the repeats already held');

    const other = await early.storeFormA({ name: 'Pat Example', email: `dedup-other-${t}@example.org`, buyer_intake_id: `VFBUYER-DEDUP-${t}-C`, answers: {} });
    ids.push(other.id);
    assert.equal(other.stored, 'inserted');
    assert.notEqual(other.id, first.id);
    ok('the same name with a different email is a separate lead: names are never matched');

    const ev = (await query(`SELECT count(*)::int n FROM engine_events WHERE event_type = 'VFARM_LEAD_CAPTURED' AND subject_id = ANY($1)`, [[`VFBUYER-DEDUP-${t}-A`, `VFBUYER-DEDUP-${t}-B`]])).rows[0].n;
    assert.equal(ev, 1);
    ok('a repeat sign-up writes no second lead event');

    const pure = early.resubmitText({ City: 'Utica' }, { submitted_at: null, name: 'Pat', organisation: null, answers: { City: 'Utica' } });
    assert.equal(pure, 'Filled in Form A again, as Pat. Same answers as before.');
    ok('a repeat with the same answers says so');

    console.log(`\n${passed} passed`);
  } finally {
    await query(`DELETE FROM engine_events WHERE subject_id LIKE $1`, [`VFBUYER-DEDUP-${t}%`]);
    await query(`DELETE FROM engine_vfarm_leads WHERE id::text = ANY($1)`, [ids]);
    process.exit(process.exitCode ?? 0);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
