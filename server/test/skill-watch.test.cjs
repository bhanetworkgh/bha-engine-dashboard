/**
 * The skill watch's judgement (14 Nov 2026): n8n's update renamed backup copies of
 * skills and read live versions with none; neither may be saved as the new normal.
 * Pure, no database or network. Run with: npm run test:skill-watch
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
// Nothing here touches a database; where the pg package is not installed, stand it in.
try { require.resolve('pg'); } catch {
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'pg' ? { Pool: class {}, types: { setTypeParser() {} } } : load.call(this, req, ...rest); };
}
const sw = require(path.join(DIST, 'server/src/skillWatch.js'));
const pg = require(path.join(DIST, 'server/src/publishGate.js'));

// 1. A rename by n8n is not a loss.
assert.equal(sw.baseName('Open loops (Bays (OpenRouter backup))', 'Bays (OpenRouter backup)'), 'Open loops');
assert.equal(sw.baseName('Open loops', 'Bays (Agent)'), 'Open loops');
let j = sw.judge({ version: 'v1', skills: ['Open loops', 'Decision Watch'] }, 'v1', ['Open loops (Bays (OpenRouter backup))', 'Decision Watch (Bays (OpenRouter backup))'], 'Bays (OpenRouter backup)');
assert.deepEqual(j.lost, []);
assert.equal(j.keep_baseline, false);

// 2. The same version reading with fewer skills: a loss, said as n8n's read, baseline kept.
j = sw.judge({ version: 'v1', skills: ['Open loops', 'One true home'] }, 'v1', [], 'Bays (Agent)');
assert.deepEqual(j.lost, ['Open loops', 'One true home']);
assert.equal(j.same_version, true);
assert.equal(j.keep_baseline, true);
assert.deepEqual(j.baseline, { version: 'v1', skills: ['Open loops', 'One true home'] });

// 3. A new publish with fewer skills: a loss, and the new version becomes the baseline.
j = sw.judge({ version: 'v1', skills: ['A', 'B'] }, 'v2', ['A'], 'X');
assert.deepEqual(j.lost, ['B']);
assert.equal(j.same_version, false);
assert.equal(j.keep_baseline, false);
assert.deepEqual(j.baseline, { version: 'v2', skills: ['A'] });

// 4. No baseline yet: nothing lost, the read is the baseline.
j = sw.judge(null, 'v1', ['A (X)'], 'X');
assert.deepEqual(j.lost, []);
assert.deepEqual(j.baseline, { version: 'v1', skills: ['A'] });

// 5. The inventory's comparison ignores the same rename.
assert.deepEqual(pg.droppedSkills([{ name: 'Open loops' }, { name: 'Gone' }], [{ id: 's1', name: 'Open loops (Bays (OpenRouter backup))' }], 'Bays (OpenRouter backup)'), ['Gone']);
assert.deepEqual(pg.droppedSkills([{ name: 'Open loops' }], [{ id: 's1', name: 'Open loops' }]), []);

console.log('skill watch: 5 checks pass');
