/**
 * Read-back equality for BHARAG text (2026-11-09, Jason): words and punctuation must match; whitespace BHARAG
 * normalises (sub-bullet indentation, blank lines) is ignored and reported.
 * Run with: npm run test:stored-text
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { sameStoredText } = require(path.join(DIST, 'server/src/mcp/sopTools'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const sent = 'Rule:\n\n• Future drafts:\n    ◦ on a pattern,\n    ◦ approved for reuse.';
assert.equal(sameStoredText(sent, sent), 'exact'); ok('identical text is an exact match');
assert.equal(sameStoredText('Rule:\n• Future drafts:\n◦ on a pattern,\n◦ approved for reuse.', sent), 'whitespace_only'); ok('stripped indentation and a dropped blank line pass as whitespace only');
assert.equal(sameStoredText('Rule:\n• Future drafts:\n◦ on a pattern\n◦ approved for reuse.', sent), 'differs'); ok('a missing comma is a real difference');
assert.equal(sameStoredText('Rule:\n• Future drafts:\n◦ on a pattern,\n◦ approved for re-use.', sent), 'differs'); ok('a changed word is a real difference');
assert.equal(sameStoredText(null, sent), 'differs'); ok('nothing read back is never a match');
console.log(`stored-text: ${n} passed`);
