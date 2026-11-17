/**
 * Genie's direct tools wait on a person (17 Nov 2026, Destiny — Genie rebuild step 6.1). Genie reaches GitHub,
 * Render, n8n, Supabase, Twilio and ElevenLabs through their own MCP servers. Reading runs freely; a call that
 * changes something (a deploy, a published workflow, a merged change, a sent message) is not made. Genie stores
 * it here, posts an Approve / Deny card in the thread it was asked in, and makes the call only once Destiny or
 * Jason approves. Stripe is read only and never reaches this table.
 *
 * Held here, not in Genie, so a request outlives a Genie deploy and every outcome is on the dashboard:
 * - one row per request; the same call still pending is the same request (a unique index on its digest);
 * - only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) decide, checked here and by the table's CHECK;
 * - the claim is one UPDATE … WHERE status = 'pending', so two clicks, or two Genie instances, cannot both win;
 * - a click by anyone else changes nothing and is kept in attempts;
 * - 24 hours with no answer is expired, and an expired request is never run;
 * - every step is one engine event (lane GENIE).
 */
import { createHash } from 'node:crypto';
import { query } from './pg';
import * as engineEvents from './engineEvents';

export const APPROVERS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
export const APPROVAL_EVENTS = ['genie_approval_requested', 'genie_approval_decided', 'genie_approval_finished', 'genie_approval_expired'];

type Row = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const CHANNEL = /^[CGD][A-Z0-9]{6,}$/;
const NAME = /^[a-z0-9_-]{1,40}$/;

export class ApprovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function log(type: string, id: string, actor: string, detail: Row): Promise<void> {
  await engineEvents.record({ event_type: type, subject_id: id, lane: 'GENIE', actor, source_ref: 'genie-approvals', detail });
}

/** The same server, tool and arguments are the same request. Pure. */
export function digestOf(server: string, tool: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([server, tool, args ?? {}])).digest('hex');
}

/** Stores a held call. A repeat of one still pending answers that request, so no second card is posted. */
export async function request(b: Row): Promise<Row> {
  const server = str(b.server, 40);
  const tool = str(b.tool, 120);
  const channel = str(b.channel_id, 40);
  if (!NAME.test(server)) throw new ApprovalError(422, 'server is required: the MCP server id.');
  if (!tool) throw new ApprovalError(422, 'tool is required.');
  if (!CHANNEL.test(channel)) throw new ApprovalError(422, 'channel_id is required: where the approval card is posted.');
  const summary = str(b.summary, 1500) || `${server}: ${tool}`;
  const args = b.args && typeof b.args === 'object' ? b.args : {};
  const digest = digestOf(server, tool, args);
  const held = await query<Row>(`SELECT id, card_ts FROM engine_genie_approvals WHERE digest = $1 AND status = 'pending' AND expires_at > now()`, [digest]);
  if (held.rows[0]) return { ok: true, id: held.rows[0].id, repeat: true, card_ts: held.rows[0].card_ts };
  const id = `GAP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  await query(
    `INSERT INTO engine_genie_approvals (id, server, tool, args, summary, channel_id, thread_ts, requester, request_id, digest)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
    [id, server, tool, JSON.stringify(args), summary, channel, str(b.thread_ts, 40) || null, str(b.requester, 40) || null, str(b.request_id, 80) || null, digest],
  );
  await log('genie_approval_requested', id, str(b.requester, 40) || 'genie', { server, tool, summary, channel_id: channel, thread_ts: str(b.thread_ts, 40) || null });
  return { ok: true, id, repeat: false };
}

export async function setCard(b: Row): Promise<Row> {
  await query(`UPDATE engine_genie_approvals SET card_ts = $2 WHERE id = $1`, [str(b.id, 60), str(b.card_ts, 40) || null]);
  return { ok: true };
}

/**
 * Approve or deny. Only an approver changes anything; the claim is one statement. Approved hands back the stored
 * call (server, tool, args) for Genie to make; Genie reports the result with finish().
 */
export async function decide(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const who = str(b.decider, 40);
  const decision = str(b.decision, 10);
  if (decision !== 'approve' && decision !== 'deny') throw new ApprovalError(422, 'decision is approve or deny.');
  const r = await query<Row>(`SELECT * FROM engine_genie_approvals WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found', message: `No approval ${id}.` };
  if (!APPROVERS.has(who)) {
    await query(`UPDATE engine_genie_approvals SET attempts = attempts || $2::jsonb WHERE id = $1`, [id, JSON.stringify([{ by: who, at: new Date().toISOString(), decision }])]);
    return { ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason can approve or deny this.' , row };
  }
  if (row.status !== 'pending') return { ok: false, reason: 'already_decided', message: `This was already ${String(row.status)}.`, row };
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    await query(`UPDATE engine_genie_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [id]);
    await log('genie_approval_expired', id, 'genie', { server: row.server, tool: row.tool });
    return { ok: false, reason: 'expired', message: 'This request is over 24 hours old and has expired. Ask Genie again.', row };
  }
  const status = decision === 'approve' ? 'approved' : 'denied';
  const claimed = await query<Row>(
    `UPDATE engine_genie_approvals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, who],
  );
  if (!claimed.rows[0]) return { ok: false, reason: 'already_decided', message: 'Someone decided this a moment ago.' };
  await log('genie_approval_decided', id, who, { decision: status, server: row.server, tool: row.tool, summary: row.summary });
  return { ok: true, decision: status, row: claimed.rows[0] };
}

/** What happened once an approved call was made. A call never claimed approved is refused. */
export async function finish(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const ok = b.ok === true;
  const r = await query<Row>(
    `UPDATE engine_genie_approvals SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1 AND status = 'approved' RETURNING id, server, tool`,
    [id, ok ? 'done' : 'failed', str(b.result, 4000) || null, ok ? null : str(b.error, 2000) || 'no reason given'],
  );
  if (!r.rows[0]) return { ok: false, reason: 'not_approved', message: `${id} is not waiting on a result.` };
  await log('genie_approval_finished', id, 'genie', { ok, server: r.rows[0].server, tool: r.rows[0].tool, error: ok ? null : str(b.error, 500) });
  return { ok: true };
}

/** Requests past 24 hours with no answer. Genie rewrites their cards. */
export async function expire(): Promise<Row> {
  const r = await query<Row>(`UPDATE engine_genie_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING id, server, tool, channel_id, card_ts, summary`);
  for (const row of r.rows) await log('genie_approval_expired', String(row.id), 'genie', { server: row.server, tool: row.tool });
  return { ok: true, expired: r.rows };
}

export async function list(): Promise<Row[]> {
  const r = await query<Row>(`SELECT id, server, tool, summary, channel_id, thread_ts, requester, status, decided_by, decided_at, result, error, created_at, finished_at
      FROM engine_genie_approvals ORDER BY created_at DESC LIMIT 100`);
  return r.rows;
}
