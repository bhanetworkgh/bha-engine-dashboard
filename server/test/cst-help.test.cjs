/**
 * CST help for the voice agent (30 Oct 2026). Pure, no database: which key opens which mode, and that a
 * live call never sees a page that has not passed Hardik's check for exactly its current text.
 * Run with:  npm run test:cst-help   (after the server build)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const c = require(path.join(DIST, 'server/src', 'cstHelp.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const env = { CST_HELP_KEY: 'live-key-1234567890', CST_HELP_PREVIEW_KEY: 'preview-key-0987654321' };
assert.deepEqual(c.modeFor('live-key-1234567890', env), { ok: true, mode: 'live' });
assert.deepEqual(c.modeFor('preview-key-0987654321', env), { ok: true, mode: 'preview' });
assert.equal(c.modeFor('wrong', env).status, 401);
assert.equal(c.modeFor(undefined, env).status, 401);
assert.equal(c.modeFor('', { CST_HELP_KEY: '' }).status, 503);
assert.equal(c.modeFor('x', {}).status, 503);
assert.equal(c.modeFor('preview-key-0987654321', { CST_HELP_KEY: 'live-key-1234567890' }).status, 401);
ok('the live key opens live, the preview key opens preview, anything else is 401, neither set is 503');

const page = (id, stage, body, checked) => ({ page_id: id, title: id, body, body_sha256: 'h-' + body, checked_sha256: checked, stage, gaps: [] });
const pages = [
  page('a', 'in_corpus', 'A', 'h-A'),
  page('b', 'checked', 'B', 'h-B'),
  page('c', 'draft', 'C', null),
  page('d', 'in_corpus', 'D2', 'h-D1'),
];
pages[2].gaps = [{ id: 'src', owner: 'Jegan', note: 'sources' }];
const live = c.agentView(pages, 'live');
assert.deepEqual(live.pages.map((p) => p.page_id), ['a']);
assert.equal(live.pages[0].status, 'approved');
ok('live sees only in_corpus pages whose text is the text Hardik checked (a checked page not yet in corpus, a draft, and an edited page are all left out)');
assert.match(c.agentView([pages[2]], 'live').instruction, /No help page has been approved/);
ok('live with nothing approved tells the agent to say so and offer a person');
const pv = c.agentView(pages, 'preview');
assert.deepEqual(pv.pages.map((p) => [p.page_id, p.status]), [['a', 'approved'], ['b', 'draft, not for customers'], ['c', 'draft, not for customers'], ['d', 'draft, not for customers']]);
assert.deepEqual(pv.pages[2].not_written_yet, [{ owner: 'Jegan', note: 'sources' }]);
assert.match(pv.instruction, /TEST MODE/);
ok('preview sees every page, each marked by stage, with what is not written yet and who owes it');
console.log(`\n${n} checks passed`);
