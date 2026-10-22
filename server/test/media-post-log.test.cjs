/**
 * The Media Twin post log (2026-10-22, H58Q, Jason's SOURCE_TO_TARGET_LOG).
 * Part 1 checks every rule in mediaPostLog.check() with no database. Part 2 runs write() and read()
 * against a LOCAL database (localhost or 127.0.0.1, name ending _test) and deletes what it wrote.
 * Run with:  npm run test:media-post-log   (after the server build; part 2 needs DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const mpl = require(path.join(DIST, 'server/src', 'mediaPostLog.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const JASON = mpl.JASON;
const BASE = { asset_id: 'H58Q-A', asset_version: 'v0.3', source_id: 'linkedin:urn:li:share:TEST', platform: 'linkedin', claim_state: 'interest_only_live' };
const LINK = 'https://bhanetwork.org/vfarm?utm_source=linkedin&utm_medium=social&utm_campaign=vfarm_early_access';
const inFolder = async (id) => (id === 'FILE_IN_FOLDER' ? true : id === 'FILE_ELSEWHERE' ? false : 'Drive did not answer');
const refused = async (input, reason) => {
  await assert.rejects(mpl.check(input), (e) => {
    assert.equal(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.message}`);
    return true;
  });
};

(async () => {
  // ---------------------------------------------------------------- part 1, pure
  const draft = await mpl.check({ before: null, fields: BASE });
  assert.equal(draft.classification, 'CONCEPTUAL');
  assert.equal(draft.verified_current_p1_0, false);
  assert.equal(draft.approval, 'pending');
  assert.equal(draft.publish_result, 'not_published');
  assert.equal(draft.manual_only, true);
  ok('a draft post logs as CONCEPTUAL, not verified current, pending, not published, manual only');

  await refused({ before: null, fields: { ...BASE, source_id: undefined } }, 'missing_field');
  await refused({ before: null, fields: { ...BASE, nonsense: 1 } }, 'unknown_field');
  await refused({ before: null, fields: { ...BASE, platform: 'myspace' } }, 'bad_value');
  ok('a missing id, an unknown field and a platform outside the list are refused');

  await refused({ before: null, fields: { ...BASE, classification: 'VERIFIED_CURRENT' } }, 'verified_current_blocked');
  await refused({ before: null, fields: { ...BASE, verified_current_p1_0: true } }, 'verified_current_blocked');
  await refused({ before: null, fields: { ...BASE, automation_enabled: true } }, 'automation_off');
  ok('verified current is blocked, and automation is refused');

  await refused({ before: null, fields: { ...BASE, approval: 'APPROVE_FOR_EA_PUBLICATION', approved_by: 'U0BKT6MAW2Y' } }, 'approval_is_jasons');
  await refused({ before: null, fields: { ...BASE, approval: 'APPROVE_FOR_EA_PUBLICATION' } }, 'approval_is_jasons');
  ok('only Jason approves publication');

  const approved = { ...BASE, approval: 'APPROVE_FOR_EA_PUBLICATION', approved_by: JASON };
  await refused({ before: null, fields: { ...BASE, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER', utm_url: LINK }, inApprovedFolder: inFolder }, 'not_approved');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', utm_url: LINK }, inApprovedFolder: inFolder }, 'asset_not_in_folder');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_ELSEWHERE', utm_url: LINK }, inApprovedFolder: inFolder }, 'asset_not_in_folder');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_UNKNOWN', utm_url: LINK }, inApprovedFolder: inFolder }, 'drive_unchecked');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER', utm_url: LINK } }, 'drive_unchecked');
  ok('queued needs Jason\'s approval and a file in the approved folder; Drive not answering fails closed');

  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER' }, inApprovedFolder: inFolder }, 'utm_required');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER', utm_url: LINK.replace('linkedin', 'x') }, inApprovedFolder: inFolder }, 'utm_wrong');
  await refused({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER', utm_url: 'https://evil.example/vfarm?utm_source=linkedin&utm_medium=social&utm_campaign=x' }, inApprovedFolder: inFolder }, 'utm_wrong');
  assert.equal(mpl.utmProblem(LINK, 'linkedin'), null);
  const site = await mpl.check({ before: null, fields: { ...approved, platform: 'website', publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER' }, inApprovedFolder: inFolder });
  assert.equal(site.publish_result, 'queued');
  ok('a social post needs the /vfarm link tagged for its platform; the website itself needs none');

  const queued = await mpl.check({ before: null, fields: { ...approved, publish_result: 'queued', asset_file_id: 'FILE_IN_FOLDER', utm_url: LINK }, inApprovedFolder: inFolder });
  assert.equal(queued.publish_result, 'queued');
  await refused({ before: null, fields: { ...approved, publish_result: 'published', asset_file_id: 'FILE_IN_FOLDER', utm_url: LINK }, inApprovedFolder: inFolder }, 'target_required');
  ok('an approved picture in the folder with the right link can be queued; published needs the live post\'s link or id');

  const before = { log_id: 'MPL-1', ...BASE, asset_file_id: 'FILE_IN_FOLDER', classification: 'CONCEPTUAL', verified_current_p1_0: false, approval: 'APPROVE_FOR_EA_PUBLICATION', approved_by: JASON, approved_at: null, manual_only: true, automation_enabled: false, utm_url: LINK, publish_result: 'published', target_url: 'https://linkedin.com/feed/update/x', target_id: null, read_back: 'ok', read_back_detail: null, loop_id: null, notes: null, logged_by: 'U0AEW3TBYH1', test: false, created_at: '', updated_at: '' };
  await refused({ before, fields: { platform: 'x' } }, 'fixed_after_create');
  await refused({ before, fields: { publish_result: 'not_published' } }, 'already_published');
  await refused({ before, fields: { read_back: 'error' } }, 'missing_field');
  const rb = await mpl.check({ before, fields: { read_back: 'error', read_back_detail: 'LinkedIn says the post was removed' } });
  assert.equal(rb.read_back, 'error');
  ok('picture, source and platform are fixed; a published row never goes back; a read-back error needs what the platform said');

  // ---------------------------------------------------------------- part 2, database
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  await query(`DELETE FROM engine_media_post_log WHERE source_id LIKE 'linkedin:urn:li:share:TEST%'`);

  const dry = await mpl.write({ fields: BASE, by: 'U0AEW3TBYH1', via: 'test', dry_run: true });
  assert.equal(dry.written, false);
  assert.equal((await query(`SELECT count(*)::int AS n FROM engine_media_post_log`)).rows[0].n, 0);
  ok('a dry run writes nothing');

  const a = await mpl.write({ fields: BASE, by: '<@U0AEW3TBYH1>', via: 'test', test: true });
  assert.equal(a.created, true);
  assert.match(a.row.log_id, /^MPL-\d+-[A-Z0-9]{4}$/);
  assert.equal(a.row.logged_by, 'U0AEW3TBYH1');
  assert.ok(a.event_id, 'an engine event was recorded');
  const ev = await query(`SELECT event_type, subject_id, lane FROM engine_events WHERE id = $1`, [a.event_id]);
  assert.deepEqual(ev.rows[0], { event_type: 'media_post_logged', subject_id: a.row.log_id, lane: 'MEDIA' });
  ok('a post is logged with its own id, its author and one media_post_logged event in the same transaction');

  const b = await mpl.write({ log_id: a.row.log_id, fields: { approval: 'APPROVE_FOR_EA_PUBLICATION', approved_by: JASON }, by: 'U0AEW3TBYH1', via: 'test' });
  assert.equal(b.created, false);
  assert.deepEqual(b.row.asset_id, 'H58Q-A');
  const same = await mpl.write({ log_id: a.row.log_id, fields: { approval: 'APPROVE_FOR_EA_PUBLICATION' }, by: 'U0AEW3TBYH1', via: 'test' });
  assert.equal(same.written, false);
  ok('an update changes only what was sent, and an unchanged update writes nothing');

  await assert.rejects(mpl.write({ log_id: a.row.log_id, fields: { publish_result: 'queued', utm_url: LINK, asset_file_id: 'FILE_ELSEWHERE' }, by: 'U0AEW3TBYH1', via: 'test', inApprovedFolder: inFolder }), (e) => e.reason === 'asset_not_in_folder');
  const held = (await query(`SELECT publish_result FROM engine_media_post_log WHERE log_id = $1`, [a.row.log_id])).rows[0];
  assert.equal(held.publish_result, 'not_published');
  ok('a refused write leaves the row exactly as it was');

  await assert.rejects(query(`UPDATE engine_media_post_log SET automation_enabled = true WHERE log_id = $1`, [a.row.log_id]));
  await assert.rejects(query(`UPDATE engine_media_post_log SET verified_current_p1_0 = true WHERE log_id = $1`, [a.row.log_id]));
  ok('the table itself refuses automation and verified current, whoever writes');

  const pub = await mpl.write({ log_id: a.row.log_id, fields: { publish_result: 'published', utm_url: LINK, asset_file_id: 'FILE_IN_FOLDER', target_url: 'https://www.linkedin.com/feed/update/urn:li:share:TEST', read_back: 'ok' }, by: 'U0AEW3TBYH1', via: 'test', inApprovedFolder: inFolder });
  assert.equal(pub.row.publish_result, 'published');
  const r = await mpl.read({ include_test: true, asset_id: 'H58Q-A' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].target_url, 'https://www.linkedin.com/feed/update/urn:li:share:TEST');
  assert.equal(r.counts.test_rows, 1);
  assert.equal(r.counts.published, 0, 'a test row is not counted as a real post');
  assert.equal((await mpl.read({})).rows.length, 0, 'test rows are left out unless asked for');
  ok('a published post reads back whole; test rows are labelled, left out of the counts and out of a plain read');

  await query(`DELETE FROM engine_media_post_log WHERE log_id = $1`, [a.row.log_id]);
  await query(`DELETE FROM engine_events WHERE subject_id = $1`, [a.row.log_id]);
  console.log(`\n${n} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
