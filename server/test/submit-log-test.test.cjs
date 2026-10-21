// test_submit_log (21 Oct 2026, INC-BAYS.CODEX-036): the verdict on one Submit Actions run.
// Pure: no database, no network. Pins that a run passes only when the form check refused the
// submission, the note posted with Slack ok and says what to fix, the assert ran, and nothing
// past the check ran; and that each way it can fail is named.
const assert = require('node:assert/strict');
const path = require('node:path');
const { judge, MUST_NOT_RUN } = require(path.join(__dirname, '..', '..', 'server-dist', 'server', 'src', 'submitLogTest.js'));

const node = (json, status = 'success') => [{ executionStatus: status, data: { main: [[{ json }]] } }];
const URL_ERR = '• *Session URL* must be a full otter.ai or loom.com link (starting with https://). Check the URL and Description fields were not swapped.';
const TEXT = '<@U0AEW3TBYH1> :warning: *Your log submission needs a fix before it can go through:*\n\n' + URL_ERR + '\n\nRun `/submit-log` to send it again.';

function good() {
  return {
    status: 'success',
    data: { resultData: { runData: {
      'Extract Submission': node({ allFieldsValid: false, fieldErrors: [URL_ERR] }),
      'Delete Original Form 2': node({ error: 'Invalid URL' }),
      'Send Validation Error to Builder': node({ ok: true, channel: 'C0AFPJ5S1C1', ts: '1792556000.000100', message: { text: TEXT } }),
      'Assert Builder Told of Fix': node({ builder_told: true }),
    } } },
  };
}

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

check('a clean field-check run passes', () => {
  const v = judge(good(), 'swapped');
  assert.equal(v.pass, true, JSON.stringify(v.checks));
  assert.equal(v.note.ts, '1792556000.000100');
  assert.equal(v.note.channel, 'C0AFPJ5S1C1');
});

check('Slack refusing the note fails it and says so', () => {
  const e = good();
  e.data.resultData.runData['Send Validation Error to Builder'] = node({ ok: false, error: 'not_in_channel' });
  e.status = 'error';
  const v = judge(e, 'swapped');
  assert.equal(v.pass, false);
  assert.match(v.checks.find((c) => c.name.startsWith('the note posted')).detail, /not_in_channel/);
});

check('a submission that reached the scraper fails it, naming the node', () => {
  const e = good();
  e.data.resultData.runData['Kick Off Scrape'] = node({});
  const v = judge(e, 'swapped');
  assert.equal(v.pass, false);
  assert.match(v.checks.find((c) => c.name === 'nothing past the check ran').detail, /Kick Off Scrape/);
});

check('the old heading ("missing some required fields") fails the wording check', () => {
  const e = good();
  e.data.resultData.runData['Send Validation Error to Builder'][0].data.main[0][0].json.message.text = 'Your log submission is missing some required fields: ' + URL_ERR;
  assert.equal(judge(e, 'swapped').pass, false);
});

check('no assert means the Slack answer was never checked: fail', () => {
  const e = good();
  delete e.data.resultData.runData['Assert Builder Told of Fix'];
  assert.equal(judge(e, 'swapped').pass, false);
});

check('a passed form check is never a pass', () => {
  const e = good();
  e.data.resultData.runData['Extract Submission'] = node({ allFieldsValid: true, fieldErrors: [] });
  assert.equal(judge(e, 'swapped').pass, false);
});

check('missing_description expects the Description error', () => {
  const e = good();
  const DESC = '• *Session Description* is required.';
  e.data.resultData.runData['Extract Submission'] = node({ allFieldsValid: false, fieldErrors: [DESC] });
  e.data.resultData.runData['Send Validation Error to Builder'][0].data.main[0][0].json.message.text = 'needs a fix ' + DESC;
  assert.equal(judge(e, 'missing_description').pass, true);
  assert.equal(judge(e, 'swapped').pass, false);
});

check('no run found is a fail, not a pass', () => {
  assert.equal(judge(null, 'swapped').pass, false);
});

check('the scraper and the submission row are on the must-not-run list', () => {
  for (const name of ['Kick Off Scrape', 'Write to BHA Submissions (Airtable) · POST']) assert.ok(MUST_NOT_RUN.includes(name));
});

console.log(`\n${n} checks passed`);
