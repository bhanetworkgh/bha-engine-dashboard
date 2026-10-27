/**
 * CST help pages (27 Oct 2026). Part 1 checks the pure rules with no database. Part 2 runs migration 98
 * against a LOCAL database (localhost or 127.0.0.1, name ending _test): the three seeded pages, a write,
 * Hardik's check on his own Slack message (Slack stood in), an edit that puts a checked page back to draft,
 * in_corpus only from checked, and the read tool's answer and scopes. It restores what it changed.
 * Run with:  npm run test:help-pages   (after the server build; part 2 needs DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const h = require(path.join(DIST, 'server/src', 'helpPages.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const DESTINY = 'U0AEW3TBYH1';
const HARDIK = 'U0BKT6MAW2Y';
const KAVIN = 'U0BNQGG020Y';
const HARDIK_MSG = 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792702326928939';
const OTHER_MSG = 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792702326928940';
const slack = async (link) => ({ ok: true, user: link.ts === '1792702326.928939' ? HARDIK : KAVIN });
const reason = async (p, r) => assert.rejects(p, (x) => { assert.equal(x.reason, r, `expected ${r}, got ${x.reason}: ${x.message}`); return true; });

(async () => {
  // ---------------------------------------------------------------- part 1, pure
  assert.deepEqual(h.cleanGaps([{ id: 'cleaning-steps', owner: 'Jegan', note: 'The steps.' }]), [{ id: 'cleaning-steps', owner: 'Jegan', note: 'The steps.' }]);
  assert.throws(() => h.cleanGaps([{ id: 'x', owner: 'Jegan', note: 'n' }]), /id must be/);
  assert.throws(() => h.cleanGaps([{ id: 'abc', owner: '', note: 'n' }]), /owner/);
  assert.throws(() => h.cleanGaps([{ id: 'abc', owner: 'J', note: 'n' }, { id: 'abc', owner: 'J', note: 'n' }]), /twice/);
  ok('a gap needs an id, an owner and a note; an id is listed once');
  assert.equal(h.stageLabel({ stage: 'draft', gaps: [{}, {}] }), 'Draft, 2 gaps open');
  assert.equal(h.stageLabel({ stage: 'draft', gaps: [] }), 'Draft');
  assert.equal(h.stageLabel({ stage: 'checked', gaps: [] }), 'Checked by Hardik');
  assert.equal(h.stageLabel({ stage: 'in_corpus', gaps: [] }), 'In cst-help-manuals');
  ok('the stage reads in words, and a draft with gaps says how many');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  try {
    // ---------------------------------------------------------------- the seed
    let r = await h.read();
    assert.deepEqual(r.pages.map((p) => p.page_id), ['operator-quickstart', 'rack-care', 'what-cst-can-do']);
    assert.ok(r.pages.every((p) => p.stage === 'draft' && !p.customer_safe));
    assert.deepEqual(r.pages.find((p) => p.page_id === 'rack-care').gaps.map((g) => g.id), ['cleaning-steps', 'plant-stage-care']);
    for (const p of r.pages) assert.equal(p.body_sha256, h.sha(p.body), `${p.page_id}: stored hash is the text's`);
    assert.match(r.pages[0].body, /## What you can see/);
    assert.equal(r.counts.draft, 3);
    assert.equal(r.counts.gaps_open, 2);
    assert.deepEqual(r.pages.find((p) => p.page_id === 'operator-quickstart').gaps, []);
    assert.match(r.pages[0].body, /current pilot rule/);
    ok('migrations 98 and 99 leave the three drafts with Jegan\'s two gaps named, the quickstart stating the pilot rule, and the hash of their text');

    const before = r.pages.find((p) => p.page_id === 'what-cst-can-do');

    // ---------------------------------------------------------------- who may write
    await reason(h.write({ page_id: 'what-cst-can-do', body: 'x', requester_user_id: KAVIN }), 'not_permitted');
    await reason(h.write({ page_id: 'Bad Id', body: 'x', title: 't', requester_user_id: DESTINY }), 'bad_page_id');
    let w = await h.write({ page_id: 'what-cst-can-do', title: before.title, body: before.body, requester_user_id: DESTINY });
    assert.equal(w.written, false);
    ok('only Destiny or Jason writes a page; the same text again changes nothing');

    // ---------------------------------------------------------------- the check
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'in_corpus', bharag_doc_id: 'd1', requester_user_id: DESTINY }), 'wrong_stage');
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'checked', requester_user_id: DESTINY }, { checkMessage: slack }), 'evidence_required');
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'checked', evidence_link: OTHER_MSG, requester_user_id: DESTINY }, { checkMessage: slack }), 'evidence_not_hardiks');
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'checked', evidence_link: HARDIK_MSG, body_sha256: 'stale', requester_user_id: DESTINY }, { checkMessage: slack }), 'text_changed');
    const dry = await h.setStage({ page_id: 'what-cst-can-do', action: 'checked', evidence_link: HARDIK_MSG, requester_user_id: DESTINY }, { dry_run: true, checkMessage: slack });
    assert.equal(dry.written, false);
    assert.equal((await h.get('what-cst-can-do')).stage, 'draft');
    ok('in_corpus is refused before a check; a check needs Hardik\'s own message, on the text as it stands; a dry run writes nothing');

    let s = await h.setStage({ page_id: 'what-cst-can-do', action: 'checked', evidence_link: HARDIK_MSG, body_sha256: before.body_sha256, requester_user_id: DESTINY }, { checkMessage: slack });
    assert.equal(s.page.stage, 'checked');
    assert.equal(s.page.checked_by, HARDIK);
    assert.equal(s.page.checked_sha256, before.body_sha256);
    ok('Hardik\'s check is recorded against the hash of the text he passed');

    // ---------------------------------------------------------------- an edit undoes it
    w = await h.write({ page_id: 'what-cst-can-do', body: before.body + '\n\nOne more line.', note: 'test edit', requester_user_id: DESTINY });
    assert.equal(w.page.stage, 'draft');
    assert.equal(w.page.checked_by, null);
    assert.match(w.message, /draft again/);
    ok('changing a checked page\'s text puts it back to draft');

    s = await h.setStage({ page_id: 'what-cst-can-do', action: 'checked', evidence_link: HARDIK_MSG, requester_user_id: HARDIK }, { checkMessage: slack });
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'in_corpus', requester_user_id: DESTINY }), 'bharag_doc_id_required');
    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'in_corpus', bharag_doc_id: 'doc-1', requester_user_id: HARDIK }), 'not_permitted');
    s = await h.setStage({ page_id: 'what-cst-can-do', action: 'in_corpus', bharag_doc_id: 'doc-1', requester_user_id: DESTINY });
    assert.equal(s.page.stage, 'in_corpus');
    r = await h.read();
    assert.equal(r.pages.find((p) => p.page_id === 'what-cst-can-do').customer_safe, true);
    ok('in_corpus only from checked, by Destiny or Jason, with the BHARAG doc id; only then is a page customer-safe');

    await reason(h.setStage({ page_id: 'what-cst-can-do', action: 'back_to_draft', requester_user_id: DESTINY }), 'note_required');
    s = await h.setStage({ page_id: 'what-cst-can-do', action: 'back_to_draft', note: 'test', requester_user_id: DESTINY });
    assert.equal(s.page.stage, 'draft');
    assert.equal(s.page.bharag_doc_id, null);
    const hist = await h.history('what-cst-can-do');
    assert.deepEqual(hist.slice(0, 5).map((x) => x.action), ['back_to_draft', 'in_corpus', 'checked', 'edited', 'checked']);
    const ev = await query(`SELECT count(*)::int AS n FROM engine_events WHERE event_type IN ('help_page_written','help_page_stage_changed') AND subject_id = 'what-cst-can-do'`);
    assert.equal(ev.rows[0].n, 5);
    ok('back to draft needs a reason; every change is a history line and one engine event');

    // ---------------------------------------------------------------- the tools
    const { readHelpPages, writeHelpPage } = require(path.join(DIST, 'server/src/mcp', 'helpPageTools.js'));
    const deps = { access: 'read', startedAt: new Date().toISOString(), dispatch: async () => ({ status: 200, body: {} }) };
    const t = await readHelpPages.handler({ page_id: 'rack-care' }, deps);
    assert.equal(t.ok, true);
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0].url, /\/cs-twin\?tab=help&page=rack-care$/);
    assert.ok(t.rules.some((x) => /never quote it to a customer/.test(x)));
    const miss = await readHelpPages.handler({ page_id: 'nope' }, deps);
    assert.equal(miss.reason, 'not_found');
    const agent = await writeHelpPage.handler({ page_id: 'rack-care', body: 'x', requester_user_id: DESTINY }, { ...deps, access: 'write', agent: 'bays' });
    assert.equal(agent.reason, 'agent_not_permitted');
    ok('read_help_pages returns the page with its link and the rules; an agent token cannot write');

    // restore the seeded text and stage
    await query(`UPDATE engine_help_pages SET body=$2, body_sha256=$3, stage='draft' WHERE page_id=$1`, ['what-cst-can-do', before.body, before.body_sha256]);
    await query(`DELETE FROM engine_help_page_history WHERE page_id='what-cst-can-do' AND action <> 'created'`);
    await query(`DELETE FROM engine_events WHERE event_type IN ('help_page_written','help_page_stage_changed')`);
  } finally {
    await closePool();
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
