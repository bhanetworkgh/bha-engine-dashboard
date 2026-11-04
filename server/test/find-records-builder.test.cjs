// 4 Nov 2026 — a Slack id in a find_records builder_id filter finds the person's rows.
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const { builderIdValues } = require(path.join(DIST, 'server/src/mcp/findRecords.js'));
let n = 0;
const ok = (fn, m) => { fn(); console.log(`ok ${++n} - ${m}`); };
ok(() => assert.deepEqual(builderIdValues(['U0BNQGG020Y']), { values: ['U0BNQGG020Y', 'kavin'], check: [] }), 'a roster Slack id also matches the name');
ok(() => assert.deepEqual(builderIdValues(['kavin']), { values: ['kavin'], check: [] }), 'a name stays as sent');
ok(() => assert.deepEqual(builderIdValues(['U0AEW3TBYH1', 'jegan']).values, ['U0AEW3TBYH1', 'jegan', 'destiny']), 'a list keeps every value');
ok(() => assert.deepEqual(builderIdValues(['U0ZZZZZZZZZ']), { values: ['U0ZZZZZZZZZ'], check: ['U0ZZZZZZZZZ'] }), 'an unknown Slack id stays and is checked');
console.log(`\n${n} checks passed`);
