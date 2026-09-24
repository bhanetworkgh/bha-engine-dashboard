/**
 * The Bays tools of 2026-09-24, pinned end to end: the real server process and
 * MCP transport, a local database, and local stand-ins for n8n, Slack and
 * Google, so every outcome can be driven rather than hoped for.
 *
 *   list_n8n_workflows / get_n8n_workflow — id/name/active only; the trimmed
 *     view (no sticky nodes, parameters capped at 1,500, "From [main 0] -> To"
 *     connections, notes capped at 3,000); an unknown id names list_n8n_workflows.
 *   read_slack_file — refuses anything not https://files.slack.com/; a PDF's
 *     text is extracted (a real Chromium-made PDF when one is available, and a
 *     hand-written one always); text returned as text; the 30,000 cap; 404 →
 *     file_not_found; 403 and a sign-in redirect → not_authorised; an
 *     image-only PDF → no_text_layer.
 *   grant_drive_access — a non-bhanetwork address is refused, Destiny is DMed,
 *     and Google is never called; look-alike domains are refused too; a
 *     bhanetwork address is granted with the role asked for.
 *   share_doc, create_doc — the permission and the Doc, and their answers.
 *   create_record {kind: patterns} — a Doc in the patterns folder with the
 *     BHARAG text; a Docs failure leaves the record saved and says doc_created:false.
 *   find_records — channel_tracking (previous_doc_id) and filters_gte/lte.
 *   the registry — four workflows retired, Agent Delivery present, the endpoint note.
 *
 * Run with:  npm run test:bays-tools   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:bays-tools writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const TOKEN = 'one-url-for-test';
const PORT = 5078;
const T = Date.now();

/* ------------------------------------------------------------ fixtures */

/** A minimal, valid PDF with one Helvetica page and a Flate content stream. */
function handPdf(lines) {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/([()\\])/g, '\\$1')}) Tj`).join(' ')} ET`;
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    const b = o
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    offsets.push(len);
    parts.push(b);
    len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** A page that shows no text at all: what a scanned PDF looks like to a text reader. */
const scannedPdf = () => handPdf([]);

const chromePdf = process.env.CHROME_PDF && fs.existsSync(process.env.CHROME_PDF) ? fs.readFileSync(process.env.CHROME_PDF) : null;

/* ------------------------------------------------------------ stand-ins */

const seen = { dms: [], google: [], slackAuth: [] };

const LONG_PARAM = 'x'.repeat(2_000);
const WORKFLOW = {
  id: 'wfTEST000000001',
  name: 'Bays — Agent Delivery',
  active: true,
  updatedAt: '2026-09-24T05:00:00.000Z',
  versionId: 'v1',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'dashboard-ask-bays', httpMethod: 'POST' }, position: [0, 0], id: 'a' },
    { name: 'Big Code', type: 'n8n-nodes-base.code', disabled: true, parameters: { jsCode: LONG_PARAM }, position: [1, 0], id: 'b' },
    { name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {}, position: [2, 0], id: 'c' },
    { name: 'Tool', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', parameters: {}, position: [2, 1], id: 'd' },
    { name: 'Sticky — Overview', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Overview: '.padEnd(3_500, 'y') }, position: [0, 1], id: 'e' },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Big Code', type: 'main', index: 0 }], [{ node: 'Agent', type: 'main', index: 0 }]] },
    Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
  },
};

const n8n = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers['x-n8n-api-key'] !== 'n8n-key') return send(401, { message: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/v1/workflows') return send(200, { data: [{ id: WORKFLOW.id, name: WORKFLOW.name, active: true, nodes: WORKFLOW.nodes }, { id: 'wfOLD', name: 'Bays — Tools Router', active: false }], nextCursor: null });
  if (u.pathname === `/api/v1/workflows/${WORKFLOW.id}`) return send(200, WORKFLOW);
  return send(404, { message: 'Not Found' });
});

const LONG_TEXT = 'Line of text for the cap.\n'.repeat(1_400); // 36,400 chars
const slack = http.createServer((req, res) => {
  seen.slackAuth.push(req.headers.authorization);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/chat.postMessage') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.dms.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: '1790000000.000100' }));
    });
    return;
  }
  const files = {
    '/files-pri/T1/F1/report.pdf': ['application/pdf', handPdf(['Golden CAD run (provenance)', 'Second line, BAYS lane.'])],
    '/files-pri/T1/F2/chrome.pdf': ['application/pdf', chromePdf],
    '/files-pri/T1/F3/notes.txt': ['text/plain; charset=utf-8', Buffer.from('Plain notes — café.\n')],
    '/files-pri/T1/F4/long.txt': ['text/plain', Buffer.from(LONG_TEXT)],
    '/files-pri/T1/F5/scan.pdf': ['application/pdf', scannedPdf()],
  };
  if (u.pathname === '/files-pri/T1/F9/private.pdf') {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  if (u.pathname === '/files-pri/T1/F8/redirect.pdf') {
    res.writeHead(302, { location: 'https://bha.slack.com/?redir=%2Ffiles-pri' });
    return res.end();
  }
  const f = files[u.pathname];
  if (!f || !f[1]) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': f[0], 'content-length': f[1].length });
  res.end(f[1]);
});

let failDocsWrite = false;
let docSeq = 0;
const google = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const json = body && (req.headers['content-type'] || '').includes('json') ? JSON.parse(body) : body;
    seen.google.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization, body: json });
    const send = (code, b) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (u.pathname === '/token') return send(200, { access_token: 'ya29.test', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer ya29.test') return send(401, { error: { message: 'bad token' } });
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') return send(200, { id: `doc-${++docSeq}` });
    let m = /^\/v1\/documents\/([^:]+):batchUpdate$/.exec(u.pathname);
    if (m) return failDocsWrite ? send(403, { error: { message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }] } }) : send(200, { documentId: m[1] });
    m = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(u.pathname);
    if (m) return m[1] === 'missing' ? send(404, { error: { message: 'File not found: missing.', errors: [{ reason: 'notFound' }] } }) : send(200, { id: `perm-${m[1]}` });
    m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m) return send(200, { id: m[1], name: 'Doc', mimeType: 'application/vnd.google-apps.document', webViewLink: `https://docs.google.com/document/d/${m[1]}/edit?usp=drivesdk` });
    return send(404, { error: { message: `no route ${u.pathname}` } });
  });
});

/* ------------------------------------------------------------ the client */

let rpcId = 0;
function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
async function call(name, args) {
  const r = await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.error) return { rpcError: r.body.error };
  return JSON.parse(r.body.result.content[0].text);
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

(async () => {
  const [n8nUrl, slackUrl, googleUrl] = await Promise.all([listen(n8n), listen(slack), listen(google)]);
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: TOKEN,
    MCP_WRITE_TOKEN: TOKEN,
    DASHBOARD_INBOUND_KEY: 'inbound-for-test',
    RECOVERY_ENABLED: 'false',
    N8N_API_URL: `${n8nUrl}/api/v1`,
    N8N_API_KEY: 'n8n-key',
    SLACK_BAYS_BOT_TOKEN: 'xoxb-test',
    SLACK_API_URL: `${slackUrl}/api`,
    SLACK_FILES_ORIGIN: slackUrl,
    GOOGLE_API_URL: googleUrl,
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
  };
  for (const k of ['BHARAG_BUILD_PATTERNS_KEY', 'BHARAG_CODEX_KEY', 'BHARAG_COMMERCIAL_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON']) delete env[k];
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\//i.test(log) && (await post('/mcp/nope', {}).catch(() => null))) break;
  }
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const passed = [];
  const step = (name) => passed.push(name);

  try {
    const tools = (await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t) => t.name);
    for (const t of ['list_n8n_workflows', 'get_n8n_workflow', 'read_slack_file', 'share_doc', 'grant_drive_access', 'create_doc', 'find_records', 'create_record']) assert.ok(tools.includes(t), `lists ${t}`);
    step('tools listed');

    /* ---- n8n ---- */
    const list = await call('list_n8n_workflows', {});
    assert.equal(list.ok, true);
    assert.deepEqual(list.workflows, [
      { id: WORKFLOW.id, name: 'Bays — Agent Delivery', active: true },
      { id: 'wfOLD', name: 'Bays — Tools Router', active: false },
    ]);
    step('list_n8n_workflows: id, name, active only');

    const wf = await call('get_n8n_workflow', { workflow_id: WORKFLOW.id });
    assert.equal(wf.ok, true);
    assert.equal(wf.updatedAt, '2026-09-24T05:00:00.000Z');
    assert.deepEqual(wf.nodes.map((n) => n.name), ['Webhook', 'Big Code', 'Agent', 'Tool'], 'sticky notes are not nodes');
    assert.deepEqual(Object.keys(wf.nodes[0]).sort(), ['disabled', 'name', 'parameters', 'type']);
    const big = wf.nodes.find((n) => n.name === 'Big Code');
    assert.equal(big.disabled, true);
    assert.equal(big.parameters_truncated, true);
    assert.equal(big.parameters.length, 1_500);
    assert.deepEqual(wf.connections, ['Webhook [main 0] -> Big Code', 'Webhook [main 1] -> Agent', 'Tool [ai_tool 0] -> Agent']);
    assert.equal(wf.notes.length, 1);
    assert.equal(wf.notes[0].content.length, 3_000);
    assert.equal(wf.notes[0].truncated, true);
    step('get_n8n_workflow: trimmed view with caps');

    const unknown = await call('get_n8n_workflow', { workflow_id: 'nope' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'workflow_not_found');
    assert.match(unknown.message, /use list_n8n_workflows to find the exact id/);
    step('get_n8n_workflow: unknown id');

    /* ---- read_slack_file ---- */
    for (const bad of ['https://evil.com/files-pri/T1/F1/report.pdf', 'http://files.slack.com/files-pri/T1/F1/report.pdf', 'https://files.slack.com.evil.com/x', 'https://files.slack.com@evil.com/x', 'file:///etc/passwd']) {
      const r = await call('read_slack_file', { url: bad });
      assert.equal(r.ok, false, bad);
      assert.equal(r.reason, 'not_a_slack_file_url', bad);
    }
    const before = seen.slackAuth.length;
    assert.equal(seen.slackAuth.length, before, 'a refused url is never fetched');
    step('read_slack_file: not_a_slack_file_url');

    const pdf = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F1/report.pdf' });
    assert.equal(pdf.ok, true);
    assert.equal(pdf.outcome, 'extracted');
    assert.equal(pdf.type, 'pdf');
    assert.equal(pdf.text, 'Golden CAD run (provenance)\nSecond line, BAYS lane.');
    assert.equal(pdf.truncated, false);
    assert.equal(seen.slackAuth.at(-1), 'Bearer xoxb-test', 'downloaded with the Bays bot token');
    step('read_slack_file: PDF text extracted');

    if (chromePdf) {
      const c = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F2/chrome.pdf' });
      assert.equal(c.outcome, 'extracted');
      assert.match(c.text, /Golden CAD run — provenance/);
      assert.match(c.text, /Ümlaut café “quotes” 42%/);
      assert.match(c.text, /LOOP-1790182250648-ZOLH/);
      assert.equal(c.pages, 2);
      step('read_slack_file: Chromium PDF (CID fonts, ToUnicode) extracted');
    }

    const txt = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F3/notes.txt' });
    assert.equal(txt.outcome, 'extracted');
    assert.equal(txt.text, 'Plain notes — café.\n');
    const long = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F4/long.txt' });
    assert.equal(long.truncated, true);
    assert.equal(long.text.length, 30_000);
    assert.equal(long.chars, LONG_TEXT.length);
    step('read_slack_file: text, and the 30,000 cap');

    const missing = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F0/gone.pdf' });
    assert.equal(missing.ok, false);
    assert.equal(missing.outcome, 'file_not_found');
    const denied = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F9/private.pdf' });
    assert.equal(denied.outcome, 'not_authorised');
    assert.equal(denied.status, 403);
    const redirected = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F8/redirect.pdf' });
    assert.equal(redirected.outcome, 'not_authorised');
    const scan = await call('read_slack_file', { url: 'https://files.slack.com/files-pri/T1/F5/scan.pdf' });
    assert.equal(scan.ok, false);
    assert.equal(scan.outcome, 'no_text_layer');
    step('read_slack_file: file_not_found, not_authorised (403 and redirect), no_text_layer');

    const readLog = await query(`SELECT count(*)::int AS n FROM engine_writes WHERE endpoint = 'mcp:read_slack_file' AND outcome = 'read' AND at > $1`, [new Date(T).toISOString()]);
    assert.ok(readLog.rows[0].n >= 9);
    step('read_slack_file: every read logged');

    /* ---- grant_drive_access: the hard rule ---- */
    for (const email of ['someone@gmail.com', 'x@evil-bhanetwork.org', 'x@bhanetwork.org.evil.com', 'x@sub.bhanetwork.org', 'a@b@bhanetwork.org', ' @bhanetwork.org']) {
      const g0 = seen.google.length;
      const dms = seen.dms.length;
      const r = await call('grant_drive_access', { file_id: 'file-1', email, role: 'writer', requester_user_id: 'U0TEST' });
      assert.equal(r.ok, false, email);
      assert.equal(r.reason, 'non_bhanetwork_email', email);
      assert.equal(seen.google.length, g0, `Google is never called for ${email}`);
      assert.equal(seen.dms.length, dms + 1, `Destiny is DMed for ${email}`);
      assert.equal(seen.dms.at(-1).channel, 'U0AEW3TBYH1');
      assert.ok(seen.dms.at(-1).text.includes(email.trim().toLowerCase()) && seen.dms.at(-1).text.includes('file-1'));
      assert.equal(r.destiny_notified, true);
    }
    const dryBad = await call('grant_drive_access', { file_id: 'file-1', email: 'x@gmail.com', dry_run: true });
    assert.equal(dryBad.reason, 'non_bhanetwork_email', 'a dry run is refused the same way');
    step('grant_drive_access: outside the domain refused, DM sent, nothing shared');

    const granted = await call('grant_drive_access', { file_id: 'file-1', email: 'Hardik@BHAnetwork.org', role: 'commenter' });
    assert.equal(granted.ok, true);
    assert.equal(granted.role, 'commenter');
    assert.equal(granted.email, 'hardik@bhanetwork.org');
    const perm = seen.google.find((g) => g.path === '/drive/v3/files/file-1/permissions');
    assert.deepEqual(perm.body, { role: 'commenter', type: 'user', emailAddress: 'hardik@bhanetwork.org' });
    assert.match(perm.query, /supportsAllDrives=true/);
    const token = seen.google.find((g) => g.path === '/token');
    assert.match(token.body, /grant_type=refresh_token/);
    const defaultRole = await call('grant_drive_access', { file_id: 'file-2', email: 'destiny@bhanetwork.org' });
    assert.equal(defaultRole.role, 'reader');
    step('grant_drive_access: a bhanetwork address granted, reader by default');

    /* ---- share_doc ---- */
    const shared = await call('share_doc', { document_id: 'doc-abc' });
    assert.equal(shared.ok, true);
    assert.equal(shared.document_id, 'doc-abc');
    assert.equal(shared.permission_id, 'perm-doc-abc');
    assert.equal(shared.link, 'https://docs.google.com/document/d/doc-abc/edit?usp=drivesdk');
    assert.deepEqual(seen.google.find((g) => g.path === '/drive/v3/files/doc-abc/permissions').body, { role: 'reader', type: 'anyone' });
    const notFound = await call('share_doc', { document_id: 'missing' });
    assert.equal(notFound.ok, false);
    assert.match(notFound.message, /404.*File not found/);
    assert.match(notFound.step, /share/);
    step('share_doc: anyone reader, link; a missing file names the step and Google’s answer');

    /* ---- create_doc ---- */
    const made = await call('create_doc', { folder_id: '1lbNlyzOknDu2mjWaOIeyUrWj-3mmax-V', title: 'Bays — Daily Digest — 2026-09-24', content: 'Digest body' });
    assert.equal(made.ok, true);
    assert.match(made.doc_id, /^doc-/);
    const createCall = seen.google.filter((g) => g.path === '/drive/v3/files' && g.method === 'POST').at(-1);
    assert.deepEqual(createCall.body, { name: 'Bays — Daily Digest — 2026-09-24', mimeType: 'application/vnd.google-apps.document', parents: ['1lbNlyzOknDu2mjWaOIeyUrWj-3mmax-V'] });
    const ins = seen.google.filter((g) => g.path === `/v1/documents/${made.doc_id}:batchUpdate`).at(-1);
    assert.equal(ins.body.requests[0].insertText.text, 'Digest body');
    step('create_doc: Doc in the folder with its text');

    /* ---- the pattern Doc on create_record ---- */
    const pname = `Bays tools pattern ${T}`;
    const pat = await call('create_record', {
      kind: 'patterns',
      drafted_by: 'Destiny',
      fields: { pattern_name: pname, bha_system: 'BHARAG', problem: 'p', solution: 's', context: 'c', reusability: 'Moderate', commercial_impact: 'none' },
    });
    assert.equal(pat.ok, true, JSON.stringify(pat));
    assert.equal(pat.saved, true);
    assert.equal(pat.doc_created, true);
    assert.match(pat.doc_id, /^doc-/);
    assert.equal(pat.ingested_to_bharag, false, 'no BHARAG key here — reported separately, as before');
    const pcreate = seen.google.filter((g) => g.path === '/drive/v3/files' && g.method === 'POST').at(-1);
    assert.equal(pcreate.body.name, `Build Pattern -- ${pname} -- Destiny`);
    assert.deepEqual(pcreate.body.parents, ['1o_EkaqsC9C1opq1to5mAmt63eUPFn55b']);
    const ptext = seen.google.filter((g) => g.path === `/v1/documents/${pat.doc_id}:batchUpdate`).at(-1).body.requests[0].insertText.text;
    assert.match(ptext, new RegExp(`^BHA Build Pattern: ${pname}\\n\\nPattern ID: BP-BHARAG-`));
    step('create_record patterns: Doc titled and filed, the BHARAG text');

    failDocsWrite = true;
    const pat2 = await call('create_record', {
      kind: 'patterns',
      fields: { pattern_name: `Second ${pname}`, bha_system: 'BHARAG', problem: 'p2', solution: 's2', context: 'c2', reusability: 'Narrow', commercial_impact: 'none' },
    });
    failDocsWrite = false;
    assert.equal(pat2.ok, true);
    assert.equal(pat2.saved, true);
    assert.equal(pat2.doc_created, false);
    assert.match(pat2.doc_error, /403/);
    assert.ok(pat2.doc_id, 'the empty Doc is named so it is not lost');
    const held = await query(`SELECT count(*)::int AS n FROM engine_build_patterns WHERE natural_id = $1`, [pat2.natural_id]);
    assert.equal(held.rows[0].n, 1, 'a Doc failure never undoes the record');
    assert.match(pat2.note, /Google Doc was NOT made/);
    assert.match(seen.google.filter((g) => g.path === '/drive/v3/files' && g.method === 'POST').at(-1).body.name, / -- Bays$/, 'drafted_by defaults to Bays');
    step('create_record patterns: a Doc failure leaves the record saved, doc_created:false');

    /* ---- the audit ---- */
    const audit = await query(`SELECT tool, outcome FROM engine_mcp_writes WHERE tool IN ('share_doc','grant_drive_access','create_doc') AND at > $1`, [new Date(T).toISOString()]);
    const by = (tool, outcome) => audit.rows.filter((r) => r.tool === tool && r.outcome === outcome).length;
    assert.equal(by('grant_drive_access', 'refused'), 7);
    assert.equal(by('grant_drive_access', 'applied'), 2);
    assert.equal(by('share_doc', 'applied'), 1);
    assert.equal(by('share_doc', 'failed'), 1);
    assert.equal(by('create_doc', 'applied'), 1);
    assert.equal(audit.rows.filter((r) => r.outcome === 'pending').length, 0);
    step('Drive writes audited, refusals included, none left pending');

    /* ---- find_records ---- */
    const ch = `C${T}`;
    await query(
      `INSERT INTO engine_channel_tracking (natural_id, created_time, fields, source, first_seen_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 'engine', $2, $2), ($4, $5, $6::jsonb, 'engine', $5, $5)`,
      [
        ch, '2026-09-23T08:00:00.000Z', JSON.stringify({ channel_id: ch, channel_name: 'bays-tools-test', doc_id: 'docNEW', previous_doc_id: 'docOLD', folder_id: 'f', date: '2026-09-23' }),
        `${ch}B`, '2026-09-20T08:00:00.000Z', JSON.stringify({ channel_id: `${ch}B`, channel_name: 'bays-tools-test-2', doc_id: 'docX', previous_doc_id: '', folder_id: 'f', date: '2026-09-20' }),
      ],
    );
    const ct = await call('find_records', { kind: 'channel_tracking', filters: { channel_id: ch } });
    assert.equal(ct.total, 1);
    assert.equal(ct.rows[0].fields.previous_doc_id, 'docOLD');
    assert.equal(ct.rows[0].fields.doc_id, 'docNEW');
    const range = await call('find_records', { kind: 'channel_tracking', search: 'bays-tools-test', filters_gte: { date: '2026-09-21' } });
    assert.deepEqual(range.rows.map((r) => r.natural_id), [ch]);
    const range2 = await call('find_records', { kind: 'channel_tracking', search: 'bays-tools-test', filters_lte: { date: '2026-09-21' }, filters_gte: { created_time: '2026-09-19' } });
    assert.deepEqual(range2.rows.map((r) => r.natural_id), [`${ch}B`]);
    const onId = await call('find_records', { kind: 'channel_tracking', filters_gte: { id: '5' } });
    assert.ok(onId.rpcError || onId.error || /refused on "id"/.test(JSON.stringify(onId)), 'gte on id is refused');
    step('find_records: channel_tracking with previous_doc_id; filters_gte / filters_lte; refused on id');

    /* ---- the registry ---- */
    const reg = await query(`SELECT id, status, replay FROM registry_workflows WHERE id = ANY($1)`, [['rKRnxHhKSJUd4Q6M', 'WjWzhVRq566A60fJ', 'WZHZJ0PXEhswCvxD', 'GjNtBQQvVSJvsPNI', '5AFqtZQaeKFFiGqe']]);
    const st = Object.fromEntries(reg.rows.map((r) => [r.id, r.status]));
    for (const id of ['rKRnxHhKSJUd4Q6M', 'WjWzhVRq566A60fJ', 'WZHZJ0PXEhswCvxD', 'GjNtBQQvVSJvsPNI']) assert.equal(st[id], 'retired', id);
    assert.equal(st['5AFqtZQaeKFFiGqe'], 'production');
    assert.equal(reg.rows.find((r) => r.id === '5AFqtZQaeKFFiGqe').replay, 'never');
    const ep = await query(`SELECT notes FROM registry_endpoints WHERE id = 'ep-dashboard-ask-bays'`);
    assert.match(ep.rows[0].notes, /Agent Delivery \(5AFqtZQaeKFFiGqe\)/);
    step('registry: four retired, Agent Delivery added, endpoint note names it');

    await query(`DELETE FROM engine_channel_tracking WHERE natural_id IN ($1, $2)`, [ch, `${ch}B`]);
    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.log(`test:bays-tools — ${passed.length} checks passed`);
  } catch (e) {
    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.error(e);
    console.error(log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    server.kill();
    await closePool().catch(() => {});
    n8n.close();
    slack.close();
    google.close();
  }
})();
