/**
 * Human approval for the three actions an agent must not take on its own
 * (2026-10-04, Destiny — LOOP-1790969736142-8185).
 *
 * `share_doc`, `grant_drive_access` and `delete_record` were gated by n8n's own
 * tool approval, which works by suspending the agent and waiting. Bays runs
 * inside a workflow (`Bays — Agent Delivery`), and n8n cannot suspend there:
 * the call died with "Agent execution suspended waiting for tool approval.
 * Suspend/resume is not supported in workflow execution context" (execution
 * 24683, 2 Oct). Nobody was ever asked, so the action could never go through.
 *
 * So the gate lives here, where the three actions already live:
 *
 *   1. An **agent** calls one of the three. Every check the tool already makes
 *      runs first, so a refusal is still an immediate refusal with no card.
 *   2. Nothing is done. A row is stored in `engine_approvals` and an
 *      Approve / Deny card is posted in Slack as Bays.
 *   3. The agent is answered `awaiting_approval` straight away, so it can say
 *      so plainly instead of hanging.
 *   4. A click reaches n8n's `Bays — Front Door` (Slack-signed), which posts
 *      it to `POST /api/engine/approvals/decide`. **Only Destiny or Jason may
 *      decide**, checked here, on the Slack id Slack itself signed.
 *   5. Approve runs the tool's own handler, in process, with the arguments
 *      stored at request time. Deny, or 24 hours with no answer, does nothing
 *      and says so on the card.
 *
 * **Only an agent token is gated.** The shared connector (Destiny through
 * Claude) and the page are already a person acting; gating them would be
 * asking a person to approve themselves.
 *
 * No silent failures: a card Slack refuses is `approval_card_not_posted` and
 * nothing is left pending behind it; an approved action that then fails is
 * written on the card in words and answered `raise: true`, which the n8n
 * workflow turns into an incident.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { query } from './pg';
import * as slack from './slack';
import * as quota from './quota';
import * as engineEvents from './engineEvents';
import { callerStore, currentAgent } from './mcp/caller';
import * as timers from './timers';

/** Destiny and Jason. The only two people whose click decides anything. */
export const APPROVERS: ReadonlyArray<string> = ['U0AEW3TBYH1', 'U0A9V97949F'];
export const GATED_TOOLS: ReadonlyArray<string> = ['share_doc', 'grant_drive_access', 'delete_record'];
export const TTL_HOURS = 24;
export const ACTION_APPROVE = 'engine_approval_approve';
export const ACTION_DENY = 'engine_approval_deny';
const SWEEP_MS = 5 * 60_000;
const WORKSPACE = (process.env.SLACK_WORKSPACE_URL || 'https://bayshorizonnetwork.slack.com').replace(/\/+$/, '');

/* ------------------------------------------------------- who is running */

interface ApprovedRun {
  approval_id: string;
  approver: string;
}
const approvedRun = new AsyncLocalStorage<ApprovedRun>();

/** Set while an approved request's handler runs, so the gate lets it through once. */
export function currentApproval(): ApprovedRun | null {
  return approvedRun.getStore() ?? null;
}

/** True when the caller is an agent and no person has approved this call. */
export function needsApproval(): boolean {
  return currentAgent() !== null && currentApproval() === null;
}

/**
 * How an approved request is run: the tool's own handler. Registered by
 * `mcp/tools.ts`, which is the only place that holds the catalogue, so this
 * file does not import the tools that import it.
 */
type Executor = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
let executor: Executor | null = null;
export function setExecutor(fn: Executor): void {
  executor = fn;
}

/* ----------------------------------------------------------------- rows */

export interface ApprovalRow {
  id: string;
  approval_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  summary: string;
  target: string | null;
  agent: string | null;
  requester_user_id: string | null;
  origin_channel: string | null;
  origin_thread_ts: string | null;
  card_channel: string | null;
  card_ts: string | null;
  card_thread_ts: string | null;
  card_error: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'card_failed';
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result_ok: boolean | null;
  result: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

const COLS = `id::text, approval_id, tool, arguments, summary, target, agent, requester_user_id, origin_channel, origin_thread_ts,
              card_channel, card_ts, card_thread_ts, card_error, status, decided_by, decided_at, executed_at, result_ok, result, created_at, expires_at`;

async function byId(approvalId: string): Promise<ApprovalRow | null> {
  const r = await query<ApprovalRow>(`SELECT ${COLS} FROM engine_approvals WHERE approval_id = $1`, [approvalId]);
  return r.rows[0] ?? null;
}

/** The newest requests, for a reader. */
export async function list(limit = 50): Promise<ApprovalRow[]> {
  const r = await query<ApprovalRow>(`SELECT ${COLS} FROM engine_approvals ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(200, limit))]);
  return r.rows;
}

function mintId(): string {
  return `APR-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;
}

/** The call, less the parts that say where to ask and whether to act. */
function canonical(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    if (k === 'dry_run' || k === 'channel_id' || k === 'thread_ts') continue;
    out[k] = args[k];
  }
  return out;
}

function digestOf(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ tool, args: canonical(args) })).digest('hex');
}

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isChannel = (v: string | null): v is string => v !== null && /^[CGD][A-Z0-9]{6,}$/.test(v);
const isTs = (v: string | null): v is string => v !== null && /^\d{9,11}\.\d{1,6}$/.test(v);

function permalink(channel: string, ts: string, threadTs: string | null): string {
  const base = `${WORKSPACE}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

async function event(type: string, row: { approval_id: string; tool: string; agent: string | null }, actor: string | null, detail: Record<string, unknown>): Promise<void> {
  try {
    await engineEvents.record({ event_type: type, subject_id: row.approval_id, lane: row.agent, actor, detail: { tool: row.tool, ...detail }, dedupe_key: `${type}:${row.approval_id}` });
  } catch (e) {
    // The event is a second record of what engine_approvals already holds; it never blocks the gate.
    console.error(`approvals: could not record ${type} for ${row.approval_id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ----------------------------------------------------------------- card */

const mention = (id: string) => `<@${id}>`;

function expiryText(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function cardBlocks(row: Pick<ApprovalRow, 'approval_id' | 'summary' | 'requester_user_id' | 'expires_at' | 'tool'>, askApprovers: boolean): unknown[] {
  const who = row.requester_user_id ? mention(row.requester_user_id) : 'nobody named';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:lock: *Approval needed*${askApprovers ? ` — ${APPROVERS.map(mention).join(' ')}` : ''}\nBays has been asked to *${row.summary}*.\nNothing has been done yet.` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Asked by ${who} · \`${row.tool}\` · \`${row.approval_id}\` · only ${APPROVERS.map(mention).join(' or ')} can decide · expires ${expiryText(row.expires_at)}` }] },
    {
      type: 'actions',
      block_id: `approval:${row.approval_id}`,
      elements: [
        { type: 'button', action_id: ACTION_APPROVE, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: row.approval_id },
        { type: 'button', action_id: ACTION_DENY, style: 'danger', text: { type: 'plain_text', text: 'Deny' }, value: row.approval_id },
      ],
    },
  ];
}

function settledBlocks(row: ApprovalRow, headline: string, line: string): unknown[] {
  const who = row.requester_user_id ? mention(row.requester_user_id) : 'nobody named';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${headline}\nBays was asked to *${row.summary}*.\n${line}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Asked by ${who} · \`${row.tool}\` · \`${row.approval_id}\`` }] },
  ];
}

async function updateCard(row: ApprovalRow, headline: string, line: string): Promise<string | null> {
  if (!row.card_channel || !row.card_ts) return 'the card was never posted';
  const text = `${headline} ${line}`.replace(/[*_`]/g, '');
  const r = await slack.botCall('chat.update', { channel: row.card_channel, ts: row.card_ts, text, blocks: settledBlocks(row, headline, line) });
  return r.ok ? null : `Slack refused the card update: ${String(r.error ?? 'unknown error')}`;
}

/** Tells the asker, where they asked, when the card had to live somewhere else. */
async function tellOrigin(row: ApprovalRow, text: string): Promise<string | null> {
  if (!row.origin_channel || row.origin_channel === row.card_channel) return null;
  const r = await slack.botCall('chat.postMessage', { channel: row.origin_channel, thread_ts: row.origin_thread_ts ?? undefined, text, unfurl_links: false, unfurl_media: false });
  return r.ok ? null : `Slack refused the note to where it was asked: ${String(r.error ?? 'unknown error')}`;
}

/* -------------------------------------------------------------- request */

export interface RequestInput {
  tool: string;
  args: Record<string, unknown>;
  /** What would happen, in plain words, finishing "Bays has been asked to …". */
  summary: string;
  target: string | null;
}

export type RequestResult =
  | { posted: true; already_pending: boolean; row: ApprovalRow; link: string }
  | { posted: false; error: string; approval_id: string | null };

/**
 * Stores the request and posts its card. Never performs the action. A request
 * identical to one still pending answers that one and posts nothing new, so an
 * agent that retries cannot stack cards.
 */
export async function request(input: RequestInput): Promise<RequestResult> {
  const digest = digestOf(input.tool, input.args);
  const agent = currentAgent();
  const requester = clean(input.args.requester_user_id);
  const originChannel = clean(input.args.channel_id);
  const originThread = clean(input.args.thread_ts);

  const held = await query<ApprovalRow>(`SELECT ${COLS} FROM engine_approvals WHERE args_digest = $1 AND status = 'pending' AND expires_at > now()`, [digest]);
  if (held.rows[0]?.card_channel && held.rows[0].card_ts) {
    const h = held.rows[0];
    return { posted: true, already_pending: true, row: h, link: permalink(h.card_channel as string, h.card_ts as string, h.card_thread_ts) };
  }

  if (!slack.slackConfigured()) return { posted: false, error: `${slack.SLACK_TOKEN_VAR} is not set on this server, so nobody can be asked to approve.`, approval_id: null };

  const approvalId = mintId();
  const insert = () =>
    query<ApprovalRow>(
      `INSERT INTO engine_approvals (approval_id, tool, arguments, args_digest, summary, target, agent, requester_user_id, origin_channel, origin_thread_ts, expires_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, now() + ($11 || ' hours')::interval)
       ON CONFLICT (args_digest) WHERE status = 'pending' DO NOTHING
       RETURNING ${COLS}`,
      [approvalId, input.tool, JSON.stringify(canonical(input.args)), digest, input.summary.slice(0, 1500), input.target, agent, requester, isChannel(originChannel) ? originChannel : null, isTs(originThread) ? originThread : null, String(TTL_HOURS)],
    );
  let row = (await insert()).rows[0];
  if (!row) {
    // Something still marked pending holds the slot and is not a live request:
    // one past its time, or one whose card never went out because the process
    // stopped between the insert and the post. Settle those, then take the slot.
    await sweepExpired();
    await query(
      `UPDATE engine_approvals SET status = 'card_failed', card_error = 'the card was never posted: the process stopped before Slack was asked'
        WHERE args_digest = $1 AND status = 'pending' AND card_ts IS NULL AND created_at < now() - interval '2 minutes'`,
      [digest],
    );
    row = (await insert()).rows[0];
    if (!row) return { posted: false, error: 'An identical request is being recorded by another call right now. Nothing was done; ask again in a moment.', approval_id: null };
  }

  /**
   * Where the card goes. The thread it was asked in, when that is a channel
   * the approvers can be in; a DM is only used when the asker is an approver,
   * because nobody else can open somebody's DM with Bays. Otherwise the
   * engine alerts channel.
   */
  const alerts = quota.channelId();
  const origin = row.origin_channel;
  const inThread = origin !== null && (origin.startsWith('D') ? requester !== null && APPROVERS.includes(requester) : true);
  const tries: { channel: string; thread: string | null }[] = [];
  if (inThread && origin) tries.push({ channel: origin, thread: row.origin_thread_ts });
  if (alerts && !tries.some((t) => t.channel === alerts)) tries.push({ channel: alerts, thread: null });
  if (!tries.length) {
    await query(`UPDATE engine_approvals SET status = 'card_failed', card_error = $2 WHERE approval_id = $1`, [approvalId, `${quota.CHANNEL_VAR} is not set and the ask named no Slack channel`]);
    return { posted: false, error: `There is nowhere to post the approval card: the ask named no Slack channel and ${quota.CHANNEL_VAR} is not set on this server.`, approval_id: approvalId };
  }

  const errors: string[] = [];
  for (const t of tries) {
    const ownThread = t.channel === origin && requester !== null && APPROVERS.includes(requester);
    const r = await slack.botCall('chat.postMessage', {
      channel: t.channel,
      thread_ts: t.thread ?? undefined,
      text: `Approval needed: Bays has been asked to ${row.summary}. Only Destiny or Jason can decide. (${approvalId})`,
      blocks: cardBlocks(row, !ownThread),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (r.ok && typeof r.ts === 'string') {
      const channel = typeof r.channel === 'string' ? r.channel : t.channel;
      const saved = await query<ApprovalRow>(`UPDATE engine_approvals SET card_channel = $2, card_ts = $3, card_thread_ts = $4, card_error = $5 WHERE approval_id = $1 RETURNING ${COLS}`, [
        approvalId,
        channel,
        r.ts,
        t.thread,
        errors.length ? errors.join(' | ') : null,
      ]);
      const done = saved.rows[0];
      await event('approval_requested', done, requester, { summary: done.summary, target: done.target, card_channel: channel, card_ts: r.ts });
      // Nothing is posted where it was asked at this point: the agent's own
      // reply says it is waiting and links the card. The decision is what the
      // asker would otherwise never hear, so that is what tellOrigin is for.
      return { posted: true, already_pending: false, row: done, link: permalink(channel, r.ts, t.thread) };
    }
    errors.push(`${t.channel}: ${String(r.error ?? 'unknown error')}`);
  }
  const why = `Slack refused the approval card (${errors.join(' | ')})`;
  await query(`UPDATE engine_approvals SET status = 'card_failed', card_error = $2 WHERE approval_id = $1`, [approvalId, why]);
  return { posted: false, error: `${why}. Nothing was done and nobody has been asked.`, approval_id: approvalId };
}

/**
 * What a gated tool answers instead of acting. `awaiting_approval` is an
 * answer, not a failure; `approval_card_not_posted` is a failure and reads
 * like one.
 */
export function pendingAnswer(r: RequestResult): { outcome: string; detail: string; answer: Record<string, unknown> } {
  if (!r.posted) {
    return {
      outcome: 'failed',
      detail: `approval card not posted: ${r.error}`,
      answer: { ok: false, done: false, reason: 'approval_card_not_posted', approval_id: r.approval_id, message: r.error },
    };
  }
  return {
    outcome: 'awaiting_approval',
    detail: `${r.row.approval_id}${r.already_pending ? ' (already pending)' : ''} — card ${r.link}`,
    answer: {
      ok: false,
      done: false,
      reason: 'awaiting_approval',
      approval_id: r.row.approval_id,
      already_pending: r.already_pending,
      approvers: [...APPROVERS],
      card_link: r.link,
      card_channel: r.row.card_channel,
      expires_at: r.row.expires_at,
      message:
        'Nothing has been done yet. This action needs a person: an Approve / Deny card is waiting in Slack (card_link), and only Destiny or Jason can decide. The result is posted on that card. This is an answer, not a tool failure — tell the person it is waiting and link the card, and do not call this again for the same thing.',
    },
  };
}

/* --------------------------------------------------------------- decide */

export interface DecideInput {
  approval_id: string;
  decision: 'approve' | 'deny';
  user_id: string;
  channel_id?: string | null;
}

export interface DecideResult {
  status: number;
  body: Record<string, unknown>;
}

async function ephemeral(channel: string | null | undefined, user: string, thread: string | null, text: string): Promise<void> {
  if (!channel) return;
  const r = await slack.botCall('chat.postEphemeral', { channel, user, thread_ts: thread ?? undefined, text });
  if (!r.ok) console.error(`approvals: could not tell ${user} "${text.slice(0, 60)}…": ${String(r.error)}`);
}

function resultLine(result: Record<string, unknown>): string {
  const link = typeof result.link === 'string' ? ` ${result.link}` : '';
  if (result.ok === true) {
    if (result.deleted === true) return `Deleted \`${String(result.natural_id ?? result.id)}\` (${String(result.kind)}). The whole row is kept in record_deletions.`;
    if (typeof result.permission_id === 'string' && typeof result.email === 'string') return `${String(result.email)} now has ${String(result.role)} access.`;
    if (typeof result.permission_id === 'string') return `Anyone with the link can now read it.${link}`;
    return 'Done.';
  }
  return String(result.message ?? result.reason ?? 'it failed, and the tool gave no reason');
}

/**
 * One click. The Slack id must be an approver's; the claim is one statement,
 * so two clicks cannot both win. Approve runs the tool; deny records the no.
 */
export async function decide(input: DecideInput): Promise<DecideResult> {
  const row = await byId(input.approval_id);
  if (!row) return { status: 404, body: { ok: false, reason: 'unknown_approval', raise: false, message: `No approval request is held under ${input.approval_id}.` } };

  if (!APPROVERS.includes(input.user_id)) {
    await query(`UPDATE engine_approvals SET attempts = attempts || $2::jsonb WHERE approval_id = $1`, [row.approval_id, JSON.stringify([{ user_id: input.user_id, decision: input.decision, at: new Date().toISOString(), refused: 'not_an_approver' }])]);
    await ephemeral(input.channel_id ?? row.card_channel, input.user_id, row.card_thread_ts, `Only ${APPROVERS.map(mention).join(' or ')} can decide this one. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'not_an_approver', raise: false, approval_id: row.approval_id, message: `${input.user_id} is not an approver. Nothing was changed.` } };
  }

  const next = input.decision === 'approve' ? 'approved' : 'denied';
  const claim = await query<ApprovalRow>(`UPDATE engine_approvals SET status = $2, decided_by = $3, decided_at = now() WHERE approval_id = $1 AND status = 'pending' AND expires_at > now() RETURNING ${COLS}`, [row.approval_id, next, input.user_id]);
  const claimed = claim.rows[0];
  if (!claimed) {
    const now = await byId(row.approval_id);
    const state = now?.status === 'pending' ? 'expired' : (now?.status ?? 'gone');
    if (now?.status === 'pending') await sweepExpired();
    await ephemeral(input.channel_id ?? row.card_channel, input.user_id, row.card_thread_ts, `This request was already ${state}${now?.decided_by ? ` by ${mention(now.decided_by)}` : ''}. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: `already_${state}`, raise: false, approval_id: row.approval_id, decided_by: now?.decided_by ?? null, message: `This request is already ${state}. Nothing was changed.` } };
  }

  const by = mention(input.user_id);
  if (next === 'denied') {
    const line = 'Nothing was done.';
    const cardError = await updateCard(claimed, `:no_entry_sign: *Denied* by ${by}`, line);
    const note = await tellOrigin(claimed, `:no_entry_sign: ${by} said no to that request (\`${claimed.approval_id}\`). Nothing was done.`);
    await event('approval_decided', claimed, input.user_id, { decision: 'denied' });
    const problems = [cardError, note].filter(Boolean);
    return { status: 200, body: { ok: true, decision: 'denied', done: false, raise: problems.length > 0, approval_id: claimed.approval_id, ...(problems.length ? { message: problems.join(' ') } : {}) } };
  }

  // Approved: run the tool's own handler, as the agent that asked, once.
  let result: Record<string, unknown>;
  if (!executor) {
    result = { ok: false, reason: 'no_executor', message: 'The tool catalogue was not loaded, so the approved action could not be run.' };
  } else {
    try {
      const run = executor;
      result = await callerStore.run({ agent: claimed.agent }, () => approvedRun.run({ approval_id: claimed.approval_id, approver: input.user_id }, () => run(claimed.tool, { ...claimed.arguments })));
    } catch (e) {
      result = { ok: false, reason: 'tool_threw', message: e instanceof Error ? e.message : String(e) };
    }
  }
  const ok = result.ok === true;
  const saved = await query<ApprovalRow>(`UPDATE engine_approvals SET executed_at = now(), result_ok = $2, result = $3::jsonb WHERE approval_id = $1 RETURNING ${COLS}`, [claimed.approval_id, ok, JSON.stringify(result)]);
  const done = saved.rows[0] ?? claimed;
  const line = resultLine(result);
  const cardError = await updateCard(done, ok ? `:white_check_mark: *Approved* by ${by} — done` : `:x: *Approved* by ${by}, but it failed`, ok ? line : `Nothing was changed: ${line}`);
  const note = await tellOrigin(done, ok ? `:white_check_mark: ${by} approved it (\`${done.approval_id}\`). ${line}` : `:x: ${by} approved it (\`${done.approval_id}\`), but it failed: ${line}`);
  await event('approval_decided', done, input.user_id, { decision: 'approved', result_ok: ok, reason: ok ? null : (result.reason ?? null) });
  const problems = [ok ? null : `The approved ${done.tool} failed: ${line}`, cardError, note].filter(Boolean);
  return {
    status: 200,
    body: { ok, decision: 'approved', done: ok, raise: problems.length > 0, approval_id: done.approval_id, tool: done.tool, result, ...(problems.length ? { message: problems.join(' ') } : {}) },
  };
}

/* ---------------------------------------------------------------- sweep */

/** Requests nobody decided in time: marked expired, and the card says so. */
export async function sweepExpired(): Promise<number> {
  const r = await query<ApprovalRow>(`UPDATE engine_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING ${COLS}`);
  for (const row of r.rows) {
    const line = `Nobody decided within ${TTL_HOURS} hours, so nothing was done. Ask again if it is still needed.`;
    const cardError = await updateCard(row, ':hourglass: *Expired*', line);
    if (cardError) console.error(`approvals: ${row.approval_id} expired: ${cardError}`);
    const note = await tellOrigin(row, `:hourglass: That request (\`${row.approval_id}\`) expired: ${line}`);
    if (note) console.error(`approvals: ${row.approval_id} expired: ${note}`);
    await event('approval_expired', row, null, {});
  }
  return r.rows.length;
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    sweepExpired().catch((e) => console.error(`approvals: sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  timer = setInterval(() => (timers.beat('approvals sweep'), tick()), SWEEP_MS);
  timer.unref();
  setTimeout(tick, 90_000).unref();
}
