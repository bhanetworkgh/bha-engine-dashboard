// A Media Twin rewrite keeps the records its parent draft rested on (17 Nov 2026, LOOP-1794859197285-VMZR:
// MTP-1794839176882-WKJK came back with sources.codex empty, losing CODEX-20261114-ahad-vfarm-sensor-debug).
// Pure, no database or network.
const assert = require('node:assert');
const path = require('node:path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'x';
const dist = path.join(process.env.SERVER_DIST || path.join(__dirname, '../../server-dist'), 'server/src');
const m = require(path.join(dist, 'mediaPosts.js'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const parent = { news: [], codex: ['CODEX-20261114-ahad-vfarm-sensor-debug'], loops: [], slack: [], execution: '91351', self_check: 'parent' };
const rewrite = { news: [], codex: [], loops: [], slack: [], execution: '91625', rewrite_of: 'MTP-1794826948085-195Q', self_check: 'rewrite' };

ok("WKJK's real case: the parent's Codex log comes back", () => {
  const out = m.mergeSources(parent, rewrite);
  assert.deepEqual(out.codex, ['CODEX-20261114-ahad-vfarm-sensor-debug']);
  assert.equal(out.execution, '91625');
  assert.equal(out.self_check, 'rewrite');
  assert.equal(out.rewrite_of, 'MTP-1794826948085-195Q');
});
ok('the failure-story check sees the carried id', () => {
  assert.deepEqual(m.sourceIds(m.mergeSources(parent, rewrite)), ['CODEX-20261114-ahad-vfarm-sensor-debug']);
});
ok('a record the rewrite adds is kept after the parent ones, each id once', () => {
  const out = m.mergeSources({ loops: ['LOOP-1-AAAA'], codex: ['CODEX-A'] }, { loops: ['LOOP-2-BBBB', 'LOOP-1-AAAA'] });
  assert.deepEqual(out.loops, ['LOOP-1-AAAA', 'LOOP-2-BBBB']);
  assert.deepEqual(out.codex, ['CODEX-A']);
});
ok('a rewrite that sends no sources at all still inherits them', () => {
  assert.deepEqual(m.mergeSources(parent, undefined).codex, ['CODEX-20261114-ahad-vfarm-sensor-debug']);
});
ok('a list neither side has is not invented', () => {
  const out = m.mergeSources({ codex: ['CODEX-A'] }, { execution: '1' });
  assert.equal('loops' in out, false);
  assert.equal('news' in out, false);
});
ok("the rewrite's doctrine check is left where the create path reads it", () => {
  const dc = { platforms: { x: { appliance: true } } };
  assert.deepEqual(m.mergeSources(parent, { doctrine_check: dc }).doctrine_check, dc);
});
console.log(`${n} passed`);
