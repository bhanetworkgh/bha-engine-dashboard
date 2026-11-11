/**
 * Rewriting the pay part of a log's review card in place (10 Nov 2026, Destiny). After the LogStream
 * pay rules were tuned on their first night of real logs, the logs still waiting on Jason were scored
 * again; their cards in #bha-log-reviews are updated, never posted again, so Jason keeps one card per
 * log and its Approve pop-up opens on the new suggestion.
 *
 * What changes on the card, and nothing else:
 *   - the "Suggested pay" section (the blocks between the divider after the review and the divider
 *     before the buttons), rebuilt from the Codex row's Pay Suggestion the way Build Layer 1 Payload
 *     builds it, with one line saying it was scored again and why;
 *   - the fourth part of each button's value, the suggestion the pop-up opens on. The first three
 *     parts (submission id, builder, missing sections) are kept exactly.
 * A card for a log that is not Pending (approved, rejected) is refused: its buttons are gone or its
 * decision is made. A card whose buttons cannot be found is refused rather than guessed at.
 */
import { query } from './pg';
import * as slack from './slack';
import * as paySuggest from './paySuggest';

type Obj = Record<string, unknown>;
type Block = Obj & { type?: string; text?: { type?: string; text?: string }; elements?: Obj[]; block_id?: string };

export class CardError extends Error {
  constructor(public reason: string, message: string, public status = 422) {
    super(message);
  }
}

const PART: Record<string, string> = { live: 'credited', live_pending: 'half now, half held until its live event', held: 'held', already_paid: 'already logged, docked' };
const cap = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const list = (items: string[]): Block => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_list', style: 'bullet', indent: 0, elements: items.map((t) => ({ type: 'rich_text_section', elements: [{ type: 'text', text: cap(t, 900) }] })) }],
});

/** The pay blocks for a suggestion, as Build Layer 1 Payload builds them, plus why it was scored again. Pure. */
export function payBlocks(sug: ReturnType<typeof paySuggest.fromRow>, why: string): Block[] {
  const note = `_${why}_`;
  if (!sug || sug.none) return [section(cap(`*Suggested pay:* none was worked out for this log, so the pop-up opens on full. Check it before approving.\n${note}`, 2900))];
  const parts = (sug.parts ?? []) as { what: string; status: string; missing?: string[] }[];
  return [
    section(cap(`*Suggested pay* (from this review, you decide on Approve)\n${paySuggest.lineFor(sug)}${sug.log_class === 'RELOG_OLD_WORK' ? `\nRe-log of ${sug.relog_of ?? 'earlier work'}. New this session: ${sug.relog_delta ?? 'not stated'}` : ''}\n${note}`, 2900)),
    ...((sug.flags ?? []).length ? [section(cap((sug.flags ?? []).map((f) => `:red_circle: ${f}`).join('\n'), 2900))] : []),
    ...(parts.length ? [list(parts.map((p) => `${p.what}: ${PART[p.status] ?? p.status}${(p.missing ?? []).length ? ` (needs: ${(p.missing ?? []).join(', ')})` : ''}`))] : []),
    ...(sug.release_condition ? [section(cap(`*Held until:* ${sug.release_condition}`, 2900))] : []),
    ...releaseBlocks(sug),
  ];
}

/**
 * Pay held on the builder's earlier logs (11 Nov 2026): what this log proves and Approve will release when
 * the box is left ticked, and every hold it does not address, so a held share is never forgotten. Each earlier
 * log is its own bold block with its Codex ID, the day it was logged, the day the pay was held, a link to it
 * on the dashboard and why it was held (Destiny, 11 Nov: "so he doesn't miss it at all"). The same shape is in
 * n8n's Build Layer 1 Payload. Pure.
 */
export function releaseBlocks(sug: ReturnType<typeof paySuggest.fromRow>): Block[] {
  const r = (sug?.releases ?? null) as paySuggest.Releases | null;
  if (!r || (!r.items.length && !r.open.length)) return [];
  const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }) : '(no date recorded)');
  const id = (x: { codex_entry_id: string | null; submission_id: string }) => x.codex_entry_id ?? x.submission_id;
  const about = (x: { logged_at?: string | null; held_at?: string | null; link?: string }) => `*Logged ${day(x.logged_at)} · held ${day(x.held_at)} · <${x.link || paySuggest.logLink(x as never)}|Open the log on the dashboard>*`;
  const why = (c: string | null | undefined) => (c ? `\n*Held because:* ${cap(c, 400)}` : '');
  const out: Block[] = [
    section(r.total_share > 0
      ? `*:moneybag: Held pay on earlier logs: Approve releases ${paySuggest.pct(r.total_share)} of a day while the box is ticked.*`
      : '*:hourglass_flowing_sand: Held pay on earlier logs: this log proves none of it yet.*'),
  ];
  for (const i of r.items) {
    const head = i.release_share > 0
      ? `*:white_check_mark: Release ${paySuggest.pct(i.release_share)} of a day held on ${id(i)}*` + (i.release_share < i.held_share ? `\n*${paySuggest.pct(i.held_share - i.release_share)} stays held: not proven by this log.*` : '')
      : `*:hourglass_flowing_sand: Still held: ${paySuggest.pct(i.held_share)} of a day on ${id(i)}, not proven by this log*`;
    out.push(section(cap(`${head}\n${about(i)}${why(i.release_condition)}`, 2900)));
    out.push(list(i.parts.slice(0, 8).map((p) => `${p.what}, ${paySuggest.pct(p.share)}: ${p.ok ? `proven (${p.proof}). ${p.why}` : `still held, ${p.why}`}`)));
  }
  for (const o of r.open.slice(0, 6)) {
    out.push(section(cap(`*:hourglass_flowing_sand: Still held: ${paySuggest.pct(o.held_share)} of a day on ${id(o)}, not addressed by this log*\n${about(o)}${why(o.release_condition)}`, 2900)));
  }
  return out;
}

/** The fourth part of the button value: what the Approve pop-up opens on. Same shape as Build Layer 1 Payload. Pure. */
export function sugPart(sug: ReturnType<typeof paySuggest.fromRow>): string {
  if (!sug || sug.none || !sug.pay_recommendation) return '';
  return (
    '|' +
    JSON.stringify({
      r: sug.pay_recommendation,
      s: sug.rest ?? 'hold',
      c: sug.credited_share,
      h: sug.held_share,
      t: sug.reason_tag ?? '',
      n: (sug.reason_note ?? '').slice(0, 400),
      k: (sug.release_condition ?? '').slice(0, 500),
      l: paySuggest.lineFor(sug).slice(0, 150),
      x: ((sug.releases ?? null) as paySuggest.Releases | null)?.total_share ?? 0,
    })
  );
}

/** The first three parts of a button value, kept as they are. Pure. */
export function head3(value: string): string {
  let at = -1;
  for (let i = 0; i < 3; i++) {
    at = value.indexOf('|', at + 1);
    if (at === -1) return value;
  }
  return value.slice(0, at);
}

/** The card with its pay part and button values replaced. Pure; refuses a card with no buttons. */
export function rebuild(blocks: Block[], sug: ReturnType<typeof paySuggest.fromRow>, why: string): Block[] {
  const out = blocks.map((b) => JSON.parse(JSON.stringify(b)) as Block);
  const actionsAt = out.findIndex((b) => b.type === 'actions');
  if (actionsAt === -1) throw new CardError('no_buttons', 'The card has no buttons, so there is no pop-up to update; it is left as it is.');
  const start = out.findIndex((b) => b.type === 'section' && typeof b.text?.text === 'string' && /^\*Suggested pay/.test(b.text.text));
  const fresh = payBlocks(sug, why);
  if (start !== -1 && start < actionsAt) {
    let end = start;
    while (end < actionsAt && out[end].type !== 'divider') end++;
    out.splice(start, end - start, ...fresh);
  } else {
    // A card from before LogStream: put the pay part in, between dividers, above the buttons.
    const at = out.findIndex((b) => b.type === 'actions');
    out.splice(at, 0, ...fresh, { type: 'divider' });
  }
  // Slack reads a card back with ">" as "&gt;", so a quoted answer that fit at 3,000 characters when posted can
  // come back longer and be refused as invalid_blocks on the update (10 Nov 2026). Every section is held to the limit.
  for (const b of out) if (b.type === 'section' && b.text && typeof b.text.text === 'string' && b.text.text.length > 3000) b.text.text = cap(b.text.text, 3000);
  const actions = out.find((b) => b.type === 'actions');
  for (const el of (actions?.elements ?? []) as Obj[]) {
    if (typeof el.value === 'string') el.value = head3(el.value) + sugPart(sug);
  }
  return out;
}

const BUDGET = 11_000;

/** The card with the longest pay part that keeps it inside Slack's budget, or null. Pure. */
export function fitCard(blocks: Block[], sug: ReturnType<typeof paySuggest.fromRow>, why: string, id: string): Block[] | null {
  // Slack already took the card as it stands, so a card no bigger than that is never refused for its size.
  // The new button suggestion adds up to about 1,000 characters to each button, so that much room is always given.
  const limit = Math.max(BUDGET, JSON.stringify(blocks).length + 4_000);
  const tries: ((x: Block[]) => Block[])[] = [
    (x) => x,
    (x) => x.filter((b) => b.type !== 'rich_text'),
    (x) => x.filter((b) => b.type !== 'rich_text').map((b) => (b.type === 'section' && typeof b.text?.text === 'string' && /^(:red_circle:|\*Held until)/.test(b.text.text) ? section(cap(b.text.text, 400)) : b)),
  ];
  const fresh = payBlocks(sug, why);
  for (const t of tries) {
    const mine = t(fresh);
    const out = rebuild(blocks, sug, why);
    const at = out.findIndex((b) => JSON.stringify(b) === JSON.stringify(fresh[0]));
    if (at !== -1) out.splice(at, fresh.length, ...mine);
    if (JSON.stringify(out).length <= limit) return out;
  }
  const short = section(cap(`*Suggested pay* (from this review, you decide on Approve)\n${sug && !sug.none ? paySuggest.lineFor(sug) : 'none was worked out'}\nThe parts, flags and what releases the held share are on the log in the dashboard: https://dashboard.bhanetwork.org/codex/${encodeURIComponent(id)}\n_${why}_`, 2900));
  const out = rebuild(blocks, sug, why);
  const at = out.findIndex((b) => JSON.stringify(b) === JSON.stringify(fresh[0]));
  if (at !== -1) out.splice(at, fresh.length, short);
  return JSON.stringify(out).length <= Math.max(12_000, limit) ? out : null;
}

const WORKSPACE = 'https://bayshorizonnetwork.slack.com';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed, 11 Nov 2026, 4:50PM UTC", the pay review card's own format. Pure. */
export function when(v: unknown): string {
  const d = new Date(String(v ?? ''));
  if (!v || isNaN(d.getTime())) return 'Not recorded';
  let h = d.getUTCHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}${ap} UTC`;
}
const flat = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

export interface Approval {
  approver_user_id: string;
  approved_at: string;
  early_reason?: string | null;
  missing?: string | null;
  notes_added?: boolean;
}

/**
 * The review card once a log is approved (11 Nov 2026, Jason in C0AUKTND199 1794414187.601659: "make it clear
 * who the approved log is for"). Until then Approve rewrote the card to "Approved. Log is processing now." and
 * a channel of approvals could not be told apart. It now says whose log it was, the session, when it was worked
 * and approved, and who approved it, in the pay review card's shape. Pure.
 */
export function approvedBlocks(f: Obj, submissionId: string, a: Approval): { text: string; blocks: Block[] } {
  const builderId = flat(f['Builder User ID']) || (/^[UW][A-Z0-9]+_/.test(submissionId) ? submissionId.split('_')[0] : '');
  const name = flat(f['Builder Name']) || 'the builder';
  const title = cap(flat(f['Session Description']) || 'Untitled session', 280);
  const url = flat(f['Session Url'] ?? f['Session URL']);
  const codexId = flat(f['Codex Entry ID']);
  const head = a.early_reason ? 'Approved early' : a.notes_added ? 'Approved with notes' : 'Approved';
  const fields = [
    `*Builder:*\n${builderId ? `<@${builderId}>` : name}`,
    `*Approved by:*\n<@${a.approver_user_id}>`,
    `*Session date:*\n${when(f['Timestamp'])}`,
    `*Approved at:*\n${when(a.approved_at)}`,
    codexId ? `*Codex Entry ID:*\n\`${codexId}\`` : `*Submission ID:*\n\`${submissionId}\``,
    `*Session:*\n${/^https?:\/\//.test(url) ? `<${url}|Open session>` : 'Not provided'}`,
  ];
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: cap(`✅ ${head}: ${name}`, 150) } },
    section(`*${title}*`),
    { type: 'section', fields: fields.map((t) => ({ type: 'mrkdwn', text: t })) },
  ];
  if (a.early_reason) blocks.push(section(cap(`:warning: *Codex incomplete when approved.*${a.missing ? `\n*Missing:* ${a.missing}` : ''}\n*Reason:* ${a.early_reason}`, 2900)));
  if (a.notes_added) blocks.push(section('📝 Notes were added and go into the Codex entry.'));
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: codexId ? `Codex entry posted · <https://dashboard.bhanetwork.org/codex/${encodeURIComponent(codexId)}|Open on the dashboard>` : "Log is processing now. The Codex entry posts in the builder's log channel." }],
  });
  return { text: cap(`${head}: ${name}, ${title}`, 300), blocks };
}

/**
 * Rewrites a log's review card as approved. Called by Submit Actions at the Approve click (the card is in the
 * body), and for a card approved before this existed (found from the row). `dry_run` builds and sends nothing.
 */
export async function markApproved(b: Obj): Promise<Obj> {
  const id = flat(b.submission_id);
  if (!id) throw new CardError('submission_id_required', 'submission_id is the log the card belongs to.');
  const approver = flat(b.approver_user_id);
  if (!/^[UW][A-Z0-9]{6,}$/.test(approver)) throw new CardError('approver_required', 'approver_user_id is the Slack id of the person who approved.');
  const r = await query<{ fields: Obj }>(`SELECT fields FROM engine_codex_submissions WHERE natural_id = $1 OR fields->>'Submission ID' = $1 ORDER BY updated_at DESC LIMIT 2`, [id]);
  if (r.rows.length > 1) throw new CardError('ambiguous', `${id} matches two Codex rows; nothing was changed.`, 409);
  const f = r.rows[0]?.fields ?? {};
  if (String(f['Jason Status'] ?? '') === 'Rejected') throw new CardError('rejected', `${id} was rejected, so its card is left as it is.`, 409);
  const channel = flat(b.channel) || flat(f['Review Card Channel']);
  const ts = flat(b.ts) || flat(f['Review Card TS']);
  if (!channel || !ts) throw new CardError('no_card', `No card location for ${id}: send channel and ts, or the row needs Review Card Channel and TS.`, 404);
  const approvedAt = flat(b.approved_at) || flat(f['Jason Reviewed At']) || new Date().toISOString();
  const card = approvedBlocks(f, id, {
    approver_user_id: approver,
    approved_at: approvedAt,
    early_reason: flat(b.early_reason) || null,
    missing: flat(b.missing) || null,
    notes_added: b.notes_added === true,
  });
  const found = r.rows.length === 1;
  if (b.dry_run === true) return { ok: true, dry_run: true, submission_id: id, channel, ts, row_found: found, ...card };
  const u = await slack.botCall('chat.update', { channel, ts, text: card.text, blocks: card.blocks });
  if (!u.ok) throw new CardError('slack_refused', `Slack refused the update: ${u.error}.`, 502);
  return { ok: true, updated: true, submission_id: id, channel, ts, row_found: found, link: `${WORKSPACE}/archives/${channel}/p${ts.replace('.', '')}` };
}

/**
 * Reads the log's card from Slack and rewrites its pay part from the Codex row's Pay Suggestion.
 * `dry_run` reads and builds but sends nothing.
 */
export async function refreshPay(b: Obj): Promise<Obj> {
  const id = String(b.submission_id ?? '').trim();
  if (!id) throw new CardError('submission_id_required', 'submission_id is the Codex row the card belongs to.');
  const why = String(b.why ?? '').trim() || 'Scored again on 10 Nov 2026 under the tuned pay rules.';
  const r = await query<{ fields: Obj }>(`SELECT fields FROM engine_codex_submissions WHERE natural_id = $1 OR fields->>'Submission ID' = $1 ORDER BY updated_at DESC LIMIT 2`, [id]);
  if (!r.rows.length) throw new CardError('not_found', `No Codex row ${id}.`, 404);
  if (r.rows.length > 1) throw new CardError('ambiguous', `${id} matches two Codex rows; nothing was changed.`, 409);
  const f = r.rows[0].fields;
  const status = String(f['Jason Status'] ?? '');
  if (status && status !== 'Pending') throw new CardError('not_pending', `${id} is ${status}, not waiting on Jason, so its card is left as it is.`, 409);
  const channel = String(f['Review Card Channel'] ?? '');
  const ts = String(f['Review Card TS'] ?? '');
  if (!channel || !ts) throw new CardError('no_card', `${id} carries no Review Card Channel and TS, so its card cannot be found.`, 404);
  const h = await slack.botCall('conversations.history', { channel, latest: ts, inclusive: true, limit: 1 }, 'form');
  const m = h.ok ? ((h.messages as { ts?: string; text?: string; blocks?: Block[] }[]) ?? [])[0] : undefined;
  if (!h.ok) throw new CardError('card_unreadable', `Slack would not read the card in ${channel}: ${h.error}.`, 502);
  if (!m || m.ts !== ts || !Array.isArray(m.blocks)) throw new CardError('card_not_found', `No card at ${channel} ${ts}.`, 404);
  const sug = paySuggest.fromRow(f);
  // Slack's card size budget, as Build Layer 1 Payload keeps it. The pay part gets shorter in steps until the card
  // fits (10 Nov 2026: two of Ahad's long cards were refused whole): the parts list first (Held until restates it),
  // then the flags and the held text are cut short, then only the one line and a pointer to the dashboard remain.
  const shape = (x: Block[]) => x.map((k) => `${k.type}:${JSON.stringify(k).length}:${String(k.text?.text ?? '').slice(0, 40)}`);
  if (b.dry_run === true && b.shape === true) return { ok: true, dry_run: true, submission_id: id, size: JSON.stringify(m.blocks).length, shape: shape(m.blocks), rebuilt: shape(rebuild(m.blocks, sug, why)) };
  let blocks = fitCard(m.blocks, sug, why, id);
  if (!blocks) throw new CardError('too_long', 'The rewritten card would be past Slack\'s size limit even with the shortest pay part; nothing was sent.');
  const line = sug && !sug.none ? paySuggest.lineFor(sug) : null;
  if (b.dry_run === true) return { ok: true, dry_run: true, submission_id: id, channel, ts, line, blocks_before: m.blocks.length, blocks_after: blocks.length };
  // The fallback text read back from Slack is rebuilt from the blocks and can pass Slack's limit (msg_too_long on
  // two cards, execution 79097), so a short one is sent; the card itself is the blocks.
  const fallback = String(m.text ?? '').slice(0, 300) || 'Builder log review';
  const u = await slack.botCall('chat.update', { channel, ts, text: fallback, blocks });
  if (!u.ok) throw new CardError('slack_refused', `Slack refused the update: ${u.error}.`, 502);
  return { ok: true, updated: true, submission_id: id, channel, ts, line, link: `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ts.replace('.', '')}` };
}
