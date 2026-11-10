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

const PART: Record<string, string> = { live: 'credited', live_pending: 'merged, no live event yet', held: 'held', already_paid: 'already logged, docked' };
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
    section(cap(`*Suggested pay* (from this review, you decide on Approve)\n${sug.line ?? 'No suggestion.'}${sug.log_class === 'RELOG_OLD_WORK' ? `\nRe-log of ${sug.relog_of ?? 'earlier work'}. New this session: ${sug.relog_delta ?? 'not stated'}` : ''}\n${note}`, 2900)),
    ...((sug.flags ?? []).length ? [section(cap((sug.flags ?? []).map((f) => `:red_circle: ${f}`).join('\n'), 2900))] : []),
    ...(parts.length ? [list(parts.map((p) => `${p.what}: ${PART[p.status] ?? p.status}${(p.missing ?? []).length ? ` (needs: ${(p.missing ?? []).join(', ')})` : ''}`))] : []),
    ...(sug.release_condition ? [section(cap(`*Held until:* ${sug.release_condition}`, 2900))] : []),
  ];
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
      l: (sug.line ?? '').slice(0, 150),
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
  const actions = out.find((b) => b.type === 'actions');
  for (const el of (actions?.elements ?? []) as Obj[]) {
    if (typeof el.value === 'string') el.value = head3(el.value) + sugPart(sug);
  }
  return out;
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
  const blocks = rebuild(m.blocks, sug, why);
  if (JSON.stringify(blocks).length > 12_000) throw new CardError('too_long', 'The rewritten card would be past Slack\'s size limit; nothing was sent.');
  const line = sug && !sug.none ? sug.line ?? null : null;
  if (b.dry_run === true) return { ok: true, dry_run: true, submission_id: id, channel, ts, line, blocks_before: m.blocks.length, blocks_after: blocks.length };
  const u = await slack.botCall('chat.update', { channel, ts, text: m.text ?? 'Builder log review', blocks });
  if (!u.ok) throw new CardError('slack_refused', `Slack refused the update: ${u.error}.`, 502);
  return { ok: true, updated: true, submission_id: id, channel, ts, line, link: `https://bayshorizonnetwork.slack.com/archives/${channel}/p${ts.replace('.', '')}` };
}
