/**
 * Stage 3, the proposal (17 Oct 2026, Destiny — Jason in #bha-coordination, 17 Oct:
 * "Stage 3 is us answering back with 'this is the setup that fits your site' (Canon-Locked
 * setups only) and 'this is its price'. From there they can accept and move to Stage 4, ask
 * the Customer Service Twin questions, or request a call as an optional branch. Stage 3 is
 * non-transactional." SOP 66570ea2; the flow is SOP 09cb58a7).
 *
 * - **One private page per lead**, `/proposal/<token>`, built like Form 2: no login, the link is
 *   the lock, the token an HMAC of the proposal id under `INTAKE2_LINK_SECRET` (no new secret),
 *   and only its sha256 is stored. Any link that opens nothing gets the same "not valid" page.
 * - **Made only for a lead in Stage 3** (Form 2 in, moved on by a person once the five checks
 *   cleared), never closed. A new proposal replaces the old one and the old link stops working.
 * - **Every proposal is marked test until Canon Lock exists.** No setup is Canon-Locked yet, so
 *   nothing here can be a real offer: the page says so in a banner on every view. `test` is not
 *   a field a caller can turn off.
 * - **Non-transactional.** Three buttons: Accept (the lead moves to Stage 4, where the
 *   templated agreement and their own Stripe link belong), Ask a question, Request a call.
 *   Nothing on this page takes a payment or shows a payment link.
 * - **Every action is recorded on the lead and posted in #vfarm-early-access as Bays**, with the
 *   post's outcome written back. Accept is once; a second Accept answers "already accepted".
 */
import { createHash, createHmac } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as leadFlow from './leadFlow';
import * as events from './events';
import * as slack from './slack';
import * as intake2 from './intake2';
import { brandedPage, escapeHtml as esc, notValidPage } from './intake2Page';

const ALERT_CHANNEL = () => process.env.INTAKE2_ALERT_CHANNEL?.trim() || 'C0C36GPEB3L';
const base = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class ProposalError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

export type DecisionKind = 'accepted' | 'question' | 'call';

export interface ProposalAction {
  kind: DecisionKind;
  at: string;
  text: string | null;
  notified: { ts: string | null; error: string | null } | null;
  /**
   * A buyer's question has a named owner from the moment it lands (23 Oct 2026, Jason; SOP
   * c803d029): Destiny by default, Jason as backstop. Set on questions only.
   */
  assignee?: { slack_id: string; name: string; backstop_slack_id: string; backstop_name: string };
}

/** Who answers a buyer's Stage 3 question (SOP c803d029). One place, so the record and the post agree. */
export const QUESTION_OWNER = { slack_id: 'U0AEW3TBYH1', name: 'Destiny Arupi', backstop_slack_id: 'U0A9V97949F', backstop_name: 'Jason Bays' } as const;

/** What the buyer is told after asking, word for word from Jason (23 Oct 2026). */
export const QUESTION_RECEIVED = "We've received your question. A member of the team will reply by email. For now this is manual and not instant.";

export interface Proposal {
  proposal_id: string;
  test: true;
  setup_name: string;
  summary: string;
  inclusions: string[];
  price_amount: number;
  currency: string;
  timeline: string | null;
  created_at: string;
  created_by: string;
  opened_at: string | null;
  accepted_at: string | null;
  actions: ProposalAction[];
  token_sha256: string;
}

function secret(): string {
  const s = process.env[intake2.SECRET_VAR]?.trim();
  if (!s) throw new ProposalError(503, 'not_configured', `${intake2.SECRET_VAR} is not set on this server, so no proposal link can be made.`);
  return s;
}
export function tokenFor(proposalId: string): string {
  return createHmac('sha256', secret()).update(`proposal:${proposalId}`).digest('base64url');
}
export const linkFor = (token: string) => `${base()}/proposal/${token}`;

/** What the page may show about a proposal: never the hash, always the link (worked out again). */
export function forPage(p: Proposal | null): (Omit<Proposal, 'token_sha256'> & { link: string }) | null {
  if (!p) return null;
  const { token_sha256: _drop, ...rest } = p;
  let link = '';
  try {
    link = linkFor(tokenFor(p.proposal_id));
  } catch {
    link = `(${intake2.SECRET_VAR} is not set, so the link cannot be shown)`;
  }
  return { ...rest, link };
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

export interface ProposalInput {
  setup_name?: unknown;
  summary?: unknown;
  inclusions?: unknown;
  price_amount?: unknown;
  currency?: unknown;
  timeline?: unknown;
}

/** Check a proposal's fields. Pure. Price is in the smallest unit (cents). */
export function validate(input: ProposalInput): Pick<Proposal, 'setup_name' | 'summary' | 'inclusions' | 'price_amount' | 'currency' | 'timeline'> {
  const setup_name = clean(input.setup_name, 120);
  const summary = clean(input.summary, 2000);
  if (setup_name.length < 3) throw new ProposalError(422, 'setup_name', 'Name the setup (3 to 120 characters).');
  if (summary.length < 10) throw new ProposalError(422, 'summary', 'Say what the setup is and why it fits their site (10 to 2,000 characters).');
  const rawInc = Array.isArray(input.inclusions) ? input.inclusions : typeof input.inclusions === 'string' ? input.inclusions.split('\n') : [];
  const inclusions = rawInc.map((x) => clean(x, 200)).filter(Boolean).slice(0, 20);
  const price = Number(input.price_amount);
  if (!Number.isInteger(price) || price < 100 || price > 100_000_000) throw new ProposalError(422, 'price_amount', 'The price is whole cents, at least 100 (1.00) and at most 100,000,000.');
  const currency = (clean(input.currency, 3) || 'usd').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new ProposalError(422, 'currency', 'The currency is a three-letter code, such as usd.');
  const timeline = clean(input.timeline, 300) || null;
  return { setup_name, summary, inclusions, price_amount: price, currency, timeline };
}

async function post(text: string): Promise<{ ts: string | null; error: string | null }> {
  const r = await slack.botCall('chat.postMessage', { channel: ALERT_CHANNEL(), text, unfurl_links: false }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), http_status: 0 }));
  if (!r.ok) console.error(`[proposal] alert not posted: ${r.error}`);
  return r.ok ? { ts: String((r as { ts?: unknown }).ts ?? ''), error: null } : { ts: null, error: String(r.error ?? 'unknown') };
}

const money = (cents: number, cur: string) => `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur.toUpperCase()}`;

/** Make (or replace) the proposal for a lead in Stage 3. */
export async function create(leadId: string, input: ProposalInput, by: string): Promise<{ proposal: ReturnType<typeof forPage>; replaced: string | null }> {
  const who = clean(by, 120) || 'the dashboard login';
  const fields = validate(input);
  secret();
  const out = await withTransaction(async (db) => {
    const r = await db.query<{ id: string; stage: number; closed_at: Date | null; intake_2_completed_at: Date | null; buyer: string | null; proposal: Proposal | null }>(
      `SELECT id::text AS id, stage, closed_at, intake_2_completed_at, form_a->>'buyer_intake_id' AS buyer, proposal FROM engine_vfarm_leads WHERE id::text = $1 FOR UPDATE`,
      [leadId],
    );
    const row = r.rows[0];
    if (!row) throw new ProposalError(404, 'not_found', 'No lead with that id.');
    if (row.closed_at) throw new ProposalError(409, 'closed', 'That lead is closed. Reopen it first.');
    if (row.stage !== 3) throw new ProposalError(409, 'not_stage_3', `A proposal is made for a lead in Stage 3 (Form 2 in and the five checks cleared). This lead is in Stage ${row.stage}.`);
    if (!row.intake_2_completed_at) throw new ProposalError(409, 'no_form_2', 'This lead has not sent Form 2, so there is no site to propose against.');
    const n = (row.proposal?.proposal_id?.match(/-(\d+)$/)?.[1] ?? '0') as string;
    const suffix = (row.buyer ?? row.id).replace(/^VFBUYER-/, '').replace(/[^A-Za-z0-9-]/g, '');
    const proposal_id = `VFPROP-${suffix}-${Number(n) + 1}`;
    const token = tokenFor(proposal_id);
    const p: Proposal = { proposal_id, test: true, ...fields, created_at: new Date().toISOString(), created_by: who, opened_at: null, accepted_at: null, actions: [], token_sha256: sha(token) };
    await db.query(`UPDATE engine_vfarm_leads SET proposal = $2::jsonb WHERE id::text = $1`, [leadId, JSON.stringify(p)]);
    await engineEvents.record(
      { event_type: 'vfarm_proposal_made', subject_id: row.buyer ?? row.id, lane: 'VFARM', actor: who, detail: { lead_id: row.id, proposal_id, replaced: row.proposal?.proposal_id ?? null, test: true, price_amount: p.price_amount, currency: p.currency }, dedupe_key: `proposal:${proposal_id}` },
      db,
    );
    return { p, replaced: row.proposal?.proposal_id ?? null };
  });
  events.changed('vfarm_leads', leadId);
  return { proposal: forPage(out.p), replaced: out.replaced };
}

type Found = { id: string; full_name: string; organization_name: string | null; buyer: string | null; stage: number; closed_at: Date | null; proposal: Proposal };

async function byToken(token: string): Promise<Found | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const r = await query<Found>(
    `SELECT id::text AS id, full_name, organization_name, form_a->>'buyer_intake_id' AS buyer, stage, closed_at, proposal
       FROM engine_vfarm_leads WHERE proposal->>'token_sha256' = $1`,
    [sha(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // The token is re-derived from the stored id, so a hash match on a stale secret still fails here.
  try {
    if (tokenFor(row.proposal.proposal_id) !== token) return null;
  } catch {
    return null;
  }
  return row;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

function proposalBody(f: Found, flash: string | null): string {
  const p = f.proposal;
  const test = `<div class="banner bad"><strong>Test proposal.</strong> This is an internal test of the vFarm proposal page, not an offer. No setup is confirmed yet, and nothing here is a price you can buy at.</div>`;
  const inc = p.inclusions.length ? `<ul>${p.inclusions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  const card = `<section class="card"><h2>The setup that fits your site</h2>
<p style="font-size:20px;font-weight:600;margin:6px 0 4px">${esc(p.setup_name)}</p>
<p style="white-space:pre-wrap">${esc(p.summary)}</p>${inc}
<p style="font-size:18px;margin:14px 0 0"><strong>${esc(money(p.price_amount, p.currency))}</strong></p>
${p.timeline ? `<p class="status">${esc(p.timeline)}</p>` : ''}</section>`;
  const note = `<p class="note">This is a proposal, not a purchase. Nothing is charged on this page. If you accept, we will contact you by email about the next steps.</p>`;
  const done = p.accepted_at
    ? `<div class="done"><h2>Accepted</h2><p>Thank you. You accepted this proposal on ${esc(p.accepted_at.slice(0, 10))}. We will contact you by email about the next steps. You can still send us a question below.</p></div>`
    : `<form method="post" style="margin:0 0 18px"><input type="hidden" name="action" value="accept"><button class="btn" type="submit">Accept this proposal</button></form>`;
  const ask = `<section class="card"><h2>Ask a question</h2>
<form method="post"><input type="hidden" name="action" value="question"><textarea name="text" required minlength="3" maxlength="2000" placeholder="What would you like to know?"></textarea>
<p style="margin:10px 0 0"><button class="btn" type="submit" style="background:#fff;border-color:#c9c4b4">Send question</button></p></form></section>
<section class="card"><h2>Request a call</h2><p class="status">Prefer to talk it through? Tell us when suits you and we will get in touch.</p>
<form method="post"><input type="hidden" name="action" value="call"><textarea name="text" maxlength="1000" placeholder="Best times and how to reach you (optional)" style="min-height:64px"></textarea>
<p style="margin:10px 0 0"><button class="btn" type="submit" style="background:#fff;border-color:#c9c4b4">Request a call</button></p></form></section>`;
  const flashHtml = flash ? `<div class="note">${esc(flash)}</div>` : '';
  return `${test}${flashHtml}${card}${note}${done}${ask}<footer><strong>Bays Horizon Network</strong> · <a href="https://bhanetwork.org/vfarm">bhanetwork.org/vfarm</a> · questions: <a href="mailto:admin@bhanetwork.org">admin@bhanetwork.org</a></footer>`;
}

/** The page, for a GET. Marks the proposal opened the first time. Null when the link opens nothing. */
export async function page(token: string, flash: string | null = null): Promise<string | null> {
  const f = await byToken(token);
  if (!f || f.closed_at) return null;
  if (!f.proposal.opened_at) {
    await query(`UPDATE engine_vfarm_leads SET proposal = jsonb_set(proposal, '{opened_at}', to_jsonb($2::text)) WHERE id::text = $1 AND proposal->>'opened_at' IS NULL`, [f.id, new Date().toISOString()]);
    events.changed('vfarm_leads', f.id);
  }
  return brandedPage('Your proposal', `Your vFarm proposal, ${first(f.full_name)}`, `${f.organization_name ? `${esc(f.organization_name)} · ` : ''}Based on the site specification you sent us.`, proposalBody(f, flash));
}

export function notValid(): string {
  return notValidPage();
}

/** One buyer action from the page. Answers the flash line to show, or null when the link opens nothing. */
export async function act(token: string, actionRaw: unknown, textRaw: unknown): Promise<{ flash: string } | null> {
  const f = await byToken(token);
  if (!f || f.closed_at) return null;
  const kind = actionRaw === 'accept' ? 'accepted' : actionRaw === 'question' ? 'question' : actionRaw === 'call' ? 'call' : null;
  if (!kind) throw new ProposalError(422, 'action', 'Choose accept, a question or a call.');
  const text = clean(textRaw, kind === 'question' ? 2000 : 1000) || null;
  if (kind === 'question' && (!text || text.length < 3)) return { flash: 'Write your question first (at least 3 characters).' };
  if (kind === 'accepted' && f.proposal.accepted_at) return { flash: 'You have already accepted this proposal. We will contact you by email about the next steps.' };

  const at = new Date().toISOString();
  const moved = await withTransaction(async (db) => {
    const cur = await db.query<{ stage: number; proposal: Proposal }>(`SELECT stage, proposal FROM engine_vfarm_leads WHERE id::text = $1 FOR UPDATE`, [f.id]);
    const row = cur.rows[0];
    if (!row || row.proposal.proposal_id !== f.proposal.proposal_id) return 'replaced' as const;
    if (kind === 'accepted' && row.proposal.accepted_at) return 'already' as const;
    const action: ProposalAction = { kind, at, text, notified: null, ...(kind === 'question' ? { assignee: { ...QUESTION_OWNER } } : {}) };
    const p: Proposal = { ...row.proposal, accepted_at: kind === 'accepted' ? at : row.proposal.accepted_at, actions: [...row.proposal.actions, action].slice(-50) };
    let stageSql = '';
    const params: unknown[] = [f.id, JSON.stringify(p)];
    if (kind === 'accepted' && row.stage === 3) {
      stageSql = `, stage = 4, stage_changed_at = now(), stage_history = stage_history || $3::jsonb`;
      params.push(JSON.stringify([{ from: 3, to: 4, at, by: `${f.full_name} (accepted the proposal)`, reason: `Accepted ${row.proposal.proposal_id}`, via: 'buyer' }]));
    }
    await db.query(`UPDATE engine_vfarm_leads SET proposal = $2::jsonb${stageSql} WHERE id::text = $1`, params);
    if (stageSql) await leadFlow.recordStageMove(db, { lead_id: f.id, buyer_intake_id: f.buyer ?? null, from: 3, to: 4, at, by: 'buyer', via: 'buyer', reason: `Accepted ${row.proposal.proposal_id}` });
    await engineEvents.record(
      { event_type: `vfarm_proposal_${kind}`, at, subject_id: f.buyer ?? f.id, lane: 'VFARM', actor: 'buyer', detail: { lead_id: f.id, proposal_id: row.proposal.proposal_id, test: true, moved_to_stage_4: kind === 'accepted' && row.stage === 3, ...(kind === 'question' ? { assignee: QUESTION_OWNER.slack_id, backstop: QUESTION_OWNER.backstop_slack_id } : {}) }, dedupe_key: kind === 'accepted' ? `proposal-accepted:${row.proposal.proposal_id}` : null },
      db,
    );
    return 'ok' as const;
  });
  if (moved === 'replaced') return null;
  if (moved === 'already') return { flash: 'You have already accepted this proposal.' };
  events.changed('vfarm_leads', f.id);

  const p = f.proposal;
  const head = '*[Test proposal]* ';
  const title = kind === 'accepted' ? 'Proposal accepted (moved to Stage 4)' : kind === 'question' ? 'Question on a proposal' : 'Call requested on a proposal';
  const text2 = [
    `${head}*${title}*`,
    `*Name:* ${f.full_name}`,
    `*Organisation:* ${f.organization_name ?? 'not given'}`,
    `*Setup:* ${p.setup_name} · ${money(p.price_amount, p.currency)}`,
    ...(text ? [`*${kind === 'question' ? 'Question' : 'Note'}:* ${text}`] : []),
    `*Buyer:* ${f.buyer ?? 'unknown'} · ${p.proposal_id}`,
    '',
    kind === 'accepted'
      ? 'Next is Stage 4: the agreement and their own Stripe link. No payment has been taken.'
      : kind === 'question'
        ? `*Owner:* <@${QUESTION_OWNER.slack_id}> answers by email, <@${QUESTION_OWNER.backstop_slack_id}> as backstop. The buyer was told this is manual and not instant.`
        : 'Answer them by email. The Customer Service Twin is not wired to proposals yet.',
    `Record: ${base()}/vfarm?tab=early-access&lead=${f.id}`,
  ].join('\n');
  const notified = await post(text2);
  await query(
    `UPDATE engine_vfarm_leads SET proposal = jsonb_set(proposal, ARRAY['actions', (jsonb_array_length(proposal->'actions') - 1)::text, 'notified'], $2::jsonb) WHERE id::text = $1`,
    [f.id, JSON.stringify(notified)],
  ).catch((e) => console.error(`[proposal] could not store the alert outcome: ${e instanceof Error ? e.message : String(e)}`));
  return {
    flash:
      kind === 'accepted'
        ? 'Thank you, you accepted the proposal. We will contact you by email about the next steps.'
        : kind === 'question'
          ? QUESTION_RECEIVED
          : 'Thank you, we will get in touch to arrange a call.',
  };
}
