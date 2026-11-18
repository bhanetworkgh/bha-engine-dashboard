/**
 * Held pay, released on the evidence it was waiting for (18 Nov 2026, Destiny — D7 part 2; Ahad's
 * held pay sat until somebody noticed the proof had already been posted).
 *
 * Every five minutes, each new piece of evidence a builder puts on record — a change to a loop or a
 * Decision Watch (the same changes the #bha-coordination announcements read, `changeAnnounce.collect`)
 * or an evidence document saved — is checked against that builder's held pay (`payNote.held()`,
 * part by part, `heldPay.itemFor`). A model (Haiku, Anthropic first, OpenRouter second, as the intent
 * check calls it) is asked, per held part, whether this evidence is what the part waits for. It is
 * told to say no when unsure, and only a yes with high confidence goes further.
 *
 * A match posts ONE draft release card as Bays in #bha-pay-reviews (payCard.PAY_CHANNEL): the
 * builder, the log, the part, the share and its amount at the day rate in force on the log's date,
 * the evidence and the model's reason, with Release and Not yet buttons (the approval card's own two
 * action ids, value HPR-<claim id>, so n8n's Front Door forwards a click unchanged). Only Destiny or
 * Jason can press them. Release calls `payNote.release` with the evidence as the proof link, for that
 * part's share only; Not yet changes nothing. NOTHING IS PAID WITHOUT THE CLICK.
 *
 * One card per held part: the card is claimed by an engine event keyed on the log and the part
 * before it goes to Slack, and a post Slack refuses gives the claim back. Each piece of evidence is
 * checked once (a `held_pay_checked` event keyed on it), so the model is not asked again every pass.
 * Nothing older than the first pass after deploy (meta held_pay_watch.since) is read.
 */
import { query } from './pg';
import { getMeta, setMetaIfAbsent } from './db';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';
import * as changeAnnounce from './changeAnnounce';
import * as payNote from './payNote';
import * as heldPay from './heldPay';
import { PAY_CHANNEL, usd, pct, rateFor } from './payCard';

export const RULE = {
  every_minutes: 5,
  min_confidence: 'high',
  evidence_chars: 1500,
  lookback_hours: 6,
} as const;

export const PREFIX = 'HPR-';
export const isCardId = (id: string): boolean => /^HPR-\d+$/.test(id);
const ACTION_YES = 'engine_approval_approve';
const ACTION_NO = 'engine_approval_deny';
const MODEL_TIMEOUT_MS = 25_000;
const DASHBOARD = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Obj = Record<string, unknown>;

/** One piece of evidence a builder put on record. */
export interface Evidence {
  key: string; // the dedupe key it is checked under, once
  builders: string[]; // Slack ids whose held pay it may speak for
  source: string; // "loop LOOP-…", "decision watch DW-…", "evidence EV-…"
  text: string;
  link: string; // https, used as the release's proof link
  at: string;
}

export interface Match {
  submission_id: string;
  codex_entry_id: string | null;
  part: string;
  share: number;
  needs: string;
  met: boolean;
  confidence: 'high' | 'medium' | 'low';
  why: string;
}

const checkedKey = (k: string) => `held_pay_watch:checked:${k}`;
const cardKey = (submission: string, part: string) => `held_pay_watch:card:${submission}:${part.toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`;

/** A changeAnnounce item as evidence. Its key is its first change key, so one action is checked once. */
export function fromItem(i: changeAnnounce.Item): Evidence {
  const builders = [...new Set([i.author, i.owner_id].filter((x): x is string => !!x))];
  return {
    key: `item:${i.keys.join(',')}`,
    builders,
    source: `${i.record === 'loop' ? 'loop' : 'decision watch'} ${i.id}`,
    // The note itself first: a long loop title must never push the proof out of the card (18 Nov 2026).
    text: clip([`${i.why}`, `What changed: ${i.changes.join('; ')}`, `${i.record === 'loop' ? 'Loop' : 'Decision watch'} ${i.id}: ${clip(i.title, 200)}`, `Where it stands: ${i.stands}`].join('\n'), RULE.evidence_chars),
    link: i.link,
    at: i.at,
  };
}

const SYSTEM = [
  'You decide whether a piece of evidence a builder just put on record is the proof a held part of their pay was waiting for.',
  'Each held part names what it waits for. Say met: true only when the evidence plainly shows that exact thing was done (the same work, the same live event or artefact), not related work, not a plan, not a promise.',
  'When unsure, say met: false. Confidence high only when the evidence names the thing outright.',
  'Answer with JSON only: {"parts":[{"index":<number>,"met":true|false,"confidence":"high"|"medium"|"low","why":"<one sentence>"}]}, one entry per held part, in order.',
].join('\n');

export function prompt(e: Evidence, parts: { log: string; what: string; needs: string }[]): string {
  return [
    `The evidence (${e.source}):`,
    e.text,
    '',
    'The held parts:',
    ...parts.map((p, n) => `${n}. On log ${p.log}: "${p.what}" waits for: ${p.needs}`),
  ].join('\n');
}

export function parse(text: string, count: number): { met: boolean; confidence: 'high' | 'medium' | 'low'; why: string }[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Obj;
  try {
    j = JSON.parse(m[0]) as Obj;
  } catch {
    return null;
  }
  if (!Array.isArray(j.parts)) return null;
  const out = Array.from({ length: count }, () => ({ met: false, confidence: 'low' as 'high' | 'medium' | 'low', why: '' }));
  for (const p of j.parts as Obj[]) {
    const n = Number(p.index);
    if (!Number.isInteger(n) || n < 0 || n >= count) continue;
    const c = p.confidence === 'high' || p.confidence === 'medium' ? p.confidence : 'low';
    out[n] = { met: p.met === true, confidence: c, why: typeof p.why === 'string' ? clip(p.why.trim(), 300) : '' };
  }
  return out;
}

export type Asker = (system: string, user: string) => Promise<string>;

async function askModel(system: string, user: string): Promise<string> {
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
        headers: anthropic ? { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'X-Title': 'BHA Engine Dashboard - held pay watch' },
        body: JSON.stringify(
          anthropic
            ? { model: 'claude-haiku-5-5', max_tokens: 800, system, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-haiku-5.5', max_tokens: 800, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Obj;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}`);
      return anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
    } catch (e) {
      errors.push(`${r.provider}: ${e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`no model answered: ${errors.join('; ')}`);
}

/** The held parts of one builder, as the model is shown them. */
export function partsFor(notes: payNote.PayNote[], builder: string): { note: payNote.PayNote; part: heldPay.HeldPart; log: string }[] {
  return notes
    .filter((n) => n.builder_slack_id === builder && n.held_share > 0)
    .flatMap((n) => heldPay.itemFor(n).parts.map((part) => ({ note: n, part, log: n.codex_entry_id ?? n.submission_id })));
}

/** Matches for one piece of evidence: only a met part with high confidence. */
export async function judge(e: Evidence, notes: payNote.PayNote[], ask: Asker = askModel): Promise<Match[]> {
  const out: Match[] = [];
  for (const b of e.builders) {
    const parts = partsFor(notes, b);
    if (!parts.length) continue;
    const text = await ask(SYSTEM, prompt(e, parts.map((p) => ({ log: p.log, what: p.part.what, needs: p.part.needs }))));
    const verdicts = parse(text, parts.length);
    if (!verdicts) throw new Error(`the model's answer was not the JSON asked for: ${clip(text, 160)}`);
    verdicts.forEach((v, n) => {
      if (!v.met || v.confidence !== RULE.min_confidence) return;
      const p = parts[n];
      out.push({ submission_id: p.note.submission_id, codex_entry_id: p.note.codex_entry_id, part: p.part.what, share: p.part.share, needs: p.part.needs, met: true, confidence: v.confidence, why: v.why });
    });
  }
  return out;
}

/** Evidence documents saved since the window opened, by builders. */
async function savedEvidence(since: string, until: string): Promise<Evidence[]> {
  const r = await query<{ id: string; at: string; detail: Obj; actor: string | null; text: string | null; proves: string | null; title: string | null; author_id: string | null; test: boolean | null }>(
    `SELECT e.id::text, to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, e.detail, e.actor,
            left(v.text, 1200) AS text, v.proves, v.title, v.author_id, v.test
       FROM engine_events e LEFT JOIN engine_evidence v ON v.evidence_id = e.subject_id
      WHERE e.event_type = 'evidence_saved' AND e.at > $1::timestamptz AND e.at <= $2::timestamptz ORDER BY e.at`,
    [since, until],
  );
  return r.rows
    .filter((x) => !x.test)
    .map((x) => {
      const id = String(x.detail?.evidence_id ?? '');
      return {
        key: `evidence:${id}`,
        builders: [...new Set([x.author_id, x.actor].filter((y): y is string => !!y && /^[UW][A-Z0-9]{6,}$/.test(y)))],
        source: `evidence ${id}`,
        text: clip([`Evidence ${id}: ${x.title ?? ''}`, x.proves ? `What it proves: ${x.proves}` : '', x.text ?? ''].filter(Boolean).join('\n'), RULE.evidence_chars),
        link: `${DASHBOARD()}/evidence?doc=${encodeURIComponent(id)}`,
        at: x.at,
      };
    });
}

async function heldKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await query<{ k: string }>(`SELECT dedupe_key AS k FROM engine_events WHERE dedupe_key = ANY($1::text[])`, [keys.map(checkedKey)]);
  return new Set(r.rows.map((x) => x.k));
}

/** Everything waiting to be checked, oldest first. */
export async function pending(now = new Date()): Promise<Evidence[]> {
  // The change items are read under this watch's own claims, never the announcements'.
  const items = await changeAnnounce.collect(now, 'held_pay_watch.since', async (keys) => {
    // collect asks per change key; an item is held when its whole evidence key was checked.
    void keys;
    return new Set();
  });
  const since = (await getMeta('held_pay_watch.since')) ?? now.toISOString();
  const floor = new Date(Math.max(new Date(since).getTime(), now.getTime() - RULE.lookback_hours * 3_600_000)).toISOString();
  const until = new Date(now.getTime() - 60_000).toISOString();
  const all = [...items.map(fromItem), ...(await savedEvidence(floor, until))].filter((e) => e.builders.length);
  const done = await heldKeys(all.map((e) => e.key));
  return all.filter((e) => !done.has(checkedKey(e.key))).sort((a, b) => a.at.localeCompare(b.at));
}

export interface CardInput {
  match: Match;
  builder: string;
  builderName: string;
  rate: number | null;
  rateFrom: string | null;
  evidence: Evidence;
}

export function cardBlocks(c: CardInput, cardId: string | null, decided?: { by: string; at: string; released: boolean; message: string }): { text: string; blocks: Obj[] } {
  const amount = c.rate === null ? null : c.match.share * c.rate;
  const log = c.match.codex_entry_id ?? c.match.submission_id;
  const head = decided ? (decided.released ? 'Held pay released' : 'Held pay not released') : 'Held pay ready to release';
  const amountText = amount === null ? `${pct(c.match.share)} of a day (no day rate on record for that date)` : `${usd(amount)} (${pct(c.match.share)} of a day at ${usd(c.rate as number)} a day${c.rateFrom ? `, from ${c.rateFrom}` : ''})`;
  const text = `${head}: ${c.builderName}, ${log}, ${amountText}`;
  const blocks: Obj[] = [
    { type: 'header', text: { type: 'plain_text', text: head } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Builder*\n<@${c.builder}>` },
        { type: 'mrkdwn', text: `*Log*\n<${DASHBOARD()}/codex/${encodeURIComponent(log)}|${log}>` },
        { type: 'mrkdwn', text: `*Held part*\n${clip(c.match.part, 300)}` },
        { type: 'mrkdwn', text: `*To release*\n${amountText}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*It was waiting for*\n${clip(c.match.needs, 600)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*The evidence*\n<${c.evidence.link}|${c.evidence.source}>\n>${clip(c.evidence.text.split('\n')[0] || '', 900)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Why it matches*\n${c.match.why || 'not given'}` } },
  ];
  if (decided) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${decided.released ? 'Released' : 'Not released'} by <@${decided.by}> on ${decided.at.slice(0, 16).replace('T', ' ')} UTC. ${clip(decided.message, 300)}` }] });
  } else if (cardId) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Nothing is paid until Jason or Destiny presses Release.' }] });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: ACTION_YES, style: 'primary', text: { type: 'plain_text', text: 'Release' }, value: cardId },
        { type: 'button', action_id: ACTION_NO, text: { type: 'plain_text', text: 'Not yet' }, value: cardId },
      ],
    });
  }
  return { text, blocks };
}

export interface PassResult {
  checked: number;
  matches: number;
  posted: number;
  already: number;
  failed: { key: string; error: string }[];
  dry_run: boolean;
  cards: { submission_id: string; part: string; amount: string; evidence: string }[];
}

type Poster = (channel: string, text: string, blocks: Obj[]) => Promise<{ ok: boolean; ts?: string; error?: string }>;
const slackPost: Poster = async (channel, text, blocks) => {
  const r = await slack.botCall('chat.postMessage', { channel, text, blocks, unfurl_links: false });
  return { ok: r.ok === true, ts: typeof r.ts === 'string' ? r.ts : undefined, error: r.ok ? undefined : String(r.error) };
};

async function nameOf(id: string): Promise<string> {
  if (payNote.DECIDERS[id]) return payNote.DECIDERS[id];
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1`, [id]);
  return r.rows[0]?.name || id;
}

export async function pass(opts: { now?: Date; dry_run?: boolean; post?: Poster; ask?: Asker } = {}): Promise<PassResult> {
  const now = opts.now ?? new Date();
  if (!opts.dry_run) await setMetaIfAbsent('held_pay_watch.since', now.toISOString());
  const out: PassResult = { checked: 0, matches: 0, posted: 0, already: 0, failed: [], dry_run: !!opts.dry_run, cards: [] };
  const evidence = await pending(now);
  if (!evidence.length) return out;
  const notes = await payNote.held();
  for (const e of evidence) {
    if (!e.builders.some((b) => notes.some((n) => n.builder_slack_id === b))) {
      if (!opts.dry_run) await record({ event_type: 'held_pay_checked', subject_id: e.source, lane: 'BAYS', actor: 'held-pay-watch', detail: { matches: 0, reason: 'no held pay' }, dedupe_key: checkedKey(e.key) });
      continue;
    }
    let matches: Match[];
    try {
      matches = await judge(e, notes, opts.ask ?? askModel);
    } catch (err) {
      // Not marked checked: the next pass asks again.
      out.failed.push({ key: e.key, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    out.checked++;
    out.matches += matches.length;
    for (const m of matches) {
      const note = notes.find((n) => n.submission_id === m.submission_id);
      const builder = note?.builder_slack_id ?? e.builders[0];
      const date = note ? heldPay.logDate(note) : null;
      const rate = await rateFor({ query } as never, builder, date);
      const input: CardInput = { match: m, builder, builderName: await nameOf(builder), rate: rate?.day_rate_usd ?? null, rateFrom: rate?.effective_from ?? null, evidence: e };
      const amount = rate ? usd(m.share * rate.day_rate_usd) : `${pct(m.share)} of a day`;
      out.cards.push({ submission_id: m.submission_id, part: m.part, amount, evidence: e.source });
      if (opts.dry_run) continue;
      const claim = await record({
        event_type: 'held_pay_release_proposed',
        subject_id: m.codex_entry_id ?? m.submission_id,
        lane: 'BAYS',
        actor: 'held-pay-watch',
        detail: { submission_id: m.submission_id, codex_entry_id: m.codex_entry_id, part: m.part, share: m.share, needs: m.needs, why: m.why, builder, evidence: { source: e.source, link: e.link, text: e.text }, rate: input.rate, rate_from: input.rateFrom, channel: PAY_CHANNEL },
        dedupe_key: cardKey(m.submission_id, m.part),
      });
      if (!claim.recorded || !claim.id) { out.already++; continue; }
      const cardId = `${PREFIX}${claim.id}`;
      const c = cardBlocks(input, cardId);
      const r = await (opts.post ?? slackPost)(PAY_CHANNEL, c.text, c.blocks);
      if (!r.ok) {
        await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
        out.failed.push({ key: e.key, error: `Slack refused the card: ${r.error}` });
        continue;
      }
      await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ ts: r.ts, card_id: cardId })]);
      out.posted++;
    }
    await record({ event_type: 'held_pay_checked', subject_id: e.source, lane: 'BAYS', actor: 'held-pay-watch', detail: { matches: matches.length, builders: e.builders }, dedupe_key: checkedKey(e.key) });
  }
  return out;
}

/** A stored card's claim, back into the card's input. */
async function inputFrom(d: Obj): Promise<CardInput> {
  const ev = d.evidence as Obj;
  return {
    match: { submission_id: String(d.submission_id), codex_entry_id: (d.codex_entry_id as string) ?? null, part: String(d.part), share: Number(d.share), needs: String(d.needs ?? ''), met: true, confidence: 'high', why: String(d.why ?? '') },
    builder: String(d.builder),
    builderName: await nameOf(String(d.builder)),
    rate: d.rate === null || d.rate === undefined ? null : Number(d.rate),
    rateFrom: (d.rate_from as string) ?? null,
    evidence: { key: '', builders: [], source: String(ev?.source ?? ''), text: String(ev?.text ?? ''), link: String(ev?.link ?? ''), at: '' },
  };
}

/**
 * The first card (HPR-145469, 18 Nov 2026) was posted before the evidence line put the note first.
 * Once, while it is still undecided, it is redrawn with the note leading, buttons kept.
 */
export async function restyleFirstCard(): Promise<string> {
  const id = 145469;
  const flag = 'held_pay_watch.restyled.145469';
  if (await getMeta(flag)) return 'already done';
  const r = await query<{ detail: Obj }>(`SELECT detail FROM engine_events WHERE id = $1 AND event_type = 'held_pay_release_proposed'`, [id]);
  const d = r.rows[0]?.detail;
  if (!d || typeof d.ts !== 'string') return 'no card';
  if (d.decided) return 'already decided, left as it is';
  const ev = { ...(d.evidence as Obj) };
  const lines = String(ev.text ?? '').split('\n');
  const why = lines.find((l) => l.startsWith('Why: '));
  if (why) ev.text = [why.slice(5), ...lines.filter((l) => l !== why)].join('\n');
  const c = cardBlocks(await inputFrom({ ...d, evidence: ev }), `${PREFIX}${id}`);
  const u = await slack.botCall('chat.update', { channel: String(d.channel ?? PAY_CHANNEL), ts: d.ts, text: c.text, blocks: c.blocks });
  if (!u.ok) return `Slack refused the update: ${String(u.error)}`;
  await setMetaIfAbsent(flag, new Date().toISOString());
  return 'redrawn';
}

/** A click on a release card. Only Destiny or Jason; once only. */
export async function decide(input: { id: string; decision: 'approve' | 'deny'; user_id: string }): Promise<{ status: number; body: Obj }> {
  const id = Number(input.id.slice(PREFIX.length));
  const r = await query<{ detail: Obj }>(`SELECT detail FROM engine_events WHERE id = $1 AND event_type = 'held_pay_release_proposed'`, [id]);
  const d = r.rows[0]?.detail;
  if (!d) return { status: 404, body: { ok: false, reason: 'not_found', raise: false, message: `No held pay release card ${input.id}.` } };
  const channel = String(d.channel ?? PAY_CHANNEL);
  const tell = async (text: string) => {
    const t = await slack.botCall('chat.postEphemeral', { channel, user: input.user_id, text });
    if (!t.ok) console.error(`[held-pay-watch] could not tell ${input.user_id}: ${String(t.error)}`);
  };
  if (!payNote.DECIDERS[input.user_id]) {
    await tell('Only Jason or Destiny can release held pay. Nothing was changed.');
    return { status: 200, body: { ok: false, reason: 'not_allowed', raise: false, message: `${input.user_id} may not release pay. Nothing was changed.` } };
  }
  // The claim: one decision per card, whoever clicks first.
  const claimed = await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1 AND NOT (detail ? 'decided') RETURNING id`, [id, JSON.stringify({ decided: { by: input.user_id, at: new Date().toISOString(), decision: input.decision } })]);
  if (!claimed.rows.length) {
    await tell('This card was already decided. Nothing was changed.');
    return { status: 200, body: { ok: false, reason: 'already_decided', raise: false, message: 'Already decided. Nothing was changed.' } };
  }
  let released = false;
  let message = 'Left held. Nothing was paid.';
  let raise = false;
  if (input.decision === 'approve') {
    try {
      const res = await payNote.release({ submission_id: d.submission_id, released_by: input.user_id, proof_link: (d.evidence as Obj)?.link, share: d.share, parts: [d.part], via: 'held_pay_card', note: `Released from the held pay card ${input.id}: ${String(d.why ?? '')}` });
      released = true;
      message = res.message;
    } catch (e) {
      message = `The release was refused: ${e instanceof Error ? e.message : String(e)}`;
      raise = true;
      await query(`UPDATE engine_events SET detail = detail - 'decided' WHERE id = $1`, [id]);
    }
  }
  await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [id, JSON.stringify({ outcome: { released, message } })]);
  await record({ event_type: released ? 'held_pay_release_card_released' : input.decision === 'deny' ? 'held_pay_release_card_declined' : 'held_pay_release_card_failed', subject_id: String(d.codex_entry_id ?? d.submission_id), lane: 'BAYS', actor: input.user_id, detail: { card_id: input.id, part: d.part, share: d.share, message } });
  if (typeof d.ts === 'string' && !raise) {
    const c = cardBlocks(await inputFrom(d), null, { by: input.user_id, at: new Date().toISOString(), released, message });
    const u = await slack.botCall('chat.update', { channel, ts: d.ts, text: c.text, blocks: c.blocks });
    if (!u.ok) console.error(`[held-pay-watch] card ${input.id} not updated: ${String(u.error)}`);
  }
  if (raise) await tell(message);
  return { status: 200, body: { ok: !raise, done: !raise, released, raise, message } };
}

export function startSweeping(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    timers.beat('held pay watch');
    try {
      const r = await pass();
      if (r.posted || r.failed.length) console.log(`[held-pay-watch] checked ${r.checked}, cards ${r.posted}, failed ${r.failed.length}${r.failed.length ? `: ${r.failed[0].error}` : ''}`);
    } catch (e) {
      console.error(`[held-pay-watch] pass failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 45_000).unref?.();
  setTimeout(() => {
    restyleFirstCard()
      .then((r) => console.log(`[held-pay-watch] first card restyle: ${r}`))
      .catch((e) => console.error(`[held-pay-watch] first card restyle failed: ${e instanceof Error ? e.message : String(e)}`));
  }, 25_000).unref?.();
  setInterval(() => void tick(), RULE.every_minutes * 60_000).unref?.();
}
