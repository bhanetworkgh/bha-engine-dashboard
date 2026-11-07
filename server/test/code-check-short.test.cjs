/**
 * The short version of a code check (7 Nov 2026, Destiny — Jason's ask on Hardik's 7 Nov check). On Approve the
 * log's thread gets only this; the long version goes onto the Codex entry ('Code Check Full') and into BHARAG
 * (metadata code_check.full_text).
 *
 *   1. shortVersion is built from the check's own fields: verdict, readiness, every claim with its result, what is
 *      missing, what could not be checked, the pay call with each follow-up, the recommendation, and a link to the
 *      full check on the dashboard. It carries none of the long version's own sections.
 *   2. It fits one Slack message as rich text.
 *   3. A check with no claims or nothing missing says so rather than leaving a heading empty.
 *
 * No database and no network. Run with:  npm run test:code-check-short
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./_pg-stub.cjs');
  return realResolve.call(this, request, ...rest);
};
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const d = require(path.join(DIST, 'server/src', 'codeCheckDraft.js'));

let failed = 0;
const ok = (name, fn) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

const ID = 'CODEX-20261107-hardik-bhatt-honest-gate-evidence';
const check = {
  codex_entry_id: ID, verdict: 'partly', pay_call: 'as_logged', readiness: 'blocked_on_gate', gate: 'Stage 1 and Stage 2 (LOOP-1791428275782-TU4O)',
  verdict_reason: 'The log is honest that nothing was built or deployed, and the records I could open agree with it.',
  claims: [
    { claim: 'Production harvester execution picked row 139', where: 'get_n8n_workflow qnNZlzWAF1GXuxX3', result: 'partly', proof: 'Workflow is active, updated 6 Nov 04:53Z. I could not open the execution.' },
    { claim: 'Formal loop closure is not done', where: 'find_records loops', result: 'confirmed', proof: 'LOOP-1793976544109-LNJO is In Progress.' },
  ],
  missing: ['tested_for_real', 'written_down'],
  couldnt_check: 'The n8n execution itself and the Slack post.',
  follow_ups: [{ what: 'Reconcile the execution ID', who: 'Hardik Bhatt', by: '2026-11-10', loop_id: 'LOOP-1793976544109-LNJO' }],
  approve: 'yes', approve_why: 'It moves the evidence closer to formal acceptance.',
};
const draft = `*Code check: Hardik Bhatt, ${ID}, 7 Nov 2026*\n*Verdict:* Partly matches.\n*Readiness:* Does not pass yet and is blocked on Stage gate Stage 1 and Stage 2 (LOOP-1791428275782-TU4O).\n\n*In plain words, a real-world example*\nThink of a weekly summary.\n\n*1. What the log claims vs what's live*\n- long detail\n\n*3. What I couldn't check*\n- x\n\n*4. Pay call*\nPay as logged.`;

const short = d.shortVersion({ codex_entry_id: ID, builder: 'Hardik Bhatt', draft_text: draft, check });

ok('1. the short version carries every part Jason asked for, from the check itself', () => {
  for (const s of ['*Verdict:* Partly matches.', '*Readiness:* Does not pass yet and is blocked', '*What was checked*', '*Partly:* Production harvester', '*Confirmed:* Formal loop closure', 'LOOP-1793976544109-LNJO is In Progress', '*Still missing before customer ready*', '• Tested for real', '• Written down so someone else could run it', '*Could not check:* The n8n execution', '*Pay call:* Pay as logged.', 'Reconcile the execution ID, Hardik Bhatt, by 2026-11-10 (LOOP-1793976544109-LNJO)', '*Bays recommendation:* Approve: yes.', `/codex/${ID}|Full check on the dashboard>`]) {
    assert.ok(short.includes(s), `missing: ${s}\n---\n${short}`);
  }
  assert.ok(!short.includes('In plain words') && !short.includes('long detail') && !short.includes('get_n8n_workflow'), 'the long version leaked in');
});

ok('2. it renders as rich text in one message', () => {
  const b = d.threadBlocks(short);
  assert.ok(Array.isArray(b.blocks) && b.blocks.length > 0 && b.blocks.length <= 50);
});

ok('3. empty parts say so', () => {
  const s = d.shortVersion({ codex_entry_id: ID, builder: null, draft_text: '', check: { ...check, claims: [], missing: [], follow_ups: [], readiness: 'no_gate', approve: undefined } });
  assert.ok(s.includes('• No claims were recorded.') && s.includes('• Nothing named.') && s.includes('*Readiness:* No stage gate on this lane.') && !s.includes('Bays recommendation'));
});

console.log(short.split('\n').slice(0, 3).join('\n'));
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
