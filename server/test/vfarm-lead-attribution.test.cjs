/**
 * vFarm lead attribution (10 Nov 2026, Destiny — Jason's paid-test gate: "UTM/basic attribution in
 * place"). The /vfarm form's utm_* tags reach the dashboard from the website intake and land on
 * the lead, whichever arrives first. In process against a local database:
 *   1. tags posted before the lead are copied when Hardik's tracker posts the lead;
 *   2. tags posted after the lead are copied onto it at once;
 *   3. a lead that already has a source keeps it (a second link never overwrites the first);
 *   4. a signup with no tags changes nothing, and is still kept as a fact;
 *   5. a bad email is refused.
 *
 * Run with:  npm run test:vfarm-lead-attribution   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:vfarm-lead-attribution writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
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
  const e1 = `attr-a-${t}@example.org`, e2 = `attr-b-${t}@example.org`, e3 = `attr-c-${t}@example.org`;
  const lead = (email, buyer) => early.storeFormA({ name: 'Pat', email, buyer_intake_id: buyer, answers: { 'Email address': email } });
  const tags = { utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: 'tomatoes_paid_p1', utm_content: 'v1' };
  const row = async (email) => (await query(`SELECT utm_source, utm_medium, utm_campaign, source_page, form_a FROM engine_vfarm_leads WHERE email = $1`, [email])).rows[0];
  try {
    let w = await early.storeAttribution(early.readAttribution({ email: e1.toUpperCase(), utm: tags, page: '/vfarm' }));
    assert.equal(w.applied_to, null);
    await lead(e1, `VFBUYER-ATTR-${t}-A`);
    let r = await row(e1);
    assert.deepEqual([r.utm_source, r.utm_medium, r.utm_campaign, r.source_page], ['tiktok', 'paid', 'tomatoes_paid_p1', '/vfarm']);
    assert.equal(r.form_a.utm.utm_content, 'v1');
    ok('tags that arrive before the lead are copied when the lead is posted');

    await lead(e2, `VFBUYER-ATTR-${t}-B`);
    w = await early.storeAttribution(early.readAttribution({ email: e2, utm: { ...tags, utm_source: 'instagram' } }));
    assert.ok(w.applied_to);
    r = await row(e2);
    assert.equal(r.utm_source, 'instagram');
    ok('tags that arrive after the lead are copied onto it at once');

    await early.storeAttribution(early.readAttribution({ email: e2, utm: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'x' } }));
    r = await row(e2);
    assert.equal(r.utm_source, 'instagram');
    ok('a lead that already has a source keeps it');

    w = await early.storeAttribution(early.readAttribution({ email: e3, utm: {} }));
    await lead(e3, `VFBUYER-ATTR-${t}-C`);
    r = await row(e3);
    assert.equal(r.utm_source ?? '', '');
    assert.equal(w.utm_keys.length, 0);
    const kept = (await query(`SELECT count(*)::int n FROM engine_vfarm_lead_attribution WHERE email = $1`, [e3])).rows[0].n;
    assert.equal(kept, 1);
    ok('a signup with no tags changes nothing on the lead, and the visit is still kept');

    assert.throws(() => early.readAttribution({ email: 'not-an-email', utm: tags }), /email is required/);
    ok('a bad email is refused');
    console.log(`\n${passed} passed`);
  } finally {
    await query(`DELETE FROM engine_events WHERE subject_id LIKE $1`, [`VFBUYER-ATTR-${t}%`]);
    await query(`DELETE FROM engine_vfarm_leads WHERE email = ANY($1)`, [[e1, e2, e3]]);
    await query(`DELETE FROM engine_vfarm_lead_attribution WHERE email = ANY($1)`, [[e1, e2, e3]]);
    process.exit(process.exitCode ?? 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
