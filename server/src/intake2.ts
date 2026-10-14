/**
 * Intake-2 — the serious-buyer "Site & Deployment Specification"
 * (VFARM_BUYER_INTAKE.v1), built 14 Oct 2026 (Destiny; Hardik's contract of
 * 13 Oct and field list of 14 Oct; Jason's go-ahead in #bha-media-twin the
 * same day).
 *
 * Jason's three requirements, and where each is held:
 *   - **one opaque link per lead, not a public form.** The link is an HMAC of
 *     the lead's deterministic invite id under `INTAKE2_LINK_SECRET`, so the
 *     same lead always gets the same link and nobody can guess another. Only
 *     its sha256 is stored, under a unique index.
 *   - **writes to that lead's existing record, no duplicate contacts.** The
 *     answers land in `engine_vfarm_leads.intake_2` on the row the link was
 *     issued for. Nothing here inserts a row.
 *   - **the 31 fields exactly as the contract defines them, uploads without a
 *     Google sign-in.** The fields are `src/data/intake2.ts`; files are
 *     uploaded through this server into a private Drive folder per lead.
 *
 * Hardik's implementation target: the Stage 1 → 2 move is the invite trigger
 * (`earlyAccess.moveStage` calls `issueInvite`); invite, submission and send
 * ids are deterministic; one completion event,
 * `serious_buyer_spec_intake_completed`, through the engine's own events
 * table; and it **fails closed** on a lead with no buyer intake id, no valid
 * email or not in Stage 2.
 *
 * **Interest only.** Nothing here sets, reads or implies a price, a
 * reservation, a subscription or a payment, and the five Client Request checks
 * (feasibility, pricing, ownership, licensing, food safety) are not touched:
 * the form attaches evidence, it does not confirm a check.
 *
 * The email is sent by n8n's `vFarm — Intake-2 Invite` (Admin Gmail, from
 * admin@bhanetwork.org, like the Form A confirmation), which answers with
 * Gmail's message id. A send that does not come back with one is recorded as
 * failed with the reason and shown on the lead.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from './pg';
import * as engineEvents from './engineEvents';
import * as events from './events';
import * as google from './google';
import * as slack from './slack';
import * as n8n from './n8n';
import { getMeta, setMeta } from './db';
import {
  INTAKE2_CONTRACT,
  INTAKE2_FIELDS,
  INTAKE2_FILE_MAX_BYTES,
  INTAKE2_FILE_TYPES,
  INTAKE2_FILES_PER_FIELD,
  answerText,
  type Intake2Field,
  type Intake2File,
  type Intake2Invite,
  type Intake2Send,
  type Intake2Stored,
} from '../../src/data/intake2';

export class Intake2Error extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
    public errors?: { field: number; label: string; message: string }[],
  ) {
    super(message);
  }
}

export const SECRET_VAR = 'INTAKE2_LINK_SECRET';
const INVITE_PATH = process.env.INTAKE2_INVITE_PATH?.trim() || '/webhook/vfarm-intake2-invite';
const DRIVE_PARENT_VAR = 'INTAKE2_DRIVE_FOLDER_ID';
const DRIVE_PARENT_META = 'intake2.drive_parent';
/** #vfarm-early-access, where the tracker announces Form A leads. */
const ALERT_CHANNEL = process.env.INTAKE2_ALERT_CHANNEL?.trim() || 'C0C36GPEB3L';
const SEND_TIMEOUT_MS = 60_000;
const MAX_UPLOADS_PER_LEAD = 20;

export const COMPLETED_EVENT = 'serious_buyer_spec_intake_completed';
export const INVITED_EVENT = 'serious_buyer_spec_intake_invited';

function base(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}
function secret(): string | null {
  return process.env[SECRET_VAR]?.trim() || null;
}
export function configured(): boolean {
  return secret() !== null;
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The suffix every deterministic id carries: VFBUYER-FORMA-3TH40G gives FORMA-3TH40G. */
function suffixOf(buyer: string): string {
  return buyer.replace(/^VFBUYER-/, '');
}
export const inviteIdFor = (buyer: string): string => `VFINT2-INV-${suffixOf(buyer)}`;
export const submissionIdFor = (buyer: string): string => `VFINT2-SUB-${suffixOf(buyer)}`;
const sendIdFor = (buyer: string, n: number): string => `VFINT2-SEND-${suffixOf(buyer)}-${n}`;

/** The link's secret part. Deterministic, so re-sending gives the same link; unguessable without the secret. */
export function tokenFor(inviteId: string): string {
  const s = secret();
  if (!s) throw new Intake2Error(503, 'not_configured', `${SECRET_VAR} is not set on this server, so no Intake-2 link can be made.`);
  return createHmac('sha256', s).update(`intake2:${inviteId}`).digest('base64url');
}
export const linkFor = (token: string): string => `${base()}/intake/${token}`;

interface Row {
  id: string;
  full_name: string;
  email: string | null;
  organization_name: string | null;
  stage: number;
  form_a: { buyer_intake_id?: string; early_access_lead_id?: string | null; correlation_id?: string | null } | null;
  intake_2: Intake2Stored | null;
  intake_2_completed_at: Date | null;
  intake_2_invite: (Omit<Intake2Invite, 'link'> & { uploads?: (Intake2File & { field: number; at: string })[] }) | null;
}

const COLS = `id, full_name, email, organization_name, stage, form_a, intake_2, intake_2_completed_at, intake_2_invite`;

async function rowById(id: string): Promise<Row | null> {
  const r = await query<Row>(`SELECT ${COLS} FROM engine_vfarm_leads WHERE id::text = $1`, [id]);
  return r.rows[0] ?? null;
}

/** The row a link opens, or null. Compared on the hash, then once more in constant time. */
async function rowByToken(token: string): Promise<Row | null> {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
  const r = await query<Row>(`SELECT ${COLS} FROM engine_vfarm_leads WHERE intake_2_invite->>'token_sha256' = $1`, [sha(token)]);
  const row = r.rows[0];
  if (!row?.intake_2_invite || !configured()) return null;
  const expect = Buffer.from(tokenFor(row.intake_2_invite.invite_id));
  const got = Buffer.from(token);
  return expect.length === got.length && timingSafeEqual(expect, got) ? row : null;
}

/** Fails closed: every reason a lead cannot be sent Intake-2, named. */
function identityOf(row: Row): { buyer: string; email: string } {
  const buyer = row.form_a?.buyer_intake_id?.trim();
  if (!buyer) throw new Intake2Error(422, 'no_buyer_intake_id', 'This lead has no buyer intake id (it came through the old public route, not Form A), so Intake-2 cannot be tied to it. It needs to come through Form A first.');
  const email = (row.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Intake2Error(422, 'no_valid_email', 'This lead has no valid email address, so the invite has nowhere to go.');
  if (row.stage !== 2) throw new Intake2Error(409, 'not_stage_2', 'Intake-2 is only sent to a lead in Stage 2. Move the lead to Stage 2 first; that sends the invite.');
  return { buyer, email };
}

/** The one lead a buyer intake id names. None is a 404 and two is a 409 naming both, never a pick. */
export async function leadIdByBuyer(buyer: string): Promise<string> {
  if (!buyer) throw new Intake2Error(422, 'no_buyer_intake_id', 'Name the lead by its buyer_intake_id.');
  const r = await query<{ id: string }>(`SELECT id FROM engine_vfarm_leads WHERE form_a->>'buyer_intake_id' = $1`, [buyer]);
  if (!r.rows.length) throw new Intake2Error(404, 'no_lead', `No lead carries buyer_intake_id ${buyer}.`);
  if (r.rows.length > 1) throw new Intake2Error(409, 'ambiguous', `More than one lead carries ${buyer}: ${r.rows.map((x) => x.id).join(', ')}.`);
  return r.rows[0].id;
}

export interface InviteOutcome {
  ok: boolean;
  reason: string;
  message: string;
  invite_id?: string;
  link?: string;
  send?: Intake2Send | null;
  dry_run?: boolean;
}

/**
 * Make the lead's invite if it has none, then email it unless it was already
 * emailed. `resend` sends again (a new send id); it is refused once the lead
 * has answered. Never throws for a send failure: the failure is the outcome,
 * stored on the lead.
 */
export async function issueInvite(leadId: string, opts: { by: string; resend?: boolean; dry_run?: boolean }): Promise<InviteOutcome> {
  const by = (opts.by || '').trim().slice(0, 120) || 'unknown';
  const row = await rowById(leadId);
  if (!row) throw new Intake2Error(404, 'no_lead', 'No lead with that id.');
  const { buyer, email } = identityOf(row);
  if (!configured()) throw new Intake2Error(503, 'not_configured', `${SECRET_VAR} is not set on this server, so no Intake-2 link can be made.`);
  if (row.intake_2_completed_at) {
    return { ok: false, reason: 'already_completed', message: `This lead already answered Intake-2 on ${row.intake_2_completed_at.toISOString().slice(0, 10)}. Nothing was sent.`, invite_id: row.intake_2_invite?.invite_id };
  }
  const inviteId = inviteIdFor(buyer);
  const token = tokenFor(inviteId);
  const link = linkFor(token);
  const sentBefore = (row.intake_2_invite?.sends ?? []).some((s) => s.outcome === 'sent');
  if (sentBefore && !opts.resend) {
    return { ok: true, reason: 'already_sent', message: 'The invite was already emailed. Nothing was sent again; use resend to send it again.', invite_id: inviteId, link, send: null };
  }
  if (opts.dry_run) {
    return { ok: true, reason: 'dry_run', message: `Would ${row.intake_2_invite ? '' : 'make the invite and '}email ${email} the Intake-2 link.`, invite_id: inviteId, link, dry_run: true };
  }

  if (!row.intake_2_invite) {
    const invite: Omit<Intake2Invite, 'link'> = { invite_id: inviteId, token_sha256: sha(token), issued_at: new Date().toISOString(), issued_by: by, sends: [], opened_at: null, drive_folder: null };
    await withTransaction(async (db) => {
      const u = await db.query(`UPDATE engine_vfarm_leads SET intake_2_invite = $2::jsonb WHERE id = $1 AND intake_2_invite IS NULL`, [row.id, JSON.stringify(invite)]);
      if (u.rowCount) {
        await engineEvents.record(
          {
            event_type: INVITED_EVENT,
            subject_id: buyer,
            lane: 'CAPITAL',
            actor: by,
            source_ref: `${base()}/vfarm?tab=early-access&lead=${row.id}`,
            detail: { buyer_intake_id: buyer, invite_id: inviteId, lead_row_id: row.id, contract: INTAKE2_CONTRACT, early_access_lead_id: row.form_a?.early_access_lead_id ?? null, correlation_id: row.form_a?.correlation_id ?? null },
            dedupe_key: `${INVITED_EVENT}:${buyer}`,
          },
          db,
        );
      }
      events.changed('vfarm_leads', row.id, db);
    });
  }

  const n = (row.intake_2_invite?.sends?.length ?? 0) + 1;
  const send = await sendEmail({ send_id: sendIdFor(buyer, n), invite_id: inviteId, to: email, name: row.full_name, organisation: row.organization_name, link, by });
  await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{sends}', coalesce(intake_2_invite->'sends', '[]'::jsonb) || $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify([send])]);
  events.changed('vfarm_leads', row.id);
  if (send.outcome === 'sent') return { ok: true, reason: 'sent', message: `Intake-2 invite emailed to ${email}.`, invite_id: inviteId, link, send };
  console.error(`[intake-2] invite ${send.send_id} to ${email} not sent: ${send.error}`);
  return { ok: false, reason: 'send_failed', message: `The invite was made but the email did not go: ${send.error}`, invite_id: inviteId, link, send };
}

async function sendEmail(a: { send_id: string; invite_id: string; to: string; name: string; organisation: string | null; link: string; by: string }): Promise<Intake2Send> {
  const at = new Date().toISOString();
  const out = (outcome: 'sent' | 'failed', gmail: string | null, error: string | null): Intake2Send => ({ send_id: a.send_id, at, by: a.by, to: a.to, outcome, gmail_message_id: gmail, error });
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return out('failed', null, 'DASHBOARD_INBOUND_KEY is not set on this server, and the invite email webhook is authenticated by it.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${n8n.n8nHost()}${INVITE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify({ send_id: a.send_id, invite_id: a.invite_id, to: a.to, name: a.name, organisation: a.organisation, link: a.link }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let body: { ok?: boolean; gmail_message_id?: string; error?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* the status decides */
    }
    if (res.ok && body.ok === true && body.gmail_message_id) return out('sent', body.gmail_message_id, null);
    return out('failed', null, `n8n answered ${res.status}: ${body.error ?? (text.slice(0, 300) || 'no body')}`);
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return out('failed', null, timedOut ? `n8n did not answer within ${SEND_TIMEOUT_MS / 1000} seconds; the email may still have gone, so check admin@bhanetwork.org's Sent folder before resending` : `could not reach n8n: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ the buyer page */

export interface PageState {
  first_name: string;
  organisation: string | null;
  submitted: boolean;
  submitted_at: string | null;
  uploads: { field: number; name: string; size: number; file_id: string }[];
}

/** Whether a link opens a lead that can see the form. Changes nothing. */
export async function isValid(token: string): Promise<boolean> {
  const row = await rowByToken(token);
  return Boolean(row && row.stage === 2);
}

/** What the page may know: a first name, the organisation, whether it was answered. Never the email or any id. */
export async function pageState(token: string): Promise<PageState | null> {
  const row = await rowByToken(token);
  if (!row || row.stage !== 2) return null;
  if (!row.intake_2_invite?.opened_at) {
    await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{opened_at}', to_jsonb($2::text)) WHERE id = $1 AND (intake_2_invite->>'opened_at') IS NULL`, [row.id, new Date().toISOString()]);
    events.changed('vfarm_leads', row.id);
  }
  return {
    first_name: (row.full_name || '').trim().split(/\s+/)[0] || 'there',
    organisation: row.organization_name,
    submitted: Boolean(row.intake_2_completed_at),
    submitted_at: row.intake_2_completed_at ? row.intake_2_completed_at.toISOString() : null,
    uploads: (row.intake_2_invite?.uploads ?? []).map((u) => ({ field: u.field, name: u.name, size: u.size, file_id: u.file_id })),
  };
}

async function driveParent(): Promise<string> {
  const fromEnv = process.env[DRIVE_PARENT_VAR]?.trim();
  if (fromEnv) return fromEnv;
  const held = await getMeta(DRIVE_PARENT_META);
  if (held) return held;
  const f = await google.createFolder('vFarm Intake-2 uploads (BHA Engine)', null);
  await setMeta(DRIVE_PARENT_META, f.id);
  console.log(`[intake-2] made the Drive folder for uploads: ${f.id}`);
  return f.id;
}

/** One file for one upload field, into the lead's own private Drive folder. */
export async function upload(token: string, fieldNo: number, name: string, mime: string, bytes: Buffer): Promise<Intake2File & { field: number }> {
  const row = await rowByToken(token);
  if (!row || row.stage !== 2) throw new Intake2Error(404, 'not_found', 'This link is not valid.');
  if (row.intake_2_completed_at) throw new Intake2Error(409, 'already_submitted', 'This specification was already sent, so no more files can be added here. Reply to the invite email to send anything else.');
  const field = INTAKE2_FIELDS.find((f) => f.n === fieldNo);
  if (!field || field.kind !== 'file') throw new Intake2Error(422, 'not_a_file_field', 'That question does not take a file.');
  if (!INTAKE2_FILE_TYPES[mime]) throw new Intake2Error(415, 'file_type', 'Only PDF, JPG and PNG files can be uploaded.');
  if (!bytes.length) throw new Intake2Error(422, 'empty_file', 'That file is empty.');
  if (bytes.length > INTAKE2_FILE_MAX_BYTES) throw new Intake2Error(413, 'file_too_large', `Each file can be up to ${INTAKE2_FILE_MAX_BYTES / 1024 / 1024} MB.`);
  const held = row.intake_2_invite?.uploads ?? [];
  if (held.length >= MAX_UPLOADS_PER_LEAD) throw new Intake2Error(429, 'too_many_files', `Up to ${MAX_UPLOADS_PER_LEAD} files can be uploaded on this link.`);
  if (!google.googleConfigured()) throw new Intake2Error(503, 'not_configured', 'File upload is not available right now. You can send the form without the file and reply to the invite email with it.');
  const cleanName = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 180) || `file-${Date.now()}`;

  let folder = row.intake_2_invite?.drive_folder ?? null;
  try {
    if (!folder) {
      const buyer = row.form_a?.buyer_intake_id ?? row.id;
      folder = await google.createFolder(`Intake-2 — ${row.organization_name || row.full_name} — ${buyer}`, await driveParent());
      await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{drive_folder}', $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify(folder)]);
    }
    const f = await google.uploadFile(folder.id, cleanName, mime, bytes);
    const stored = { file_id: f.id, name: f.name, mime: f.mime, size: f.size, link: f.link, field: fieldNo, at: new Date().toISOString() };
    await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{uploads}', coalesce(intake_2_invite->'uploads', '[]'::jsonb) || $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify([stored])]);
    events.changed('vfarm_leads', row.id);
    return stored;
  } catch (e) {
    console.error(`[intake-2] upload for ${row.form_a?.buyer_intake_id ?? row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new Intake2Error(502, 'upload_failed', 'The file could not be saved just now. Try again, or send the form without it and reply to the invite email with the file.');
  }
}

/* ------------------------------------------------------------ validation */

type Errs = { field: number; label: string; message: string }[];
const s = (v: unknown, max = 8000): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function readField(f: Intake2Field, raw: unknown, uploads: (Intake2File & { field: number })[], errs: Errs): unknown {
  const fail = (message: string) => {
    errs.push({ field: f.n, label: f.label, message });
    return undefined;
  };
  switch (f.kind) {
    case 'longtext': {
      const v = s(raw);
      if (!v) return f.required ? fail('This question needs an answer.') : undefined;
      return v;
    }
    case 'integer': {
      const t = s(raw, 20);
      if (!t) return f.required ? fail('This question needs a number.') : undefined;
      const n = Number(t);
      if (!Number.isInteger(n) || n < f.min) return fail(`Enter a whole number, ${f.min} or more.`);
      return n;
    }
    case 'select':
    case 'multi': {
      const o = (raw && typeof raw === 'object' ? raw : {}) as { choice?: unknown; choices?: unknown; detail?: unknown };
      const detail = s(o.detail, 2000);
      if (f.kind === 'select') {
        const choice = s(o.choice, 300);
        if (!choice) return f.required ? fail('Choose one.') : undefined;
        if (!f.options.includes(choice)) return fail('Choose one of the options shown.');
        const wantsDetail = f.detail && (!f.detail.when || f.detail.when === choice);
        if (wantsDetail && f.detail?.required && !detail) return fail(`Add "${f.detail.label}".`);
        return wantsDetail && detail ? { choice, detail } : { choice };
      }
      const choices = Array.isArray(o.choices) ? [...new Set(o.choices.map((c) => s(c, 300)).filter(Boolean))] : [];
      if (!choices.length) return f.required ? fail('Choose at least one.') : detail ? { choices: [], detail } : undefined;
      if (choices.some((c) => !f.options.includes(c))) return fail('Choose from the options shown.');
      return detail ? { choices, detail } : { choices };
    }
    case 'group': {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const missing: string[] = [];
      for (const p of f.parts) {
        const v = o[p.key];
        if (p.kind === 'multi') {
          const arr = Array.isArray(v) ? [...new Set(v.map((x) => s(x, 300)).filter(Boolean))] : [];
          if (arr.some((x) => !(p.options ?? []).includes(x))) return fail(`${p.label}: choose from the options shown.`);
          if (arr.length) out[p.label] = arr;
          else if (p.required) missing.push(p.label);
          continue;
        }
        const t = s(v, 2000);
        if (!t) {
          if (p.required) missing.push(p.label);
          continue;
        }
        if (p.kind === 'select' && !(p.options ?? []).includes(t)) return fail(`${p.label}: choose one of the options shown.`);
        if (p.kind === 'number') {
          const n = Number(t);
          if (!Number.isFinite(n) || n <= 0) return fail(`${p.label}: enter a number above 0.`);
          out[p.label] = n;
          continue;
        }
        out[p.label] = t;
      }
      if (!Object.keys(out).length && !f.required) return undefined;
      if (missing.length) return fail(`Still needed: ${missing.join(', ')}.`);
      return out;
    }
    case 'file': {
      const ids = Array.isArray(raw) ? raw.map((x) => s(x, 200)).filter(Boolean) : [];
      if (!ids.length) return f.required ? fail('Add a file.') : undefined;
      if (ids.length > INTAKE2_FILES_PER_FIELD) return fail(`Up to ${INTAKE2_FILES_PER_FIELD} files here.`);
      const files: Intake2File[] = [];
      for (const id of new Set(ids)) {
        const u = uploads.find((x) => x.file_id === id && x.field === f.n);
        if (!u) return fail('A file here was not uploaded through this link. Remove it and add it again.');
        files.push({ file_id: u.file_id, name: u.name, mime: u.mime, size: u.size, link: u.link });
      }
      return files;
    }
  }
}

/** The answers keyed by the contract's labels, or the reasons they cannot be stored. Pure. */
export function validate(answers: Record<string, unknown>, uploads: (Intake2File & { field: number })[]): { answers: Record<string, unknown>; errors: Errs } {
  const errors: Errs = [];
  const out: Record<string, unknown> = {};
  for (const f of INTAKE2_FIELDS) {
    const v = readField(f, answers[f.id], uploads, errors);
    if (v !== undefined) out[f.label] = v;
  }
  return { answers: out, errors };
}

function digestOf(answers: Record<string, unknown>): string {
  return sha(JSON.stringify(INTAKE2_FIELDS.map((f) => [f.label, answers[f.label] ?? null])));
}

export interface SubmitResult {
  ok: true;
  already: boolean;
  submission_id: string;
  submitted_at: string;
}

/**
 * Store the answers on the lead, once. The same answers sent again (a retry)
 * answer `already: true` and change nothing; different answers after the
 * first are refused, because the first is what the record says the buyer told
 * us. The event lands in the same transaction as the answers.
 */
export async function submit(token: string, body: Record<string, unknown>, userAgent: string | null): Promise<SubmitResult> {
  const row = await rowByToken(token);
  if (!row || row.stage !== 2 || !row.intake_2_invite) throw new Intake2Error(404, 'not_found', 'This link is not valid.');
  const buyer = row.form_a?.buyer_intake_id;
  if (!buyer) throw new Intake2Error(404, 'not_found', 'This link is not valid.');
  const raw = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {}) as Record<string, unknown>;
  const { answers, errors } = validate(raw, row.intake_2_invite.uploads ?? []);
  if (errors.length) throw new Intake2Error(422, 'invalid', `${errors.length} answer${errors.length === 1 ? '' : 's'} need${errors.length === 1 ? 's' : ''} another look.`, errors);
  const digest = digestOf(answers);
  const submissionId = submissionIdFor(buyer);

  if (row.intake_2) {
    if (row.intake_2.digest === digest) return { ok: true, already: true, submission_id: row.intake_2.submission_id, submitted_at: row.intake_2.submitted_at };
    throw new Intake2Error(409, 'already_submitted', 'This specification was already sent. To change an answer, reply to the invite email and the team will update it.');
  }

  const now = new Date().toISOString();
  const stored: Intake2Stored & { user_agent: string | null; notified: null } = {
    contract: INTAKE2_CONTRACT,
    invite_id: row.intake_2_invite.invite_id,
    submission_id: submissionId,
    buyer_intake_id: buyer,
    early_access_lead_id: row.form_a?.early_access_lead_id ?? null,
    correlation_id: row.form_a?.correlation_id ?? null,
    submitted_at: now,
    answers,
    drive_folder: row.intake_2_invite.drive_folder ?? null,
    digest,
    user_agent: userAgent ? userAgent.slice(0, 300) : null,
    notified: null,
  };
  const landed = await withTransaction(async (db) => {
    const u = await db.query(`UPDATE engine_vfarm_leads SET intake_2 = $2::jsonb, intake_2_completed_at = $3 WHERE id = $1 AND intake_2 IS NULL`, [row.id, JSON.stringify(stored), now]);
    if (!u.rowCount) return false;
    await engineEvents.record(
      {
        event_type: COMPLETED_EVENT,
        at: now,
        subject_id: buyer,
        lane: 'CAPITAL',
        actor: 'the buyer (Intake-2 link)',
        source_ref: `${base()}/vfarm?tab=early-access&lead=${row.id}`,
        detail: {
          buyer_intake_id: buyer,
          submission_id: submissionId,
          invite_id: stored.invite_id,
          lead_row_id: row.id,
          contract: INTAKE2_CONTRACT,
          early_access_lead_id: stored.early_access_lead_id,
          correlation_id: stored.correlation_id,
          answered: Object.keys(answers).length,
          files: INTAKE2_FIELDS.filter((f) => f.kind === 'file').reduce((n, f) => n + ((answers[f.label] as unknown[] | undefined)?.length ?? 0), 0),
          checks_still_open: ['Feasibility', 'Pricing', 'Ownership', 'Licensing', 'Food Safety'],
        },
        dedupe_key: `${COMPLETED_EVENT}:${buyer}`,
      },
      db,
    );
    events.changed('vfarm_leads', row.id, db);
    return true;
  });
  if (!landed) {
    // Another request stored it between the read and the write: answer as a retry would.
    const again = await rowById(row.id);
    if (again?.intake_2?.digest === digest) return { ok: true, already: true, submission_id: again.intake_2.submission_id, submitted_at: again.intake_2.submitted_at };
    throw new Intake2Error(409, 'already_submitted', 'This specification was already sent. To change an answer, reply to the invite email and the team will update it.');
  }
  await announce(row, stored).catch((e) => console.error(`[intake-2] alert for ${buyer} failed: ${e instanceof Error ? e.message : String(e)}`));
  return { ok: true, already: false, submission_id: submissionId, submitted_at: now };
}

/** One post in #vfarm-early-access as Bays. Its outcome is written onto the stored answers, never lost. */
async function announce(row: Row, stored: Intake2Stored): Promise<void> {
  const a = stored.answers;
  const get = (n: number): string => {
    const f = INTAKE2_FIELDS.find((x) => x.n === n)!;
    return answerText(f, a[f.label]) || 'not given';
  };
  const site = (a[INTAKE2_FIELDS[5].label] ?? {}) as Record<string, unknown>;
  const where = [site['City'], site['Country']].filter(Boolean).join(', ') || 'not given';
  const text = [
    '*Intake-2 received (Site & Deployment Specification)*',
    `*Name:* ${row.full_name}`,
    `*Organisation:* ${row.organization_name ?? 'not given'}`,
    `*Racks to evaluate:* ${get(3)}`,
    `*Site:* ${where}`,
    `*Ready for review:* ${get(22)}`,
    `*Approval and budget:* ${get(23)}`,
    `*Buyer:* ${stored.buyer_intake_id}`,
    '',
    'Interest only. Feasibility, pricing, ownership, licensing and food-safety checks are still open; this attaches evidence, it confirms none of them.',
    `Full record: ${base()}/vfarm?tab=early-access&lead=${row.id}`,
  ].join('\n');
  const r = await slack.botCall('chat.postMessage', { channel: ALERT_CHANNEL, text, unfurl_links: false });
  const notified = r.ok ? { at: new Date().toISOString(), channel: ALERT_CHANNEL, ts: String(r.ts ?? ''), error: null } : { at: new Date().toISOString(), channel: ALERT_CHANNEL, ts: null, error: String(r.error ?? 'unknown') };
  await query(`UPDATE engine_vfarm_leads SET intake_2 = jsonb_set(intake_2, '{notified}', $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify(notified)]);
  events.changed('vfarm_leads', row.id);
  if (!r.ok) console.error(`[intake-2] alert for ${stored.buyer_intake_id} not posted: ${r.error}`);
}

/**
 * The invite as the dashboard may show it: the link is worked out again from
 * the invite id (it is never stored), and the hash is left out.
 */
export function forPage(inv: Omit<Intake2Invite, 'link'> | null): Omit<Intake2Invite, 'token_sha256'> | null {
  if (!inv) return null;
  const { token_sha256: _drop, ...rest } = inv;
  let link = '';
  try {
    link = linkFor(tokenFor(inv.invite_id));
  } catch {
    link = `(${SECRET_VAR} is not set, so the link cannot be shown)`;
  }
  return { ...rest, link };
}
