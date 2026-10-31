/**
 * Decision Watch reminder contract (31 Oct 2026, Jason in #workflow-logs-destiny 1793376980.352649):
 * in-thread reminders at 24 hours, then 72 hours quiet, then 7 days quiet, and one combined DM per person
 * listing every open watch. The pure parts: the step timing, the one-line "what is owed", the DM's order
 * and wording, and the reminder's "why it was picked" line. No database, no network.
 *   npm run test:decision-watch-digest
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const dw = require(path.join(__dirname, '..', '..', 'server-dist', 'server', 'src', 'decisionWatch.js'));

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };
const NOW = new Date('2026-10-31T08:00:00Z');
const H = 3600e3;
const ago = (h) => new Date(NOW.getTime() - h * H);
const watch = (id, owner, quietHours, extra = {}) => ({
  watch_id: id, owner_user_id: owner, quiet_since: ago(quietHours), wait_minutes: 1440, reminders_sent: 0, max_reminders: 3,
  decision: `Do the thing ${id}`, next_step: null, thread_link: `https://example/${id}`, snoozed_until: null, fixture: false, record_id: null, ...extra,
});

ok('reminder 1 waits the watch\'s own wait', () => assert.equal(dw.stepWaitMinutes({ wait_minutes: 1440, reminders_sent: 0, max_reminders: 3 }), 1440));
ok('reminder 2 waits 72 hours quiet', () => assert.equal(dw.stepWaitMinutes({ wait_minutes: 1440, reminders_sent: 1, max_reminders: 3 }), 72 * 60));
ok('reminder 3 waits 7 days quiet', () => assert.equal(dw.stepWaitMinutes({ wait_minutes: 1440, reminders_sent: 2, max_reminders: 3 }), 168 * 60));
ok('the escalation waits the watch\'s own wait', () => assert.equal(dw.stepWaitMinutes({ wait_minutes: 1440, reminders_sent: 3, max_reminders: 3 }), 1440));
ok('a longer own wait is never shortened', () => assert.equal(dw.stepWaitMinutes({ wait_minutes: 96 * 60, reminders_sent: 1, max_reminders: 3 }), 96 * 60));
ok('dueAt follows the step', () => assert.equal(dw.dueAt({ quiet_since: NOW, wait_minutes: 1440, reminders_sent: 1, max_reminders: 3 }).getTime(), NOW.getTime() + 72 * H));
ok('what is owed is the newest update line', () => assert.equal(dw.owedLine({ next_step: 'First plan\nUpdate 2026-10-30 (Jason): post the evidence', decision: 'x' }), 'post the evidence'));
ok('with no next step, what is owed is the ask', () => assert.equal(dw.owedLine({ next_step: null, decision: 'Send the SOW' }), 'Send the SOW'));

ok('the DM lists overdue first, longest waiting first, and leaves a snoozed watch not overdue', () => {
  const items = dw.digestItems([watch('DW-A', 'U1', 30), watch('DW-B', 'U1', 100), watch('DW-C', 'U1', 2), watch('DW-S', 'U1', 50, { snoozed_until: new Date(NOW.getTime() + 48 * H) })], NOW);
  assert.deepEqual(items.map((i) => i.watch_id), ['DW-B', 'DW-A', 'DW-S', 'DW-C']);
  assert.deepEqual(items.map((i) => i.overdue), [true, true, false, false]);
  assert.equal(items[2].snoozed_until, '2026-11-02');
  const text = dw.digestText('U1', items);
  assert.match(text, /you have \*4 open asks\*, 2 past their first wait/);
  assert.ok(text.indexOf('*Waiting on you*') < text.indexOf('*Open, not due yet*'));
  assert.match(text, /`DW-B` · <https:\/\/example\/DW-B\|thread> · waiting 4 days/);
  assert.match(text, /snoozed until 2026-11-02/);
  assert.match(text, /One summary per 12 hours/);
});

ok('past 25 watches the DM counts the rest and links the page', () => {
  const many = Array.from({ length: 30 }, (_, i) => watch(`DW-${i}`, 'U1', 30 + i));
  const text = dw.digestText('U1', dw.digestItems(many, NOW));
  assert.match(text, /_and 5 more: <https:\/\/[^|]+\/bays\?tab=decision-watch\|all your watches>_/);
});

ok('a thread reminder says which step picked it and that the list comes by DM', () => {
  const t = dw.reminderText(watch('DW-Z', 'U9', 80, { reminders_sent: 1 }), 2, NOW);
  assert.match(t, /reminder 2 of 3, after 72 hours quiet, longest-waiting first/);
  assert.match(t, /One reminder per person per 12 hours across all their watches; the full list of what you are holding comes by DM/);
  assert.match(dw.reminderText(watch('DW-Y', 'U9', 30, { reminders_sent: 2 }), 3, NOW), /reminder 3 of 3, after 7 days quiet/);
});

console.log(`\n${n} passed`);
