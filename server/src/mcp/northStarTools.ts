/**
 * North Star's three code tools, ported from `North Star — Tools Router`
 * (`G6Myypk64kpcaVhz`) so the Router can retire (2026-09-24, Destiny).
 *
 *   read_slack             — the `RS -` nodes
 *   read_open_loops        — the `ROL -` nodes
 *   get_priority_evidence  — the `PE -` nodes
 *
 * **Ported as written.** The limits, labels, clip lengths and sort orders below
 * are the Code nodes' own, several of them tuned on the 22 Sep out-of-memory
 * crash (seven North Star runs reading Slack at 08:00 at once): a 7-day window
 * at most, 50 messages a channel, 25 threads, 50 replies a thread, 60,000
 * characters out. They are not improved here, and every comment that says
 * "the source" means the node it names.
 *
 * The n8n nodes read the engine through `GET /api/engine/:kind`; these read the
 * same rows through the function that route calls, `mirror.lookup`, with the
 * same limits and orders, so a row reaches North Star in the shape it always
 * did. Slack is read as **North Star's own bot** (`SLACK_NORTH_STAR_BOT_TOKEN`),
 * never as Bays.
 *
 * All three are reads, registered with the read tools, and each call is logged
 * to `engine_writes` as `read` like `find_records`.
 */
import * as mirror from '../mirror';
import * as slack from '../slack';
import type { ToolAnnotations, ToolDefinition, ToolDeps } from './tools';

const READS_WORLD: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const READS_DB: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** The BHA roster, verbatim from RS - Build Digest and ROL - Label Loops. */
export const PEOPLE: Record<string, string> = {
  U0A9V97949F: 'Jason Bays',
  U0AEW3TBYH1: 'Destiny Arupi',
  U0AD1V1D65N: 'Kaiqi Yang',
  U0AF011R821: 'Jegan',
  U0AC6RFNP3P: 'Ahad',
  U0BKT6MAW2Y: 'Hardik Bhatt',
  U0BNQGG020Y: 'Kavin',
};

/* The source's caps (RS - Collect Messages, RS - Build Digest, the HTTP nodes). */
const HISTORY_LIMIT = 50;
const MAX_THREADS = 25;
const REPLIES_LIMIT = 50;
const SLACK_CHARS = 60_000;
const BOT_CLIP = 300;
const PERSON_CLIP = 1_200;
const BATCH = 10;
const BATCH_PAUSE_MS = 1_500;
const SKIP = ['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name'];
const LINK_BASE = 'https://bayshorizonnetwork.slack.com/archives/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The HTTP nodes' batching: ten at a time, 1.5 s between batches. */
async function batched<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    if (i) await sleep(BATCH_PAUSE_MS);
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  }
  return out;
}

async function logRead(tool: string, kind: string, deps: ToolDeps, detail: string, t0: number): Promise<void> {
  await mirror.logWrite({
    endpoint: `mcp:${tool}`,
    kind,
    method: 'MCP',
    key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET',
    outcome: 'read',
    detail: detail.slice(0, 400),
    ms: Date.now() - t0,
  });
}

/* ================================================================ read_slack */

interface SlackMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string;
  text?: string;
  subtype?: string;
  reply_count?: number;
  latest_reply?: string;
}

export interface ReadSlackArgs {
  since_hours?: unknown;
  keywords?: unknown;
  slack_channel?: unknown;
}

/**
 * The Read_Slack branch, end to end. Answers the digest, or `ok:false` with the
 * source's own plain-English reason where RS - Plan Reads threw.
 */
export async function readSlack(args: ReadSlackArgs): Promise<Record<string, unknown>> {
  const tok = slack.northStarToken();
  if (!tok) return { ok: false, reason: 'not_configured', message: `${slack.NS_TOKEN_VAR} is not set on this server, so North Star cannot read Slack as itself.` };

  /* RS - List Channels */
  let body: Record<string, unknown>;
  try {
    body = await slack.webApi(tok, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '999' });
  } catch (e) {
    return { ok: false, reason: 'slack_error', step: 'users.conversations', message: e instanceof Error ? e.message : String(e) };
  }

  /* RS - Plan Reads */
  if (body.ok === false) {
    const hint = body.error === 'missing_scope' ? ' -- the North Star Slack app needs channels:read and groups:read, then a reinstall.' : '';
    return { ok: false, reason: body.error === 'missing_scope' ? 'missing_scope' : 'slack_refused', step: 'users.conversations', message: 'Slack refused users.conversations: ' + String(body.error) + hint };
  }
  let hours = parseInt(String(args.since_hours ?? ''), 10);
  if (!hours || hours < 1) hours = 72;
  if (hours > 168) hours = 168;
  const oldest = Math.floor(Date.now() / 1000) - hours * 3600;
  const only = String(args.slack_channel || '').replace(/^#/, '').trim().toLowerCase();
  const chans = ((body.channels as { id: string; name?: string; is_archived?: boolean; is_im?: boolean; is_mpim?: boolean }[]) || [])
    .filter((c) => !c.is_archived && !c.is_im && !c.is_mpim)
    .filter((c) => !only || c.id.toLowerCase() === only || String(c.name || '').toLowerCase() === only);
  if (chans.length === 0) {
    return {
      ok: false,
      reason: 'no_channels',
      message: only ? 'North Star is not a member of a channel matching "' + only + '".' : 'North Star is not a member of any channel, so there is nothing to read.',
    };
  }
  const plans = chans.map((c) => ({ channel_id: c.id, channel_name: c.name ?? c.id, oldest, hours }));

  /* RS - Channel History */
  let res: Record<string, unknown>[];
  try {
    res = await batched(plans, (p) => slack.webApi(tok, 'conversations.history', { channel: p.channel_id, oldest: p.oldest, limit: HISTORY_LIMIT }));
  } catch (e) {
    return { ok: false, reason: 'slack_error', step: 'conversations.history', message: e instanceof Error ? e.message : String(e) };
  }

  /* RS - Collect Messages */
  const parents: { channel_id: string; channel: string; ts: string; user: string; bot: boolean; bot_name: string; text: string; reply_count: number }[] = [];
  const threads: { channel_id: string; channel: string; ts: string; oldest: number }[] = [];
  const failed: string[] = [];
  res.forEach((r, i) => {
    const p = plans[i];
    if (!r || r.ok === false || r.error) {
      const err = r && (r.error as { message?: string } | string | undefined);
      failed.push((p.channel_name || '?') + ': ' + ((err && (typeof err === 'object' ? err.message || JSON.stringify(err) : err)) || 'no response'));
      return;
    }
    for (const m of (r.messages as SlackMsg[]) || []) {
      if (m.subtype && SKIP.includes(m.subtype)) continue;
      parents.push({ channel_id: p.channel_id, channel: p.channel_name, ts: m.ts, user: m.user || '', bot: !!m.bot_id, bot_name: (m.bot_profile && m.bot_profile.name) || m.username || '', text: String(m.text || '').slice(0, 2000), reply_count: m.reply_count || 0 });
      if ((m.reply_count || 0) > 0 && parseFloat(m.latest_reply || '0') >= p.oldest) threads.push({ channel_id: p.channel_id, channel: p.channel_name, ts: m.ts, oldest: p.oldest });
    }
  });
  threads.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  const threadsTotal = threads.length;
  const titems = threads.slice(0, MAX_THREADS);

  /* RS - Thread Replies (the source's api.test placeholder, when there are no threads, calls nothing here) */
  let reps: Record<string, unknown>[];
  try {
    reps = await batched(titems, (t) => slack.webApi(tok, 'conversations.replies', { channel: t.channel_id, ts: t.ts, oldest: t.oldest, limit: REPLIES_LIMIT }));
  } catch (e) {
    return { ok: false, reason: 'slack_error', step: 'conversations.replies', message: e instanceof Error ? e.message : String(e) };
  }

  /* RS - Build Digest */
  const who = (u: string | undefined, bot: boolean, bn: string | undefined) => (bot ? (bn || 'bot') + ' (bot)' : PEOPLE[u ?? ''] || u || 'unknown');
  const link = (ch: string, ts: string, thr?: string) => LINK_BASE + ch + '/p' + String(ts).replace('.', '') + (thr && thr !== ts ? '?thread_ts=' + thr : '');
  const clean = (t: unknown) =>
    String(t || '')
      .replace(/<@(U[A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) => '@' + (PEOPLE[id] || id))
      .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/<!(channel|here|everyone)>/g, '@$1');

  const all: { channel: string; author: string; is_bot: boolean; ts: string; kind: string; replies?: number; text: string; link: string }[] = [];
  for (const m of parents) all.push({ channel: m.channel, author: who(m.user, m.bot, m.bot_name), is_bot: m.bot, ts: m.ts, kind: 'message', replies: m.reply_count, text: clean(m.text), link: link(m.channel_id, m.ts) });
  titems.forEach((t, i) => {
    const r = reps[i] || {};
    if (r.ok === false || r.error) return;
    for (const m of (r.messages as SlackMsg[]) || []) {
      if (m.ts === t.ts || parseFloat(m.ts) < t.oldest) continue;
      all.push({ channel: t.channel, author: who(m.user, !!m.bot_id, m.bot_profile ? m.bot_profile.name : ''), is_bot: !!m.bot_id, ts: m.ts, kind: 'thread reply', text: clean(String(m.text || '').slice(0, 2000)), link: link(t.channel_id, m.ts, t.ts) });
    }
  });

  const q = String(args.keywords || '').trim();
  let kept = all;
  if (q) {
    const words = q.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
    if (words.length) kept = all.filter((m) => { const t = m.text.toLowerCase(); return words.some((w) => t.includes(w)); });
  }
  kept.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));

  const out: Record<string, unknown>[] = [];
  let chars = 0;
  for (const m of kept) {
    const row: Record<string, unknown> = { channel: '#' + m.channel, author: m.author, at: new Date(parseFloat(m.ts) * 1000).toISOString(), kind: m.kind, text: m.is_bot ? m.text.slice(0, BOT_CLIP) : m.text.slice(0, PERSON_CLIP), link: m.link };
    if (m.replies) row.replies = m.replies;
    chars += JSON.stringify(row).length;
    if (chars > SLACK_CHARS) break;
    out.push(row);
  }

  return {
    ok: true,
    mode: 'slack',
    window_hours: hours,
    keywords: q || null,
    channels_read: plans.length,
    channels_failed: failed,
    threads_expanded: titems.length,
    threads_not_expanded: Math.max(0, threadsTotal - MAX_THREADS),
    messages_matched: kept.length,
    messages_returned: out.length,
    truncated: out.length < kept.length,
    no_data: kept.length === 0,
    messages: out,
  };
}

export const readSlackTool: ToolDefinition = {
  name: 'read_slack',
  description:
    'North Star’s Slack read, as its own bot: every public and private channel it is in (never DMs or group DMs, archived excluded), threads included, newest first. since_hours defaults to 72 and is capped at 168. keywords keeps messages containing any of the words (over two characters). slack_channel narrows to one channel by name or id. Caps, as tuned on the 22 Sep out-of-memory crash: 50 messages a channel, the 25 newest threads with replies in the window expanded, 50 replies a thread, 60,000 characters out; bot posts cut to 300 characters, people’s to 1,200. Each item is {channel, author, at, kind (message | thread reply), text, link}. Also returns window_hours, channels_read, channels_failed, threads_expanded, threads_not_expanded, messages_matched, messages_returned, truncated, no_data. A missing scope or no channel is ok:false with the reason.',
  inputSchema: {
    type: 'object',
    properties: {
      since_hours: { type: 'number', description: 'How far back. Default 72, at most 168.' },
      keywords: { type: 'string', description: 'Optional. Any-word match, e.g. "LOOP-" or "vfarm, pilot".' },
      slack_channel: { type: 'string', description: 'Optional. One channel, by name (with or without #) or id.' },
    },
    additionalProperties: false,
  },
  annotations: { ...READS_WORLD, title: 'Read Slack as North Star' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const out = await readSlack(args);
    await logRead('read_slack', 'slack', deps, out.ok ? `${String(out.window_hours)}h ${out.keywords ? `"${String(out.keywords)}" ` : ''}→ ${String(out.messages_returned)} of ${String(out.messages_matched)} from ${String(out.channels_read)} channels` : `refused: ${String(out.reason)} — ${String(out.message)}`, t0);
    return out;
  },
};

/* =========================================================== read_open_loops */

const ID_RE = /LOOP-\d+-[A-Z0-9]{4}/g;
/** One page of the lookup; read_open_loops pages until it has every loop. */
const LOOPS_PAGE = 1_000;
const LOG_ROWS = 60;
const LOOPS_CHARS = 70_000;

export async function readOpenLoops(args: { builder_id?: unknown }): Promise<Record<string, unknown>> {
  const builder = typeof args.builder_id === 'string' ? args.builder_id.trim() : '';

  /*
   * ROL - Fetch Loops read `limit=1000`, newest first, and nothing past it. On
   * 24 Sep the table held 1,004 rows, so the four oldest were never seen — two
   * of them still Open (Jegan's LOOP-1787828953631-CCTQ and
   * LOOP-1787828951562-TUQ7). Every page is read now (decision 2026-09-24,
   * Destiny), until a short page or the matched count says there are no more.
   */
  const filters: mirror.LookupFilter[] = builder ? [{ op: 'f', name: 'Assignee Slack User ID', value: builder }] : [];
  const lb = { rows: [] as mirror.LookupRow[], count: 0 };
  for (let offset = 0; ; offset += LOOPS_PAGE) {
    const page = await mirror.lookup('loops', { filters, limit: LOOPS_PAGE, order: 'created_desc', offset });
    lb.rows.push(...page.rows);
    lb.count = page.count || lb.count;
    if (page.rows.length < LOOPS_PAGE || lb.rows.length >= lb.count) break;
  }
  const cx = await mirror.lookup('codex', { filters: [], limit: LOG_ROWS, order: 'created_desc' });

  /* ROL - Slack Mentions: this same tool's Slack read, "LOOP-", 168 hours. */
  let sl: Record<string, unknown> = {};
  let slackError: string | null = null;
  try {
    sl = await readSlack({ keywords: 'LOOP-', since_hours: 168 });
    if (sl.ok === false) {
      slackError = `${String(sl.reason)}: ${String(sl.message)}`;
      sl = {};
    }
  } catch (e) {
    slackError = e instanceof Error ? e.message : String(e);
    sl = {};
  }

  /* ROL - Label Loops */
  const now = Date.now();
  const days = (d: unknown) => { if (!d) return null; const t = new Date(String(d)).getTime(); return isNaN(t) ? null : Math.floor((now - t) / 86400000); };
  const iso = (d: unknown) => { const t = new Date(String(d)).getTime(); return isNaN(t) ? '' : new Date(t).toISOString(); };

  const loops = lb.rows.map((r) => r.fields || {}).filter((f) => String(f.Status || '').toLowerCase() !== 'closed');

  const fromLogs: Record<string, { at: string; how: string; by: unknown; codex: unknown }> = {};
  for (const row of cx.rows) {
    const f = row.fields || {};
    const at = iso(f['Processed At'] || f['Timestamp'] || row.created_time);
    const ids = new Set(JSON.stringify(f).match(ID_RE) || []);
    for (const id of ids) {
      let how = 'mentioned';
      if (String(f['Loops Closed'] || '').includes(id)) how = 'closed';
      else if (String(f['Loops Advanced'] || '').includes(id)) how = 'advanced';
      else if (String(f['Loops Opened'] || '').includes(id)) how = 'opened';
      const prev = fromLogs[id];
      if (!prev || at > prev.at) fromLogs[id] = { at, how, by: f['Builder Name'] || '', codex: f['Codex Entry ID'] || f['Submission ID'] || '' };
    }
  }

  const fromSlack: Record<string, { at: string; by: unknown; channel: unknown; link: unknown }> = {};
  for (const m of (sl.messages as { text?: string; at: string; author: unknown; channel: unknown; link: unknown }[]) || []) {
    for (const id of String(m.text || '').match(ID_RE) || []) {
      if (!fromSlack[id] || m.at > fromSlack[id].at) fromSlack[id] = { at: m.at, by: m.author, channel: m.channel, link: m.link };
    }
  }

  const out = loops.map((f) => {
    const id = String(f.loop_id || '');
    const lg = fromLogs[id] || null;
    const s = fromSlack[id] || null;
    const raisedBy = String(f['Raised By'] || '');
    const byJason = /jason/i.test(raisedBy) || raisedBy.includes('U0A9V97949F');
    const age = days(f['Date Raised']);
    const lastTouch = [lg && lg.at, s && s.at].filter(Boolean).sort().pop() || null;
    const idle = lastTouch ? days(lastTouch) : null;
    let label: string;
    if (lg && lg.how === 'closed') label = 'maybe done';
    else if (idle !== null && idle <= 7) label = 'moving';
    else if (age !== null && age >= 7) label = 'stalled';
    else label = 'new';
    return {
      loop_id: id,
      what: String(f.What || '').slice(0, 240),
      status: f.Status || '',
      owner: PEOPLE[String(f['Assignee Slack User ID'] ?? '')] || f['Assignee Slack User ID'] || 'unassigned',
      raised_by: raisedBy,
      raised_by_jason: byJason,
      age_days: age,
      last_log_touch: lg,
      last_slack_mention: s,
      label,
    };
  });

  const RANK: Record<string, number> = { stalled: 0, moving: 1, 'maybe done': 2, new: 3 };
  out.sort((a, b) => Number(b.raised_by_jason) - Number(a.raised_by_jason) || RANK[a.label] - RANK[b.label] || (b.age_days || 0) - (a.age_days || 0));
  const counts = out.reduce<Record<string, number>>((m, l) => { m[l.label] = (m[l.label] || 0) + 1; return m; }, {});

  const kept: typeof out = [];
  let chars = 0;
  for (const l of out) { chars += JSON.stringify(l).length; if (chars > LOOPS_CHARS) break; kept.push(l); }

  return {
    ok: true,
    mode: builder ? 'single_builder' : 'global',
    builder_id: builder || null,
    no_data: out.length === 0,
    total_open_loops: out.length,
    counts,
    sorted_by: 'Jason-raised first, then stalled, moving, maybe done, new; oldest first within each',
    slack_checked: sl.mode === 'slack',
    slack_window_hours: (sl.window_hours as number) || null,
    // Not in the source, whose Slack failure stopped the whole run: here a
    // Slack read that fails leaves every label decided on work logs alone, and
    // says so, rather than taking the loops down with it.
    ...(slackError ? { slack_error: slackError, note: 'Slack was not read, so no loop was labelled from a Slack mention — labels here come from work logs and age only.' } : {}),
    loop_rows_read: lb.rows.length,
    work_logs_checked: cx.rows.length,
    returned: kept.length,
    truncated: kept.length < out.length,
    loops: kept,
  };
}

export const readOpenLoopsTool: ToolDefinition = {
  name: 'read_open_loops',
  description:
    'Every loop not Closed, from the engine database (optionally one builder’s, by Slack user id), each labelled moving (a work log or Slack touched it in the last 7 days), stalled (7+ days old, untouched for a week), maybe done (a work log says it was closed but it is not Closed) or new (under a week old). Matching is on the exact loop id, LOOP-<digits>-<4 chars>, against the 60 newest Codex work logs and 7 days of Slack read as North Star. Sorted Jason-raised first, then stalled, moving, maybe done, new; oldest first within each. At most 70,000 characters. Returns total_open_loops, counts, sorted_by, slack_checked, work_logs_checked, returned, truncated, loops.',
  inputSchema: {
    type: 'object',
    properties: { builder_id: { type: 'string', description: 'Optional. The builder’s Slack user id (Assignee Slack User ID), e.g. U0AEW3TBYH1.' } },
    additionalProperties: false,
  },
  annotations: { ...READS_WORLD, title: 'Open loops, labelled' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const out = await readOpenLoops(args);
    await logRead('read_open_loops', 'loops', deps, `${out.builder_id ? `builder ${String(out.builder_id)} ` : ''}→ ${String(out.returned)} of ${String(out.total_open_loops)} ${JSON.stringify(out.counts)} slack_checked=${String(out.slack_checked)}`, t0);
    return out;
  },
};

/* ===================================================== get_priority_evidence */

export async function getPriorityEvidence(args: { lane_id?: unknown }): Promise<Record<string, unknown>> {
  const lane = String(args.lane_id || '').trim();

  /* PE - Fetch Codex, PE - Fetch RT Jobs, PE - Fetch Commercial */
  const cx = (await mirror.lookup('codex', { filters: [], limit: 40, order: 'created_desc' })).rows;
  const rt = (await mirror.lookup('rt-jobs', { filters: [], limit: 300, order: 'created_desc' })).rows;
  const cc = (await mirror.lookup('commercial', { filters: [], limit: 300, order: 'created_desc' })).rows;

  /* PE - Format Evidence */
  const clip = (v: unknown, n: number) => { if (v === null || v === undefined) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '...' : s; };

  const logs = cx.map((r) => { const f = r.fields || {}; return {
    codex_id: f['Codex Entry ID'] || f['Submission ID'] || '',
    builder: f['Builder Name'] || '',
    date: f['Processed At'] || f['Timestamp'] || r.created_time || '',
    session: clip(f['Session Description'], 300),
    summary: clip(f['Summary'], 700),
    lanes_touched: clip(f['Lanes Touched'], 200),
    lane_states_changed: clip(f['Lane States Changed'], 400),
    loops_closed: clip(f['Loops Closed'], 400),
    loops_advanced: clip(f['Loops Advanced'], 400),
    loops_opened: clip(f['Loops Opened'], 400),
    jason_status: f['Jason Status'] || '',
    jason_notes: clip(f['Jason Notes'], 500),
  }; });

  // `r.lane_id` is read first as the source reads it; the lookup row carries no
  // such column, so — as through the HTTP route — the field is what answers.
  const jobs = rt.map((r) => { const f = r.fields || {}; const row = r as mirror.LookupRow & { lane_id?: string | null }; return {
    lane_id: row.lane_id || f['Lane'] || f['lane_id'] || '',
    job_id: f['Job ID'] || r.natural_id || '',
    status: f['Status'] || f['status'] || '',
    question: clip(f['Question'] || f['question'], 400),
    outcome: clip(f['Outcome'] || f['outcome'], 300),
    summary: clip(f['Summary'] || f['Answer Summary'] || f['research_summary'], 600),
    updated_at: r.updated_at,
  }; });

  const cards = cc.map((r) => { const f = r.fields || {}; return {
    lane_id: f.lane_id || '', card_id: f.card_id || '', title: f.opportunity_title || '',
    readiness_state: f.readiness_state || '', lane_state: f.lane_state || '', blocked_reason: clip(f.lane_state_blocked_reason, 300),
    next_action: clip(f.next_action, 300), missing_proof: clip(f.missing_proof, 300), confidence: f.confidence || '',
    pilot_state: f.pilot_state || '', engine_movement_state: f.engine_movement_state || '',
    missing_research_count: f.missing_research_count || null, created_at: f.created_at || '',
  }; });

  const forLane = (x: { lane_id: unknown }) => !lane || String(x.lane_id || '') === lane;
  const lanesSeen = [...new Set([...cards.map((c) => c.lane_id), ...jobs.map((j) => j.lane_id)].filter(Boolean).map(String))].sort();
  const laneCards = cards.filter(forLane);
  const laneJobs = jobs.filter(forLane);
  const recentLogs = lane ? logs.slice(0, 15) : logs.slice(0, 25);

  return {
    ok: true,
    mode: lane ? 'single_lane' : 'global',
    lane_id: lane || null,
    no_data: laneCards.length + laneJobs.length === 0 && recentLogs.length === 0,
    source_note: 'Engine database via the dashboard, read live. Work logs are the newest first and are not filtered by lane -- read lanes_touched and lane_states_changed yourself. Research jobs and cards are filtered to lane_id when one was given.',
    lanes_seen: lanesSeen,
    recent_work_logs: recentLogs,
    research_jobs: laneJobs.slice(0, 60),
    research_jobs_total: laneJobs.length,
    commercial_cards: laneCards.slice(0, 40),
    commercial_cards_total: laneCards.length,
  };
}

export const getPriorityEvidenceTool: ToolDefinition = {
  name: 'get_priority_evidence',
  description:
    'What North Star weighs after Slack, from the engine database: the newest Codex work logs (25 with no lane, 15 with one — never lane-filtered; read lanes_touched and lane_states_changed), Research Twin jobs (at most 60, of the newest 300) and commercial cards (at most 40, of the newest 300), the last two filtered to lane_id when one is given. Returns mode, lane_id, no_data, source_note, lanes_seen, recent_work_logs, research_jobs + research_jobs_total, commercial_cards + commercial_cards_total.',
  inputSchema: {
    type: 'object',
    properties: { lane_id: { type: 'string', description: 'Optional, e.g. LANE-VFARM-ZONE_MONITORING_SAAS. lanes_seen lists the ones held.' } },
    additionalProperties: false,
  },
  annotations: { ...READS_DB, title: 'North Star’s priority evidence' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const out = await getPriorityEvidence(args);
    await logRead('get_priority_evidence', 'priority_evidence', deps, `${out.lane_id ? `lane ${String(out.lane_id)} ` : ''}→ ${(out.recent_work_logs as unknown[]).length} logs, ${String(out.research_jobs_total)} jobs, ${String(out.commercial_cards_total)} cards`, t0);
    return out;
  },
};

export const NORTH_STAR_TOOLS: ToolDefinition[] = [readSlackTool, readOpenLoopsTool, getPriorityEvidenceTool];
