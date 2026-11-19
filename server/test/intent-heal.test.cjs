// Genie rebuild 9.3: when a Bays intent-check incident is the engine's own fix (server/src/intentHeal.ts), pure, no database.
const assert = require('node:assert/strict');
const { passFor, targetOf, line } = require('../../server-dist/server/src/intentHeal.js');

const miss = { check_id: 'IC-1', tool: 'update_record', at: '2026-11-18T10:49:13.378Z', action: 'Change loop LOOP-1791181087549-GAJV ("Three vFarm hardware items")' };
const same = { check_id: 'IC-2', tool: 'update_record', at: '2026-11-18T10:50:23.000Z', action: 'Change loop LOOP-1791181087549-GAJV ("Three vFarm hardware items")' };
const other = { check_id: 'IC-3', tool: 'update_record', at: '2026-11-18T10:50:00.000Z', action: 'Change loop LOOP-1790000000000-ABCD ("Another")' };
const otherTool = { check_id: 'IC-4', tool: 'close_decision_watch', at: '2026-11-18T10:50:00.000Z', action: 'Close LOOP-1791181087549-GAJV' };
const late = { ...same, check_id: 'IC-5', at: '2026-11-18T11:30:00.000Z' };

assert.equal(targetOf(miss.action), 'LOOP-1791181087549-GAJV');
assert.equal(targetOf('Change Decision Watch DW-1793943283984-BEFG (owner Jason)'), 'DW-1793943283984-BEFG');
assert.equal(targetOf('Open a new loop: "VFARM_CONFIDENCE_SCORING_V0"'), null, 'a new loop names no record');
assert.equal(passFor(miss, [other, otherTool, same]).check_id, 'IC-2', 'the pass on the same record and tool is the fix');
assert.equal(passFor(miss, [other]), null, 'a pass on a different record is not the fix (13 Nov: DQ1P passed, BEFG had missed)');
assert.equal(passFor(miss, [otherTool]), null, 'a different tool is not the fix (16 Nov: close_decision_watch after a missed update_record)');
assert.equal(passFor(miss, [late]), null, 'outside 30 minutes it is left for a person');
assert.equal(passFor({ ...miss, action: 'Open a new loop: "x"', tool: 'create_record' }, [{ ...same, tool: 'create_record', action: 'Open a new loop: "x"' }]), null, 'a write with no record is never closed here (17 Nov: AGENT-117)');
assert.ok(line('INC-BAYS.AGENT-120', 'update_record', 'LOOP-1791181087549-GAJV', 'IC-2', '7029', 70).includes('70 seconds later'));
console.log('intent-heal: 9 checks passed');
