/**
 * Loop and Decision Watch change announcements (18 Nov 2026, D7). The rules, no database or Slack:
 * what counts as a change, what is a small edit, where the reason comes from, and the two post shapes.
 * Run with:  npm run test:change-announce
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ca = require(path.join(DIST, 'server/src', 'changeAnnounce.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };
const names = { U0AEW3TBYH1: 'Destiny Arupi', U0AC6RFNP3P: 'Ahad', U0AF011R821: 'Jeganathan' };
const nm = (id) => names[id] || id;
const ch = (id, at, before, keys) => ({ history_id: String(id), at, before, changed_keys: keys });

// 1. a close with its reason is a completion report
let it = ca.loopItem('LOOP-1-AAAA', { What: 'Rotate the CST keys', Status: 'Closed', 'Close Reason': 'All 14 keys checked at source', 'Assignee Slack User ID': 'U0AC6RFNP3P' },
  [ch(1, '2026-11-18T08:00:00Z', { What: 'Rotate the CST keys', Status: 'Open', 'Assignee Slack User ID': 'U0AC6RFNP3P' }, ['Status', 'Close Reason'])], nm);
assert.equal(it.kind, 'completion');
assert.equal(it.why, 'All 14 keys checked at source');
assert.equal(it.owner, 'Ahad');
assert.deepEqual(it.changes, ['closed (was Open)']);
assert.match(ca.render(it), /^<!channel> \*Completion report\* on loop LOOP-1-AAAA/);
assert.doesNotMatch(ca.render(it), /Next:/);
ok('a loop closed with a reason is a completion report giving that reason, and carries no nudge');

// 2. a reworded title alone posts nothing
assert.equal(ca.loopItem('LOOP-2-BBBB', { What: 'New words', Status: 'Open' }, [ch(2, '2026-11-18T08:00:00Z', { What: 'Old words', Status: 'Open' }, ['What'])], nm), null);
assert.equal(ca.loopItem('LOOP-2-BBBB', { What: 'x', lane_tag: 'GENIE', Status: 'Open' }, [ch(3, '2026-11-18T08:00:00Z', { What: 'x', lane_tag: 'BAYS', Status: 'Open' }, ['lane_tag'])], nm), null);
ok('a reworded title or a lane tag change is a small edit and posts nothing');

// 3. a progress note added is a progress report, quoting only what was added
it = ca.loopItem('LOOP-3-CCCC', { What: 'Genie builds workflows', Status: 'In Progress', 'Progress Note': 'Spec written.\nUpdate 2026-11-18: n8n tools wired and proven on run 95300.', 'Assignee Slack User ID': 'U0AEW3TBYH1' },
  [ch(4, '2026-11-18T08:00:00Z', { What: 'Genie builds workflows', Status: 'In Progress', 'Progress Note': 'Spec written.', 'Assignee Slack User ID': 'U0AEW3TBYH1' }, ['Progress Note'])], nm);
assert.equal(it.kind, 'progress');
assert.equal(it.why, 'n8n tools wired and proven on run 95300.');
assert.match(ca.render(it), /^<!channel> \*Progress report\* on loop LOOP-3-CCCC/);
assert.match(ca.render(it), /Next: keep it moving and close it once it is done\./);
ok('a note added is a progress report that quotes only the new part, with a nudge');

// 4. several writes to one loop in a pass fold into one item
it = ca.loopItem('LOOP-4-DDDD', { What: 'w', Status: 'Closed', 'Close Reason': 'done', 'Assignee Slack User ID': 'U0AF011R821' }, [
  ch(5, '2026-11-18T08:00:00Z', { What: 'w', Status: 'Open', 'Assignee Slack User ID': 'U0AEW3TBYH1' }, ['Assignee Slack User ID']),
  ch(6, '2026-11-18T08:00:20Z', { What: 'w', Status: 'Open', 'Assignee Slack User ID': 'U0AF011R821' }, ['Status', 'Close Reason']),
], nm);
assert.equal(it.kind, 'completion');
assert.deepEqual(it.changes, ['closed (was Open)', 'now with Jeganathan (was Destiny Arupi)']);
assert.deepEqual(it.keys, ['change_announce:loop_history:5', 'change_announce:loop_history:6']);
ok('two writes to one loop are one post, claimed by both history rows');

// 5. no reason written is said, never invented
it = ca.loopItem('LOOP-5-EEEE', { What: 'w', Status: 'Closed' }, [ch(7, '2026-11-18T08:00:00Z', { What: 'w', Status: 'Open' }, ['Status'])], nm);
assert.equal(it.why, 'no reason recorded');
assert.equal(it.owner, 'no owner set');
ok('a close with no reason on the record says "no reason recorded"');

// 5b. a close whose reason is only on Bays' audit line takes it from there, with who asked
it = ca.loopItem('LOOP-5B-EEEE', { What: 'w', Status: 'Closed', 'Assignee Slack User ID': 'U0AF011R821' },
  [ch(9, '2026-11-18T06:22:17.055Z', { What: 'w', Status: 'Open', 'Assignee Slack User ID': 'U0AF011R821' }, ['Status'])], nm,
  [{ at: '2026-11-18T06:22:17.039Z', tool: 'archive_record', reason: 'Shipped in commit ee0f4531, 23 tests green.', by: 'U0AF011R821' },
   { at: '2026-11-18T05:00:00.000Z', tool: 'archive_record', reason: 'an older write', by: 'U0AEW3TBYH1' }]);
assert.equal(it.why, 'Shipped in commit ee0f4531, 23 tests green.');
assert.deepEqual(it.changes, ['closed by Jeganathan (was Open)']);
ok('a close with its reason only on the audit line uses it and names who asked; an older write is not read');

// 6. a test loop posts nothing
assert.equal(ca.loopItem('LOOP-6-FFFF', { What: 'TEST probe', Status: 'Closed' }, [ch(8, '2026-11-18T08:00:00Z', { What: 'TEST probe', Status: 'Open' }, ['Status'])], nm), null);
ok('a loop whose title starts TEST posts nothing');

// 7. a watch next step added is a progress report naming who and what was added, with the newest line as next
const w = { watch_id: 'DW-1-AAAA', decision: 'Genie can build any workflow', owner_name: 'Destiny Arupi', status: 'open', next_step: 'Build the tools.\nUpdate 2026-11-18 (Jason, this thread): prove one real build.', thread_link: 'https://x.slack.com/archives/C1/p1', fixture: false };
it = ca.watchItem(w, [{ event_id: '10', event_type: 'decision_watch_updated', at: '2026-11-18T08:00:00Z', detail: { by: 'U0AEW3TBYH1', changes: [{ field: 'next_step', from: 'Build the tools.', to: w.next_step }] } }], nm);
assert.equal(it.kind, 'progress');
assert.deepEqual(it.changes, ['next step updated by Destiny Arupi']);
assert.equal(it.why, 'prove one real build.');
assert.equal(it.next, 'prove one real build.');
assert.match(ca.render(it), /\nNext: prove one real build\. Close it once that lands\.\n/);
ok('a watch next step update is a progress report with what was added and the newest line as the next step');

// 8. a watch close is a completion report with its proof reason
it = ca.watchItem(w, [{ event_id: '11', event_type: 'decision_watch_closed', at: '2026-11-18T09:00:00Z', detail: { by: 'U0A9V97949F', reason: 'Proof: run 95300', status: 'answered' } }], (id) => (id === 'U0A9V97949F' ? 'Jason Bays' : id));
assert.equal(it.kind, 'completion');
assert.deepEqual(it.changes, ['closed by Jason Bays (answered)']);
assert.equal(it.why, 'Proof: run 95300');
assert.equal(it.next, null);
ok('a watch closed is a completion report with its close reason');

// 9. a test watch posts nothing
assert.equal(ca.watchItem({ ...w, fixture: true }, [{ event_id: '12', event_type: 'decision_watch_closed', at: '2026-11-18T09:00:00Z', detail: { reason: 'x' } }], nm), null);
ok('a fixture watch posts nothing');

// 10. many changes go out as one combined post
const many = [1, 2, 3, 4, 5].map((k) => ({ kind: k % 2 ? 'completion' : 'progress', record: 'loop', id: `LOOP-${k}`, title: `t${k}`, owner: 'Ahad', changes: ['closed (was Open)'], why: 'r', stands: 'Closed', next: null, link: 'https://d/x', keys: [`k${k}`], at: '2026-11-18T08:00:00Z' }));
const b = ca.renderBatch(many);
assert.match(b, /^<!channel> \*Engine updates\*: 5 changes \(3 closed, 2 moved\)/);
assert.equal(b.split('\n').filter((l) => l.startsWith('• ')).length, 5);
assert.ok(ca.RULE.batch_over < many.length);
ok('more than four changes in a pass are one combined post listing each');

// 11. the channel is #bha-coordination by default
assert.equal(ca.RULE.channel, process.env.CHANGE_ANNOUNCE_CHANNEL?.trim() || 'C0ASMPYQLG3');
ok('the posts go to #bha-coordination');

// 12. added() and newestLine()
assert.equal(ca.added('a', 'a\nUpdate 2026-11-18: b'), 'b');
assert.equal(ca.added('old', 'something new'), 'something new');
assert.equal(ca.newestLine('one\ntwo\nUpdate 2026-11-18 (Jason): three'), 'three');
ok('only the added text is quoted, and the date stamp is dropped');

// 13. Block Kit: header, facts, what changed as a bullet list, why as a quote, a button
{
  const bi = { kind: 'progress', record: 'loop', id: 'LOOP-9-ZZZZ', title: 'Wire it', owner: 'Destiny Arupi', changes: ['Progress Note added', 'status Open → In Progress'], why: 'event 118905 landed', stands: 'In Progress', next: null, link: 'https://x/open-loops/LOOP-9-ZZZZ', keys: ['k'], at: '2026-11-18T09:27:37Z', author: 'U1', owner_id: 'U1', changed_by: 'Destiny Arupi', lane: 'CAPITAL' };
  const b = ca.blocks(bi);
  assert.equal(b[0].type, 'header');
  assert.equal(b[0].text.text, 'Progress report');
  const list = b.find((x) => x.type === 'rich_text' && x.elements.some((e) => e.type === 'rich_text_list'));
  assert.equal(list.elements[1].elements.length, 2);
  assert.ok(b.some((x) => x.type === 'rich_text' && x.elements.some((e) => e.type === 'rich_text_quote')));
  assert.ok(JSON.stringify(b).includes('Changed by') && JSON.stringify(b).includes('CAPITAL') && JSON.stringify(b).includes('10:27 Lagos'));
  assert.equal(b[b.length - 1].elements[0].url, bi.link);
  assert.ok(b[1].text.text.startsWith('<!channel>') && JSON.stringify(b).includes('<@U1>'));
  const bb = ca.batchBlocks([bi, { ...bi, id: 'LOOP-8', kind: 'completion' }]);
  assert.equal(bb[0].text.text, 'Engine updates');
  assert.ok(bb.filter((x) => x.type === 'rich_text').length === 2);
  ok('the post is Block Kit with lists, a quote and a button');
}

console.log(`\n${n} checks passed`);
