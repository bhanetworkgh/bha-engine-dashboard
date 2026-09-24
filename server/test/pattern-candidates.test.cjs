/**
 * Acting on a pattern candidate from the Build patterns page (2026-09-24),
 * pinned end to end: the real server process behind a real sign-in, a local
 * database, and local stand-ins for Google and BHARAG.
 *
 *   register — through create_record's own path: BP- id minted, pattern saved,
 *     BHARAG ingested, Google Doc made; the candidate turns Registered with the
 *     Pattern ID, Registered At and Registered By; a second register is 409.
 *   decline — a reason is required; Status Declined with reason and who.
 *   reassign — to a Builder Profiles row only; Suggested Architect and
 *     Architect Slack ID both change; the same architect again is 409.
 *   who may act — the architect, the builder, Jason or Destiny; anyone else is
 *     403 and nothing is written; an actor with no profile is 400.
 *   the cookie — every action is refused without one.
 *   the audit — each write is on engine_mcp_writes with access 'page', and on
 *     engine_writes as endpoint page:<tool>.
 *
 * Every row it makes is deleted at the end. Run with:  npm run test:candidates
 * (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:candidates writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const PORT = 5081;
const TOKEN = 'candidates-test';
const T = Date.now();
const PASSWORD = 'candidate-test-password';
const ID = (s) => `UT${s}${String(T).slice(-6)}`;
const ARCH = ID('ARCH');
const BUILDER = ID('BLDR');
const OTHER = ID('OTHR');
const NEWARCH = ID('NEWA');
const DESTINY = 'U0AEW3TBYH1';

/* ------------------------------------------------------------ stand-ins */

const seen = { google: [], ingest: [] };
let docSeq = 0;
const google = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.google.push({ method: req.method, path: u.pathname, body: body && body.startsWith('{') ? JSON.parse(body) : null });
    const send = (code, b) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (u.pathname === '/token') return send(200, { access_token: 'ya29.test', expires_in: 3600 });
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') return send(200, { id: `cdoc-${++docSeq}` });
    const m = /^\/v1\/documents\/([^:]+):batchUpdate$/.exec(u.pathname);
    if (m) return send(200, { documentId: m[1] });
    const f = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (f) return send(200, { id: f[1], webViewLink: `https://docs.google.com/document/d/${f[1]}/edit` });
    return send(404, { error: { message: `no route ${u.pathname}` } });
  });
});
const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.ingest.push({ path: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ document_id: `bh-${seen.ingest.length}` }));
  });
});
/*
 * Slack: conversations.replies (the thread, read as North Star), and
 * chat.postMessage / chat.getPermalink / chat.delete (the announcement, as
 * Bays). A channel in failPost refuses the post the way Slack does: HTTP 200,
 * ok:false.
 */
seen.slack = [];
const posts = new Map();
let failPost = null;
const THREAD = [
  { user: 'U0BNQGG020Y', ts: '1790000000.000100', text: 'Rover stepper: the Python pulse loop tops out at 3400 steps/s, <@U0AEW3TBYH1> the spec is 4000.' },
  { user: 'U0AEW3TBYH1', ts: '1790000100.000200', text: 'Moved pulse generation to pigpio DMA; 100% commanded-vs-actual at 2, 5, 10, 20 and 40 mm/s.' },
  { bot_id: 'B1', bot_profile: { name: 'Bays' }, ts: '1790000200.000300', text: 'Flagged as a pattern candidate.' },
];
const slackSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const method = u.pathname.replace(/^\/api\//, '');
    let args = Object.fromEntries(u.searchParams);
    if (body) args = { ...args, ...((req.headers['content-type'] || '').includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body))) };
    seen.slack.push({ method, auth: req.headers.authorization, args });
    const send = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (method === 'conversations.replies') {
      if (args.channel === 'CNOTMEMBER') return send({ ok: false, error: 'not_in_channel' });
      return send({ ok: true, messages: THREAD });
    }
    if (method === 'chat.postMessage') {
      if (failPost && args.channel === failPost) return send({ ok: false, error: 'not_in_channel' });
      const ts = `${Math.floor(Date.now() / 1000)}.${String(posts.size + 1).padStart(6, '0')}`;
      posts.set(ts, args);
      return send({ ok: true, channel: args.channel, ts });
    }
    if (method === 'chat.getPermalink') return send({ ok: true, permalink: `https://bayshorizonnetwork.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` });
    if (method === 'chat.delete') return send(posts.delete(args.ts) ? { ok: true } : { ok: false, error: 'message_not_found' });
    return send({ ok: false, error: 'unknown_method' });
  });
});
/* OpenRouter: records the request and answers with a draft that leaves some fields empty, as a grounded draft does. */
let modelAnswer = null;
const openrouter = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.model = { auth: req.headers.authorization, path: req.url, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(modelAnswer) + '\n```\n' } }], usage: { total_tokens: 1234 } }));
  });
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

/* ------------------------------------------------------------ the client */

let cookie = '';
function request(method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}), ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let body = null;
          try {
            body = b ? JSON.parse(b) : null;
          } catch {
            body = b;
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
async function mcp(name, args) {
  const r = await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { cookie: '' });
  return JSON.parse(r.body.result.content[0].text);
}
const act = (ref, action, body) => request('POST', `/api/pattern-candidates/${encodeURIComponent(ref)}/${action}`, body);

(async () => {
  const [googleUrl, bharagUrl, slackUrl, orUrl] = await Promise.all([listen(google), listen(bharag), listen(slackSrv), listen(openrouter)]);
  const { hashPassword } = require(path.join(__dirname, '../../server-dist/server/src/auth.js'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: TOKEN,
    MCP_WRITE_TOKEN: TOKEN,
    DASHBOARD_INBOUND_KEY: 'inbound-for-test',
    RECOVERY_ENABLED: 'false',
    AUTH_EMAIL: 'test@bhanetwork.org',
    AUTH_PASSWORD_HASH: hashPassword(PASSWORD),
    SESSION_SECRET: 'candidates-session-secret',
    GOOGLE_API_URL: googleUrl,
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
    BHARAG_API_URL: bharagUrl,
    BHARAG_BUILD_PATTERNS_KEY: 'bp-key',
    SLACK_API_URL: `${slackUrl}/api`,
    SLACK_BAYS_BOT_TOKEN: 'xoxb-bays',
    SLACK_NORTH_STAR_BOT_TOKEN: 'xoxb-northstar',
    OPENROUTER_API_URL: orUrl,
    OPENROUTER_API_KEY: 'sk-or-test',
  };
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'AUTH_PASSWORD']) delete env[k];
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\//i.test(log) && (await request('GET', '/api/auth/session').catch(() => null))) break;
  }
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const made = { profiles: [], candidates: [], patterns: [] };
  const passed = [];
  const step = (s) => passed.push(s);

  try {
    /* ---- the cookie ---- */
    const noCookie = await act('CAND-x', 'decline', { actor_user_id: DESTINY, reason: 'nope' });
    assert.equal(noCookie.status, 401, 'refused without a session');
    const login = await request('POST', '/api/auth/login', { email: 'test@bhanetwork.org', password: PASSWORD });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    step('actions are behind the page cookie');

    /* ---- throwaway profiles and candidates ---- */
    const hadDestiny = (await query(`SELECT count(*)::int n FROM engine_builder_profiles WHERE natural_id = $1`, [DESTINY])).rows[0].n > 0;
    for (const [id, name] of [[ARCH, `Arch ${T}`], [BUILDER, `Builder ${T}`], [OTHER, `Other ${T}`], [NEWARCH, `New Arch ${T}`], ...(hadDestiny ? [] : [[DESTINY, 'Destiny Arupi']])]) {
      const p = await mcp('create_record', { kind: 'builder_profiles', fields: { user_id: id, name, pronouns: 'they/them', lane: 'BAYS', role: 'builder' } });
      assert.equal(p.ok, true, JSON.stringify(p));
      made.profiles.push(id);
    }
    const profiles = await request('GET', '/api/builder-profiles');
    assert.ok(profiles.body.profiles.some((p) => p.user_id === ARCH && p.name === `Arch ${T}`), 'the picker reads Builder Profiles');

    const mk = async (label, source = 'https://bha.slack.com/archives/C0/p1') => {
      const c = await mcp('create_record', {
        kind: 'pattern_candidates',
        fields: {
          Candidate: `Throwaway ${label} ${T}`,
          Summary: `A throwaway candidate for the page-action test (${label}).`,
          Lane: 'BAYS',
          Builder: `Builder ${T}`,
          'Builder Slack ID': BUILDER,
          'Suggested Architect': `Arch ${T}`,
          'Architect Slack ID': ARCH,
          'Why This Architect': 'Did the work.',
          'Flagged By': 'test',
          'Source Link': source,
        },
      });
      assert.equal(c.ok, true, JSON.stringify(c));
      made.candidates.push(c.natural_id);
      return c.natural_id;
    };
    const [cReg, cDec, cRea] = [await mk('register'), await mk('decline'), await mk('reassign')];
    const listed = await request('GET', '/api/pattern-candidates');
    const row = listed.body.candidates.find((c) => c.id === cReg);
    assert.ok(row, 'the page lists the candidate by its CAND- id');
    assert.equal(row.status, 'Proposed');
    assert.equal(row.architect_slack_id, ARCH);
    step('throwaway profiles and candidates seeded');

    /* ---- who may act ---- */
    const auditFrom = (await query(`SELECT coalesce(max(id),0)::int m FROM engine_mcp_writes`)).rows[0].m;
    const before = (await query(`SELECT count(*)::int n FROM engine_mcp_writes WHERE access = 'page'`)).rows[0].n;
    const other = await act(cDec, 'decline', { actor_user_id: OTHER, reason: 'not mine to decline' });
    assert.equal(other.status, 403);
    assert.equal(other.body.reason, 'not_permitted');
    assert.match(other.body.message, /only its suggested architect/);
    const nobody = await act(cDec, 'decline', { actor_user_id: 'UNOPROFILE1', reason: 'who am I' });
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.reason, 'unknown_actor');
    const noActor = await act(cDec, 'decline', { reason: 'who am I' });
    assert.equal(noActor.body.reason, 'no_actor');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_mcp_writes WHERE access = 'page'`)).rows[0].n, before, 'a refused actor writes nothing, not even an audit line');
    step('only the architect, the builder, Jason or Destiny may act');

    /* ---- decline ---- */
    const noReason = await act(cDec, 'decline', { actor_user_id: ARCH, reason: ' x ' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.reason, 'no_reason');
    const dec = await act(cDec, 'decline', { actor_user_id: BUILDER, reason: 'Already covered by an existing pattern.' });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    const decRow = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cDec])).rows[0].fields;
    assert.equal(decRow.Status, 'Declined');
    assert.equal(decRow['Declined Reason'], 'Already covered by an existing pattern.');
    assert.equal(decRow['Declined By'], `Builder ${T}`);
    assert.equal(decRow['Declined By Slack ID'], BUILDER);
    assert.ok(decRow['Declined At']);
    assert.equal(decRow.Summary, 'A throwaway candidate for the page-action test (decline).', 'every other field kept');
    const again = await act(cDec, 'decline', { actor_user_id: ARCH, reason: 'twice' });
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, 'already_declined');
    const decPage = (await request('GET', '/api/pattern-candidates')).body.candidates.find((c) => c.id === cDec);
    assert.deepEqual([decPage.status, decPage.declined_reason, decPage.declined_by], ['Declined', 'Already covered by an existing pattern.', `Builder ${T}`]);
    step('decline: reason required, Declined with reason and who, then closed');

    /* ---- reassign ---- */
    const bad = await act(cRea, 'reassign', { actor_user_id: ARCH, architect_user_id: 'UNOPROFILE1' });
    assert.equal(bad.body.reason, 'unknown_architect');
    const same = await act(cRea, 'reassign', { actor_user_id: ARCH, architect_user_id: ARCH });
    assert.equal(same.status, 409);
    const rea = await act(cRea, 'reassign', { actor_user_id: DESTINY, architect_user_id: NEWARCH });
    assert.equal(rea.status, 200, JSON.stringify(rea.body));
    assert.equal(rea.body.suggested_architect, `New Arch ${T}`);
    const reaRow = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cRea])).rows[0].fields;
    assert.deepEqual([reaRow['Suggested Architect'], reaRow['Architect Slack ID'], reaRow['Reassigned By'], reaRow.Status], [`New Arch ${T}`, NEWARCH, 'Destiny Arupi', 'Proposed']);
    const oldArch = await act(cRea, 'decline', { actor_user_id: ARCH, reason: 'I was the architect' });
    assert.equal(oldArch.status, 403, 'the previous architect no longer may act');
    step('reassign: from Builder Profiles only, both fields change, the old architect loses the right');

    /* ---- register ---- */
    const reg = await act(cReg, 'register', {
      actor_user_id: ARCH,
      pattern: {
        pattern_name: `Throwaway register ${T}`,
        bha_system: 'BAYS',
        reusability: 'Moderate',
        problem: 'The problem.',
        solution: 'The solution.',
        context: 'The context.',
        implementation_checklist: 'Step one\nStep two\n',
      },
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.match(reg.body.pattern_id, /^BP-BAYS-\d+-[A-Z0-9]{4}$/);
    made.patterns.push(reg.body.pattern_id);
    assert.equal(reg.body.candidate_updated, true);
    assert.equal(reg.body.ingested_to_bharag, true);
    assert.equal(reg.body.doc_created, true);
    assert.match(reg.body.doc_link, /^https:\/\/docs\.google\.com\/document\/d\/cdoc-/);
    const pat = (await query(`SELECT fields, source FROM engine_build_patterns WHERE natural_id = $1`, [reg.body.pattern_id])).rows[0];
    assert.equal(pat.source, 'engine');
    assert.equal(pat.fields.pattern_name, `Throwaway register ${T}`);
    const docCreate = seen.google.filter((g) => g.path === '/drive/v3/files' && g.method === 'POST').at(-1);
    assert.equal(docCreate.body.name, `Build Pattern -- Throwaway register ${T} -- Arch ${T}`, 'drafted_by is the person acting, on the Doc');
    assert.equal(pat.fields.implementation_checklist, 'Step one | Step two', 'one step per line joined as patterns are');
    assert.equal(seen.ingest.at(-1).key, 'bp-key');
    assert.equal(seen.ingest.at(-1).body.metadata.pattern_id, reg.body.pattern_id);
    const regRow = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cReg])).rows[0].fields;
    assert.deepEqual([regRow.Status, regRow['Pattern ID'], regRow['Registered By']], ['Registered', reg.body.pattern_id, `Arch ${T}`]);
    assert.ok(regRow['Registered At']);
    const twice = await act(cReg, 'register', { actor_user_id: ARCH, pattern: { pattern_name: 'again' } });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.reason, 'already_registered');
    assert.match(twice.body.message, new RegExp(reg.body.pattern_id));
    step('register: BP- id, pattern saved, BHARAG ingested, Doc made, candidate Registered with the id');

    /* ---- the announcement ---- */
    const annPost = seen.slack.filter((x) => x.method === 'chat.postMessage').at(-1);
    assert.equal(reg.body.announced, true, JSON.stringify(reg.body));
    assert.equal(annPost.auth, 'Bearer xoxb-bays', 'posted as Bays');
    assert.equal(annPost.args.channel, 'C0B0668PRNW', 'into #bha-build-patterns');
    const cardText = JSON.stringify(annPost.args.blocks);
    assert.equal(annPost.args.blocks[0].text.text, '🔧 BHA Build Pattern', 'the extractor card header');
    assert.match(cardText, new RegExp(`From \\*Builder ${T}\\*`), 'the builder whose work it came from');
    assert.match(cardText, new RegExp(`\\*Throwaway register ${T}\\*`), 'the pattern name');
    assert.match(cardText, new RegExp(`\\*Pattern ID:\\* \`${reg.body.pattern_id}\``), 'the BP- id');
    assert.match(cardText, /The problem\./, 'the one-line problem');
    assert.match(cardText, new RegExp(`Registered by <@${ARCH}>`), 'who registered it, as a mention');
    assert.match(cardText, /<https:\/\/docs\.google\.com\/document\/d\/cdoc-[^|]+\|Google Doc>/, 'the Doc link');
    assert.match(cardText, new RegExp(`/build-patterns\\?open=row-${reg.body.pattern_row_id}\\|Full pattern on the dashboard>`), 'the pattern on the dashboard');
    assert.equal(reg.body.pattern_url.endsWith(`/build-patterns?open=row-${reg.body.pattern_row_id}`), true);
    assert.match(reg.body.announcement_link, /^https:\/\/bayshorizonnetwork\.slack\.com\/archives\/C0B0668PRNW\/p\d+/);
    assert.equal(regRow['Announcement Link'], reg.body.announcement_link, 'the candidate carries its announcement');
    const annAudit = (await query(`SELECT outcome, access, kind FROM engine_mcp_writes WHERE tool = 'announce_pattern' AND natural_id = $1`, [reg.body.pattern_id])).rows;
    assert.deepEqual(annAudit, [{ outcome: 'posted', access: 'page', kind: 'slack' }]);
    step('announce: one Bays post in #bha-build-patterns — name, BP- id, problem, <@registrar>, builder, Doc, dashboard link');

    /* ---- draft full pattern ---- */
    const cDraft = await mk('draft', 'https://bayshorizonnetwork.slack.com/archives/C0A90TS44T1/p1790000100000200?thread_ts=1790000000.000100&cid=C0A90TS44T1');
    modelAnswer = {
      pattern_name: 'DMA pulse generation for stepper accuracy',
      problem: 'A Python pulse loop tops out at 3400 steps per second against a 4000 step requirement.',
      solution: 'Generate pulses with the Raspberry Pi DMA engine through pigpio.',
      context: 'vFarm Rover stepper axis.',
      bha_system: 'VFARM',
      reusability: 'broad — any motion axis',
      implementation_checklist: ['Measure the loop overhead per step', 'Switch pulse generation to pigpio DMA'],
      learnings_gotchas: '',
      anti_pattern: 'Anti-Pattern: running a software pulse loop when its overhead exceeds the step period.',
      integration_points: '',
      readiness_gates: '',
      next_use_case: '',
      commercial_impact: '',
      research_production_impact: '',
      routing_logic: '',
      test_coverage: '100% commanded-vs-actual at 2, 5, 10, 20 and 40 mm/s.',
      naming_note: '',
      roadmap_context: '',
      pattern_id: 'BP-MODEL-SHOULD-NOT-PICK',
      observability: 'not asked for',
    };
    const otherDraft = await act(cDraft, 'draft', { actor_user_id: OTHER });
    assert.equal(otherDraft.status, 403, 'a draft follows the same who-may-act rule');
    const d = await act(cDraft, 'draft', { actor_user_id: BUILDER });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(seen.model.auth, 'Bearer sk-or-test');
    assert.equal(seen.model.path, '/chat/completions');
    assert.equal(seen.model.body.model, 'anthropic/claude-sonnet-5', "the model the agents and the Pattern Extractor use");
    assert.equal(seen.model.body.max_tokens, 3000);
    assert.deepEqual(seen.model.body.response_format, { type: 'json_object' });
    const [sys, usr] = seen.model.body.messages;
    assert.match(sys.content, /You are the Bays Horizon Build-Pattern Extractor/, "the extractor's prompt");
    assert.match(sys.content, /A field the sources do not support is an empty string/, 'the never-invent rule');
    assert.doesNotMatch(sys.content, /pattern_id:/, 'pattern_id is minted, not asked for');
    assert.match(usr.content, /A throwaway candidate for the page-action test \(draft\)\./, 'the Summary is a source');
    assert.match(usr.content, /Kavin: Rover stepper: the Python pulse loop tops out at 3400 steps\/s, @Destiny Arupi the spec is 4000\./, 'the thread is a source, names and mentions cleaned');
    const replies = seen.slack.filter((x) => x.method === 'conversations.replies').at(-1);
    assert.deepEqual([replies.auth, replies.args.channel, replies.args.ts], ['Bearer xoxb-northstar', 'C0A90TS44T1', '1790000000.000100'], 'the thread root, read as North Star');
    assert.equal(d.body.sources.thread.read, true);
    assert.equal(d.body.sources.thread.messages, 3);
    assert.equal(d.body.fields.implementation_checklist, 'Measure the loop overhead per step\nSwitch pulse generation to pigpio DMA', 'the checklist one step per line');
    assert.equal(d.body.fields.reusability, 'Broad', 'reusability normalised to the three values');
    assert.equal(d.body.fields.learnings_gotchas, '', 'an unsupported field stays empty');
    assert.ok(d.body.empty_fields.includes('integration_points') && d.body.empty_fields.includes('readiness_gates'));
    assert.equal('pattern_id' in d.body.fields, false, "the model's pattern_id is dropped");
    assert.equal('observability' in d.body.fields, false, 'a field no page shows is not drafted');
    assert.match(d.body.note, /Nothing is saved until you press Register/);
    assert.equal((await query(`SELECT count(*)::int n FROM engine_build_patterns WHERE fields->>'pattern_name' = $1`, ['DMA pulse generation for stepper accuracy'])).rows[0].n, 0, 'a draft saves nothing');
    assert.equal((await query(`SELECT fields->>'Status' s FROM engine_pattern_candidates WHERE natural_id = $1`, [cDraft])).rows[0].s, 'Proposed', 'the candidate is untouched');
    const draftLog = (await query(`SELECT outcome, detail FROM engine_writes WHERE endpoint = 'page:draft_pattern' AND natural_id = $1`, [cDraft])).rows;
    assert.equal(draftLog.length, 1);
    assert.equal(draftLog[0].outcome, 'read');
    assert.match(draftLog[0].detail, /thread 3 messages/);

    const unread = await mk('draft unread', 'https://bayshorizonnetwork.slack.com/archives/CNOTMEMBER/p1790000000000100');
    const d2 = await act(unread, 'draft', { actor_user_id: ARCH });
    assert.equal(d2.status, 200);
    assert.equal(d2.body.sources.thread.read, false);
    assert.match(d2.body.sources.thread.note, /not_in_channel — the North Star bot is not in that channel/);
    assert.match(d2.body.note, /the thread was not read/, 'a draft from the Summary alone says so');
    assert.match(seen.model.body.messages[1].content, /\(not read: Slack refused conversations\.replies: not_in_channel/);
    step('draft: the extractor’s model and prompt, Summary + thread (as North Star), unsupported fields empty, nothing saved');

    /* ---- register the draft, with the announcement refused ---- */
    failPost = 'C0B0668PRNW';
    const full = { ...d.body.fields, pattern_name: `Throwaway drafted ${T}`, learnings_gotchas: 'Edited by the architect before registering.' };
    const reg2 = await act(cDraft, 'register', { actor_user_id: BUILDER, pattern: full });
    failPost = null;
    assert.equal(reg2.status, 200, JSON.stringify(reg2.body));
    made.patterns.push(reg2.body.pattern_id);
    assert.match(reg2.body.pattern_id, /^BP-VFARM-\d+-[A-Z0-9]{4}$/);
    assert.equal(reg2.body.announced, false);
    assert.match(reg2.body.announcement_error, /not_in_channel — Bays is not a member of #bha-build-patterns/);
    assert.equal(reg2.body.candidate_updated, true, 'a failed post never undoes the registration');
    assert.equal(reg2.body.doc_created, true);
    assert.equal(reg2.body.ingested_to_bharag, true);
    const pat2 = (await query(`SELECT fields FROM engine_build_patterns WHERE natural_id = $1`, [reg2.body.pattern_id])).rows[0].fields;
    assert.equal(pat2.anti_pattern, full.anti_pattern, 'every drafted field is stored');
    assert.equal(pat2.test_coverage, full.test_coverage);
    assert.equal(pat2.learnings_gotchas, 'Edited by the architect before registering.', 'what was edited is what is stored');
    assert.equal(pat2.implementation_checklist, 'Measure the loop overhead per step | Switch pulse generation to pigpio DMA');
    assert.equal('integration_points' in pat2, false, 'an empty field is not written as an empty string');
    const r2 = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cDraft])).rows[0].fields;
    assert.deepEqual([r2.Status, r2['Pattern ID'], r2['Announcement Link']], ['Registered', reg2.body.pattern_id, undefined]);
    const failAudit = (await query(`SELECT outcome, detail FROM engine_mcp_writes WHERE tool = 'announce_pattern' AND natural_id = $1`, [reg2.body.pattern_id])).rows;
    assert.equal(failAudit[0].outcome, 'failed');
    assert.match(failAudit[0].detail, /not_in_channel/);
    step('register a draft: every field stored as edited; a refused post is reported and audited, the registration stands');

    /* ---- the audit ---- */
    const audit = (await query(`SELECT tool, kind, outcome, requester_user_id FROM engine_mcp_writes WHERE access = 'page' AND id > $1 ORDER BY id`, [auditFrom])).rows;
    const tools = audit.map((a) => `${a.tool}:${a.kind}:${a.outcome}`);
    assert.ok(tools.includes('update_record:pattern_candidates:updated'), tools.join(', '));
    assert.ok(tools.includes('create_record:patterns:inserted'), tools.join(', '));
    const pageLines = (await query(`SELECT endpoint, key_label FROM engine_writes WHERE natural_id = ANY($1) AND endpoint LIKE 'page:%'`, [[cReg, cDec, cRea, reg.body.pattern_id]])).rows;
    assert.ok(pageLines.some((l) => l.endpoint === 'page:create_record' && l.key_label === 'session cookie'), JSON.stringify(pageLines));
    assert.ok(pageLines.some((l) => l.endpoint === 'page:update_record'));
    step("audit: engine_mcp_writes access 'page', engine_writes page:<tool>");

    /* ---- the read connection never lists the page's access ---- */
    const list = await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { cookie: '' });
    assert.ok(list.body.result.tools.length > 10);
    step('MCP tools/list unaffected');
  } catch (e) {
    console.error(log.split('\n').slice(-30).join('\n'));
    throw e;
  } finally {
    // The throwaway announcement comes out of the channel, as Bays, the way it went in.
    for (const ts of [...posts.keys()]) {
      const r = await fetch(`http://127.0.0.1:${slackSrv.address().port}/api/chat.delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'C0B0668PRNW', ts }) }).then((x) => x.json());
      assert.equal(r.ok, true, 'announcement deleted');
    }
    // The throwaway rows go through the same delete path the tools use.
    for (const n of made.patterns) await mcp('delete_record', { kind: 'patterns', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    for (const n of made.candidates) await mcp('delete_record', { kind: 'pattern_candidates', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    for (const n of made.profiles) await mcp('delete_record', { kind: 'builder_profiles', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    const left = (await query(`SELECT (SELECT count(*) FROM engine_pattern_candidates WHERE natural_id = ANY($1)) + (SELECT count(*) FROM engine_build_patterns WHERE natural_id = ANY($2)) + (SELECT count(*) FROM engine_builder_profiles WHERE natural_id = ANY($3)) AS n`, [made.candidates, made.patterns, made.profiles])).rows[0].n;
    server.kill();
    google.close();
    slackSrv.close();
    openrouter.close();
    bharag.close();
    await closePool();
    assert.equal(Number(left), 0, 'every throwaway row deleted');
  }
  console.log(`test:candidates — ${passed.length} steps held:\n  ${passed.join('\n  ')}\n  every throwaway row and channel post deleted`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
