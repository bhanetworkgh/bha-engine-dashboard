/**
 * The intent check on Bays' writes (13 Nov 2026, Destiny; SOPs 4c413e97, 05ccd8ab): the pure parts.
 * The model call and the Slack read are proved live on Bays' token; this pins the parsing, the
 * refusal for a missing ask, which tools are covered and what Bays is shown.
 * Run with: npm run test:intent-check
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ic = require(path.join(DIST, 'server/src/intentCheck'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

(async () => {
  assert.deepEqual(ic.parseVerdict('{"match": false, "reason": "wrong loop", "asked": "close 6I62"}'), { match: false, reason: 'wrong loop', asked: 'close 6I62' }); ok('a bare JSON verdict is read');
  assert.equal(ic.parseVerdict('Sure.\n```json\n{"match": true, "reason": "x", "asked": "y"}\n```').match, true); ok('a fenced verdict is read');
  assert.equal(ic.parseVerdict('I think it matches.'), null); ok('prose is never read as a verdict');
  assert.equal(ic.parseVerdict('{"match": "yes"}'), null); ok('a verdict whose match is not a boolean is refused');

  const tasks = ['Log review nudge -- Jason (every 6h)', 'Morning digest', 'Weekly sweep (Mon)', 'Weekly sweep (Fri)'];
  assert.equal(ic.matchTask(tasks, 'Log review nudge -- Jason'), tasks[0]); ok('a task named without its "(every 6h)" note is found (the 13 Nov 18:00 refusal)');
  assert.equal(ic.matchTask(tasks, 'log review nudge — jason'), tasks[0]); ok('case and dash style do not count');
  assert.equal(ic.matchTask(tasks, 'Morning digest'), tasks[1]); ok('an exact name still matches');
  assert.equal(ic.matchTask(tasks, 'Weekly sweep'), null); ok('a name that fits two tasks matches neither');
  assert.equal(ic.matchTask(tasks, 'Log review nudge -- Hardik'), null); ok('a different task is still refused');

  assert.equal(ic.uncheckedCrosses(2), false); assert.equal(ic.uncheckedCrosses(3), true); ok('the third unchecked pass in an hour opens the incident');

  for (const t of ['update_record', 'create_record', 'archive_record', 'move_loop', 'open_decision_watch', 'close_decision_watch', 'send_nudge', 'edit_sop']) assert.ok(ic.CHECKED.includes(t), t);
  ok('loop moves, watch openings and closes, nudges and SOP edits are all checked');
  assert.ok(ic.CHECKED_AGENTS.has('bays') && !ic.CHECKED_AGENTS.has('research_twin')); ok('only Bays is checked');

  assert.equal(await ic.describe('update_record', { kind: 'patterns', fields: {} }), null); ok('a write to another kind is not checked');
  assert.equal(await ic.describe('create_record', { kind: 'loops', fields: { What: 'x' }, dry_run: true }), null); ok('a dry run is not checked');
  const nudge = await ic.describe('send_nudge', { recipients: ['U0AEW3TBYH1'], text: 'Is the summary broken?', cc: 'U0A9V97949F' });
  assert.match(nudge, /Destiny/); assert.match(nudge, /Jason/); assert.match(nudge, /Is the summary broken\?/); ok('a nudge is described by who it goes to and what it says');
  const long = 'Adding one more layer. '.repeat(120);
  const word = await ic.describe('send_nudge', { recipients: ['U0AEW3TBYH1'], text: long });
  assert.ok(word.includes(long.trim()), 'a 2,760-character DM is shown whole'); assert.ok(!word.includes('…')); ok('a word-for-word DM under 6,000 characters is shown to the check whole, never with "…" (INC-BAYS.AGENT-112, -113)');
  const huge = 'x'.repeat(7000);
  { const v = ic.shown('<@U0AEW3TBYH1>, Jason asked me to nudge you. cc <@U0AF011R821|Jegan>', 6000);
    assert.match(v, /<@U0AEW3TBYH1> \(Destiny Arupi\)/); assert.match(v, /<@U0AF011R821\|Jegan> \(Jegan\)/);
    ok('a tagged id in the text carries its name, so the check knows <@U0AEW3TBYH1> is Destiny (INC-BAYS.AGENT-134, -135)'); }
  assert.match(ic.shown(huge, 6000), /shortened for the check: the full text is 7000 characters and is sent whole/); ok('a longer one says it is shortened and sent whole');
  assert.match(ic.SYSTEM, /as it stands now, before this action/); assert.match(ic.SYSTEM, /never call it cut off/); ok('the check is told what is context and what is shortened');
  const add = await ic.describe('update_decision_watch', { watch_id: 'DW-1', next_step: 'Pilot 1 v1.0 spec' });
  assert.match(add, /gains, below everything it holds now \(which stays word for word\)/); ok('a watch next step is shown as added, not replaced (the OWYM refusal, check 438)');
  const rep = await ic.describe('update_decision_watch', { watch_id: 'DW-1', next_step: 'x', replace: true });
  assert.match(rep, /replaced with/); ok('replace: true is shown as a replace');
  const watch = await ic.describe('open_decision_watch', { owner_user_id: 'U0BKT6MAW2Y', decision: 'Update 6I62 with PR #24 state' });
  assert.match(watch, /Hardik/); assert.match(watch, /6I62/); ok('a watch is described by its owner and what they owe');

  assert.match(ic.fieldChanges({ What: 'x' }, { 'Progress Note': 'pointer' }), /Progress Note \(empty now\) -> "pointer"/);
  assert.match(ic.fieldChanges({ 'Progress Note': 'old line' }, { 'Progress Note': 'new' }), /now "old line"/);
  assert.match(ic.fieldChanges(null, { Status: null }), /current value not read\) -> removed/);
  {
    const old = '13 Nov (Jegan) -- Round 1 evidence record.\n\n21 Oct: Stopped the stuck RDS.';
    const desc = ic.fieldChanges({ 'Progress Note': old }, { 'Progress Note': '16 Nov (Jegan) -- Round 1 revision.\n\n' + old });
    assert.match(desc, /keeps all of it word for word and adds, above it: "16 Nov \(Jegan\) -- Round 1 revision\."/);
    assert.doesNotMatch(desc, /13 Nov/);
    assert.equal(ic.addedText(old, old + '\n\n17 Nov: more.').where, 'below it');
    assert.equal(ic.addedText(old, 'new text only'), null);
    assert.equal(ic.addedText(old, old.replace('stuck', 'hung') + ' extra'), null);
  }
  assert.match(ic.SYSTEM, /setting a field that is empty now adds to it/); ok('each field set shows what it holds now, so an append into an empty field reads as an append (INC-BAYS.AGENT-097)');
  const r = await ic.resolveAsk('update_record', { kind: 'loops', fields: {} });
  assert.equal(r.ok, false); assert.equal(r.reason, 'ask_required'); assert.match(r.message, /Nothing was written/); assert.match(r.message, /message_ts/);
  ok('a loop change with no ask is refused and told exactly what to send');
  const stated = await ic.resolveAsk('send_nudge', { ask: { text: 'nudge Destiny about the summary' } });
  assert.equal(stated.ok, true); assert.equal(stated.ask.source, 'agent_stated'); assert.match(stated.ask.key, /^text:/); ok('a non-Slack ask is taken as stated and marked so');

  const p = ic.prompt({ key: 'k', source: 'slack', text: 'Jason: close 6I62', context: '- Hardik: done', asker: null }, 'Close loop X', 'archive_record');
  assert.match(p, /The message that asked:/); assert.match(p, /for context only/); assert.match(p, /archive_record/); ok('the model is given the ask, the thread and the action');
  assert.equal(ic.ASK_PROPERTY.additionalProperties, false); assert.ok(ic.ASK_PROPERTY.properties.message_ts); ok('Bays is shown the ask argument with its shape');
  assert.deepEqual(ic.parseAnswer('{"answers": false, "reason": "says no request"}'), { answers: false, reason: 'says no request' }); ok('a reply verdict is read');
  const none = await ic.answerCheck({ ask: 'summarize this log', reply: "I don't have a new request in this turn, so there's nothing new to act on." });
  assert.equal(none.answers, false); assert.equal(none.checked, 'phrase'); ok('a "no new request" reply is a non-answer without asking a model');
  const empty = await ic.answerCheck({ ask: 'x', reply: '' });
  assert.equal(empty.answers, false); ok('an empty reply is a non-answer');
  assert.deepEqual(ic.parseCloses('{"loops":[{"loop_id":"LOOP-1","backed":false,"reason":"only planned"}]}'), [{ loop_id: 'LOOP-1', backed: false, reason: 'only planned' }]); ok('a loop close verdict is read');
  const nothing = await ic.loopCloseCheck({ closes: [], log: 'x' });
  assert.equal(nothing.checked, 'nothing_to_check'); assert.deepEqual(nothing.held, []); ok('a log that closes nothing is not checked');
  const nolog = await ic.loopCloseCheck({ closes: [{ loop_id: 'LOOP-1', what: 'x', evidence: 'y' }], log: '' });
  assert.equal(nolog.checked, 'unchecked'); assert.deepEqual(nolog.kept, ['LOOP-1']); ok('a close check with no log holds nothing back and says so');
  const noNote = await ic.rewriteCheck({ rewrites: [{ platform: 'x', note: '', old: 'a', new: 'b' }] });
  assert.equal(noNote.checked, 'nothing_to_check'); assert.deepEqual(noNote.missed, []); ok('a rewrite with no note to answer is not checked');
  const lines = ic.recordLines([{ natural_id: 'LOOP-1793620799001-3NBE', status: 'In Progress', lane: 'CST', builder_id: 'ahad', what: 'Sensor data still not reading on the burn-in cabinet' }]);
  assert.match(lines, /LOOP-1793620799001-3NBE: status In Progress, lane CST, owner ahad\. What: Sensor data still not reading/); ok('a named loop is shown with its title, status, lane and owner');
  const withRec = ic.prompt({ key: 'k', source: 'slack', text: 'notify jason and destiny about this loop', context: '', asker: null }, 'Send a DM about LOOP-1793620799001-3NBE (Sensor data still not reading)', 'send_nudge', lines);
  assert.match(withRec, /Records the action names, as the dashboard holds them/); assert.match(withRec, /burn-in cabinet/); ok('the model is given the records the action names (the 13 Nov audit 6314 refusal)');
  assert.doesNotMatch(ic.prompt({ key: 'k', source: 'slack', text: 'x', context: '', asker: null }, 'y', 'send_nudge'), /Records the action names/); ok('no records section when the action names none');
  assert.match(ic.SYSTEM, /A fact that matches a listed record/); assert.match(ic.SYSTEM, /neither the thread nor a listed record shows is a miss/); ok('a fact from a listed record is supported; an invented one is still a miss');
  assert.match(ic.SYSTEM, /Work the message puts on a person/); assert.match(ic.SYSTEM, /even when every fact in it is right/); ok('work Jason put on a builder (a DK0O A/B/C map) is a miss when an agent posts it for them (INC-BAYS.AGENT-137)');
  assert.deepEqual('nudge LOOP-1793620799001-3NBE and loop-1793620799001-3nbe'.match(ic.LOOP_IN_ACTION), ['LOOP-1793620799001-3NBE']); ok('loop ids are read from the action');
  console.log(`intent-check: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
