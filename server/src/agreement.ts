/**
 * Stage 4, the signed agreement (28 Nov 2026, Destiny — LOOP-1792401352885-08KI; the agreement
 * templates moved here from NJJU in the consolidation Jason approved, #bha-coordination
 * 1792426037.993449; DocuSign was cancelled the same day, so the agreement is signed here).
 *
 * - **One private page per lead**, `/agreement/<token>`, built like the proposal page: no login,
 *   the link is the lock, the token an HMAC of the agreement id under `INTAKE2_LINK_SECRET`, only
 *   its sha256 stored, and any link that opens nothing gets the same "not valid" page.
 * - **Made only for a lead in Stage 4 whose proposal was accepted.** A new agreement replaces an
 *   unsigned one; a signed one is final and is never replaced.
 * - **The text is versioned and frozen.** `termsFor` writes it from the accepted proposal (setup,
 *   price) and Jason's approved offer (the monthly subscription), and the whole text is stored on
 *   the lead with its sha256. A signature is refused unless the stored text still hashes to that.
 * - **A real buyer's agreement waits on Jason** the same way a real proposal does: his newest real
 *   offer approval must be `approved` and its conditions must name `agreement_version` equal to
 *   `AGREEMENT_VERSION`, with `monthly_price_cents`. That is his yes to this exact text. A team
 *   test lead (an @bhanetwork.org address) gets a test agreement, marked on every view.
 * - **Signing records who, when and what**: the typed name, title and organisation, the version,
 *   the text's sha256, and one `vfarm_agreement_signed` event in the same transaction. It moves no
 *   stage and takes no payment. Stage 5 needs this signature and a paid deposit (`earlyAccess`).
 */
import { createHash, createHmac } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as events from './events';
import * as slack from './slack';
import * as intake2 from './intake2';
import * as proposal from './proposal';
import { brandedPage, escapeHtml as esc, notValidPage } from './intake2Page';

export const AGREEMENT_VERSION = 'VFARM-PILOT-AGREEMENT-v1';
export const PARTY = 'Bays Horizon Network LLC';

const ALERT_CHANNEL = () => process.env.INTAKE2_ALERT_CHANNEL?.trim() || 'C0C36GPEB3L';
const base = () => (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class AgreementError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
  }
}

export interface Signature {
  name: string;
  title: string | null;
  organisation: string | null;
  at: string;
}

export interface Agreement {
  agreement_id: string;
  version: string;
  test: boolean;
  offer_id: string | null;
  proposal_id: string;
  text: string;
  text_sha256: string;
  deposit_cents: number;
  currency: string;
  created_at: string;
  created_by: string;
  opened_at: string | null;
  signed: Signature | null;
  notified: { ts: string | null; error: string | null } | null;
  token_sha256: string;
}

type Offer = { verdict: string; offer_id: string | null; conditions?: unknown };

const cond = (o: Offer | null): Record<string, unknown> => (o && o.conditions && typeof o.conditions === 'object' && !Array.isArray(o.conditions) ? (o.conditions as Record<string, unknown>) : {});

export interface AgreementRule {
  team_test: boolean;
  can_make_real: boolean;
  offer_id: string | null;
  monthly_cents: number | null;
  reason: string;
}

/** Test or real, and whether a real agreement can be made now. Pure. */
export function rule(email: string | null | undefined, offer: Offer | null, unread = false): AgreementRule {
  if (proposal.isTeamTest(email)) return { team_test: true, can_make_real: false, offer_id: null, monthly_cents: null, reason: 'A team test lead: its agreement is marked test on every view and binds nobody.' };
  if (unread) return { team_test: false, can_make_real: false, offer_id: null, monthly_cents: null, reason: 'The charge gate could not be read just now, so no agreement can be made for a real buyer until it can.' };
  const c = cond(offer);
  if (!offer || offer.verdict !== 'approved' || !offer.offer_id) return { team_test: false, can_make_real: false, offer_id: null, monthly_cents: null, reason: 'Jason has not approved a live offer yet, so no agreement can be made for a real buyer.' };
  if (c.agreement_version !== AGREEMENT_VERSION) return { team_test: false, can_make_real: false, offer_id: offer.offer_id, monthly_cents: null, reason: `Jason's approved offer ${offer.offer_id} does not name agreement_version "${AGREEMENT_VERSION}" in its conditions, so this text is not approved for a real buyer.` };
  const m = Number(c.monthly_price_cents);
  if (!Number.isInteger(m) || m < 100) return { team_test: false, can_make_real: false, offer_id: offer.offer_id, monthly_cents: null, reason: `Jason's approved offer ${offer.offer_id} names no monthly_price_cents, so the agreement cannot state the subscription.` };
  return { team_test: false, can_make_real: true, offer_id: offer.offer_id, monthly_cents: m, reason: `A real agreement under Jason's approved offer ${offer.offer_id}, text ${AGREEMENT_VERSION}.` };
}

const money = (cents: number, cur: string) => `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur.toUpperCase()}`;

/**
 * The agreement text, v1. Pure. Terms from the Pilot 1 offer spec v1 (28 Nov 2026), for Jason's
 * approval: deposit half at signing, balance at commissioning, the subscription after 30
 * unattended days, a six-month term and the four refund and exit rules. Changing a word is a new
 * AGREEMENT_VERSION, which Jason must name again in his offer approval.
 */
export function termsFor(p: Pick<proposal.Proposal, 'setup_name' | 'summary' | 'inclusions' | 'price_amount' | 'currency' | 'timeline'>, buyer: { name: string; organisation: string | null }, monthlyCents: number | null): { text: string; deposit_cents: number } {
  const deposit = Math.round(p.price_amount / 2);
  const balance = p.price_amount - deposit;
  const who = buyer.organisation ? `${buyer.organisation} (signed for by ${buyer.name})` : buyer.name;
  const monthly = monthlyCents ? money(monthlyCents, p.currency) : 'not set (no approved offer names it)';
  const text = [
    `vFarm Pilot Agreement (${AGREEMENT_VERSION})`,
    '',
    `Between ${PARTY} ("BHA") and ${who} ("the Buyer").`,
    '',
    '1. What BHA provides',
    `1.1 The setup in the proposal the Buyer accepted: ${p.setup_name}. ${p.summary}`,
    ...(p.inclusions.length ? [`1.2 It includes: ${p.inclusions.join('; ')}.`] : []),
    '1.3 BHA builds, ships, installs and commissions it, and monitors it every day once installed.',
    '1.4 Commissioning is complete only when, for every rack: the per-visit checks of the operating guide are in place; the 14-day flush and between-crop clean are documented and followed; a 72-hour burn-in has passed; pH has been recalibrated; and 30 days of unattended monitoring have run, with the Buyer\'s operators reporting and BHA making every change.',
    '',
    '2. What the Buyer provides',
    '2.1 The space for the racks and a service aisle, power at the agreed feed, water, internet access, and on-site operators who watch and report.',
    '',
    '3. Price and payment',
    `3.1 One-time hardware and install price: ${money(p.price_amount, p.currency)}.`,
    `3.2 Deposit at signing: ${money(deposit, p.currency)}, half the price. This agreement takes effect when the deposit is paid.`,
    `3.3 Balance: ${money(balance, p.currency)}, due when commissioning signs off after the 72-hour burn-in.`,
    `3.4 Monthly monitoring subscription: ${monthly} for the site, starting the day after the 30 unattended days end.`,
    '3.5 Pilot term: six months of paid subscription.',
    ...(p.timeline ? [`3.6 Timeline as proposed: ${p.timeline}. No date is guaranteed.`] : []),
    '',
    '4. Not included',
    '4.1 No 24/7 on-call, no uptime percentage and no fixed repair time. No yield promise. On-site visits are arranged, not on demand. No rover or arm deliverables, custom analytics, self-serve configuration, fleet tools or third-party integrations.',
    '',
    '5. Refund and exit',
    '5.1 If BHA cannot get a rack through commissioning within 60 days of install, the Buyer may cancel that rack and get back its share of everything paid, and BHA removes it at BHA\'s cost.',
    '5.2 During the first 30 days of paid subscription the Buyer may stop the subscription with no further charge. The hardware is the Buyer\'s once it is paid for.',
    '5.3 After that, the subscription is month to month inside the term, cancellable on 30 days\' notice. Months already used are not refunded.',
    '5.4 If a rack is down for more than 7 days in a month for a reason on BHA\'s side, that rack\'s share of the month is credited on the next bill.',
    '',
    '6. Signing',
    '6.1 The Buyer signs by typing their full name below and ticking the box. BHA records the name, the time, this version and a fingerprint of this exact text.',
  ].join('\n');
  return { text, deposit_cents: deposit };
}

function secret(): string {
  const s = process.env[intake2.SECRET_VAR]?.trim();
  if (!s) throw new AgreementError(503, 'not_configured', `${intake2.SECRET_VAR} is not set on this server, so no agreement link can be made.`);
  return s;
}
export function tokenFor(agreementId: string): string {
  return createHmac('sha256', secret()).update(`agreement:${agreementId}`).digest('base64url');
}
export const linkFor = (token: string) => `${base()}/agreement/${token}`;

export function forPage(a: Agreement | null): (Omit<Agreement, 'token_sha256' | 'text'> & { link: string; text_chars: number }) | null {
  if (!a) return null;
  const { token_sha256: _t, text, ...rest } = a;
  let link = '';
  try {
    link = linkFor(tokenFor(a.agreement_id));
  } catch {
    link = `(${intake2.SECRET_VAR} is not set, so the link cannot be shown)`;
  }
  return { ...rest, link, text_chars: text.length };
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

async function post(text: string): Promise<{ ts: string | null; error: string | null }> {
  const r = await slack.botCall('chat.postMessage', { channel: ALERT_CHANNEL(), text, unfurl_links: false }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), http_status: 0 }));
  if (!r.ok) console.error(`[agreement] alert not posted: ${r.error}`);
  return r.ok ? { ts: String((r as { ts?: unknown }).ts ?? ''), error: null } : { ts: null, error: String(r.error ?? 'unknown') };
}

/** Make (or replace an unsigned) agreement for a lead in Stage 4. */
export async function create(leadId: string, by: string): Promise<{ agreement: ReturnType<typeof forPage>; replaced: string | null }> {
  const who = clean(by, 120) || 'the dashboard login';
  secret();
  const gate = await proposal.currentOfferFull();
  const out = await withTransaction(async (db) => {
    const r = await db.query<{ id: string; stage: number; closed_at: Date | null; buyer: string | null; email: string | null; name: string; org: string | null; proposal: proposal.Proposal | null; agreement: Agreement | null }>(
      `SELECT id::text AS id, stage, closed_at, form_a->>'buyer_intake_id' AS buyer, email, full_name AS name, organization_name AS org, proposal, agreement
         FROM engine_vfarm_leads WHERE id::text = $1 FOR UPDATE`,
      [leadId],
    );
    const row = r.rows[0];
    if (!row) throw new AgreementError(404, 'not_found', 'No lead with that id.');
    if (row.closed_at) throw new AgreementError(409, 'closed', 'That lead is closed. Reopen it first.');
    if (row.stage !== 4) throw new AgreementError(409, 'not_stage_4', `An agreement is made for a lead in Stage 4 (proposal accepted). This lead is in Stage ${row.stage}.`);
    if (!row.proposal?.accepted_at) throw new AgreementError(409, 'no_accepted_proposal', 'This lead has not accepted a proposal, so there is nothing to agree to.');
    if (row.agreement?.signed) throw new AgreementError(409, 'already_signed', `Agreement ${row.agreement.agreement_id} was signed on ${row.agreement.signed.at.slice(0, 10)}. A signed agreement is final and is never replaced.`);
    const rl = rule(row.email, gate.offer, gate.unread);
    if (!rl.team_test && !rl.can_make_real) throw new AgreementError(409, gate.unread ? 'gate_unread' : 'agreement_not_approved', rl.reason);
    if (!rl.team_test && row.proposal.test !== false) throw new AgreementError(409, 'test_proposal', 'A real agreement rests on a real proposal, and this lead\'s proposal is a test.');
    const n = Number(row.agreement?.agreement_id?.match(/-(\d+)$/)?.[1] ?? '0');
    const suffix = (row.buyer ?? row.id).replace(/^VFBUYER-/, '').replace(/[^A-Za-z0-9-]/g, '');
    const agreement_id = `VFAGR-${suffix}-${n + 1}`;
    const t = termsFor(row.proposal, { name: row.name, organisation: row.org }, rl.monthly_cents);
    const a: Agreement = {
      agreement_id, version: AGREEMENT_VERSION, test: rl.team_test, offer_id: rl.offer_id, proposal_id: row.proposal.proposal_id,
      text: t.text, text_sha256: sha(t.text), deposit_cents: t.deposit_cents, currency: row.proposal.currency,
      created_at: new Date().toISOString(), created_by: who, opened_at: null, signed: null, notified: null, token_sha256: sha(tokenFor(agreement_id)),
    };
    await db.query(`UPDATE engine_vfarm_leads SET agreement = $2::jsonb WHERE id::text = $1`, [leadId, JSON.stringify(a)]);
    await engineEvents.record(
      { event_type: 'vfarm_agreement_made', subject_id: row.buyer ?? row.id, lane: 'VFARM', actor: who, detail: { lead_id: row.id, agreement_id, version: AGREEMENT_VERSION, text_sha256: a.text_sha256, test: a.test, offer_id: a.offer_id, proposal_id: a.proposal_id, deposit_cents: a.deposit_cents, replaced: row.agreement?.agreement_id ?? null }, dedupe_key: `agreement:${agreement_id}` },
      db,
    );
    return { a, replaced: row.agreement?.agreement_id ?? null };
  });
  events.changed('vfarm_leads', leadId);
  return { agreement: forPage(out.a), replaced: out.replaced };
}

type Found = { id: string; full_name: string; organization_name: string | null; buyer: string | null; closed_at: Date | null; agreement: Agreement };

async function byToken(token: string): Promise<Found | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const r = await query<Found>(
    `SELECT id::text AS id, full_name, organization_name, form_a->>'buyer_intake_id' AS buyer, closed_at, agreement
       FROM engine_vfarm_leads WHERE agreement->>'token_sha256' = $1`,
    [sha(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  try {
    if (tokenFor(row.agreement.agreement_id) !== token) return null;
  } catch {
    return null;
  }
  return row;
}

function body(f: Found, flash: string | null): string {
  const a = f.agreement;
  const test = a.test ? `<div class="banner bad"><strong>Test agreement.</strong> This is an internal test of the vFarm agreement page. It binds nobody and nothing here is charged.</div>` : '';
  const flashHtml = flash ? `<div class="note">${esc(flash)}</div>` : '';
  const text = `<section class="card"><pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.55;margin:0">${esc(a.text)}</pre>
<p class="status" style="margin-top:14px">Version ${esc(a.version)} · fingerprint ${esc(a.text_sha256.slice(0, 16))}</p></section>`;
  const sign = a.signed
    ? `<div class="done"><h2>Signed</h2><p>Signed by ${esc(a.signed.name)}${a.signed.title ? `, ${esc(a.signed.title)}` : ''} on ${esc(a.signed.at.slice(0, 10))}. We will contact you by email about the deposit.</p></div>`
    : `<section class="card"><h2>Sign</h2><form method="post">
<label>Your full name<br><input name="name" required minlength="3" maxlength="120" style="width:100%"></label>
<p><label>Your title (optional)<br><input name="title" maxlength="120" style="width:100%"></label></p>
<p><label>Organisation (optional)<br><input name="organisation" maxlength="160" style="width:100%" value="${esc(f.organization_name ?? '')}"></label></p>
<p><label><input type="checkbox" name="agree" value="yes" required> I have read this agreement and I agree to it.</label></p>
<p style="margin:10px 0 0"><button class="btn" type="submit">Sign the agreement</button></p></form>
<p class="note">Signing takes no payment. The deposit is requested separately, by email.</p></section>`;
  return `${test}${flashHtml}${text}${sign}<footer><strong>${PARTY}</strong> · <a href="https://bhanetwork.org/vfarm">bhanetwork.org/vfarm</a> · questions: <a href="mailto:admin@bhanetwork.org">admin@bhanetwork.org</a></footer>`;
}

/** The page, for a GET. Marks the agreement opened the first time. Null when the link opens nothing. */
export async function page(token: string, flash: string | null = null): Promise<string | null> {
  const f = await byToken(token);
  if (!f || f.closed_at) return null;
  if (!f.agreement.opened_at) {
    await query(`UPDATE engine_vfarm_leads SET agreement = jsonb_set(agreement, '{opened_at}', to_jsonb($2::text)) WHERE id::text = $1 AND agreement->>'opened_at' IS NULL`, [f.id, new Date().toISOString()]);
    events.changed('vfarm_leads', f.id);
  }
  const first = f.full_name.trim().split(/\s+/)[0] || 'there';
  return brandedPage('Your agreement', `Your vFarm agreement, ${first}`, `${f.organization_name ? `${esc(f.organization_name)} · ` : ''}For the proposal you accepted.`, body(f, flash));
}

export function notValid(): string {
  return notValidPage();
}

/** The buyer signs. Returns the flash line to show, or null when the link opens nothing. */
export async function sign(token: string, form: { name?: unknown; title?: unknown; organisation?: unknown; agree?: unknown }): Promise<{ flash: string; signed: boolean } | null> {
  const f = await byToken(token);
  if (!f || f.closed_at) return null;
  if (f.agreement.signed) return { flash: 'This agreement is already signed.', signed: false };
  const name = clean(form.name, 120);
  if (name.length < 3) return { flash: 'Type your full name to sign (at least 3 characters).', signed: false };
  if (form.agree !== 'yes') return { flash: 'Tick the box to say you have read the agreement and agree to it.', signed: false };
  const sig: Signature = { name, title: clean(form.title, 120) || null, organisation: clean(form.organisation, 160) || null, at: new Date().toISOString() };
  const done = await withTransaction(async (db) => {
    const cur = await db.query<{ stage: number; agreement: Agreement }>(`SELECT stage, agreement FROM engine_vfarm_leads WHERE id::text = $1 FOR UPDATE`, [f.id]);
    const row = cur.rows[0];
    if (!row || row.agreement.agreement_id !== f.agreement.agreement_id) return 'replaced' as const;
    if (row.agreement.signed) return 'already' as const;
    if (sha(row.agreement.text) !== row.agreement.text_sha256) throw new AgreementError(409, 'text_changed', 'The agreement text no longer matches what was issued, so it cannot be signed. We will send a new link.');
    await db.query(`UPDATE engine_vfarm_leads SET agreement = jsonb_set(agreement, '{signed}', $2::jsonb) WHERE id::text = $1`, [f.id, JSON.stringify(sig)]);
    await engineEvents.record(
      { event_type: 'vfarm_agreement_signed', at: sig.at, subject_id: f.buyer ?? f.id, lane: 'VFARM', actor: 'buyer', detail: { lead_id: f.id, agreement_id: row.agreement.agreement_id, version: row.agreement.version, text_sha256: row.agreement.text_sha256, test: row.agreement.test, offer_id: row.agreement.offer_id, stage: row.stage }, dedupe_key: `agreement-signed:${row.agreement.agreement_id}` },
      db,
    );
    return 'ok' as const;
  });
  if (done === 'replaced') return null;
  if (done === 'already') return { flash: 'This agreement is already signed.', signed: false };
  events.changed('vfarm_leads', f.id);
  const a = f.agreement;
  const notified = await post(
    [
      `${a.test ? '*[Test agreement]* ' : ''}*Agreement signed*`,
      `*Signed by:* ${sig.name}${sig.title ? `, ${sig.title}` : ''}${sig.organisation ? ` (${sig.organisation})` : ''}`,
      `*Agreement:* ${a.agreement_id} · ${a.version} · deposit ${money(a.deposit_cents, a.currency)}`,
      `*Buyer:* ${f.buyer ?? 'unknown'}`,
      '',
      'Next is the deposit. Stage 5 needs this signature and a paid deposit. No payment has been taken.',
      `Record: ${base()}/vfarm?tab=early-access&lead=${f.id}`,
    ].join('\n'),
  );
  await query(`UPDATE engine_vfarm_leads SET agreement = jsonb_set(agreement, '{notified}', $2::jsonb) WHERE id::text = $1`, [f.id, JSON.stringify(notified)]).catch((e) =>
    console.error(`[agreement] could not store the alert outcome: ${e instanceof Error ? e.message : String(e)}`),
  );
  return { flash: 'Thank you, the agreement is signed. We will contact you by email about the deposit.', signed: true };
}

/**
 * What Stage 5 needs from the agreement (28 Nov 2026). Pure. A real buyer needs a signed real
 * agreement; a team test lead may move on a signed test agreement, which grants nothing.
 */
export function stage5Agreement(a: Pick<Agreement, 'signed' | 'test'> | null, teamTest: boolean): { ok: true } | { ok: false; message: string } {
  if (!a || !a.signed) return { ok: false, message: 'Stage 5 is a customer: the agreement and the payment both in. No signed agreement is recorded on this lead.' };
  if (a.test && !teamTest) return { ok: false, message: 'This lead\'s signed agreement is a test agreement, and only a team test lead may move to Stage 5 on one.' };
  return { ok: true };
}

/** The subscriber id a customer is recorded under, from its buyer id. Pure. */
export const subscriberIdFor = (buyerOrId: string) => `VFSUB-${buyerOrId.replace(/^VFBUYER-/, '').replace(/[^A-Za-z0-9-]/g, '')}`;
