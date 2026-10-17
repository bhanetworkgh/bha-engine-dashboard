/**
 * The Stripe to ledger rail (17 Oct 2026, Destiny — D4, the internal $1 test under
 * VFARM_STRIPE_LEDGER_CONTROLLED_TEST_ACCEPTANCE_V1; Jason, #bha-coordination 17 Oct:
 * "wiring and internal testing, not live customer payments").
 *
 * Checkout -> webhook -> provider event -> ledger -> canonical read-back.
 *
 * - **The page is Stripe's own hosted Checkout.** Nothing on bhanetwork.org links to a
 *   payment and /vfarm stays interest_only_live. A Checkout Session is made for one lead,
 *   with `client_reference_id` = the lead's id and `metadata.buyer_intake_id` = its buyer
 *   id, and its URL goes to that person only.
 * - **The webhook is the only way a payment reaches the ledger.** `POST /api/public/stripe/webhook`,
 *   public because Stripe has no key of ours, and locked by Stripe's own signature
 *   (`Stripe-Signature`, HMAC-SHA256 of `<t>.<raw body>`, five minutes' tolerance). One
 *   signing secret per mode, `STRIPE_WEBHOOK_SECRET_TEST` and `STRIPE_WEBHOOK_SECRET_LIVE`,
 *   no defaults; an event whose `livemode` does not match the secret that verified it is
 *   refused.
 * - **An event is stored once.** `engine_stripe_events`, keyed on Stripe's event id. A
 *   repeat (Stripe retries until it gets a 2xx) answers 200 `duplicate` and changes nothing.
 * - **The ledger is the lead's `stripe_payment`.** Paid, failed or expired, with the
 *   session, the payment intent, the amount and every event that touched it. It sets no
 *   stage, no subscriber, no entitlement and no reservation.
 * - **No silent failures.** A forged or unreadable call is 400 and an
 *   `stripe_webhook_refused` event (one Slack alert an hour); a paid session that names no
 *   lead it can be matched to is stored as `unmatched` and alerted, because that is money
 *   with no record; a declined card and an expired link are posted too. A database failure
 *   is a 500, so Stripe tries again.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as events from './events';
import * as mirror from './mirror';
import * as slack from './slack';
import * as quota from './quota';

export const SECRET_VARS = { test: 'STRIPE_WEBHOOK_SECRET_TEST', live: 'STRIPE_WEBHOOK_SECRET_LIVE' } as const;
export const TOLERANCE_S = 300;
/** #vfarm-early-access, where the buyer flow's alerts land. */
const ALERT_CHANNEL = () => process.env.STRIPE_ALERT_CHANNEL?.trim() || process.env.INTAKE2_ALERT_CHANNEL?.trim() || 'C0C36GPEB3L';

type Mode = 'test' | 'live';

function secretFor(mode: Mode): string | null {
  return process.env[SECRET_VARS[mode]]?.trim() || null;
}

export function configured(): { test: boolean; live: boolean } {
  return { test: !!secretFor('test'), live: !!secretFor('live') };
}

function base(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}

/* ------------------------------------------------------------- signature */

export type Verdict = { ok: true; mode: Mode } | { ok: false; reason: 'not_configured' | 'no_signature' | 'bad_signature' | 'too_old' };

/**
 * Stripe's scheme: the header is `t=<unix>,v1=<hex>[,v1=<hex>…]`; each v1 is
 * HMAC-SHA256(secret, `${t}.${raw}`). Any v1 under either mode's secret verifies, and the
 * mode is the secret that did it. Pure apart from the clock, which can be passed.
 */
export function verify(raw: Buffer, header: string | undefined, nowS = Math.floor(Date.now() / 1000), secrets = { test: secretFor('test'), live: secretFor('live') }): Verdict {
  if (!secrets.test && !secrets.live) return { ok: false, reason: 'not_configured' };
  if (!header) return { ok: false, reason: 'no_signature' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    if (k === 'v1' && v && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t == null || !sigs.length) return { ok: false, reason: 'no_signature' };
  const signed = Buffer.concat([Buffer.from(`${t}.`), raw]);
  for (const mode of ['test', 'live'] as const) {
    const s = secrets[mode];
    if (!s) continue;
    const want = createHmac('sha256', s).update(signed).digest();
    for (const sig of sigs) {
      const got = Buffer.from(sig, 'hex');
      if (got.length === want.length && timingSafeEqual(got, want)) {
        if (Math.abs(nowS - t) > TOLERANCE_S) return { ok: false, reason: 'too_old' };
        return { ok: true, mode };
      }
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

/* --------------------------------------------------------------- handling */

export interface StripePayment {
  state: 'paid' | 'failed' | 'expired' | 'pending';
  mode: Mode;
  amount: number | null;
  currency: string | null;
  session_id: string | null;
  payment_intent: string | null;
  customer_email: string | null;
  paid_at: string | null;
  last_event_id: string;
  last_event_type: string;
  updated_at: string;
  failure: string | null;
  events: Array<{ id: string; type: string; at: string }>;
}

export type Outcome = 'recorded' | 'duplicate' | 'unmatched' | 'ignored';

const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
]);

type Obj = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What an event means for the ledger, from Stripe's own fields. Pure. */
export function read(ev: Obj): {
  type: string;
  state: StripePayment['state'] | null;
  session_id: string | null;
  payment_intent: string | null;
  lead_id: string | null;
  buyer_intake_id: string | null;
  amount: number | null;
  currency: string | null;
  email: string | null;
  failure: string | null;
} {
  const type = String(ev.type ?? '');
  const o = ((ev.data as Obj | undefined)?.object ?? {}) as Obj;
  const md = (o.metadata ?? {}) as Obj;
  const isSession = type.startsWith('checkout.session.');
  let state: StripePayment['state'] | null = null;
  if (type === 'checkout.session.completed') state = o.payment_status === 'paid' || o.payment_status === 'no_payment_required' ? 'paid' : 'pending';
  else if (type === 'checkout.session.async_payment_succeeded') state = 'paid';
  else if (type === 'checkout.session.async_payment_failed' || type === 'payment_intent.payment_failed') state = 'failed';
  else if (type === 'checkout.session.expired') state = 'expired';
  const lastErr = (o.last_payment_error ?? null) as Obj | null;
  return {
    type,
    state,
    session_id: isSession ? s(o.id) : null,
    payment_intent: isSession ? s(o.payment_intent) : s(o.id),
    lead_id: s(o.client_reference_id) ?? s(md.lead_id),
    buyer_intake_id: s(md.buyer_intake_id),
    amount: n(o.amount_total) ?? n(o.amount),
    currency: s(o.currency),
    email: s((o.customer_details as Obj | undefined)?.email) ?? s(o.customer_email) ?? s(o.receipt_email),
    failure: lastErr ? [s(lastErr.code), s(lastErr.decline_code), s(lastErr.message)].filter(Boolean).join(': ') || 'payment failed' : type === 'checkout.session.async_payment_failed' ? 'async payment failed' : null,
  };
}

/** The transitions the ledger allows: paid is never undone by a later failed or expired event. */
export function next(prev: StripePayment['state'] | null, incoming: StripePayment['state']): StripePayment['state'] {
  if (prev === 'paid') return 'paid';
  return incoming;
}

export interface Handled {
  status: number;
  outcome: Outcome;
  event_id: string;
  lead_id: string | null;
  detail: string;
}

/**
 * One verified event, in one transaction: the event row (once), then the lead. A payment
 * intent event carries no lead of its own; it is matched through the session that named
 * that intent, so a declined card lands on the lead whose link it was.
 */
export async function handle(ev: Obj, mode: Mode): Promise<Handled> {
  const eventId = s(ev.id);
  if (!eventId || !/^evt_/.test(eventId)) return { status: 400, outcome: 'ignored', event_id: String(ev.id ?? ''), lead_id: null, detail: 'not a Stripe event' };
  const r = read(ev);
  const at = typeof ev.created === 'number' ? new Date(ev.created * 1000).toISOString() : new Date().toISOString();

  const result = await withTransaction(async (db) => {
    const ins = await db.query<{ event_id: string }>(
      `INSERT INTO engine_stripe_events (event_id, type, livemode, stripe_created_at, session_id, payment_intent, amount, currency, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, r.type, mode === 'live', at, r.session_id, r.payment_intent, r.amount, r.currency, JSON.stringify(ev)],
    );
    if (!ins.rows.length) return { outcome: 'duplicate' as Outcome, lead_id: null as string | null, detail: 'already stored; nothing changed', payment: null as StripePayment | null, prev: null as StripePayment['state'] | null };
    const done = async (outcome: Outcome, lead: string | null, detail: string) => {
      await db.query(`UPDATE engine_stripe_events SET outcome = $2, lead_id = $3, detail = $4 WHERE event_id = $1`, [eventId, outcome, lead, detail]);
      return { outcome, lead_id: lead, detail, payment: null as StripePayment | null, prev: null as StripePayment['state'] | null };
    };
    if (!HANDLED.has(r.type) || !r.state) return done('ignored', null, `${r.type} is not a payment event this ledger reads`);

    // Which lead. A session names it; an intent is found through its session.
    let leadId = r.lead_id;
    let buyer = r.buyer_intake_id;
    if (!leadId && !r.session_id && r.payment_intent) {
      const via = await db.query<{ lead_id: string | null; raw: Obj }>(
        `SELECT lead_id, raw FROM engine_stripe_events WHERE payment_intent = $1 AND session_id IS NOT NULL AND lead_id IS NOT NULL ORDER BY received_at DESC LIMIT 1`,
        [r.payment_intent],
      );
      if (via.rows[0]) {
        leadId = via.rows[0].lead_id;
        buyer = s((((via.rows[0].raw.data as Obj)?.object as Obj)?.metadata as Obj)?.buyer_intake_id) ?? buyer;
      }
    }
    if (!leadId) {
      // A failed intent with no session yet seen is the card being declined inside Checkout
      // before the session completes; Stripe sends the session events later. Stored, said.
      if (r.state === 'failed') return done('unmatched', null, `payment failed (${r.failure ?? 'no reason given'}) and no session of ours names this payment intent yet`);
      return done('unmatched', null, 'no client_reference_id or lead_id metadata on the session');
    }
    const lead = await db.query<{ id: string; buyer: string | null; stripe_payment: StripePayment | null }>(
      `SELECT id::text AS id, form_a->>'buyer_intake_id' AS buyer, stripe_payment FROM engine_vfarm_leads WHERE id::text = $1 FOR UPDATE`,
      [leadId],
    );
    const row = lead.rows[0];
    if (!row) return done('unmatched', leadId, `no lead ${leadId}`);
    if (!buyer || buyer !== row.buyer) return done('unmatched', leadId, `the session's buyer_intake_id (${buyer ?? 'none'}) is not lead ${leadId}'s (${row.buyer ?? 'none'})`);
    const prev = row.stripe_payment;
    if (prev && prev.mode !== mode) return done('unmatched', leadId, `lead ${leadId} already holds a ${prev.mode} payment; a ${mode} event does not overwrite it`);

    const now = new Date().toISOString();
    const state = next(prev?.state ?? null, r.state);
    const payment: StripePayment = {
      state,
      mode,
      amount: r.amount ?? prev?.amount ?? null,
      currency: r.currency ?? prev?.currency ?? null,
      session_id: r.session_id ?? prev?.session_id ?? null,
      payment_intent: r.payment_intent ?? prev?.payment_intent ?? null,
      customer_email: r.email ?? prev?.customer_email ?? null,
      paid_at: prev?.paid_at ?? (state === 'paid' ? at : null),
      last_event_id: eventId,
      last_event_type: r.type,
      updated_at: now,
      failure: state === 'paid' ? null : r.failure ?? prev?.failure ?? null,
      events: [...(prev?.events ?? []), { id: eventId, type: r.type, at }].slice(-50),
    };
    await db.query(`UPDATE engine_vfarm_leads SET stripe_payment = $2::jsonb WHERE id::text = $1`, [leadId, JSON.stringify(payment)]);
    await engineEvents.record(
      {
        event_type: state === 'paid' && prev?.state !== 'paid' ? 'vfarm_payment_recorded' : `vfarm_payment_${state}`,
        at,
        subject_id: buyer,
        lane: 'VFARM',
        actor: 'stripe',
        source_ref: eventId,
        detail: { lead_id: leadId, mode, amount: payment.amount, currency: payment.currency, session_id: payment.session_id, payment_intent: payment.payment_intent, stripe_event_type: r.type, failure: payment.failure },
        dedupe_key: `stripe:${eventId}`,
      },
      db,
    );
    const out = await done('recorded', leadId, `${r.type}: ${prev?.state ?? 'none'} -> ${state}`);
    return { ...out, payment, prev: prev?.state ?? null };
  });

  if (result.lead_id) events.changed('vfarm_leads', result.lead_id);
  if (result.outcome === 'recorded' && result.payment && result.payment.state !== result.prev) await alert(result.payment, result.lead_id!, eventId);
  if (result.outcome === 'unmatched') await alertUnmatched(eventId, r.type, mode, r.amount, r.currency, result.detail);
  return { status: 200, outcome: result.outcome, event_id: eventId, lead_id: result.lead_id, detail: result.detail };
}

/* ----------------------------------------------------------------- alerts */

const money = (amount: number | null, currency: string | null) => (amount == null ? 'amount not given' : `${(amount / 100).toFixed(2)} ${(currency ?? '').toUpperCase()}`.trim());

async function post(channel: string, text: string, what: string): Promise<void> {
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), http_status: 0 }));
  if (!r.ok) {
    console.error(`[stripe] ${what} alert not posted: ${r.error}`);
    await engineEvents.record({ event_type: 'stripe_alert_not_posted', subject_id: what, lane: 'VFARM', actor: 'dashboard', detail: { channel, error: String(r.error ?? 'unknown') } }).catch(() => undefined);
  }
}

async function alert(p: StripePayment, leadId: string, eventId: string): Promise<void> {
  const lead = await query<{ full_name: string; buyer: string | null }>(`SELECT full_name, form_a->>'buyer_intake_id' AS buyer FROM engine_vfarm_leads WHERE id::text = $1`, [leadId]);
  const l = lead.rows[0];
  const head = p.mode === 'test' ? '*[Stripe sandbox, test only]* ' : '';
  const title = p.state === 'paid' ? 'Payment received' : p.state === 'failed' ? 'Payment failed' : p.state === 'expired' ? 'Checkout link expired, nothing paid' : 'Checkout completed, payment pending';
  const text = [
    `${head}*${title}*`,
    `*Name:* ${l?.full_name ?? 'unknown'}`,
    `*Buyer:* ${l?.buyer ?? 'unknown'}`,
    `*Amount:* ${money(p.amount, p.currency)}`,
    ...(p.failure ? [`*Reason:* ${p.failure}`] : []),
    `*Stripe:* ${p.session_id ?? p.payment_intent ?? 'no id'} (event ${eventId})`,
    '',
    'Recorded on the ledger only. No stage, entitlement or reservation is set by a payment.',
    `Record: ${base()}/vfarm?tab=early-access&lead=${leadId}`,
  ].join('\n');
  await post(ALERT_CHANNEL(), text, `payment ${eventId}`);
}

async function alertUnmatched(eventId: string, type: string, mode: Mode, amount: number | null, currency: string | null, detail: string): Promise<void> {
  // Only money with no home is worth a person's attention; an ignored type is not posted.
  const channel = quota.channelId() || ALERT_CHANNEL();
  const head = mode === 'test' ? '*[Stripe sandbox, test only]* ' : '';
  await post(channel, `${head}*Stripe event with no lead*\n*Event:* ${type} ${eventId}\n*Amount:* ${money(amount, currency)}\n*Why:* ${detail}\nStored in engine_stripe_events as unmatched. Check it in Stripe and match it by hand.`, `unmatched ${eventId}`);
}

/** A refused webhook call: an event every time, a Slack alert at most once an hour. */
export async function refused(reason: string, ip: string | null): Promise<void> {
  const hour = new Date().toISOString().slice(0, 13);
  const r = await engineEvents
    .record({ event_type: 'stripe_webhook_refused', subject_id: 'stripe-webhook', lane: 'VFARM', actor: 'dashboard', detail: { reason, ip_hint: ip ? ip.replace(/\.\d+$/, '.x') : null }, dedupe_key: `stripe-refused:${hour}` })
    .catch(() => ({ recorded: false, id: null }));
  if (r.recorded) {
    const channel = quota.channelId() || ALERT_CHANNEL();
    await post(channel, `*Stripe webhook call refused* (${reason})\nA call to /api/public/stripe/webhook did not carry a valid Stripe signature, so nothing was stored. One alert an hour; every refusal is on engine_events as stripe_webhook_refused.`, 'refused webhook');
  }
}

export async function logCall(outcome: 'inserted' | 'unchanged' | 'rejected' | 'error', natural: string | null, detail: string, ms: number): Promise<void> {
  await mirror.logWrite({ endpoint: '/api/public/stripe/webhook', kind: 'stripe_events', method: 'POST', key_label: 'Stripe-Signature', natural_id: natural, outcome, detail: detail.slice(0, 500), ms }).catch(() => undefined);
}

/* -------------------------------------------------------------- read-back */

/** The canonical read-back: every stored event, newest first, and every lead holding a payment. */
export async function readBack(opts: { lead_id?: string | null; limit?: number } = {}): Promise<{ events: unknown[]; payments: unknown[]; configured: { test: boolean; live: boolean } }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const ev = await query(
    `SELECT event_id, type, CASE WHEN livemode THEN 'live' ELSE 'test' END AS mode, stripe_created_at, received_at, session_id, payment_intent, amount, currency, outcome, lead_id, detail
       FROM engine_stripe_events WHERE ($1::text IS NULL OR lead_id = $1) ORDER BY received_at DESC LIMIT $2`,
    [opts.lead_id ?? null, limit],
  );
  const pay = await query(
    `SELECT id::text AS lead_id, full_name, form_a->>'buyer_intake_id' AS buyer_intake_id, stripe_payment
       FROM engine_vfarm_leads WHERE stripe_payment IS NOT NULL AND ($1::text IS NULL OR id::text = $1) ORDER BY (stripe_payment->>'updated_at') DESC`,
    [opts.lead_id ?? null],
  );
  return { events: ev.rows, payments: pay.rows, configured: configured() };
}

/* ------------------------------------------------------------------ pages */

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#6e6e73}@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f5f5f7;--dim:#a1a1a6}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:18px;padding:32px;max-width:460px;box-shadow:0 4px 24px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 8px}p{color:var(--dim);margin:0}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

/** Where Stripe sends a buyer back. It says nothing about any payment: the webhook is the record. */
export function donePage(): string {
  return page('Thank you', 'Your payment has been sent to Stripe, and Stripe will email you a receipt. BHA will be in touch about next steps. You can close this page.');
}
export function cancelledPage(): string {
  return page('Checkout cancelled', 'Nothing was charged. If you meant to pay, use the link you were sent again.');
}
