/**
 * **SUPERSEDED (2026-09-23, Destiny): the public route below is kept but no
 * longer used by the site.** Every Early Access lead now arrives through
 * Hardik's Google Form A — directly, or from bhanetwork.org/vfarm, which
 * submits into Form A — and his n8n tracker pushes each one to
 * `POST /api/engine/vfarm-leads` (`storeFormA`, at the foot of this file),
 * behind the engine's service key, with every answer. The public route is
 * origin-checked for browsers, so n8n cannot call it, and it stores only name,
 * email and organisation. It stays because removing a public endpoint a stale
 * page might still post to would turn a lead into an error; nothing current
 * posts to it. The description below is of that route.
 *
 * The receiving end of the vFarm Early Access funnel (2026-09-20, on Destiny's
 * instruction).
 *
 * The static site at bhanetwork.org posts an expression of interest here, this
 * server stores it, and the Early Access tab on /vfarm is where somebody reads
 * and annotates it. Three things about that shape are deliberate:
 *
 * **This is the only public write route in the application.** Everything else
 * under /api is behind the session cookie or the engine's service key. A route
 * a stranger can POST to is a liability worth naming rather than burying, so
 * the whole of it lives in this one file: what it accepts, what it refuses,
 * how often, and what it is allowed to say back.
 *
 * **It records an expression of interest and nothing else.** There is no
 * subscriber, payment, entitlement, reservation or delivery state here, and
 * the response says `{ ok: true }` and stops. Somebody filling in a form has
 * not bought anything, reserved anything or joined anything, and neither the
 * stored row nor the reply may imply that they have.
 *
 * **It never answers with data.** Not the stored row, not a count, not whether
 * the address was already on file. A public endpoint that confirms "you are
 * already on the list" is an address oracle; the repeat is recorded and shown
 * on the dashboard, where the audience is the six people who should see it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { query } from './pg';
import * as events from './events';
import { FORM_A_QUESTIONS } from '../../src/data/formA';

/* ------------------------------------------------------------------ config */

/**
 * The apex and the www host are the front door. The onrender.com host is the
 * same static site on its Render address, which is what serves it before DNS
 * cuts over and what stays reachable if the apex is ever pointed elsewhere —
 * without it, a form on that host is refused with "Origin not allowed."
 */
const DEFAULT_ORIGINS = [
  'https://bhanetwork.org',
  'https://www.bhanetwork.org',
  'https://bhanetwork-site.onrender.com',
  'http://localhost:5173',
];

export const ALLOWED_ORIGINS_VAR = 'EARLY_ACCESS_ALLOWED_ORIGINS';

/** The origins the browser form may be served from. Comma-separated, trimmed. */
export const ALLOWED_ORIGINS: string[] = (process.env.EARLY_ACCESS_ALLOWED_ORIGINS?.trim()
  ? process.env.EARLY_ACCESS_ALLOWED_ORIGINS.split(',')
  : DEFAULT_ORIGINS
)
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const ORIGINS_FROM_ENV = Boolean(process.env.EARLY_ACCESS_ALLOWED_ORIGINS?.trim());

export const NOTIFY_URL_VAR = 'EARLY_ACCESS_NOTIFY_URL';
export const NOTIFY_URL = process.env.EARLY_ACCESS_NOTIFY_URL?.trim() || null;

export const SALT_VAR = 'IP_HASH_SALT';

/**
 * The salt for the address digest.
 *
 * Unset, a random one is generated for this process rather than falling back to
 * no salt: an unsalted SHA-256 of an IPv4 address is reversible by anyone with
 * an afternoon and four billion guesses, so "salted" with an empty string would
 * be the kind of security that reads as security and is not. The cost of the
 * random one is that hashes do not compare across a restart — the rate limiter
 * is in-process anyway, so only the stored column loses meaning, and the boot
 * line says so.
 */
const SALT = process.env.IP_HASH_SALT?.trim() || randomBytes(32).toString('hex');
export const SALT_FROM_ENV = Boolean(process.env.IP_HASH_SALT?.trim());

export function notifyConfigured(): boolean {
  return Boolean(NOTIFY_URL);
}

/* ------------------------------------------------------------------- CORS */

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''));
}

export function originOf(req: IncomingMessage): string | undefined {
  const o = req.headers.origin;
  return Array.isArray(o) ? o[0] : o;
}

/**
 * The CORS headers for this one route.
 *
 * The origin is echoed only when it is on the list — never `*`. A wildcard here
 * would be harmless in itself, since the endpoint returns nothing worth
 * reading, but it would also make the allow-list decorative.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && originAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/* ------------------------------------------------------------ the address */

export function clientIp(req: IncomingMessage): string {
  // Render terminates TLS in front of this process, so the socket address is
  // its router. x-forwarded-for's first entry is the caller.
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim();
}

/** A salted digest of the address. The address itself is never stored or logged. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(`${SALT}:${ip}`).digest('hex');
}

/* ------------------------------------------------------------ rate limits */

/**
 * Five in ten minutes and twenty in a day, per address, held in this process.
 *
 * In-process is the right size for this: the volume is a handful a day, and a
 * shared counter in Postgres would mean a write on every refused request, which
 * is the thing a flood is trying to make us do. Render runs one instance, and
 * even with two the worst case is double the allowance rather than none.
 */
const SHORT_WINDOW_MS = 10 * 60 * 1000;
const SHORT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LIMIT = 20;

const hits = new Map<string, number[]>();

/** Keeps the map from growing without bound when a lot of addresses are seen once. */
function sweep(now: number): void {
  if (hits.size < 5000) return;
  for (const [key, times] of hits) {
    const live = times.filter((t) => now - t < DAY_MS);
    if (live.length) hits.set(key, live);
    else hits.delete(key);
  }
}

export interface RateVerdict {
  ok: boolean;
  /** Which limit refused it, for the log. Never sent to the caller. */
  reason?: string;
  retry_after_seconds?: number;
}

export function checkRate(ipHash: string, now = Date.now()): RateVerdict {
  sweep(now);
  const times = (hits.get(ipHash) ?? []).filter((t) => now - t < DAY_MS);
  const recent = times.filter((t) => now - t < SHORT_WINDOW_MS);

  if (recent.length >= SHORT_LIMIT) {
    const oldest = Math.min(...recent);
    return { ok: false, reason: `${SHORT_LIMIT} in ${SHORT_WINDOW_MS / 60000} minutes`, retry_after_seconds: Math.max(1, Math.ceil((SHORT_WINDOW_MS - (now - oldest)) / 1000)) };
  }
  if (times.length >= DAY_LIMIT) {
    const oldest = Math.min(...times);
    return { ok: false, reason: `${DAY_LIMIT} in a day`, retry_after_seconds: Math.max(1, Math.ceil((DAY_MS - (now - oldest)) / 1000)) };
  }
  hits.set(ipHash, [...times, now]);
  return { ok: true };
}

/** For the tests, and for nothing else. */
export function resetRates(): void {
  hits.clear();
}

/* ------------------------------------------------------------ validation */

export class SubmissionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

/**
 * Plausible, not correct. The only way to know an address works is to send to
 * it, which this endpoint does not do, so this rejects what is obviously not an
 * address and accepts the rest — one @, something either side, a dot in the
 * domain, no spaces.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_ORG = 200;
/** Enough for a real value, short enough that nobody stores a document in one. */
const MAX_TAG = 200;

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export interface Submission {
  full_name: string;
  email: string;
  organization_name: string | null;
  source_surface: string;
  source_page: string | null;
  source_campaign: string | null;
  page_contract_version: string | null;
  mechanics_contract_version: string | null;
  claim_state: string | null;
  submitted_at: string | null;
  /**
   * Attribution, exactly as the page captured it.
   *
   * Stored as '' where the URL did not carry a value, never as null and never
   * inferred: an empty string says "the link did not say", which is a fact,
   * and a guess would look like evidence.
   */
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  asset_id: string;
  source_channel: string;
  landing_variant: string;
  contract_version: string;
}

/** A tag as given, clipped, or '' — never null, so "absent" stays one value. */
function tag(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_TAG) : '';
}

/**
 * Reads the body the site sends and refuses anything else.
 *
 * Unknown fields are ignored rather than rejected: the site and this server
 * deploy separately, so a field added there before it is read here must not
 * start failing every submission. The three that matter are checked strictly;
 * everything else is provenance and is stored as given, clipped.
 */
export function readSubmission(body: Record<string, unknown>): Submission {
  const full_name = text(body.full_name, MAX_NAME);
  if (!full_name) throw new SubmissionError(400, 'A name is required.');
  if (typeof body.full_name === 'string' && body.full_name.trim().length > MAX_NAME) {
    throw new SubmissionError(400, `A name can be at most ${MAX_NAME} characters.`);
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!rawEmail) throw new SubmissionError(400, 'An email address is required.');
  if (rawEmail.length > MAX_EMAIL) throw new SubmissionError(400, `An email address can be at most ${MAX_EMAIL} characters.`);
  if (!EMAIL.test(rawEmail)) throw new SubmissionError(400, 'That does not look like an email address.');

  if (typeof body.organization_name === 'string' && body.organization_name.trim().length > MAX_ORG) {
    throw new SubmissionError(400, `An organisation name can be at most ${MAX_ORG} characters.`);
  }

  const submitted = text(body.submitted_at, 40);
  return {
    full_name,
    email: rawEmail,
    organization_name: text(body.organization_name, MAX_ORG),
    // The site always sends one; a submission that does not say where it came
    // from is still a real person, so it is recorded as unstated rather than
    // refused.
    source_surface: text(body.source_surface, MAX_TAG) ?? 'unstated',
    source_page: text(body.source_page, MAX_TAG),
    source_campaign: text(body.source_campaign, MAX_TAG),
    page_contract_version: text(body.page_contract_version, MAX_TAG),
    mechanics_contract_version: text(body.mechanics_contract_version, MAX_TAG),
    claim_state: text(body.claim_state, MAX_TAG),
    submitted_at: submitted && !Number.isNaN(Date.parse(submitted)) ? new Date(submitted).toISOString() : null,
    utm_source: tag(body.utm_source),
    utm_medium: tag(body.utm_medium),
    utm_campaign: tag(body.utm_campaign),
    asset_id: tag(body.asset_id),
    source_channel: tag(body.source_channel),
    landing_variant: tag(body.landing_variant),
    contract_version: tag(body.contract_version),
  };
}

/* ---------------------------------------------------------------- the write */

export interface Stored {
  id: string;
  created_at: string;
  is_repeat_email: boolean;
}

export async function store(s: Submission, ipHash: string, userAgent: string | null): Promise<Stored> {
  // Asked before the insert, so "repeat" means an address that was already on
  // file when this one arrived rather than one that counts itself.
  const seen = await query<{ n: string }>('SELECT count(*)::text AS n FROM engine_vfarm_leads WHERE email = $1', [s.email]);
  const isRepeat = Number(seen.rows[0]?.n ?? 0) > 0;

  const r = await query<{ id: string; created_at: string }>(
    `INSERT INTO engine_vfarm_leads
       (full_name, email, organization_name, source_surface, source_page, source_campaign,
        page_contract_version, mechanics_contract_version, claim_state, submitted_at, user_agent, ip_hash,
        utm_source, utm_medium, utm_campaign, asset_id, source_channel, landing_variant, contract_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id, created_at`,
    [
      s.full_name,
      s.email,
      s.organization_name,
      s.source_surface,
      s.source_page,
      s.source_campaign,
      s.page_contract_version,
      s.mechanics_contract_version,
      s.claim_state,
      s.submitted_at,
      userAgent,
      ipHash,
      s.utm_source,
      s.utm_medium,
      s.utm_campaign,
      s.asset_id,
      s.source_channel,
      s.landing_variant,
      s.contract_version,
    ],
  );
  const row = r.rows[0];
  events.changed('vfarm_leads', row.id);
  return { id: row.id, created_at: new Date(row.created_at).toISOString(), is_repeat_email: isRepeat };
}

/* -------------------------------------------------------- the Slack hop */

/** Five seconds. The caller is already gone; this is a ceiling on a stuck socket. */
const NOTIFY_TIMEOUT_MS = 5000;

/**
 * Tells the team a lead arrived, through the n8n webhook that posts into
 * #vfarm-early-access.
 *
 * **Never awaited by the request.** The lead is already stored by the time this
 * runs, and a Slack outage is not a reason to fail a submission or to keep
 * somebody's browser waiting — so a failure is logged, `notified_at` stays
 * null, and the row is on the dashboard either way. The null is the useful
 * part: it says this one was never announced, which is exactly what somebody
 * needs to know when they are wondering why they did not see it.
 *
 * No Slack token lives in this repo and nothing here calls Slack directly. The
 * webhook holds that credential, the same way ENGINE_HEAL_URL does.
 */
export async function notify(lead: Stored, s: Submission): Promise<void> {
  if (!NOTIFY_URL) return;
  const body = {
    event: 'vfarm_early_access_lead',
    lead_id: lead.id,
    full_name: s.full_name,
    email: s.email,
    organization_name: s.organization_name,
    source_page: s.source_page,
    source_campaign: s.source_campaign,
    utm_source: s.utm_source,
    utm_medium: s.utm_medium,
    utm_campaign: s.utm_campaign,
    asset_id: s.asset_id,
    source_channel: s.source_channel,
    landing_variant: s.landing_variant,
    contract_version: s.contract_version,
    is_repeat_email: lead.is_repeat_email,
    created_at: lead.created_at,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[early-access] the notification for ${lead.id} was refused: ${res.status} ${res.statusText}. The lead is stored; notified_at stays null.`);
      return;
    }
    await query('UPDATE engine_vfarm_leads SET notified_at = now() WHERE id = $1', [lead.id]);
    events.changed('vfarm_leads', lead.id);
    console.log(`[early-access] notified for ${lead.id} in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[early-access] the notification for ${lead.id} could not be sent: ${e instanceof Error ? e.message : String(e)}. The lead is stored; notified_at stays null.`);
  }
}

/* ------------------------------------------------------------- the read */

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'archived'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isStatus(v: string): v is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(v);
}

export interface Lead {
  id: string;
  full_name: string;
  email: string;
  organization_name: string | null;
  source_surface: string;
  source_page: string | null;
  source_campaign: string | null;
  page_contract_version: string | null;
  mechanics_contract_version: string | null;
  claim_state: string | null;
  status: string;
  notes: string | null;
  notified_at: string | null;
  submitted_at: string | null;
  created_at: string;
  user_agent: string | null;
  /** Attribution as captured. Null only on rows written before it was stored. */
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  asset_id: string | null;
  source_channel: string | null;
  landing_variant: string | null;
  contract_version: string | null;
  /** Everything Form A asked and the tracker's ids; null on a lead from the old public route. */
  form_a: FormAStored | null;
  /** True where this address was already on an earlier row. Computed, never stored. */
  is_repeat_email: boolean;
}

export interface LeadsData {
  leads: Lead[];
  summary: {
    total: number;
    last_7_days: number;
    last_30_days: number;
    by_status: Record<string, number>;
  };
}

/**
 * Every column but `ip_hash`, newest first, with the repeat flag computed.
 *
 * `ip_hash` has no way onto the page: it is a rate-limiting artefact, it says
 * nothing a reader can act on, and a column nobody needs is a column that ends
 * up somewhere it should not be.
 */
export async function leads(): Promise<LeadsData> {
  const r = await query<Lead & { created_at: Date; notified_at: Date | null; submitted_at: Date | null; seq: string }>(
    `SELECT id, full_name, email, organization_name, source_surface, source_page, source_campaign,
            page_contract_version, mechanics_contract_version, claim_state, status, notes,
            notified_at, submitted_at, created_at, user_agent,
            utm_source, utm_medium, utm_campaign, asset_id, source_channel,
            landing_variant, contract_version, form_a,
            row_number() OVER (PARTITION BY email ORDER BY created_at, id) AS seq
       FROM engine_vfarm_leads
      ORDER BY created_at DESC, id DESC`,
  );

  const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
  const rows: Lead[] = r.rows.map((row) => ({
    ...row,
    created_at: iso(row.created_at) as string,
    notified_at: iso(row.notified_at),
    submitted_at: iso(row.submitted_at),
    // Row one of an address is the first time it was seen; anything after is a repeat.
    is_repeat_email: Number(row.seq) > 1,
  }));

  const now = Date.now();
  const since = (days: number) => rows.filter((l) => now - Date.parse(l.created_at) < days * DAY_MS).length;
  const by_status: Record<string, number> = {};
  for (const s of LEAD_STATUSES) by_status[s] = 0;
  for (const l of rows) by_status[l.status] = (by_status[l.status] ?? 0) + 1;

  return { leads: rows, summary: { total: rows.length, last_7_days: since(7), last_30_days: since(30), by_status } };
}

/**
 * The only thing about a lead this dashboard may change: what somebody did
 * about it, and what they wrote down.
 *
 * Nothing else is editable and nothing else should be. The rest of the row is
 * what a person told the site about themselves, and a record you can quietly
 * rewrite is not a record.
 */
export async function patch(id: string, changes: { status?: string; notes?: string | null }): Promise<Lead> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (changes.status !== undefined) {
    if (!isStatus(changes.status)) {
      throw new SubmissionError(422, `"${changes.status}" is not a status a lead can be in. One of: ${LEAD_STATUSES.join(', ')}.`);
    }
    values.push(changes.status);
    sets.push(`status = $${values.length}`);
  }
  if (changes.notes !== undefined) {
    const n = typeof changes.notes === 'string' ? changes.notes.slice(0, 4000) : null;
    values.push(n && n.trim() ? n : null);
    sets.push(`notes = $${values.length}`);
  }
  if (!sets.length) throw new SubmissionError(400, 'Send a status, or notes, or both. Nothing else about a lead is editable.');

  values.push(id);
  const r = await query<{ id: string }>(`UPDATE engine_vfarm_leads SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`, values);
  if (!r.rows.length) throw new SubmissionError(404, 'No lead with that id.');
  events.changed('vfarm_leads', id);

  const all = await leads();
  const updated = all.leads.find((l) => l.id === id);
  if (!updated) throw new SubmissionError(404, 'No lead with that id.');
  return updated;
}

/* ---------------------------------------------------- the engine route */

/**
 * What Form A leads are stored as (2026-09-23, Destiny): every answer keyed by
 * its question text exactly as Form A words it, and the tracker's identifiers,
 * all as the tracker sent them.
 */
export interface FormAStored {
  answers: Record<string, unknown>;
  early_access_lead_id: string | null;
  buyer_intake_id: string;
  correlation_id: string | null;
  source_campaign: string | null;
  submitted_at: string | null;
}

export interface FormAWrite {
  id: string;
  buyer_intake_id: string;
  inserted: boolean;
  answers: number;
  /** Keys sent that are not one of Form A's 23 questions — stored anyway, and shown. */
  unexpected_questions: string[];
  /** Form A questions the body did not carry. Usually a key typed differently. */
  missing_questions: string[];
  /** Top-level fields this route does not read. */
  ignored_fields: string[];
}

const ENGINE_FIELDS = ['name', 'email', 'organisation', 'organization', 'answers', 'early_access_lead_id', 'buyer_intake_id', 'correlation_id', 'source_campaign', 'submitted_at'];

function opt(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

/**
 * POST /api/engine/vfarm-leads — one Form A lead from Hardik's n8n tracker.
 *
 * **Superseding the public route**, which is kept but no longer used by the
 * site: that one is origin-checked for browsers, so n8n cannot call it, and it
 * stores three fields, so it would lose twenty of the answers. This one is
 * behind the engine's service key like every other engine write.
 *
 * **It never announces anything.** The tracker posts the Slack alert itself;
 * a second announcement from here would be the same lead twice. `notified_at`
 * is left null on these rows, and the page does not read that as "missed",
 * because for a Form A lead the announcement is not this server's to make.
 *
 * **An upsert on buyer_intake_id**, which the tracker derives from the email
 * and the Form A timestamp: the same submission posted twice updates one row.
 * An update replaces the answers and the identifiers — the newer post is the
 * newer statement of the same submission — and never touches `status` or
 * `notes`, which are this dashboard's own.
 */
export async function storeFormA(body: Record<string, unknown>): Promise<FormAWrite> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SubmissionError(400, 'Send one lead as a JSON object.');
  const rawAnswers = body.answers;
  if (rawAnswers !== undefined && (rawAnswers === null || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers))) {
    throw new SubmissionError(422, 'answers must be an object keyed by Form A question text, e.g. { "Country": "Ghana" }.');
  }
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((rawAnswers ?? {}) as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    answers[k.slice(0, 500)] = typeof v === 'string' ? v.slice(0, 8000) : v;
  }

  const buyer = opt(body.buyer_intake_id, 200);
  if (!buyer) throw new SubmissionError(422, 'buyer_intake_id is required: it is the key a repeat of the same submission is matched on.');

  // The columns: from the top level, falling back to the answer that asked for it.
  const name = opt(body.name, 200) ?? opt(answers['Full name'], 200);
  const email = (opt(body.email, 320) ?? opt(answers['Email address'], 320))?.toLowerCase() ?? null;
  const org = opt(body.organisation ?? body.organization, 300) ?? opt(answers['Organization / household name'], 300);
  if (!name) throw new SubmissionError(422, 'name is required (or answers["Full name"]).');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SubmissionError(422, 'email is required and must look like an address (or answers["Email address"]).');

  const submitted = opt(body.submitted_at, 100);
  const stored: FormAStored = {
    answers,
    early_access_lead_id: opt(body.early_access_lead_id, 200),
    buyer_intake_id: buyer,
    correlation_id: opt(body.correlation_id, 200),
    source_campaign: opt(body.source_campaign, 200),
    submitted_at: submitted,
  };
  // The column takes a time only where the value is one unambiguously; the
  // blob keeps whatever was sent, Google Forms' "9/23/2026 14:05:09" included.
  const submittedAt = submitted && /^\d{4}-\d{2}-\d{2}T/.test(submitted) && Number.isFinite(Date.parse(submitted)) ? new Date(submitted).toISOString() : null;

  const r = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO engine_vfarm_leads (full_name, email, organization_name, source_surface, source_campaign, submitted_at, form_a)
     VALUES ($1, $2, $3, 'form_a', $4, $5, $6::jsonb)
     ON CONFLICT ((form_a->>'buyer_intake_id')) WHERE form_a ? 'buyer_intake_id'
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   email = EXCLUDED.email,
                   organization_name = EXCLUDED.organization_name,
                   source_campaign = EXCLUDED.source_campaign,
                   submitted_at = EXCLUDED.submitted_at,
                   form_a = EXCLUDED.form_a
     RETURNING id, (xmax = 0) AS inserted`,
    [name, email, org, stored.source_campaign, submittedAt, JSON.stringify(stored)],
  );

  events.changed('vfarm_leads', r.rows[0].id);
  const known = new Set(FORM_A_QUESTIONS);
  return {
    id: r.rows[0].id,
    buyer_intake_id: buyer,
    inserted: r.rows[0].inserted,
    answers: Object.keys(answers).length,
    unexpected_questions: Object.keys(answers).filter((k) => !known.has(k)),
    missing_questions: FORM_A_QUESTIONS.filter((q) => !(q in answers)),
    ignored_fields: Object.keys(body).filter((k) => !ENGINE_FIELDS.includes(k)),
  };
}
