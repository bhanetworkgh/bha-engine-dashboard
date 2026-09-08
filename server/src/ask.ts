/**
 * The Ask Bays proxy. The browser posts to /api/ask; this forwards to the
 * dashboard's own n8n workflow with the API key from the environment. The
 * key never leaves this process.
 */

export const ASK_URL = process.env.ASK_BAYS_URL || 'https://n8n.arupiautomates.cloud/webhook/dashboard-ask-bays';
const ASK_KEY = process.env.ASK_BAYS_API_KEY || null;
export const MODEL_LABEL = process.env.ASK_BAYS_MODEL_LABEL || 'Claude Sonnet 5.0';

export function askConfigured(): boolean {
  return Boolean(ASK_KEY);
}

export interface AskReply {
  ok: boolean;
  answer: string;
  session_id: string;
  steps: string[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [];
}

/** Sends one message. Any failure comes back as ok:false with a plain answer, never a throw. */
export async function ask(message: string, sessionId: string, builderId: string): Promise<AskReply> {
  if (!ASK_KEY) {
    return { ok: false, answer: 'Ask Bays is not connected: ASK_BAYS_API_KEY is not set on the server.', session_id: sessionId, steps: [] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': ASK_KEY },
      body: JSON.stringify({ message, session_id: sessionId, builder_id: builderId }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, answer: `Bays returned something that was not JSON (HTTP ${res.status}).`, session_id: sessionId, steps: [] };
    }
    if (!res.ok && typeof json.answer !== 'string') {
      return { ok: false, answer: `Bays did not accept the message (HTTP ${res.status}).`, session_id: sessionId, steps: [] };
    }
    return {
      ok: json.ok === undefined ? res.ok : Boolean(json.ok),
      answer: typeof json.answer === 'string' ? json.answer : 'Bays replied without an answer field.',
      session_id: typeof json.session_id === 'string' && json.session_id ? json.session_id : sessionId,
      steps: asStringArray(json.steps),
    };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      answer: timedOut ? 'Bays did not answer within two minutes.' : 'Could not reach the Bays workflow.',
      session_id: sessionId,
      steps: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
