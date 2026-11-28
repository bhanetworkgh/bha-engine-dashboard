/**
 * Excused sessions: hard-block days (28 Nov 2026, Destiny — Jason's SOP 8996e4da, approved in C0AFEAEHWR2
 * 1795129017.299389, "SOP -- Excused Sessions: Hard Block Incidents"). The numbers and the four block types
 * live in RULE and nowhere else.
 *
 * A builder who could not work at all on a day, because of a power cut, an internet outage, a blocked site or a
 * medical emergency, gets one excused_session per affected UTC day, all tied to one hard-block incident in the
 * ledger, with at least one supporting artefact, drafted within 24 hours of the block ending. Weather alone, a
 * busy day or work that ran long never counts.
 *
 * What an approved one does, and only that:
 *   - it pays 0%: it is not a Codex log, so it never reaches the pay ledger and never counts as a work session;
 *   - the missing-log check (codexGap) does not count the excused day as part of a gap, so no "missed log" DM;
 *   - where the approver says so (suppress_penalty), a Decision Watch escalation on that UTC day is not a pay
 *     penalty (watchPenalty.judge, outcome excused). That day only: earlier penalties stay.
 * Nothing is relabelled: no log is touched, the 19 Nov 2026 entries stay as recorded, and a session is a new
 * record written when it is raised. Agents may draft one; only Destiny (primary) or Jason decides, never the
 * builder on their own day. More than RULE.limit_count in RULE.limit_days for one builder is flagged on the record
 * for Destiny's conversation; nothing happens automatically from the count.
 *
 * The incident it opens is a person's hard block, not an engine fault: its workflow is HARD_BLOCK_WORKFLOW, which
 * logstream.excludedReason leaves out of Logstream, the self-healing scorecard, pattern capture and research.
 */
import { query, withTransaction } from './pg';
import * as bharag from './bharag';
import * as mirror from './mirror';
import * as events from './events';
import * as engineEvents from './engineEvents';
import * as slack from './slack';
import { isFormerBuilder } from './sources';

export const RULE = {
  block_types: ['power_outage', 'internet_outage', 'access_blocked', 'medical_emergency'] as const,
  evidence_within_hours: 24,
  limit_count: 3,
  limit_days: 30,
  max_days_per_block: 14,
  sop: 'SOP -- Excused Sessions: Hard Block Incidents (BHARAG 8996e4da-66bb-4685-9de9-1b6b7405f5c8)',
} as const;

export type BlockType = (typeof RULE.block_types)[number];
export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';
export const DECIDERS: readonly string[] = [DESTINY, JASON];
export const HARD_BLOCK_WORKFLOW = 'Excused session: hard block';
const BLOCK_WORDS: Record<BlockType, string> = {
  power_outage: 'power outage',
  internet_outage: 'internet outage',
  access_blocked: 'physical access to the rack or site blocked',
  medical_emergency: 'medical emergency',
};

export interface SessionRow {
  session_id: string;
  builder_user_id: string;
  builder_name: string | null;
  day: string;
  incident_id: string;
  block_type: BlockType;
  block_start: Date;
  block_end: Date;
  evidence: string[];
  note: string | null;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  suppress_penalty: boolean;
  over_limit: boolean;
  test: boolean;
  drafted_by: string;
  drafted_via: string | null;
  drafted_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

type Refusal = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message });
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** The UTC days a block covers, start to end inclusive. Pure. */
export function daysIn(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  // A block ending exactly at midnight does not touch the day that starts then.
  const last = new Date(end.getTime() - 1);
  while (d.getTime() <= last.getTime()) {
    out.push(dayOf(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A link a person can open, or an evidence id (EV-…). Pure. */
export const isArtefact = (s: string) => /^https:\/\/\S+$/i.test(s.trim()) || /^EV-\d+-[A-Z0-9]{4}$/i.test(s.trim());

export interface DraftInput {
  builder_user_id: string;
  block_type: string;
  block_start: string;
  block_end: string;
  evidence: string[];
  note?: string | null;
  days?: string[] | null;
  incident_id?: string | null;
  drafted_by: string;
  drafted_via?: string | null;
  test?: boolean;
}

/**
 * Everything the SOP asks of a draft that can be checked without a database. Pure, so the rule is tested alone.
 * Returns the days the sessions are for, or the refusal.
 */
export function checkDraft(i: DraftInput, now: Date): { ok: true; days: string[]; start: Date; end: Date; type: BlockType } | Refusal {
  if (!/^U[A-Z0-9]+$/.test(i.builder_user_id ?? '')) return refuse('builder_required', 'builder_user_id must be the builder\'s Slack id (U…).');
  if (isFormerBuilder(i.builder_user_id)) return refuse('former_builder', `${i.builder_user_id} is no longer with BHA.`);
  if (!(RULE.block_types as readonly string[]).includes(i.block_type)) return refuse('not_a_hard_block', `block_type is one of ${RULE.block_types.join(', ')}. Weather on its own, a busy day or work that ran long never counts (${RULE.sop}).`);
  const start = new Date(i.block_start), end = new Date(i.block_end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return refuse('bad_times', 'block_start and block_end are ISO times with a zone, e.g. 2026-11-27T08:00:00Z.');
  if (end.getTime() <= start.getTime()) return refuse('bad_times', 'block_end must be after block_start.');
  if (end.getTime() > now.getTime()) return refuse('block_not_over', 'Draft it once the block has ended, with its real end time.');
  if (now.getTime() - end.getTime() > RULE.evidence_within_hours * 3_600_000) return refuse('evidence_late', `The SOP asks for the incident and evidence within ${RULE.evidence_within_hours} hours of the block ending; this one ended at ${iso(end)}. A late case goes to Destiny as a conversation, not an excused session.`);
  const evidence = (i.evidence ?? []).map((e) => String(e).trim()).filter(Boolean);
  if (!evidence.length) return refuse('evidence_required', 'At least one supporting artefact is required: a link (utility or ISP outage notice, a screenshot or photo in Slack, a one-line note to Jason or Destiny for a medical emergency) or an evidence id (EV-…).');
  const bad = evidence.filter((e) => !isArtefact(e));
  if (bad.length) return refuse('evidence_not_a_link', `Each artefact is an https link or an EV- id; these are not: ${bad.join(', ')}.`);
  const covered = daysIn(start, end);
  if (covered.length > RULE.max_days_per_block) return refuse('block_too_long', `A block over ${RULE.max_days_per_block} days goes to Destiny as a conversation.`);
  const days = i.days && i.days.length ? [...new Set(i.days.map((d) => String(d).trim()))] : covered;
  const outside = days.filter((d) => !covered.includes(d));
  if (outside.length) return refuse('day_outside_block', `Only days inside the recorded block qualify (${covered.join(', ')}); not ${outside.join(', ')}.`);
  return { ok: true, days: days.sort(), start, end, type: i.block_type as BlockType };
}

/** Whether a decider may decide this session. Pure. Never the builder on their own day, except a marked test. */
export function mayDecide(s: Pick<SessionRow, 'builder_user_id' | 'test'>, by: string): Refusal | null {
  if (!DECIDERS.includes(by)) return refuse('not_permitted', 'Only Destiny (the primary approver) or Jason decides an excused session. An agent may draft one but never approves it.');
  if (by === s.builder_user_id && !s.test) return refuse('own_session', by === DESTINY ? 'Your own excused session goes to Jason.' : 'Your own excused session goes to Destiny.');
  return null;
}

/** The latest moment an approved session covers for this builder after a given time: the end of its day or its block. Pure. */
export function coveredUntil(rows: Array<Pick<SessionRow, 'day' | 'block_end' | 'status'>>, after: Date): Date | null {
  let best: Date | null = null;
  for (const r of rows) {
    if (r.status !== 'approved') continue;
    const dayEnd = new Date(`${r.day}T00:00:00Z`);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    if (dayEnd.getTime() <= after.getTime()) continue;
    if (!best || dayEnd.getTime() > best.getTime()) best = dayEnd;
  }
  return best;
}

async function profileName(userId: string): Promise<string | null | undefined> {
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [userId]);
  return r.rows[0] ? r.rows[0].name ?? null : undefined;
}

async function openHardBlockIncident(i: { builder: string; name: string | null; type: BlockType; start: Date; end: Date; evidence: string[]; note: string | null; test: boolean }): Promise<string> {
  const summary = `${i.test ? 'TEST ' : ''}Hard block: ${BLOCK_WORDS[i.type]} for ${i.name ?? i.builder}, ${iso(i.start)} to ${iso(i.end)}`;
  const body = {
    type: 'INC' as const,
    subsystem: 'CODEX', source: 'bays', severity: 'warning',
    summary,
    payload: {
      lane: 'bays', workflow_or_scenario: HARD_BLOCK_WORKFLOW, failed_node_or_component: i.type,
      error_class: 'HARD_BLOCK',
      error_message: `${BLOCK_WORDS[i.type]} kept ${i.name ?? i.builder} (${i.builder}) from working from ${iso(i.start)} to ${iso(i.end)}. Evidence: ${i.evidence.join(' ')}${i.note ? `. Note: ${i.note}` : ''}`.slice(0, 1000),
      error_message_original_bytes: null,
      execution_id: `hard_block:${i.builder}:${iso(i.start)}`, impact_tags: ['hard_block', 'excused_session', ...(i.test ? ['test'] : [])],
      retry_policy: { retryable: false, max_retries: 0, retry_interval: '5m', retries_attempted: 0 },
      self_healing_strategy: `A person's hard block, not an engine fault. Destiny (or Jason) decides the excused_session it carries (${RULE.sop}); the incident closes with that decision.`,
      research_needed: false, research_id: null, commercial_hint: null, resolved_at: null, resolved_by: null,
    },
  };
  const opened = await bharag.openIncident('bays', body);
  try {
    const res = opened.raw && typeof opened.raw === 'object' ? (opened.raw as Record<string, unknown>) : {};
    const inc = (res.incident && typeof res.incident === 'object' ? res.incident : res) as Record<string, unknown>;
    await mirror.upsert('incidents', { fields: { ...body, resolution_status: 'open', created_at: new Date().toISOString(), ...inc, entity_id: opened.id }, lane_id: 'bays' }, 'engine');
    await query(`UPDATE engine_incidents SET open_now = true, last_seen_open = $2 WHERE natural_id = $1`, [opened.id, new Date().toISOString()]);
    events.changed('incidents');
  } catch (e) {
    console.error(`[excused] Engine health copy of ${opened.id} was not written: ${e instanceof Error ? e.message : String(e)}`);
  }
  return opened.id;
}

export type DraftResult = { ok: true; sessions: ReturnType<typeof show>[]; incident_id: string; incident_opened: boolean; over_limit: boolean; destiny_told: boolean; message: string } | Refusal;

/** Draft one excused session per day of a hard block. Writes the incident (or uses the one named) and the rows; decides nothing. */
export async function draft(i: DraftInput, opts: { dry_run?: boolean; now?: Date; dm?: typeof slack.dm } = {}): Promise<DraftResult & { dry_run?: boolean }> {
  const now = opts.now ?? new Date();
  const c = checkDraft(i, now);
  if (!c.ok) return c;
  const name = await profileName(i.builder_user_id);
  if (name === undefined) return refuse('no_profile', `${i.builder_user_id} has no Builder Profile, so they are not a builder this engine pays.`);
  const held = await query<{ day: string; session_id: string; status: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, session_id, status FROM engine_excused_sessions WHERE builder_user_id = $1 AND day = ANY($2::date[]) AND status IN ('pending','approved')`,
    [i.builder_user_id, c.days],
  );
  if (held.rows.length) return refuse('already_held', `Already held: ${held.rows.map((r) => `${r.day} (${r.session_id}, ${r.status})`).join(', ')}. One excused session per builder per day.`);
  if (i.incident_id) {
    const inc = await query(`SELECT 1 FROM engine_incidents WHERE natural_id = $1`, [i.incident_id]);
    if (!inc.rows.length) return refuse('incident_not_found', `No incident ${i.incident_id} is held. Leave incident_id out and one is opened for the block.`);
  }
  const recent = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM engine_excused_sessions WHERE builder_user_id = $1 AND status IN ('pending','approved') AND day > ($2::date - make_interval(days => $3))`,
    [i.builder_user_id, c.days[c.days.length - 1], RULE.limit_days],
  );
  const overLimit = Number(recent.rows[0]?.n ?? 0) + c.days.length > RULE.limit_count;
  if (opts.dry_run) {
    return { ok: true, dry_run: true, sessions: [], incident_id: i.incident_id ?? '(would be opened)', incident_opened: !i.incident_id, over_limit: overLimit, destiny_told: false, message: `Would draft ${c.days.length} excused session${c.days.length === 1 ? '' : 's'} (${c.days.join(', ')}) for ${name ?? i.builder_user_id}, ${BLOCK_WORDS[c.type]}${overLimit ? `; over ${RULE.limit_count} in ${RULE.limit_days} days, so flagged for Destiny's conversation` : ''}.` };
  }
  let incidentId = i.incident_id ?? null;
  let opened = false;
  if (!incidentId) {
    try {
      incidentId = await openHardBlockIncident({ builder: i.builder_user_id, name: name ?? null, type: c.type, start: c.start, end: c.end, evidence: i.evidence, note: i.note ?? null, test: i.test === true });
      opened = true;
    } catch (e) {
      return refuse('incident_not_opened', `The hard-block incident could not be opened in the ledger, so no excused session was drafted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const rows = await withTransaction(async (db) => {
    const out: SessionRow[] = [];
    for (const day of c.days) {
      const id = `EXS-${now.getTime()}-${day.replace(/-/g, '').slice(4)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
      const r = await db.query<SessionRow>(
        `INSERT INTO engine_excused_sessions (session_id, builder_user_id, builder_name, day, incident_id, block_type, block_start, block_end, evidence, note, over_limit, test, drafted_by, drafted_via, drafted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, i.builder_user_id, name ?? null, day, incidentId, c.type, c.start.toISOString(), c.end.toISOString(), JSON.stringify(i.evidence), i.note ?? null, overLimit, i.test === true, i.drafted_by, i.drafted_via ?? null, now.toISOString()],
      );
      out.push(r.rows[0]);
      await engineEvents.record({ event_type: 'excused_session_drafted', subject_id: id, lane: 'BAYS', actor: i.drafted_by, detail: { builder: i.builder_user_id, day, incident_id: incidentId, block_type: c.type, over_limit: overLimit, test: i.test === true }, dedupe_key: `excused:drafted:${id}` }, db);
    }
    return out;
  });
  const told = await (opts.dm ?? slack.dm)(DESTINY, [
    `${i.test ? 'TEST: ' : ''}Excused session${rows.length === 1 ? '' : 's'} to decide for <@${i.builder_user_id}>: ${BLOCK_WORDS[c.type]}, ${iso(c.start)} to ${iso(c.end)}, incident ${incidentId}.`,
    `Days: ${rows.map((r) => `${String(r.day).slice(0, 10)} (${r.session_id})`).join(', ')}. Evidence: ${i.evidence.join(' ')}.`,
    overLimit ? `This builder is over ${RULE.limit_count} in ${RULE.limit_days} days: a conversation with them before deciding.` : '',
    `Approve or decline with decide_excused_session. It pays 0%; approved, the day is not a missed log, and you say whether a watch penalty that day is suppressed.`,
  ].filter(Boolean).join('\n')).catch((e) => ({ ok: false, detail: String(e) }));
  if (!told.ok) console.error(`[excused] Destiny was not told of ${rows.map((r) => r.session_id).join(', ')}: ${told.detail}`);
  events.changed('excused_sessions');
  return { ok: true, sessions: rows.map((r) => show(r)), incident_id: incidentId as string, incident_opened: opened, over_limit: overLimit, destiny_told: told.ok, message: `${rows.length} excused session${rows.length === 1 ? '' : 's'} drafted and waiting on Destiny. Nothing is excused until it is approved.` };
}

export type DecideResult = { ok: true; sessions: ReturnType<typeof show>[]; incident_closed: boolean | null; message: string } | Refusal;

/** Approve, decline or withdraw drafted sessions. Destiny or Jason; never the builder on their own day (a test excepted). */
export async function decide(sessionIds: string[], by: string, decision: 'approved' | 'declined' | 'withdrawn', reason: string, opts: { suppress_penalty?: boolean; now?: Date } = {}): Promise<DecideResult> {
  const now = opts.now ?? new Date();
  if (!sessionIds.length) return refuse('session_required', 'Name at least one session_id (EXS-…).');
  if (reason.trim().length < 3) return refuse('reason_required', 'Say why in a sentence.');
  const found = await query<SessionRow>(`SELECT * FROM engine_excused_sessions WHERE session_id = ANY($1::text[])`, [sessionIds]);
  const missing = sessionIds.filter((id) => !found.rows.some((r) => r.session_id === id));
  if (missing.length) return refuse('not_found', `No excused session ${missing.join(', ')}.`);
  for (const s of found.rows) {
    const no = mayDecide(s, by);
    if (no) return no;
    if (decision === 'withdrawn' ? s.status === 'withdrawn' || s.status === 'declined' : s.status !== 'pending') return refuse('already_decided', `${s.session_id} is already ${s.status}.`);
  }
  const suppress = decision === 'approved' && opts.suppress_penalty === true;
  const rows = await withTransaction(async (db) => {
    const out: SessionRow[] = [];
    for (const s of found.rows) {
      const r = await db.query<SessionRow>(
        `UPDATE engine_excused_sessions SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5, suppress_penalty = $6 WHERE session_id = $1 RETURNING *`,
        [s.session_id, decision, by, now.toISOString(), reason.trim(), suppress],
      );
      out.push(r.rows[0]);
      await engineEvents.record({ event_type: 'excused_session_decided', subject_id: s.session_id, lane: 'BAYS', actor: by, detail: { decision, suppress_penalty: suppress, reason: reason.trim().slice(0, 400), builder: s.builder_user_id, day: String(s.day).slice(0, 10), incident_id: s.incident_id, was: s.status }, dedupe_key: `excused:${decision}:${s.session_id}` }, db);
    }
    return out;
  });
  // Close each incident once none of its sessions is waiting. Never undoes the decision.
  let closed: boolean | null = null;
  for (const inc of [...new Set(rows.map((r) => r.incident_id))]) {
    const open = await query(`SELECT 1 FROM engine_excused_sessions WHERE incident_id = $1 AND status = 'pending' LIMIT 1`, [inc]);
    const ours = await query<{ wf: string | null; open_now: boolean | null }>(`SELECT fields->'payload'->>'workflow_or_scenario' AS wf, open_now FROM engine_incidents WHERE natural_id = $1`, [inc]);
    if (open.rows.length || ours.rows[0]?.wf !== HARD_BLOCK_WORKFLOW || ours.rows[0]?.open_now === false) continue;
    try {
      await bharag.closeIncident('bays', inc, `${by} (excused session ${decision})`, now.toISOString());
      await query(`UPDATE engine_incidents SET open_now = false, resolved_at = $2, resolved_by = $3 WHERE natural_id = $1`, [inc, now.toISOString(), `${by} (excused session ${decision})`]);
      events.changed('incidents');
      closed = closed !== false;
    } catch (e) {
      closed = false;
      console.error(`[excused] ${inc} decided but the incident was not closed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  events.changed('excused_sessions');
  return { ok: true, sessions: rows.map((r) => show(r)), incident_closed: closed, message: `${rows.length} session${rows.length === 1 ? '' : 's'} ${decision}${suppress ? ', watch penalty that day suppressed' : ''}.` };
}

/** Approved sessions of one builder, for the missing-log check. */
export async function approvedFor(builder: string, since: Date): Promise<SessionRow[]> {
  const r = await query<SessionRow>(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM engine_excused_sessions WHERE builder_user_id = $1 AND status = 'approved' AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date`, [builder, since.toISOString()]);
  return r.rows;
}

/** The approved, penalty-suppressing session for this builder on this UTC day, if any. */
export async function suppressingOn(builder: string, at: Date): Promise<SessionRow | null> {
  const r = await query<SessionRow>(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM engine_excused_sessions WHERE builder_user_id = $1 AND status = 'approved' AND suppress_penalty AND day = $2::date LIMIT 1`, [builder, dayOf(at)]);
  return r.rows[0] ?? null;
}

export function show(r: SessionRow) {
  return {
    session_id: r.session_id,
    builder_user_id: r.builder_user_id,
    builder_name: r.builder_name,
    day: String(r.day).slice(0, 10),
    incident_id: r.incident_id,
    block_type: r.block_type,
    block: `${BLOCK_WORDS[r.block_type] ?? r.block_type}, ${iso(r.block_start)} to ${iso(r.block_end)}`,
    evidence: r.evidence,
    note: r.note,
    status: r.status,
    pay: '0% (no work, no pay; never a work session)',
    missed_log: r.status === 'approved' ? 'not counted as a missed log' : 'counts as a missed log until approved',
    watch_penalty: r.status === 'approved' ? (r.suppress_penalty ? 'suppressed for this day only' : 'not suppressed') : 'not suppressed',
    over_limit: r.over_limit,
    test: r.test,
    drafted_by: r.drafted_by,
    drafted_via: r.drafted_via,
    drafted_at: iso(r.drafted_at),
    decided_by: r.decided_by,
    decided_at: iso(r.decided_at),
    decision_reason: r.decision_reason,
  };
}

export async function read(opts: { builder?: string | null; status?: string | null; limit?: number } = {}) {
  const r = await query<SessionRow>(
    `SELECT * FROM engine_excused_sessions WHERE ($1::text IS NULL OR builder_user_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY drafted_at DESC, day DESC LIMIT $3`,
    [opts.builder ?? null, opts.status ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );
  return { rule: RULE, sessions: r.rows.map(show), count: r.rows.length };
}
