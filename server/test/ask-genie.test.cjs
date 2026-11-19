// Genie rebuild 10.1: ask_genie's argument checks (server/src/mcp/genieAskTools.ts), pure, no database.
const assert = require('node:assert/strict');
const { argProblem, genieUrl } = require('../../server-dist/server/src/mcp/genieAskTools.js');
const ok = { channel_id: 'C0ATTFED35E', thread_ts: '1795080000.123456', asked_by: 'U0AEW3TBYH1', question: 'Is the Genie deploy on Render live?' };
assert.equal(argProblem(ok), null);
assert.match(argProblem({ ...ok, channel_id: 'D0AF0DG8ZPY' }), /channel thread only/, 'a DM is refused');
assert.match(argProblem({ ...ok, thread_ts: '' }), /thread_ts/);
assert.match(argProblem({ ...ok, asked_by: 'Destiny' }), /asked_by/);
assert.match(argProblem({ ...ok, question: 'hi' }), /3 to 8,000/);
delete process.env.GENIE_URL;
assert.equal(genieUrl(), 'https://genie-v3-migration-u82u.onrender.com');
console.log('ask-genie: 6 checks passed');
