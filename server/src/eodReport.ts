/**
 * The end of day report (24 Nov 2026, Destiny; Jason's engine steward ask, DM D0AF0DG8ZPY 1795485261.087299: by end
 * of day, say what moved for Pilot 1, what is blocked and on whom, and tomorrow's 1 or 2 priorities per person).
 *
 * Every day at 17:00 New York, Genie posts one report in #bha-coordination, built from the records and never written
 * by a model, so it says nothing the records do not:
 *   - What moved: every Codex log submitted in the last 24 hours, by person (rejected logs and reports left out), and
 *     every loop or Decision Watch that changed or closed in that window (the change announcer's own events);
 *   - What is blocked, and on whom: the blocked loops the Income Board's blockers page reads, grouped by the person
 *     each waits on (blockerAlerts.byBlocker), late first; and the two gates while they are still false;
 *   - Tomorrow's priorities: from the Income Board, each person's open BLOCKS_PILOT_1 items, at most 2, slipped first,
 *     then soonest date, then In Progress before Open, then the one untouched longest.
 *
 * One post per New York day: the claim is an `eod_report_sent` event written before the post and given back if
 * Slack refuses, and a refusal is said in the engine alerts channel once that day, so a missing report is never silent.
 */
import { query } from './pg';
import { record } from './engineEvents';
import { postAsGenie } from './genieSlack';
import * as slack from './slack';
import { blockers, read as readBoard, OWNER_VIEWS, type Blocker } from './incomeBoard';
import { byBlocker, type Person } from './blockerAlerts';
import { FORMER_BUILDERS } from './sources';
import * as timers from './timers';

export const RULE = {
  tz: 'America/New_York',
  /** 17:00 New York: 23:00 Lagos, 03:30 India, 03:00 Pakistan. */
  hour: 17,
  window_hours: 24,
  every_minutes: 10,
  priorities_per_person: 2,
  max_logs_per_person: 5,
  max_moves: 15,
  max_blocked_per_person: 5,
} as const;

const CHANNEL = () => process.env.EOD_REPORT_CHANNEL || 'C0ASMPYQLG3'; // #bha-coordination
const BASE = (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');

const cut = (s: string | null | undefined, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The New York date and hour of a moment. Pure. */
export function nyClock(now: Date): { date: string; hour: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: RULE.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Due from 17:00 New York. Pure. */
export function isDue(now: Date): boolean {
  return nyClock(now).hour >= RULE.hour;
}

export interface Log { builder: string; id: string; title: string; link: string }
export interface Move { id: string; kind: 'progress' | 'completion'; title: string; owner: string | null; changes: string[]; link: string }

/** Tomorrow's priorities per person, read from the Income Board's items. Pure. */
export function priorities(items: Blocker[]): { label: string; items: Blocker[] }[] {
  const rank = (i: Blocker) => (i.date_state === 'slipped' ? 0 : 1);
  const order = (a: Blocker, b: Blocker) =>
    rank(a) - rank(b) ||
    (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999') ||
    Number(b.status === 'In Progress') - Number(a.status === 'In Progress') ||
    (a.last_change ?? '').localeCompare(b.last_change ?? '');
  const out: { label: string; items: Blocker[] }[] = [];
  for (const v of OWNER_VIEWS) {
    for (const owner of v.owners) {
      const mine = items.filter((i) => i.open && i.owner === owner && i.impact === 'BLOCKS_PILOT_1').sort(order).slice(0, RULE.priorities_per_person);
      if (mine.length) out.push({ label: owner, items: mine });
    }
  }
  return out;
}

const when = (i: Blocker) => (i.date_state === 'slipped' ? `${i.days_slipped} day${i.days_slipped === 1 ? '' : 's'} late (was ${i.target_date})` : i.target_date ? `due ${i.target_date}` : 'no date');
const ref = (id: string, link: string | null) => (link ? `<${link}|${id.slice(-4)}>` : id.slice(-4));

/** The report. Pure. */
export function reportText(r: {
  date: string;
  logs: Log[];
  moves: Move[];
  blocked: { person: Person; loops: { loop_id: string; title: string; link: string; late: boolean; days_late: number | null; owner: string | null }[] }[];
  gates: Blocker[];
  priorities: { label: string; items: Blocker[] }[];
  ready: string;
}): string {
  const out: string[] = [`*End of day report, ${r.date} (17:00 New York)*`, `Ready for the first paid Pilot 1 rack: *${r.ready}*. Read from the Codex logs, loop and watch changes, and the <${BASE}/income-board|Income Board> for the last 24 hours.`];

  out.push('', '*What moved*');
  if (!r.logs.length && !r.moves.length) out.push('Nothing was logged or moved in the last 24 hours.');
  const byBuilder = new Map<string, Log[]>();
  for (const l of r.logs) byBuilder.set(l.builder, [...(byBuilder.get(l.builder) ?? []), l]);
  for (const [b, ls] of byBuilder) {
    const shown = ls.slice(0, RULE.max_logs_per_person).map((l) => `<${l.link}|${cut(l.title, 110)}>`).join('; ');
    out.push(`• ${b}: ${ls.length} log${ls.length === 1 ? '' : 's'}: ${shown}${ls.length > RULE.max_logs_per_person ? `, and ${ls.length - RULE.max_logs_per_person} more` : ''}`);
  }
  const closed = r.moves.filter((m) => m.kind === 'completion');
  const moved = r.moves.filter((m) => m.kind !== 'completion');
  if (closed.length) out.push(`• Closed: ${closed.slice(0, RULE.max_moves).map((m) => `${ref(m.id, m.link)} ${cut(m.title, 70)}${m.owner ? ` (${m.owner})` : ''}`).join('; ')}${closed.length > RULE.max_moves ? `, and ${closed.length - RULE.max_moves} more` : ''}`);
  if (moved.length) out.push(`• Moved: ${moved.slice(0, RULE.max_moves).map((m) => `${ref(m.id, m.link)} ${cut(m.title, 70)}${m.owner ? ` (${m.owner})` : ''}`).join('; ')}${moved.length > RULE.max_moves ? `, and ${moved.length - RULE.max_moves} more` : ''}`);

  out.push('', '*What is blocked, and on whom*');
  const openGates = r.gates.filter((g) => g.open);
  if (openGates.length) out.push(`• Gates still false: ${openGates.map((g) => g.id).join(', ')}.`);
  if (!r.blocked.length) out.push('• No open loop is marked blocked on a person.');
  for (const { person, loops } of r.blocked) {
    const late = loops.filter((l) => l.late).length;
    const shown = loops.slice(0, RULE.max_blocked_per_person).map((l) => `${ref(l.loop_id, l.link)} ${cut(l.title, 60)}${l.late ? ` (${l.days_late}d late)` : ''}`).join('; ');
    out.push(`• Waiting on <@${person.id}>: ${loops.length} loop${loops.length === 1 ? '' : 's'}${late ? `, ${late} late` : ''}: ${shown}${loops.length > RULE.max_blocked_per_person ? `, and ${loops.length - RULE.max_blocked_per_person} more` : ''}`);
  }

  out.push('', "*Tomorrow's priorities*");
  if (!r.priorities.length) out.push('No open Pilot 1 item has an owner on the board.');
  for (const p of r.priorities) out.push(`• ${p.label}: ${p.items.map((i) => `${ref(i.id, i.link)} ${cut(i.title, 80)} (${when(i)})`).join('; ')}`);
  out.push('', `_Priorities are each person's open Pilot 1 items on the Income Board: late first, then soonest date, then work already in progress. To change one, change it on the board._`);
  return out.join('\n');
}

async function people(): Promise<Person[]> {
  const r = await query<{ id: string; name: string }>(`SELECT fields->>'user_id' AS id, fields->>'name' AS name FROM engine_builder_profiles WHERE coalesce(fields->>'user_id','') <> ''`);
  return r.rows.filter((p) => p.name && !FORMER_BUILDERS.includes(p.id)).map((p) => ({ id: p.id, name: p.name }));
}

async function logs(since: Date): Promise<Log[]> {
  const r = await query<{ natural_id: string; builder: string | null; title: string | null; codex: string | null }>(
    `SELECT DISTINCT ON (natural_id) natural_id, fields->>'Builder Name' AS builder, coalesce(nullif(fields->>'Session Description',''), fields->>'Summary') AS title, fields->>'Codex Entry ID' AS codex
       FROM engine_codex_submissions
      WHERE natural_id IS NOT NULL AND created_time::timestamptz >= $1
        AND coalesce(fields->>'Jason Status','') <> 'Rejected' AND coalesce(fields->>'Log Kind','') <> 'Report'
        AND coalesce(fields->>'Session Url','') NOT ILIKE '%TEST%'
      ORDER BY natural_id, id DESC`,
    [since.toISOString()],
  );
  return r.rows.map((x) => ({ builder: x.builder || 'Unknown builder', id: x.natural_id, title: x.title || x.natural_id, link: `${BASE}/codex/${encodeURIComponent(x.codex || x.natural_id)}` }));
}

async function moves(since: Date): Promise<Move[]> {
  const r = await query<{ subject_id: string; kind: string; record: string; changes: string[] | null; title: string | null; owner: string | null }>(
    `SELECT DISTINCT ON (e.subject_id) e.subject_id, e.detail->>'kind' AS kind, e.detail->>'record' AS record,
            ARRAY(SELECT jsonb_array_elements_text(coalesce(e.detail->'changes','[]'::jsonb))) AS changes,
            coalesce(l.fields->>'What', w.decision) AS title,
            coalesce(l.fields->>'Assignee Slack User ID', w.owner_user_id) AS owner
       FROM engine_events e
       LEFT JOIN LATERAL (SELECT fields FROM engine_loops WHERE natural_id = e.subject_id ORDER BY id DESC LIMIT 1) l ON true
       LEFT JOIN engine_decision_watches w ON w.watch_id = e.subject_id
      WHERE e.event_type = 'change_announced' AND e.at >= $1
      ORDER BY e.subject_id, (e.detail->>'kind' = 'completion') DESC, e.at DESC`,
    [since.toISOString()],
  );
  const names = Object.fromEntries((await people()).map((p) => [p.id, p.name.split(/\s+/)[0]]));
  return r.rows.map((x) => ({
    id: x.subject_id,
    kind: x.kind === 'completion' ? 'completion' : 'progress',
    title: x.title || x.subject_id,
    owner: x.owner ? names[x.owner] ?? null : null,
    changes: x.changes ?? [],
    link: x.record === 'watch' ? `${BASE}/bays?tab=decision-watch` : `${BASE}/open-loops/${x.subject_id}`,
  }));
}

/** Everything the report says, read now. */
export async function build(now = new Date()) {
  const since = new Date(now.getTime() - RULE.window_hours * 3_600_000);
  const [board, b, ppl, ls, ms] = await Promise.all([readBoard(now), blockers(now), people(), logs(since), moves(since)]);
  const grouped = [...byBlocker(b.rows, ppl).values()].sort((x, y) => y.loops.filter((l) => l.late).length - x.loops.filter((l) => l.late).length || y.loops.length - x.loops.length);
  const data = { date: nyClock(now).date, logs: ls, moves: ms, blocked: grouped, gates: board.gates, priorities: priorities(board.items), ready: board.ready };
  return { ...data, text: reportText(data) };
}

async function alertRefused(day: string, error: string): Promise<void> {
  try {
    const claim = await record({ event_type: 'eod_report_refused', subject_id: day, lane: 'ENGINE', actor: 'eod-report', detail: { error: cut(error, 500) }, dedupe_key: `eod_report_refused:${day}` });
    if (!claim.recorded) return;
    const channel = process.env.QUOTA_ALERT_CHANNEL?.trim();
    if (!channel) return void console.error(`[eod-report] no QUOTA_ALERT_CHANNEL, refusal not posted: ${error}`);
    const res = await slack.botCall('chat.postMessage', { channel, text: `The end of day report for ${day} was not posted in #bha-coordination: ${cut(error, 400)}. It is tried again every ${RULE.every_minutes} minutes.`, unfurl_links: false });
    if (!res.ok) console.error(`[eod-report] refusal alert not posted (${res.error})`);
  } catch (e) {
    console.error(`[eod-report] refusal alert not posted: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One report per New York day, from 17:00 New York. dry_run builds it and posts nothing. */
export async function run(now = new Date(), opts: { force?: boolean; dry_run?: boolean } = {}): Promise<{ due: boolean; posted: boolean; already?: boolean; ts?: string; error?: string; text?: string }> {
  if (!opts.force && !isDue(now)) return { due: false, posted: false };
  const day = nyClock(now).date;
  const report = await build(now);
  if (opts.dry_run) return { due: true, posted: false, text: report.text };
  const key = `eod_report:${day}`;
  const claim = await record({ event_type: 'eod_report_sent', subject_id: day, lane: 'ENGINE', actor: 'eod-report', detail: { channel: CHANNEL(), logs: report.logs.length, moves: report.moves.length, blocked_people: report.blocked.length, priorities: report.priorities.map((p) => ({ person: p.label, items: p.items.map((i) => i.id) })) }, dedupe_key: key });
  if (!claim.recorded) return { due: true, posted: false, already: true };
  const r = await postAsGenie(CHANNEL(), report.text, [], undefined, { guarded: true });
  if (!r.ok) {
    await query(`DELETE FROM engine_events WHERE dedupe_key = $1`, [key]);
    await alertRefused(day, r.error);
    return { due: true, posted: false, error: r.error };
  }
  await query(`UPDATE engine_events SET detail = detail || jsonb_build_object('ts', $1::text) WHERE dedupe_key = $2`, [r.ts, key]);
  return { due: true, posted: true, ts: r.ts };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('end of day report');
    if (busy) return;
    busy = true;
    run()
      .then((r) => { if (r.posted || r.error) console.log(`[eod-report] ${r.posted ? `posted ${r.ts}` : `not posted: ${r.error}`}`); })
      .catch((e) => console.error(`[eod-report] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  };
  setTimeout(tick, 90_000).unref();
  timer = setInterval(tick, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
