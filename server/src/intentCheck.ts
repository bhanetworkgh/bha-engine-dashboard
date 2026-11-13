/**
 * The intent check: Bays' writes are checked against what was actually asked (13 Nov 2026, Destiny —
 * Jason in C0AF7AGC2UV 1794497180.571389; SOPs 4c413e97 and 05ccd8ab, watch DW-1794529248141-RHRX).
 *
 * Jason's rule for any Bays step that turns founder or builder intent into a decision or a loop move:
 * read it back, check it, retry once, then an incident. For a write the read-back has to come before
 * the write, because checking the reply afterwards finds a loop already closed or a watch already
 * opened. So on Bays' token, a call to one of `CHECKED` runs here first:
 *
 *  1. The ask is read from Slack by this server, never taken from the agent: the message the agent
 *     names in `ask` (channel, thread, message ts, all in its context block), with the thread before
 *     it. A tool that already carries a channel and thread (a watch, a file post) falls back to the
 *     newest message a person posted there. A scheduled task names itself and is checked against the
 *     task it says it is, which must be one Bays has.
 *  2. A small model answers one question: does this action (the loop and what is done to it; the
 *     watch's owner and wording; who a message goes to and what it says) match what was asked?
 *  3. A match runs the tool as before. A miss writes nothing and answers `intent_mismatch` with the
 *     reason, so Bays corrects the call once. A second miss on the same ask and tool writes nothing,
 *     answers `intent_mismatch_repeated`, and opens an incident on the Bays lane.
 *
 * A call with no ask it can read is refused `ask_required` (not counted as a miss: it is a missing
 * argument, and the answer says exactly what to send). When the model cannot be reached the call is
 * let through, marked `unchecked`, and one alert an hour says so: a model outage must not stop Bays
 * acting, and it must not pass in silence either. A dry run, an approved call and every caller that
 * is not Bays are not checked. Every check is a row in `engine_intent_checks` (migration 135).
 */
import { createHash, randomUUID } from 'node:crypto';
import { query } from './db';
import * as slack from './slack';
import * as bharag from './bharag';
import * as mirror from './mirror';
import * as events from './events';
import * as engineEvents from './engineEvents';
import { PEOPLE } from './mcp/northStarTools';

/** Which agents are checked. Bays is the one turning founder and builder asks into actions. */
export const CHECKED_AGENTS = new Set(['bays']);

/** Two misses on one ask and tool within this window raise an incident. */
const MISS_WINDOW_HOURS = 6;
const MODEL_TIMEOUT_MS = 25_000;
/**
 * Room for the answer (13 Nov 2026): at 300 tokens (200 on the reply check) the JSON was often cut off,
 * and 31 of 44 intent checks came back with no text at all, so the write went through unchecked.
 */
const MAX_TOKENS = 1500;

/** Why a model stopped and what it sent, for an answer that was empty or not JSON. */
export function stopNote(json: Record<string, unknown>, anthropic: boolean): string {
  if (anthropic) {
    const blocks = ((json.content as { type?: string }[]) || []).map((b) => b.type || '?');
    return `stop ${String(json.stop_reason ?? '?')}, blocks [${blocks.join(', ')}]`;
  }
  const c = ((json.choices as { finish_reason?: string; message?: { content?: unknown; reasoning?: unknown } }[]) || [])[0];
  return `finish ${String(c?.finish_reason ?? '?')}${c?.message?.reasoning ? ', reasoning only' : ''}`;
}
const CONTEXT_MESSAGES = 12;

export const ASK_PROPERTY = {
  type: 'object',
  description:
    'The message that asked for this, so the server can check the action against it before anything is written. From your context block: { "channel_id": "C…", "thread_ts": "…", "message_ts": "…" } (message_ts is the "message ts" line). In a scheduled task run: { "scheduled_task": "<the task name>" }. Only when there is no Slack message (a dashboard panel or another system asked): { "text": "<the question as asked>" }. A miss is refused with the reason: correct the call once; a second miss on the same ask raises an incident.',
  properties: {
    channel_id: { type: 'string' },
    thread_ts: { type: 'string' },
    message_ts: { type: 'string' },
    scheduled_task: { type: 'string' },
    text: { type: 'string' },
  },
  additionalProperties: false,
};

/* ------------------------------------------------------------ the action, in words */

type Args = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const person = (id: string): string => (id ? `${PEOPLE[id] || 'unknown person'} (${id})` : '(nobody)');
const ids = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,;]+/)).map((t) => (/[UW][A-Z0-9]{6,}/.exec(t) || [''])[0]).filter(Boolean);

async function loopRow(args: Args): Promise<{ loop_id: string; what: string; status: string; assignee: string } | null> {
  const nid = str(args.natural_id) || str(args.loop_id);
  const id = str(args.id);
  if (!nid && !id) return null;
  const r = await query<{ natural_id: string; fields: Record<string, unknown> }>(
    `SELECT natural_id, fields FROM engine_loops WHERE ${nid ? 'natural_id = $1' : 'id::text = $1'} ORDER BY updated_at DESC LIMIT 1`,
    [nid || id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { loop_id: row.natural_id, what: str(row.fields.What), status: str(row.fields.Status), assignee: str(row.fields['Assignee Slack User ID']) };
}

async function watchRow(watchId: string): Promise<{ decision: string; owner: string; status: string } | null> {
  if (!watchId) return null;
  const r = await query<{ decision: string; owner_user_id: string; status: string }>(`SELECT decision, owner_user_id, status FROM engine_decision_watches WHERE watch_id = $1`, [watchId]);
  const w = r.rows[0];
  return w ? { decision: w.decision, owner: w.owner_user_id, status: w.status } : null;
}

const loopLine = (l: { loop_id: string; what: string; status: string; assignee: string } | null, fallback: string): string =>
  l ? `loop ${l.loop_id} ("${clip(l.what, 300)}", now ${l.status || 'no status'}, assigned to ${person(l.assignee)})` : `loop ${fallback || '(not named)'} (not found on the dashboard)`;

/**
 * The action a call would take, in plain words, or null when the call is not one this check covers
 * (another kind, a dry run). Each tool's own arguments, plus what the dashboard holds for the target,
 * so a loop named only by id is still checked by what it is.
 */
export async function describe(tool: string, args: Args): Promise<string | null> {
  if (args.dry_run === true) return null;
  switch (tool) {
    case 'update_record': {
      if (args.kind !== 'loops') return null;
      const l = await loopRow(args);
      const f = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Args;
      const verb = /^closed$/i.test(str(f.Status)) ? 'Close' : 'Change';
      return `${verb} ${loopLine(l, str(args.natural_id) || str(args.id))}. Fields set: ${clip(f, 1500)}.`;
    }
    case 'create_record': {
      if (args.kind !== 'loops') return null;
      const f = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Args;
      return `Open a new loop: "${clip(f.What, 600)}", lane ${str(f.lane_tag) || '(none)'}, assigned to ${person(str(f['Assignee Slack User ID']))}, status ${str(f.Status) || 'Open'}.`;
    }
    case 'archive_record': {
      if (args.kind !== 'loops') return null;
      const l = await loopRow(args);
      return `Close ${loopLine(l, str(args.natural_id) || str(args.id))}. Reason given: "${clip(args.reason, 600)}".`;
    }
    case 'move_loop': {
      const l = await loopRow(args);
      return `Move ${loopLine(l, str(args.loop_id))} to builder ${str(args.to_builder) || '(none)'}. Reason given: "${clip(args.reason, 600)}".`;
    }
    case 'open_decision_watch':
      return `Open a Decision Watch with owner ${person(str(args.owner_user_id))}, who is to owe: "${clip(args.decision, 1200)}". Next step: "${clip(args.next_step, 600)}".`;
    case 'update_decision_watch': {
      const w = await watchRow(str(args.watch_id));
      const change = ['next_step', 'sop_refs', 'ns_refs', 'close_on_reply', 'unlink_record', 'replace'].filter((k) => args[k] !== undefined).map((k) => `${k}: ${clip(args[k], 600)}`).join('; ');
      return `Change Decision Watch ${str(args.watch_id)}${w ? ` (owner ${person(w.owner)}, owes "${clip(w.decision, 400)}")` : ' (not found)'}: ${change || 'nothing named'}.`;
    }
    case 'close_decision_watch': {
      const w = await watchRow(str(args.watch_id));
      return `Close Decision Watch ${str(args.watch_id)}${w ? ` (owner ${person(w.owner)}, owes "${clip(w.decision, 400)}")` : ' (not found)'} as ${str(args.outcome) || '(no outcome)'}. Reason: "${clip(args.reason, 500)}". Proof: ${clip(args.proof, 300)}.`;
    }
    case 'snooze_decision_watch': {
      const w = await watchRow(str(args.watch_id));
      return `${args.clear === true ? 'End the snooze on' : `Snooze until ${str(args.until) || '(no date)'}`} Decision Watch ${str(args.watch_id)}${w ? ` (owner ${person(w.owner)}, owes "${clip(w.decision, 400)}")` : ' (not found)'}. Reason: "${clip(args.reason, 400)}".`;
    }
    case 'send_nudge': {
      const to = ids(args.recipients).map(person).join(', ') || '(nobody)';
      const cc = ids(args.cc).map(person).join(', ');
      return `Send a Slack DM as Bays to ${to}${cc ? `, with a marked copy to ${cc}` : ''}. The message says: "${clip(args.text, 1500)}".`;
    }
    case 'post_file':
      return `Post a file titled "${clip(args.title, 200)}" to ${str(args.channel_id)}${str(args.thread_ts) ? ` in thread ${str(args.thread_ts)}` : ''}, with the comment "${clip(args.initial_comment, 400)}". It opens: "${clip(args.content, 1200)}".`;
    case 'edit_sop':
      return `Edit SOP ${str(args.id) || str(args.title) || '(not named)'}. ${args.content !== undefined ? `Its text becomes: "${clip(args.content, 1200)}"` : `Replacements: ${clip(args.replacements, 1200)}`}. Reason given: "${clip(args.reason, 400)}".`;
    default:
      return null;
  }
}

export const CHECKED: ReadonlyArray<string> = [
  'update_record', 'create_record', 'archive_record', 'move_loop',
  'open_decision_watch', 'update_decision_watch', 'close_decision_watch', 'snooze_decision_watch',
  'send_nudge', 'post_file', 'edit_sop',
];

/* ------------------------------------------------------------------ the ask */

export interface Ask {
  key: string;
  source: 'slack' | 'slack_thread_newest' | 'scheduled' | 'agent_stated';
  text: string;
  context: string;
  asker: string | null;
}

type AskResult = { ok: true; ask: Ask } | { ok: false; reason: 'ask_required' | 'ask_not_found'; message: string };

const isTs = (s: string) => /^\d{9,11}\.\d{3,6}$/.test(s);
const cleanText = (t: unknown): string =>
  String(t || '')
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) => '@' + (PEOPLE[id] || id))
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1');

type Msg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string; blocks?: unknown };

async function readThread(channel: string, threadTs: string): Promise<{ ok: true; msgs: Msg[] } | { ok: false; error: string }> {
  const tokens = [process.env[slack.SLACK_TOKEN_VAR]?.trim(), slack.northStarToken()].filter(Boolean) as string[];
  if (!tokens.length) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set` };
  let last = '';
  for (const tok of tokens) {
    try {
      const body = await slack.webApi(tok, 'conversations.replies', { channel, ts: threadTs, limit: 200 });
      if (body.ok === false) { last = String(body.error); continue; }
      return { ok: true, msgs: (body.messages as Msg[]) || [] };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: last || 'unreadable' };
}

const line = (m: Msg, n: number) => `${m.bot_id ? 'Bays or another bot' : PEOPLE[m.user ?? ''] || m.user || 'someone'}: ${clip(cleanText(m.text), n)}`;

async function scheduledTasks(): Promise<string[]> {
  const r = await query<{ tasks: { name?: string; enabled?: boolean }[] | null }>(`SELECT tasks FROM engine_agent_inventory WHERE agent_id = 'Nw5igXu4WWrjUMWB'`);
  return (r.rows[0]?.tasks || []).filter((t) => t && t.enabled !== false && t.name).map((t) => String(t.name));
}

/**
 * A task name as Bays says it (13 Nov 2026): case, dash style (-, --, en and em dashes), spacing and a
 * trailing schedule note in brackets ("(every 6h)") do not count. Bays named "Log review nudge -- Jason"
 * for the task "Log review nudge -- Jason (every 6h)" and the 18:00 nudge was refused.
 */
export function taskKey(name: string): string {
  return name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[‐-―]|-{1,}/g, '-').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
}

/** The one task a name means: an exact match first, else the only task with the same key. Two keys alike is no match. */
export function matchTask(tasks: string[], said: string): string | null {
  const exact = tasks.find((t) => t.toLowerCase() === said.toLowerCase());
  if (exact) return exact;
  const k = taskKey(said);
  const hits = tasks.filter((t) => taskKey(t) === k);
  return hits.length === 1 ? hits[0] : null;
}

export async function resolveAsk(tool: string, args: Args): Promise<AskResult> {
  const a = (args.ask && typeof args.ask === 'object' ? args.ask : {}) as Args;
  const sched = str(a.scheduled_task);
  if (sched) {
    const tasks = await scheduledTasks();
    const hit = matchTask(tasks, sched);
    if (!hit) return { ok: false, reason: 'ask_not_found', message: `"${sched}" is not one of Bays' scheduled tasks. They are: ${tasks.join('; ')}. Name the task this run is exactly as it is called.` };
    return { ok: true, ask: { key: `scheduled:${hit}:${new Date().toISOString().slice(0, 10)}`, source: 'scheduled', text: `Bays' scheduled task "${hit}" is running. Nothing was typed; the task's own purpose is the ask.`, context: '', asker: null } };
  }
  let channel = str(a.channel_id) || str(args.channel_id);
  let thread = str(a.thread_ts) || str(args.thread_ts);
  const message = str(a.message_ts);
  if (!thread && message) thread = message;
  if (channel && thread && isTs(thread) && (!message || isTs(message))) {
    const read = await readThread(channel, thread);
    if (!read.ok) return { ok: false, reason: 'ask_not_found', message: `Slack would not give the thread ${channel} / ${thread} back (${read.error}), so the ask cannot be checked. Send the channel_id, thread_ts and message_ts from your context block exactly.` };
    const msgs = read.msgs.filter((m) => !m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'bot_message');
    let idx = message ? msgs.findIndex((m) => m.ts === message) : -1;
    let source: Ask['source'] = 'slack';
    if (idx < 0) {
      if (message) return { ok: false, reason: 'ask_not_found', message: `No message ${message} is in thread ${channel} / ${thread}. Send the "message ts" from your context block.` };
      for (let i = msgs.length - 1; i >= 0; i--) if (!msgs[i].bot_id && msgs[i].user) { idx = i; break; }
      if (idx < 0) return { ok: false, reason: 'ask_not_found', message: `Thread ${channel} / ${thread} has no message from a person to check this against.` };
      source = 'slack_thread_newest';
    }
    const ask = msgs[idx];
    const before = msgs.slice(Math.max(0, idx - CONTEXT_MESSAGES), idx);
    // The thread's opening post is kept even when it is far above: it is usually what the ask is about.
    if (idx > CONTEXT_MESSAGES && msgs[0]) before.unshift(msgs[0]);
    return {
      ok: true,
      ask: {
        key: `slack:${channel}:${ask.ts}`,
        source,
        text: line(ask, 5000),
        context: before.map((m) => '- ' + line(m, 700)).join('\n'),
        asker: ask.user ?? null,
      },
    };
  }
  const stated = str(a.text);
  if (stated) return { ok: true, ask: { key: `text:${createHash('sha256').update(stated).digest('hex').slice(0, 16)}`, source: 'agent_stated', text: clip(stated, 4000), context: '', asker: null } };
  return {
    ok: false,
    reason: 'ask_required',
    message: `Nothing was written. ${tool} needs "ask": the message that asked for this, so the dashboard can check the action against it first. Send ask: { "channel_id": …, "thread_ts": …, "message_ts": … } from your context block (message_ts is the "message ts" line), or { "scheduled_task": "<task name>" } in a scheduled run, then call ${tool} again with the same arguments.`,
  };
}

/* ------------------------------------------------------------------ the model */

export const SYSTEM = `You check one action an AI assistant called Bays is about to take for Bays Horizon Advisory (BHA), against the Slack message that asked for it. Answer one question: does the action match what was asked?

Rules:
- The action matches when the message asked for it, or it plainly follows from the message (the person asked for the result and this is how it is done). The person need not use the tool's words.
- Loops: the loop must be the one the message means (by id, short code or what it is), and what is done to it must be what was asked: open, close, hold, reassign, update. Closing a loop the message did not ask to close, or did not say was done, is a miss. Changing a loop's wording to say something the message did not say is a miss.
- Decision Watches: the owner must be the person the message puts the decision or reply on, never the person asking for it unless they asked to be watched themselves. The watch's wording must say what that person owes as the message states it, not more and not something else. A watch opened when the message asked for no follow-up is a miss.
- Messages sent for someone (a DM or a post): the recipients must be who the message asked to reach, and the text must say only what the message or the thread supports. A message that states facts about a thread or a record that the thread does not show is a miss.
- SOP edits: the change must be the one the message asked for.
- In a scheduled task run there is no typed message: the action matches when it is what a task of that name exists to do.
- When the message is ambiguous and the action is a reasonable reading of it, it matches. Only call a miss when the action is clearly not what was asked: a different loop or person, a different action, or words the message does not support.

Return exactly one JSON object and nothing else: {"match": true or false, "reason": "one short sentence", "asked": "what the message asked for, in a few words"}.`;

export interface Verdict {
  match: boolean | null;
  reason: string;
  asked: string;
  provider: string | null;
  error: string | null;
}

export function parseVerdict(raw: string): { match: boolean; reason: string; asked: string } | null {
  const tries: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) tries.push(fence[1]);
  const brace = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (brace >= 0 && end > brace) tries.push(raw.slice(brace, end + 1));
  tries.push(raw);
  for (const t of tries) {
    try {
      const j = JSON.parse(t.trim()) as Record<string, unknown>;
      if (typeof j.match === 'boolean') return { match: j.match, reason: String(j.reason ?? '').slice(0, 500), asked: String(j.asked ?? '').slice(0, 300) };
    } catch {
      /* next */
    }
  }
  return null;
}

async function askModel(user: string): Promise<Verdict> {
  const errors: string[] = [];
  const routes = [
    { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY?.trim(), url: `${(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages` },
    { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY?.trim(), url: `${(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions` },
  ];
  for (const r of routes) {
    if (!r.key) { errors.push(`${r.provider}: not configured`); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const anthropic = r.provider === 'anthropic';
      const res = await fetch(r.url, {
        method: 'POST',
        headers: anthropic ? { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'X-Title': 'BHA Engine Dashboard - intent check' },
        body: JSON.stringify(
          anthropic
            ? { model: 'claude-haiku-5-5', max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-haiku-5.5', max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${clip((json.error as { message?: string })?.message ?? json.error ?? '', 200)}`);
      const text = anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
      const v = parseVerdict(text);
      if (!v) throw new Error(`answer was not the JSON asked for (${stopNote(json, anthropic)}): ${clip(text, 160)}`);
      return { ...v, provider: r.provider, error: null };
    } catch (e) {
      errors.push(`${r.provider}: ${e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { match: null, reason: '', asked: '', provider: null, error: errors.join('; ') };
}

export function prompt(ask: Ask, action: string, tool: string): string {
  return [
    ask.source === 'scheduled' ? 'The run:' : ask.source === 'agent_stated' ? 'The question, as Bays reports it (no Slack message exists):' : ask.source === 'slack_thread_newest' ? 'The newest message a person posted in the thread (Bays did not name which message asked):' : 'The message that asked:',
    ask.text,
    ask.context ? `\nEarlier in the thread, for context only (oldest first):\n${ask.context}` : '',
    `\nThe action Bays is about to take (tool ${tool}):`,
    action,
  ].join('\n');
}

/* ------------------------------------------------------------------ the gate */

export interface GateResult {
  /** Present when nothing may be written: the tool's answer to the agent. */
  refusal: Record<string, unknown> | null;
  /** The arguments to hand the tool, with `ask` taken out. */
  args: Args;
}

async function record(row: { agent: string; tool: string; ask_key: string | null; ask_source: string | null; ask_excerpt: string | null; action: string; verdict: string; reason: string | null; asked: string | null; provider: string | null; attempt: number; incident_id?: string | null }): Promise<string> {
  const id = 'IC-' + Date.now() + '-' + randomUUID().slice(0, 4).toUpperCase();
  await query(
    `INSERT INTO engine_intent_checks (check_id, agent, tool, ask_key, ask_source, ask_excerpt, action, verdict, reason, asked, provider, attempt, incident_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, row.agent, row.tool, row.ask_key, row.ask_source, row.ask_excerpt ? clip(row.ask_excerpt, 2000) : null, clip(row.action, 4000), row.verdict, row.reason, row.asked, row.provider, row.attempt, row.incident_id ?? null],
  );
  return id;
}

async function priorMisses(agent: string, tool: string, key: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text n FROM engine_intent_checks WHERE agent = $1 AND tool = $2 AND ask_key = $3 AND verdict = 'mismatch' AND at > now() - ($4 || ' hours')::interval`,
    [agent, tool, key, String(MISS_WINDOW_HOURS)],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function raiseIncident(tool: string, ask: Ask, action: string, reasons: string[]): Promise<string | null> {
  const summary = `Bays intent check / ${tool}: second miss on one ask, nothing written`;
  const body = {
    type: 'INC' as const,
    subsystem: 'AGENT', source: 'bays', severity: 'warning',
    summary,
    payload: {
      lane: 'bays', workflow_or_scenario: 'Bays intent check (dashboard)', failed_node_or_component: tool,
      error_class: 'INTENT_MISMATCH',
      error_message: clip(`Bays tried twice to ${action} The check found each time that this is not what was asked. Ask: ${ask.text}. Reasons: ${reasons.join(' | ')}`, 1000),
      error_message_original_bytes: null,
      execution_id: ask.key, impact_tags: ['bays', 'intent_check'],
      retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
      self_healing_strategy: 'Nothing was written. A person reads the ask and the two attempts on the dashboard (engine_intent_checks) and either makes the change by hand or tells Bays what was meant.',
      research_needed: false, research_id: null, commercial_hint: null, resolved_at: null, resolved_by: null,
    },
  };
  try {
    const opened = await bharag.openIncident('bays', body);
    try {
      const res = opened.raw && typeof opened.raw === 'object' ? (opened.raw as Record<string, unknown>) : {};
      const inc = (res.incident && typeof res.incident === 'object' ? res.incident : res) as Record<string, unknown>;
      await mirror.upsert('incidents', { fields: { ...body, resolution_status: 'open', created_at: new Date().toISOString(), ...inc, entity_id: opened.id }, lane_id: 'bays' }, 'engine');
      await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $2 WHERE natural_id = $1`, [opened.id, new Date().toISOString()]);
      events.changed('incidents');
    } catch (e) {
      console.error(`[intent-check] Engine health copy of ${opened.id} was not written: ${e instanceof Error ? e.message : String(e)}`);
    }
    return opened.id;
  } catch (e) {
    console.error(`[intent-check] the incident for a repeated miss on ${tool} (${ask.key}) was not opened: ${e instanceof Error ? e.message : String(e)}`);
    await alert(`Bays missed the intent check twice on ${tool} and the incident could not be opened (${e instanceof Error ? e.message : String(e)}). Nothing was written. Ask: ${clip(ask.text, 300)}`, `intent_incident_failed:${ask.key}:${tool}`);
    return null;
  }
}

/** Unchecked passes in one hour that open an incident (13 Nov 2026): the hourly alert named only the first, and 35 went by. */
export const UNCHECKED_INCIDENT_AFTER = 3;

/** Whether this many unchecked passes in an hour opens the hour's incident. Pure. */
export function uncheckedCrosses(countThisHour: number): boolean {
  return countThisHour >= UNCHECKED_INCIDENT_AFTER;
}

/**
 * Every unchecked pass is one event; the third in an hour opens one incident on the Bays lane for that
 * hour, naming the count and the last error, so a check that keeps failing open is never only a quiet
 * row. Never throws and never blocks the write or reply it is about.
 */
export async function uncheckedSeen(kind: 'intent_check' | 'answer_check', error: string, ref: string): Promise<void> {
  try {
    const hour = new Date().toISOString().slice(0, 13);
    await engineEvents.record({ event_type: `${kind}_unchecked`, subject_id: ref, lane: 'BAYS', actor: 'intent-check', detail: { error: clip(error, 500), hour }, dedupe_key: `${kind}_unchecked:${ref}` });
    const n = Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_events WHERE event_type = $1 AND at > now() - interval '60 minutes'`, [`${kind}_unchecked`])).rows[0]?.n ?? 0);
    if (!uncheckedCrosses(n)) return;
    const claim = await engineEvents.record({ event_type: `${kind}_unchecked_incident`, subject_id: hour, lane: 'BAYS', actor: 'intent-check', detail: { count: n, error: clip(error, 500) }, dedupe_key: `${kind}_unchecked_incident:${hour}` });
    if (!claim.recorded) return;
    const what = kind === 'intent_check' ? "Bays' writes" : "Bays' and North Star's replies";
    const body = {
      type: 'INC' as const,
      subsystem: 'AGENT', source: 'bays', severity: 'warning',
      summary: `Bays ${kind.replace('_', ' ')}: ${n} unchecked in the last hour`,
      payload: {
        lane: 'bays', workflow_or_scenario: 'Bays intent check (dashboard)', failed_node_or_component: kind,
        error_class: 'CHECK_UNCHECKED',
        error_message: clip(`The check on ${what} let ${n} through unchecked in the last hour, because no model answer could be read. Last error: ${error}`, 1000),
        error_message_original_bytes: null,
        execution_id: `${kind}:${hour}`, impact_tags: ['bays', 'intent_check'],
        retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
        self_healing_strategy: 'Read the unchecked rows (engine_intent_checks verdict unchecked, or the answer-check lines on engine_writes) and their errors; fix the model call or the key before more go through.',
        research_needed: false, research_id: null, commercial_hint: null, resolved_at: null, resolved_by: null,
      },
    };
    const opened = await bharag.openIncident('bays', body);
    const res = opened.raw && typeof opened.raw === 'object' ? (opened.raw as Record<string, unknown>) : {};
    const inc = (res.incident && typeof res.incident === 'object' ? res.incident : res) as Record<string, unknown>;
    await mirror.upsert('incidents', { fields: { ...body, resolution_status: 'open', created_at: new Date().toISOString(), ...inc, entity_id: opened.id }, lane_id: 'bays' }, 'engine');
    await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $2 WHERE natural_id = $1`, [opened.id, new Date().toISOString()]);
    events.changed('incidents');
  } catch (e) {
    console.error(`[intent-check] unchecked incident not opened: ${e instanceof Error ? e.message : String(e)}`);
    await alert(`The check on Bays went unchecked repeatedly and its incident could not be opened (${e instanceof Error ? e.message : String(e)}). Last error: ${clip(error, 300)}`, `${kind}_unchecked_incident_failed:${new Date().toISOString().slice(0, 13)}`);
  }
}

/** One post in the engine alerts channel per dedupe key, claimed by an event first. */
async function alert(text: string, dedupe: string): Promise<void> {
  try {
    const claim = await engineEvents.record({ event_type: 'intent_check_alert', subject_id: dedupe, lane: 'BAYS', actor: 'intent-check', detail: { text: clip(text, 1000) }, dedupe_key: dedupe });
    if (!claim.recorded) return;
    const channel = process.env.QUOTA_ALERT_CHANNEL?.trim();
    if (!channel) return void console.error(`[intent-check] no QUOTA_ALERT_CHANNEL, alert not posted: ${text}`);
    const res = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false });
    if (!res.ok) console.error(`[intent-check] alert refused by Slack (${res.error}): ${text}`);
  } catch (e) {
    console.error(`[intent-check] alert not posted: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function gate(agent: string, tool: string, rawArgs: Args): Promise<GateResult> {
  const { ask: _ask, ...args } = rawArgs;
  void _ask;
  if (!CHECKED_AGENTS.has(agent) || !CHECKED.includes(tool)) return { refusal: null, args };
  const action = await describe(tool, args);
  if (!action) return { refusal: null, args };

  const resolved = await resolveAsk(tool, rawArgs);
  if (!resolved.ok) {
    await record({ agent, tool, ask_key: null, ask_source: null, ask_excerpt: null, action, verdict: resolved.reason, reason: resolved.message, asked: null, provider: null, attempt: 0 });
    return { refusal: { ok: false, reason: resolved.reason, message: resolved.message, written: false }, args };
  }
  const ask = resolved.ask;
  const v = await askModel(prompt(ask, action, tool));

  if (v.match === null) {
    const id = await record({ agent, tool, ask_key: ask.key, ask_source: ask.source, ask_excerpt: ask.text, action, verdict: 'unchecked', reason: v.error, asked: null, provider: null, attempt: 0 });
    await alert(`The intent check on Bays' writes could not reach a model (${clip(v.error, 300)}). Bays' ${tool} went through unchecked (${id}). The third unchecked write in an hour opens an incident.`, `intent_check_unchecked:${new Date().toISOString().slice(0, 13)}`);
    await uncheckedSeen('intent_check', v.error || 'unknown', id);
    return { refusal: null, args };
  }
  if (v.match) {
    await record({ agent, tool, ask_key: ask.key, ask_source: ask.source, ask_excerpt: ask.text, action, verdict: 'match', reason: v.reason, asked: v.asked, provider: v.provider, attempt: 0 });
    return { refusal: null, args };
  }

  const before = await priorMisses(agent, tool, ask.key);
  if (before === 0) {
    const id = await record({ agent, tool, ask_key: ask.key, ask_source: ask.source, ask_excerpt: ask.text, action, verdict: 'mismatch', reason: v.reason, asked: v.asked, provider: v.provider, attempt: 1 });
    return {
      refusal: {
        ok: false, reason: 'intent_mismatch', written: false, check_id: id,
        message: `Nothing was written. The check read the ask and found this is not what was asked: ${v.reason} What was asked: ${v.asked || '(see the message)'}. Re-read the message and correct the call once. A second miss on this ask raises an incident.`,
        asked: v.asked, why: v.reason,
      },
      args,
    };
  }
  const reasons = (await query<{ reason: string }>(`SELECT reason FROM engine_intent_checks WHERE agent = $1 AND tool = $2 AND ask_key = $3 AND verdict = 'mismatch' ORDER BY at DESC LIMIT 3`, [agent, tool, ask.key])).rows.map((r) => r.reason);
  const incident = await raiseIncident(tool, ask, action, [v.reason, ...reasons]);
  const id = await record({ agent, tool, ask_key: ask.key, ask_source: ask.source, ask_excerpt: ask.text, action, verdict: 'mismatch', reason: v.reason, asked: v.asked, provider: v.provider, attempt: before + 1, incident_id: incident });
  await engineEvents.record({ event_type: 'intent_check_repeated_miss', subject_id: ask.key, lane: 'BAYS', actor: 'intent-check', detail: { tool, check_id: id, incident_id: incident, reason: v.reason }, dedupe_key: `intent_check_repeated_miss:${id}` }).catch(() => undefined);
  return {
    refusal: {
      ok: false, reason: 'intent_mismatch_repeated', written: false, raise: true, check_id: id, incident_id: incident,
      message: `Nothing was written. This is the second miss on this ask: ${v.reason} ${incident ? `Incident ${incident} is open` : 'The incident could not be opened and the engine alerts channel was told'}. Do not try ${tool} again for this ask: tell the person what you were going to do, that it did not match what they asked, and ask them to say exactly what they want.`,
      asked: v.asked, why: v.reason,
    },
    args,
  };
}

/* ------------------------------------------------- the reply check (Agent Delivery) */

export const ANSWER_SYSTEM = `You check one reply an AI assistant called Bays wrote to a message at Bays Horizon Advisory (BHA). Answer one question: does the reply respond to what the message asked?

It answers when it does what was asked, gives the information asked for, says it did the action, refuses with a reason, or asks a question it genuinely needs answered before it can act. Partial answers count. A short "Done" for a request to do something counts.

It does not answer when it says there is no request or question when the message plainly has one, asks the person what they want when the message already said, answers a different question from the one asked, or only describes an error or missing input instead of the message.

Return exactly one JSON object and nothing else: {"answers": true or false, "reason": "one short sentence"}.`;

/** Phrases that are a non-answer whatever the model says, the summary chain's own list (12 Nov 2026). */
const NON_ANSWER = /(i (do not|don't|don’t) have (a |any )?(new |pending )?(request|question)|nothing (new )?to act on|no (new |pending |actual )?(request|question) (in|to|here)|what would you like me to (pick up|do)|error payload)/i;

export interface AnswerVerdict { answers: boolean; reason: string; checked: 'model' | 'phrase' | 'unchecked'; provider: string | null; error: string | null }

/**
 * POST /api/engine/answer-check { ask, reply }: does Bays' reply answer the message? Called by
 * `Bays — Agent Delivery` before a reply is posted. The phrase list decides first; then the model.
 * A model that cannot be reached answers `answers: true, checked: 'unchecked'` with the error, so a
 * model outage never stops replies, and the caller records it.
 */
export async function answerCheck(b: Record<string, unknown>): Promise<AnswerVerdict> {
  const ask = clip(b.ask, 6000);
  const reply = clip(b.reply, 8000);
  if (!reply.trim()) return { answers: false, reason: 'The reply is empty.', checked: 'phrase', provider: null, error: null };
  if (NON_ANSWER.test(reply.slice(0, 400))) return { answers: false, reason: `The reply opens by saying there is nothing to answer: "${clip(reply.replace(/\s+/g, ' '), 160)}"`, checked: 'phrase', provider: null, error: null };
  if (!ask.trim()) return { answers: true, reason: 'No message was given to check against.', checked: 'unchecked', provider: null, error: 'no ask' };
  const v = await askAnswerModel(`The message:\n${ask}\n\nBays' reply:\n${reply}`);
  if (v.checked === 'unchecked') await uncheckedSeen('answer_check', v.error || 'unknown', `AC-${Date.now()}-${randomUUID().slice(0, 4)}`);
  return v;
}

async function askAnswerModel(user: string): Promise<AnswerVerdict> {
  const errors: string[] = [];
  const routes = [
    { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY?.trim(), url: `${(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages` },
    { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY?.trim(), url: `${(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions` },
  ];
  for (const r of routes) {
    if (!r.key) { errors.push(`${r.provider}: not configured`); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const anthropic = r.provider === 'anthropic';
      const res = await fetch(r.url, {
        method: 'POST',
        headers: anthropic ? { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'X-Title': 'BHA Engine Dashboard - answer check' },
        body: JSON.stringify(
          anthropic
            ? { model: 'claude-haiku-5-5', max_tokens: MAX_TOKENS, system: ANSWER_SYSTEM, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-haiku-5.5', max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: ANSWER_SYSTEM }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${clip((json.error as { message?: string })?.message ?? json.error ?? '', 200)}`);
      const text = anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((x) => x.type === 'text').map((x) => x.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
      const v = parseAnswer(text);
      if (!v) throw new Error(`answer was not the JSON asked for (${stopNote(json, anthropic)}): ${clip(text, 160)}`);
      return { ...v, checked: 'model', provider: r.provider, error: null };
    } catch (e) {
      errors.push(`${r.provider}: ${e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { answers: true, reason: 'No model could be reached, so the reply was not checked.', checked: 'unchecked', provider: null, error: errors.join('; ') };
}

export function parseAnswer(raw: string): { answers: boolean; reason: string } | null {
  const brace = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  for (const t of [brace >= 0 && end > brace ? raw.slice(brace, end + 1) : '', raw]) {
    if (!t) continue;
    try {
      const j = JSON.parse(t.trim()) as Record<string, unknown>;
      if (typeof j.answers === 'boolean') return { answers: j.answers, reason: String(j.reason ?? '').slice(0, 500) };
    } catch {
      /* next */
    }
  }
  return null;
}

/* ------------------------------------------- loop closes from a log review (Submit Actions) */

async function callModel(system: string, user: string, maxTokens: number): Promise<{ text: string; provider: string } | { error: string }> {
  const errors: string[] = [];
  const routes = [
    { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY?.trim(), url: `${(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages` },
    { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY?.trim(), url: `${(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions` },
  ];
  for (const r of routes) {
    if (!r.key) { errors.push(`${r.provider}: not configured`); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const anthropic = r.provider === 'anthropic';
      const res = await fetch(r.url, {
        method: 'POST',
        headers: anthropic ? { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'X-Title': 'BHA Engine Dashboard - loop close check' },
        body: JSON.stringify(
          anthropic
            ? { model: 'claude-haiku-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-haiku-5.5', max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${clip((json.error as { message?: string })?.message ?? json.error ?? '', 200)}`);
      const text = anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((x) => x.type === 'text').map((x) => x.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
      if (!text.trim()) throw new Error(`no answer text (${stopNote(json, anthropic)})`);
      return { text, provider: r.provider };
    } catch (e) {
      errors.push(`${r.provider}: ${e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: errors.join('; ') };
}

export const CLOSE_SYSTEM = `You check loop closes proposed from a BHA builder's session log. A loop is a tracked piece of work. A reviewer read the log and proposed that some of the builder's loops are now closed. For each one, answer: does the session log show that this loop's specific ask was delivered and verified?

Backed: the log shows the thing the loop asks for was done (built, fixed, shipped, decided, or answered) and checked, or names the result that settles it.
Not backed: the log shows only partial work, planning, a related but different fix, or nothing about this loop at all. The reviewer's evidence sentence is a claim to check against the log, not proof.

Return exactly one JSON object and nothing else: {"loops": [{"loop_id": "LOOP-...", "backed": true or false, "reason": "one short sentence"}]}, one entry for every loop you were given.`;

export function parseCloses(raw: string): { loop_id: string; backed: boolean; reason: string }[] | null {
  const brace = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (brace < 0 || end <= brace) return null;
  try {
    const j = JSON.parse(raw.slice(brace, end + 1)) as { loops?: unknown };
    if (!Array.isArray(j.loops)) return null;
    return j.loops
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).loop_id === 'string' && typeof (x as Record<string, unknown>).backed === 'boolean')
      .map((x) => ({ loop_id: String(x.loop_id), backed: x.backed as boolean, reason: String(x.reason ?? '').slice(0, 300) }));
  } catch {
    return null;
  }
}

/**
 * POST /api/engine/loop-close-check { closes: [{loop_id, what, evidence}], log } (13 Nov 2026, SOP
 * 05ccd8ab, the first target): before `Bays — Submit Actions` closes a builder's loops from their log,
 * each proposed close is checked against the log. A close the check finds unbacked is checked once
 * more on a fresh call, and only a close both calls find unbacked is held open (`held`), with the
 * reason, so the loop is advanced instead of closed and the Codex says why. A close is never added
 * here, only held back. A check that cannot run holds nothing and says `unchecked`.
 */
export async function loopCloseCheck(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const closes = (Array.isArray(b.closes) ? b.closes : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).loop_id === 'string')
    .slice(0, 15)
    .map((x) => ({ loop_id: String(x.loop_id), what: clip(x.what, 400), evidence: clip(x.evidence, 400) }));
  const log = clip(b.log, 90_000);
  if (!closes.length) return { checked: 'nothing_to_check', held: [], kept: [], dry_run: true };
  if (!log.trim()) return { checked: 'unchecked', error: 'no log text was sent', held: [], kept: closes.map((c) => c.loop_id), dry_run: true };
  const ask = (list: typeof closes) =>
    `The session log:\n${log}\n\nThe proposed closes:\n${list.map((c) => `- ${c.loop_id}: the loop asks "${c.what}". The reviewer's evidence: "${c.evidence}"`).join('\n')}`;
  const first = await callModel(CLOSE_SYSTEM, ask(closes), 2500);
  if ('error' in first) return { checked: 'unchecked', error: first.error, held: [], kept: closes.map((c) => c.loop_id), dry_run: true };
  const v1 = parseCloses(first.text);
  if (!v1) return { checked: 'unchecked', error: `answer was not the JSON asked for: ${clip(first.text, 160)}`, held: [], kept: closes.map((c) => c.loop_id), dry_run: true };
  const doubted = closes.filter((c) => v1.find((v) => v.loop_id === c.loop_id)?.backed === false);
  if (!doubted.length) return { checked: 'model', provider: first.provider, held: [], kept: closes.map((c) => c.loop_id), verdicts: v1, dry_run: true };
  // Retry once, on a fresh call, for the doubted ones only.
  const second = await callModel(CLOSE_SYSTEM, ask(doubted), MAX_TOKENS);
  const v2 = 'error' in second ? null : parseCloses(second.text);
  const held = doubted
    .filter((c) => (v2 ? v2.find((v) => v.loop_id === c.loop_id)?.backed !== true : true))
    .map((c) => ({ loop_id: c.loop_id, reason: v2?.find((v) => v.loop_id === c.loop_id)?.reason || v1.find((v) => v.loop_id === c.loop_id)?.reason || 'the log does not show it finished' }));
  const kept = closes.map((c) => c.loop_id).filter((id) => !held.find((h) => h.loop_id === id));
  const out = { checked: v2 ? 'model_twice' : 'model_once', provider: first.provider, held, kept, verdicts: v1, second: v2, second_error: v2 ? null : 'error' in second ? second.error : 'unparseable', dry_run: true };
  for (const h of held) {
    await engineEvents.record({ event_type: 'log_loop_close_held', subject_id: h.loop_id, lane: 'BAYS', actor: 'intent-check', detail: { reason: h.reason, submission_id: clip(b.submission_id, 80) || null, codex_entry_id: clip(b.codex_entry_id, 120) || null }, dedupe_key: `log_loop_close_held:${h.loop_id}:${clip(b.submission_id, 80) || Date.now()}` }).catch(() => undefined);
  }
  return out;
}

/* ---------------------------------------- Media Twin rewrites against Jason's notes */

export const REWRITE_SYSTEM = `You check rewrites of social media posts for Bays Horizon Advisory (BHA). Jason rejected a draft for a platform and wrote a note saying what was wrong. The Media Twin rewrote it. For each platform, answer: does the new text do what Jason's note asks?

Addressed: the change the note asks for is made (a claim removed or softened, a tone changed, a fact fixed, a length cut, a different angle), even if worded differently from how Jason would put it.
Not addressed: the thing the note objects to is still there, the rewrite ignores the note, or it makes a different change from the one asked for.

Judge only against the note. Do not judge the post's quality otherwise.

Return exactly one JSON object and nothing else: {"platforms": [{"platform": "linkedin", "addressed": true or false, "reason": "one short sentence"}]}, one entry for every platform you were given.`;

/**
 * POST /api/engine/rewrite-check { rewrites: [{platform, note, old, new}] } (13 Nov 2026, SOP 4c413e97):
 * before `Media Twin — Rewrite Draft` saves a revision, each rewritten platform is checked against
 * Jason's note for it. The workflow asks the agent once more on a fresh memory when one misses, and
 * raises when the retry misses too, so a rewrite that ignored the note never reaches Jason as though
 * it had answered it. A check that cannot run answers `unchecked` and misses nothing.
 */
export async function rewriteCheck(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rewrites = (Array.isArray(b.rewrites) ? b.rewrites : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).platform === 'string')
    .slice(0, 4)
    .map((x) => ({ platform: String(x.platform), note: clip(x.note, 2000), old: clip(x.old, 4000), new: clip(x.new, 4000) }));
  const withNote = rewrites.filter((r) => r.note.trim());
  if (!withNote.length) return { checked: 'nothing_to_check', missed: [], addressed: rewrites.map((r) => r.platform), dry_run: true };
  const user = withNote.map((r) => `--- ${r.platform}\nJason's note: "${r.note}"\nThe rejected text:\n${r.old}\nThe rewrite:\n${r.new}`).join('\n\n');
  const res = await callModel(REWRITE_SYSTEM, user, MAX_TOKENS);
  if ('error' in res) return { checked: 'unchecked', error: res.error, missed: [], addressed: rewrites.map((r) => r.platform), dry_run: true };
  let verdicts: { platform: string; addressed: boolean; reason: string }[] | null = null;
  try {
    const t = res.text;
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) as { platforms?: unknown };
    if (Array.isArray(j.platforms)) verdicts = (j.platforms as Record<string, unknown>[]).filter((x) => x && typeof x.platform === 'string' && typeof x.addressed === 'boolean').map((x) => ({ platform: String(x.platform), addressed: x.addressed as boolean, reason: String(x.reason ?? '').slice(0, 300) }));
  } catch {
    verdicts = null;
  }
  if (!verdicts) return { checked: 'unchecked', error: `answer was not the JSON asked for: ${clip(res.text, 160)}`, missed: [], addressed: rewrites.map((r) => r.platform), dry_run: true };
  const missed = withNote.filter((r) => verdicts!.find((v) => v.platform === r.platform)?.addressed === false).map((r) => ({ platform: r.platform, note: r.note, reason: verdicts!.find((v) => v.platform === r.platform)!.reason }));
  return { checked: 'model', provider: res.provider, missed, addressed: rewrites.map((r) => r.platform).filter((p) => !missed.find((m) => m.platform === p)), verdicts, dry_run: true };
}
