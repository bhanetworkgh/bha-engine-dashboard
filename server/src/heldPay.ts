/**
 * /held-pay (15 Nov 2026, Destiny): a builder types /held-pay in Slack and sees, only to them, every log
 * with pay still held, why, and what proof releases it. Read from the pay notes (payNote.held), the one
 * place held pay is kept, so the command and the Held tab cannot disagree. Shares of a day, never money.
 *
 * Destiny or Jason may name someone (/held-pay ahad) or ask for everyone (/held-pay all). Anyone else
 * sees only their own: a name from them is answered with their own list and a line saying so.
 * Reads only; writes nothing.
 */
import { query } from './pg';
import * as payNote from './payNote';
import { heldParts, logLink, pct } from './paySuggest';

type Obj = Record<string, unknown>;

/** Slack text stays under this, so the reply is never refused for length. */
export const MAX_CHARS = 3800;

export class HeldPayError extends Error {
  constructor(public reason: string, message: string, public status = 422) {
    super(message);
  }
}

const dashboard = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The log's own date from its Submission ID (<slack id>_<ms>), else when the note was decided. Pure. */
export function logDate(n: { submission_id: string; decided_at: string }): string {
  const ms = Number(String(n.submission_id).split('_').pop());
  const d = Number.isFinite(ms) && ms > 1_600_000_000_000 ? new Date(ms) : new Date(n.decided_at);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
function shortDate(iso: string): string {
  if (!iso) return 'date not recorded';
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}
const oneLine = (t: unknown, n: number) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

export interface HeldPart {
  what: string;
  held_for: string;
  share: number;
  needs: string;
}
export interface HeldItem {
  submission_id: string;
  codex_entry_id: string | null;
  log_date: string;
  held_share: number;
  link: string;
  parts: HeldPart[];
}

/** One pay note's held parts, each with what releases it. Pure. */
export function itemFor(n: payNote.PayNote): HeldItem {
  const all = Array.isArray(n.suggested?.parts) ? (n.suggested!.parts as Obj[]) : [];
  const parts = heldParts({
    submission_id: n.submission_id,
    codex_entry_id: n.codex_entry_id,
    held_share: n.held_share,
    release_condition: n.release_condition,
    reason_tag: n.reason_tag,
    suggested: n.suggested,
    released_parts: n.released_parts ?? [],
  }).map((p) => {
    const src = all.find((x) => String(x.what ?? '').toLowerCase() === p.what.toLowerCase());
    const missing = Array.isArray(src?.missing) ? (src!.missing as unknown[]).map(String).filter(Boolean) : [];
    const needs = missing.length
      ? missing.join('; ')
      : src
        ? String(src.silent_failure || '') || 'the proof named in a later log'
        : n.release_condition || 'the proof named in a later log';
    return { what: p.what, held_for: p.held_for, share: p.share, needs };
  });
  return { submission_id: n.submission_id, codex_entry_id: n.codex_entry_id, log_date: logDate(n), held_share: n.held_share, link: logLink(n), parts };
}

export interface Person {
  id: string;
  name: string;
}

async function profiles(): Promise<Person[]> {
  const r = await query<Obj>(`SELECT natural_id AS id, fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id IS NOT NULL`);
  return r.rows.map((x) => ({ id: String(x.id), name: String(x.name ?? x.id) }));
}

/** Who "/held-pay <text>" names: a mention, a Slack id, or a name word. Pure. */
export function whoIsNamed(text: string, people: Person[]): Person | 'all' | null | 'unknown' {
  const t = text.trim();
  if (!t) return null;
  if (/^(all|everyone|team)$/i.test(t)) return 'all';
  const id = (t.match(/<@([UW][A-Z0-9]+)/) ?? t.match(/^([UW][A-Z0-9]{6,})$/))?.[1];
  if (id) return people.find((p) => p.id === id) ?? { id, name: id };
  const w = t.replace(/^@/, '').toLowerCase();
  const hit = people.filter((p) => p.name.toLowerCase() === w || p.name.toLowerCase().split(/\s+/).includes(w) || p.name.toLowerCase().startsWith(w));
  return hit.length === 1 ? hit[0] : 'unknown';
}

/** The reply for one person's held pay. Pure. */
export function personText(who: Person, items: HeldItem[], self: boolean): string {
  const subject = self ? 'You have' : `${who.name} has`;
  if (!items.length) return `${self ? 'You have' : `${who.name} has`} no pay held right now.`;
  const total = r3(items.reduce((a, i) => a + i.held_share, 0));
  const head = `*Held pay${self ? '' : ` for ${who.name}`}*\n${subject} ${pct(total)} of a day held across ${items.length} log${items.length === 1 ? '' : 's'}. Each is released when a later log brings the proof below, named plainly.`;
  const foot = `\nSee every held log on the dashboard: ${dashboard()}/pay?tab=held`;
  const blocks: string[] = [];
  for (const i of items) {
    const lines = [`\n*${shortDate(i.log_date)}* · <${i.link}|${i.codex_entry_id ?? i.submission_id}> · *${pct(i.held_share)}* held`];
    for (const p of i.parts) lines.push(`• ${oneLine(p.what, 160)} (${pct(p.share)}, ${p.held_for}). Needs: ${oneLine(p.needs, 260)}`);
    blocks.push(lines.join('\n'));
  }
  let out = head;
  let shown = 0;
  for (const b of blocks) {
    if ((out + b + foot).length > MAX_CHARS - 80) break;
    out += b;
    shown++;
  }
  if (shown < blocks.length) out += `\n\n…and ${blocks.length - shown} more held log${blocks.length - shown === 1 ? '' : 's'}.`;
  return out + foot;
}

/** The reply for everyone, one line per person. Pure. */
export function allText(rows: { who: Person; items: HeldItem[] }[]): string {
  const held = rows.filter((r) => r.items.length);
  if (!held.length) return 'Nobody has pay held right now.';
  held.sort((a, b) => b.items.reduce((x, i) => x + i.held_share, 0) - a.items.reduce((x, i) => x + i.held_share, 0));
  const lines = held.map((r) => `• *${r.who.name}*: ${pct(r3(r.items.reduce((a, i) => a + i.held_share, 0)))} of a day held across ${r.items.length} log${r.items.length === 1 ? '' : 's'}`);
  return `*Held pay, everyone*\n${lines.join('\n')}\n\nType /held-pay <name> for one person's logs and what releases them, or see ${dashboard()}/pay?tab=held`;
}

export interface HeldPayAnswer {
  ok: true;
  text: string;
  target: string;
  logs: number;
  held_share: number;
  note: string | null;
}

/**
 * Answers "/held-pay <text>" for the Slack user who typed it. user_id is the person asking (from Slack's
 * own command payload, never typed); text is what followed the command.
 */
export async function answer(b: Obj): Promise<HeldPayAnswer> {
  const userId = String(b.user_id ?? '').trim();
  if (!/^[UW][A-Z0-9]{6,}$/.test(userId)) throw new HeldPayError('no_user', 'user_id (the Slack id of the person asking) is required.');
  const text = String(b.text ?? '').slice(0, 200);
  const people = await profiles();
  const me: Person = people.find((p) => p.id === userId) ?? { id: userId, name: userId };
  const admin = !!payNote.DECIDERS[userId];
  const named = whoIsNamed(text, people);
  const held = (await payNote.held()).filter((n) => n.held_share > 0);
  const itemsOf = (id: string) => held.filter((n) => n.builder_slack_id === id).map(itemFor).sort((a, b) => a.log_date.localeCompare(b.log_date));

  let note: string | null = null;
  let target: Person = me;
  if (named === 'all' && admin) {
    const ids = [...new Set(held.map((n) => n.builder_slack_id).filter((x): x is string => !!x))];
    const rows = ids.map((id) => ({ who: people.find((p) => p.id === id) ?? { id, name: held.find((n) => n.builder_slack_id === id)?.builder ?? id }, items: itemsOf(id) }));
    return { ok: true, text: allText(rows), target: 'all', logs: held.length, held_share: r3(held.reduce((a, n) => a + n.held_share, 0)), note: null };
  }
  if (named && named !== 'all' && named !== 'unknown' && named.id !== userId) {
    if (admin) target = named;
    else note = 'You can only see your own held pay, so here is yours.';
  } else if (named === 'unknown') {
    note = admin ? `Nobody matched "${oneLine(text, 40)}". Here is yours; try a first name, a mention, or "all".` : 'You can only see your own held pay, so here is yours.';
  } else if (named === 'all') {
    note = 'Only Destiny or Jason can see everyone, so here is yours.';
  }
  const items = itemsOf(target.id);
  const body = personText(target, items, target.id === userId);
  return { ok: true, text: note ? `_${note}_\n${body}` : body, target: target.id, logs: items.length, held_share: r3(items.reduce((a, i) => a + i.held_share, 0)), note };
}
