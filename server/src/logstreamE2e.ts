/**
 * LogStream end to end (10 Nov 2026, Destiny: "build a way that enables you do this whole testing, end to end,
 * without me manually submitting"). Jason's LogStream checks (DM D0AF0DG8ZPY 1794237173.152349) proved on real
 * Bays — Submit Actions runs, not on rows written by hand.
 *
 * Each case is one TEST log sent through Submit Actions exactly as Bays — Front Door hands a log form over, by n8n's
 * `Engine — LogStream E2E Runner` (POST /webhook/logstream-e2e, x-dashboard-key). The log is a typed one (summary and
 * full transcript), the path a builder takes when there is no recording, so nothing is scraped. Its Session URL is
 * `https://otter.ai/u/TEST-LOGSTREAM-<run>-<case>`, which is how every row, run and post of this test is found again and
 * how cleanup knows it may delete them: nothing without that prefix is touched.
 *
 * The steps, one per call:
 *   submit   the case's log goes in. Layer 0, the earlier-work check and Layer 1 run for real (several minutes).
 *   answer   relog_undeclared only: the runner presses "Complete & Send" on its parked row with the earlier-work
 *            answer filled in (it continues the earlier log, and what is new), as the builder would.
 *   judge    reads the Codex row, the parked row and the Submit Actions run back and passes or fails each check,
 *            including the Approve button's value the pop-up opens on.
 *   cleanup  deletes this run's TEST Codex rows (record_deletions first), its parked rows, Jason's review cards in
 *            #bha-log-reviews and any parked notices. No pay note is ever written: nothing here is approved.
 *
 * What it does not prove: the Approve click itself. Slack opens that pop-up only from a person's click.
 */
import * as n8n from './n8n';
import * as slack from './slack';
import * as mirror from './mirror';
import { query } from './pg';
import { findParkedPost, resolve as resolveParked, LOG_REVIEW_CHANNEL } from './layer0Void';

export const RUNNER_PATH = '/webhook/logstream-e2e';
export const SUBMIT_ACTIONS_ID = 'YTpezWSOIN6TNYcX';
export const URL_PREFIX = 'https://otter.ai/u/TEST-LOGSTREAM-';
export const CASES = ['relog_undeclared', 'local_only', 'silent_failure'] as const;
export type E2eCase = (typeof CASES)[number];
export const STEPS = ['submit', 'answer', 'judge', 'status', 'cleanup'] as const;
export type E2eStep = (typeof STEPS)[number];

/** The earlier log the re-log case continues: Destiny's own approved log of 9 Nov. */
export const EARLIER_LOG = 'CODEX-20261109-destiny-arupi-proof-type-gate';

export class E2eError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export const sessionUrl = (run: string, c: E2eCase) => `${URL_PREFIX}${run}-${c}`;
export const cleanRun = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);

const COMMON = [
  'Mission fit: this moves the BHA engine pay pipeline, the Codex review that decides what a builder is paid for.',
  'Errors and blockers: none this session.',
  'Next step: run the check on the next real log and read the result on the dashboard.',
  'Commercial impact: honest pay records are what let BHA show buyers and investors that the engine counts real work, so it supports the vFarm founding-buyer story.',
];

/**
 * The three TEST logs. Each is written so the review has one clear answer; the checks below test that the answer
 * reached the Codex row, the suggestion and the card, not the review's wording.
 */
export function caseLog(c: E2eCase, run: string): { description: string; summary: string; transcript: string } {
  const head = `TEST log for the LogStream end-to-end check, run ${run}. Not real work; it is deleted after the check.`;
  if (c === 'relog_undeclared') {
    return {
      description: `TEST -- LogStream e2e ${run}: continues earlier work, not declared`,
      summary: 'TEST. Carried on with the proof type gate on Codex claims.',
      transcript: [
        head,
        `Today I carried on with the proof type gate from ${EARLIER_LOG}, the gate that refuses a works-now claim with no proof type.`,
        'I went back over the gate, walked through how it reads the tag, and showed it refusing an untagged claim again.',
        ...COMMON,
        'Proof: the gate refused an untagged claim in execution 78301, proof type: test_forced.',
      ].join('\n'),
    };
  }
  if (c === 'local_only') {
    return {
      description: `TEST -- LogStream e2e ${run}: new work, local only`,
      summary: 'TEST. A new log validator, built and run on my machine only.',
      transcript: [
        head,
        'This is new work: nothing in it was logged before.',
        'I wrote a new log validator that checks every Codex row has a session date. It is on a local branch on my laptop only. It is not pushed, there is no pull request, it is not merged, and nothing in the engine calls it yet, so it is not hooked up to anything and has produced no real event.',
        ...COMMON,
        'Proof: I ran it by hand on my laptop against a copy of three rows and it flagged the one with no date, proof type: test_forced. No live run.',
      ].join('\n'),
    };
  }
  return {
    description: `TEST -- LogStream e2e ${run}: new work, live, with a silent failure`,
    summary: 'TEST. A new ledger writer, merged and live, with one path that fails silently.',
    transcript: [
      head,
      'This is new work: nothing in it was logged before.',
      'I built a ledger writer that records each builder run. It is merged in pull request 901 with CI green, it is called by the live Submit Actions workflow, and it wrote its first real record in execution 78410, proof type: live_natural.',
      'One gap I found and have not fixed: when the workspace key is missing, the writer returns early and writes nothing, with no error, no alert and no incident, so a missing key would go unnoticed. That is a silent failure.',
      ...COMMON,
    ].join('\n'),
  };
}

/** The earlier-work answer the builder gives on the parked form, for the re-log case. */
export function relogAnswer(): { relog: 'RELOG_OLD_WORK'; relog_of: string; relog_delta: string } {
  return {
    relog: 'RELOG_OLD_WORK',
    relog_of: EARLIER_LOG,
    relog_delta: 'A new read-back check on the proof type gate: it re-reads each saved claim and refuses one whose tag did not land. Merged in pull request 902 with CI green, live in Submit Actions, and it refused a real untagged claim in execution 78420, proof type: live_natural.',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Judging. Pure, so the test pins it.

export interface Rows {
  codex: { id: string; fields: Record<string, unknown> } | null;
  layer0: { id: string; fields: Record<string, unknown> } | null;
  card: { blocks: unknown[] | null; button: string | null } | null;
}

const parse = (v: unknown): any => {
  if (v && typeof v === 'object') return v;
  try {
    return JSON.parse(String(v ?? ''));
  } catch {
    return null;
  }
};

/** The suggestion the Approve pop-up opens on: the fourth part of the button value, as the modal reads it. */
export function buttonSuggestion(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  const i = value.split('|', 3).join('|').length;
  const rest = value.slice(i + 1);
  return rest ? parse(rest) : null;
}

export function judge(c: E2eCase, step: 'submit' | 'answer', r: Rows): { pass: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass: !!pass, detail });
  const f = r.codex?.fields ?? {};
  const sug = parse(f['Pay Suggestion']);
  const parts = parse(f['Work Parts']);
  add('the log reached Jason as a Codex row', !!r.codex, r.codex ? `row ${r.codex.id}, Submission ID ${String(f['Submission ID'] ?? '?')}` : 'no Codex row with this Session URL');
  add('the review wrote its work parts', Array.isArray(parts) && parts.length > 0, Array.isArray(parts) ? `${parts.length} part(s): ${parts.map((p: any) => p.what).join('; ').slice(0, 300)}` : `Work Parts: ${String(f['Work Parts'] ?? 'missing').slice(0, 120)}`);
  add('the dashboard worked out a suggested pay note', !!sug && !!sug.pay_recommendation, sug ? String(sug.line ?? JSON.stringify(sug)).slice(0, 300) : 'no Pay Suggestion on the row');

  if (c === 'relog_undeclared' && step === 'submit') {
    const l0 = r.layer0?.fields ?? {};
    const missing = parse(l0['Missing Fields']) ?? [];
    add('the log was parked', !!r.layer0 && String(l0.Status) === 'pending_builder_input', r.layer0 ? `parked row ${r.layer0.id}, Status ${String(l0.Status)}` : 'no parked row with this Session URL');
    add('it was parked for the earlier-work question', Array.isArray(missing) && missing.includes('relog'), `Missing Fields: ${JSON.stringify(missing)}`);
    add('Jason\'s card says incomplete', /incomplete/i.test(JSON.stringify(r.card?.blocks ?? '')), r.card ? 'card read from the run' : 'no card in the run');
  } else if (c === 'relog_undeclared') {
    const l0 = r.layer0?.fields ?? {};
    add('the parked row was completed with the answer', String(l0.Status) === 'completed' && /RELOG_OLD_WORK/.test(String(l0['Relog Answer'] ?? '')), `Status ${String(l0.Status)}; Relog Answer: ${String(l0['Relog Answer'] ?? 'none').slice(0, 200)}`);
    add('the review classed it a re-log', String(f['Log Class']) === 'RELOG_OLD_WORK', `Log Class ${String(f['Log Class'] ?? 'missing')}`);
    add('it names the earlier log', String(f['Relog Of'] ?? '').includes(EARLIER_LOG) || String(sug?.relog_of ?? '').includes(EARLIER_LOG), `Relog Of: ${String(f['Relog Of'] ?? 'missing')}`);
    add('it says what is new', String(f['Relog Delta'] ?? '').trim().length > 10, `Relog Delta: ${String(f['Relog Delta'] ?? 'missing').slice(0, 200)}`);
    add('the old work is docked, never paid again', !!sug && Number(sug.docked_share) > 0 && sug.reason_tag === 'RELOG_OLD_WORK', sug ? `credited ${sug.credited_share}, held ${sug.held_share}, docked ${sug.docked_share}, tag ${sug.reason_tag}` : 'no suggestion');
    add('only the new part is credited', !!sug && Number(sug.credited_share) > 0 && Number(sug.credited_share) < 1, sug ? `credited ${sug.credited_share}` : 'no suggestion');
    add('Jason\'s card now reads complete', /Complete, ready to approve|Complete\./.test(JSON.stringify(r.card?.blocks ?? '')), r.card ? 'card read from the resubmission run' : 'no card in the run');
  } else if (c === 'local_only') {
    add('nothing is credited now', !!sug && Number(sug.credited_share) === 0, sug ? `credited ${sug.credited_share}` : 'no suggestion');
    // Jason's proof levels (10 Nov 2026): code on a laptop that nobody else can open is level 0.
    add('all of it is held, INSUFFICIENT_PROOF', !!sug && Number(sug.held_share) === 1 && sug.reason_tag === 'INSUFFICIENT_PROOF', sug ? `held ${sug.held_share}, tag ${sug.reason_tag}` : 'no suggestion');
    add('it says what releases it', !!sug && /artefact|PR|pull request|branch/i.test(String(sug.release_condition ?? '')), sug ? `Held until: ${String(sug.release_condition ?? 'none').slice(0, 300)}` : 'no suggestion');
  } else {
    const flags: string[] = Array.isArray(sug?.flags) ? sug.flags : [];
    add('the silent failure is the first red flag', /^Silent failure/.test(flags[0] ?? ''), flags.length ? flags[0].slice(0, 300) : 'no flags');
    add('the silent part is held, not paid', !!sug && Number(sug.held_share) > 0, sug ? `credited ${sug.credited_share}, held ${sug.held_share}` : 'no suggestion');
    add('its release needs the silent path to write a record', !!sug && /record|alert|error|raise/i.test(String(sug.release_condition ?? '')), sug ? `Held until: ${String(sug.release_condition ?? 'none').slice(0, 300)}` : 'no suggestion');
  }

  if (!(c === 'relog_undeclared' && step === 'submit')) {
    const cardText = JSON.stringify(r.card?.blocks ?? '');
    add('Jason\'s card shows the suggested pay', cardText.includes('Suggested pay'), r.card ? (cardText.includes('Suggested pay') ? 'Suggested pay section is on the card' : 'no Suggested pay section') : 'no card in the run');
    if (c === 'silent_failure') add('the card shows the red flag', cardText.includes(':red_circle: Silent failure'), cardText.includes(':red_circle: Silent failure') ? 'red flag on the card' : 'no red flag on the card');
    const b = buttonSuggestion(r.card?.button ?? null);
    const same = !!b && !!sug && b.r === sug.pay_recommendation && Number(b.c) === Number(sug.credited_share) && Number(b.h) === Number(sug.held_share) && String(b.t ?? '') === String(sug.reason_tag ?? '');
    add('the Approve pop-up would open on the suggestion', same, b ? `button: ${b.r}, credited ${b.c}, held ${b.h}, tag ${b.t || 'none'}` : 'no suggestion on the Approve button');
    add('the button fits Slack\'s 2,000 characters', !!r.card?.button && r.card.button.length <= 2000, r.card?.button ? `${r.card.button.length} characters` : 'no button');
  }
  return { pass: checks.every((x) => x.pass), checks };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading back.

async function codexRow(url: string) {
  const r = await query<{ id: string; fields: Record<string, unknown> }>(`SELECT id::text, fields FROM engine_codex_submissions WHERE fields->>'Session Url' = $1 ORDER BY id DESC LIMIT 2`, [url]);
  return r.rows;
}
async function layer0Row(url: string) {
  const r = await query<{ id: string; fields: Record<string, unknown> }>(`SELECT id::text, fields FROM engine_layer0_holds WHERE fields->>'Session URL' = $1 ORDER BY id DESC LIMIT 2`, [url]);
  return r.rows;
}

type RunData = Record<string, Array<{ data?: { main?: Array<Array<{ json?: Record<string, unknown> }> | null> } }>>;
const first = (rd: RunData, node: string) => rd[node]?.[0]?.data?.main?.[0]?.[0]?.json ?? null;

/** The newest Submit Actions run that wrote this log, and the card it built. */
async function cardFor(url: string, wantResubmit: boolean): Promise<{ execution_id: string; blocks: unknown[] | null; button: string | null } | null> {
  const runs = (await n8n.recentExecutions(SUBMIT_ACTIONS_ID, 25)).filter((e) => n8n.TERMINAL.has(e.status));
  for (const e of runs) {
    const d = (await n8n.executionDetail(e.id)) as unknown as { data?: { resultData?: { runData?: RunData } } } | null;
    const rd = d?.data?.resultData?.runData ?? {};
    const prep = first(rd, 'Prepare Submission Data');
    if (!prep || String(prep['Session Url']) !== url) continue;
    if (wantResubmit !== !!rd['Build Merged Submission For Layer 1']) continue;
    const payload = first(rd, 'Build Layer 1 Payload');
    const blocks = parse(payload?.blocks)?.blocks ?? null;
    const actions = Array.isArray(blocks) ? blocks.find((b: any) => b.type === 'actions') : null;
    const button = actions ? String((actions.elements ?? []).find((x: any) => x.action_id === 'approve_log')?.value ?? '') || null : null;
    return { execution_id: e.id, blocks, button };
  }
  return null;
}

async function callRunner(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) throw new E2eError('not_configured', 'DASHBOARD_INBOUND_KEY is not set on this server, and the runner webhook is authenticated by it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${n8n.n8nHost()}${RUNNER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const json = parse(text);
    if (res.status === 404) throw new E2eError('runner_not_active', 'The runner webhook answered 404: the workflow is not published.');
    if (res.status === 401 || res.status === 403) throw new E2eError('runner_unauthorised', `The runner refused the dashboard key (HTTP ${res.status}).`);
    if (res.status === 422) throw new E2eError(String(json?.reason ?? 'runner_refused'), String(json?.message ?? text).slice(0, 300));
    if (res.status >= 300 || !json) throw new E2eError('runner_failed', `The runner answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json;
  } catch (e) {
    if (e instanceof E2eError) throw e;
    throw new E2eError('runner_unreachable', e instanceof Error && e.name === 'AbortError' ? 'The runner did not answer within 30 seconds.' : 'Could not reach the n8n runner.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The steps.

export async function submit(o: { requester: string; channel_id: string; run: string; case: E2eCase }) {
  const url = sessionUrl(o.run, o.case);
  if ((await codexRow(url)).length || (await layer0Row(url)).length) throw new E2eError('already_submitted', `Run ${o.run} already sent ${o.case}. Judge it, or clean the run up and use a new run label.`);
  const log = caseLog(o.case, o.run);
  const answer = await callRunner({ kind: 'submit', user_id: o.requester, channel_id: o.channel_id, session_url: url, ...log });
  return { started: true, case: o.case, session_url: url, runner: answer, next: 'The review takes a few minutes. Call step judge (or status) for this case.' };
}

export async function answer(o: { requester: string; channel_id: string; run: string }) {
  const url = sessionUrl(o.run, 'relog_undeclared');
  const rows = await layer0Row(url);
  const row = rows[0];
  if (!row) throw new E2eError('not_parked', 'No parked row for this run\'s relog_undeclared log yet. Submit it and wait for it to be parked.');
  if (String(row.fields.Status) !== 'pending_builder_input') throw new E2eError('not_pending', `The parked row ${row.id} is ${String(row.fields.Status)}, not waiting on the builder.`);
  const missing: string[] = parse(row.fields['Missing Fields']) ?? [];
  const a = relogAnswer();
  const answers: Record<string, string> = {
    mission_fit: COMMON[0], error_fix: COMMON[1], next_step: COMMON[2], commercial: COMMON[3],
    proof_type: 'The read-back check refused a real untagged claim in execution 78420, proof type: live_natural.',
  };
  const res = await callRunner({ kind: 'answer', user_id: o.requester, channel_id: o.channel_id, layer0_row_id: row.id, session_url: url, missing, answers, ...a });
  return { started: true, parked_row: row.id, missing, answered: a, runner: res, next: 'The review runs again on the full log. Call step judge for relog_undeclared in a few minutes.' };
}

export async function status(run: string) {
  const out: Record<string, unknown> = {};
  for (const c of CASES) {
    const url = sessionUrl(run, c);
    const cx = (await codexRow(url))[0];
    const l0 = (await layer0Row(url))[0];
    out[c] = {
      codex: cx ? { id: cx.id, submission_id: cx.fields['Submission ID'] ?? null, log_class: cx.fields['Log Class'] ?? null, has_suggestion: !!cx.fields['Pay Suggestion'], card_ts: cx.fields['Review Card TS'] ?? null } : null,
      parked: l0 ? { id: l0.id, status: l0.fields.Status ?? null, missing: parse(l0.fields['Missing Fields']) } : null,
    };
  }
  return out;
}

export async function judgeCase(run: string, c: E2eCase) {
  const url = sessionUrl(run, c);
  const cx = (await codexRow(url))[0] ?? null;
  const l0 = (await layer0Row(url))[0] ?? null;
  const resubmitted = c === 'relog_undeclared' && String(l0?.fields.Status) === 'completed';
  const step: 'submit' | 'answer' = resubmitted ? 'answer' : 'submit';
  const card = n8n.n8nConfigured() ? await cardFor(url, resubmitted) : null;
  const v = judge(c, step, { codex: cx, layer0: l0, card });
  return { case: c, after: step, session_url: url, ...v, execution_id: card?.execution_id ?? null, execution_url: card ? n8n.executionUrl(SUBMIT_ACTIONS_ID, card.execution_id) : null };
}

/** Deletes only rows and posts whose Session URL starts with this run's TEST prefix. */
export async function cleanup(run: string, actor: string) {
  const done: string[] = [];
  const failed: string[] = [];
  const prefix = `${URL_PREFIX}${run}-`;
  const cx = await query<{ id: string; fields: Record<string, unknown> }>(`SELECT id::text, fields FROM engine_codex_submissions WHERE fields->>'Session Url' LIKE $1 || '%'`, [prefix]);
  for (const row of cx.rows) {
    const ts = String(row.fields['Review Card TS'] ?? '');
    const ch = String(row.fields['Review Card Channel'] ?? LOG_REVIEW_CHANNEL);
    if (ts) {
      const r = await slack.botCall('chat.delete', { channel: ch, ts });
      if (r.ok || r.error === 'message_not_found') done.push(`deleted Jason's review card ${ts}`);
      else failed.push(`review card ${ts}: Slack said ${String(r.error)}`);
    }
    const pay = await query(`SELECT 1 FROM engine_pay_notes WHERE submission_id = $1 LIMIT 1`, [String(row.fields['Submission ID'] ?? '')]);
    if (pay.rows.length) {
      failed.push(`Codex row ${row.id} carries a pay note, so it was left alone`);
      continue;
    }
    const gone = await mirror.deleteRow('codex', Number(row.id), `LogStream e2e test run ${run}`, actor);
    gone ? done.push(`deleted TEST Codex row ${row.id} (${String(row.fields['Submission ID'] ?? '')})`) : failed.push(`Codex row ${row.id} was already gone`);
  }
  const l0 = await query<{ id: string; fields: Record<string, unknown> }>(`SELECT id::text, fields FROM engine_layer0_holds WHERE fields->>'Session URL' LIKE $1 || '%'`, [prefix]);
  for (const row of l0.rows) {
    try {
      const found = await findParkedPost(await resolveParked(row.id));
      if (found.ok && found.ts) {
        const r = await slack.botCall('chat.delete', { channel: LOG_REVIEW_CHANNEL, ts: found.ts });
        r.ok || r.error === 'message_not_found' ? done.push(`deleted the parked notice ${found.ts}`) : failed.push(`parked notice ${found.ts}: Slack said ${String(r.error)}`);
      }
    } catch (e) {
      failed.push(`parked notice for row ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const gone = await mirror.deleteRow('layer0', Number(row.id), `LogStream e2e test run ${run}`, actor);
    gone ? done.push(`deleted TEST parked row ${row.id}`) : failed.push(`parked row ${row.id} was already gone`);
  }
  return { ok: failed.length === 0, done, failed, note: 'The ephemeral notes in the channel were only ever visible to you and go on their own.' };
}
