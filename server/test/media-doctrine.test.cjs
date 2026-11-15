// Jason's vFarm doctrine gate on Media Twin drafts (15 Nov 2026, YHGE; SOPs f0a871ac, 753e8c36, 5e325189).
// Pure, no database or network.
const assert = require('node:assert');
const path = require('node:path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'x';
const dist = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const m = require(path.join(dist, 'mediaPosts.js'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const all = ['linkedin', 'x', 'facebook', 'instagram'];
const good = { platforms: { linkedin: { dust_collector: true, appliance: true }, facebook: { dust_collector: 'yes', appliance: 'yes' }, x: { dust_collector: false, appliance: true }, instagram: { dust_collector: false, appliance: true } } };

ok('the SOP minimum passes', () => assert.deepEqual(m.doctrineCheck(good, all, 'build_update').failures, []));
ok('no check at all fails every platform', () => assert.equal(m.doctrineCheck(undefined, all, 'build_update').failures.length, 4));
ok('LinkedIn without the dust-collector contrast fails', () => {
  const r = m.doctrineCheck({ platforms: { ...good.platforms, linkedin: { dust_collector: false, appliance: true } } }, all, 'build_update');
  assert.deepEqual(r.failures, ['linkedin: answers no to the dust-collector question']);
});
ok('X without the grab-and-go line fails', () => {
  const r = m.doctrineCheck({ platforms: { ...good.platforms, x: { dust_collector: true, appliance: false } } }, all, 'trend');
  assert.equal(r.failures.length, 1);
});
ok('an occasion post may say why the contrast does not fit; a build update may not', () => {
  const no = { platforms: { linkedin: { dust_collector: false, appliance: false } }, occasion_exempt: 'Thanksgiving greeting, the contrast would read as a sales pitch' };
  assert.deepEqual(m.doctrineCheck(no, ['linkedin'], 'holiday').failures, []);
  assert.equal(m.doctrineCheck(no, ['linkedin'], 'build_update').failures.length, 1);
  assert.equal(m.doctrineCheck(no, ['linkedin'], 'build_update').record.occasion_exempt, null);
});
ok('a rewrite is checked only on the platforms it sends', () => assert.deepEqual(m.doctrineCheck({ platforms: { x: { appliance: true } } }, ['x'], 'build_update').failures, []));
ok('a tension is kept only when it names all three parts', () => {
  const r = m.doctrineCheck({ ...good, tensions: [{ line_wanted: 'an appliance, not a hobby', product_today: 'Stage 1 rack, no unattended run yet', wording_used: 'we are building it to feel like an appliance' }, { line_wanted: 'x' }] }, all, 'build_update');
  assert.equal(r.record.tensions.length, 1);
  assert.deepEqual(r.record.sops, ['f0a871ac-86ac-43ec-a9e1-b60494d9ff26', '753e8c36-803d-4ff6-8153-92e2852bccf9', '5e325189-ca6c-421c-b598-5fa5cd403631']);
});
console.log(`${n} passed`);
