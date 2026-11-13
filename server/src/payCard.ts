/**
 * Pay figures on the pay review card (12 Nov 2026, Destiny; Jason on Destiny's 11 Nov card in
 * #bha-pay-reviews, C0C24D5PZQE 1794415513.051689: "the payout should be listed here along with showing
 * what's owed for prior day ... it should be very clear").
 *
 * The pay notes hold shares of a day. This turns them into what Jason pays, and only here:
 *
 *   Daily builders (dollars, share x the day rate in force on the session date):
 *     - this log: the share credited now, what is held and until when, what is docked;
 *     - released from earlier logs: held shares whose proof came in since the builder's last card,
 *       each at the rate of the day it was worked, with its proof link. A release is put on one
 *       card only (engine_pay_card_claims), the first card built after it, so it is never paid twice;
 *     - pay for this card: the two added up;
 *     - owed from earlier days: the builder's approved logs not yet marked paid, with what their own
 *       cards carried, and the total owed now.
 *   Monthly builders (shares only, no dollars): this log, and the month so far (credited, released,
 *     still held). They are settled once, on the statement on the 1st.
 *
 * Rates live in engine_pay_rates, one row per builder per start date, append-only, so a rate change is
 * a new row and every past day keeps the rate it was worked at. A builder with no rate on record gets
 * shares and a line saying so, never a guessed figure. A log with no pay note counts as a full day,
 * the rule the pay notes already use. Read only, except the release claims.
 */
import { query, withTransaction, type Queryable } from './pg';
import * as payNote from './payNote';
import * as slack from './slack';
import { FeedError } from './systemFeeds';

type Obj = Record<string, unknown>;
type Block = Obj & { type?: string; block_id?: string; text?: { type?: string; text?: string }; fields?: Obj[]; elements?: Obj[] };

export const PAY_CHANNEL = 'C0C24D5PZQE';
const FIG = 'pay_fig_';
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const usd = (n: number): string => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
const cap = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const day = (d: string | null): string => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no date');
const s = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));

export class PayCardError extends FeedError {
  constructor(public reason: string, message: string, status = 422) {
    super(status, message);
  }
}

export interface Rate {
  day_rate_usd: number;
  effective_from: string;
}

/** The day rate in force for a builder on a date (YYYY-MM-DD), or null when none is on record. */
export async function rateFor(db: Queryable, builder: string, date: string | null): Promise<Rate | null> {
  const r = await db.query<{ day_rate_usd: string; effective_from: string }>(
    `SELECT day_rate_usd::text, to_char(effective_from, 'YYYY-MM-DD') AS effective_from FROM engine_pay_rates
      WHERE builder_slack_id = $1 AND effective_from <= coalesce($2::date, current_date) ORDER BY effective_from DESC LIMIT 1`,
    [builder, date ? date.slice(0, 10) : null],
  );
  return r.rows[0] ? { day_rate_usd: Number(r.rows[0].day_rate_usd), effective_from: r.rows[0].effective_from } : null;
}

export interface Release {
  history_id: number;
  codex_entry_id: string;
  session_date: string | null;
  share: number;
  rate: Rate | null;
  usd: number | null;
  proof_link: string | null;
  released_at: string;
}

export interface Earlier {
  codex_entry_id: string;
  session_date: string | null;
  credited: number;
  note_found: boolean;
  rate: Rate | null;
  credited_usd: number | null;
  releases_usd: number;
  total_usd: number | null;
}

export interface Figures {
  submission_id: string;
  codex_entry_id: string | null;
  builder_slack_id: string;
  builder: string;
  pay_mode: 'Daily' | 'Monthly';
  session_date: string | null;
  rate: Rate | null;
  today: { note_found: boolean; recommendation: string; credited: number; held: number; docked: number; reason_tag: string | null; release_condition: string | null; credited_usd: number | null; held_usd: number | null; docked_usd: number | null };
  releases: Release[];
  pay_now_usd: number | null;
  earlier: Earlier[];
  earlier_total_usd: number | null;
  owed_total_usd: number | null;
  still_held: { codex_entry_id: string; session_date: string | null; share: number; usd: number | null; condition: string | null }[];
  month: { month: string; credited_shares: number; released_shares: number; held_shares: number; sessions: number } | null;
  missing_rates: string[];
}

interface LogRow {
  submission_id: string;
  codex_entry_id: string | null;
  builder_slack_id: string;
  builder: string;
  session_date: string | null;
}

async function findLog(db: Queryable, submissionId: string): Promise<LogRow> {
  const r = await db.query<{ fields: Obj }>(`SELECT fields FROM engine_codex_submissions WHERE fields->>'Submission ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [submissionId]);
  const f = r.rows[0]?.fields;
  if (!f) throw new PayCardError('log_not_found', `No log carries Submission ID ${submissionId}.`, 404);
  const when = s(f.Timestamp) || s(f['Processed At']);
  const cid = s(f['Codex Entry ID']) || null;
  // The pay ledger's own session date wins: it is what the statement and the reminders use.
  const led = cid ? await db.query<{ d: string }>(`SELECT fields->>'Session Date' AS d FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [cid]) : { rows: [] as { d: string }[] };
  const date = led.rows[0]?.d || (/^\d{4}-\d{2}-\d{2}/.test(when) ? new Date(when).toISOString().slice(0, 10) : null);
  const builder = s(f['Builder User ID']);
  if (!builder) throw new PayCardError('no_builder', `${cid ?? submissionId} names no builder.`);
  return { submission_id: submissionId, codex_entry_id: cid, builder_slack_id: builder, builder: s(f['Builder Name']) || builder, session_date: date };
}

async function payMode(db: Queryable, builder: string): Promise<'Daily' | 'Monthly'> {
  const r = await db.query<{ m: string }>(`SELECT fields->>'Pay Mode' AS m FROM engine_pay_builders WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1`, [builder]);
  return r.rows[0]?.m === 'Monthly' ? 'Monthly' : 'Daily';
}

/**
 * Release lines for a builder: those this card already holds, then every release no card holds yet (taken by
 * this card only when claiming; a dry run shows what claiming would take). `upto` limits the unclaimed ones to
 * releases made by the time this log was approved, so a card rewritten later never takes a newer card's release.
 */
async function releasesFor(db: Queryable, log: LogRow, claim: boolean, upto: string | null = null): Promise<Release[]> {
  const rows = await db.query<{ id: string; codex_entry_id: string | null; submission_id: string; share: string; proof: string | null; at: string; card: string | null }>(
    `SELECT h.id::text, h.codex_entry_id, h.submission_id,
            ((h.after->>'released_share')::numeric - coalesce((h.before->>'released_share')::numeric, 0))::text AS share,
            h.after->>'proof_link' AS proof, to_char(h.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            c.card_submission_id AS card
       FROM engine_pay_note_history h
       JOIN engine_pay_notes n ON n.submission_id = h.submission_id
       LEFT JOIN engine_pay_card_claims c ON c.history_id = h.id
      WHERE h.action = 'release' AND n.builder_slack_id = $1 AND h.submission_id <> $2
        AND (c.card_submission_id = $2 OR (c.history_id IS NULL AND ($3::timestamptz IS NULL OR h.at <= $3::timestamptz)))
      ORDER BY h.id`,
    [log.builder_slack_id, log.submission_id, upto],
  );
  const out: Release[] = [];
  for (const r of rows.rows) {
    const share = round3(Number(r.share));
    if (!(share > 0)) continue;
    if (claim && !r.card) {
      await db.query(
        `INSERT INTO engine_pay_card_claims (history_id, card_submission_id, card_codex_entry_id) VALUES ($1, $2, $3) ON CONFLICT (history_id) DO NOTHING`,
        [r.id, log.submission_id, log.codex_entry_id],
      );
      // Another card took it in the meantime: it is that card's, not this one's.
      const who = await db.query<{ card_submission_id: string }>(`SELECT card_submission_id FROM engine_pay_card_claims WHERE history_id = $1`, [r.id]);
      if (who.rows[0]?.card_submission_id !== log.submission_id) continue;
    }
    const cid = r.codex_entry_id ?? r.submission_id;
    const led = await db.query<{ d: string }>(`SELECT fields->>'Session Date' AS d FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [cid]);
    const date = led.rows[0]?.d ?? null;
    const rate = await rateFor(db, log.builder_slack_id, date);
    out.push({ history_id: Number(r.id), codex_entry_id: cid, session_date: date, share, rate, usd: rate ? round2(share * rate.day_rate_usd) : null, proof_link: r.proof, released_at: r.at });
  }
  return out;
}

/** Everything on one card, worked out from the pay note, the rates and the ledger. With claim, the card takes the unclaimed releases. */
export async function figures(b: Obj, db?: Queryable): Promise<Figures> {
  const sub = s(b.submission_id, 200);
  if (!sub) throw new PayCardError('missing_log', 'Name the log: submission_id.');
  const claim = b.claim === true || b.claim === 'true';
  const run = async (q: Queryable): Promise<Figures> => {
    const log = await findLog(q, sub);
    const mode = await payMode(q, log.builder_slack_id);
    const note = await payNote.get({ submission_id: sub }, q).catch(() => null);
    const credited = note ? note.credited_share : 1;
    const held = note ? note.held_share : 0;
    const docked = note ? note.docked_share : 0;
    const missing = new Set<string>();
    const rate = mode === 'Daily' ? await rateFor(q, log.builder_slack_id, log.session_date) : null;
    if (mode === 'Daily' && !rate) missing.add(log.session_date ?? 'this session');
    const money = (share: number, r: Rate | null): number | null => (r ? round2(share * r.day_rate_usd) : null);
    // A card rewritten after the fact takes only the releases made when this log was approved (they are
    // written seconds after its pay note), never one a later approval made.
    let upto: string | null = null;
    if (b.rewrite === true) {
      const set = await q.query<{ at: string }>(`SELECT (min(at) + interval '10 minutes')::text AS at FROM engine_pay_note_history WHERE submission_id = $1 AND action IN ('set', 'correct')`, [sub]);
      upto = set.rows[0]?.at ?? new Date(0).toISOString();
    }
    const releases = mode === 'Daily' ? await releasesFor(q, log, claim, upto) : [];
    for (const r of releases) if (!r.rate) missing.add(r.session_date ?? r.codex_entry_id);
    const sum = (xs: (number | null)[]): number | null => (xs.some((x) => x === null) ? null : round2(xs.reduce<number>((a, x) => a + (x ?? 0), 0)));
    const payNow = mode === 'Daily' ? sum([money(credited, rate), ...releases.map((r) => r.usd)]) : null;

    // Owed from earlier days: the builder's approved daily logs not yet marked paid, other than this one.
    const earlier: Earlier[] = [];
    if (mode === 'Daily' && b.paid !== true && b.paid !== 'true') {
      const unpaid = await q.query<{ cid: string; d: string | null; sub: string | null }>(
        `SELECT DISTINCT ON (p.fields->>'Codex Entry ID') p.fields->>'Codex Entry ID' AS cid, p.fields->>'Session Date' AS d,
                (SELECT c.fields->>'Submission ID' FROM engine_codex_submissions c WHERE c.fields->>'Codex Entry ID' = p.fields->>'Codex Entry ID' ORDER BY c.updated_at DESC LIMIT 1) AS sub
           FROM engine_pay_sessions p
          WHERE p.fields->>'Builder Slack ID' = $1 AND coalesce(p.fields->>'Paid', '') NOT IN ('true', 'Yes')
            AND coalesce(p.fields->>'Codex Entry ID', '') NOT IN ('', $2)
          ORDER BY p.fields->>'Codex Entry ID', p.updated_at DESC`,
        [log.builder_slack_id, log.codex_entry_id ?? ''],
      );
      for (const u of unpaid.rows.sort((a, c) => String(a.d).localeCompare(String(c.d)))) {
        const n = u.sub ? await payNote.get({ submission_id: u.sub }, q).catch(() => null) : null;
        const r = await rateFor(q, log.builder_slack_id, u.d);
        if (!r) missing.add(u.d ?? u.cid);
        const cr = n ? n.credited_share : 1;
        // A release a card carries is priced at the day it was worked, so read each one.
        const relUsd = u.sub ? await claimedUsd(q, log.builder_slack_id, u.sub) : 0;
        const c$ = money(cr, r);
        earlier.push({ codex_entry_id: u.cid, session_date: u.d, credited: cr, note_found: !!n, rate: r, credited_usd: c$, releases_usd: relUsd ?? 0, total_usd: c$ === null || relUsd === null ? null : round2(c$ + relUsd) });
      }
    }
    const earlierTotal = mode === 'Daily' ? sum(earlier.map((e) => e.total_usd)) : null;

    // Still held across the builder's notes, this one included.
    const heldRows = await q.query<{ submission_id: string; codex_entry_id: string | null; held: string; cond: string | null }>(
      `SELECT submission_id, codex_entry_id, held_share::text AS held, release_condition AS cond FROM engine_pay_notes n WHERE builder_slack_id = $1 AND held_share > 0
         AND n.submission_id NOT IN (SELECT fields->>'Submission ID' FROM engine_codex_submissions WHERE fields->>'Merged Into Day' = 'true') ORDER BY decided_at`,
      [log.builder_slack_id],
    );
    const stillHeld = [];
    for (const h of heldRows.rows) {
      const cid = h.codex_entry_id ?? h.submission_id;
      const led = await q.query<{ d: string }>(`SELECT fields->>'Session Date' AS d FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [cid]);
      const d = led.rows[0]?.d ?? null;
      const r = mode === 'Daily' ? await rateFor(q, log.builder_slack_id, d) : null;
      stillHeld.push({ codex_entry_id: cid, session_date: d, share: round3(Number(h.held)), usd: money(Number(h.held), r), condition: h.cond });
    }

    let month: Figures['month'] = null;
    if (mode === 'Monthly') {
      const m = (log.session_date ?? new Date().toISOString()).slice(0, 7);
      const facts = await payNote.statementFacts({ month: m, pay_mode: 'Monthly' });
      const mine = facts.statements.find((x) => x.builder_slack_id === log.builder_slack_id);
      month = { month: m, credited_shares: mine?.credited_shares ?? 0, released_shares: mine?.released_shares ?? 0, held_shares: round3((mine?.still_held ?? []).reduce((a, x) => a + x.held_share, 0)), sessions: mine?.session_count ?? 0 };
    }

    return {
      submission_id: sub,
      codex_entry_id: log.codex_entry_id,
      builder_slack_id: log.builder_slack_id,
      builder: log.builder,
      pay_mode: mode,
      session_date: log.session_date,
      rate,
      today: {
        note_found: !!note,
        recommendation: note ? note.pay_recommendation : 'full',
        credited,
        held,
        docked,
        reason_tag: note?.reason_tag ?? null,
        release_condition: note?.release_condition ?? null,
        credited_usd: money(credited, rate),
        held_usd: money(held, rate),
        docked_usd: money(docked, rate),
      },
      releases,
      pay_now_usd: payNow,
      earlier,
      earlier_total_usd: earlierTotal,
      owed_total_usd: mode === 'Daily' && payNow !== null && earlierTotal !== null ? round2(payNow + earlierTotal) : null,
      still_held: stillHeld,
      month,
      missing_rates: [...missing],
    };
  };
  if (db) return run(db);
  return claim ? withTransaction(run) : run({ query } as Queryable);
}

async function claimedUsd(q: Queryable, builder: string, cardSub: string): Promise<number | null> {
  const r = await q.query<{ share: string; cid: string }>(
    `SELECT ((h.after->>'released_share')::numeric - coalesce((h.before->>'released_share')::numeric, 0))::text AS share, coalesce(h.codex_entry_id, h.submission_id) AS cid
       FROM engine_pay_card_claims c JOIN engine_pay_note_history h ON h.id = c.history_id WHERE c.card_submission_id = $1`,
    [cardSub],
  );
  let total = 0;
  for (const x of r.rows) {
    const led = await q.query<{ d: string }>(`SELECT fields->>'Session Date' AS d FROM engine_pay_sessions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [x.cid]);
    const rate = await rateFor(q, builder, led.rows[0]?.d ?? null);
    if (!rate) return null;
    total += Number(x.share) * rate.day_rate_usd;
  }
  return round2(total);
}

const sec = (id: string, text: string): Block => ({ type: 'section', block_id: `${FIG}${id}`, text: { type: 'mrkdwn', text: cap(text, 2900) } });

/** The card's pay blocks for a set of figures. Pure. */
const fields = (id: string, cells: string[]): Block => ({ type: 'section', block_id: `${FIG}${id}`, fields: cells.slice(0, 10).map((c) => ({ type: 'mrkdwn', text: cap(c, 1900) })) });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string): string => { const i = Number(m.slice(5, 7)) - 1; return MONTHS[i] ?? m; };
const share = (x: number, of: number): string => (of > 0 ? pct(x / of) : '0%');

/**
 * The pay blocks (12 Nov 2026, Destiny: readable, not packed). No reason for a hold: the review above the
 * card already says why. Daily builders get dollars in two columns; monthly builders get this log and the
 * month so far as percentages of the month's logs.
 */
export function blocks(f: Figures, opts: { paid?: boolean } = {}): Block[] {
  const out: Block[] = [{ type: 'divider', block_id: `${FIG}div` }];
  const t = f.today;
  const noNote = t.note_found ? '' : '\n_no pay note, counted as a full day_';
  if (f.pay_mode === 'Monthly') {
    out.push(sec('title', '*:moneybag: Pay*  ·  monthly builder'));
    const thisLog = [`${pct(t.credited)} credited`, ...(t.held > 0 ? [`${pct(t.held)} held`] : []), ...(t.docked > 0 ? [`${pct(t.docked)} docked`] : [])].join('  ·  ');
    // Stacked, the month under this log (Destiny, 12 Nov): two columns read as two separate things.
    out.push(sec('monthly', `*This log*\n${thisLog}${noNote}`));
    if (f.month) {
      const m = f.month;
      const parts = [`${share(m.credited_shares, m.sessions)} credited`, ...(m.released_shares ? [`${share(m.released_shares, m.sessions)} released`] : []), `${share(m.held_shares, m.sessions)} held`];
      out.push(sec('month', `*${monthName(m.month)} so far*\n${m.sessions} log(s)  ·  ${m.credited_shares} day(s)\n${parts.join('  ·  ')}`));
    }
    return out;
  }
  out.push(sec('title', `*:moneybag: Pay*  ·  ${f.rate ? `${usd(f.rate.day_rate_usd)} a day` : 'no day rate on record'}`));
  const cells = [`*This session (${day(f.session_date)})*\n${pct(t.credited)}${t.credited_usd !== null ? `  ·  ${usd(t.credited_usd)}` : ''}${noNote}`];
  if (t.held > 0) cells.push(`*Held*\n${pct(t.held)}${t.held_usd !== null ? `  ·  ${usd(t.held_usd)}` : ''}`);
  if (t.docked > 0) cells.push(`*Docked*\n${pct(t.docked)}${t.docked_usd !== null ? `  ·  ${usd(t.docked_usd)}` : ''}`);
  out.push(fields('today', cells));
  if (f.releases.length) {
    const lines = f.releases.slice(0, 10).map((r) => `• ${day(r.session_date)}  ·  ${pct(r.share)}${r.usd !== null ? `  ·  ${usd(r.usd)}` : ''}${r.proof_link ? `  ·  <${r.proof_link}|proof>` : ''}`);
    out.push(sec('released', `*Released from earlier logs*\n${lines.join('\n')}${f.releases.length > 10 ? `\n…and ${f.releases.length - 10} more` : ''}`));
  }
  if (!opts.paid && f.earlier.length) {
    // A card's total includes the releases it paid out, so name them (12 Nov 2026: "95% · $420" read as a sum error).
    const lines = f.earlier.slice(0, 12).map((e) => `• ${day(e.session_date)}  ·  ${pct(e.credited)}${e.credited_usd !== null ? `  ·  ${usd(e.credited_usd)}` : ''}${e.releases_usd > 0 ? `  +  ${usd(e.releases_usd)} released on that card` : ''}${e.total_usd !== null && e.releases_usd > 0 ? `  =  ${usd(e.total_usd)}` : ''}${e.note_found ? '' : '  _(no pay note)_'}`);
    out.push(sec('earlier', `*Owed from earlier days, not marked paid*\n${lines.join('\n')}${f.earlier.length > 12 ? `\n…and ${f.earlier.length - 12} more` : ''}`));
  }
  const missing = 'not worked out';
  const totals = [`*${opts.paid ? 'Paid on this card' : 'Pay for this card'}*\n*${f.pay_now_usd !== null ? usd(f.pay_now_usd) : missing}*`];
  // Nothing owed from earlier days draws nothing (12 Nov 2026, Destiny): a nought line is noise.
  if (!opts.paid && f.earlier.length) totals.push(`*All owed now*\n*${f.owed_total_usd !== null ? usd(f.owed_total_usd) : missing}*`);
  out.push(fields('totals', totals));
  const otherHeld = f.still_held.filter((h) => h.codex_entry_id !== (f.codex_entry_id ?? f.submission_id));
  if (otherHeld.length) {
    const lines = otherHeld.slice(0, 8).map((h) => `• ${day(h.session_date)}  ·  ${pct(h.share)}${h.usd !== null ? `  ·  ${usd(h.usd)}` : ''}`);
    out.push(sec('held', `*Still held on earlier logs* (in no total above)\n${lines.join('\n')}`));
  }
  out.push({
    type: 'context',
    block_id: `${FIG}how`,
    elements: [{ type: 'mrkdwn', text: cap(`Share of a day × the day rate on the day worked. A release is paid on one card only.${f.missing_rates.length ? ` No day rate on record for: ${f.missing_rates.join(', ')}.` : ''}`, 2900) }],
  });
  return out;
}

/** Puts the pay blocks into a card: any old pay blocks out, the new ones in before the buttons (or at the end). Pure. */
export function merge(card: Block[], pay: Block[]): Block[] {
  const kept = card.filter((b) => !String(b.block_id ?? '').startsWith(FIG));
  const at = kept.findIndex((b) => b.type === 'actions');
  if (at < 0) {
    const ctx = kept.length && kept[kept.length - 1].type === 'context' ? kept.length - 1 : kept.length;
    return [...kept.slice(0, ctx), ...pay, ...kept.slice(ctx)];
  }
  return [...kept.slice(0, at), ...pay, ...kept.slice(at)];
}

/**
 * The route n8n calls (POST /api/engine/pay-card): { submission_id, claim?, paid?, card? }. With `card`
 * (a chat.postMessage or chat.update body), the answer carries it back with the pay blocks put in, so the
 * card n8n posts and the figures can never come from two places.
 */
export async function forCard(b: Obj): Promise<Obj> {
  // A log merged into its day's entry (sameDay.ts, 14 Nov 2026) has no pay of its own: its card says where the day is
  // paid and carries no Yes, Paid button.
  const sub = s(b.submission_id, 200);
  const mergedRow = sub
    ? (await query<{ f: Obj }>(`SELECT fields AS f FROM engine_codex_submissions WHERE fields->>'Submission ID' = $1 AND fields->>'Merged Into Day' = 'true' ORDER BY updated_at DESC LIMIT 1`, [sub])).rows[0]?.f
    : undefined;
  if (mergedRow) {
    const entry = s(mergedRow['Day Entry Codex ID']) || s(mergedRow['Day Entry Submission ID']) || 'the day entry';
    const cid = s(mergedRow['Codex Entry ID']) || sub;
    const day = s(mergedRow['Day Date']);
    const text = `*Pay Review: merged into the day*\n\`${cid}\` is log ${s(mergedRow['Day Log Number']) || '2'} of ${s(mergedRow['Day Logs']) || '2'} by ${s(mergedRow['Builder Name']) || 'this builder'} on ${day} (New York date). It was added to the day entry \`${entry}\`, which is the one paid day, so this log pays nothing of its own and nothing on it is held as a balance (SOP 3c0def60).`;
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    return { ok: true, merged: true, figures: null, blocks, body: { text: `Merged into ${entry}`, blocks }, line: `${cid}: merged into ${entry}, no pay of its own` };
  }
  const f = await figures(b);
  const paid = b.paid === true || b.paid === 'true';
  const pay = blocks(f, { paid });
  const card = b.card && typeof b.card === 'object' ? (b.card as Obj) : null;
  const body = card ? { ...card, blocks: merge(Array.isArray(card.blocks) ? (card.blocks as Block[]) : [], pay) } : null;
  return { ok: true, figures: f, blocks: pay, body, line: `${f.builder}: ${f.pay_mode === 'Daily' ? `pay for this card ${f.pay_now_usd !== null ? usd(f.pay_now_usd) : 'not worked out'}, all owed ${f.owed_total_usd !== null ? usd(f.owed_total_usd) : 'n/a'}` : `${pct(f.today.credited)} credited (monthly)`}` };
}

/**
 * Rewrites pay review cards already posted (POST /api/engine/pay-card/rewrite): { submission_ids, dry_run? }.
 * Each card is found in #bha-pay-reviews by the Submission ID its Yes, Paid button carries (or its Codex
 * Entry ID), its pay blocks rebuilt, and the card updated in place as Bays. A card not found is named,
 * never re-posted. A paid card shows only what it paid.
 */
export async function rewrite(b: Obj): Promise<Obj> {
  const ids = (Array.isArray(b.submission_ids) ? b.submission_ids : []).map((x) => s(x, 200)).filter(Boolean);
  if (!ids.length) throw new PayCardError('nothing_named', 'Name the logs whose cards to rewrite: submission_ids.');
  if (ids.length > 30) throw new PayCardError('too_many', 'At most 30 cards a call.');
  const dry = b.dry_run === true || b.dry_run === 'true';
  const msgs: Obj[] = [];
  let cursor = '';
  for (let page = 0; page < 6; page++) {
    const r = await slack.botCall('conversations.history', { channel: PAY_CHANNEL, limit: 200, cursor: cursor || undefined }, 'form');
    if (!r.ok) throw new PayCardError('history_unreadable', `Could not read #bha-pay-reviews: ${r.error}.`, 502);
    msgs.push(...((r.messages as Obj[]) ?? []));
    cursor = String((r.response_metadata as Obj | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  const results: Obj[] = [];
  for (const sub of ids) {
    const codex = await query<{ cid: string | null }>(`SELECT fields->>'Codex Entry ID' AS cid FROM engine_codex_submissions WHERE fields->>'Submission ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [sub]);
    const cid = codex.rows[0]?.cid ?? null;
    const msg = msgs.find((m) => {
      const raw = JSON.stringify(m.blocks ?? []);
      return /Pay Review/.test(raw) && (raw.includes(`"value":"${sub}|`) || (cid ? raw.includes(`\`${cid}\``) : false));
    });
    if (!msg) {
      results.push({ submission_id: sub, ok: false, reason: 'card_not_found', message: `No pay review card for ${cid ?? sub} in the last ${msgs.length} messages of #bha-pay-reviews.` });
      continue;
    }
    const card = (msg.blocks as Block[]) ?? [];
    const paid = JSON.stringify(card).includes('Pay Review \\u2014 Paid') || card.some((x) => x.type === 'header' && /Paid$/.test(String(x.text?.text ?? '')));
    try {
      const out = await forCard({ submission_id: sub, claim: !dry, rewrite: true, paid, card: { blocks: card } });
      if (dry) {
        results.push({ submission_id: sub, ok: true, dry_run: true, ts: msg.ts, line: out.line });
        continue;
      }
      const up = await slack.botCall('chat.update', { channel: PAY_CHANNEL, ts: msg.ts, text: s(msg.text, 3000) || 'Pay review', blocks: (out.body as Obj).blocks });
      results.push({ submission_id: sub, ok: up.ok, ts: msg.ts, line: out.line, ...(up.ok ? {} : { reason: 'slack_refused', message: up.error }) });
    } catch (e) {
      results.push({ submission_id: sub, ok: false, reason: e instanceof PayCardError ? e.reason : 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: results.every((r) => r.ok), dry_run: dry, rewritten: results.filter((r) => r.ok && !r.dry_run).length, results };
}

/**
 * Redraws a builder's unpaid pay review cards (12 Nov 2026, Jason in #bha-pay-reviews 1794497464.865089:
 * a card built before an earlier log was marked Yes, Paid still counted that log as owed). Called after
 * any pay session turns paid, so every open card reads the ledger as it now stands. Waits a few seconds
 * so the copies of one payment land together, and runs once per builder at a time. Never throws.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
export function refreshUnpaidSoon(builderSlackId: string, delayMs = 8000): void {
  if (!builderSlackId) return;
  const old = pending.get(builderSlackId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    pending.delete(builderSlackId);
    refreshUnpaid(builderSlackId).then(
      (r) => console.log(`pay-card refresh ${builderSlackId}: ${JSON.stringify({ rewritten: r.rewritten, results: (r.results as Obj[] | undefined)?.map((x) => `${x.submission_id}:${x.ok ? 'ok' : x.reason}`) })}`),
      (e) => console.error(`pay-card refresh ${builderSlackId} failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, delayMs);
  t.unref?.();
  pending.set(builderSlackId, t);
}

export async function refreshUnpaid(builderSlackId: string, dryRun = false): Promise<Obj> {
  if (!/^[UW][A-Z0-9]{6,}$/.test(builderSlackId)) throw new PayCardError('missing_builder', 'Name the builder: builder_slack_id (a Slack user id).');
  const r = await query<{ sub: string }>(
    `SELECT DISTINCT c.fields->>'Submission ID' AS sub
       FROM engine_pay_sessions p
       JOIN engine_codex_submissions c ON c.fields->>'Codex Entry ID' = p.fields->>'Codex Entry ID'
      WHERE p.fields->>'Builder Slack ID' = $1 AND coalesce(p.fields->>'Paid', '') NOT IN ('true', 'Yes')
        AND coalesce(c.fields->>'Submission ID', '') <> ''`,
    [builderSlackId],
  );
  const ids = r.rows.map((x) => x.sub).slice(0, 30);
  if (!ids.length) return { ok: true, rewritten: 0, results: [], note: 'No unpaid cards for this builder.' };
  return rewrite({ submission_ids: ids, dry_run: dryRun });
}
