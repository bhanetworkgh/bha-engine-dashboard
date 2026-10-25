/**
 * The recovery watcher (2026-09-23), pinned against stand-ins for BHARAG, the
 * n8n API, the n8n webhooks and the healer — one local HTTP server playing all
 * four, so every call the watcher makes is seen and counted.
 *
 * What this proves, because each is a way a recovery goes wrong silently:
 *   - nothing waiting means no probe is sent;
 *   - each class lands on the right dependency (class, credential, host), and a
 *     5xx or timeout under thirty minutes old is left to the healer;
 *   - a dependency still down leaves its incidents waiting;
 *   - the heal call carries `recovery: true`;
 *   - a chat reply is never re-run and is closed open → retrying → wont_fix;
 *   - a pruned run is data_gone, and n8n's own successful retry is already_done
 *     and closed self_healed;
 *   - an old Exhausted retry row is not read as this re-run's answer;
 *   - exactly one summary per batch, however many ticks follow;
 *   - the plan calls nothing;
 *   - a polling trigger's one-off 5xx (no execution id) closes itself
 *     self_healed once 30 minutes have passed with no repeat; a younger one
 *     waits and says when it will close; two of the same step inside 30
 *     minutes both stay open for a person (19 Oct 2026);
 *   - a run that names its own credit floor ("below the $50 a run needs")
 *     stays waiting, with no batch, while the probe reads less than that, and
 *     goes once the balance covers it (25 Oct 2026).
 *
 * Run with:  npm run test:recovery   (needs DATABASE_URL; migrations are applied here)
 */
const assert = require('node:assert/strict');
const http = require('node:http');

const calls = [];
const ledger = new Map();
const hour = 3600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const T = Date.now();
const id = (k) => `INC-TEST-${T}-${k}`;
const probeState = { openrouter: { ok: true, remaining_usd: 30.78, floor_usd: 5, status: 'ok' }, slack: { ok: false, status: 'auth_failed' }, google: { ok: true, status: 'ok' } };

function inc(k, cls, wf, node, exec, age) {
  ledger.set(id(k), {
    entity_id: id(k),
    source: 'bays',
    resolution_status: 'open',
    occurred_at: ago(age),
    payload: { error_class: cls, workflow_or_scenario: wf, failed_node_or_component: node, execution_id: exec, error_message: `test ${k}` },
  });
}
inc('quota', 'BILLING_QUOTA', 'TEST — Recovery A', 'Model', '9100', 2 * hour);
inc('chat', 'BILLING_QUOTA', 'Bays — Front Door', 'Model', '9101', 2 * hour);
inc('slack', 'CONFIG_AUTH', 'TEST — Recovery C', 'Post to Slack', '9102', 2 * hour);
inc('gone', 'BILLING_QUOTA', 'TEST — Recovery D', 'Model', '9103', 3 * hour);
inc('young', 'NETWORK_TIMEOUT', 'TEST — Recovery E', 'Call', '9105', 5 * 60_000);
inc('done', 'BILLING_QUOTA', 'TEST — Recovery F', 'Model', '9104', 2.5 * hour);
inc('host', 'UPSTREAM_5XX', 'TEST — Recovery G', 'Ask OpenRouter', '9106', 1.5 * hour);
inc('other', 'SCHEMA_VALIDATION', 'TEST — Recovery H', 'Parse', '9107', 2 * hour);
inc('poll', 'UPSTREAM_5XX', 'TEST — Poll A', 'Trigger (polling)', undefined, 2 * hour);
inc('pollyoung', 'UPSTREAM_5XX', 'TEST — Poll B', 'Trigger (polling)', undefined, 5 * 60_000);
inc('rep1', 'NETWORK_TIMEOUT', 'TEST — Poll C', 'Trigger (polling)', undefined, 2 * hour);
inc('rep2', 'UPSTREAM_5XX', 'TEST — Poll C', 'Trigger (polling)', undefined, 1.75 * hour);
inc('floor', 'BILLING_QUOTA', 'TEST — Recovery Floor', 'Enough Credit To Run?', '9108', 2 * hour);
ledger.get(id('floor')).payload.error_message = 'Eval run not started: OpenRouter credit is $1.91, below the $50 a run needs. No case was asked.';

const execs = {
  9100: { id: '9100', workflowId: 'wfA', status: 'error', workflowData: { nodes: [{ name: 'Model', credentials: { openRouterApi: { name: 'OR' } } }] } },
  9108: { id: '9108', workflowId: 'wfFloor', status: 'error', workflowData: { nodes: [] } },
  9101: { id: '9101', workflowId: '134ezjaO6gYqYjez', status: 'error', workflowData: { nodes: [] } },
  9102: { id: '9102', workflowId: 'wfC', status: 'error', workflowData: { nodes: [{ name: 'Post to Slack', credentials: { slackApi: { name: 'Bays' } } }] } },
  9104: { id: '9104', workflowId: 'wfF', status: 'error', retrySuccessId: '9999', workflowData: { nodes: [] } },
  9105: { id: '9105', workflowId: 'wfE', status: 'error', workflowData: { nodes: [{ name: 'Call', parameters: { url: 'https://slack.com/api/x' } }] } },
  9106: { id: '9106', workflowId: 'wfG', status: 'error', workflowData: { nodes: [{ name: 'Ask OpenRouter', parameters: { url: 'https://openrouter.ai/api/v1/chat/completions' } }] } },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const parsed = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: url.pathname, query: url.search, body: parsed, key: req.headers['x-dashboard-key'] || req.headers['x-api-key'] || null });
    const json = (status, v) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === '/api/v1/incidents' && req.method === 'GET') {
      const st = url.searchParams.get('status');
      return json(200, { incidents: [...ledger.values()].filter((i) => i.resolution_status === st) });
    }
    const status = url.pathname.match(/^\/api\/v1\/incidents\/(.+)\/status$/);
    if (status) {
      const i = ledger.get(decodeURIComponent(status[1]));
      if (!i) return json(404, { error: { message: 'no such incident' } });
      if (parsed.resolution_status === 'wont_fix') return json(400, { error: { message: 'illegal transition', code: 'LEDGER_TRANSITION' } });
      i.resolution_status = parsed.resolution_status;
      return json(200, i);
    }
    const ex = url.pathname.match(/^\/api\/v1\/executions\/(\d+)$/);
    if (ex) return execs[ex[1]] ? json(200, execs[ex[1]]) : json(404, { message: 'not found' });
    if (url.pathname === '/webhook/engine-dependency-probe') return json(200, { checked_at: new Date().toISOString(), ...probeState });
    if (url.pathname === '/webhook/engine-recovery-summary') return json(200, { ok: true });
    if (url.pathname === '/webhook/engine-heal') return json(200, { ok: true });
    json(404, { message: 'stub has no such route' });
  });
});

(async () => {
  // It drives real ticks: every waiting row in the database is acted on, against
  // the stand-ins. Never against the live database.
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
    console.error('test:recovery runs ticks against every row it finds, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
    process.exit(1);
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    BHARAG_API_URL: `${base}/api/v1`,
    BHARAG_BAYS_INCIDENTS: 'bays-key',
    N8N_API_URL: `${base}/api/v1`,
    N8N_API_KEY: 'n8n-key',
    ENGINE_HEAL_URL: `${base}/webhook/engine-heal`,
    DASHBOARD_INBOUND_KEY: 'inbound-key',
  });
  delete process.env.BHARAG_NS_INCIDENTS;
  delete process.env.BHARAG_RT_INCIDENTS;
  delete process.env.RECOVERY_ENABLED;

  const { migrate } = require('../../server-dist/server/src/migrations.js');
  const registry = require('../../server-dist/server/src/registry.js');
  const recovery = require('../../server-dist/server/src/recovery.js');
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  await migrate();
  await registry.seedRegistry();
  recovery.setGapForTests(10);

  try {
    await query(`DELETE FROM engine_recovery WHERE incident_id LIKE 'INC-TEST-%'`);
    await query(`DELETE FROM engine_recovery_batches`);
    await query(`DELETE FROM meta WHERE key LIKE 'recovery.%'`);
    const replay = await query(`SELECT replay FROM registry_workflows WHERE name = 'Bays — Front Door'`);
    assert.equal(replay.rows[0].replay, 'never', 'the chat front door is seeded never');

    // An old Exhausted row for A, from before the outage ended.
    await query(`DELETE FROM engine_retry_attempts WHERE natural_id = $1`, [id('quota')]);
    await query(`INSERT INTO engine_retry_attempts (natural_id, fields, source, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', $3, $3)`, [
      id('quota'),
      JSON.stringify({ status: 'Exhausted', incident_id: id('quota'), last_attempt_at: ago(hour) }),
      ago(hour),
    ]);

    // Tick 1: classify, probe once, drain the openrouter batch; slack stays down.
    const t1 = await recovery.runTick();
    assert.equal(t1.ran, true, t1.note);
    const rows = Object.fromEntries((await query(`SELECT incident_id, dependency, status, note FROM engine_recovery WHERE incident_id LIKE $1`, [`INC-TEST-${T}-%`])).rows.map((r) => [r.incident_id.split('-').pop(), r]));
    assert.equal(rows.quota.status, 'replaying', 'A was handed to the healer');
    assert.equal(rows.chat.status, 'chat_not_rerun', 'the chat reply was not re-run');
    assert.equal(rows.slack.dependency, 'slack', 'CONFIG_AUTH read the slackApi credential');
    assert.equal(rows.slack.status, 'waiting', 'slack is still down, so C waits');
    assert.equal(rows.gone.status, 'data_gone', 'a pruned run is data_gone');
    assert.equal(rows.done.status, 'already_done', "n8n's own successful retry is already done");
    assert.equal(rows.host.dependency, 'openrouter', 'a 5xx reads the host');
    assert.equal(rows.host.status, 'replaying');
    assert.equal(rows.young, undefined, 'a timeout under 30 minutes is left to the healer');
    assert.equal(rows.other, undefined, 'SCHEMA_VALIDATION waits on nothing');
    assert.equal(rows.floor.dependency, 'openrouter');
    assert.equal(rows.floor.status, 'waiting', 'a run needing $50 waits while the probe reads $30.78');
    assert.match(rows.floor.note, /\$30\.78 left, this run needs \$50/, 'and says why');
    assert.equal(recovery.creditFloorFor('OpenRouter credit is $1.91, below the $15 a run needs.'), 15);
    assert.equal(recovery.creditFloorFor('$2.09 left when this failed (floor $15).'), 15);
    assert.equal(recovery.creditFloorFor('This request would exceed your available credits'), null, 'a refusal that names no floor is not held');

    assert.equal(calls.filter((c) => c.path === '/webhook/engine-dependency-probe').length, 1, 'one probe');
    assert.equal(calls.find((c) => c.path === '/webhook/engine-dependency-probe').key, 'inbound-key');
    const heals = calls.filter((c) => c.path === '/webhook/engine-heal');
    assert.equal(heals.length, 2, 'two re-runs');
    for (const h of heals) assert.equal(h.body.recovery, true, 'the heal call carries recovery: true');
    assert.deepEqual(Object.keys(heals[0].body).sort(), ['error_class', 'error_message', 'execution_id', 'failed_node', 'incident_id', 'lane', 'recovery', 'workflow']);

    const posts = (k) => calls.filter((c) => c.method === 'POST' && c.path === `/api/v1/incidents/${id(k)}/status`).map((c) => c.body.resolution_status);
    assert.deepEqual(posts('chat'), ['retrying', 'wont_fix', 'manually_resolved'], 'open → retrying → wont_fix, falling back where refused');
    assert.deepEqual(posts('done'), ['retrying', 'self_healed']);
    for (const c of calls.filter((c) => c.path.endsWith('/status'))) assert.ok(Object.keys(c.body).every((k) => ['resolution_status', 'payload_patch'].includes(k)), 'nothing else at the top level');

    // One-off polling errors.
    assert.deepEqual(posts('poll'), ['retrying', 'self_healed'], 'a lone polling 5xx past 30 minutes closes itself self_healed');
    assert.deepEqual(posts('pollyoung'), [], 'a polling error under 30 minutes old is left open');
    assert.deepEqual(posts('rep1'), [], 'a repeated polling error is not a one-off');
    assert.deepEqual(posts('rep2'), [], 'nor is its repeat');
    const skip = Object.fromEntries((await recovery.plan()).skipped.map((x) => [x.incident_id, x.reason]));
    assert.equal(skip[id('poll')], undefined, 'a closed one-off leaves the passed-over list');
    assert.match(skip[id('pollyoung')], /closes itself at/, 'the young one says when it will close');
    assert.match(skip[id('rep1')], new RegExp(`Not a one-off.*${id('rep2')}`), 'the repeat is named');
    assert.match(skip[id('rep2')], new RegExp(`Not a one-off.*${id('rep1')}`), 'both ways round');
    const ev = await query(`SELECT actor, lane, detail FROM engine_events WHERE event_type = 'polling_one_off_closed' AND subject_id = $1`, [id('poll')]);
    assert.equal(ev.rows.length, 1, 'one polling_one_off_closed event');
    assert.equal(ev.rows[0].actor, 'recovery');
    assert.equal(ev.rows[0].detail.ledger_state, 'self_healed');
    const logged = await query(`SELECT actor, state FROM record_writes WHERE kind = 'incidents' AND record_id = $1`, [id('poll')]);
    assert.deepEqual(logged.rows, [{ actor: 'recovery', state: 'ok' }], 'the close is a record_writes line');
    const before1 = calls.length;
    await recovery.runTick();
    assert.equal(calls.slice(before1).filter((c) => c.path === `/api/v1/incidents/${id('poll')}/status`).length, 0, 'a closed one-off is not closed twice');

    assert.equal(calls.filter((c) => c.path === '/webhook/engine-recovery-summary').length, 0, 'no summary while two are replaying');
    const plan = await recovery.plan();
    assert.equal(plan.replaying.length, 2);
    assert.equal(plan.waiting.filter((r) => r.incident_id.startsWith(`INC-TEST-${T}`)).length, 2, 'slack and the credit-floor run wait');
    assert.ok(plan.next_tick.some((l) => /1 of 1 need more credit/.test(l)), 'the plan says the floor run is held for credit');

    // The healer answers: A recovered, G exhausted.
    const now = new Date().toISOString();
    await query(`UPDATE engine_retry_attempts SET fields = $2::jsonb, updated_at = $3 WHERE natural_id = $1`, [
      id('quota'),
      JSON.stringify({ status: 'Recovered', retry_execution_id: '9200', incident_id: id('quota'), last_attempt_at: now }),
      now,
    ]);
    await query(`INSERT INTO engine_retry_attempts (natural_id, fields, source, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'engine', $3, $3)`, [
      id('host'),
      JSON.stringify({ status: 'Exhausted', incident_id: id('host'), last_attempt_at: now, last_result: 'failed again' }),
      now,
    ]);

    const before = calls.length;
    await recovery.runTick();
    const summaries = calls.slice(before).filter((c) => c.path === '/webhook/engine-recovery-summary');
    assert.equal(summaries.length, 1, 'exactly one summary');
    const sum = summaries[0].body;
    assert.equal(sum.dependency, 'openrouter');
    const outcomes = Object.fromEntries(sum.runs.map((r) => [r.execution_id, r.outcome]));
    assert.deepEqual(outcomes, { 9100: 'recovered', 9101: 'chat_not_rerun', 9103: 'data_gone', 9104: 'already_done', 9106: 'failed_again' });
    assert.equal(sum.runs.find((r) => r.execution_id === '9100').retry_execution_id, '9200');

    await recovery.runTick();
    assert.equal(calls.filter((c) => c.path === '/webhook/engine-recovery-summary').length, 1, 'a later tick sends nothing more');

    // Credit back above the floor: the held run goes in its own batch.
    probeState.openrouter.remaining_usd = 60;
    await recovery.runTick();
    const fl = await query(`SELECT status FROM engine_recovery WHERE incident_id = $1`, [id('floor')]);
    assert.equal(fl.rows[0].status, 'replaying', 'once the balance covers its floor the run is re-run');

    // The plan calls nothing.
    const n = calls.length;
    await recovery.plan();
    assert.equal(calls.length, n, 'the plan made no outbound call');

    // Off: the tick does nothing at all.
    await recovery.setEnabled(false, 'test');
    const m = calls.length;
    const off = await recovery.runTick();
    assert.equal(off.ran, false);
    assert.equal(calls.length, m, 'switched off, nothing is called');
    const flip = await query(`SELECT actor, status FROM record_writes WHERE kind = 'recovery' ORDER BY seq DESC LIMIT 1`);
    assert.deepEqual(flip.rows[0], { actor: 'test', status: 'off' }, 'the flip is logged with who made it');
    await recovery.setEnabled(true, 'test');

    console.log('recovery: all assertions passed');
  } finally {
    await query(`DELETE FROM engine_recovery WHERE incident_id LIKE 'INC-TEST-%'`).catch(() => {});
    await query(`DELETE FROM engine_retry_attempts WHERE natural_id LIKE 'INC-TEST-%'`).catch(() => {});
    await query(`DELETE FROM engine_events WHERE event_type = 'polling_one_off_closed' AND subject_id LIKE 'INC-TEST-%'`).catch(() => {});
    await closePool();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
