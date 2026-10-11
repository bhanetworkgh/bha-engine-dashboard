/**
 * vFarm customer events: the exact tags and shapes for lead, buyer, subscriber
 * and upgrade events, and the one catalog read every twin uses to answer "who
 * are vFarm's subscribers, what did they last receive, what state and lane are
 * they in, and what spec are they on" (2026-10-11, Destiny —
 * LOOP-1789326230248-ZX0W, Jason's ask of 13 Sep).
 *
 * The events are ordinary engine.event.v1 rows in `engine_events`. What this
 * file adds is the enforcement: an event whose type is in one of the three
 * customer families is refused unless it is one of the five types below and
 * carries that type's fields. A sixth name, or a missing field, is a refusal
 * that names it, never a row with a hole in it.
 *
 * **These records are facts about what happened, never commitments.** A lead is
 * an expression of interest. Nothing here sets, reads or implies a payment, an
 * entitlement or a delivery promise; B93H claim 4.3 still governs what may be
 * said about any of it.
 *
 * `config_hash` and `cad_revision` are corpus fields from Jegan's config
 * identity spine: which spec a subscriber's hardware is on and which CAD
 * revision produced it. They are stored as sent and never derived here.
 */
import { query } from './pg';
import * as engineEvents from './engineEvents';

export const CUSTOMER_EVENTS_CONTRACT = 'vfarm.customer.events.v0';
export const FLAGSHIP_CAMPAIGN = 'vfarm_flagship_1031';

export const BUYER_STATES = ['intake_submitted', 'qualified', 'reserved', 'declined'] as const;
export const SUBSCRIBER_STATES = ['pending', 'active', 'paused', 'cancelled'] as const;

interface Spec {
  what: string;
  subject: string;
  required: readonly string[];
  optional: readonly string[];
  vocab?: Record<string, readonly string[]>;
  /** Fields that must be present once a condition holds. */
  when?: (d: Record<string, unknown>) => readonly string[];
}

/** The five event types. The name is the tag; nothing else in these families is accepted. */
export const CUSTOMER_EVENTS: Record<string, Spec> = {
  VFARM_LEAD_CAPTURED: {
    what: 'A person expressed interest (Early Access, Form A). Interest only: no reservation, payment or delivery.',
    subject: 'buyer_intake_id',
    required: ['buyer_intake_id', 'source_campaign', 'source_surface'],
    optional: ['early_access_lead_id', 'correlation_id', 'lead_row_id'],
  },
  VFARM_BUYER_STATE_CHANGED: {
    what: 'A lead moved along the buyer path.',
    subject: 'buyer_intake_id',
    required: ['buyer_intake_id', 'new_state', 'source_campaign'],
    optional: ['old_state', 'reason', 'changed_by', 'commercial_lane'],
    vocab: { new_state: BUYER_STATES, old_state: BUYER_STATES },
  },
  VFARM_SUBSCRIBER_STATE_CHANGED: {
    what: 'A subscription was created or changed state.',
    subject: 'subscriber_id',
    required: ['subscriber_id', 'new_state', 'subscription_lane'],
    optional: ['old_state', 'buyer_intake_id', 'source_campaign', 'farm_id', 'cabinet_id', 'config_hash', 'cad_revision', 'reason', 'changed_by'],
    vocab: { new_state: SUBSCRIBER_STATES, old_state: SUBSCRIBER_STATES },
    // An active subscriber is on real hardware, so the spec it is on must be named.
    when: (d) => (d.new_state === 'active' ? ['config_hash', 'cad_revision'] : []),
  },
  VFARM_SUBSCRIBER_DELIVERY: {
    what: 'Something was delivered to a subscriber: a harvest, a report, a message, a hardware part.',
    subject: 'subscriber_id',
    required: ['subscriber_id', 'delivered', 'channel'],
    optional: ['delivery_ref', 'farm_id', 'cabinet_id', 'config_hash'],
  },
  VFARM_SUBSCRIBER_UPGRADED: {
    what: 'A subscriber\'s farm levelled up: its hardware or config moved to a new spec.',
    subject: 'subscriber_id',
    required: ['subscriber_id', 'from_config_hash', 'to_config_hash', 'cad_revision'],
    optional: ['from_cad_revision', 'farm_id', 'cabinet_id', 'reason', 'changed_by'],
  },
};

const FAMILIES = ['VFARM_LEAD_', 'VFARM_BUYER_', 'VFARM_SUBSCRIBER_'];
export const isCustomerEvent = (type: string): boolean => FAMILIES.some((f) => type.toUpperCase().startsWith(f));
const has = (v: unknown): boolean => (typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined);

/**
 * Throws an EventError naming what is wrong, or returns. Called by
 * engineEvents.record before anything is written, so the route, the lead
 * store and any future writer are held to the same shape.
 */
export function check(e: engineEvents.EngineEvent): void {
  const type = String(e.event_type ?? '');
  if (!isCustomerEvent(type)) return;
  const spec = CUSTOMER_EVENTS[type];
  if (!spec) throw new engineEvents.EventError(`"${type}" is not a vFarm customer event. The five are ${Object.keys(CUSTOMER_EVENTS).join(', ')} (${CUSTOMER_EVENTS_CONTRACT}).`);
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const need = [...spec.required, ...(spec.when ? spec.when(d) : [])];
  const missing = need.filter((k) => !has(d[k]));
  if (missing.length) throw new engineEvents.EventError(`${type} needs detail.${missing.join(', detail.')} (${CUSTOMER_EVENTS_CONTRACT}). Nothing was recorded.`);
  for (const [k, allowed] of Object.entries(spec.vocab ?? {})) {
    if (has(d[k]) && !allowed.includes(String(d[k]))) throw new engineEvents.EventError(`${type}: detail.${k} "${String(d[k])}" is not one of ${allowed.join(', ')}. Nothing was recorded.`);
  }
  if (String(e.subject_id ?? '').trim() !== String(d[spec.subject]).trim()) {
    throw new engineEvents.EventError(`${type}: subject_id must be the event's own detail.${spec.subject} ("${String(d[spec.subject])}"), so every event about one person is found under one id.`);
  }
}
engineEvents.setCustomerCheck(check);

/** One lead event from a stored Form A lead. Safe to repeat: the dedupe key is the buyer intake id. */
export async function recordLead(l: { id: string; buyer_intake_id: string; early_access_lead_id?: string | null; correlation_id?: string | null; source_campaign?: string | null; source_surface?: string | null; at?: string | null }): Promise<boolean> {
  const r = await engineEvents.record({
    event_type: 'VFARM_LEAD_CAPTURED',
    at: l.at ?? null,
    subject_id: l.buyer_intake_id,
    lane: 'CAPITAL',
    actor: 'the dashboard (vFarm leads)',
    source_ref: `https://dashboard.bhanetwork.org/vfarm?tab=early-access&lead=${l.id}`,
    detail: {
      buyer_intake_id: l.buyer_intake_id,
      // A lead that named no campaign is recorded as that, in words: an empty attribution must not read as the flagship's.
      source_campaign: l.source_campaign || 'not_attributed',
      source_surface: l.source_surface || 'form_a',
      early_access_lead_id: l.early_access_lead_id ?? null,
      correlation_id: l.correlation_id ?? null,
      lead_row_id: l.id,
    },
    dedupe_key: `VFARM_LEAD_CAPTURED:${l.buyer_intake_id}`,
  });
  return r.recorded;
}

/** Every Form A lead held gets its event, once. Run at boot so leads that arrived before 11 Oct are in the catalog. */
export async function backfillLeads(): Promise<number> {
  const rows = (
    await query<{ id: string; buyer: string; lead: string | null; corr: string | null; campaign: string | null; surface: string | null; at: string }>(
      `SELECT l.id::text AS id, l.form_a->>'buyer_intake_id' AS buyer, l.form_a->>'early_access_lead_id' AS lead, l.form_a->>'correlation_id' AS corr,
              l.source_campaign AS campaign, l.source_surface AS surface, coalesce(l.submitted_at, l.created_at) AS at
         FROM engine_vfarm_leads l
        WHERE l.form_a ? 'buyer_intake_id'
          AND NOT EXISTS (SELECT 1 FROM engine_events e WHERE e.dedupe_key = 'VFARM_LEAD_CAPTURED:' || (l.form_a->>'buyer_intake_id'))`,
    )
  ).rows;
  let n = 0;
  for (const r of rows) {
    if (await recordLead({ id: r.id, buyer_intake_id: r.buyer, early_access_lead_id: r.lead, correlation_id: r.corr, source_campaign: r.campaign, source_surface: r.surface, at: new Date(r.at).toISOString() })) n++;
  }
  return n;
}

type Row = { event_type: string; at: string; subject_id: string; detail: Record<string, unknown> };

/**
 * The catalog: one read over the customer events. Leads and buyers as counts
 * (by campaign, by state); subscribers one row each with their state, lane,
 * spec and what they last received. No name and no email: the lead's own row
 * holds those, behind the page.
 */
export async function catalog(opts: { subscriber_id?: string | null; campaign?: string | null; limit?: number } = {}) {
  const rows = (
    await query<Row>(
      `SELECT event_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, subject_id, detail
         FROM engine_events
        WHERE event_type = ANY($1::text[])
        ORDER BY at, id`,
      [Object.keys(CUSTOMER_EVENTS)],
    )
  ).rows;
  const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const want = (opts.campaign ?? '').trim();

  const leads = rows.filter((r) => r.event_type === 'VFARM_LEAD_CAPTURED' && (!want || r.detail.source_campaign === want));
  const buyerNow = new Map<string, Row>();
  for (const r of rows) if (r.event_type === 'VFARM_BUYER_STATE_CHANGED') buyerNow.set(r.subject_id, r);

  const subs = new Map<string, { subscriber_id: string; state: string; since: string; subscription_lane: string | null; buyer_intake_id: string | null; source_campaign: string | null; farm_id: string | null; cabinet_id: string | null; config_hash: string | null; cad_revision: string | null; levelled_up_at: string | null; upgrades: number; last_received: { delivered: unknown; channel: unknown; at: string } | null }>();
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let newestHash: { config_hash: string; cad_revision: string | null; at: string } | null = null;
  for (const r of rows) {
    if (!r.event_type.startsWith('VFARM_SUBSCRIBER_')) continue;
    const d = r.detail;
    const cur = subs.get(r.subject_id) ?? { subscriber_id: r.subject_id, state: 'unknown', since: r.at, subscription_lane: null, buyer_intake_id: null, source_campaign: null, farm_id: null, cabinet_id: null, config_hash: null, cad_revision: null, levelled_up_at: null, upgrades: 0, last_received: null };
    if (r.event_type === 'VFARM_SUBSCRIBER_STATE_CHANGED') {
      cur.state = String(d.new_state);
      cur.since = r.at;
      cur.subscription_lane = s(d.subscription_lane) ?? cur.subscription_lane;
      cur.buyer_intake_id = s(d.buyer_intake_id) ?? cur.buyer_intake_id;
      cur.source_campaign = s(d.source_campaign) ?? cur.source_campaign;
      cur.config_hash = s(d.config_hash) ?? cur.config_hash;
      cur.cad_revision = s(d.cad_revision) ?? cur.cad_revision;
    } else if (r.event_type === 'VFARM_SUBSCRIBER_UPGRADED') {
      cur.config_hash = s(d.to_config_hash);
      cur.cad_revision = s(d.cad_revision);
      cur.levelled_up_at = r.at;
      cur.upgrades++;
    } else if (r.event_type === 'VFARM_SUBSCRIBER_DELIVERY') {
      cur.last_received = { delivered: d.delivered, channel: d.channel, at: r.at };
    }
    cur.farm_id = s(d.farm_id) ?? cur.farm_id;
    cur.cabinet_id = s(d.cabinet_id) ?? cur.cabinet_id;
    if (cur.config_hash && r.event_type !== 'VFARM_SUBSCRIBER_DELIVERY') newestHash = { config_hash: cur.config_hash, cad_revision: cur.cad_revision, at: r.at };
    subs.set(r.subject_id, cur);
  }
  // Attribution follows the person: a subscriber that named no campaign takes its lead's.
  const leadCampaign = new Map(rows.filter((r) => r.event_type === 'VFARM_LEAD_CAPTURED').map((r) => [r.subject_id, s(r.detail.source_campaign)]));
  let list = [...subs.values()].map((x) => ({
    ...x,
    source_campaign: x.source_campaign ?? (x.buyer_intake_id ? leadCampaign.get(x.buyer_intake_id) ?? null : null),
    newer_config_available: x.config_hash && newestHash && newestHash.config_hash !== x.config_hash ? newestHash.config_hash : null,
  }));
  if (want) list = list.filter((x) => x.source_campaign === want);
  const one = (opts.subscriber_id ?? '').trim();
  if (one) list = list.filter((x) => x.subscriber_id === one);
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);

  return {
    contract: CUSTOMER_EVENTS_CONTRACT,
    read_at: new Date().toISOString(),
    filters: { subscriber_id: one || null, campaign: want || null },
    flagship_campaign: FLAGSHIP_CAMPAIGN,
    leads: { total: leads.length, by_campaign: tally(leads.map((r) => String(r.detail.source_campaign))), by_surface: tally(leads.map((r) => String(r.detail.source_surface))), newest_at: leads.length ? leads[leads.length - 1].at : null },
    buyers: { total: buyerNow.size, by_state: tally([...buyerNow.values()].map((r) => String(r.detail.new_state))) },
    subscribers: { total: list.length, by_state: tally(list.map((x) => x.state)), by_lane: tally(list.map((x) => x.subscription_lane ?? '(no lane)')), rows: list.slice(-limit).reverse() },
    newest_config: newestHash,
    events_held: tally(rows.map((r) => r.event_type)),
    event_types: Object.fromEntries(Object.entries(CUSTOMER_EVENTS).map(([k, v]) => [k, { what: v.what, subject_id: `detail.${v.subject}`, required: v.required, optional: v.optional, vocabulary: v.vocab ?? {} }])),
    notes: [
      'A lead is an expression of interest. Nothing here is a reservation, a payment or a delivery promise.',
      list.length === 0 && !one ? 'No subscriber event has been recorded yet, so there are no subscribers to list. That is "none recorded", not "none exist".' : null,
      buyerNow.size === 0 ? 'No buyer state has been recorded yet: nothing writes VFARM_BUYER_STATE_CHANGED today.' : null,
      'Names and email addresses are not here. They are on the lead\'s own row, behind the vFarm page.',
      'newer_config_available compares a subscriber\'s config_hash with the newest one any subscriber event has named. It is null when they match or when no hash is held.',
    ].filter(Boolean),
  };
}
