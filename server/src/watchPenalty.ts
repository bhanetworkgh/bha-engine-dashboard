/**
 * The Decision Watch pay penalty (23 Nov 2026, Destiny — LOOP-1795365194865-CV3L; Jason approved it word for
 * word on 22 Nov in DM D0AF0DG8ZPY 1795018876.890439, and set the push to 30 days the same day).
 *
 * Scope: a watch whose lane, or whose linked loop's lane, is CST, KIOSK, vFarm hardware, CAPITAL, or an engine
 * lane (Bays, North Star, Research Twin, Genie, Media Twin). A watch with no lane is not in scope, and the in-scope
 * list says how many sit outside it so they can be given one.
 *
 * Clean response (protects the builder): before the watch escalates, the owner posts in its thread either evidence
 * (a link, or a record id such as LOOP-, DW-, CODEX-, EV-, INC-, a PR) or a blocker with a new date. A blocker on
 * time is never penalized. Missing your own new date with silence is a new miss: silence starts again at the end
 * of that date. A blocker whose date cannot be read counts as clean: the doubt goes to the builder.
 *
 * Trigger (both required): the watch escalates (three reminders with no movement, then one more quiet wait), and the
 * owner submitted at least one log, in any lane, during the silent stretch. No logs, no penalty.
 *
 * Penalty: 1st escalation 10% of a day off the owner's next log, 2nd 25%, 3rd and after 50% of that day's pay. The
 * count resets after 30 days with no escalation. It is applied by the engine through the pay note (payNote.set),
 * never by hand, and taken from the credited share first, then the held share. The review card names it. Destiny or
 * Jason can override it with a written reason (kept on record). Nothing is applied backwards: only escalations after
 * the rule is switched on count, and it is off until the announcement has gone out.
 */
import { query, type Queryable } from './pg';
import { getMeta, setMeta } from './db';
import * as engineEvents from './engineEvents';
import * as timers from './timers';
import { ADMIN_IDS } from './writeGuards';

export const RULE = {
  /**
   * 25 Nov 2026 (Jason, C0ASMPYQLG3 1793891836.825299; SOP a4ed8707): vFarm, KIOSK and CST watches only.
   * VFARM_HARDWARE, CAPITAL and the engine lanes came off; any widening needs Jason's separate explicit approval.
   */
  lanes: ['VFARM', 'KIOSK', 'CST'] as readonly string[],
  /** Share of a day taken off, by escalation number (1st, 2nd, 3rd and after). */
  shares: [0.1, 0.25, 0.5] as readonly number[],
  reset_days: 30,
  every_minutes: 10,
  /** Jason, 22 Nov: a 30-day enforcement push to a shipped, chargeable Pilot 1. */
  push_days: 30,
} as const;

const META_ON = 'watch_penalty.enabled_at';
const PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}`;
export const WARNING = 'This watch carries a pay penalty if it escalates: if it gets three reminders with no evidence and no blocker with a new date posted here, and you log work meanwhile, 10% of a day comes off your next log (25% the second time, 50% from the third, reset after 30 days with none).';

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/* ------------------------------------------------------------------ pure rules */

const EVIDENCE = /(https?:\/\/\S+|\b(?:LOOP|DW|CODEX|EV|INC|TASK|BP|CAND|KC|REP)-[A-Za-z0-9.-]{3,}|\bPR\s*#?\d+|\/pull\/\d+)/i;
const BLOCKER = /\b(blocked|blocker|blocking|waiting (?:on|for)|depends on|stuck on|held up|new date|pushed to|moving it to|need[s]? .{0,40}\bfrom\b)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The new date a blocker names, as YYYY-MM-DD, relative to when it was posted. null when none can be read. Pure. */
export function newDate(text: string, postedAt: Date): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const y = postedAt.getUTCFullYear();
  const mk = (m: number, d: number) => {
    let dt = new Date(Date.UTC(y, m, d));
    if (dt.getTime() < postedAt.getTime() - 7 * 86_400_000) dt = new Date(Date.UTC(y + 1, m, d));
    return dt.toISOString().slice(0, 10);
  };
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (dm) return mk(MONTHS.indexOf(dm[2]), Number(dm[1]));
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) return mk(MONTHS.indexOf(md[1]), Number(md[2]));
  if (/\btomorrow\b/.test(t)) return new Date(postedAt.getTime() + 86_400_000).toISOString().slice(0, 10);
  // The last weekday named is the new date ("arrives Thursday, new date Friday" is Friday).
  let wd = -1;
  let at = -1;
  DAYS.forEach((d, i) => {
    const m = [...t.matchAll(new RegExp(`\\b${d}\\b`, 'g'))].pop();
    if (m && (m.index ?? -1) > at) { at = m.index ?? -1; wd = i; }
  });
  if (wd >= 0) {
    const ahead = ((wd - postedAt.getUTCDay() + 7) % 7) || 7;
    return new Date(postedAt.getTime() + ahead * 86_400_000).toISOString().slice(0, 10);
  }
  if (/\btoday\b|\btonight\b|\beod\b/.test(t)) return postedAt.toISOString().slice(0, 10);
  return null;
}

export type Response = { kind: 'evidence' } | { kind: 'blocker'; new_date: string | null } | null;

/** Whether one owner message is a clean response. Pure. */
export function classify(text: string, postedAt: Date): Response {
  const blocker = BLOCKER.test(text);
  const date = newDate(text, postedAt);
  if (blocker && date) return { kind: 'blocker', new_date: date };
  if (EVIDENCE.test(text)) return { kind: 'evidence' };
  if (blocker) return { kind: 'blocker', new_date: null };
  return null;
}

export interface Silence {
  clean: boolean;
  /** Why, in words. */
  finding: string;
  /** Where the silent stretch begins, when there is one. */
  silence_from: Date | null;
  response_ts: string | null;
}

/**
 * The silent stretch before an escalation, from the owner's own messages in the thread. Pure.
 * The newest clean response decides: evidence, or a blocker whose new date has not passed (or cannot be read), is
 * clean. A blocker whose new date passed with no later owner message starts a new silence at the end of that date.
 */
export function silence(owner: { ts: string; text: string }[], openedAt: Date, escalatedAt: Date): Silence {
  const msgs = owner.map((m) => ({ ...m, at: new Date(Number(m.ts) * 1000) })).filter((m) => m.at <= escalatedAt).sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const m of msgs) {
    const r = classify(m.text, m.at);
    if (!r) continue;
    if (r.kind === 'evidence') return { clean: true, finding: 'the owner posted evidence in the thread before it escalated', silence_from: null, response_ts: m.ts };
    if (!r.new_date) return { clean: true, finding: 'the owner posted a blocker in the thread before it escalated (its new date could not be read, so it counts as clean)', silence_from: null, response_ts: m.ts };
    const end = new Date(`${r.new_date}T23:59:59Z`);
    if (end >= escalatedAt) return { clean: true, finding: `the owner posted a blocker with a new date, ${r.new_date}, that had not passed when it escalated`, silence_from: null, response_ts: m.ts };
    const later = msgs.some((x) => x.at > end);
    if (later) return { clean: true, finding: `the owner posted a blocker with a new date, ${r.new_date}, and spoke again after it`, silence_from: null, response_ts: m.ts };
    return { clean: false, finding: `the owner's new date, ${r.new_date}, passed with no word: a new miss`, silence_from: end, response_ts: m.ts };
  }
  return { clean: false, finding: msgs.length ? 'the owner replied, but with no evidence and no blocker with a new date' : 'the owner posted nothing in the thread', silence_from: openedAt, response_ts: null };
}

/** The escalation number for a new one, from the owner's earlier counted ones (not overridden). Pure. */
export function levelFor(earlier: Date[], at: Date): number {
  const prior = earlier.filter((d) => d < at).sort((a, b) => b.getTime() - a.getTime());
  let level = 1;
  let last = at;
  for (const d of prior) {
    if (last.getTime() - d.getTime() > RULE.reset_days * 86_400_000) break;
    level += 1;
    last = d;
  }
  return level;
}

export const shareFor = (level: number) => RULE.shares[Math.min(level, RULE.shares.length) - 1];

/** What a penalty takes off a pay choice: from the credited share first, then the held share. Pure. */
export function takeOff(credited: number, held: number, share: number): { credited: number; held: number; taken: number } {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const fromCredit = Math.min(credited, share);
  const fromHeld = Math.min(held, r3(share - fromCredit));
  return { credited: r3(credited - fromCredit), held: r3(held - fromHeld), taken: r3(fromCredit + fromHeld) };
}

/* ------------------------------------------------------------------ switch */

let onCache: { at: number; value: Date | null } | null = null;
export async function enabledAt(): Promise<Date | null> {
  if (onCache && Date.now() - onCache.at < 60_000) return onCache.value;
  const v = await getMeta(META_ON).catch(() => null);
  const d = v && v !== 'off' ? new Date(v) : null;
  onCache = { at: Date.now(), value: d && !Number.isNaN(d.getTime()) ? d : null };
  return onCache.value;
}

export async function setSwitch(on: boolean, by: string | null, reason: string): Promise<Record<string, unknown>> {
  if (!by || !ADMIN_IDS.includes(by)) return { ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason switches the watch pay penalty on or off.' };
  if (reason.trim().length < 3) return { ok: false, reason: 'reason_required', message: 'Say why, in a few words.' };
  const was = await enabledAt();
  if (on && was) return { ok: true, unchanged: true, enabled_at: was.toISOString(), message: `Already on since ${was.toISOString()}.` };
  if (!on && !was) return { ok: true, unchanged: true, message: 'Already off.' };
  const at = new Date();
  await setMeta(META_ON, on ? at.toISOString() : 'off');
  onCache = null;
  await engineEvents.record({ event_type: on ? 'watch_penalty_switched_on' : 'watch_penalty_switched_off', subject_id: 'watch_penalty', lane: 'BAYS', actor: by, detail: { reason: reason.trim().slice(0, 300), at: at.toISOString() }, dedupe_key: `wp:switch:${at.getTime()}` });
  return { ok: true, on, ...(on ? { enabled_at: at.toISOString(), message: `On from ${at.toISOString()}. Only escalations after this count; nothing is applied backwards.` } : { message: 'Off. Penalties already recorded stay as they are.' }) };
}

/* ------------------------------------------------------------------ scope */

interface WatchLite { watch_id: string; owner_user_id: string; lane: string | null; record_kind: string | null; record_id: string | null; decision: string; next_step: string | null; created_at: Date; closed_at: Date | null; channel_id: string | null; thread_ts: string | null; thread_link: string | null; fixture: boolean; status: string }

/** The lane a watch is judged under: its own, else its linked loop's. */
export async function laneOf(w: Pick<WatchLite, 'lane' | 'record_kind' | 'record_id'>, db: Queryable = { query } as Queryable): Promise<string | null> {
  if (w.lane) return w.lane.toUpperCase();
  if (w.record_kind === 'loops' && w.record_id) {
    const r = await db.query<{ lt: string | null }>(`SELECT fields->>'lane_tag' AS lt FROM engine_loops WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1`, [w.record_id]);
    return r.rows[0]?.lt ?? null;
  }
  return null;
}

export const inScopeLane = (lane: string | null) => !!lane && RULE.lanes.includes(lane.toUpperCase());

/** The warning line for a watch's reminders, when the rule is on and the watch is in scope; else null. */
export async function warningFor(w: Pick<WatchLite, 'lane' | 'record_kind' | 'record_id'> & { fixture?: boolean }): Promise<string | null> {
  try {
    if (!(await enabledAt())) return null;
    return inScopeLane(await laneOf(w)) ? WARNING : null;
  } catch {
    return null;
  }
}

/** Jason's 30-day push group for a watch. Pure. */
export function pushGroup(lane: string | null, text: string): string {
  const t = text.toLowerCase();
  if (/\b2kg0\b|\bv52v\b|charge[_ ]gate|offer[_ ]approv|stripe|checkout|payment/.test(t)) return 'Stripe 2KG0 / V52V and charge gate';
  if (/monitoring twin|\bmonitoring\b|alerts?\b|screen.{0,4}source/.test(t)) return 'Monitoring Twin';
  const l = (lane ?? '').toUpperCase();
  if (l === 'VFARM_HARDWARE' || l === 'VFARM' || l === 'KIOSK' || /\brack\b|pilot 1|stage 1|rover|hardware/.test(t)) return 'Pilot 1 racks and hardware';
  if (l === 'CAPITAL') return 'CAPITAL';
  if (l === 'CST') return 'CST';
  return 'Engine';
}

/** Every open watch the rule covers, grouped for Jason's 30-day push, and how many sit outside it with no lane. */
export async function inScope(): Promise<{ groups: { group: string; watches: { watch_id: string; lane: string; owner_user_id: string; decision: string; link: string | null }[] }[]; total: number; no_lane: number; other_lane: number }> {
  const rows = (await query<WatchLite & { loop_lane: string | null }>(
    `SELECT w.*, l.lt AS loop_lane FROM engine_decision_watches w
       LEFT JOIN LATERAL (SELECT fields->>'lane_tag' AS lt FROM engine_loops WHERE w.record_kind = 'loops' AND natural_id = w.record_id ORDER BY updated_at DESC LIMIT 1) l ON true
      WHERE w.status IN ('watching', 'escalating') AND w.fixture = false ORDER BY w.created_at`,
  )).rows;
  const groups = new Map<string, { watch_id: string; lane: string; owner_user_id: string; decision: string; link: string | null }[]>();
  let noLane = 0;
  let other = 0;
  for (const w of rows) {
    const lane = (w.lane ?? w.loop_lane ?? null)?.toUpperCase() ?? null;
    if (!lane) { noLane += 1; continue; }
    if (!inScopeLane(lane)) { other += 1; continue; }
    const g = pushGroup(lane, `${w.decision} ${w.next_step ?? ''}`);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ watch_id: w.watch_id, lane, owner_user_id: w.owner_user_id, decision: w.decision.split('\n')[0].slice(0, 200), link: w.thread_link });
  }
  const order = ['Pilot 1 racks and hardware', 'Monitoring Twin', 'Stripe 2KG0 / V52V and charge gate', 'CAPITAL', 'CST', 'Engine'];
  const out = order.filter((g) => groups.has(g)).map((g) => ({ group: g, watches: groups.get(g)! }));
  return { groups: out, total: out.reduce((n, g) => n + g.watches.length, 0), no_lane: noLane, other_lane: other };
}

/* ------------------------------------------------------------------ on escalation */

export interface PenaltyRow {
  penalty_id: string;
  watch_id: string;
  owner_user_id: string;
  lane: string;
  escalated_at: string;
  silence_from: string;
  logs_in_silence: string[];
  level: number;
  share: number;
  status: 'pending' | 'applied' | 'overridden';
  applied_submission_id: string | null;
  applied_share: number | null;
  applied_at: string | null;
  override_reason: string | null;
  override_by: string | null;
  override_at: string | null;
  finding: string;
}

async function ownerMessages(w: WatchLite, until: Date): Promise<{ ok: true; messages: { ts: string; text: string }[] } | { ok: false; error: string }> {
  if (!w.channel_id || !w.thread_ts) return { ok: true, messages: [] };
  const { readSince } = await import('./decisionWatch');
  const r = await readSince(w.channel_id, w.thread_ts, (new Date(w.created_at).getTime() / 1000 - 1).toFixed(6));
  if (!r.ok) return { ok: false, error: r.error };
  const mine = r.messages
    .filter((m) => m.user === w.owner_user_id && !m.bot_id && m.ts && Number(m.ts) * 1000 <= until.getTime())
    .map((m) => ({ ts: String(m.ts), text: String((m as { text?: string }).text ?? '') }));
  // The root message counts too when the owner posted it.
  return { ok: true, messages: mine };
}

async function checked(watchId: string, at: string, outcome: string, detail: Record<string, unknown>, lane: string | null): Promise<void> {
  await engineEvents.record({ event_type: 'watch_penalty_checked', subject_id: watchId, lane: lane ?? 'BAYS', actor: 'watch penalty', detail: { outcome, escalated_at: at, ...detail }, dedupe_key: `wp:checked:${watchId}:${at}` });
}

/** Judges one escalation. Idempotent on (watch, escalation time). */
export async function judge(watchId: string, escalatedAt: Date): Promise<{ outcome: string; penalty?: PenaltyRow; detail?: string }> {
  const w = (await query<WatchLite>(`SELECT * FROM engine_decision_watches WHERE watch_id = $1`, [watchId])).rows[0];
  const at = escalatedAt.toISOString();
  if (!w) return { outcome: 'not_held' };
  if (w.fixture) return { outcome: 'fixture' };
  const on = await enabledAt();
  if (!on || escalatedAt < on) { await checked(watchId, at, 'before_switch_on', {}, w.lane); return { outcome: 'before_switch_on' }; }
  const lane = await laneOf(w);
  if (!inScopeLane(lane)) { await checked(watchId, at, 'out_of_scope', { lane }, lane); return { outcome: 'out_of_scope', detail: lane ?? 'no lane' }; }
  // An approved excused session that day, with the penalty suppressed by its approver (28 Nov 2026, SOP 8996e4da).
  // That day only: a penalty recorded on an earlier day stays.
  const { suppressingOn } = await import('./excusedSessions');
  const excused = await suppressingOn(w.owner_user_id, escalatedAt);
  if (excused) { await checked(watchId, at, 'excused', { session_id: excused.session_id, incident_id: excused.incident_id }, lane); return { outcome: 'excused', detail: excused.session_id }; }
  const msgs = await ownerMessages(w, escalatedAt);
  if (!msgs.ok) return { outcome: 'thread_unread', detail: msgs.error }; // tried again on the next pass
  const s = silence(msgs.messages, new Date(w.created_at), escalatedAt);
  if (s.clean) { await checked(watchId, at, 'clean_response', { finding: s.finding, response_ts: s.response_ts }, lane); return { outcome: 'clean_response', detail: s.finding }; }
  const from = s.silence_from ?? new Date(w.created_at);
  const logs = (await query<{ sid: string }>(
    `SELECT natural_id AS sid FROM engine_codex_submissions
      WHERE fields->>'Builder User ID' = $1 AND created_time::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz
        AND coalesce(fields->>'Jason Status', '') <> 'Rejected' AND coalesce(fields->>'Log Kind', '') <> 'Report'
      ORDER BY created_time`,
    [w.owner_user_id, from.toISOString(), at],
  )).rows.map((r) => r.sid);
  if (!logs.length) { await checked(watchId, at, 'no_logs', { finding: s.finding, silence_from: from.toISOString() }, lane); return { outcome: 'no_logs', detail: s.finding }; }
  const earlier = (await query<{ at: Date }>(`SELECT escalated_at AS at FROM engine_watch_penalties WHERE owner_user_id = $1 AND status <> 'overridden'`, [w.owner_user_id])).rows.map((r) => new Date(r.at));
  const level = levelFor(earlier, escalatedAt);
  const share = shareFor(level);
  const id = `WP-${escalatedAt.getTime()}-${watchId.slice(-4)}`;
  const ins = await query<PenaltyRow>(
    `INSERT INTO engine_watch_penalties (penalty_id, watch_id, owner_user_id, lane, escalated_at, silence_from, logs_in_silence, level, share, finding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (watch_id, escalated_at) DO NOTHING RETURNING *`,
    [id, watchId, w.owner_user_id, lane, at, from.toISOString(), JSON.stringify(logs), level, share, s.finding],
  );
  if (!ins.rows[0]) return { outcome: 'already_recorded' };
  await checked(watchId, at, 'penalty', { penalty_id: id, level, share, logs, finding: s.finding }, lane);
  await query(`UPDATE engine_decision_watches SET history = history || $2::jsonb WHERE watch_id = $1`, [watchId, JSON.stringify([{ at: new Date().toISOString(), what: `pay penalty ${id}: ${pct(share)} of a day off the owner's next log (escalation ${level}; ${s.finding}; ${logs.length} log${logs.length === 1 ? '' : 's'} submitted meanwhile)` }])]);
  // One line in the watch's thread so the builder sees it where the watch lives. A post that does not land never undoes the penalty.
  if (w.channel_id && w.thread_ts) {
    const { postAsGenie } = await import('./genieSlack');
    const text = `:receipt: *Decision Watch pay penalty* <@${w.owner_user_id}>: this watch escalated with ${s.finding}, while ${logs.length} log${logs.length === 1 ? ' was' : 's were'} submitted. Under the Decision Watch pay rule, ${pct(share)} of a day comes off your next log (escalation ${level} in 30 days). Destiny or Jason can override it with a written reason. (\`${id}\`)`;
    const p = await postAsGenie(w.channel_id, text, [], undefined, { thread_ts: w.thread_ts, guarded: true }).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!p.ok) console.error(`[watch-penalty] ${id} recorded; the thread line was not posted: ${p.error}`);
  }
  return { outcome: 'penalty', penalty: ins.rows[0] };
}

/** Every escalation since the switch that has not been judged yet. */
export async function sweep(): Promise<{ looked_at: number; outcomes: Record<string, number> }> {
  const on = await enabledAt();
  const out = { looked_at: 0, outcomes: {} as Record<string, number> };
  if (!on) return out;
  const rows = (await query<{ subject_id: string; at: Date }>(
    `SELECT e.subject_id, e.at FROM engine_events e
      WHERE e.event_type = 'decision_watch_escalated' AND e.at >= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM engine_events c WHERE c.event_type = 'watch_penalty_checked' AND c.subject_id = e.subject_id AND c.detail->>'escalated_at' = to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        AND NOT EXISTS (SELECT 1 FROM engine_watch_penalties p WHERE p.watch_id = e.subject_id AND p.escalated_at = e.at)
      ORDER BY e.at LIMIT 20`,
    [on.toISOString()],
  )).rows;
  for (const r of rows) {
    out.looked_at += 1;
    const j = await judge(r.subject_id, new Date(r.at)).catch((e) => ({ outcome: 'error', detail: e instanceof Error ? e.message : String(e) }));
    out.outcomes[j.outcome] = (out.outcomes[j.outcome] ?? 0) + 1;
    if (j.outcome === 'error' || j.outcome === 'thread_unread') console.error(`[watch-penalty] ${r.subject_id}: ${j.outcome} ${j.detail ?? ''}`);
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('watch pay penalty');
    if (busy) return;
    busy = true;
    sweep()
      .then((r) => { if (r.looked_at) console.log(`[watch-penalty] ${r.looked_at} escalations judged: ${JSON.stringify(r.outcomes)}`); })
      .catch((e) => console.error(`[watch-penalty] sweep failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.every_minutes * 60_000);
  timer.unref();
}

/* ------------------------------------------------------------------ the pay note */

/** The oldest pending penalty a builder's log takes: one escalated before the log was submitted. */
export async function pendingFor(builder: string | null, submittedAt: Date | null, db: Queryable = { query } as Queryable, lock = false): Promise<PenaltyRow | null> {
  if (!builder || !submittedAt) return null;
  const r = await db.query<PenaltyRow>(
    `SELECT * FROM engine_watch_penalties WHERE owner_user_id = $1 AND status = 'pending' AND escalated_at < $2::timestamptz ORDER BY escalated_at LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [builder, submittedAt.toISOString()],
  );
  return r.rows[0] ?? null;
}

/** The card line for a pending penalty. Pure. */
export const cardFlag = (p: Pick<PenaltyRow, 'watch_id' | 'share' | 'penalty_id' | 'level'>) =>
  `Watch penalty: ${p.watch_id} ${pct(p.share)} (escalation ${p.level}, ${p.penalty_id}). The engine takes it off whatever you approve; to override it, give a written reason.`;

/** Marks a pending penalty applied to one log, inside the pay note's own transaction. */
export async function markApplied(db: Queryable, p: PenaltyRow, submissionId: string, taken: number): Promise<void> {
  await db.query(`UPDATE engine_watch_penalties SET status = 'applied', applied_submission_id = $2, applied_share = $3, applied_at = now() WHERE penalty_id = $1 AND status = 'pending'`, [p.penalty_id, submissionId, taken]);
  await engineEvents.record({ event_type: 'watch_penalty_applied', subject_id: p.watch_id, lane: p.lane, actor: 'watch penalty', detail: { penalty_id: p.penalty_id, submission_id: submissionId, share: p.share, taken }, dedupe_key: `wp:applied:${p.penalty_id}` }, db);
}

/** Overrides one penalty with a written reason. A pending one is never applied; an applied one is marked for the pay note to restore. */
export async function override(penaltyId: string, by: string | null, reason: string, db: Queryable = { query } as Queryable): Promise<Record<string, unknown>> {
  if (!by || !ADMIN_IDS.includes(by)) return { ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason overrides a watch pay penalty.' };
  if (reason.trim().length < 8) return { ok: false, reason: 'reason_required', message: 'An override needs a written reason (8 characters or more); it is kept on record.' };
  const p = (await db.query<PenaltyRow>(`SELECT * FROM engine_watch_penalties WHERE penalty_id = $1`, [penaltyId])).rows[0];
  if (!p) return { ok: false, reason: 'not_found', message: `No penalty ${penaltyId}.` };
  if (p.status === 'overridden') return { ok: true, unchanged: true, message: `${penaltyId} is already overridden.` };
  await db.query(`UPDATE engine_watch_penalties SET status = 'overridden', override_reason = $2, override_by = $3, override_at = now() WHERE penalty_id = $1`, [penaltyId, reason.trim().slice(0, 600), by]);
  await engineEvents.record({ event_type: 'watch_penalty_overridden', subject_id: p.watch_id, lane: p.lane, actor: by, detail: { penalty_id: penaltyId, was: p.status, applied_submission_id: p.applied_submission_id, reason: reason.trim().slice(0, 300) }, dedupe_key: `wp:override:${penaltyId}` }, db);
  return {
    ok: true, overridden: penaltyId, was: p.status,
    message: p.status === 'applied'
      ? `${penaltyId} overridden. It had taken ${pct(Number(p.applied_share ?? 0))} off ${p.applied_submission_id}; restore that share on its pay note with set_pay_note (a correction, note "watch penalty ${penaltyId} overridden").`
      : `${penaltyId} overridden before it was applied: no log loses anything.`,
  };
}

/* ------------------------------------------------------------------ the read */

export async function read(): Promise<Record<string, unknown>> {
  const on = await enabledAt();
  const rows = (await query<PenaltyRow>(`SELECT * FROM engine_watch_penalties ORDER BY escalated_at DESC LIMIT 100`)).rows;
  const scope = await inScope();
  return {
    on: !!on,
    enabled_at: on ? on.toISOString() : null,
    rule: `Watches on ${RULE.lanes.join(', ')} (its own lane or its loop's). A watch escalates after three reminders with no movement. If, by then, its owner posted neither evidence nor a blocker with a new date in its thread, and submitted a log during that silent stretch, ${RULE.shares.map(pct).join(', ')} of a day comes off their next log (1st, 2nd, 3rd and after), reset after ${RULE.reset_days} days with none. Applied through the pay note, never by hand; overrides need a written reason. Nothing is applied backwards.`,
    in_penalty: rows.filter((r) => r.status !== 'overridden'),
    overridden: rows.filter((r) => r.status === 'overridden'),
    in_scope: scope,
    page: `${PAGE}/logstream?tab=watch-penalties`,
  };
}
