/**
 * Shared memory (17 Nov 2026, Genie rebuild 7, sharedMemory.ts): the pure parts. No database, no network.
 * SERVER_DIST=<compiled server dir> node server/test/shared-memory.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.SERVER_DIST || path.join(__dirname, '..', '..', 'server-dist', 'server', 'src');
const shared = require(path.join(dist, 'sharedMemory.js'));
assert.deepEqual(shared.words('Remember that <@U0AEW3TBYH1> Kavin is out until Friday'), ['kavin', 'out', 'until', 'friday']);
assert.ok(shared.WRITERS.has('genie') && shared.WRITERS.has('bays') && !shared.WRITERS.has('anyone'));
assert.equal(shared.LIMITS.note_chars, 600);
console.log('shared memory: 3 checks passed');
