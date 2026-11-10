/**
 * Deleting the engine's own Slack messages (10 Nov 2026, Destiny: "a tool that lets you delete messages, like all
 * the test logs and whatever"). Test runs leave cards, notices and confirmations behind in real channels, and until
 * this only a person in Slack could take them down.
 *
 * Only messages one of the engine's three bots posted (Bays, North Star, Research Twin) can go, each deleted with the
 * token of the bot that posted it, because Slack lets a bot delete only its own posts. A person's message is never
 * touched and is listed as not ours. Two ways to name what goes:
 *   - messages: permalinks (or {channel, ts}), the exact posts;
 *   - search: one channel, words the post must contain (3 characters at least), and a window (24 hours by default,
 *     168 at most), the engine's own posts only.
 * Nothing is deleted without `confirm: "DELETE <n>"`, n being the number the preview found, so a preview read twice
 * cannot delete more than was shown. 50 at most a call. With `with_replies` a deleted post's thread replies by the same
 * bots go too. The whole text of every post is kept on the audit line before it is deleted, so what went can still be
 * read. Each run that deletes is one `slack_messages_deleted` event.
 */
import * as slack from './slack';

export const MAX_DELETE = 50;
export const MAX_WINDOW_HOURS = 168;

type Bot = { name: string; token: string; user_id: string | null; bot_id: string | null };
export type Msg = { channel: string; ts: string; thread_ts?: string; text?: string; user?: string; bot_id?: string; blocks?: unknown; reply_count?: number };
export type Found = { channel: string; ts: string; link: string; posted_by: string | null; text: string; thread_ts: string | null; reply: boolean };
export type Skipped = { ref: string; reason: string };

export class DeleteError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

/** A Slack permalink or {channel, ts} to {channel, ts, thread_ts}. Pure. */
export function parseRef(ref: unknown): { channel: string; ts: string; thread_ts: string | null } | null {
  if (ref && typeof ref === 'object') {
    const r = ref as Record<string, unknown>;
    const channel = String(r.channel ?? '').trim();
    const ts = String(r.ts ?? '').trim();
    return /^[CDG][A-Z0-9]{6,}$/.test(channel) && /^\d{9,11}\.\d{6}$/.test(ts) ? { channel, ts, thread_ts: r.thread_ts ? String(r.thread_ts) : null } : null;
  }
  const s = String(ref ?? '').trim();
  const m = s.match(/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([CDG][A-Z0-9]{6,})\/p(\d{10})(\d{6})(?:\?(.*))?$/i);
  if (!m) return null;
  const thread = (m[4] ?? '').match(/(?:^|&)thread_ts=(\d{9,11}\.\d{6})/);
  return { channel: m[1].toUpperCase(), ts: `${m[2]}.${m[3]}`, thread_ts: thread ? thread[1] : null };
}

/** Does this post contain the words? Case-blind, over its text and its blocks. Pure. */
export function contains(m: Pick<Msg, 'text' | 'blocks'>, words: string): boolean {
  const hay = `${m.text ?? ''} ${JSON.stringify(m.blocks ?? '')}`.toLowerCase();
  return hay.includes(words.toLowerCase());
}

export const permalink = (channel: string, ts: string) => `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ts.replace('.', '')}`;

let botsCache: { at: number; bots: Bot[] } | null = null;

/** The engine's bots this server holds a token for, with who each one is in Slack. */
async function bots(): Promise<Bot[]> {
  if (botsCache && Date.now() - botsCache.at < 10 * 60_000) return botsCache.bots;
  const out: Bot[] = [];
  const toks: [string, string | null][] = [
    ['Bays', process.env[slack.SLACK_TOKEN_VAR]?.trim() || null],
    ['North Star', slack.northStarToken()],
    ['Research Twin', slack.researchTwinToken()],
  ];
  for (const [name, token] of toks) {
    if (!token) continue;
    const r = await slack.botCall('auth.test', {}, 'form', token);
    if (r.ok) out.push({ name, token, user_id: (r.user_id as string) ?? null, bot_id: (r.bot_id as string) ?? null });
  }
  botsCache = { at: Date.now(), bots: out };
  return out;
}

const owner = (m: Msg, list: Bot[]): Bot | null => list.find((b) => (m.bot_id && m.bot_id === b.bot_id) || (m.user && m.user === b.user_id)) ?? null;

/** Reads with each bot's token in turn until one can read the channel. */
async function read(method: string, params: Record<string, unknown>, list: Bot[]): Promise<{ ok: true; body: slack.SlackBody } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const b of list) {
    const r = await slack.botCall(method, params, 'form', b.token);
    if (r.ok) return { ok: true, body: r };
    errors.push(`${b.name}: ${r.error}`);
  }
  return { ok: false, error: errors.join('; ') || 'no Slack token is set on this server' };
}

async function one(channel: string, ts: string, thread_ts: string | null, list: Bot[]): Promise<{ msg: Msg | null; error?: string }> {
  if (thread_ts && thread_ts !== ts) {
    const r = await read('conversations.replies', { channel, ts: thread_ts, latest: ts, oldest: ts, inclusive: true, limit: 5 }, list);
    if (!r.ok) return { msg: null, error: r.error };
    const m = ((r.body.messages as Msg[]) ?? []).find((x) => x.ts === ts);
    return { msg: m ? { ...m, channel } : null };
  }
  const r = await read('conversations.history', { channel, latest: ts, oldest: ts, inclusive: true, limit: 1 }, list);
  if (!r.ok) return { msg: null, error: r.error };
  const m = ((r.body.messages as Msg[]) ?? []).find((x) => x.ts === ts);
  if (m) return { msg: { ...m, channel } };
  // A reply named without its thread: history does not list replies, so look it up as a thread of its own.
  const rr = await read('conversations.replies', { channel, ts, limit: 1 }, list);
  const mm = rr.ok ? ((rr.body.messages as Msg[]) ?? []).find((x) => x.ts === ts) : undefined;
  return { msg: mm ? { ...mm, channel } : null };
}

async function replies(channel: string, root: string, list: Bot[]): Promise<Msg[]> {
  const out: Msg[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await read('conversations.replies', { channel, ts: root, limit: 200, cursor }, list);
    if (!r.ok) break;
    for (const m of (r.body.messages as Msg[]) ?? []) if (m.ts !== root) out.push({ ...m, channel });
    cursor = (r.body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

const shape = (m: Msg, b: Bot | null): Found => ({
  channel: m.channel,
  ts: m.ts,
  link: permalink(m.channel, m.ts),
  posted_by: b?.name ?? null,
  text: `${m.text ?? ''}`.slice(0, 4000),
  thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
  reply: !!(m.thread_ts && m.thread_ts !== m.ts),
});

/** What would be deleted. Reads only. */
export async function find(o: { messages?: unknown[]; channel?: string; contains?: string; since_hours?: number; with_replies?: boolean }): Promise<{ found: Found[]; skipped: Skipped[]; bots: string[] }> {
  const list = await bots();
  if (!list.length) throw new DeleteError('not_configured', `No Slack bot token is set on this server (${slack.SLACK_TOKEN_VAR}, ${slack.NS_TOKEN_VAR}, ${slack.RT_TOKEN_VAR}).`);
  const found: Found[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const take = (m: Msg, ref: string) => {
    const key = `${m.channel}:${m.ts}`;
    if (seen.has(key)) return;
    const b = owner(m, list);
    if (!b) {
      skipped.push({ ref, reason: 'not posted by an engine bot (Bays, North Star or Research Twin), so it is left alone' });
      return;
    }
    seen.add(key);
    found.push(shape(m, b));
  };

  if (Array.isArray(o.messages) && o.messages.length) {
    for (const raw of o.messages) {
      const ref = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const p = parseRef(raw);
      if (!p) {
        skipped.push({ ref, reason: 'not a Slack message link or {channel, ts}' });
        continue;
      }
      const r = await one(p.channel, p.ts, p.thread_ts, list);
      if (!r.msg) {
        skipped.push({ ref, reason: r.error ? `could not read it: ${r.error}` : 'no such message (already deleted?)' });
        continue;
      }
      take(r.msg, ref);
    }
  } else {
    const channel = String(o.channel ?? '').trim();
    const words = String(o.contains ?? '').trim();
    if (!/^[CDG][A-Z0-9]{6,}$/.test(channel)) throw new DeleteError('bad_channel', 'A search needs channel, a Slack channel id (C…, G… or D…).');
    if (words.length < 3) throw new DeleteError('contains_required', 'A search needs contains: at least 3 characters the post must include, so a search can never match everything.');
    const hours = Math.min(MAX_WINDOW_HOURS, Math.max(1, Number(o.since_hours) || 24));
    const oldest = String(Math.floor(Date.now() / 1000 - hours * 3600));
    let cursor: string | undefined;
    for (let page = 0; page < 10 && found.length < MAX_DELETE * 2; page++) {
      const r = await read('conversations.history', { channel, oldest, limit: 200, cursor }, list);
      if (!r.ok) throw new DeleteError('unreadable', `Slack would not let any engine bot read ${channel}: ${r.error}`);
      const msgs = ((r.body.messages as Msg[]) ?? []).map((m) => ({ ...m, channel }));
      for (const m of msgs) {
        if (contains(m, words) && owner(m, list)) take(m, permalink(channel, m.ts));
        if ((m.reply_count ?? 0) > 0) {
          for (const rep of await replies(channel, m.ts, list)) if (contains(rep, words) && owner(rep, list)) take(rep, permalink(channel, rep.ts));
        }
      }
      cursor = (r.body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      if (!cursor) break;
    }
  }

  if (o.with_replies === true) {
    for (const f of [...found]) {
      if (f.reply) continue;
      for (const rep of await replies(f.channel, f.ts, list)) take(rep, permalink(f.channel, rep.ts));
    }
  }
  // Replies before their parent, so a thread is taken down from the bottom.
  found.sort((a, b) => Number(b.reply) - Number(a.reply) || Number(b.ts) - Number(a.ts));
  return { found, skipped, bots: list.map((b) => b.name) };
}

/** Deletes what `find` found, each with the token of the bot that posted it. */
export async function remove(found: Found[]): Promise<{ deleted: Found[]; failed: (Found & { error: string })[] }> {
  const list = await bots();
  const deleted: Found[] = [];
  const failed: (Found & { error: string })[] = [];
  for (const f of found) {
    const b = list.find((x) => x.name === f.posted_by);
    if (!b) {
      failed.push({ ...f, error: 'the bot that posted it has no token here' });
      continue;
    }
    const r = await slack.botCall('chat.delete', { channel: f.channel, ts: f.ts }, 'form', b.token);
    if (r.ok || r.error === 'message_not_found') deleted.push(f);
    else failed.push({ ...f, error: String(r.error) });
  }
  return { deleted, failed };
}
