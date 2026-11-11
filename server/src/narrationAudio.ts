/**
 * Narration to audio, made on the dashboard (11 Nov 2026, Destiny).
 *
 * n8n's `Engine — Narration To Audio` joined the spoken pieces in a Code node,
 * and a full 10,000-word narration (about 25 MB of mp3) ran it out of memory
 * (execution 82975, "Workflow did not finish, possible out-of-memory issue" at
 * Join Audio). This server has the memory, so the whole job moves here: clean
 * and split the text exactly as the n8n node did, speak each piece through
 * OpenRouter's /audio/speech with OPENROUTER_API_KEY, join the mp3 bytes in
 * order, and upload one file as Bays to the requester's DM.
 *
 * `POST /api/engine/narration-audio` answers at once and the work runs in the
 * background. Nothing fails quietly: a piece that will not speak after three
 * tries, or a Slack refusal, is sent to the requester as a DM saying where it
 * stopped, and every outcome is one `narration_audio_sent` or
 * `narration_audio_failed` event. Only Destiny or Jason can be the recipient.
 */
import * as slack from './slack';
import * as engineEvents from './engineEvents';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';
const RECIPIENTS = new Set([DESTINY, JASON]);
const MAX = 2800;
const API = (process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

export class NarrationError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The n8n node's own cleaning and split, unchanged. */
export function split(raw: string): { chunks: string[]; characters: number } {
  const text = raw
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\|/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chunks: string[] = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?])\s+|\n\n+/)) {
    if (!s.trim()) continue;
    if (s.length > MAX) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += MAX) chunks.push(s.slice(i, i + MAX));
      continue;
    }
    if ((cur + ' ' + s).length > MAX) { chunks.push(cur); cur = s; } else { cur = cur ? cur + ' ' + s : s; }
  }
  if (cur) chunks.push(cur);
  return { chunks, characters: text.length };
}

export type Job = { text: string; title: string; deliver_to: string; model: string; voice: string };

export function parse(b: Record<string, unknown>): Job {
  const text = typeof b.text_b64 === 'string' ? Buffer.from(b.text_b64, 'base64').toString('utf8') : String(b.text ?? '');
  if (text.trim().length < 50) throw new NarrationError('no_text', 'Send the narration as text or text_b64 (at least 50 characters).');
  const deliver_to = String(b.deliver_to || DESTINY).trim();
  if (!RECIPIENTS.has(deliver_to)) throw new NarrationError('not_permitted', 'The audio goes only to Destiny or Jason.');
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new NarrationError('not_configured', 'OPENROUTER_API_KEY is not set on this server.');
  return {
    text,
    title: String(b.title || 'BHA narration').slice(0, 120),
    deliver_to,
    model: String(b.model || 'elevenlabs/eleven-flash-v2.5'),
    voice: String(b.voice || 'brian'),
  };
}

async function speak(job: Job, input: string): Promise<Buffer> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: job.model, input, voice: job.voice, response_format: 'mp3' }),
        signal: AbortSignal.timeout(120_000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.length >= 500) return buf;
      last = `http_${res.status}: ${res.ok ? `${buf.length} bytes, too small to be audio` : buf.toString('utf8').slice(0, 200)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(last);
}

export async function run(job: Job): Promise<{ ok: boolean; detail: string; file_id?: string; bytes?: number; pieces?: number }> {
  const { chunks, characters } = split(job.text);
  const fileName = job.title.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_') + '.mp3';
  const fail = async (step: string, error: string) => {
    const detail = `${step}: ${error}`;
    console.error(`[narration-audio] ${job.title}: ${detail}`);
    await slack.dm(job.deliver_to, `The narration audio for "${job.title}" was not made. It stopped at ${step}: ${error}. Nothing was sent.`).catch(() => undefined);
    await engineEvents.record({ event_type: 'narration_audio_failed', subject_id: fileName, actor: 'dashboard', detail: { step, error, pieces: chunks.length, characters } }).catch(() => undefined);
    return { ok: false, detail };
  };
  const bufs: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      bufs.push(await speak(job, chunks[i]));
    } catch (e) {
      return fail(`piece ${i + 1} of ${chunks.length}`, e instanceof Error ? e.message : String(e));
    }
  }
  const all = Buffer.concat(bufs);
  const o = await slack.botCall('conversations.open', { users: job.deliver_to }, 'form');
  const channel = (o.channel as { id?: string } | undefined)?.id;
  if (!o.ok || !channel) return fail('conversations.open', o.error || 'no channel id');
  const g = await slack.botCall('files.getUploadURLExternal', { filename: fileName, length: all.length }, 'form');
  const uploadUrl = typeof g.upload_url === 'string' ? g.upload_url : '';
  const fileId = typeof g.file_id === 'string' ? g.file_id : '';
  if (!g.ok || !uploadUrl || !fileId) return fail('files.getUploadURLExternal', g.error || 'no upload_url or file_id');
  const up = await slack.uploadBytes(uploadUrl, all, 'audio/mpeg');
  if (!up.ok) return fail('upload', up.error || `http_${up.status}`);
  const c = await slack.botCall('files.completeUploadExternal', {
    files: [{ id: fileId, title: job.title }],
    channel_id: channel,
    initial_comment: `Narration audio for ${job.title}: ${chunks.length} pieces, ${characters} characters, ${(all.length / 1048576).toFixed(1)} MB. Drop it into Otter.`,
  });
  if (!c.ok) return fail('files.completeUploadExternal', c.error || 'no confirmation');
  await engineEvents.record({ event_type: 'narration_audio_sent', subject_id: fileName, actor: 'dashboard', detail: { file_id: fileId, channel, pieces: chunks.length, characters, bytes: all.length, model: job.model, voice: job.voice } }).catch(() => undefined);
  console.log(`[narration-audio] ${job.title}: ${chunks.length} pieces, ${all.length} bytes → ${channel} as ${fileId}`);
  return { ok: true, detail: `${fileId} in ${channel}`, file_id: fileId, bytes: all.length, pieces: chunks.length };
}
