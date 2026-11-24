/**
 * Blocker alerts (24 Nov 2026, Destiny): twice a week, Monday and Friday, every person the blockers page says a
 * loop is waiting on is tagged once in #bha-coordination by Genie, with each loop, who is waiting and the unblock
 * date, and asked why it is held and when they can clear it. Monday and Friday leave the start and the end of a
 * week, and the weekend, to sort things out between rounds.
 *
 * Who is being waited on is read from the loop's own "Blocked By" (incomeBoard.blockers): each "Name: what is
 * needed" clause, split on ";", names the person before the colon. A clause that names nobody on Builder Profiles
 * (a vendor, a part arriving, "none named") tags nobody. Former builders are never tagged. Jason is tagged like
 * anyone else: he asked to be lit up when he is the hold-up.
 *
 * A reply from that person in the post's thread is written onto every loop in the post, as a decision_log line,
 * once per reply. Each post is claimed by one engine event per person per day before it goes to Slack, and the
 * claim is given back if Slack refuses, so a round is never posted twice and never silently skipped.
 */
import { query } from './pg';
import { record } from './engineEvents';
import { postAsGenie } from './genieSlack';
import { readSince } from './decisionWatch';
import { patchRecord } from './engineWrite';
import { blockers, type BlockedLoop } from './incomeBoard';
import { FORMER_BUILDERS } from './sources';
import * as timers from './timers';

export const RULE = {
  /** UTC days: 1 Monday, 5 Friday. */
  days: [1, 5],
  /** From 14:00 UTC: 15:00 Lagos, 19:30 India, 09:00 New York, so every timezone is awake. */
  hour_utc: 14,
  every_minutes: 15,
  max_loops_per_post: 10,
  /** Replies are read and written onto the loops for this long after a post. */
  reply_window_days: 4,
} as const;

const CHANNEL = () => process.env.BLOCKER_ALERT_CHANNEL || 'C0ASMPYQLG3'; // #bha-coordination
const BLOCKERS_PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}/income-board?tab=blockers`;

export type Person = { id: string; name: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NAME_LIST = /^[A-Z][\w'-]*( [A-Z][\w'-]*)?((, | and | or )[A-Z][\w'-]*( [A-Z][\w'-]*)?)*$/;

/**
 * The part of one clause that says who it waits on. "Name: what" names whoever is before the colon. With no
 * colon, the words before the first "(" name the person ("Jason Bays (authorized reviewer)"), and so does a
 * bracket holding only names ("Sample video approval (Jason)"), never a bracket of prose ("(Hardik's email)"). Pure.
 */
export function whoPart(clause: string): { who: string; what: string } {
  const c = clause.trim();
  const colon = c.indexOf(':');
  if (colon >= 0) return { who: c.slice(0, colon), what: c.slice(colon + 1).trim() };
  const open = c.indexOf('(');
  const head = open >= 0 ? c.slice(0, open) : c;
  const paren = open >= 0 ? (c.slice(open + 1).match(/^([^)]*)\)/)?.[1] ?? '') : '';
  return { who: NAME_LIST.test(paren.trim()) ? `${head} ${paren}` : head, what: c };
}

const names = (p: Person) => [p.name, p.name.split(/\s+/)[0]].filter((n) => n.length > 2);
const named = (p: Person, who: string) => names(p).some((n) => new RegExp(`\\b${esc(n)}\\b`, 'i').test(who));

/** The people a "Blocked By" text is waiting on, one ";" clause at a time. Pure. */
export function blockersNamed(blockedBy: string, people: Person[]): Person[] {
  const out = new Map<string, Person>();
  for (const clause of String(blockedBy ?? '').split(';')) {
    const { who } = whoPart(clause);
    for (const p of people) if (named(p, who)) out.set(p.id, p);
  }
  return [...out.values()];
}

/** The loops each person is holding up, longest late first. Pure. */
export function byBlocker(rows: BlockedLoop[], people: Person[]): Map<string, { person: Person; loops: BlockedLoop[] }> {
  const out = new Map<string, { person: Person; loops: BlockedLoop[] }>();
  for (const row of rows) {
    for (const p of blockersNamed(row.blocked_by, people)) {
      const slot = out.get(p.id) ?? { person: p, loops: [] };
      slot.loops.push(row);
      out.set(p.id, slot);
    }
  }
  for (const slot of out.values()) slot.loops.sort((a, b) => (b.days_late ?? -1) - (a.days_late ?? -1) || (a.unblock_date ?? '9999').localeCompare(b.unblock_date ?? '9999'));
  return out;
}

const cut = (s: string | null | undefined, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The clauses of "Blocked By" that name this person. Pure. */
export function whatIsNeeded(blockedBy: string, person: Person): string {
  const mine = String(blockedBy).split(';').map((c) => whoPart(c)).filter((w) => named(person, w.who));
  return mine.map((w) => w.what).join('; ') || blockedBy;
}

/** The post for one person. Pure. */
export function postText(person: Person, loops: BlockedLoop[]): string {
  const shown = loops.slice(0, RULE.max_loops_per_post);
  const lines = shown.map((l) => {
    const id = l.loop_id.slice(-4);
    const when = l.late ? `unblock date ${l.unblock_date}, ${l.days_late} day${l.days_late === 1 ? '' : 's'} late` : l.unblock_date ? `unblock date ${l.unblock_date}` : 'no unblock date set';
    return `• <${l.link}|${id}> ${cut(l.title, 90)}\n   Waiting on you for: ${cut(whatIsNeeded(l.blocked_by, person), 160)}. Owner: ${l.owner ?? 'not set'}, ${when}.`;
  });
  const more = loops.length > shown.length ? `\n…and ${loops.length - shown.length} more on the <${BLOCKERS_PAGE}|blockers page>.` : '';
  return `<@${person.id}> ${loops.length === 1 ? 'this loop is' : `these ${loops.length} loops are`} waiting on you. Please reply in this thread with why ${loops.length === 1 ? "it's" : "each is"} held and when you can clear it:\n\n${lines.join('\n')}${more}`;
}

/** Monday or Friday from 14:00 UTC. Pure. */
export function isDue(now: Date): boolean {
  return (RULE.days as readonly number[]).includes(now.getUTCDay()) && now.getUTCHours() >= RULE.hour_utc;
}

async function people(): Promise<Person[]> {
  const r = await query<{ id: string; name: string }>(`SELECT fields->>'user_id' AS id, fields->>'name' AS name FROM engine_builder_profiles WHERE coalesce(fields->>'user_id','') <> ''`);
  return r.rows.filter((p) => p.name && !FORMER_BUILDERS.includes(p.id)).map((p) => ({ id: p.id, name: p.name }));
}

/** One round: a post per person being waited on, once per day. */
export async function round(now = new Date(), opts: { force?: boolean } = {}): Promise<{ due: boolean; posted: number; skipped: number; failed: string[] }> {
  if (!opts.force && !isDue(now)) return { due: false, posted: 0, skipped: 0, failed: [] };
  const day = now.toISOString().slice(0, 10);
  const grouped = byBlocker((await blockers(now)).rows, await people());
  let posted = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const { person, loops } of grouped.values()) {
    const key = `blocker_alert:${person.id}:${day}`;
    const claim = await record({ event_type: 'blocker_alert_sent', subject_id: person.id, lane: 'ENGINE', actor: 'blocker-alerts', detail: { name: person.name, loops: loops.map((l) => l.loop_id), channel: CHANNEL() }, dedupe_key: key });
    if (!claim.recorded) { skipped++; continue; }
    const r = await postAsGenie(CHANNEL(), postText(person, loops), [], undefined, { guarded: true });
    if (!r.ok) {
      await query(`DELETE FROM engine_events WHERE dedupe_key = $1`, [key]);
      failed.push(`${person.name}: ${r.error}`);
      continue;
    }
    await query(`UPDATE engine_events SET detail = detail || jsonb_build_object('ts', $1::text) WHERE dedupe_key = $2`, [r.ts, key]);
    posted++;
  }
  return { due: true, posted, skipped, failed };
}

/** Replies from the person tagged, written onto each loop in their post. */
export async function sweepReplies(now = new Date()): Promise<{ written: number; errors: string[] }> {
  const r = await query<{ subject_id: string; detail: { name?: string; loops?: string[]; channel?: string; ts?: string } }>(
    `SELECT subject_id, detail FROM engine_events WHERE event_type = 'blocker_alert_sent' AND at > $1 AND detail ? 'ts'`,
    [new Date(now.getTime() - RULE.reply_window_days * 86_400_000).toISOString()],
  );
  let written = 0;
  const errors: string[] = [];
  for (const ev of r.rows) {
    const { ts, channel, loops = [], name = 'someone' } = ev.detail;
    if (!ts || !channel || !loops.length) continue;
    const read = await readSince(channel, ts, ts);
    if (!read.ok) { errors.push(read.error); continue; }
    for (const m of read.messages) {
      if (!m.ts || m.ts === ts || m.bot_id || m.user !== ev.subject_id || !m.text?.trim()) continue;
      const claim = await record({ event_type: 'blocker_reply_recorded', subject_id: ev.subject_id, lane: 'ENGINE', actor: 'blocker-alerts', detail: { reply_ts: m.ts, loops }, dedupe_key: `blocker_reply:${ev.subject_id}:${m.ts}` });
      if (!claim.recorded) continue;
      const date = new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 10);
      const line = `${date} (${name}, blocker reply in #bha-coordination): ${cut(m.text, 1200)}`;
      for (const loopId of loops) {
        const row = (await query<{ id: string; fields: Record<string, unknown> }>(`SELECT id, fields FROM engine_loops WHERE natural_id = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`, [loopId])).rows[0];
        if (!row) continue;
        const log = Array.isArray(row.fields.decision_log) ? (row.fields.decision_log as unknown[]) : row.fields.decision_log ? [row.fields.decision_log] : [];
        try {
          await patchRecord('loops', row.id, { decision_log: [...log, line] }, { endpoint: 'blocker-alerts', method: 'PATCH', key_label: 'blocker alerts', t0: Date.now() }, loopId);
          written++;
        } catch (e) {
          errors.push(`${loopId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return { written, errors };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('blocker alerts');
    if (busy) return;
    busy = true;
    round()
      .then((r) => { if (r.posted || r.failed.length) console.log(`[blocker-alerts] round: ${r.posted} posted, ${r.skipped} already posted today${r.failed.length ? `, refused: ${r.failed.join('; ')}` : ''}`); })
      .then(() => sweepReplies())
      .then((s) => { if (s.written || s.errors.length) console.log(`[blocker-alerts] replies: ${s.written} loop notes written${s.errors.length ? `, errors: ${s.errors.slice(0, 3).join('; ')}` : ''}`); })
      .catch((e) => console.error(`[blocker-alerts] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
