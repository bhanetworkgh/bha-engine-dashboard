/**
 * Loop and Decision Watch change announcements (18 Nov 2026, Destiny — D7; Jason to Bays, 17 Nov:
 * "when there are changes to decisions watches or loops, that there should be a post ... explaining
 * the change and the why behind it and encouragement as always to close down decision watches and
 * loops"; Destiny, 18 Nov: one post, in #bha-coordination, so the whole team is briefed, not the
 * owner's workflow log).
 *
 * Every five minutes, what changed on a loop or a watch since the last pass is posted as Bays in
 * #bha-coordination: a completion report when a loop or watch closed, a progress report when it
 * moved (a status change, a new owner, a note or a next step added, a watch reopened). Each says what
 * changed, the reason written on the record (never invented: "no reason recorded" when there is
 * none) and where it stands, and a progress report ends with a nudge toward closing it.
 *
 * Small edits post nothing: a reworded title or lane tag, a new loop, a reminder, a snooze. A test
 * watch (fixture) or a loop whose title starts "TEST" posts nothing.
 *
 * Read from what the engine already writes, so no write path had to change: loop changes from
 * engine_record_history (every update keeps the fields it replaced), watch changes from the
 * decision_watch_updated, decision_watch_closed and decision_watch_reopened events.
 *
 * One post per change: each change is claimed by an engine event (dedupe key per history row or
 * watch event) before anything goes to Slack, and a post Slack refuses gives its claims back so the
 * next pass tries again. A change is posted once whatever number of instances run. Changes are read
 * once they are a minute old, so the rows one action writes land in one post. More than
 * RULE.batch_over changes in one pass go out as one combined post rather than flood the channel.
 * Nothing older than the first pass after deploy (meta change_announce.since) is announced.
 */
import { query } from './pg';
import { getMeta, setMetaIfAbsent } from './db';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';

export const RULE = {
  channel: process.env.CHANGE_ANNOUNCE_CHANNEL?.trim() || 'C0ASMPYQLG3', // #bha-coordination
  every_minutes: 5,
  settle_seconds: 60,
  lookback_hours: 6,
  batch_over: 4,
  why_chars: 500,
} as const;

const DASHBOARD = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');

/** Fields whose change alone is a small edit: nothing is announced for them. */
const SMALL = new Set(['What', 'lane_tag', 'Date Raised', 'Raised By', 'Source Link', 'loop_id', 'updated_at', 'Last Touched', 'Last Updated', 'builder_id']);
const CLOSE_WHY = ['Close Reason', 'Resolution', 'Closure Note', 'Closure Evidence Note'];

export type Kind = 'completion' | 'progress';

export interface Item {
  kind: Kind;
  record: 'loop' | 'watch';
  id: string; // LOOP-… or DW-…
  title: string;
  owner: string;
  changes: string[]; // what changed, one line each
  why: string; // the reason as written on the record, or "no reason recorded"
  stands: string; // where it stands now
  next: string | null; // the next step, for the nudge
  link: string;
  keys: string[]; // dedupe keys, one per change row
  at: string;
  /** The Slack id of who made the change, where the record says (an MCP write's requester, a watch event's by), else the owner's. */
  author: string | null;
  /** The record's owner (a loop's assignee, a watch's owner), whose held pay a change may speak for. */
  owner_id: string | null;
  /** Who made the change, by name, where the record says; null when it does not. */
  changed_by?: string | null;
  /** The loop's lane, where it has one. */
  lane?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : JSON.stringify(v));

/** What a text field gained: the tail when the new text only adds to the old, else the new text. */
export function added(before: string, after: string): string {
  const b = before.trim();
  const a = after.trim();
  const tail = b && a.startsWith(b) ? a.slice(b.length) : a;
  return tail.replace(/^\s*Update \d{4}-\d{2}-\d{2}(?: \([^)]*\))?:\s*/i, '').trim();
}

/** The newest line of a next step, which is where it stands now. */
export function newestLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^Update \d{4}-\d{2}-\d{2}(?: \([^)]*\))?:\s*/i, '').trim();
}

export interface LoopChange {
  history_id: string;
  at: string;
  before: Record<string, unknown>;
  changed_keys: string[];
}

/**
 * One loop's changes in this pass, folded into one item. `before` of the first change and the
 * loop's fields now give the whole move. Null when every change was a small edit.
 */
export interface LoopAudit {
  at: string;
  tool: string;
  reason: string;
  by: string | null;
}

export function loopItem(loopId: string, now: Record<string, unknown>, changes: LoopChange[], ownerName: (id: string) => string, audit: LoopAudit[] = []): Item | null {
  if (!changes.length) return null;
  const title = str(now['What']) || loopId;
  if (/^TEST\b/i.test(title)) return null;
  const sorted = [...changes].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0].before ?? {};
  const keys = new Set(sorted.flatMap((c) => c.changed_keys ?? []));
  const lines: string[] = [];
  const notes: string[] = [];
  const s0 = str(first['Status']);
  const s1 = str(now['Status']);
  const closed = keys.has('Status') && s1 === 'Closed' && s0 !== 'Closed';
  // The MCP write that made this change, when one did: its reason and who asked for it (14 Nov on,
  // a close's reason is often only there, on the audit line, never on the loop).
  const lastAt = sorted[sorted.length - 1].at;
  const firstAt = sorted[0].at;
  const near = audit
    .filter((a) => a.at >= new Date(new Date(firstAt).getTime() - 120_000).toISOString() && a.at <= new Date(new Date(lastAt).getTime() + 5_000).toISOString())
    .sort((a, b) => b.at.localeCompare(a.at));
  const auditReason = (closed ? near.find((a) => a.tool === 'archive_record' && a.reason) : undefined)?.reason || near.find((a) => a.reason)?.reason || '';
  const by = near.find((a) => a.by)?.by ?? null;
  const byText = by ? ` by ${ownerName(by)}` : '';
  if (keys.has('Status') && s0 !== s1) lines.push(closed ? `closed${byText} (was ${s0 || 'not set'})` : `status ${s0 || 'not set'} → ${s1 || 'not set'}${byText}`);
  const a0 = str(first['Assignee Slack User ID']);
  const a1 = str(now['Assignee Slack User ID']);
  if (keys.has('Assignee Slack User ID') && a0 !== a1) lines.push(`now with ${a1 ? ownerName(a1) : 'nobody'}${a0 ? ` (was ${ownerName(a0)})` : ''}`);
  for (const k of keys) {
    if (SMALL.has(k) || k === 'Status' || k === 'Assignee Slack User ID') continue;
    const text = added(str(first[k]), str(now[k]));
    if (!text) continue;
    if (CLOSE_WHY.includes(k)) continue; // read as the reason below
    lines.push(`${k} added`);
    notes.push(text);
  }
  if (!lines.length) return null;
  // The reason a close gives: a close field written in this change first, else one already on the loop.
  const closeKey = CLOSE_WHY.find((k) => keys.has(k) && str(now[k])) ?? CLOSE_WHY.find((k) => str(now[k]));
  const closeWhy = closeKey ? added(keys.has(closeKey) ? str(first[closeKey]) : '', str(now[closeKey])) : '';
  const why = clip((closed ? closeWhy || auditReason || notes[notes.length - 1] : notes[notes.length - 1] || auditReason) || 'no reason recorded', RULE.why_chars);
  const owner = a1 ? ownerName(a1) : 'no owner set';
  return {
    kind: closed ? 'completion' : 'progress',
    record: 'loop',
    id: loopId,
    title,
    owner,
    changes: lines,
    why,
    stands: closed ? 'Closed' : s1 || 'Open',
    next: null,
    link: `${DASHBOARD()}/open-loops/${encodeURIComponent(loopId)}`,
    keys: sorted.map((c) => `change_announce:loop_history:${c.history_id}`),
    at: sorted[sorted.length - 1].at,
    author: by || a1 || null,
    owner_id: a1 || null,
    changed_by: by ? ownerName(by) : null,
    lane: str(now['lane_tag']) || null,
  };
}

export interface WatchEvent {
  event_id: string;
  event_type: 'decision_watch_updated' | 'decision_watch_closed' | 'decision_watch_reopened';
  at: string;
  detail: Record<string, unknown>;
}

export type WatchRow = {
  watch_id: string;
  owner_user_id?: string | null;
  decision: string;
  owner_name: string | null;
  status: string;
  next_step: string | null;
  thread_link: string | null;
  fixture: boolean;
};

/** One watch's events in this pass, folded into one item. Null for a test watch or nothing to say. */
export function watchItem(w: WatchRow, events: WatchEvent[], byName: (id: string) => string): Item | null {
  if (!events.length || w.fixture) return null;
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const lines: string[] = [];
  const whys: string[] = [];
  let closed = false;
  let reason = '';
  let author: string | null = null;
  let changedBy: string | null = null;
  for (const e of sorted) {
    const by = str(e.detail.by);
    if (by) { author = by; changedBy = byName(by); }
    const who = by ? byName(by) : '';
    if (e.event_type === 'decision_watch_closed') {
      closed = true;
      reason = str(e.detail.reason);
      lines.push(`closed${who ? ` by ${who}` : ''}${str(e.detail.status) ? ` (${str(e.detail.status)})` : ''}`);
    } else if (e.event_type === 'decision_watch_reopened') {
      closed = false;
      lines.push(`reopened${who ? ` by ${who}` : ''}`);
      if (str(e.detail.reason)) whys.push(str(e.detail.reason));
    } else {
      const changes = Array.isArray(e.detail.changes) ? (e.detail.changes as Array<Record<string, unknown>>) : [];
      for (const c of changes) {
        const field = str(c.field) || 'watch';
        const text = added(str(c.from), str(c.to));
        if (!text) continue;
        lines.push(`${field.replace(/_/g, ' ')} updated${who ? ` by ${who}` : ''}`);
        whys.push(text);
      }
    }
  }
  if (!lines.length) return null;
  const next = w.next_step ? newestLine(w.next_step) : null;
  return {
    kind: closed ? 'completion' : 'progress',
    record: 'watch',
    id: w.watch_id,
    title: w.decision,
    owner: w.owner_name || 'no owner set',
    changes: lines,
    why: clip((closed ? reason : whys[whys.length - 1]) || 'no reason recorded', RULE.why_chars),
    stands: closed ? 'Closed' : 'Open',
    next: closed ? null : next ? clip(next, 300) : null,
    link: w.thread_link || `${DASHBOARD()}/bays?tab=decision-watch`,
    keys: sorted.map((e) => `change_announce:watch_event:${e.event_id}`),
    at: sorted[sorted.length - 1].at,
    author: author || w.owner_user_id || null,
    owner_id: w.owner_user_id || null,
    changed_by: changedBy,
    lane: null,
  };
}

const label = (i: Item) => `${i.record === 'loop' ? 'loop' : 'decision watch'} ${i.id}`;

/** One change, as its own post. */
export function render(i: Item): string {
  const head = `${i.kind === 'completion' ? '*Completion report*' : '*Progress report*'} <!channel> on ${label(i)}`;
  const lines = [
    head,
    `*${clip(i.title, 200)}*`,
    `Owner: ${i.owner_id ? `<@${i.owner_id}>` : i.owner}`,
    `What changed: ${i.changes.join('; ')}`,
    `Why: ${i.why}`,
    `Where it stands: ${i.stands}`,
  ];
  if (i.kind === 'progress') lines.push(i.next ? `Next: ${i.next.replace(/[.\s]+$/, '')}. Close it once that lands.` : `Next: keep it moving and close it once it is done.`);
  lines.push(`<${i.link}|Open it>`);
  return lines.join('\n');
}

/** Several changes in one pass, as one post. */
export function renderBatch(items: Item[]): string {
  const done = items.filter((i) => i.kind === 'completion').length;
  const head = `*Engine updates* <!channel>: ${items.length} changes (${done} closed, ${items.length - done} moved)`;
  const body = items.map((i) => {
    const tag = i.kind === 'completion' ? 'Closed' : 'Progress';
    const tail = i.kind === 'progress' && i.next ? ` Next: ${clip(i.next, 160)}` : '';
    return `• *${tag}* <${i.link}|${i.id}> ${clip(i.title, 110)} (${i.owner}): ${i.changes.join('; ')}. Why: ${clip(i.why, 220)}.${tail}`;
  });
  return [head, ...body, 'Keep them moving, and close each one on the dashboard once it lands.'].join('\n');
}

type Block = Record<string, unknown>;
const txt = (text: string, style?: Record<string, boolean>): Block => (style ? { type: 'text', text, style } : { type: 'text', text });
const section = (...elements: Block[]): Block => ({ type: 'rich_text_section', elements });
const bullets = (lines: string[]): Block => ({ type: 'rich_text_list', style: 'bullet', elements: lines.map((l) => section(txt(l))) });
const lagos = (iso: string): string => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${d.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} Lagos`;
};

/** One change as Block Kit: header, the record, its facts, what changed as a list, why, next, a button. */
export function blocks(i: Item): Block[] {
  const what = i.record === 'loop' ? 'Loop' : 'Decision watch';
  const facts: Block[] = [
    { type: 'mrkdwn', text: `*Owner*\n${i.owner_id ? `<@${i.owner_id}>` : i.owner}` },
    { type: 'mrkdwn', text: `*Changed by*\n${i.changed_by || 'not recorded'}` },
    { type: 'mrkdwn', text: `*Where it stands*\n${i.stands}` },
    { type: 'mrkdwn', text: `*When*\n${lagos(i.at)}` },
  ];
  if (i.lane) facts.push({ type: 'mrkdwn', text: `*Lane*\n${i.lane}` });
  const out: Block[] = [
    // The heading is a section, not a header block: a header is plain text and cannot tag @channel.
    { type: 'section', text: { type: 'mrkdwn', text: `*${i.kind === 'completion' ? 'Completion report' : 'Progress report'}* <!channel>` } },
    { type: 'section', text: { type: 'mrkdwn', text: `${what} <${i.link}|${i.id}>\n*${clip(i.title, 280)}*` } },
    { type: 'section', fields: facts },
    { type: 'rich_text', elements: [section(txt('What changed', { bold: true })), bullets(i.changes.map((c) => clip(c, 300)))] },
    { type: 'rich_text', elements: [section(txt('Why', { bold: true })), { type: 'rich_text_quote', elements: [txt(clip(i.why, RULE.why_chars))] }] },
  ];
  if (i.kind === 'progress') {
    const next = i.next ? `${i.next.replace(/[.\s]+$/, '')}. Close it once that lands.` : 'Keep it moving and close it once it is done.';
    out.push({ type: 'rich_text', elements: [section(txt('Next: ', { bold: true }), txt(clip(next, 400)))] });
  }
  out.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: i.record === 'loop' ? 'Open the loop' : 'Open the watch' }, url: i.link, action_id: 'change_announce_open' }] });
  return out;
}

/** Several changes as one Block Kit post: a header, then each change as its own list item. */
export function batchBlocks(items: Item[]): Block[] {
  const done = items.filter((i) => i.kind === 'completion').length;
  const out: Block[] = [
    { type: 'section', text: { type: 'mrkdwn', text: '*Engine updates* <!channel>' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${items.length} changes: ${done} closed, ${items.length - done} moved` }] },
  ];
  for (const i of items.slice(0, 40)) {
    out.push({ type: 'section', text: { type: 'mrkdwn', text: `*${i.kind === 'completion' ? 'Closed' : 'Progress'}* <${i.link}|${i.id}> ${clip(i.title, 140)}\nOwner: ${i.owner_id ? `<@${i.owner_id}>` : i.owner}${i.changed_by ? ` · changed by ${i.changed_by}` : ''} · ${i.stands}` } });
    const lines = [...i.changes.map((c) => clip(c, 200)), `Why: ${clip(i.why, 260)}`];
    if (i.kind === 'progress' && i.next) lines.push(`Next: ${clip(i.next, 200)}`);
    out.push({ type: 'rich_text', elements: [bullets(lines)] });
  }
  out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Keep them moving, and close each one on the dashboard once it lands.' }] });
  return out;
}

/* --------------------------------------------------------------- reading */

async function names(): Promise<Map<string, string>> {
  const r = await query<{ id: string; name: string | null }>(`SELECT natural_id AS id, fields->>'name' AS name FROM engine_builder_profiles`);
  return new Map(r.rows.filter((x) => x.name).map((x) => [x.id, x.name as string]));
}

async function held(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await query<{ k: string }>(`SELECT dedupe_key AS k FROM engine_events WHERE dedupe_key = ANY($1::text[])`, [keys]);
  return new Set(r.rows.map((x) => x.k));
}

/** Everything waiting to be announced, oldest first. */
export async function pending(now = new Date()): Promise<Item[]> {
  return collect(now, 'change_announce.since', held);
}

/**
 * The changes in the window, as items, skipping the ones `isHeld` says were already handled. The held-pay
 * watch reads the same changes under its own claims (`heldPayWatch.ts`), so the two never consume each
 * other's. An item's keys are always this module's own change_announce keys; a caller maps them.
 */
export async function collect(now: Date, sinceKey: string, isHeld: (keys: string[]) => Promise<Set<string>>): Promise<Item[]> {
  const since = (await getMeta(sinceKey)) ?? now.toISOString();
  const from = new Date(Math.max(new Date(since).getTime(), now.getTime() - RULE.lookback_hours * 3_600_000)).toISOString();
  const to = new Date(now.getTime() - RULE.settle_seconds * 1000).toISOString();
  const nm = await names();
  const name = (id: string) => nm.get(id) || id;

  const h = await query<{ id: string; row_id: string; at: string; before: Record<string, unknown>; changed_keys: string[]; loop_id: string; fields: Record<string, unknown> }>(
    `SELECT h.id::text, h.row_id, h.changed_at AS at, h.before_fields AS before, h.changed_keys, l.natural_id AS loop_id, l.fields
       FROM engine_record_history h JOIN engine_loops l ON l.id::text = h.row_id
      WHERE h.table_name = 'engine_loops' AND h.op = 'update' AND h.changed_at > $1 AND h.changed_at <= $2
      ORDER BY h.changed_at`,
    [from, to],
  );
  const ev = await query<{ id: string; event_type: WatchEvent['event_type']; at: string; detail: Record<string, unknown>; watch_id: string }>(
    `SELECT id::text, event_type, at, detail, subject_id AS watch_id FROM engine_events
      WHERE event_type IN ('decision_watch_updated', 'decision_watch_closed', 'decision_watch_reopened') AND at > $1 AND at <= $2
      ORDER BY at`,
    [from, to],
  );
  const already = await isHeld([...h.rows.map((r) => `change_announce:loop_history:${r.id}`), ...ev.rows.map((r) => `change_announce:watch_event:${r.id}`)]);

  const items: Item[] = [];
  const byLoop = new Map<string, { fields: Record<string, unknown>; changes: LoopChange[] }>();
  for (const r of h.rows) {
    if (already.has(`change_announce:loop_history:${r.id}`)) continue;
    const g = byLoop.get(r.loop_id) ?? { fields: r.fields, changes: [] };
    g.changes.push({ history_id: r.id, at: new Date(r.at).toISOString(), before: r.before ?? {}, changed_keys: r.changed_keys ?? [] });
    byLoop.set(r.loop_id, g);
  }
  const audits = new Map<string, LoopAudit[]>();
  if (byLoop.size) {
    const a = await query<{ natural_id: string; at: string; tool: string; reason: string | null; by: string | null }>(
      `SELECT natural_id, at, tool, arguments->>'reason' AS reason, COALESCE(requester_user_id, arguments->>'requester_user_id') AS by
         FROM engine_mcp_writes
        WHERE natural_id = ANY($1::text[]) AND at > $2::timestamptz - interval '5 minutes' AND at <= $3
          AND NOT COALESCE(dry_run, false) AND outcome NOT IN ('refused', 'failed', 'preview')`,
      [[...byLoop.keys()], from, to],
    );
    for (const r of a.rows) {
      const list = audits.get(r.natural_id) ?? [];
      list.push({ at: new Date(r.at).toISOString(), tool: r.tool, reason: (r.reason ?? '').trim(), by: r.by });
      audits.set(r.natural_id, list);
    }
  }
  for (const [loopId, g] of byLoop) {
    const it = loopItem(loopId, g.fields, g.changes, name, audits.get(loopId) ?? []);
    if (it) items.push(it);
  }

  const byWatch = new Map<string, WatchEvent[]>();
  for (const r of ev.rows) {
    if (already.has(`change_announce:watch_event:${r.id}`)) continue;
    const list = byWatch.get(r.watch_id) ?? [];
    list.push({ event_id: r.id, event_type: r.event_type, at: new Date(r.at).toISOString(), detail: r.detail ?? {} });
    byWatch.set(r.watch_id, list);
  }
  if (byWatch.size) {
    const w = await query<WatchRow>(
      `SELECT watch_id, owner_user_id, decision, owner_name, status, next_step, thread_link, coalesce(fixture, false) AS fixture FROM engine_decision_watches WHERE watch_id = ANY($1::text[])`,
      [[...byWatch.keys()]],
    );
    for (const row of w.rows) {
      const it = watchItem(row, byWatch.get(row.watch_id) ?? [], name);
      if (it) items.push(it);
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/* --------------------------------------------------------------- posting */

export interface PassResult {
  pending: number;
  posted: number;
  batched: boolean;
  failed: string | null;
  previews?: string[];
}

type Post = (channel: string, text: string, blocks?: Block[]) => Promise<{ ok: boolean; error?: string; ts?: string }>;

const defaultPost: Post = async (channel, text, blocks) => {
  const r = await slack.botCall('chat.postMessage', { channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false });
  return { ok: r.ok, error: r.error, ts: typeof r.ts === 'string' ? r.ts : undefined };
};

/** Claims every key of the item; false if another pass got there first. */
async function claim(i: Item): Promise<number[] | null> {
  const ids: number[] = [];
  for (const k of i.keys) {
    const r = await record({
      event_type: 'change_announced',
      subject_id: i.id,
      lane: 'BAYS',
      actor: 'change-announce',
      detail: { kind: i.kind, record: i.record, changes: i.changes, channel: RULE.channel },
      dedupe_key: k,
    });
    if (!r.recorded || r.id === null) {
      if (ids.length) await query(`DELETE FROM engine_events WHERE id = ANY($1::bigint[])`, [ids]);
      return null;
    }
    ids.push(r.id);
  }
  return ids;
}

export async function pass(opts: { now?: Date; dry_run?: boolean; post?: Post } = {}): Promise<PassResult> {
  const now = opts.now ?? new Date();
  await setMetaIfAbsent('change_announce.since', now.toISOString());
  const items = await pending(now);
  const batched = items.length > RULE.batch_over;
  if (opts.dry_run) return { pending: items.length, posted: 0, batched, failed: null, previews: batched ? [renderBatch(items)] : items.map(render) };
  const post = opts.post ?? defaultPost;
  if (!items.length) return { pending: 0, posted: 0, batched: false, failed: null };

  if (batched) {
    const claimed: Array<{ i: Item; ids: number[] }> = [];
    for (const i of items) {
      const ids = await claim(i);
      if (ids) claimed.push({ i, ids });
    }
    if (!claimed.length) return { pending: items.length, posted: 0, batched, failed: null };
    const r = await post(RULE.channel, renderBatch(claimed.map((c) => c.i)), batchBlocks(claimed.map((c) => c.i)));
    if (!r.ok) {
      await query(`DELETE FROM engine_events WHERE id = ANY($1::bigint[])`, [claimed.flatMap((c) => c.ids)]);
      console.error(`[change-announce] the combined post of ${claimed.length} changes was refused, will retry: ${r.error}`);
      return { pending: items.length, posted: 0, batched, failed: r.error ?? 'refused' };
    }
    return { pending: items.length, posted: claimed.length, batched, failed: null };
  }

  let posted = 0;
  let failed: string | null = null;
  for (const i of items) {
    const ids = await claim(i);
    if (!ids) continue;
    const r = await post(RULE.channel, render(i), blocks(i));
    if (!r.ok) {
      await query(`DELETE FROM engine_events WHERE id = ANY($1::bigint[])`, [ids]);
      failed = r.error ?? 'refused';
      console.error(`[change-announce] the post for ${i.id} was refused, will retry: ${failed}`);
      continue;
    }
    if (r.ts) await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = ANY($1::bigint[])`, [ids, JSON.stringify({ ts: r.ts })]).catch(() => undefined);
    posted += 1;
  }
  return { pending: items.length, posted, batched: false, failed };
}

/**
 * The posts that went out as plain text before the Block Kit post existed (18 Nov 2026): JD68
 * (history row 1638) and A2OW (1639, posted by the old instance during the deploy's hand-over).
 * Once each, they are rewritten in place with the blocks, guarded by a meta key per post.
 */
const PLAIN_POSTS = [
  { channel: 'C0ASMPYQLG3', ts: '1794994282.960389', key: 'change_announce:loop_history:1638' },
  { channel: 'C0ASMPYQLG3', ts: '1794994880.245829', key: 'change_announce:loop_history:1639' },
  { channel: 'C0ASMPYQLG3', ts: '1794995350.047099', key: 'change_announce:loop_history:1640' },
  { channel: 'C0ASMPYQLG3', ts: '1794995350.350669', key: 'change_announce:loop_history:1641' },
];
export async function restyleFirstPost(now = new Date()): Promise<string> {
  const out: string[] = [];
  let items: Item[] | null = null;
  for (const p of PLAIN_POSTS) {
    const flag = `change_announce.restyled4.${p.ts}`;
    if (await getMeta(flag)) { out.push(`${p.ts} already done`); continue; }
    items ??= await collect(now, 'change_announce.since', async () => new Set());
    const it = items.find((i) => i.keys.includes(p.key));
    if (!it) { out.push(`${p.ts} no longer in the window`); continue; }
    const r = await slack.botCall('chat.update', { channel: p.channel, ts: p.ts, text: render(it), blocks: blocks(it) });
    if (!r.ok) { out.push(`${p.ts} refused: ${String(r.error)}`); continue; }
    await setMetaIfAbsent(flag, now.toISOString());
    out.push(`${p.ts} rewritten`);
  }
  return out.join('; ');
}

/* ----------------------------------------------------------------- timer */

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('change announcements');
    if (busy) return;
    busy = true;
    pass()
      .then((r) => {
        if (r.posted || r.failed) console.log(`[change-announce] ${r.pending} changes, ${r.posted} posted${r.batched ? ' in one combined post' : ''}${r.failed ? `, refused: ${r.failed}` : ''}`);
      })
      .catch((e) => console.error(`[change-announce] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  };
  setTimeout(tick, 30_000).unref();
  setTimeout(() => {
    restyleFirstPost()
      .then((r) => console.log(`[change-announce] first post restyle: ${r}`))
      .catch((e) => console.error(`[change-announce] first post restyle failed: ${e instanceof Error ? e.message : String(e)}`));
  }, 20_000).unref();
  timer = setInterval(tick, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
