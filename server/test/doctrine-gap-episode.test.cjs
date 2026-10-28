/**
 * SE8L / YEAO, pure checks: research keys, gap episodes, the seven-day Research Twin rule, the fence
 * and the rolling restatement. Run with: npm run test:se8l-episode
 *
 * No database and no network. The store (doctrineEpisodes), the event log, the resolver and BHARAG
 * are stood in by assigning their exports, the way test:se8l does. What this cannot prove is the
 * database's half: the partial unique index, FOR UPDATE, the fence row lock against a real takeover.
 * Those are in doctrine-gap-episode.db.test.cjs and need a local _test Postgres.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const gap = require(path.join(DIST, 'server/src/doctrineGap.js'));
const store = require(path.join(DIST, 'server/src/doctrineEpisodes.js'));
const consumer = require(path.join(DIST, 'server/src/doctrineConsumer.js'));
const events = require(path.join(DIST, 'server/src/engineEvents.js'));
const pg = require(path.join(DIST, 'server/src/pg.js'));
const bharag = require(path.join(DIST, 'server/src/bharag.js'));
const systemFeeds = require(path.join(DIST, 'server/src/systemFeeds.js'));
const publicationDecision = require(path.join(DIST, 'server/src/publicationDecision.js'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const claim = (extra = {}) => ({
  doctrine_id: 'B93H', doctrine_version: 'v0.1', change_id: 'CHANGE-1', claim_id: 'CAP-1', label: 'Capability',
  maturity_state: 'PROVEN_NOW', claim_state: 'interest_only_live', config_hash: 'cfg-held',
  cad_provenance: { cad_revision: 'CAD-1', provenance_ref: 'OWLG:E-1' }, evidence_publication_status: 'PUBLISHABLE',
  fail_closed: { needs_evidence: false, reason: null }, allowed_use: { media_twin: true, vfarm: true, genie_ns: true },
  ...extra,
});
const publication = (extra = {}) => ({
  schema: 'vfam.claim_publication_decision.read.v1', event_name: 'VFAM.claim_publication_decision', doctrine_id: 'B93H', claim_id: 'CAP-1', surface: 'media_twin',
  decision: 'allowed', recorded_decision: 'allowed', applicable: true, reason: 'T0NO_GATE_CLEARED', decision_id: 'DEC-1', event_id: 1,
  decided_at: '2026-10-10T00:00:00.000Z', recorded_at: '2026-10-10T00:00:00.000Z', actor: 'Hardik', source_ref: 'VRFK', evidence_refs: [], doctrine_change_id: 'CHANGE-1',
  ...extra,
});
const t0noGap = (surface) => gap.classify({ surface, claim: claim({ fail_closed: { needs_evidence: true, reason: 'MISSING_RUNTIME_PROOF' } }), publication: null });
const staleGap = (surface) => gap.classify({ surface, claim: claim(), publication: publication({ surface, decision: 'needs_evidence', applicable: false, reason: 'STALE_PUBLICATION_DECISION' }) });
const pubGap = (surface) => gap.classify({ surface, claim: claim(), publication: publication({ surface, decision: 'needs_evidence', applicable: false, reason: 'NO_APPLICABLE_DECISION' }) });

/* ----------------------------------------------------------- research keys */
{
  const a = gap.researchKeyFor(t0noGap('media_twin'));
  const b = gap.researchKeyFor(t0noGap('vfarm'));
  assert.equal(a, 'doctrine-gap:B93H:CAP-1:t0no_needs_evidence');
  assert.equal(a, b);
  ok('a T0NO needs_evidence gap is one research question across surfaces: the claim lacks it whichever surface reads it');

  const sm = gap.researchKeyFor(staleGap('media_twin'));
  const sv = gap.researchKeyFor(staleGap('vfarm'));
  assert.equal(sm, 'doctrine-gap:B93H:CAP-1:stale_evidence:media_twin');
  assert.notEqual(sm, sv);
  assert.equal(gap.researchKeyFor(pubGap('media_twin')), 'doctrine-gap:B93H:CAP-1:publication_needs_evidence:media_twin');
  assert.notEqual(gap.researchKeyFor(pubGap('media_twin')), a, 'a publication gap and the claim\'s own gap are different questions');
  ok('stale_evidence and publication needs_evidence stay per surface: nothing says two surfaces lack the same thing');

  const other = gap.researchKeyFor(gap.classify({ surface: 'media_twin', claim: claim({ doctrine_id: 'TSNR', fail_closed: { needs_evidence: true, reason: 'X' } }), publication: null }));
  assert.equal(other, 'doctrine-gap:TSNR:CAP-1:t0no_needs_evidence', 'the same claim id under another doctrine is another question');
  ok('the same claim id under two doctrines is two questions');

  const resolver = gap.classify({ surface: gap.RESOLVER_SURFACE, resolver_error: { message: 'down' }, active_consumer: true });
  const unauthorized = gap.classify({ surface: 'genie_ns', resolver_error: { status: 403, message: 'no' } });
  const malformed = gap.classify({ surface: 'vfarm', claim: { doctrine_id: 'B93H' } });
  const contradiction = gap.classify({ surface: 'media_twin', claim: claim(), publication: publication({ decision: 'needs_evidence', recorded_decision: 'allowed', applicable: false, reason: 'PUBLICATION_DECISION_CONTRADICTS_CURRENT_T0NO' }) });
  const drill = gap.classify({ surface: 'media_twin', claim: claim({ doctrine_id: gap.DRILL_DOCTRINE_ID, fail_closed: { needs_evidence: true, reason: 'X' } }), publication: null });
  for (const o of [resolver, unauthorized, malformed, contradiction, drill]) assert.equal(gap.researchKeyFor(o), null, `${o.condition} must never be research`);
  ok('resolver outages, refused and malformed reads, contradictions and the drill have no research key, so they can never reach Research Twin');
}

/* ---------------------------------------------------------- episode steps */
const ep = (extra = {}) => ({
  episode_id: 'DGE-1', recovery_key: 'doctrine:media_twin:B93H:CAP-1', research_key: 'doctrine-gap:B93H:CAP-1:t0no_needs_evidence', condition: 'needs_evidence',
  first_sweep_seq: 1, last_sweep_seq: 10, started_at: iso(T0), last_confirmed_at: iso(T0 + 5 * MIN), confirmations: 2, continuity: 'verified', ended_at: null, end_reason: null,
  ...extra,
});
const sw = (seq, ms, dbMs = ms) => ({ seq, at: iso(ms), db_now: iso(dbMs) });
const KEY = 'doctrine-gap:B93H:CAP-1:t0no_needs_evidence';
{
  assert.deepEqual(gap.episodeStep(null, null, KEY, sw(1, T0)), { action: 'start', research_key: KEY, at: iso(T0), continuity: 'verified', note: null });
  assert.deepEqual(gap.episodeStep(null, null, null, sw(1, T0)), { action: 'none' });
  ok('a gap with no open episode starts one at the sweep\'s database time; a non-research reading starts nothing');

  assert.equal(gap.episodeStep(ep(), 10, KEY, sw(11, T0 + 10 * MIN)).action, 'confirm');
  assert.equal(gap.episodeStep(ep(), 10, KEY, sw(10, T0 + 10 * MIN)).action, 'replay');
  assert.equal(gap.episodeStep(ep(), 10, KEY, sw(9, T0 + 10 * MIN)).action, 'replay');
  assert.equal(gap.episodeStep(null, 10, KEY, sw(10, T0 + 10 * MIN)).action, 'replay', 'a replay after the episode ended does not start a new one');
  ok('a seq not above the highest the key has seen is a replay and changes nothing: a retried or taken-over sweep counts once, a new sweep always counts');

  const broken = gap.episodeStep(ep(), 10, KEY, sw(11, T0 + 5 * MIN + gap.CONTINUITY.max_confirmation_gap_minutes * MIN + 1));
  assert.equal(broken.action, 'end_then_start');
  assert.equal(broken.reason, 'continuity_broken');
  assert.equal(broken.continuity, 'verified');
  assert.equal(gap.episodeStep(ep(), 10, KEY, sw(11, T0 + 5 * MIN + gap.CONTINUITY.max_confirmation_gap_minutes * MIN)).action, 'confirm', 'exactly the limit still confirms');
  ok(`a gap between confirmations over ${gap.CONTINUITY.max_confirmation_gap_minutes} minutes (provisional, not Canon) ends the episode and starts a new one: the interruption never counts`);

  const back = gap.episodeStep(ep(), 10, KEY, sw(11, T0 + MIN));
  assert.deepEqual([back.action, back.reason, back.continuity], ['end_then_start', 'clock_doubt', 'unverified']);
  const ahead = gap.episodeStep(ep(), 10, KEY, sw(11, T0 + 10 * MIN, T0 + 8 * MIN));
  assert.deepEqual([ahead.action, ahead.reason, ahead.continuity], ['end_then_start', 'clock_doubt', 'unverified']);
  const bad = gap.episodeStep(null, null, KEY, { seq: 1, at: 'not a time', db_now: iso(T0) });
  assert.equal(bad.continuity, 'unverified');
  ok('a sweep time before the last confirmation, ahead of the database clock, or unreadable ends the episode as clock_doubt and starts one that is unverified for good');

  const changed = gap.episodeStep(ep(), 10, 'doctrine-gap:B93H:CAP-1:stale_evidence:media_twin', sw(11, T0 + 10 * MIN));
  assert.deepEqual([changed.action, changed.reason], ['end_then_start', 'condition_changed']);
  assert.deepEqual(gap.episodeStep(ep(), 10, null, sw(11, T0 + 10 * MIN)), { action: 'end', episode_id: 'DGE-1', reason: 'recovered', at: iso(T0 + 10 * MIN) });
  ok('a different gap ends the episode and starts another; a reading that is no gap ends it as recovered, so a reappearance is a new episode with a new clock');
}

/* ----------------------------------------------------------- eligibility */
{
  const noUse = { ok: true, verified_consumer: false, consumer: null, real_hits: 0, hit_refs: [], note: null };
  const used = { ok: true, verified_consumer: true, consumer: 'genie', real_hits: 1, hit_refs: ['9'], note: null };
  const long = ep({ last_confirmed_at: iso(T0 + 7 * DAY) });
  const now = T0 + 7 * DAY + 5 * MIN;
  assert.deepEqual(gap.eligibleForResearch(long, used, now), { eligible: true, refusals: [], gap_age_days: 7 });
  ok('seven confirmed days, a verified consumer and a real hit: eligible for one job');

  assert.deepEqual(gap.eligibleForResearch(long, noUse, now).refusals, ['no_verified_consumer', 'no_real_hit']);
  assert.deepEqual(gap.eligibleForResearch(long, { ...used, real_hits: 0 }, now).refusals, ['no_real_hit']);
  assert.deepEqual(gap.eligibleForResearch(long, { ok: false, error: 'db down' }, now).refusals, ['consumer_evidence_unreadable']);
  const young = ep({ last_confirmed_at: iso(T0 + 7 * DAY - MIN) });
  assert.deepEqual(gap.eligibleForResearch(young, used, T0 + 7 * DAY).refusals, ['gap_age_under_7_days']);
  ok('a missing consumer, a missing hit and unreadable evidence are each refused by name');

  assert.deepEqual(gap.eligibleForResearch(long, used, T0 + 9 * DAY).refusals, ['continuity_unverified'], 'nothing has confirmed it for two days');
  assert.ok(gap.eligibleForResearch(ep({ continuity: 'unverified', last_confirmed_at: iso(T0 + 7 * DAY) }), used, now).refusals.includes('continuity_unverified'));
  assert.ok(gap.eligibleForResearch(ep({ started_at: 'bad' }), used, now).refusals.includes('continuity_unverified'));
  assert.ok(gap.eligibleForResearch(ep({ ended_at: iso(now), last_confirmed_at: iso(T0 + 7 * DAY) }), used, now).refusals.includes('episode_ended'));
  ok('an episode nobody has confirmed lately, one on a doubtful clock, one with an unreadable start and one that ended are refused');

  const all = gap.eligibleForResearch(ep({ continuity: 'unverified' }), noUse, T0 + DAY);
  assert.deepEqual(all.refusals, ['continuity_unverified', 'gap_age_under_7_days', 'no_verified_consumer', 'no_real_hit']);
  ok('every failing condition is named at once, not only the first');

  // Age counts only confirmed time: an episode confirmed for 6 days and read 3 days later is 6, not 9.
  assert.equal(gap.eligibleForResearch(ep({ last_confirmed_at: iso(T0 + 6 * DAY) }), used, T0 + 6 * DAY + MIN).gap_age_days, 6);
  ok('gap age runs to the last confirmation, never to now');
}

/* ------------------------------------------------------- consumer evidence */
(async () => {
  {
    assert.deepEqual(consumer.VERIFIED_CONSUMER_WRITERS, []);
    assert.ok(Object.isFrozen(consumer.VERIFIED_CONSUMER_WRITERS));
    const realQuery = pg.query;
    let asked = 0;
    pg.query = async () => { asked++; return { rows: [{ id: '1', actor: 'x', inside: true }], rowCount: 1 }; };
    try {
      const ev = await consumer.consumerEvidence('B93H', 'CAP-1', iso(T0));
      assert.equal(ev.ok, true);
      assert.equal(ev.verified_consumer, false);
      assert.equal(ev.real_hits, 0);
      assert.match(ev.note, /fails closed/);
      assert.equal(asked, 0, 'with no authorized writer nothing is even read');
      ok('production fails closed: no authorized consumer-use writer, so no consumer and no hit, whatever the event log holds');

      let sql = '';
      let params = [];
      pg.query = async (q, p) => { sql = q; params = p; return { rows: [{ id: '5', actor: 'genie', inside: true }, { id: '2', actor: 'genie', inside: false }], rowCount: 2 }; };
      const ev2 = await consumer.consumerEvidence('B93H', 'CAP-1', iso(T0), ['genie']);
      assert.deepEqual([ev2.verified_consumer, ev2.real_hits, ev2.hit_refs, ev2.consumer], [true, 1, ['5'], 'genie']);
      assert.match(sql, /actor = ANY\(\$6::text\[\]\)/);
      assert.deepEqual(params[6], ['synthetic', 'fixture', 'test', 'drill']);
      assert.equal(params[0], 'doctrine_claim_used');
      assert.equal(params[1], 'doctrine.claim.use.v1');
      ok('with a writer a test names, only that writer\'s non-synthetic uses count, and only those inside the episode are hits');

      pg.query = async () => { throw new Error('relation missing'); };
      assert.deepEqual(await consumer.consumerEvidence('B93H', 'CAP-1', iso(T0), ['genie']), { ok: false, error: 'relation missing' });
      ok('a read that fails says so, and eligibility refuses it as unreadable');
    } finally {
      pg.query = realQuery;
    }
  }

  /* ------------------------------------------------------ observe, stood in */
  const real = { record: events.record, query: pg.query, liveIncidents: bharag.liveIncidents, openIncident: bharag.openIncident, error: console.error, log: console.log, store: { ...store }, doctrineClaims: systemFeeds.doctrineClaims, readDecisions: publicationDecision.readDecisions };
  const restore = () => {
    Object.assign(events, { record: real.record });
    Object.assign(pg, { query: real.query });
    Object.assign(bharag, { liveIncidents: real.liveIncidents, openIncident: real.openIncident });
    Object.assign(store, real.store);
    Object.assign(systemFeeds, { doctrineClaims: real.doctrineClaims });
    Object.assign(publicationDecision, { readDecisions: real.readDecisions });
    console.error = real.error;
    console.log = real.log;
  };
  const SWEEP = { seq: 41, token: 'tok', version: 1, at: '2026-10-27T00:00:00.000Z', resumed: false };
  const base = () => {
    const calls = { recorded: [], applied: [], restated: 0, opened: [], claims: 0, fenced: 0 };
    events.record = async (e) => { calls.recorded.push(e); return { recorded: true, id: calls.recorded.length }; };
    pg.query = async () => ({ rows: [], rowCount: 0 });
    store.readAlarm = async () => null;
    store.fenced = async (_s, fn) => { calls.fenced++; return fn({ query: async () => ({ rows: [], rowCount: 0 }) }, '2026-10-27T00:00:00.000Z'); };
    store.readEpisode = async () => ({ open: null, maxSeq: null });
    store.applyEpisode = async (_db, step) => { calls.applied.push(step); return { episode_id: step.action === 'start' ? 'DGE-NEW' : null, changed: step.action !== 'none' }; };
    store.claimAlarmOpen = async () => { calls.claims++; return 'claim'; };
    store.recordAlarmOpen = async () => true;
    store.releaseAlarmClaim = async () => undefined;
    store.takeRestatement = async () => { calls.restated++; return null; };
    bharag.liveIncidents = async () => [];
    bharag.openIncident = async (_lane, body) => { calls.opened.push(body); return { id: 'INC-1', raw: {} }; };
    console.error = () => undefined;
    return calls;
  };
  try {
    {
      const calls = base();
      const r = await gap.observe({ surface: 'media_twin', claim: claim({ fail_closed: { needs_evidence: true, reason: 'MISSING_RUNTIME_PROOF' } }), publication: null }, SWEEP);
      assert.equal(r.observation.observation_id, (await gap.observe({ surface: 'media_twin', claim: claim({ fail_closed: { needs_evidence: true, reason: 'MISSING_RUNTIME_PROOF' } }), publication: null }, SWEEP)).observation.observation_id);
      assert.equal(calls.recorded[0].dedupe_key, calls.recorded[1].dedupe_key, 'the same reading in the same sweep is the same event');
      assert.equal(r.observation.sweep_seq, 41);
      assert.equal(r.research_key, 'doctrine-gap:B93H:CAP-1:t0no_needs_evidence');
      assert.equal(calls.applied[0].action, 'start');
      assert.equal(r.incident.action, 'none');
      assert.equal(calls.claims, 0, 'needs_evidence never claims an incident');
      ok('a reading\'s identity is its key and its sweep\'s seq, never its time: a replay is the same event; a gap starts its episode and opens no incident');
    }
    {
      const calls = base();
      const r = await gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP);
      assert.equal(r.incident.action, 'opened');
      assert.equal(calls.opened.length, 1);
      assert.equal(calls.opened[0].payload.research_needed, false);
      assert.equal(calls.opened[0].subsystem, 'DOCTRINE');
      assert.equal(r.research_key, null);
      ok('an operational doctrine incident is opened with research_needed false, so T4 has nothing to read from it (SOP dc89a498)');
    }
    {
      const calls = base();
      store.claimAlarmOpen = async () => { calls.claims++; return null; };
      const r = await gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP);
      assert.equal(r.incident.action, 'claimed_elsewhere');
      assert.equal(calls.opened.length, 0);
      ok('a worker that loses the alarm claim never calls BHARAG');
    }
    {
      const calls = base();
      store.fenced = async () => { calls.fenced++; throw new store.FencedError(41); };
      await assert.rejects(gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP), store.FencedError);
      assert.equal(calls.opened.length, 0);
      assert.equal(calls.claims, 0);
      assert.equal(calls.applied.length, 0);
      ok('a fenced worker stops at its first write: no episode change, no claim, no BHARAG call');
    }
    {
      const calls = base();
      let fencedAt = -1;
      store.readAlarm = async () => ({ recovery_key: 'k', state: 'open', ledger_id: 'INC-9', opened_at: null, last_restated_at: null, restatements: 0 });
      // An identical unhealthy reading on an open alarm: nothing written, so the restatement slot is asked for.
      pg.query = async (q) => (/ORDER BY at DESC, id DESC LIMIT 1/.test(q) ? { rows: [{ event_type: 'doctrine_gap_observed', detail: gap.classify({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }) }], rowCount: 1 } : { rows: [], rowCount: 0 });
      store.takeRestatement = async () => { calls.restated++; fencedAt = calls.fenced; return { ledger_id: 'INC-9', n: 3 }; };
      const r = await gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP);
      assert.equal(r.written, false);
      assert.equal(calls.restated, 1);
      assert.ok(fencedAt >= 1, 'the restatement slot is taken inside the fenced transaction');
      assert.equal(r.write_reason, 'incident_restatement');
      const ev = calls.recorded.find((e) => e.dedupe_key.startsWith('doctrine_gap_observed:restate:'));
      assert.equal(ev.dedupe_key, 'doctrine_gap_observed:restate:INC-9:3');
      assert.equal(ev.detail.ledger_id, 'INC-9');
      assert.equal(ev.detail.write_reason, 'incident_restatement');
      ok('an open incident\'s restatement carries its ledger id, is keyed on the restatement count, and is taken in the same fenced transaction');

      const again = base();
      again.recorded.length = 0;
      store.readAlarm = async () => ({ recovery_key: 'k', state: 'open', ledger_id: 'INC-9', opened_at: null, last_restated_at: null, restatements: 3 });
      pg.query = async (q) => (/ORDER BY at DESC, id DESC LIMIT 1/.test(q) ? { rows: [{ event_type: 'doctrine_gap_observed', detail: gap.classify({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }) }], rowCount: 1 } : { rows: [], rowCount: 0 });
      store.takeRestatement = async () => null;
      const r2 = await gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP);
      assert.equal(r2.restated, null);
      assert.equal(again.recorded.length, 0, 'not due: nothing at all is written');
      ok('when the alarm row says the last restatement is under 24 hours old, nothing is written');
    }
    {
      const calls = base();
      store.readAlarm = async () => ({ recovery_key: 'k', state: 'open', ledger_id: 'INC-9', opened_at: null, last_restated_at: null, restatements: 0 });
      const r = await gap.observe({ surface: 'genie_ns', resolver_error: { status: 401, message: 'unauthorized' } }, SWEEP);
      assert.equal(r.write_reason, 'first');
      assert.equal(calls.restated, 0, 'a written reading is not also a restatement');
      ok('a reading that is written is never also restated');
    }

    /* ---------------------------------------------------------- the sweep */
    {
      base();
      let read = 0;
      store.claimSweep = async () => ({ sweep: null, reason: 'another sweep is running and its owner is still heartbeating' });
      systemFeeds.doctrineClaims = async () => { read++; return { claims: [] }; };
      const lines = [];
      console.log = (l) => lines.push(String(l));
      const out = await gap.sweepCanonical();
      console.log = real.log;
      assert.deepEqual(out, []);
      assert.equal(read, 0);
      assert.match(lines.join('\n'), /sweep skipped: another sweep is running/);
      ok('a sweep that cannot be claimed reads nothing and writes nothing');
    }
    {
      const calls = base();
      let finished = 0;
      store.claimSweep = async () => ({ sweep: SWEEP, reason: null });
      store.finishSweep = async () => { finished++; return true; };
      systemFeeds.doctrineClaims = async () => ({ claims: [claim(), claim({ claim_id: 'CAP-2' })] });
      publicationDecision.readDecisions = async (claims) => ({ decisions: claims.map(() => publication()) });
      let n = 0;
      store.fenced = async (_s, fn) => { if (++n === 2) throw new store.FencedError(41); return fn({ query: async () => ({ rows: [], rowCount: 0 }) }, SWEEP.at); };
      const errors = [];
      console.error = (l) => errors.push(String(l));
      const out = await gap.sweepCanonical();
      assert.equal(out.length, 1, 'stopped at the reading whose write was fenced');
      assert.equal(finished, 0, 'a fenced sweep does not finish');
      assert.equal(calls.recorded.filter((e) => /RESOLVER/.test(e.subject_id)).length, 0, 'losing the fence is never recorded as a resolver failure');
      assert.match(errors.join('\n'), /no longer owned by this worker; .*stopped after 1 of/);
      ok('a sweep that loses its fence stops where it is, does not finish, and is not mistaken for a resolver failure');
    }
    {
      base();
      store.claimSweep = async () => ({ sweep: SWEEP, reason: null });
      store.finishSweep = async () => true;
      systemFeeds.doctrineClaims = async () => ({ claims: [claim()] });
      publicationDecision.readDecisions = async (claims) => ({ decisions: claims.map(() => publication()) });
      store.applyEpisode = async () => { throw new Error('connection reset'); };
      await assert.rejects(gap.sweepCanonical(), /connection reset/);
      ok('a database failure while recording is thrown, not filed as a resolver outage; the sweep stays running and is taken over under the same seq');
    }
    {
      const calls = base();
      let finished = null;
      store.claimSweep = async () => ({ sweep: SWEEP, reason: null });
      store.finishSweep = async (_s, totals) => { finished = totals; return true; };
      systemFeeds.doctrineClaims = async () => { throw new Error('resolver timed out'); };
      const out = await gap.sweepCanonical();
      assert.equal(out.length, 1);
      assert.equal(out[0].observation.condition, 'resolver_unavailable');
      assert.equal(out[0].research_key, null);
      assert.deepEqual(finished, { keys: 1, claims_read: null, resolver_error: 'resolver timed out' });
      assert.equal(calls.applied[0].action, 'none', 'a resolver outage starts no research episode');
      ok('a resolver outage is one operational reading with no research key, and the sweep records the error');
    }
  } finally {
    restore();
  }
  console.log(`\n${passed} SE8L episode checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
