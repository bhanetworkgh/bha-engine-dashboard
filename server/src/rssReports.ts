/**
 * BHA RSS reports what happens (16 Nov 2026, Destiny — Genie rebuild steps 4.2 and 4.3,
 * LOOP-1794689712393-O0J6).
 *
 * BHA RSS holds no Slack key, and does not need one: it already holds the dashboard's inbound key.
 *
 * - 4.2, errors to #bha-pipeline-errors (RSS_ERROR_CHANNEL): BHA RSS posts a failed source, a source
 *   run that saved items but could not enrich some, a digest it could not write, a digest it could not
 *   deliver, and a scheduler pass that failed to `POST /api/engine/rss-error` (x-dashboard-key, body_b64
 *   accepted). Bays posts it. One post per kind and subject per UTC day: a source that fails on every
 *   run is said once a day, not every minute. The claim is an engine event written before the post;
 *   a post Slack refuses gives the claim back, so the next report tries again.
 * - A digest that never arrives cannot report itself (a delivery failure that reaches nobody), so this
 *   process checks too: once the digest hour plus the grace below has passed, a day with no digest held
 *   is posted to #bha-pipeline-errors once.
 * - 4.3, the daily digest to #bha-engine-digests (RSS_DIGEST_CHANNEL; Destiny, 16 Nov: digests go there,
 *   #bha-engine-alerts is for critical alerts): when the day's digest is stored, Bays posts its title,
 *   its "What moved outside" section and the counts, once per day, and says where the rest is.
 *
 * It reads and posts. It changes nothing on BHA RSS.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';

export const ERROR_EVENT = 'rss_error_reported';
export const DIGEST_EVENT = 'outside_digest_posted';
export const MISSING_EVENT = 'outside_digest_missing';
export const KINDS = ['source_failed', 'enrichment_failed', 'digest_failed', 'digest_not_delivered', 'pass_failed'] as const;
export type RssErrorKind = (typeof KINDS)[number];
/** The digest covers the UTC day before and is written at 06:00 UTC; it counts as missing at 08:00 UTC. */
export const RULE = { digest_due_hour_utc: 8, tick_minutes: 30 } as const;

const errorChannel = () => (process.env.RSS_ERROR_CHANNEL || 'C0ATC4CA3G9').trim();
const digestChannel = () => (process.env.RSS_DIGEST_CHANNEL || 'C0C534NQ0HG').trim();

export class RssReportError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LABEL: Record<RssErrorKind, string> = {
  source_failed: 'a source could not be read',
  enrichment_failed: 'a source run saved its items but could not enrich some',
  digest_failed: 'the daily digest could not be written',
  digest_not_delivered: 'the daily digest was written but did not reach the dashboard',
  pass_failed: 'a scheduler pass failed',
};

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface RssErrorInput {
  kind: RssErrorKind;
  subject: string;
  error: string;
  source_name?: string;
  source_url?: string;
  digest_date?: string;
  at?: string;
}

export function parseError(b: Record<string, unknown>): RssErrorInput {
  const kind = str(b.kind, 40) as RssErrorKind;
  if (!KINDS.includes(kind)) throw new RssReportError(422, `kind must be one of ${KINDS.join(', ')}.`);
  const subject = str(b.subject, 200);
  if (!subject) throw new RssReportError(422, 'subject is required: the source id, or the digest date.');
  const error = str(b.error, 1000);
  if (!error) throw new RssReportError(422, "error is required: what failed, in the service's own words.");
  return {
    kind,
    subject,
    error,
    source_name: str(b.source_name, 200) || undefined,
    source_url: str(b.source_url, 500) || undefined,
    digest_date: str(b.digest_date, 10) || undefined,
    at: str(b.at, 40) || undefined,
  };
}

export function errorMessage(e: RssErrorInput): { text: string; blocks: unknown[] } {
  const facts: Array<[string, string | undefined]> = [
    ['Source', e.source_name ? `${e.source_name}${e.source_url ? ` (${e.source_url})` : ''}` : e.source_url],
    ['Digest date', e.digest_date],
    ['Subject', e.subject],
    ['Error', e.error],
    ['At', e.at],
  ];
  const lines = facts.filter(([, v]) => v).map(([k, v]) => `*${k}:* ${esc(String(v))}`);
  const title = `BHA RSS: ${LABEL[e.kind]}`;
  return {
    text: [title, ...lines.map((l) => l.replace(/\*/g, ''))].join('\n'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${esc(title)}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Said once per day for each source and kind. Its run history is in BHA RSS (rss.bhanetwork.org/status).' }] },
    ],
  };
}

async function post(channel: string, text: string, blocks: unknown[]): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set, so nothing can be posted` };
  const msg = { channel, text, blocks, unfurl_links: false, unfurl_media: false };
  let r = await slack.botCall('chat.postMessage', msg);
  if (!r.ok && r.error === 'not_in_channel' && (await slack.botCall('conversations.join', { channel })).ok) r = await slack.botCall('chat.postMessage', msg);
  if (r.ok && typeof r.ts === 'string') return { ok: true, ts: r.ts };
  return { ok: false, error: `Slack refused the post: ${String(r.error ?? 'unknown error')}` };
}

/** Claim once, post, and give the claim back if Slack refuses, so a post nobody received is retried. */
async function claimAndPost(
  event: { event_type: string; subject_id: string; dedupe_key: string; detail: Record<string, unknown> },
  channel: string,
  message: { text: string; blocks: unknown[] },
  postFn: typeof post,
): Promise<{ posted: boolean; already?: boolean; ts?: string; error?: string }> {
  const claim = await record({ ...event, lane: 'GENIE', actor: 'bha-rss', source_ref: 'bha-rss' });
  if (!claim.recorded) return { posted: false, already: true };
  const p = await postFn(channel, message.text, message.blocks);
  if (p.ok) {
    await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ channel, ts: p.ts })]);
    return { posted: true, ts: p.ts };
  }
  await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
  console.error(`[rss-reports] ${event.event_type} for ${event.subject_id} not posted: ${p.error}`);
  return { posted: false, error: p.error };
}

export async function reportError(b: Record<string, unknown>, opts: { now?: Date; post?: typeof post } = {}): Promise<Record<string, unknown>> {
  const e = parseError(b);
  if (b.dry_run === true) return { ok: true, dry_run: true, kind: e.kind, subject: e.subject, would_post_to: errorChannel(), text: errorMessage(e).text };
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const r = await claimAndPost(
    { event_type: ERROR_EVENT, subject_id: e.subject, dedupe_key: `${ERROR_EVENT}:${e.kind}:${e.subject}:${day}`, detail: { ...e } },
    errorChannel(),
    errorMessage(e),
    opts.post ?? post,
  );
  if (r.already) return { ok: true, posted: false, reason: 'already_said_today', kind: e.kind, subject: e.subject };
  if (!r.posted) return { ok: false, posted: false, raise: true, reason: 'slack_refused', error: r.error };
  return { ok: true, posted: true, channel: errorChannel(), ts: r.ts, kind: e.kind, subject: e.subject };
}

/** Markdown links and bold to Slack's own format; the digest is written in Markdown. */
export function toSlack(markdown: string): string {
  return esc(markdown)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)<>|]+)\)/g, (_m, t: string, u: string) => `<${u}|${t.replace(/\|/g, '/')}>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ');
}

/** One section of the digest body, by its heading ("What moved outside"), without the heading. */
export function section(body: string, heading: string): string | null {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.replace(/^#+\s*/, '').trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return text || null;
}

export function digestMessage(d: { digest_date: string; title: string; body: string; items_used: number; sources_used: number }): { text: string; blocks: unknown[] } {
  const moved = section(d.body, 'What moved outside');
  const head = toSlack(moved ?? d.body).slice(0, 2900);
  const others = ['Post ideas for the Media Twin', 'Questions for Research Twin', 'Signals for North Star', 'Context for Genie'].filter((h) => section(d.body, h));
  return {
    text: `${d.title}\n\n${moved ?? d.body.slice(0, 2900)}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: d.title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: moved ? `*What moved outside*\n${head}` : head } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${d.items_used} items from ${d.sources_used} sources on ${d.digest_date}.${others.length ? ` The rest (${others.join(', ')}) is in BHARAG and read with read_outside_digest.` : ''}`,
          },
        ],
      },
    ],
  };
}

/** Called once the day's digest is stored; posts it once per day. Never throws. */
export async function postDigest(d: { digest_date: string; title: string; body: string; items_used: number; sources_used: number }, opts: { post?: typeof post } = {}): Promise<Record<string, unknown>> {
  try {
    const r = await claimAndPost(
      { event_type: DIGEST_EVENT, subject_id: d.digest_date, dedupe_key: `${DIGEST_EVENT}:${d.digest_date}`, detail: { title: d.title } },
      digestChannel(),
      digestMessage(d),
      opts.post ?? post,
    );
    if (r.already) return { posted: false, reason: 'already_posted' };
    return r.posted ? { posted: true, channel: digestChannel(), ts: r.ts } : { posted: false, reason: 'slack_refused', error: r.error };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[rss-reports] digest ${d.digest_date} not posted: ${error}`);
    return { posted: false, reason: 'error', error };
  }
}

/** The day a digest is due for at `now`, once its hour has passed; null before then. */
export function dueDate(now: Date): string | null {
  if (now.getUTCHours() < RULE.digest_due_hour_utc) return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000).toISOString().slice(0, 10);
}

export async function checkMissing(opts: { now?: Date; post?: typeof post } = {}): Promise<Record<string, unknown>> {
  const date = dueDate(opts.now ?? new Date());
  if (!date) return { checked: false, reason: 'not_due' };
  const held = await query('SELECT 1 FROM engine_outside_digests WHERE digest_date = $1', [date]);
  if (held.rows.length) return { checked: true, date, missing: false };
  const e: RssErrorInput = { kind: 'digest_not_delivered', subject: date, digest_date: date, error: `no digest for ${date} has reached the dashboard by ${RULE.digest_due_hour_utc}:00 UTC` };
  const r = await claimAndPost(
    { event_type: MISSING_EVENT, subject_id: date, dedupe_key: `${MISSING_EVENT}:${date}`, detail: { date } },
    errorChannel(),
    errorMessage(e),
    opts.post ?? post,
  );
  return { checked: true, date, missing: true, posted: r.posted, already: Boolean(r.already), error: r.error };
}

let started = false;
export function startWatching(): void {
  if (started) return;
  started = true;
  const tick = () => {
    timers.beat('outside digest check');
    checkMissing().catch((e) => console.error(`[rss-reports] missing-digest check failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(tick, 180_000).unref();
  setInterval(tick, RULE.tick_minutes * 60_000).unref();
}
