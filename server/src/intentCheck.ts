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

export async function resolveAsk(tool: string, args: Args): Promise<AskResult> {
  const a = (args.ask && typeof args.ask === 'object' ? args.ask : {}) as Args;
  const sched = str(a.scheduled_task);
  if (sched) {
    const tasks = await scheduledTasks();
    const hit = tasks.find((t) => t.toLowerCase() === sched.toLowerCase());
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
            ? { model: 'claude-haiku-5-5', max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-haiku-5.5', max_tokens: 300, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${clip((json.error as { message?: string })?.message ?? json.error ?? '', 200)}`);
      const text = anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
      const v = parseVerdict(text);
      if (!v) throw new Error(`answer was not the JSON asked for: ${clip(text, 160)}`);
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
    await alert(`The intent check on Bays' writes could not reach a model (${clip(v.error, 300)}). Bays' ${tool} went through unchecked (${id}). Further unchecked writes this hour are recorded on engine_intent_checks without another post.`, `intent_check_unchecked:${new Date().toISOString().slice(0, 13)}`);
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
