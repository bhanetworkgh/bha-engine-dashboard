/**
 * Logstream v0 (2026-10-10), pinned against a real local database and a Slack
 * stand-in.
 *
 * Part 1 replays history through the rule itself, with no database. The
 * fixture is every fault signature that fired more than once between 28 Aug
 * and 9 Oct 2026, with its real times (the 64 signatures that fired once can
 * never cross a threshold and are left out). It must reproduce the design
 * note's section 6a: three signatures reach 5 in 7 days, seven reach 3, and
 * two of the seven are a guard and the simulator, which the rule leaves out.
 *
 * Part 2 runs the writer and the trigger:
 *   - one observed row per incident, one closed row once it closes, and a
 *     second pass writes nothing;
 *   - 3 of one fault opens one Research Twin job, not three;
 *   - 5 of one fault also tells a person, once;
 *   - test, simulator and refused-ask incidents open nothing;
 *   - an alert Slack refuses is failed with the reason, and lands on the next pass;
 *   - the rate rule needs 10 runs and 3 failures;
 *   - five workflows crossing is one outage alert and no new research;
 *   - a closed incident gets one patterns_evaluated row, judged only from the record;
 *   - North Star is asked for guidance once, only when the research job resolves;
 *   - person_confirmed and autopay_enabled are false on every row.
 *
 * Run with:  npm run test:logstream   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

/* ---------------------------------------------------------------- part 1 */
const HISTORY = {
  'Bays — Builder Chasers|Assert Chaser Delivered': ['2026-09-29T15:00:44Z', '2026-09-29T17:00:46Z', '2026-09-29T19:00:44Z', '2026-09-29T21:00:43Z', '2026-09-29T23:00:41Z', '2026-09-30T01:00:44Z', '2026-09-30T03:00:44Z'],
  'post_response_incident_reporting|agent-orchestrator': ['2026-10-06T03:22:23Z', '2026-10-06T03:22:23Z', '2026-10-06T03:22:35Z', '2026-10-06T03:22:35Z', '2026-10-06T03:22:39Z'],
  'North Star — Front Door|Is Duplicate?': ['2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z'],
  'North Star — Conversational Agent|Read_Slack': ['2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z', '2026-09-22T08:00:57Z'],
  'Bays — Daily Doc Rotator|Create Daily Doc': ['2026-09-22T23:00:54Z', '2026-09-26T23:00:54Z', '2026-09-27T23:00:49Z'],
  'Bays — Front Door|Raise Refused Ask': ['2026-09-28T20:08:23Z', '2026-10-02T16:21:54Z', '2026-10-04T20:48:10Z'],
  'Engine — Monitoring Twin Simulator|Build Simulated Snapshot': ['2026-10-01T18:15:10Z', '2026-10-01T18:15:10Z', '2026-10-03T08:03:44Z'],
  'Research Twin — Agent Delivery|Raise If Anything Failed': ['2026-09-28T08:04:23Z', '2026-10-07T09:56:22Z', '2026-10-07T12:07:24Z'],
  'Bays — Scheduled Run Watch|Compare Against Schedule': ['2026-10-07T16:54:03Z', '2026-10-09T05:42:48Z'],
  'post_response_incident_reporting|bha_rag_ingest': ['2026-10-06T03:22:35Z', '2026-10-09T23:15:41Z'],
  'North Star — Conversational Agent|North Star Agent': ['2026-09-17T15:32:03Z', '2026-09-23T09:28:26Z'],
  'North Star — Front Door|North Star Agent': ['2026-09-17T15:32:03Z', '2026-09-23T09:28:24Z'],
};

function replay(logstream) {
  const all = [];
  for (const [sig, times] of Object.entries(HISTORY)) {
    const [workflow, node] = sig.split('|');
    times.forEach((t, n) => all.push({ incident_id: `${sig}#${n}`, lane_id: 'bays', workflow, node, tags: [], occurred_at: t }));
  }
  // The most a signature ever held in one rolling 7 days, with and without the exclusions.
  const peak = (useRule) => {
    const best = new Map();
    for (const end of all) {
      const to = Date.parse(end.occurred_at);
      const win = all.filter((i) => Date.parse(i.occurred_at) <= to && Date.parse(i.occurred_at) > to - 7 * 86_400_000);
      if (useRule) {
        for (const c of logstream.evaluate(win, []).filter((x) => x.kind === 'signature_research')) best.set(c.key, Math.max(best.get(c.key) ?? 0, c.n));
      } else {
        const n = win.filter((i) => i.workflow === end.workflow && i.node === end.node).length;
        const k = logstream.signatureOf(end.workflow, end.node);
        best.set(k, Math.max(best.get(k) ?? 0, n));
      }
    }
    return best;
  };
  const raw = peak(false);
  assert.equal([...raw.values()].filter((n) => n >= 5).length, 3, 'three signatures reached 5 in 7 days');
  assert.equal([...raw.values()].filter((n) => n >= 3).length, 7, 'seven reached 3 in 7 days');
  ok('history: 3 signatures reach 5 in 7 days and 7 reach 3, as the design note counted');
  const ruled = peak(true);
  assert.deepEqual([...ruled.keys()].sort(), ['Bays — Builder Chasers :: Assert Chaser Delivered', 'Bays — Daily Doc Rotator :: Create Daily Doc', 'North Star — Conversational Agent :: Read_Slack', 'North Star — Front Door :: Is Duplicate?', 'post_response_incident_reporting :: agent-orchestrator']);
  ok('history: with the guard and the simulator left out, the rule fires on the 5 real ones');

  assert.equal(logstream.excludedReason({ workflow: 'TEST — Self-healing, North Star lane', node: 'Shape Question' }), 'test');
  assert.equal(logstream.excludedReason({ workflow: 'Monitoring Twin (simulated farm)', node: 'x', tags: ['vfarm', 'simulated'] }), 'simulator');
  assert.equal(logstream.excludedReason({ workflow: 'Bays — Front Door', node: 'Raise Refused Ask' }), 'refused_ask');
  assert.equal(logstream.excludedReason({ workflow: 'Bays — Latest Digest', node: 'Read' }), null, '"Latest" is not a test');
  ok('exclusions: test, simulator and refused ask, and nothing else');

  const rate = (runs, failures) => logstream.evaluate([], [{ workflow_id: 'w', workflow: 'W', runs, failures }]).length;
  assert.equal(rate(19, 5), 1);
  assert.equal(rate(9, 5), 0, 'under 10 runs');
  assert.equal(rate(20, 2), 0, 'under 3 failures');
  assert.equal(rate(100, 19), 0, 'under 20%');
  assert.equal(rate(15, 3), 1, 'exactly 20% crosses');
  ok('rate rule: 20% with at least 10 runs and 3 failures');
}

/* ---------------------------------------------------------------- part 2 */
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:logstream writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const posts = [];
let refuse = false;
const slack = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (refuse) return res.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
    posts.push(body);
    res.end(JSON.stringify({ ok: true, channel: body.channel, ts: `17916${posts.length}.000100` }));
  });
});

const asks = [];
let hookAnswer = { code: 200, body: { ok: true } };
const hook = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    asks.push({ path: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
    res.writeHead(hookAnswer.code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hookAnswer.body));
  });
});

(async () => {
  const port = await new Promise((r) => slack.listen(0, '127.0.0.1', () => r(slack.address().port)));
  const hookPort = await new Promise((r) => hook.listen(0, '127.0.0.1', () => r(hook.address().port)));
  process.env.N8N_BASE_URL = `http://127.0.0.1:${hookPort}`;
  delete process.env.N8N_API_URL;
  process.env.DASHBOARD_INBOUND_KEY = 'inbound-test';
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}`;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
  process.env.QUOTA_ALERT_CHANNEL = 'C0ALERTS001';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  const logstream = req('logstream.js');
  replay(logstream);

  const { migrate } = req('migrations.js');
  const { query } = req('pg.js');
  await migrate();
  const T = Date.now();
  const WF = `LS Test Flow ${T}`;
  // A clean window: nothing else in this database may cross a threshold while the test runs.
  await query(`DELETE FROM engine_incidents WHERE natural_id LIKE 'INC-LSTEST-%'`);
  await query(`DELETE FROM engine_execution_runs WHERE workflow_id LIKE 'lstest-%'`);
  let seq = 0;
  const incident = async (workflow, node, { minsAgo = 60, tags = [], open = true } = {}) => {
    const id = `INC-LSTEST-${T}-${++seq}`;
    const at = new Date(Date.now() - minsAgo * 60_000).toISOString();
    await query(
      `INSERT INTO engine_incidents (natural_id, lane_id, fields, source, first_seen_at, updated_at, open_now, resolved_at, resolved_by)
       VALUES ($1, 'bays', $2::jsonb, 'engine', $3, $3, $4, $5, $6)`,
      [id, JSON.stringify({ entity_id: id, occurred_at: at, payload: { workflow_or_scenario: workflow, failed_node_or_component: node, error_class: 'UNKNOWN', impact_tags: tags } }), at, open, open ? null : new Date().toISOString(), open ? null : 'test'],
    );
    return id;
  };
  const triggers = async (key) => (await query(`SELECT kind, action_state, job_id, error, n, attempts FROM engine_logstream_triggers WHERE key LIKE $1 ORDER BY id`, [`%${key}%`])).rows;
  const jobs = async () => (await query(`SELECT natural_id, fields FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Logstream' AND fields->>'Question' LIKE $1`, [`%${T}%`])).rows;

  /* the writer */
  const a1 = await incident(WF, 'Step A', { minsAgo: 300 });
  const a2 = await incident(WF, 'Step A', { minsAgo: 200, open: false });
  let w = await logstream.sweep();
  const rows = (await query(`SELECT incident_id, state, signature, objective_outcomes, research_trigger, person_confirmed, autopay_enabled, excluded_reason FROM engine_logstream WHERE incident_id IN ($1, $2) ORDER BY id`, [a1, a2])).rows;
  assert.deepEqual(rows.map((r) => `${r.incident_id === a1 ? 'a1' : 'a2'}:${r.state}`).sort(), ['a1:observed', 'a2:closed', 'a2:observed', 'a2:patterns_evaluated']);
  assert.equal(rows.find((r) => r.incident_id === a2 && r.state === 'observed').objective_outcomes.incident_frequency_7d, 2);
  const closed = rows.find((r) => r.state === 'closed');
  assert.ok(closed.objective_outcomes.time_to_recovery_seconds > 0);
  assert.equal(closed.objective_outcomes.time_to_recovery_trusted, true);
  assert.ok(rows.every((r) => r.person_confirmed === false && r.autopay_enabled === false));
  assert.equal(rows[0].signature, `${WF} :: Step A`);
  assert.equal((await triggers(WF)).length, 0, 'two of a fault is not a pattern');
  ok('writer: one observed row per incident, a closed row with time to recovery, pay flags false');
  w = await logstream.sweep();
  assert.equal(w.rows_written, 0);
  ok('writer: a second pass writes nothing');

  /* three opens one job */
  const a3 = await incident(WF, 'Step A', { minsAgo: 100 });
  w = await logstream.sweep();
  let t = await triggers(`${WF} :: Step A`);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.action_state}`), ['signature_research:job_opened']);
  let j = await jobs();
  assert.equal(j.length, 1, 'one job for the pattern, not one per incident');
  assert.equal(j[0].fields.Status, 'Pending');
  assert.ok(j[0].fields.Context.includes(a1) && j[0].fields.Context.includes(a3));
  const opened = (await query(`SELECT research_trigger FROM engine_logstream WHERE incident_id = $1 AND state = 'research_opened'`, [a3])).rows[0];
  assert.equal(opened.research_trigger.rt_job_id, j[0].natural_id);
  assert.equal(posts.length, 0, 'three does not call a person');
  await logstream.sweep();
  assert.equal((await jobs()).length, 1, 'a repeat pass opens no second job');
  ok('trigger: 3 of one fault in 7 days opens one Research Twin job, once');

  /* five tells a person; a refused alert is failed, then lands */
  await incident(WF, 'Step A', { minsAgo: 50 });
  await incident(WF, 'Step A', { minsAgo: 40 });
  refuse = true;
  w = await logstream.sweep();
  t = await triggers(`${WF} :: Step A`);
  const esc = t.find((x) => x.kind === 'signature_escalation');
  assert.equal(esc.action_state, 'failed');
  assert.ok(esc.error.includes('not_in_channel'));
  assert.equal(w.failed, 1);
  refuse = false;
  await logstream.sweep();
  t = await triggers(`${WF} :: Step A`);
  assert.equal(t.find((x) => x.kind === 'signature_escalation').action_state, 'alerted');
  assert.equal(t.find((x) => x.kind === 'signature_research').n, 5, 'the pattern row follows the count');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C0ALERTS001');
  assert.ok(posts[0].text.includes('Step A') && posts[0].text.includes('5 times'));
  await logstream.sweep();
  assert.equal(posts.length, 1, 'told once');
  assert.equal((await jobs()).length, 1);
  ok('trigger: 5 tells a person once; an alert Slack refuses is failed with the reason and lands on the next pass');

  /* excluded incidents open nothing */
  for (let n = 0; n < 5; n++) await incident(`TEST — LS ${T}`, 'Step T');
  for (let n = 0; n < 5; n++) await incident(`${WF} sim`, 'Step S', { tags: ['simulated'] });
  for (let n = 0; n < 5; n++) await incident(`${WF} door`, 'Raise Refused Ask');
  await logstream.sweep();
  assert.equal((await triggers(`LS ${T}`)).length, 0);
  assert.equal((await triggers(`${WF} sim`)).length, 0);
  assert.equal((await triggers(`${WF} door`)).length, 0);
  const ex = (await query(`SELECT DISTINCT excluded_reason FROM engine_logstream WHERE incident_id LIKE $1 AND excluded_reason IS NOT NULL ORDER BY 1`, [`INC-LSTEST-${T}-%`])).rows.map((r) => r.excluded_reason);
  assert.deepEqual(ex, ['refused_ask', 'simulator', 'test']);
  ok('trigger: test, simulator and refused-ask incidents are written down and open nothing');

  /* the rate rule */
  let ex_id = 9_000_000_000_000 + (T % 1_000_000) * 1000;
  const run = async (wfId, name, n, failed) => {
    for (let k = 0; k < n; k++) {
      const at = new Date(Date.now() - 3_600_000).toISOString();
      await query(`INSERT INTO engine_execution_runs (execution_id, workflow_id, workflow_name, status, mode, day, started_at, first_seen_at, updated_at) VALUES ($1, $2, $3, $4, 'trigger', $5, $6, $6, $6)`, [++ex_id, wfId, name, k < failed ? 'error' : 'success', at.slice(0, 10), at]);
    }
  };
  await run(`lstest-${T}-r1`, `${WF} rate one`, 12, 4);
  await run(`lstest-${T}-r2`, `${WF} rate small`, 6, 6);
  await logstream.sweep();
  t = await triggers(`lstest-${T}-r`);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.action_state}`), ['workflow_rate:job_opened']);
  assert.equal((await jobs()).length, 2);
  ok('trigger: a workflow failing 4 of 12 opens one job; 6 of 6 is under the floor of 10 runs');

  /* a run that failed because a guard refused something is not a failure of the workflow */
  await run(`lstest-${T}-g1`, `${WF} guarded door`, 12, 4);
  const guardRuns = (await query(`SELECT execution_id::text AS id FROM engine_execution_runs WHERE workflow_id = $1 AND status = 'error' ORDER BY execution_id LIMIT 2`, [`lstest-${T}-g1`])).rows;
  for (const g of guardRuns) {
    const id = await incident(`${WF} guarded door`, 'Raise Refused Ask');
    await query(`UPDATE engine_incidents SET fields = jsonb_set(fields, '{payload,execution_id}', to_jsonb($2::text)) WHERE natural_id = $1`, [id, g.id]);
  }
  await logstream.sweep();
  assert.equal((await triggers(`lstest-${T}-g1`)).length, 0, '4 of 12 with two refusals is 2 of 10');
  ok('trigger: runs that failed on a refused ask are left out of the rate rule');

  /* five workflows at once is one outage */
  const before = (await jobs()).length;
  for (let n = 3; n <= 5; n++) await run(`lstest-${T}-o${n}`, `${WF} outage ${n}`, 10, 5);
  const p = posts.length;
  await logstream.sweep();
  const out = (await query(`SELECT action_state, n, workflows FROM engine_logstream_triggers WHERE kind = 'shared_outage' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(out.action_state, 'alerted');
  assert.ok(out.n >= 5);
  assert.equal(posts.length, p + 1);
  assert.ok(posts[p].text.includes('shared-cause outage'));
  t = await triggers(`lstest-${T}-o`);
  assert.ok(t.length === 3 && t.every((x) => x.action_state === 'suppressed_shared_outage'));
  assert.equal((await jobs()).length, before, 'no per-workflow research during an outage');
  ok('trigger: five workflows crossing is one outage alert and no new research');

  /* which pattern applied */
  const P = logstream.PATTERNS;
  const ev = (o) => logstream.evaluatePatterns({ excluded: null, resolved_at: '2026-10-09T10:00:00Z', resolved_by: null, close_reasoned: false, guarded_retries: 0, ...o });
  assert.equal(ev({ close_reasoned: true }).adherence[P.S757].result, 'followed');
  assert.equal(ev({ resolved_by: 'the ledger (closed upstream by the healer or a person)' }).adherence[P.S757].result, 'not_followed');
  assert.equal(ev({ resolved_by: 'admin@bhanetwork.org' }).adherence[P.S757].result, 'not_applicable', 'a close the record says too little about is not judged');
  assert.equal(ev({ close_reasoned: true, resolved_at: '2026-10-05T10:00:00Z' }).adherence[P.S757].result, 'not_applicable', 'before the protocol existed');
  assert.equal(ev({ close_reasoned: true, excluded: 'test' }).adherence[P.S757].result, 'not_applicable');
  assert.deepEqual(ev({ guarded_retries: 2, close_reasoned: true }).applied.sort(), [P.BW9S, P.S757].sort());
  assert.equal(ev({}).adherence[P.GRM8].result, 'not_applicable');
  const c1 = await incident(`${WF} close`, 'Step C', { open: false });
  const c2 = await incident(`${WF} close`, 'Step D', { open: false });
  await query(`UPDATE engine_incidents SET resolved_by = 'the ledger (closed upstream by the healer or a person)' WHERE natural_id = $1`, [c2]);
  await query(`INSERT INTO engine_mcp_writes (tool, arguments, digest, access, kind, dry_run, outcome, actor, target) VALUES ('close_incidents', $1::jsonb, 'x', 'write', 'incidents', false, 'applied', 'test', 'incidents')`, [JSON.stringify({ ids: [c1], reason: 'fixed, with evidence' })]);
  await query(`INSERT INTO engine_mcp_writes (tool, arguments, digest, access, kind, dry_run, outcome, actor, target) VALUES ('retry_incident', $1::jsonb, 'x', 'write', 'incidents', false, 'applied', 'test', 'incidents')`, [JSON.stringify({ incident_id: c1, reason: 'one guarded retry' })]);
  await logstream.sweep();
  const tagged = (await query(`SELECT incident_id, pattern_ids_applied, pattern_adherence FROM engine_logstream WHERE state = 'patterns_evaluated' AND incident_id IN ($1, $2)`, [c1, c2])).rows;
  const of = (id) => tagged.find((r) => r.incident_id === id);
  assert.deepEqual(of(c1).pattern_ids_applied.sort(), [P.BW9S, P.S757].sort());
  assert.equal(of(c1).pattern_adherence[P.S757].result, 'followed');
  assert.equal(of(c2).pattern_adherence[P.S757].result, 'not_followed');
  assert.deepEqual(of(c2).pattern_ids_applied, [P.S757]);
  ok('patterns: the closure protocol and the guarded retry are read from the record; anything unclear is not applicable');

  /* the guidance step */
  const job = (await jobs()).find((x) => x.fields.Question.includes('Step A'));
  await logstream.requestGuidance();
  assert.equal(asks.length, 0, 'North Star is not asked while the job is still pending');
  await query(`UPDATE engine_rt_jobs SET fields = fields || $2::jsonb WHERE natural_id = $1`, [job.natural_id, JSON.stringify({ Status: 'Resolved', Finding: 'The step times out when the upstream is cold.', Confidence: 'medium' })]);
  hookAnswer = { code: 500, body: { ok: false, error: 'north star said no' } };
  let g = await logstream.requestGuidance();
  assert.equal(g.failed, 1);
  let gt = (await query(`SELECT guidance_state, guidance_error FROM engine_logstream_triggers WHERE job_id = $1`, [job.natural_id])).rows[0];
  assert.equal(gt.guidance_state, 'failed');
  assert.ok(gt.guidance_error.includes('north star said no'));
  hookAnswer = { code: 200, body: { ok: true } };
  g = await logstream.requestGuidance();
  assert.equal(g.asked, 1);
  assert.equal(asks.length, 2);
  assert.equal(asks[1].headers['x-dashboard-key'], 'inbound-test');
  assert.ok(asks[1].body.prompt.includes('The step times out') && asks[1].body.prompt.includes(job.natural_id) && asks[1].body.prompt.includes('recommendation only'));
  assert.equal(asks[1].body.channel_id, 'C0B5JHVAXCM');
  await logstream.requestGuidance();
  assert.equal(asks.length, 2, 'asked once');
  const rateJob = (await jobs()).find((x) => x.fields.Question.includes('rate one'));
  await query(`UPDATE engine_rt_jobs SET fields = fields || $2::jsonb WHERE natural_id = $1`, [rateJob.natural_id, JSON.stringify({ Status: 'Capped (needs human)' })]);
  g = await logstream.requestGuidance();
  assert.equal(g.no_finding, 1);
  assert.equal(asks.length, 2, 'a capped job has nothing to turn into guidance');
  ok('guidance: North Star is asked once when research resolves; a refusal is failed and retried; a capped job is not sent');

  /* the page's read */
  const page = await logstream.read();
  assert.ok(page.summary.incidents >= 5 && page.triggers.length >= 3 && page.signatures.length >= 1 && page.rows.length >= 1);
  assert.equal(page.summary.person_confirmed, 0);
  assert.ok(page.adherence.some((a) => a.pattern === P.S757 && a.result === 'followed'));
  ok('read: the page gets the summary, crossings, faults, rows and adherence');

  const flags = (await query(`SELECT count(*)::int AS n FROM engine_logstream WHERE person_confirmed OR autopay_enabled`)).rows[0].n;
  assert.equal(flags, 0);
  ok('pay: person_confirmed and autopay_enabled are false on every row');

  await query(`DELETE FROM engine_incidents WHERE natural_id LIKE $1`, [`INC-LSTEST-${T}-%`]);
  await query(`DELETE FROM engine_execution_runs WHERE workflow_id LIKE $1`, [`lstest-${T}-%`]);
  await query(`DELETE FROM engine_logstream WHERE incident_id LIKE $1`, [`INC-LSTEST-${T}-%`]);
  await query(`DELETE FROM engine_logstream_triggers WHERE key LIKE $1 OR key LIKE $2 OR kind = 'shared_outage'`, [`%${T}%`, `lstest-${T}-%`]);
  await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Opened By' = 'Logstream' AND fields->>'Question' LIKE $1`, [`%${T}%`]);
  await query(`DELETE FROM engine_mcp_writes WHERE arguments::text LIKE $1`, [`%INC-LSTEST-${T}-%`]);
  console.log(`\n${passed} checks passed.`);
  slack.close();
  hook.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
