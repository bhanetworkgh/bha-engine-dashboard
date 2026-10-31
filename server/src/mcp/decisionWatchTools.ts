/**
 * Decision Watch over MCP (2026-10-11, Destiny — LOOP-1791743584778-5YQA).
 *
 *   `open_decision_watch`   — Bays, when a decision is put to a named person in
 *                             a thread it is already in, or when somebody says
 *                             "Bays, watch this".
 *   `list_decision_watches` — what is being watched and what happened to the rest.
 *   `close_decision_watch`  — the requester, the owner, Destiny or Jason.
 *   `update_decision_watch` — attach an SOP or North Star reference to a watch
 *                             opened before the rule existed (in Bays' scope).
 *   `snooze_decision_watch` — pause its reminders until a date, at most 14 days
 *                             ahead; the watch stays open (in Bays' scope).
 *   `run_decision_watch`    — the sweep on demand, for a person on the
 *                             connector. In no agent's scope.
 *
 * All four are on the write connection; the first three are in Bays' scope.
 * Every call is on `engine_mcp_writes` (kind `decision_watch`), refusals and
 * dry runs included. The rules live in `decisionWatch.ts`.
 */
import * as dw from '../decisionWatch';
import { destinationVerdict } from './slackTools';
import * as channelRegister from '../channelRegister';
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
    `Start watching one decision that is waiting on one named person, so it cannot be forgotten. Use it (a) when you are already in a thread and a decision, question or lane step is put to a named person and not answered there and then, or (b) when somebody says "Bays, watch this". Never to watch a thread nobody asked a named person anything in. The dashboard then checks every few minutes: any reply, the owner's included, or a change to the linked loop or task restarts the wait, and NO reply closes a watch (it closes only on proof, with close_decision_watch, or when its linked loop or task closes), and after ${dw.RULE.wait_hours} quiet hours a reminder is posted in the thread as Bays, up to ${dw.RULE.max_reminders}, then one escalation to Jason and Destiny and it stops. Pass the thread as thread_link (a Slack message link) or channel_id + thread_ts; a watch with no thread needs record_id (a LOOP-… or TASK-… id) and reminds the owner by DM. sop_refs and ns_refs are the SOP title and id and the North Star position the decision ties to: look them up first and pass what you found, or leave them out; never invent one. A second call for the same thread and owner while the first is open answers the first and makes no duplicate. The answer lists owner_other_open, the owner's other open watches in any thread: if one of them is already waiting on the same ask, do not keep two, because both would remind the same person (add what is new to the older one with update_decision_watch and close this one with close_decision_watch, cancelled). However many watches a person has, they get at most one reminder per ${dw.RULE.owner_gap_hours} hours, and a snooze that ends (or is cleared) starts a fresh full wait rather than reminding at once. The thread is checked first: a ts Slack has no message for is refused (thread_not_found), a place no bot can read is refused (thread_not_readable), and a reply's ts is turned into its thread, so pass the link of the message the ask was made in. A channel you are in that the engine never set up is set up on this call (Drive folder, daily doc, tracking, the same setup as when you join), and channel_setup says so: tell the person it was set up. A channel you are not in (bays_not_in_channel), one kept out on purpose or a test channel (channel_excluded), or a setup that failed (register_failed) is refused with numbered steps: pass those steps to the person as they are. Returns {ok, watch_id, created, next_action_at, channel_setup}. Audited on engine_mcp_writes.`,
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
      close_on_reply: { type: 'boolean', description: 'No longer used (26 Oct 2026): no reply closes a watch, whatever is sent here. Leave it out.' },
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
      // A channel Bays is in but the engine never set up is set up here, on the first watch, by the
      // same setup a Bays join runs (14 Oct 2026, Jason's ask 1). Anything else is refused with steps.
      let registered: { channel_id: string; message: string; dry_run: boolean } | null = null;
      if (channel && deps.agent) {
        const where = await destinationVerdict(channel);
        if (!where.known && where.kind === 'channel') {
          const reg = await channelRegister.register(channel, { dry_run: args.dry_run === true, requested_by: requester });
          if (!reg.ok) return refuse(reg.reason === 'channel_unreadable' ? 'unknown_destination' : reg.reason, reg.message);
          registered = { channel_id: reg.channel_id, message: reg.message, dry_run: reg.dry_run };
        } else if (!where.known) {
          return refuse('unknown_destination', `Bays cannot post reminders there: ${where.why}. A person can open this watch through the connector.`);
        }
      } else if (channel && /^[CG]/.test(channel)) {
        // A person on the connector may watch anywhere, but a channel the engine never set up is still
        // set up, so it is captured like every other. Here a refusal does not stop the watch: it is said.
        const where = await destinationVerdict(channel);
        if (!where.known) {
          const reg = await channelRegister.register(channel, { dry_run: args.dry_run === true, requested_by: requester });
          registered = { channel_id: channel, message: reg.message, dry_run: reg.ok ? reg.dry_run : args.dry_run === true };
        }
      }
      // The thread must exist and be readable, and a reply's ts becomes its thread's root,
      // however the place was given (14 Oct 2026: a watch on a ts no message carried, DW-…-OSK0).
      // A dry run checks too: it is a read, and "would watch" a thread that is not there is a false answer.
      let threadCheck: dw.ThreadCheck | null = null;
      if (channel && thread) {
        threadCheck = await dw.checkThread(channel, thread);
        if (!threadCheck.ok) return refuse(threadCheck.reason, threadCheck.message);
        thread = threadCheck.root;
      }
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
        close_on_reply: false,
      };
      if (args.dry_run === true) {
        return { outcome: 'dry_run', detail: null, answer: { ok: true, dry_run: true, thread_checked: threadCheck?.ok ? threadCheck.checked : null, channel_setup: registered?.message ?? null, would_watch: { ...input, wait_minutes: input.wait_minutes ?? dw.RULE.wait_hours * 60, max_reminders: dw.RULE.max_reminders } } };
      }
      const r = await dw.open(input);
      if (!r.ok) return refuse(r.reason, r.message);
      const shown = dw.show(r.watch);
      return {
        outcome: r.created ? 'applied' : 'unchanged',
        detail: `${r.watch.watch_id} ${r.created ? 'opened' : 'already open'} for ${r.watch.owner_user_id}${registered ? `; ${registered.channel_id} set up first` : ''}`,
        target: r.watch.watch_id,
        answer: {
          ok: true,
          created: r.created,
          watch_id: r.watch.watch_id,
          channel_setup: registered?.message ?? null,
          next_action: shown.next_action,
          next_action_at: shown.next_action_at,
          watch: shown,
          owner_other_open: r.others,
          message: r.created
            ? `${registered ? `${registered.message} ` : ''}Watching. If <@${r.watch.owner_user_id}> has not replied and nothing has moved in ${shown.wait}, a reminder is posted as Bays. A reply from the owner restarts the wait and does not close it; close it with close_decision_watch, with proof, once what is owed is done. Say this plainly to the person; do not promise anything more than that.${r.others.length ? ` <@${r.watch.owner_user_id}> already has ${r.others.length} other open watch${r.others.length === 1 ? '' : 'es'} (owner_other_open): if one is the same ask, keep one, not both.` : ''}`
            : `This decision is already being watched as ${r.watch.watch_id}; no second watch was made, and nothing on it was changed. To attach an SOP or North Star reference to it, call update_decision_watch.`,
        },
      };
    }),
};

export const listDecisionWatches: ToolDefinition = {
  name: 'list_decision_watches',
  description:
    'List the decisions being watched: open ones first (soonest reminder first), then the closed ones. status is watching, answered (the owner replied), moved (the linked loop or task was closed), escalated (the reminders ran out and Jason and Destiny were told) or cancelled. "problem" is why a watch could not be checked or posted, e.g. a thread no bot can read. Filter with owner_user_id or open_only. Use it to answer "what is Bays watching" or "what am I being waited on for". Each watch carries how_it_moves: where a reply counts, what it does, and when the next reminder goes. Before telling anyone what a watch will do (whether a message resets it, closes it, or when it will nudge), read that line and say it as written; never work it out from the thread you are in, because the watch may be on a different thread.',
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
    'Close a watch that is still open, by its watch_id (DW-…). A watch closes ONLY on proof (26 Oct 2026, Destiny): a reply, a promise ("will run it this week"), a plan or a timeline is never a reason to close; the watch stays open and keeps reminding, or is snoozed to the date the person named (snooze_decision_watch). Close it when (a) what was owed is shown done: outcome "answered", proof the link to where it was shown (the Slack message with the result, a PR, a dashboard page) or the id of the record that settles it; (b) the owner, Destiny or Jason says to close it: outcome "cancelled" (or "answered" if they say it is done), proof the link to that message; or (c) it was folded into another watch on the same ask: outcome "cancelled", proof the DW-… it was folded into. Without proof the close is refused (proof_required). When a watch has several parts, every part must be shown done. Only the person who asked for the watch, its owner, Destiny or Jason may close it. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      watch_id: { type: 'string', description: 'DW-…' },
      outcome: { type: 'string', enum: ['answered', 'cancelled'] },
      reason: { type: 'string', description: 'Why, in a sentence: what was shown done, or who said to close it.' },
      proof: { type: 'string', description: 'Required. A link to where it was shown done or where the owner said to close it (Slack message, PR, dashboard page), or the id of the record that settles it (LOOP-…, TASK-…, the DW-… it was folded into).' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      dry_run: { type: 'boolean' },
    },
    required: ['watch_id', 'outcome', 'reason', 'proof', 'requester_user_id'],
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
      const proof = str(args, 'proof');
      if (!dw.hasProof(proof)) return refuse('proof_required', `${id} is closed only on proof: pass proof as a link to where it was shown done or where the owner said to close it, or the id of the record that settles it (LOOP-…, TASK-…, the DW-… it was folded into). A reply or a promise to do it is not proof: leave it open, or snooze it to the date it is due.`);
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would_close: { watch_id: id, outcome, reason, proof } } };
      const r = await dw.close(id, requester, outcome, reason, new Date(), proof);
      if (!r.ok) return refuse(r.reason, r.message);
      return { outcome: 'applied', detail: `${id} ${outcome} by ${requester}${deps.agent ? ` through ${deps.agent}` : ''}`, target: id, answer: { ok: true, watch_id: id, status: r.status, message: `${id} is closed (${outcome}). No more reminders will be posted for it.` } };
    }),
};

export const updateDecisionWatch: ToolDefinition = {
  name: 'update_decision_watch',
  description:
    'Set or add to the references on a watch that is still open, by its watch_id (DW-…): sop_refs (the SOP title and BHARAG id its reminders point to), ns_refs (the North Star position) and next_step. Use it when an SOP is written, or found, after the watch was opened, so the next reminder names the rule and not only that the thread is quiet. Send only the fields to change. A field sent is ADDED to what the watch already holds (next_step as a new dated "Update" line under the old text, the references separated by "; "), so nothing already owed is lost; pass replace: true only when the old text must go, and then send the whole of what is still owed. An empty string clears a field. What is being waited on, the owner and the thread cannot be changed: that is a different watch. Only the person who asked for the watch, its owner, Destiny or Jason may change it. Every change is a dated line in the watch\'s history and a decision_watch_updated engine event carrying the old and new value. Returns {ok, changed, watch}. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      watch_id: { type: 'string', description: 'DW-…' },
      sop_refs: { type: 'string', description: 'The SOP it ties to: title and BHARAG id. Never invent one.' },
      ns_refs: { type: 'string', description: 'The North Star position or lane ranking it ties to.' },
      next_step: { type: 'string', description: 'The next logged step expected of the owner.' },
      append: { type: 'boolean', description: 'Kept for older callers: adding is the default now. append: false is the same as replace: true.' },
      replace: { type: 'boolean', description: 'Replace what is held instead of adding to it. Only when the old text must go; send everything still owed.' },
      close_on_reply: { type: 'boolean', description: 'No longer used (26 Oct 2026): no reply closes a watch. Leave it out.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      dry_run: { type: 'boolean' },
    },
    required: ['watch_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Attach an SOP or North Star reference to a watched decision' },
  handler: (args, deps) =>
    audited('update_decision_watch', args, deps, async () => {
      const id = str(args, 'watch_id');
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: id || null, answer: { ok: false, reason, message: `${message} Nothing was changed.` } });
      const requester = bare(str(args, 'requester_user_id'));
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const changes: Partial<Record<dw.Updatable, string | null>> = {};
      for (const f of dw.UPDATABLE) if (typeof args[f] === 'string') changes[f] = args[f] as string;
      if (!Object.keys(changes).length) return refuse('nothing_to_change', 'Send at least one of sop_refs, ns_refs or next_step. (close_on_reply is no longer used: no reply closes a watch.)');
      const closeOnReply = undefined;
      const replace = args.replace === true || args.append === false;
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would_change: { watch_id: id, ...changes, mode: replace ? 'replace' : 'add', ...(closeOnReply !== undefined ? { close_on_reply: closeOnReply } : {}) } } };
      const r = await dw.update(id, requester, changes, { replace, closeOnReply });
      if (!r.ok) return refuse(r.reason, r.message);
      return {
        outcome: r.changed.length || r.flipped ? 'applied' : 'unchanged',
        detail: r.changed.length || r.flipped ? `${id}: ${[...r.changed.map((c) => c.field), ...(r.flipped ? ['close_on_reply'] : [])].join(', ')} ${replace ? 'replaced' : 'updated'} by ${requester}${deps.agent ? ` through ${deps.agent}` : ''}` : `${id}: already holds this`,
        target: id,
        answer: { ok: true, watch_id: id, changed: r.changed, watch: dw.show(r.watch), message: r.changed.length || r.flipped ? `${id} updated${replace ? ' (replaced)' : ', added to what it held'}. Its next reminder will carry this.` : `${id} already holds exactly this; nothing was changed.` },
      };
    }),
};

/** A date to snooze until: an ISO time with its zone, or a bare day (YYYY-MM-DD, read as 00:00 UTC that day). */
export function parseUntil(raw: string): Date | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const snoozeDecisionWatch: ToolDefinition = {
  name: 'snooze_decision_watch',
  description:
    `Pause a watch's reminders until a date, by its watch_id (DW-…). Use it when the person a watch is waiting on, whoever asked for it, Destiny or Jason asks not to be reminded for a while ("snooze it until the 30th", "don't remind me till after 10/31"). Never cancel a watch and open a new one to get a longer wait: that loses its history. The watch stays open: its thread is still read, the owner's reply still counts, a linked loop closing still closes it, and nothing is posted until the date; after it, or when clear: true ends it early, the full wait starts again from then, so no reminder goes the moment a snooze lifts. until is the date the person named: a day as YYYY-MM-DD (read as 00:00 UTC that day) or an ISO time with its zone. At most ${dw.RULE.max_snooze_days} days from now; a later date is refused (too_long) and the answer says the latest date allowed, so ask the person to pick one. Ask the person for the date when they did not name one; never pick it for them. A snooze already running is replaced by the new date. clear: true ends a snooze early. Only the watch's owner, the person who asked for it, Destiny or Jason may snooze it. Returns {ok, snoozed_until, watch}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      watch_id: { type: 'string', description: 'DW-…' },
      until: { type: 'string', description: 'The date the person named: YYYY-MM-DD, or an ISO time with its zone (e.g. 2026-10-30T09:00:00+01:00). Required unless clear is true.' },
      clear: { type: 'boolean', description: 'true ends a running snooze now.' },
      reason: { type: 'string', description: 'Optional. Why, in the person\'s words.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      dry_run: { type: 'boolean' },
    },
    required: ['watch_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Snooze a watched decision until a date' },
  handler: (args, deps) =>
    audited('snooze_decision_watch', args, deps, async () => {
      const id = str(args, 'watch_id');
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: id || null, answer: { ok: false, reason, message: `${message} Nothing was changed.` } });
      const requester = bare(str(args, 'requester_user_id'));
      if (!USER_RE.test(requester)) return refuse('requester_required', '"requester_user_id" must be the Slack id (U…) of the person asking.');
      const clear = args.clear === true;
      const raw = str(args, 'until');
      if (clear && raw) return refuse('until_and_clear', 'Send until to snooze, or clear: true to end a snooze, not both.');
      if (!clear && !raw) return refuse('until_required', 'Say until when: a day as YYYY-MM-DD, or an ISO time with its zone. Ask the person for the date if they did not name one.');
      const until = clear ? null : parseUntil(raw);
      if (!clear && !until) return refuse('bad_until', `"${raw.slice(0, 60)}" is not a date this can read. Send YYYY-MM-DD, or an ISO time with its zone.`);
      const reason = str(args, 'reason') || null;
      if (args.dry_run === true) {
        const now = Date.now();
        const latest = new Date(now + dw.RULE.max_snooze_days * 86_400_000);
        const problem = until && until.getTime() <= now ? 'not_in_future' : until && until.getTime() > latest.getTime() ? 'too_long' : null;
        return { outcome: 'dry_run', detail: problem, target: id, answer: { ok: !problem, dry_run: true, would_snooze: { watch_id: id, until: until ? until.toISOString() : null, clear }, ...(problem ? { reason: problem, latest_allowed: latest.toISOString() } : {}) } };
      }
      const r = await dw.snooze(id, requester, until, reason);
      if (!r.ok) return refuse(r.reason, r.message);
      const shown = dw.show(r.watch);
      return {
        outcome: r.changed ? 'applied' : 'unchanged',
        detail: r.changed ? `${id} ${until ? `snoozed until ${until.toISOString()}` : 'snooze ended'} by ${requester}${deps.agent ? ` through ${deps.agent}` : ''}` : `${id}: already ${until ? 'snoozed until that date' : 'not snoozed'}`,
        target: id,
        answer: {
          ok: true,
          watch_id: id,
          changed: r.changed,
          snoozed_until: r.snoozed_until ? r.snoozed_until.toISOString() : null,
          next_action_at: shown.next_action_at,
          watch: shown,
          message: until
            ? `${id} is snoozed until ${until.toISOString()}. It stays open: a reply in the thread still counts, and nothing is posted before that date. After it, the full wait starts again from that date before any reminder. Say this plainly to the person.`
            : r.changed
              ? `${id}'s snooze is over. It is watching again, and the full wait starts again from now, so no reminder goes straight away.`
              : `${id} was not snoozed; nothing was changed.`,
        },
      };
    }),
};

export const runDecisionWatch: ToolDefinition = {
  name: 'run_decision_watch',
  description:
    'Run the Decision Watch pass now, the same one the timer runs every five minutes: the in-thread reminders (24 hours, then 72 hours, then 7 days quiet) and the combined DM (one per person per 12 hours, every open watch listed). dry_run defaults to TRUE: nothing is posted or changed and the answer lists what each open watch and each person would get. With dry_run false it reads the threads, closes what its linked loop or task settled and posts whatever is due (no reply closes a watch). watch_id narrows it to one watch. For a person on the connector; in no agent\'s scope.',
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: 'Default true.' },
      watch_id: { type: 'string', description: 'Optional. Only this watch (the combined DM pass is skipped).' },
      digest_for: { type: 'string', description: 'Optional Slack id: only this person\'s combined DM. With dry_run true the answer carries the DM\'s text as preview.' },
      digest_now: { type: 'boolean', description: 'Send digest_for\'s combined DM now, whatever the 12-hour gap. Only for the requester\'s own list (digest_for must be requester_user_id).' },
      requester_user_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Run the Decision Watch pass' },
  handler: (args, deps) => {
    const dry = args.dry_run !== false;
    return audited('run_decision_watch', { ...args, dry_run: dry }, deps, async () => {
      const digestFor = bare(str(args, 'digest_for')) || undefined;
      const now = args.digest_now === true;
      if (now && (dry || !digestFor || digestFor !== bare(str(args, 'requester_user_id')))) {
        return { outcome: 'refused', detail: 'digest_now', answer: { ok: false, reason: 'digest_now_own_list_only', message: 'digest_now sends a combined DM at once, so it needs dry_run false and digest_for equal to requester_user_id: a person may push only their own list. Nothing was sent.' } };
      }
      const watchId = str(args, 'watch_id') || undefined;
      const r = digestFor && !watchId ? null : await dw.sweep(new Date(), { dry, only: watchId });
      const d = watchId ? null : await dw.digestSweep(new Date(), { dry, only: digestFor, force: now });
      const detail = [
        r ? `${r.looked_at} looked at, ${r.reminded.length} reminded, ${r.closed.length} closed, ${r.escalated.length} escalated, ${r.failed.length} failed` : null,
        d ? `combined DM: ${dry ? `${d.would?.filter((w) => w.action.startsWith('send')).length ?? 0} would send` : `${d.sent.length} sent`}, ${d.held_gap.length} held, ${d.failed.length} failed` : null,
      ].filter(Boolean).join('; ');
      return { outcome: dry ? 'dry_run' : 'applied', detail, answer: { ok: !(d?.failed.length), dry_run: dry, ...(r ?? {}), ...(d ? { digest: d } : {}) } };
    });
  },
};

export const reopenDecisionWatch: ToolDefinition = {
  name: 'reopen_decision_watch',
  description:
    'Open a closed watch again, by its watch_id (DW-…), when it was closed before what it waited on was done (26 Oct 2026, Destiny: a watch closes only on proof). Same id, thread and owner; its reminders count from nothing again and the wait starts now; the old close stays in its history. Refused when another watch on the same thread and person is already open (add to that one instead). Destiny or Jason only; in no agent\'s scope. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      watch_id: { type: 'string', description: 'DW-…' },
      reason: { type: 'string', description: 'Why it is being reopened: what is still owed.' },
      requester_user_id: { type: 'string', description: 'Slack id of Destiny or Jason.' },
      dry_run: { type: 'boolean' },
    },
    required: ['watch_id', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE, title: 'Reopen a watched decision' },
  handler: (args, deps) =>
    audited('reopen_decision_watch', args, deps, async () => {
      const id = str(args, 'watch_id');
      const refuse = (reason: string, message: string) => ({ outcome: 'refused', detail: reason, target: id || null, answer: { ok: false, reason, message: `${message} Nothing was changed.` } });
      if (deps.agent) return refuse('not_permitted', 'Reopening a watch is a person\'s call, through the connector.');
      const requester = bare(str(args, 'requester_user_id'));
      if (!(dw.APPROVERS as readonly string[]).includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can reopen a watch.');
      const reason = str(args, 'reason');
      if (reason.length < 3) return refuse('reason_required', 'Say what is still owed.');
      if (args.dry_run === true) return { outcome: 'dry_run', detail: null, target: id, answer: { ok: true, dry_run: true, would_reopen: { watch_id: id, reason } } };
      const r = await dw.reopen(id, requester, reason);
      if (!r.ok) return refuse(r.reason, r.message);
      return { outcome: 'applied', detail: `${id} reopened by ${requester}`, target: id, answer: { ok: true, watch_id: id, status: r.watch.status, next_action_at: dw.dueAt(r.watch).toISOString(), message: `${id} is open again. The wait starts now; the first reminder is due ${dw.dueAt(r.watch).toISOString()} if nothing moves.` } };
    }),
};

export const DECISION_WATCH_WRITE_TOOLS: ToolDefinition[] = [openDecisionWatch, listDecisionWatches, closeDecisionWatch, updateDecisionWatch, snoozeDecisionWatch, runDecisionWatch, reopenDecisionWatch];
