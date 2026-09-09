/**
 * The Ask Bays proxy. The browser posts to /api/ask; this forwards to the
 * dashboard's own n8n workflow with the API key from the environment. The
 * key never leaves this process — the workflow's own entry node says the
 * same thing, and anything in the browser bundle is readable by whoever
 * opens the page.
 *
 * The workflow's contract, read from the live workflow (Bays — Dashboard
 * Agent, vDunZ17dxLXatcw0) rather than assumed:
 *
 *   POST  {ASK_URL}
 *   header x-api-key: {ASK_BAYS_API_KEY}
 *   body   { message, session_id, builder_id }   builder_id defaults to admin
 *
 *   success  { ok: true,  answer, session_id, asked_at, steps: string[] }
 *   failure  { ok: false, answer, error: 'unauthorised' | 'empty_message',
 *              session_id, steps: [] }
 *
 * The failure comes back with **HTTP 200**, so `ok` is the only honest
 * signal. Reading the status code instead would hand the browser the words
 * "This request was not authorised." as though Bays had said them. Every
 * branch below turns on `json.ok === true` and nothing else.
 *
 * The agent calls tools before answering and replies synchronously, so a
 * real answer can take tens of seconds. Hence the ninety-second budget, and
 * a timeout reported as a timeout rather than as a refusal.
 */

import type { AskErrorKind, AskReply } from '../../src/data/types';

export const ASK_URL = process.env.ASK_BAYS_URL || 'https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays';
const ASK_KEY = process.env.ASK_BAYS_API_KEY || null;
export const MODEL_LABEL = process.env.ASK_BAYS_MODEL_LABEL || 'Claude Sonnet 5.0';

/** The agent is synchronous and calls tools first; tens of seconds is normal. */
const TIMEOUT_MS = 90_000;

export function askConfigured(): boolean {
  return Boolean(ASK_KEY);
}

export type { AskReply };

function fail(error: AskErrorKind, answer: string, sessionId: string): AskReply {
  return { ok: false, answer, session_id: sessionId, steps: [], error };
}

/** The workflow lowercases and space-separates these already; keep what it sent. */
function asSteps(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The two the workflow returns; anything else is recorded but not trusted as one of ours. */
function asWorkflowError(v: unknown): AskErrorKind | null {
  return v === 'unauthorised' || v === 'empty_message' ? v : null;
}

/**
 * Sends one message. Never throws: every failure comes back as ok:false with
 * an `error` saying which kind, and an `answer` that reads as a plain sentence.
 */
export async function ask(message: string, sessionId: string, builderId: string): Promise<AskReply> {
  if (!ASK_KEY) {
    return fail('not_configured', 'Ask Bays is not connected: ASK_BAYS_API_KEY is not set on the server.', sessionId);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  let text: string;
  try {
    res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': ASK_KEY },
      body: JSON.stringify({ message, session_id: sessionId, builder_id: builderId || 'admin' }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return timedOut
      ? fail('timeout', 'Bays did not answer within ninety seconds.', sessionId)
      : fail('unreachable', 'Could not reach the Bays workflow.', sessionId);
  } finally {
    clearTimeout(timer);
  }

  let json: Record<string, unknown>;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return fail('bad_response', `Bays returned something that was not JSON (HTTP ${res.status}).`, sessionId);
  }

  // The only success signal. A refusal, an n8n-level rejection of the key at
  // the webhook itself (HTTP 403, no `ok` at all), and a 200 carrying
  // ok:false all land here together, which is the point.
  if (json.ok !== true) {
    const kind = asWorkflowError(json.error);
    const spoken = asString(json.answer);
    const answer =
      spoken ??
      // n8n's own header-auth rejection never reaches the workflow's code, so
      // it has no `answer`; say what happened rather than repeating its body.
      (res.status === 401 || res.status === 403
        ? 'The Bays workflow rejected the dashboard’s API key.'
        : res.ok
          ? 'Bays did not accept the message.'
          : `Bays did not accept the message (HTTP ${res.status}).`);
    return {
      ok: false,
      answer,
      session_id: asString(json.session_id) ?? sessionId,
      steps: [],
      error: kind ?? (res.status === 401 || res.status === 403 ? 'unauthorised' : 'bad_response'),
    };
  }

  const answer = asString(json.answer);
  return {
    ok: true,
    answer: answer ?? 'Bays replied without an answer field.',
    session_id: asString(json.session_id) ?? sessionId,
    asked_at: asString(json.asked_at) ?? undefined,
    steps: asSteps(json.steps),
  };
}
