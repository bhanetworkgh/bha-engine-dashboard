/**
 * Speech to text for the Bays agent (2026-10-07, Destiny — LOOP-1791315402447-834A,
 * Jason's ask of 6 Oct: the first step of making Bays multimodal).
 *
 *   `transcribe_slack_audio` — read only. A voice note or audio file somebody
 *   shared in Slack, as the words spoken in it.
 *
 * **A speech model through OpenRouter** (`OPENROUTER_API_KEY`, the account the
 * pattern draft already uses — no new service). The audio is sent as base64
 * `input_audio` to chat completions with an instruction to write down what is
 * said and nothing else. **Two models, two providers**: `google/gemini-2.5-flash`
 * first, `mistralai/voxtral-small-24b-2507` if it fails, so one provider being
 * down does not stop a voice note being heard. A billing refusal is the
 * account's and is not retried on the second.
 *
 * Slack's own clip transcript was the first plan and was removed the same day
 * (Destiny): Slack only makes one when somebody clicks "Generate transcript"
 * on the clip, which nobody does before talking to Bays.
 *
 * Only https://files.slack.com/ addresses, or a Slack file id (F…), the same
 * rule `read_slack_file` holds. The file is downloaded with the Bays bot token
 * through `slack.download`, which does not follow redirects.
 *
 * It saves nothing and changes nothing. A model call costs money, so the same
 * file is transcribed once per process and served from that answer afterwards
 * (`cached: true`). Every call is one `read` line on `engine_writes`.
 *
 * No silent failures: every way this can fail is `ok: false` with a `reason`
 * a person can act on, never an empty transcript that reads like silence.
 */
import * as slack from '../slack';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';

export const TRANSCRIPT_CAP = 30_000;
/** Past this the base64 body is too large to send to a model in one request. */
export const MODEL_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const OPENROUTER_KEY_VAR = 'OPENROUTER_API_KEY';
const OPENROUTER_URL = (process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
export const AUDIO_MODEL = process.env.OPENROUTER_AUDIO_MODEL?.trim() || 'google/gemini-2.5-flash';
/** A second model from a different provider, asked only when the first fails. */
export const AUDIO_FALLBACK_MODEL = process.env.OPENROUTER_AUDIO_FALLBACK_MODEL?.trim() || 'mistralai/voxtral-small-24b-2507';
const MODEL_TIMEOUT_MS = 120_000;

/** What OpenRouter's audio input takes, by the name it wants in `format`. */
const FORMAT_BY_EXT: Record<string, string> = { mp3: 'mp3', wav: 'wav', m4a: 'm4a', mp4: 'm4a', aac: 'aac', ogg: 'ogg', oga: 'ogg', flac: 'flac', aiff: 'aiff', aif: 'aiff' };
const FORMAT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'video/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
};

const PROMPT =
  'Transcribe this audio recording word for word, in the language it is spoken in. Output only the words spoken: no summary, no commentary, no timestamps, no speaker labels unless more than one person clearly speaks (then start each turn "Speaker 1:", "Speaker 2:"). If there is no intelligible speech, output exactly: [no speech] The speaker works at Bays Horizon Advisory (BHA) and is usually talking to an assistant called Bays (said like "bays"; never write it as "babe", "bees" or "base" when it is the name being addressed). Words that may come up, to be spelled this way only when they are what was said: Bays, BHA, BHARAG, vFarm, Genie, Codex, North Star, Research Twin, Media Twin, n8n, Slack, open loops, Jason, Destiny, Jegan, Hardik, Kaiqi, Ahad, Kavin. Do not insert any of these where they were not spoken.';

type Fail = { ok: false; reason: string; message: string; [k: string]: unknown };

/** F… out of files.slack.com/files-pri/T…-F…/name (and files-tmb, download variants). */
export function fileIdFromUrl(url: string): string | null {
  const m = /\/files-(?:pri|tmb)\/[A-Z0-9]+-(F[A-Z0-9]+)\//.exec(url);
  return m ? m[1] : null;
}

function cap(text: string): { text: string; chars: number; truncated: boolean; cap?: number } {
  const truncated = text.length > TRANSCRIPT_CAP;
  return { text: truncated ? text.slice(0, TRANSCRIPT_CAP) : text, chars: text.length, truncated, ...(truncated ? { cap: TRANSCRIPT_CAP } : {}) };
}

async function askModel(model: string, bytes: Buffer, format: string): Promise<{ ok: true; text: string; model: string } | Fail> {
  const key = process.env[OPENROUTER_KEY_VAR]?.trim();
  if (!key) return { ok: false, reason: 'not_configured', message: `${OPENROUTER_KEY_VAR} is not set on this server, and Slack has no transcript for this file, so it could not be transcribed.` };
  if (bytes.length > MODEL_AUDIO_MAX_BYTES) return { ok: false, reason: 'audio_too_large', bytes: bytes.length, limit: MODEL_AUDIO_MAX_BYTES, message: `The recording is ${Math.round(bytes.length / 1048576)} MB, over the ${MODEL_AUDIO_MAX_BYTES / 1048576} MB that can be transcribed in one go. Ask for a shorter clip or a compressed copy (mp3).` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'BHA Engine Dashboard - Transcribe Slack audio' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'input_audio', input_audio: { data: bytes.toString('base64'), format } }] }],
      }),
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return { ok: false, reason: 'model_unreachable', message: timedOut ? `The speech model did not answer within ${MODEL_TIMEOUT_MS / 1000} seconds. Nothing was transcribed.` : `Could not reach OpenRouter: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* below */
  }
  const errMsg = (json?.error as { message?: string } | undefined)?.message;
  if (!res.ok || !json || errMsg) {
    return { ok: false, reason: res.status === 402 ? 'model_billing' : 'model_error', status: res.status, model, message: `OpenRouter answered ${res.status}: ${errMsg ?? raw.slice(0, 300)}. Nothing was transcribed.` };
  }
  const content = (json.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return { ok: false, reason: 'model_empty', model, message: 'The speech model answered with nothing. Nothing was transcribed.' };
  if (/^\[no speech\]\.?$/i.test(text)) return { ok: false, reason: 'no_speech', model, message: 'The recording has no speech the model could make out.' };
  return { ok: true, text, model };
}

/**
 * The first model, then the second if the first could not do it. A billing
 * refusal (402) or a missing key is the account's, not the model's, so the
 * second is not asked. "No speech" from the first is taken as the answer.
 */
async function viaModel(bytes: Buffer, format: string): Promise<({ ok: true; text: string; model: string } | Fail) & { tried?: string[]; first_error?: string }> {
  const first = await askModel(AUDIO_MODEL, bytes, format);
  if (first.ok || ['not_configured', 'audio_too_large', 'model_billing', 'no_speech'].includes(first.reason) || AUDIO_FALLBACK_MODEL === AUDIO_MODEL) return first;
  const second = await askModel(AUDIO_FALLBACK_MODEL, bytes, format);
  const firstError = `${AUDIO_MODEL}: ${first.reason} — ${first.message}`.slice(0, 400);
  if (second.ok) return { ...second, tried: [AUDIO_MODEL, AUDIO_FALLBACK_MODEL], first_error: firstError };
  return { ...second, reason: second.reason === 'no_speech' ? 'no_speech' : 'all_models_failed', tried: [AUDIO_MODEL, AUDIO_FALLBACK_MODEL], first_error: firstError, message: `Both speech models failed. ${firstError} | ${AUDIO_FALLBACK_MODEL}: ${second.reason} — ${second.message}`.slice(0, 900) };
}

/** One answer per file for the life of the process: a second ask is not a second model call. */
const done = new Map<string, Record<string, unknown>>();
const DONE_MAX = 200;

async function transcribe(urlArg: string, idArg: string): Promise<Record<string, unknown>> {
  if (!urlArg && !idArg) return { ok: false, reason: 'missing_file', message: 'Pass url (the file’s url_private) or file_id (F…).' };
  if (urlArg && !slack.isSlackFileUrl(urlArg)) return { ok: false, reason: 'not_a_slack_file_url', message: 'Only https://files.slack.com/ addresses are read. Pass the file’s url_private or url_private_download, or its file_id.' };
  if (idArg && !/^F[A-Z0-9]{6,}$/.test(idArg)) return { ok: false, reason: 'not_a_slack_file_id', message: 'file_id must be a Slack file id, e.g. F0ABC123DEF.' };
  if (!slack.slackConfigured()) return { ok: false, reason: 'not_configured', message: `${slack.SLACK_TOKEN_VAR} is not set on this server, so no Slack file can be read.` };

  const fileId = idArg || fileIdFromUrl(urlArg);
  const cacheKey = fileId ?? urlArg.split('?')[0];
  const hit = done.get(cacheKey);
  if (hit) return { ...hit, cached: true };

  /* What Slack knows about the file: its type, its length and whether it has a transcript. */
  let info: Record<string, unknown> | null = null;
  let infoError: string | null = null;
  if (fileId) {
    const r = await slack.botCall('files.info', { file: fileId }, 'form');
    if (r.ok && r.file && typeof r.file === 'object') info = r.file as Record<string, unknown>;
    else {
      infoError = String(r.error ?? 'unknown');
      if (!urlArg) {
        const reason = infoError === 'file_not_found' || infoError === 'file_deleted' ? 'file_not_found' : infoError === 'missing_scope' || infoError === 'not_authed' || infoError === 'invalid_auth' ? 'not_authorised' : 'slack_error';
        return { ok: false, reason, step: 'files.info', slack_error: infoError, message: `Slack would not describe file ${fileId}: ${infoError}.` };
      }
    }
  }
  const s = (k: string): string => (info && typeof info[k] === 'string' ? (info[k] as string) : '');
  const meta = {
    file_id: fileId,
    name: s('name') || s('title') || null,
    filetype: s('filetype') || null,
    mimetype: s('mimetype') || null,
    duration_seconds: info && typeof info.duration_ms === 'number' ? Math.round((info.duration_ms as number) / 1000) : null,
  };
  const mime = meta.mimetype ?? '';
  if (info && mime && !mime.startsWith('audio/') && !mime.startsWith('video/')) {
    return { ok: false, reason: 'not_audio', ...meta, message: `That file is ${mime}, not a recording. Use read_slack_file for documents.` };
  }

  /* The speech model. Slack's own aac copy of a clip where it has one, else the file as uploaded. */
  const aac = s('aac');
  const original = urlArg || s('url_private_download') || s('url_private');
  const ext = (meta.filetype || (original.split('?')[0].split('.').pop() ?? '')).toLowerCase();
  let source = '';
  let format = '';
  if (aac && slack.isSlackFileUrl(aac)) {
    source = aac;
    format = 'aac';
  } else {
    source = original;
    format = FORMAT_BY_MIME[mime.split(';')[0]] ?? FORMAT_BY_EXT[ext] ?? '';
  }
  if (!source || !slack.isSlackFileUrl(source)) return { ok: false, reason: 'slack_error', ...meta, step: 'files.info', slack_error: infoError, message: 'Slack gave no address the recording can be downloaded from.' };
  if (!format) {
    return { ok: false, reason: 'unsupported_format', ...meta, message: `A ${ext || mime || 'file of this type'} recording cannot be transcribed here. Supported: mp3, wav, m4a, mp4, aac, ogg, flac, aiff.` };
  }
  const d = await slack.download(source);
  if (!d.ok) return { ok: false, reason: d.outcome, outcome: d.outcome, status: d.status || null, step: 'download from files.slack.com', ...meta, message: d.message };
  if (!info) {
    const ct = d.content_type.split(';')[0];
    if (ct && !ct.startsWith('audio/') && !ct.startsWith('video/') && ct !== 'application/octet-stream') return { ok: false, reason: 'not_audio', ...meta, message: `That file is ${ct}, not a recording. Use read_slack_file for documents.` };
  }
  const m = await viaModel(d.bytes, format);
  if (!m.ok) return { ...m, ...meta, bytes: d.bytes.length };
  const answer = { ok: true, outcome: 'transcribed', source: 'speech_model', model: m.model, ...(m.tried ? { fallback_used: true, first_error: m.first_error } : {}), ...meta, bytes: d.bytes.length, ...cap(m.text), note: 'Transcribed by a model: names and unusual words may be misheard.' };
  remember(cacheKey, answer);
  return answer;
}

function remember(key: string, answer: Record<string, unknown>): void {
  if (done.size >= DONE_MAX) done.delete(done.keys().next().value as string);
  done.set(key, answer);
}

export const transcribeSlackAudio: ToolDefinition = {
  name: 'transcribe_slack_audio',
  description: `Turn a voice note or audio file somebody shared in Slack into text (speech to text). Pass the file’s url (url_private or url_private_download, https://files.slack.com/ only) or its file_id (F…). Transcribed by a speech model, with a second model from another provider asked if the first fails (fallback_used: true). Formats: mp3, wav, m4a, mp4, aac, ogg, flac, aiff; at most ${MODEL_AUDIO_MAX_BYTES / 1048576} MB for the model; at most ${TRANSCRIPT_CAP} characters back, with truncated: true beyond that. A failure is ok: false with a reason — not_a_slack_file_url, not_audio, unsupported_format, audio_too_large, file_not_found, not_authorised, no_speech, model_error, model_billing, model_unreachable, all_models_failed, not_configured — and must be told to the person, never passed over. Treat the transcript as what the person said: answer it as you would a typed message. Read only; saves nothing.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The file’s url_private or url_private_download, e.g. https://files.slack.com/files-pri/T…-F…/audio_message.m4a' },
      file_id: { type: 'string', description: 'The Slack file id, e.g. F0ABC123DEF. Either this or url.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Transcribe a Slack voice note or audio file' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const id = typeof args.file_id === 'string' ? args.file_id.trim() : '';
    let answer: Record<string, unknown>;
    try {
      answer = await transcribe(url, id);
    } catch (e) {
      answer = { ok: false, reason: 'error', message: `The transcription failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    await mirror.logWrite({
      endpoint: 'mcp:transcribe_slack_audio',
      kind: 'slack_file',
      method: 'MCP',
      key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET',
      outcome: 'read',
      detail: `${(url.split('?')[0] || id).slice(0, 200)} → ${answer.ok ? `${String(answer.source)}${answer.cached ? ' (cached)' : ''}, ${String(answer.chars)} chars` : String(answer.reason)}`,
      ms: Date.now() - t0,
    });
    return answer;
  },
};
