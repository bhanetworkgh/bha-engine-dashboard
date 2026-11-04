/**
 * The automatic code check (4 Nov 2026, Destiny): a check that runs itself, with a person on the last step.
 *
 * A log is sent to n8n's `Code Check — Run` (POST /webhook/code-check-run), whose agent reads the log and the live
 * services with Bays' read tools and hands the finished check back through submit_code_check_draft. Bays posts it as
 * a card in #bha-code-reviews with two buttons, and only Destiny's click moves it:
 *
 *   Approve     Bays posts the check in the log's own thread and it is recorded, which runs the same Codex note,
 *               BHARAG note and reviewed card as a check Destiny sends himself.
 *   Send notes  Bays asks for his notes in the card's thread. His next reply goes back to the agent with the check,
 *               and the new round replaces the card. As many rounds as he likes; there is no reject.
 *
 * A click reuses the approval card's action ids with a CCD- value, so n8n's Bays — Front Door and Bays — Approval
 * Decision forward it unchanged to /api/engine/approvals/decide. Nothing reaches a builder's thread without Approve.
 *
 * Automatic starts are off until start_code_check turns them on, and then only for logs approved after that moment.
 * start_code_check also runs one log by hand, which is how older logs are checked. A run that hands nothing back in
 * RUN_LIMIT_MINUTES is failed and raised in the channel, never left looking busy.
 */
import { query } from './pg';
import { record } from './engineEvents';
import { getMeta, setMeta } from './db';
import * as slack from './slack';
import * as n8n from './n8n';
import * as cc from './codeChecks';
import * as watch from './codeCheckWatch';
import { readSince } from './decisionWatch';
import { CODE_CHECK_BRIEF } from './codeCheckBrief';

export const DRAFT_PREFIX = 'CCD-';
export const isDraftId = (id: string): boolean => id.startsWith(DRAFT_PREFIX) && id.length > DRAFT_PREFIX.length;
export const RUN_LIMIT_MINUTES = 30;
export const MAX_SECTION = 2900;
export const MAX_SECTIONS = 40;
const RUN_PATH = process.env.CODE_CHECK_RUN_PATH?.trim() || '/webhook/code-check-run';
const AUTO_KEY = 'code_check.auto_from';

export interface DraftRow {
  codex_entry_id: string;
  round: number;
  state: string;
  check_input: cc.CheckInput | null;
  draft_text: string | null;
  notes: string | null;
  card_channel: string | null;
  card_ts: string | null;
  notes_asked_ts: string | null;
  builder: string | null;
  detail: string | null;
}

const COLS = 'codex_entry_id, round, state, check_input, draft_text, notes, card_channel, card_ts, notes_asked_ts, builder, detail';
async function byId(id: string): Promise<DraftRow | null> {
  const r = await query<DraftRow>(`SELECT ${COLS} FROM engine_code_check_drafts WHERE codex_entry_id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** Pure: the check cut on line ends into pieces Slack will take as section blocks. */
export function splitSections(text: string, max = MAX_SECTION): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    for (let rest = line; ; rest = rest.slice(max)) {
      const piece = rest.slice(0, max);
      if (cur.length + piece.length + 1 > max && cur) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n${piece}` : piece;
      if (rest.length <= max) break;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Pure: the card for one round. */
export function cardBlocks(d: { codex_entry_id: string; builder: string | null; round: number; draft_text: string; log_url: string | null }): { text: string; blocks: unknown[] } {
  const who = d.builder ?? 'a builder';
  const parts = splitSections(d.draft_text);
  const shown = parts.slice(0, MAX_SECTIONS);
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `Code check ready: ${who}`.slice(0, 150) } },
    ...shown.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: `${DRAFT_PREFIX}${d.codex_entry_id}`, action_id: watch.ACTION_MARK },
        { type: 'button', text: { type: 'plain_text', text: 'Send notes' }, value: `${DRAFT_PREFIX}${d.codex_entry_id}`, action_id: 'engine_approval_deny' },
        ...(d.log_url ? [{ type: 'button', text: { type: 'plain_text', text: 'Open the log' }, url: d.log_url, action_id: 'code_check_open_log' }] : []),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Round ${d.round}. Approve posts this in the log's thread as Bays. Send notes sends it back with your notes.${parts.length > shown.length ? ' It is too long for one card, so the end is cut here; Approve still posts all of it.' : ''}` }] },
  ];
  return { text: `Code check ready: ${who}, ${d.codex_entry_id}, round ${d.round}.`, blocks };
}

/** Pure: a settled card, buttons gone. */
export function settledBlocks(line: string, who: string | null): { text: string; blocks: unknown[] } {
  return { text: line, blocks: [{ type: 'header', text: { type: 'plain_text', text: `Code check: ${who ?? 'a builder'}`.slice(0, 150) } }, { type: 'section', text: { type: 'mrkdwn', text: line } }] };
}

/** Pure: is this reply Destiny's notes? */
export function isNotes(m: { user?: string; bot_id?: string; subtype?: string; text?: string; ts?: string }, afterTs: number): boolean {
  return !m.bot_id && !m.subtype && m.user === cc.DESTINY && !!m.ts && Number(m.ts) > afterTs && !!m.text?.trim();
}

/** Pure: what the agent is asked to do this round. */
export function taskFor(d: { codex_entry_id: string; builder: string | null; round: number; previous: string | null; notes: string | null }): string {
  const first = `Run the code check on ${d.codex_entry_id}, ${d.builder ?? 'the builder'}'s log. Finish by calling submit_code_check_draft with round ${d.round}.`;
  return d.notes ? `${first}\n\nDestiny read the check below and sent these notes. Follow them, check anything they point at against the live source, and submit the whole check again.\n\nHIS NOTES:\n${d.notes}\n\nTHE CHECK HE READ:\n${d.previous ?? ''}` : first;
}

async function raiseInChannel(text: string): Promise<void> {
  const r = await slack.botCall('chat.postMessage', { channel: watch.CHANNEL(), text: `<@${cc.DESTINY}> ${text}`, unfurl_links: false });
  if (!r.ok) console.error(`[code-check-draft] could not raise: ${text} (${String(r.error)})`);
}

export type Sender = (body: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>;
const sendToN8n: Sender = async (body) => {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return { ok: false, detail: 'DASHBOARD_INBOUND_KEY is not set' };
  try {
    const r = await fetch(`${n8n.n8nHost()}${RUN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return r.ok ? { ok: true, detail: 'started' } : { ok: false, detail: `n8n answered ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

async function builderOf(id: string): Promise<string | null> {
  const r = await query<{ b: string | null }>(`SELECT fields->>'Builder Name' AS b FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`, [id]);
  return r.rows[0]?.b ?? null;
}

/** Sends one log to the agent. A log already running is left alone. */
export async function start(codexId: string, opts: { notes?: string | null; send?: Sender } = {}): Promise<{ ok: boolean; reason?: string; message: string; round?: number }> {
  const cur = await byId(codexId);
  if (cur?.state === 'running') return { ok: false, reason: 'already_running', message: `Round ${cur.round} of ${codexId} is already running.` };
  if (cur?.state === 'approved') return { ok: false, reason: 'already_approved', message: `${codexId} is already approved and posted.` };
  const builder = cur?.builder ?? (await builderOf(codexId));
  const round = (cur?.round ?? 0) + 1;
  await query(
    `INSERT INTO engine_code_check_drafts (codex_entry_id, round, state, builder, notes, started_at) VALUES ($1, $2, 'running', $3, $4, now())
     ON CONFLICT (codex_entry_id) DO UPDATE SET round = $2, state = 'running', notes = $4, started_at = now(), detail = NULL, notes_asked_ts = NULL`,
    [codexId, round, builder, opts.notes ?? null],
  );
  const sent = await (opts.send ?? sendToN8n)({ codex_entry_id: codexId, round, brief: CODE_CHECK_BRIEF, task: taskFor({ codex_entry_id: codexId, builder, round, previous: cur?.draft_text ?? null, notes: opts.notes ?? null }) });
  if (!sent.ok) {
    await query(`UPDATE engine_code_check_drafts SET state = 'failed', detail = $2 WHERE codex_entry_id = $1`, [codexId, sent.detail]);
    await raiseInChannel(`The code check on ${codexId} could not start: ${sent.detail}`);
    return { ok: false, reason: 'not_started', message: sent.detail };
  }
  await record({ event_type: 'code_check_draft_started', subject_id: codexId, lane: 'BAYS', actor: 'code-check-draft', detail: { round, with_notes: !!opts.notes } });
  return { ok: true, round, message: `Round ${round} of ${codexId} started.` };
}

async function logUrl(id: string): Promise<watch.LogPost | null> {
  const row = await query<{ ch: string | null; at: string | null }>(
    `SELECT NULLIF(fields->>'Builder Channel ID', '') AS ch, COALESCE(fields->>'Jason Reviewed At', fields->>'Processed At') AS at FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 ORDER BY updated_at DESC LIMIT 1`,
    [id],
  );
  return watch.findLogPost(id, row.rows[0]?.ch ?? null, row.rows[0]?.at ?? new Date().toISOString());
}

/** The agent hands the check back. Checked exactly as a recorded check is, so a bad one is refused before anyone sees it. */
export async function submit(i: cc.CheckInput & { draft_text?: unknown; round?: unknown }): Promise<Record<string, unknown>> {
  const id = typeof i.codex_entry_id === 'string' ? i.codex_entry_id.trim() : '';
  const cur = await byId(id);
  if (!cur || cur.state !== 'running') return { ok: false, reason: 'not_running', message: `No check is running for ${id}. Nothing was saved.` };
  if (Number(i.round) !== cur.round) return { ok: false, reason: 'wrong_round', message: `Round ${cur.round} is running, not ${String(i.round)}.` };
  const draft = typeof i.draft_text === 'string' ? i.draft_text.trim() : '';
  if (!watch.OPENS_CHECK.test(draft) || !draft.includes(id)) return { ok: false, reason: 'bad_draft', message: 'draft_text opens "*Code check:" and names the Codex ID.' };
  const { draft_text: _d, round: _r, ...fields } = i;
  const check = { ...fields, requester_user_id: cc.DESTINY };
  const post = await logUrl(id);
  try {
    const dry = await cc.recordCheck({ ...check, check_link: post?.url ?? `https://bayshorizonnetwork.slack.com/archives/${watch.CHANNEL()}` }, { dry_run: true });
    const c = watch.compareSent(draft, draft, dry.check.verdict as cc.Verdict, dry.check.pay_call as cc.PayCall, dry.check.bays_summary?.approve);
    if (c.conflict) return { ok: false, reason: 'draft_disagrees', message: c.conflict.replace('what went out', 'the draft') };
  } catch (e) {
    if (e instanceof cc.CodeCheckError) return { ok: false, reason: e.reason, message: `${e.message} Fix it and submit again.` };
    throw e;
  }
  const m = cardBlocks({ codex_entry_id: id, builder: cur.builder, round: cur.round, draft_text: draft, log_url: post?.url ?? null });
  if (cur.card_ts && cur.card_channel) await slack.botCall('chat.update', { channel: cur.card_channel, ts: cur.card_ts, ...settledBlocks(`Round ${cur.round - 1} was replaced by round ${cur.round}.`, cur.builder) });
  const posted = await slack.botCall('chat.postMessage', { channel: watch.CHANNEL(), text: m.text, blocks: m.blocks, unfurl_links: false, unfurl_media: false });
  if (!posted.ok) return { ok: false, reason: 'card_not_posted', raise: true, message: `Slack refused the card: ${String(posted.error)}` };
  await query(`UPDATE engine_code_check_drafts SET state = 'ready', check_input = $2::jsonb, draft_text = $3, card_channel = $4, card_ts = $5 WHERE codex_entry_id = $1`, [id, JSON.stringify(check), draft, watch.CHANNEL(), String(posted.ts)]);
  await record({ event_type: 'code_check_draft_ready', subject_id: id, lane: 'BAYS', actor: 'code-check-draft', detail: { round: cur.round, verdict: check.verdict, pay_call: check.pay_call } });
  return { ok: true, saved: true, message: `Round ${cur.round} of ${id} is in #bha-code-reviews for Destiny.` };
}

export interface ClickResult { status: number; body: Record<string, unknown> }

/** One click on a draft card. Only Destiny; one claim per click, so a double click posts once. */
export async function click(input: { id: string; decision: 'approve' | 'deny'; user_id: string }): Promise<ClickResult> {
  const id = input.id.slice(DRAFT_PREFIX.length);
  const cur = await byId(id);
  const say = async (text: string) => {
    if (cur?.card_channel) await slack.botCall('chat.postEphemeral', { channel: cur.card_channel, user: input.user_id, text });
  };
  if (input.user_id !== cc.DESTINY) {
    await say(`Only <@${cc.DESTINY}> reviews this one. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'not_allowed', raise: false, message: 'Not Destiny. Nothing was changed.' } };
  }
  const next = input.decision === 'approve' ? 'posting' : 'awaiting_notes';
  const claim = await query(`UPDATE engine_code_check_drafts SET state = $2 WHERE codex_entry_id = $1 AND state = 'ready' RETURNING 1`, [id, next]);
  if (!claim.rows.length || !cur) {
    await say(`This one is already ${cur?.state ?? 'gone'}. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'not_ready', raise: false, message: `State is ${cur?.state ?? 'unknown'}. Nothing was changed.` } };
  }
  return input.decision === 'approve' ? approve(id, cur) : askForNotes(id, cur);
}

async function askForNotes(id: string, cur: DraftRow): Promise<ClickResult> {
  const r = await slack.botCall('chat.postMessage', { channel: cur.card_channel, thread_ts: cur.card_ts, text: `<@${cc.DESTINY}> Reply here with your notes and I'll send the check back with them.` });
  if (!r.ok) {
    await query(`UPDATE engine_code_check_drafts SET state = 'ready' WHERE codex_entry_id = $1`, [id]);
    return { status: 200, body: { ok: false, reason: 'not_posted', raise: true, message: `Slack refused the ask for notes: ${String(r.error)}` } };
  }
  await query(`UPDATE engine_code_check_drafts SET notes_asked_ts = $2 WHERE codex_entry_id = $1`, [id, String(r.ts)]);
  return { status: 200, body: { ok: true, done: true, raise: false, message: 'Waiting for notes.' } };
}

async function approve(id: string, cur: DraftRow): Promise<ClickResult> {
  const back = async (detail: string) => {
    await query(`UPDATE engine_code_check_drafts SET state = 'ready', detail = $2 WHERE codex_entry_id = $1`, [id, detail]);
    await slack.botCall('chat.postMessage', { channel: cur.card_channel, thread_ts: cur.card_ts, text: `<@${cc.DESTINY}> The check did not post: ${detail} Nothing went to the builder's thread. Click Approve to try again.` });
    return { status: 200, body: { ok: false, reason: 'not_posted', raise: true, message: detail } };
  };
  const post = await logUrl(id);
  if (!post) return back(`The posted Codex for ${id} was not found in its log channel.`);
  const sent = await slack.botCall('chat.postMessage', { channel: post.channel, thread_ts: post.ts, text: cur.draft_text, unfurl_links: false, unfurl_media: false });
  if (!sent.ok) return back(`Slack refused it: ${String(sent.error)}.`);
  const ts = String(sent.ts);
  const link = `${post.url.split('/p')[0]}/p${ts.replace('.', '')}?thread_ts=${post.ts}&cid=${post.channel}`;
  try {
    const r = await cc.recordCheck({ ...(cur.check_input as cc.CheckInput), check_link: link, posted_at: new Date(Number(ts) * 1000).toISOString(), requester_user_id: cc.DESTINY });
    const a = await watch.afterRecord(r.check);
    const missed = [a.codex_note.ok ? null : `Codex: ${a.codex_note.detail}`, a.bharag_note.ok ? null : `BHARAG: ${a.bharag_note.detail}`, a.review_card.ok ? null : `the alert card: ${a.review_card.detail}`].filter(Boolean);
    await query(`UPDATE engine_code_check_drafts SET state = 'approved', detail = $2 WHERE codex_entry_id = $1`, [id, missed.length ? missed.join('; ') : 'recorded']);
    const line = `:white_check_mark: Approved and posted in the log's thread. <${link}|Open it>.${missed.length ? ` Not everything landed: ${missed.join('; ')}.` : ''}`;
    await slack.botCall('chat.update', { channel: cur.card_channel, ts: cur.card_ts, ...settledBlocks(line, cur.builder) });
    return { status: 200, body: { ok: true, done: true, raise: missed.length > 0, message: line } };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await query(`UPDATE engine_code_check_drafts SET state = 'failed', detail = $2 WHERE codex_entry_id = $1`, [id, detail]);
    await raiseInChannel(`The check on ${id} is in the log's thread but was not recorded: ${detail} ${link}`);
    return { status: 200, body: { ok: false, reason: 'not_recorded', raise: true, message: detail } };
  }
}

/* --------------------------------------------------------------- the sweep */

export async function autoFrom(): Promise<string | null> {
  return (await getMeta(AUTO_KEY).catch(() => null)) || null;
}
export async function setAuto(on: boolean, by: string): Promise<string | null> {
  const from = on ? new Date().toISOString() : '';
  await setMeta(AUTO_KEY, from);
  await record({ event_type: on ? 'code_check_auto_on' : 'code_check_auto_off', subject_id: AUTO_KEY, lane: 'BAYS', actor: by, detail: { from } });
  return from || null;
}

/** One pass: notes that arrived, runs that went quiet, and new approvals once automatic starts are on. */
export async function sweep(opts: { read?: typeof readSince; send?: Sender } = {}): Promise<void> {
  const read = opts.read ?? readSince;
  const waiting = await query<DraftRow>(`SELECT ${COLS} FROM engine_code_check_drafts WHERE state = 'awaiting_notes' AND notes_asked_ts IS NOT NULL`);
  for (const d of waiting.rows) {
    const seen = await read(d.card_channel as string, d.card_ts as string, d.notes_asked_ts as string);
    if (!seen.ok) { console.error(`[code-check-draft] ${d.codex_entry_id}: ${seen.error}`); continue; }
    const notes = seen.messages.filter((m) => isNotes(m, Number(d.notes_asked_ts))).map((m) => m.text as string).join('\n\n');
    if (notes) await start(d.codex_entry_id, { notes, send: opts.send });
  }
  const stuck = await query<{ codex_entry_id: string; round: number }>(`UPDATE engine_code_check_drafts SET state = 'failed', detail = 'no check came back' WHERE state = 'running' AND started_at < now() - ($1 || ' minutes')::interval RETURNING codex_entry_id, round`, [String(RUN_LIMIT_MINUTES)]);
  for (const s of stuck.rows) await raiseInChannel(`Round ${s.round} of the code check on ${s.codex_entry_id} gave nothing back in ${RUN_LIMIT_MINUTES} minutes. It stays waiting for a check.`);
  const from = await autoFrom();
  if (!from) return;
  const { due } = await watch.due();
  const held = await query<{ codex_entry_id: string }>(`SELECT codex_entry_id FROM engine_code_check_drafts`);
  const have = new Set(held.rows.map((r) => r.codex_entry_id));
  for (const d of due) if (!have.has(d.codex_entry_id) && Date.parse(d.approved_at) >= Date.parse(from)) await start(d.codex_entry_id, { send: opts.send });
}
