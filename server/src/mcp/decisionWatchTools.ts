/**
 * Decision Watch over MCP (2026-10-11, Destiny — LOOP-1791743584778-5YQA).
 *
 *   `open_decision_watch`   — Bays, when a decision is put to a named person in
 *                             a thread it is already in, or when somebody says
 *                             "Bays, watch this".
 *   `list_decision_watches` — what is being watched and what happened to the rest.
 *   `close_decision_watch`  — the requester, the owner, Destiny or Jason.
 *   `run_decision_watch`    — the sweep on demand, for a person on the
 *                             connector. In no agent's scope.
 *
 * All four are on the write connection; the first three are in Bays' scope.
 * Every call is on `engine_mcp_writes` (kind `decision_watch`), refusals and
 * dry runs included. The rules live in `decisionWatch.ts`.
 */
import * as dw from '../decisionWatch';
import { destinationVerdict } from './slackTools';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const USER_RE = /^[UW][A-Z0-9]{6,}$/;
const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const bare = (v: string) => v.replace(/^<[@#]?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

async function audited(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  run: () => Promise<{ outcome: string; detail: string | null; answer: Record<string, unknown>; target?: string | null }>,
): Promise<Record<string, unknown>> {
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'decision_watch', requester: bare(str(args, 'requester_user_id')) || null, dry_run: args.dry_run === true });
  try {
    const r = await run();
    await auditClose(audit, { outcome: r.outcome, detail: r.detail, natural_id: r.target ?? null, after: r.answer });
    return { ...r.answer, audit_id: audit };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, reason: 'error', message, audit_id: audit };
  }
}

export const openDecisionWatch: ToolDefinition = {
  name: 'open_decision_watch',
  description:
    `Start watching one decision that is waiting on one named person, so it cannot be forgotten. Use it (a) when you are already in a thread and a decision, question or lane step is put to a named person and not answered there and then, or (b) when somebody says "Bays, watch this". Never to watch a thread nobody asked a named person anything in. The dashboard then checks every few minutes: a reply from the owner closes the watch, any other reply or a change to the linked loop or task restarts the wait, and after ${dw.RULE.wait_hours} quiet hours a reminder is posted in the thread as Bays, up to ${dw.RULE.max_reminders}, then one escalation to Jason and Destiny and it stops. Pass the thread as thread_link (a Slack message link) or channel_id + thread_ts; a watch with no thread needs record_id (a LOOP-… or TASK-… id) and reminds the owner by DM. sop_refs and ns_refs are the SOP title and id and the North Star position the decision ties to: look them up first and pass what you found, or leave them out; never invent one. A second call for the same thread and owner while the first is open answers the first and makes no duplicate. Returns {ok, watch_id, created, next_action_at}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string', description: 'What is being waited on, in one or two plain sentences, as the person who asked put it.' },
      owner_user_id: { type: 'string', description: 'Slack id (U…) of the one person who owes the answer.' },
      thread_link: { type: 'string', description: 'A Slack link to the thread, or to any message in it.' },
      channel_id: { type: 'string', description: 'With thread_ts, instead of thread_link: the channel or DM id (C…, G…, D…).' },
      thread_ts: { type: 'string', description: 'The thread\'s parent message ts, e.g. 1791733223.226019.' },
      record_id: { type: 'string', description: 'Optional. The loop (LOOP-…) or backlog task (TASK-…) that tracks this. Closing it closes the watch.' },
      sop_refs: { type: 'string', description: 'Optional. The SOP it ties to: title and BHARAG id.' },
      ns_refs: { type: 'string', description: 'Optional. The North Star position or lane ranking it ties to.' },
      next_step: { type: 'string', description: 'Optional. The next logged step expected of the owner, in a sentence.' },
      lane: { type: 'string', description: 'Optional. The lane tag, e.g. BAYS, CAPITAL.' },
      wait_hours: { type: 'number', description: `Optional. Quiet hours before a reminder. Default ${dw.RULE.wait_hours}; ${dw.RULE.min_wait_hours} to ${dw.RULE.max_wait_hours}. Change it only when the person asking names a different wait.` },
      requester_user_id: { type: 'string', description: 'Slack id of the person who asked for the watch, or whose message put the decision. Required.' },
      fixture: { type: 'boolean', description: 'A marked test watch. Refused on an agent token. Its posts start with TEST and it may wait as little as one minute (wait_minutes).' },
      wait_minutes: { type: 'number', description: 'Fixture only: the wait in minutes.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would be watched, without recording it.' },
    },
    required: ['decision', 'owner_user_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Watch a decision until it is answered' },
  handler: (args, deps) =>
    audited('open_decision_watch', args, deps, async () => {
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, answer: { ok: false, reason, message: `${message} Nothing is being watched.` } });
      const requester = bare(str(args, 'requester_user_id'));
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const fixture = args.fixture === true;
      if (fixture && deps.agent) return refuse('fixture_not_for_agents', 'A test watch can only be opened by a person on the connector.');
      let channel = bare(str(args, 'channel_id')) || null;
      let thread = str(args, 'thread_ts') || null;
      const link = str(args, 'thread_link');
      if (link) {
        const at = dw.parseThreadLink(link);
        if (!at) return refuse('bad_thread_link', `"${link.slice(0, 120)}" is not a Slack message link.`);
        channel = at.channel;
        thread = at.ts;
      }
      if ((channel && !thread) || (!channel && thread)) return refuse('bad_thread', 'A thread needs both channel_id and thread_ts, or one thread_link.');
      if (thread && !/^\d{9,11}\.\d{1,6}$/.test(thread)) return refuse('bad_thread_ts', `"${thread}" is not a Slack message ts.`);
      // Who it may remind and where: the destination guard every other Slack write here answers to.
      // A reminder is text an agent wrote, posted later with nobody watching, so it only ever goes to
      // a person with a Builder Profile (or an approver), and from an agent only into a known channel.
      const owner = bare(str(args, 'owner_user_id'));
      if (USER_RE.test(owner)) {
        const who = await destinationVerdict(owner);
        if (!who.known) return refuse('unknown_owner', `<@${owner}> cannot be watched: ${who.why}.`);
      }
      if (channel && deps.agent) {
        const where = await destinationVerdict(channel);
        if (!where.known) return refuse('unknown_destination', `Bays cannot post reminders there: ${where.why}. A person can open this watch through the connector.`);
      }
      // A link to a reply names the reply; the watch needs the thread it sits in.
      if (channel && thread && link && !/[?&]thread_ts=/.test(link) && args.dry_run !== true) thread = await dw.resolveRoot(channel, thread);
      const recordId = str(args, 'record_id') || null;
      const recordKind = recordId ? (recordId.startsWith('LOOP-') ? 'loops' : recordId.startsWith('TASK-') ? 'lane_backlog' : null) : null;
      if (recordId && !recordKind) return refuse('bad_record_id', `"${recordId}" is not a loop id (LOOP-…) or a backlog task id (TASK-…).`);
      const waitMinutes = fixture && typeof args.wait_minutes === 'number' ? args.wait_minutes : typeof args.wait_hours === 'number' ? args.wait_hours * 60 : undefined;
      const input: dw.OpenInput = {
        decision: str(args, 'decision'),
        owner_user_id: bare(str(args, 'owner_user_id')),
        lane: str(args, 'lane') || null,
        sop_refs: str(args, 'sop_refs') || null,
        ns_refs: str(args, 'ns_refs') || null,
        next_step: str(args, 'next_step') || null,
        channel_id: channel,
        thread_ts: thread,
        record_kind: recordKind,
        record_id: recordId,
        wait_minutes: waitMinutes,
        created_by: requester,
        created_via: deps.agent ?? 'the shared connector',
        fixture,
      };
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: null, answer: { ok: true, dry_run: true, would_watch: { ...input, wait_minutes: input.wait_minutes ?? dw.RULE.wait_hours * 60, max_reminders: dw.RULE.max_reminders } } };
      }
      const r = await dw.open(input);
      if (!r.ok) return refuse(r.reason, r.message);
      const shown = dw.show(r.watch);
      return {
        outcome: r.created ? 'applied' : 'unchanged',
        detail: `${r.watch.watch_id} ${r.created ? 'opened' : 'already open'} for ${r.watch.owner_user_id}`,
        target: r.watch.watch_id,
        answer: {
          ok: true,
          created: r.created,
          watch_id: r.watch.watch_id,
          next_action: shown.next_action,
          next_action_at: shown.next_action_at,
          watch: shown,
          message: r.created
            ? `Watching. If <@${r.watch.owner_user_id}> has not replied and nothing has moved in ${shown.wait}, a reminder is posted as Bays. Say this plainly to the person; do not promise anything more than that.`
            : `This decision is already being watched as ${r.watch.watch_id}; no second watch was made.`,
        },
      };
    }),
};

export const listDecisionWatches: ToolDefinition = {
  name: 'list_decision_watches',
  description:
    'List the decisions being watched: open ones first (soonest reminder first), then the closed ones. status is watching, answered (the owner replied), moved (the linked loop or task was closed), escalated (the reminders ran out and Jason and Destiny were told) or cancelled. "problem" is why a watch could not be checked or posted, e.g. a thread no bot can read. Filter with owner_user_id or open_only. Use it to answer "what is Bays watching" or "what am I being waited on for".',
  inputSchema: {
    type: 'object',
    properties: {
      open_only: { type: 'boolean', description: 'Only watches still open.' },
      owner_user_id: { type: 'string', description: 'Only watches waiting on this person.' },
      include_fixtures: { type: 'boolean', description: 'Include marked test watches.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'List watched decisions' },
  handler: async (args) => {
    const all = await dw.read({ fixtures: args.include_fixtures === true });
    const who = bare(str(args, 'owner_user_id'));
    let rows = all.watches;
    if (args.open_only === true) rows = rows.filter((w) => w.status === 'watching');
    if (who) rows = rows.filter((w) => w.owner_user_id === who);
    return { ok: true, rule: all.rule.in_words, counts: all.counts, posted_today: all.posted_today, count: rows.length, watches: rows.slice(0, 40).map(({ history: _history, ...w }) => w), truncated: rows.length > 40 };
  },
};

export const closeDecisionWatch: ToolDefinition = {
  name: 'close_decision_watch',
  description:
    'Close a watch that is still open, by its watch_id (DW-…). outcome "answered" when the decision was given somewhere the watch could not see (a call, another thread); "cancelled" when it should never have been watched or no longer matters. Only the person who asked for the watch, its owner, Destiny or Jason may close it. A reason is required. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      watch_id: { type: 'string', description: 'DW-…' },
      outcome: { type: 'string', enum: ['answered', 'cancelled'] },
      reason: { type: 'string', description: 'Why, in a sentence. Where it was answered, if it was.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      dry_run: { type: 'boolean' },
    },
    required: ['watch_id', 'outcome', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Close a watched decision' },
  handler: (args, deps) =>
    audited('close_decision_watch', args, deps, async () => {
      const id = str(args, 'watch_id');
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: id || null, answer: { ok: false, reason, message: `${message} Nothing was changed.` } });
      const requester = bare(str(args, 'requester_user_id'));
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const outcome = str(args, 'outcome');
      if (outcome !== 'answered' && outcome !== 'cancelled') return refuse('bad_outcome', 'outcome is "answered" or "cancelled".');
      const reason = str(args, 'reason');
      if (reason.length < 3) return refuse('reason_required', 'Say why in a sentence.');
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would_close: { watch_id: id, outcome, reason } } };
      const r = await dw.close(id, requester, outcome, reason);
      if (!r.ok) return refuse(r.reason, r.message);
      return { outcome: 'applied', detail: `${id} ${outcome} by ${requester}${deps.agent ? ` through ${deps.agent}` : ''}`, target: id, answer: { ok: true, watch_id: id, status: r.status, message: `${id} is closed (${outcome}). No more reminders will be posted for it.` } };
    }),
};

export const runDecisionWatch: ToolDefinition = {
  name: 'run_decision_watch',
  description:
    'Run the Decision Watch pass now, the same one the timer runs every five minutes. dry_run defaults to TRUE: nothing is posted or changed and the answer lists what each open watch would get. With dry_run false it reads the threads, closes what was answered and posts whatever is due. watch_id narrows it to one watch. For a person on the connector; in no agent\'s scope.',
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: 'Default true.' },
      watch_id: { type: 'string', description: 'Optional. Only this watch.' },
      requester_user_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Run the Decision Watch pass' },
  handler: (args, deps) => {
    const dry = args.dry_run !== false;
    return audited('run_decision_watch', { ...args, dry_run: dry }, deps, async () => {
      const r = await dw.sweep(new Date(), { dry, only: str(args, 'watch_id') || undefined });
      return { outcome: dry ? 'dry_run' : 'applied', detail: `${r.looked_at} looked at, ${r.reminded.length} reminded, ${r.closed.length} closed, ${r.escalated.length} escalated, ${r.failed.length} failed`, answer: { ok: true, dry_run: dry, ...r } };
    });
  },
};

export const DECISION_WATCH_WRITE_TOOLS: ToolDefinition[] = [openDecisionWatch, listDecisionWatches, closeDecisionWatch, runDecisionWatch];
