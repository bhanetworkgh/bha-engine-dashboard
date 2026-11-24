// The Media Twin's second review (24 Nov 2026): link tagging, reading the reviewer's answer, and what happens next.
// Pure, no database or network.
const assert = require('node:assert');
const path = require('node:path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'x';
const dist = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const m = require(path.join(dist, 'mediaReview.js'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const tag = (s) => m.tagLinks(s, 'x', 'MTP-1-AB12');
const T = 'utm_source=x&utm_medium=social&utm_campaign=media_twin&utm_content=MTP-1-AB12';

ok('a link is tagged for its platform, punctuation left outside', () => assert.equal(tag('Join at https://bhanetwork.org/vfarm.'), `Join at https://bhanetwork.org/vfarm?${T}.`));
ok('a bare domain gets https and a path', () => assert.equal(tag('See bhanetwork.org'), `See https://bhanetwork.org/?${T}`));
ok('an existing query and a hash are kept', () => assert.equal(tag('bhanetwork.org/vfarm?ref=a#top!'), `https://bhanetwork.org/vfarm?ref=a&${T}#top!`));
ok('a link already tagged is left alone', () => assert.equal(tag('https://www.bhanetwork.org/vfarm?utm_source=li'), 'https://www.bhanetwork.org/vfarm?utm_source=li'));
ok('an email address and other sites are not links', () => assert.equal(tag('admin@bhanetwork.org or example.org'), 'admin@bhanetwork.org or example.org'));
ok('the reviewer answer is read, fenced or not', () => {
  const v = m.parseReview('```json\n{"platforms":{"x":{"pass":true,"failed":[],"reasons":"","fix":""},"linkedin":{"pass":false,"failed":["no_buying","bogus"],"reasons":"says $199","fix":"drop it"}}}\n```', ['x', 'linkedin', 'facebook']);
  assert.equal(v.x.pass, true);
  assert.equal(v.linkedin.pass, false);
  assert.deepEqual(v.linkedin.failed, ['no_buying']);
  assert.equal(v.facebook.pass, false, 'a platform with no verdict fails');
});
ok('a pass that names a failed rule is a fail', () => assert.equal(m.parseReview('{"platforms":{"x":{"pass":true,"failed":["no_buying"]}}}', ['x']).x.pass, false));
ok('an answer that is not the JSON asked for is null, so nothing posts', () => assert.equal(m.parseReview('Looks good to me!', ['x']), null));
ok('all pass: post', () => assert.equal(m.nextStep({ x: { pass: true }, linkedin: { pass: true } }, new Set()), 'post'));
ok('a first fail: rewrite', () => assert.equal(m.nextStep({ x: { pass: true }, linkedin: { pass: false } }, new Set()), 'rewrite'));
ok('a fail on a platform rejected before: a person', () => assert.equal(m.nextStep({ x: { pass: false }, linkedin: { pass: false } }, new Set(['linkedin'])), 'people'));
ok('the note carries the reasons, the rules and the fix', () => assert.equal(m.note({ pass: false, failed: ['no_buying'], reasons: 'Says $199.', fix: 'Drop the price.' }), 'Second review: Says $199. (rules: no_buying) Fix: Drop the price.'));
const posts = require(path.join(dist, 'mediaPosts.js'));
ok('the decision path is named on every post', () => {
  assert.equal(posts.decisionPath({ parent_post_id: null }, 'media-twin-reviewer'), 'passed the second review first time');
  assert.equal(posts.decisionPath({ parent_post_id: 'MTP-1-AAAA' }, 'media-twin-reviewer'), 'passed the second review on a rewrite');
  assert.equal(posts.decisionPath({ parent_post_id: null }, 'U0A9V97949F'), 'approved by Jason');
});
console.log(`${n} passed`);
