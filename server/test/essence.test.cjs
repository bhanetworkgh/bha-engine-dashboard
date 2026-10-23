/**
 * Essence markers (24 Oct 2026, 0LEW). Part 1 checks the shape rules and the quote match with no
 * database. Part 2 proposes, confirms, rejects and reads against a LOCAL database (localhost or
 * 127.0.0.1, name ending _test), with the Codex log and Slack stood in, and deletes what it wrote.
 * Run with:  npm run test:essence   (after the server build; part 2 needs DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const e = require(path.join(DIST, 'server/src', 'essence.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const KAVIN = 'U0BNQGG020Y';
const JASON = 'U0A9V97949F';
const LOG = 'CODEX-TEST-essence-1';
const TRANSCRIPT = 'So the joint kept cracking at the same place. When a number looks like a pattern, ask what shape makes that pattern before you change the design. That is what I did.';
const REAL = 'When a number looks like a pattern, ask what shape makes that pattern before you change the design.';
const PARAPHRASE = 'When a number looks like a pattern, ask what shape produces that pattern before you change the design.';
const LINK = 'https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792773102009109';
const BASE = { subject_id: KAVIN, kind: 'debugging_instinct', line: 'Reads a repeating number as a shape problem before redesigning.', quote: REAL, source_kind: 'codex_log', source_ref: LOG, proposed_by: 'U0AEW3TBYH1', test: true };
const refused = (input, reason) => assert.throws(() => e.check(input), (x) => { assert.equal(x.reason, reason, `expected ${reason}, got ${x.reason}: ${x.message}`); return true; });

const reader = (logs = {}, msgs = {}) => ({
  async codexLog(ref) { const l = logs[ref]; return l ? { found: true, entry_id: ref, ...l } : { found: false }; },
  async slackMessage(link) { const m = msgs[link]; return m ? { ok: true, ...m } : { ok: false, reason: 'not_found', message: 'no such message' }; },
});
const LOGS = { [LOG]: { builder: KAVIN, builder_name: 'Kavin', transcript: TRANSCRIPT }, 'CODEX-TEST-essence-2': { builder: KAVIN, builder_name: 'Kavin', transcript: 'Again: ' + REAL }, 'CODEX-TEST-essence-3': { builder: KAVIN, builder_name: 'Kavin', transcript: REAL + ' Third time.' }, 'CODEX-TEST-other': { builder: 'U0OTHER0001', builder_name: 'Other', transcript: TRANSCRIPT } };

(async () => {
  // ---------------------------------------------------------------- part 1, pure
  assert.equal(e.quoteIn(REAL, TRANSCRIPT), true);
  assert.equal(e.quoteIn(PARAPHRASE, TRANSCRIPT), false);
  assert.equal(e.quoteIn('WHEN a number  looks like a pattern, ask what shape makes that pattern', TRANSCRIPT), true);
  assert.equal(e.quoteIn('“when a number looks like a pattern”', TRANSCRIPT), true);
  assert.equal(e.quoteIn('short', TRANSCRIPT), false);
  ok('a quote matches word for word (case, curly quotes and spacing aside); a paraphrase does not');

  assert.equal(e.check(BASE).kind, 'debugging_instinct');
  refused({ ...BASE, subject_id: 'Kavin' }, 'subject_required');
  refused({ ...BASE, kind: 'task' }, 'unknown_kind');
  refused({ ...BASE, quote: '' }, 'quote_required');
  refused({ ...BASE, line: 'x'.repeat(300) }, 'line_too_long');
  refused({ ...BASE, source_kind: 'gossip' }, 'unknown_source_kind');
  refused({ ...BASE, source_kind: 'review', source_ref: 'CODEX-1' }, 'source_required');
  refused({ ...BASE, confidence: 2 }, 'bad_confidence');
  ok('shape: a Slack id, a kind from the list, a quote, one line, a known source and a Slack link for founder sources');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  await migrate();
  const clean = async () => {
    await query(`DELETE FROM engine_essence_markers WHERE test`);
    await query(`DELETE FROM engine_events WHERE event_type LIKE 'essence_marker_%' AND (detail->>'test') = 'true'`);
  };
  await clean();
  const R = reader(LOGS, { [LINK]: { user: JASON, text: 'Builder confirmation is mandatory. Nothing about a person is written into them without them.' } });
  const reason = async (p, want) => { await assert.rejects(p, (x) => { assert.equal(x.reason, want, `expected ${want}, got ${x.reason}: ${x.message}`); return true; }); };

  // ---------------------------------------------------------------- part 2, the quote check
  await reason(e.propose({ ...BASE, quote: PARAPHRASE }, { reader: R }), 'quote_not_found');
  await reason(e.propose({ ...BASE, source_ref: 'CODEX-TEST-other' }, { reader: R }), 'not_their_log');
  await reason(e.propose({ ...BASE, source_ref: 'CODEX-TEST-none' }, { reader: R }), 'source_not_found');
  await reason(e.propose({ ...BASE, subject_id: KAVIN, source_kind: 'review', source_ref: LINK, quote: 'Builder confirmation is mandatory.' }, { reader: R }), 'not_their_message');
  assert.equal((await query(`SELECT count(*)::int AS c FROM engine_essence_markers WHERE test`)).rows[0].c, 0);
  ok('no quote, no marker: a paraphrase, someone else\'s log or message, or a missing source writes nothing');

  const dry = await e.propose(BASE, { reader: R, dry_run: true });
  assert.equal(dry.outcome, 'would_propose');
  assert.equal((await query(`SELECT count(*)::int AS c FROM engine_essence_markers WHERE test`)).rows[0].c, 0);
  const p = await e.propose(BASE, { reader: R, via: 'test' });
  assert.equal(p.outcome, 'proposed');
  assert.equal(p.marker.status, 'proposed');
  assert.equal(p.marker.published, false);
  const again = await e.propose(BASE, { reader: R });
  assert.equal(again.outcome, 'already_held');
  ok('a real quote proposes one private marker; dry run writes nothing; the same source twice is one marker');

  let read = await e.read(KAVIN, { include_test: true });
  assert.equal(read.markers.length, 0);
  assert.equal(read.counts.proposed, 1);
  ok('a proposed marker is never read by a twin');

  const { decideEssenceMarker, readEssence, proposeEssenceMarker } = require(path.join(DIST, 'server/src/mcp', 'essenceTools.js'));
  const deps = { access: 'write', agent: null };
  let d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'confirm', requester_user_id: 'U0AEW3TBYH1' }, deps);
  assert.equal(d.reason, 'not_the_subject');
  d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'confirm', requester_user_id: KAVIN }, { access: 'write', agent: 'bays' });
  assert.equal(d.reason, 'agent_not_permitted');
  d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'publish', requester_user_id: KAVIN }, deps);
  assert.equal(d.reason, 'not_confirmed');
  ok('only the subject decides: not Destiny, not an agent, and nothing is shared before it is confirmed');

  d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'confirm', requester_user_id: KAVIN }, deps);
  assert.equal(d.ok, true);
  assert.equal(d.marker.status, 'confirmed');
  const r = await readEssence.handler({ who: KAVIN, include_test: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.markers.length, 1);
  assert.equal(r.markers[0].quote, REAL);
  assert.equal(r.markers[0].published, false);
  assert.ok(r.rules.some((x) => /private/.test(x)));
  ok('"That\'s me" makes it readable, quote and privacy rule with it, still private');

  await e.propose({ ...BASE, source_ref: 'CODEX-TEST-essence-2' }, { reader: R });
  const st = await e.propose({ ...BASE, source_ref: 'CODEX-TEST-essence-3' }, { reader: R });
  assert.equal(st.outcome, 'became_stable');
  assert.equal(st.marker.status, 'stable');
  assert.equal(st.marker.seen_in.length, 3);
  assert.equal((await query(`SELECT count(*)::int AS c FROM engine_essence_markers WHERE test`)).rows[0].c, 1);
  ok('the same line from two more logs is one marker, and it becomes stable at three sources');

  d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'publish', requester_user_id: KAVIN }, deps);
  assert.equal(d.marker.published, true);
  d = await decideEssenceMarker.handler({ marker_id: p.marker.marker_id, action: 'unpublish', requester_user_id: KAVIN }, deps);
  assert.equal(d.marker.published, false);
  ok('the subject can share a confirmed marker and take it back');

  const v = await proposeEssenceMarker.handler({ subject_id: KAVIN, kind: 'voice', line: 'Thinks out loud in short sentences.', quote: 'That is what I did.', source_kind: 'codex_log', source_ref: LOG, requester_user_id: 'U0AEW3TBYH1', test: true }, deps);
  assert.equal(v.ok, false); // 'That is what I did.' is 19 chars, but the tool cannot reach the stand-in log
  ok('the tool checks the real store; a log it cannot find is refused');

  const rej = await e.propose({ ...BASE, kind: 'standard', line: 'Will not ship a joint that cracks twice.' }, { reader: R });
  await e.decide({ marker_id: rej.marker.marker_id, action: 'reject', requester_user_id: KAVIN });
  await reason(e.propose({ ...BASE, kind: 'standard', line: 'Will not ship a joint that cracks twice.', source_ref: 'CODEX-TEST-essence-2' }, { reader: R }), 'previously_rejected');
  read = await e.read(KAVIN, { include_test: true });
  assert.equal(read.counts.rejected, 1);
  assert.ok(read.markers.every((m) => m.status !== 'rejected'));
  ok('"Not me" is never read and never proposed again');

  await e.propose({ ...BASE, kind: 'trade_off', line: 'Trades speed for one more check of the shape.' }, { reader: R });
  await e.propose({ ...BASE, kind: 'voice', line: 'Says what he did, plainly.' }, { reader: R });
  await reason(e.propose({ ...BASE, kind: 'decision_rule', line: 'Checks the shape first, every time.' }, { reader: R }), 'too_many_for_source');
  ok(`at most ${e.RULE.max_per_source} markers from one log (a rejected one does not count)`);

  const f = await e.propose({ subject_id: JASON, kind: 'standard', line: 'Nothing about a person goes in without them.', quote: 'Builder confirmation is mandatory.', source_kind: 'review', source_ref: LINK, proposed_by: 'U0AEW3TBYH1', test: true }, { reader: R });
  assert.equal(f.outcome, 'proposed');
  ok('a founder marker comes from the founder\'s own Slack message, checked the same way');

  const ev = await query(`SELECT event_type, count(*)::int AS c FROM engine_events WHERE event_type LIKE 'essence_marker_%' AND (detail->>'test') = 'true' GROUP BY 1`);
  const evs = Object.fromEntries(ev.rows.map((x) => [x.event_type, x.c]));
  assert.ok(evs.essence_marker_proposed >= 4 && evs.essence_marker_confirmed === 1 && evs.essence_marker_stable === 1 && evs.essence_marker_rejected === 1);
  ok('every change is one engine event');

  await clean();
  await closePool();
  console.log(`\n${n} checks passed`);
})().catch((x) => { console.error(x); process.exit(1); });
