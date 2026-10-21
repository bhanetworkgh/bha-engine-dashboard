/**
 * The log-form field check (2026-10-21, Destiny — INC-BAYS.CODEX-036).
 *
 * Kavin swapped Session URL and Description on 20 Oct, the title reached the Loom scraper and
 * the run failed. Bays — Submit Actions now stops such a submission and tells the builder in
 * their log channel what to fix ("Send Validation Error to Builder", checked by "Assert Builder
 * Told of Fix"). This proves that path without anyone posting in Slack.
 *
 * It calls n8n's `Engine — Submit Log Field Check Runner` (jENz4iq1Br6TRlEz,
 * POST /webhook/submit-log-field-check, x-dashboard-key), which builds ONE submission that is
 * wrong on purpose, shaped exactly as Bays — Front Door hands it over, and runs Submit Actions
 * the way the Front Door does. The runner refuses anything that would pass the form check, so
 * this can never reach the scraper or save a log. Then the Submit Actions run it started is read
 * back from n8n and judged node by node: the note posted and Slack said ok, the assert ran, and
 * nothing past the check (the scraper, the submission row) ran. What it does not prove is the
 * Front Door's Slack signature check, which this path does not touch.
 */
import * as n8n from './n8n';

export const RUNNER_PATH = '/webhook/submit-log-field-check';
export const SUBMIT_ACTIONS_ID = 'YTpezWSOIN6TNYcX';
export const CASES = ['swapped', 'not_a_link', 'missing_description'] as const;
export type FieldCase = (typeof CASES)[number];

/** Nodes that run only once a submission has passed the check. None may appear in a field-check run. */
export const MUST_NOT_RUN = [
  'Kick Off Scrape',
  'Otter Path',
  'Loom Path',
  'Find Pending Log For Recording · GET',
  'Write to BHA Submissions (Airtable) · POST',
  'Layer 0 — Completeness Gate',
];

export class FieldCheckError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

type RunData = Record<string, Array<{ executionStatus?: string; error?: unknown; data?: { main?: Array<Array<{ json?: Record<string, unknown> }> | null> } }>>;

function firstJson(runData: RunData, node: string): Record<string, unknown> | null {
  const run = runData[node]?.[0];
  const item = run?.data?.main?.[0]?.[0];
  return item?.json ?? null;
}

/**
 * Judge one Submit Actions run. Pure, so the test pins it. A run passes only when every check
 * does: a field check that cannot show the note landed has proved nothing.
 */
export function judge(exec: { status?: string; data?: { resultData?: { runData?: RunData; error?: unknown } } } | null, expected: FieldCase): { pass: boolean; checks: Check[]; note: { channel: string | null; ts: string | null } } {
  const checks: Check[] = [];
  const runData: RunData = exec?.data?.resultData?.runData ?? {};
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  add('run finished cleanly', exec?.status === 'success', `n8n status: ${exec?.status ?? 'not found'}`);

  const ext = firstJson(runData, 'Extract Submission');
  const errs = Array.isArray(ext?.fieldErrors) ? (ext!.fieldErrors as unknown[]).map(String) : [];
  add('the form check refused it', !!ext && ext.allFieldsValid === false && errs.length > 0, ext ? `allFieldsValid ${String(ext.allFieldsValid)}; ${errs.length} field error(s)` : 'Extract Submission did not run');
  const wantText = expected === 'missing_description' ? 'Session Description' : 'Session URL';
  add(`the error names ${wantText}`, errs.some((e) => e.includes(wantText)), errs.join(' | ').slice(0, 300) || 'no field errors');

  const sent = firstJson(runData, 'Send Validation Error to Builder');
  const ok = sent?.ok === true;
  add('the note posted and Slack said ok', ok, sent ? (ok ? `posted, ts ${String(sent.ts ?? '?')}` : `Slack answered ${String(sent.error ?? 'no ok')}`) : 'Send Validation Error to Builder did not run');
  const text = String((sent?.message as Record<string, unknown> | undefined)?.text ?? '');
  add('the note says what to fix', /needs a fix/i.test(text) && text.includes(wantText), text ? text.slice(0, 200) : 'no message text in Slack’s answer');

  const asserted = runData['Assert Builder Told of Fix']?.[0];
  add('the Slack answer was checked', asserted?.executionStatus === 'success', asserted ? `Assert Builder Told of Fix: ${asserted.executionStatus}` : 'Assert Builder Told of Fix did not run');

  const leaked = MUST_NOT_RUN.filter((n) => runData[n]);
  add('nothing past the check ran', leaked.length === 0, leaked.length ? `ran: ${leaked.join(', ')}` : 'scraper, submission row and completeness gate not reached');

  return {
    pass: checks.every((c) => c.pass),
    checks,
    note: { channel: sent ? String(sent.channel ?? '') || null : null, ts: sent ? String(sent.ts ?? '') || null : null },
  };
}

async function callRunner(body: Record<string, unknown>, timeoutMs = 90_000): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) throw new FieldCheckError('not_configured', 'DASHBOARD_INBOUND_KEY is not set on this server, and the runner webhook is authenticated by it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${n8n.n8nHost()}${RUNNER_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON; reported as text */
    }
    return { status: res.status, json, text };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new FieldCheckError('runner_unreachable', timedOut ? `The runner did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'Could not reach the n8n runner.');
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Submit Actions run this test started: the first one that began after `t0`. Waits up to ~30 s for it to finish. */
async function findRun(t0: number): Promise<n8n.N8nExecution | null> {
  for (let i = 0; i < 10; i++) {
    const runs = await n8n.recentExecutions(SUBMIT_ACTIONS_ID, 10);
    const mine = runs
      .filter((r) => r.startedAt && Date.parse(r.startedAt) >= t0 - 2000)
      .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0];
    if (mine && n8n.TERMINAL.has(mine.status)) return mine;
    await sleep(3000);
  }
  return null;
}

export interface FieldCheckResult {
  pass: boolean;
  case: FieldCase;
  run: string;
  runner: { status: number; answer: unknown };
  execution_id: string | null;
  execution_url: string | null;
  checks: Check[];
  note: { channel: string | null; ts: string | null };
}

export async function run(o: { requester: string; username: string; channel_id: string; case: FieldCase; run: string }): Promise<FieldCheckResult> {
  if (!n8n.n8nConfigured()) throw new FieldCheckError('not_configured', 'N8N_API_KEY is not set, so the run cannot be read back to prove it.');
  const t0 = Date.now();
  const r = await callRunner({ user_id: o.requester, username: o.username, channel_id: o.channel_id, case: o.case, run: o.run });
  if (r.status === 422) throw new FieldCheckError(String(r.json?.reason ?? 'runner_refused'), String(r.json?.message ?? r.text).slice(0, 300));
  if (r.status === 401 || r.status === 403) throw new FieldCheckError('runner_unauthorised', `The runner refused the dashboard key (HTTP ${r.status}).`);
  if (r.status === 404) throw new FieldCheckError('runner_not_active', 'The runner webhook answered 404: the workflow is not published.');
  if (r.status >= 500 || !r.json) throw new FieldCheckError('runner_failed', `The runner answered HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  const exec = await findRun(t0);
  const detail = exec ? ((await n8n.executionDetail(exec.id)) as unknown as Parameters<typeof judge>[0]) : null;
  const verdict = judge(detail, o.case);
  return {
    pass: verdict.pass,
    case: o.case,
    run: o.run,
    runner: { status: r.status, answer: r.json },
    execution_id: exec?.id ?? null,
    execution_url: exec ? n8n.executionUrl(SUBMIT_ACTIONS_ID, exec.id) : null,
    checks: exec ? verdict.checks : [{ name: 'the Submit Actions run was found', pass: false, detail: 'No Submit Actions run started after the call finished within 30 seconds.' }],
    note: verdict.note,
  };
}
