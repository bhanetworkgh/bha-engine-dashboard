/**
 * The record check (21 Nov 2026, Destiny): what the dashboard holds for the ids a file names.
 *
 * No database and no network: `pg.js` is replaced in the require cache by a small stand-in holding the
 * records of the case that led to this (Ahad's evidence report of 21 Nov). What is pinned:
 *
 *   - an id's kind is read from its shape, and a shape this check does not read is "not checked", never missing;
 *   - a loop on record comes back with what it is, its status and its owner;
 *   - a Decision Watch that does not exist is on_record false, with the real watch whose ending matches;
 *   - a loop under the wrong id is on_record false, with the real loop whose ending matches;
 *   - an incident comes back closed with who closed it; one not held says it is not in the dashboard's copy;
 *   - a Codex id cut short is on_record false, with the entry that starts the same way;
 *   - ids are trimmed, taken once, and capped at 60 with the rest counted.
 *
 * Run with:  npm run test:record-check
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

const LOOPS = [
  { natural_id: 'LOOP-1793917459843-K9VT', what: 'Slack app A0CF23GMNHJ identified and renamed', status: 'Closed', lane: 'CST', builder_id: 'ahad', closed_why: null, latest_note: 'Accepted by Jason Bays (9 Nov 2026)', copies: 1 },
  { natural_id: 'LOOP-1790985133890-XKWD', what: 'Fix the live transcript persistence failure', status: 'Closed', lane: 'CST', builder_id: 'ahad', closed_why: null, latest_note: null, copies: 1 },
];
const WATCHES = [{ watch_id: 'DW-1793406530806-QJY3', decision: 'Ahad owes a log to loop mapping', status: 'answered', owner_name: 'Ahad', owner_user_id: 'U0AC6RFNP3P', lane: 'CST', close_reason: 'answered', record_id: null, next_step: null }];
const INCIDENTS = [{ natural_id: 'INC-RESEARCHTWIN.RESEARCHJOB-045', summary: 'Research Twin — Front Door / Raise Refused Ask failing', ledger: 'manually_resolved', severity: 'high', subsystem: 'RESEARCHJOB', first_seen: '2026-11-21T06:13:08.144Z', resolved_at: '2026-11-21T07:39:56.488Z', resolved_by: 'mcp:write (U0AEW3TBYH1)', test_reason: null }];
const CODEX = [{ id: 'CODEX-20261113-destiny-arupi-genie-cutover-readback-fix', builder: 'Destiny Arupi', status: 'Approved', what: 'Genie cutover read-back fix', at: '2026-11-13T10:00:00Z', row_id: 512 }];

const tail = (id) => id.slice(id.lastIndexOf('-') + 1);
async function query(sql, params = []) {
  const p0 = params[0];
  let rows = [];
  if (/FROM engine_loops WHERE natural_id = ANY/.test(sql)) rows = LOOPS.filter((x) => p0.includes(x.natural_id));
  else if (/FROM engine_loops WHERE right\(natural_id, 4\)/.test(sql)) rows = LOOPS.filter((x) => p0.includes(tail(x.natural_id))).map((x) => ({ ...x, tail: tail(x.natural_id) }));
  else if (/FROM engine_decision_watches WHERE watch_id = ANY/.test(sql)) rows = WATCHES.filter((x) => p0.includes(x.watch_id));
  else if (/FROM engine_decision_watches WHERE right\(watch_id, 4\)/.test(sql)) rows = WATCHES.filter((x) => p0.includes(tail(x.watch_id))).map((x) => ({ ...x, tail: tail(x.watch_id) }));
  else if (/FROM engine_incidents/.test(sql)) rows = INCIDENTS.filter((x) => p0.includes(x.natural_id));
  else if (/engine_codex_submissions WHERE fields->>'Codex Entry ID' = ANY/.test(sql)) rows = CODEX.filter((x) => p0.includes(x.id));
  else if (/engine_codex_submissions WHERE fields->>'Codex Entry ID' <> ''/.test(sql)) rows = CODEX.filter((x) => x.id.startsWith(p0) || p0.startsWith(x.id));
  return { rows, rowCount: rows.length };
}
require.cache[require.resolve(path.join(DIST, 'server/src/pg.js'))] = { exports: { query, withTransaction: async (fn) => fn({ query }), afterCommit: () => {} } };

const rc = require(path.join(DIST, 'server/src/recordCheck.js'));

(async () => {
  assert.equal(rc.kindOfId('LOOP-1793917459843-K9VT'), 'loop');
  assert.equal(rc.kindOfId('DW-1789623401234-QJY3'), 'decision_watch');
  assert.equal(rc.kindOfId('INC-BAYS.AGENT-042'), 'incident');
  assert.equal(rc.kindOfId('CODEX-20261113-destiny-arupi-genie-cutover-readback-fix'), 'codex');
  assert.equal(rc.kindOfId('EV-1793991062901-4CJK'), 'evidence');
  assert.equal(rc.kindOfId('BP-INFRA-002'), 'pattern');
  assert.equal(rc.kindOfId('K9VT'), 'short');
  assert.equal(rc.kindOfId('JSON'), 'short');
  assert.equal(rc.kindOfId('2026'), null);
  assert.equal(rc.kindOfId('GAP-1795251553077-G5O7'), null);
  ok('an id’s kind is read from its shape');

  const many = Array.from({ length: 70 }, (_, i) => `LOOP-17900000000${String(i).padStart(2, '0')}-AAAA`);
  const cleaned = rc.cleanIds([' LOOP-1793917459843-K9VT. ', 'LOOP-1793917459843-K9VT', 42, '', ...many]);
  assert.equal(cleaned.ids[0], 'LOOP-1793917459843-K9VT');
  assert.equal(cleaned.ids.length, 60);
  assert.equal(cleaned.dropped, 11);
  ok('ids are trimmed, taken once and capped at 60, the rest counted');

  const out = await rc.check([
    'LOOP-1793917459843-K9VT',
    'DW-1789623401234-QJY3',
    'LOOP-1790000000000-XKWD',
    'INC-RESEARCHTWIN.RESEARCHJOB-045',
    'INC-BAYS.AGENT-999',
    'CODEX-20261113-destiny-arupi-genie',
    'GAP-1795251553077-G5O7',
  ]);
  const by = Object.fromEntries(out.records.map((x) => [x.id, x]));
  assert.equal(out.ok, true);
  assert.deepEqual(out.records.map((x) => x.id)[0], 'LOOP-1793917459843-K9VT');

  const k9 = by['LOOP-1793917459843-K9VT'];
  assert.equal(k9.on_record, true);
  assert.equal(k9.status, 'Closed');
  assert.equal(k9.owner, 'ahad');
  assert.match(k9.detail, /Accepted by Jason Bays/);
  ok('a loop on record comes back with its status, owner and latest note');

  const dw = by['DW-1789623401234-QJY3'];
  assert.equal(dw.on_record, false);
  assert.equal(dw.closest[0].id, 'DW-1793406530806-QJY3');
  assert.equal(dw.closest[0].owner, 'Ahad');
  ok('a watch that does not exist is not on record, with the real watch that ends the same way');

  const xk = by['LOOP-1790000000000-XKWD'];
  assert.equal(xk.on_record, false);
  assert.equal(xk.closest[0].id, 'LOOP-1790985133890-XKWD');
  ok('a loop under the wrong id is not on record, with the real loop that ends the same way');

  const inc = by['INC-RESEARCHTWIN.RESEARCHJOB-045'];
  assert.equal(inc.on_record, true);
  assert.equal(inc.status, 'closed (manually_resolved)');
  assert.match(inc.detail, /Closed by: mcp:write/);
  assert.equal(by['INC-BAYS.AGENT-999'].on_record, false);
  assert.match(by['INC-BAYS.AGENT-999'].note, /copy of the incident ledger/);
  ok('an incident comes back closed with who closed it; one not held says whose copy was read');

  const cx = by['CODEX-20261113-destiny-arupi-genie'];
  assert.equal(cx.on_record, false);
  assert.equal(cx.closest[0].id, 'CODEX-20261113-destiny-arupi-genie-cutover-readback-fix');
  ok('a Codex id cut short is not on record, with the entry that starts the same way');

  const gap = by['GAP-1795251553077-G5O7'];
  assert.equal(gap.on_record, null);
  assert.deepEqual(out.not_checked, ['GAP-1795251553077-G5O7']);
  assert.deepEqual(out.not_on_record, ['DW-1789623401234-QJY3', 'LOOP-1790000000000-XKWD', 'INC-BAYS.AGENT-999', 'CODEX-20261113-destiny-arupi-genie']);
  assert.equal(out.checked, 6);
  assert.equal(out.on_record, 2);
  ok('an id of a kind this check does not read is not checked, never missing');

  console.log(`\nrecord check: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
