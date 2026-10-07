/**
 * transcribe_slack_audio (2026-10-07, LOOP-1791315402447-834A).
 *
 * No database and no network: the write log (`mirror.logWrite`) is replaced
 * by a recorder before the tool is loaded, and `fetch` by a stand-in for
 * Slack's Web API, files.slack.com and OpenRouter. What is pinned:
 *
 *   - only https://files.slack.com/ addresses and F… ids are taken;
 *   - a document is not_audio, a webm is unsupported_format;
 *   - the first model's transcript is returned, with the BHA names in the prompt;
 *   - the first model failing sends the same audio to the second (fallback_used);
 *   - both failing is all_models_failed, naming both;
 *   - a 402 is the account's and the second model is not asked;
 *   - "[no speech]" is no_speech, never an empty transcript;
 *   - the same file is one model call (cached);
 *   - every call writes one read line.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.AUDIO_TOOLS_DIST || path.join(__dirname, '../../server-dist');
process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-test';
process.env.OPENROUTER_API_KEY = 'sk-test';
process.env.OPENROUTER_AUDIO_MODEL = 'model/first';
process.env.OPENROUTER_AUDIO_FALLBACK_MODEL = 'model/second';
delete process.env.SLACK_API_URL;
delete process.env.SLACK_FILES_ORIGIN;
delete process.env.OPENROUTER_API_URL;

/* The write log, recorded instead of written. */
const logged = [];
const mirrorPath = require.resolve(path.join(DIST, 'server/src/mirror.js'));
require.cache[mirrorPath] = { id: mirrorPath, filename: mirrorPath, loaded: true, exports: { logWrite: async (l) => { logged.push(l); } } };

/* Slack and OpenRouter, stood in. */
const FILES = {
  F0AUDIO0001: { name: 'audio_message.m4a', filetype: 'm4a', mimetype: 'audio/mp4', duration_ms: 5200, url_private_download: 'https://files.slack.com/files-pri/T1-F0AUDIO0001/download/audio_message.m4a' },
  F0AUDIO0002: { name: 'second.m4a', filetype: 'm4a', mimetype: 'audio/mp4', url_private_download: 'https://files.slack.com/files-pri/T1-F0AUDIO0002/download/second.m4a' },
  F0AUDIO0003: { name: 'third.mp3', filetype: 'mp3', mimetype: 'audio/mpeg', url_private_download: 'https://files.slack.com/files-pri/T1-F0AUDIO0003/download/third.mp3' },
  F0AUDIO0004: { name: 'fourth.mp3', filetype: 'mp3', mimetype: 'audio/mpeg', url_private_download: 'https://files.slack.com/files-pri/T1-F0AUDIO0004/download/fourth.mp3' },
  F0AUDIO0005: { name: 'quiet.wav', filetype: 'wav', mimetype: 'audio/wav', url_private_download: 'https://files.slack.com/files-pri/T1-F0AUDIO0005/download/quiet.wav' },
  F0REPORT001: { name: 'report.pdf', filetype: 'pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/files-pri/T1-F0REPORT001/download/report.pdf' },
  F0WEBM00001: { name: 'clip.webm', filetype: 'webm', mimetype: 'audio/webm', url_private_download: 'https://files.slack.com/files-pri/T1-F0WEBM00001/download/clip.webm' },
};
/** What each model does next, per call: a function of the request body. */
let modelPlan = {};
const modelCalls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://slack.com/api/files.info') {
    const id = new URLSearchParams(String(init.body)).get('file');
    return FILES[id] ? json(200, { ok: true, file: { id, ...FILES[id] } }) : json(200, { ok: false, error: 'file_not_found' });
  }
  if (u.startsWith('https://files.slack.com/')) {
    assert.equal(init.headers.Authorization, 'Bearer xoxb-test', 'the file is fetched with the Bays bot token');
    assert.equal(init.redirect, 'manual', 'redirects are not followed');
    return new Response(Buffer.from('not-really-audio'), { status: 200, headers: { 'content-type': 'audio/mp4' } });
  }
  if (u === 'https://openrouter.ai/api/v1/chat/completions') {
    const body = JSON.parse(String(init.body));
    modelCalls.push(body);
    const plan = modelPlan[body.model];
    assert.ok(plan, `unexpected model ${body.model}`);
    return plan(body);
  }
  throw new Error(`unexpected fetch ${u}`);
};
const says = (text) => () => json(200, { choices: [{ message: { content: text } }] });
const fails = (status, message) => () => json(status, { error: { message } });

const { transcribeSlackAudio: tool, fileIdFromUrl } = require(path.join(DIST, 'server/src/mcp/audioTools.js'));
const call = (args) => tool.handler(args, { access: 'write' });
const step = (s) => console.log(`  ok  ${s}`);

(async () => {
  assert.equal(fileIdFromUrl('https://files.slack.com/files-pri/T0A1-F0BCD123/audio_message.m4a'), 'F0BCD123');
  assert.equal(fileIdFromUrl('https://files.slack.com/files-pri/T0A1-F0BCD123/download/a.m4a'), 'F0BCD123');
  step('file id read from a Slack file url');

  for (const bad of ['https://evil.com/files-pri/T1-F0AUDIO0001/a.m4a', 'http://files.slack.com/files-pri/T1-F0AUDIO0001/a.m4a', 'https://files.slack.com.evil.com/x', 'https://files.slack.com@evil.com/x']) {
    const r = await call({ url: bad });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_a_slack_file_url', bad);
  }
  assert.equal((await call({})).reason, 'missing_file');
  assert.equal((await call({ file_id: 'not-an-id' })).reason, 'not_a_slack_file_id');
  assert.equal((await call({ file_id: 'F0MISSING01' })).reason, 'file_not_found');
  assert.equal(modelCalls.length, 0, 'a refusal calls no model');
  step('refusals: not a Slack url, no file, bad id, unknown file');

  assert.equal((await call({ file_id: 'F0REPORT001' })).reason, 'not_audio');
  assert.equal((await call({ file_id: 'F0WEBM00001' })).reason, 'unsupported_format');
  assert.equal(modelCalls.length, 0);
  step('a document is not_audio and a webm is unsupported_format');

  /* The first model answers. */
  modelPlan = { 'model/first': says('Bays, how many open loops do I have?') };
  const a = await call({ url: FILES.F0AUDIO0001.url_private_download });
  assert.equal(a.ok, true);
  assert.equal(a.source, 'speech_model');
  assert.equal(a.model, 'model/first');
  assert.equal(a.fallback_used, undefined);
  assert.equal(a.text, 'Bays, how many open loops do I have?');
  assert.equal(a.file_id, 'F0AUDIO0001');
  assert.equal(a.duration_seconds, 5);
  assert.equal(a.truncated, false);
  assert.equal(modelCalls.length, 1);
  const sent = modelCalls[0].messages[0].content;
  assert.equal(sent[1].type, 'input_audio');
  assert.equal(sent[1].input_audio.format, 'm4a');
  assert.equal(Buffer.from(sent[1].input_audio.data, 'base64').toString(), 'not-really-audio');
  assert.match(sent[0].text, /Bays/, 'the prompt names Bays');
  assert.match(sent[0].text, /BHARAG/, 'the prompt carries BHA\'s words');
  step('first model: transcript, audio as base64 input_audio, BHA names in the prompt');

  const again = await call({ file_id: 'F0AUDIO0001' });
  assert.equal(again.cached, true);
  assert.equal(again.text, a.text);
  assert.equal(modelCalls.length, 1, 'the same file is one model call');
  step('the same file is served from the first answer');

  /* The first fails, the second answers. */
  modelCalls.length = 0;
  modelPlan = { 'model/first': fails(503, 'provider down'), 'model/second': says('Second model heard this.') };
  const b = await call({ file_id: 'F0AUDIO0002' });
  assert.equal(b.ok, true);
  assert.equal(b.model, 'model/second');
  assert.equal(b.fallback_used, true);
  assert.match(b.first_error, /model\/first: model_error/);
  assert.deepEqual(modelCalls.map((c) => c.model), ['model/first', 'model/second']);
  assert.equal(modelCalls[0].messages[0].content[1].input_audio.data, modelCalls[1].messages[0].content[1].input_audio.data, 'the same audio goes to the second model');
  step('first model down: the same audio goes to the second, marked fallback_used');

  /* Both fail. */
  modelCalls.length = 0;
  modelPlan = { 'model/first': fails(500, 'boom'), 'model/second': fails(400, 'Provider returned error') };
  const c = await call({ file_id: 'F0AUDIO0003' });
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'all_models_failed');
  assert.match(c.message, /model\/first/);
  assert.match(c.message, /model\/second/);
  assert.equal(c.text, undefined, 'a failure carries no transcript');
  step('both models down: all_models_failed, naming both');

  /* Out of credit: the account's, not the model's. */
  modelCalls.length = 0;
  modelPlan = { 'model/first': fails(402, 'Insufficient credits'), 'model/second': says('should never be asked') };
  const d = await call({ file_id: 'F0AUDIO0004' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'model_billing');
  assert.deepEqual(modelCalls.map((x) => x.model), ['model/first'], 'a 402 is not retried on the second model');
  step('402: model_billing, second model not asked');

  /* Silence. */
  modelCalls.length = 0;
  modelPlan = { 'model/first': says('[no speech]') };
  const e = await call({ file_id: 'F0AUDIO0005' });
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'no_speech');
  assert.equal(modelCalls.length, 1);
  step('[no speech] is no_speech, never an empty transcript');

  /* A failure is not remembered: the next ask tries again. */
  modelCalls.length = 0;
  modelPlan = { 'model/first': says('Now it works.') };
  const f = await call({ file_id: 'F0AUDIO0003' });
  assert.equal(f.ok, true);
  assert.equal(f.cached, undefined);
  step('a failed file is tried again on the next ask');

  assert.ok(logged.length >= 14, `one read line per call (${logged.length})`);
  for (const l of logged) {
    assert.equal(l.endpoint, 'mcp:transcribe_slack_audio');
    assert.equal(l.outcome, 'read');
  }
  assert.ok(logged.some((l) => /speech_model \(cached\)/.test(l.detail)));
  assert.ok(logged.some((l) => /all_models_failed/.test(l.detail)));
  step('every call writes one read line');

  console.log('audio-tools: all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
