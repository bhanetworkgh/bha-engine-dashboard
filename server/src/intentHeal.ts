/**
 * An intent-check incident the engine fixed itself (19 Nov 2026, Destiny — Genie rebuild step 9.3).
 *
 * A second miss on one ask opens an incident on the Bays lane (intentCheck.raiseIncident). Very often
 * Bays then gets the same write right on its next try, and a person closed the incident by hand after
 * checking just that. This sweep makes that check: an incident is closed `self_healed` when, within
 * `RULE.window_minutes` of the miss that opened it,
 *   - Bays' check on the same ask and the same tool passed,
 *   - on the same record (the LOOP-, DW-, TASK- … id the action names; a write that names none, such as
 *     a new loop or a DM, is never closed here, because a pass on a different record is not the fix), and
 *   - that write landed (a line on engine_mcp_writes with a landed outcome naming the record).
 * Anything else stays open for a person. Each close posts one line in #bha-self-healing as Bays and
 * writes one `intent_check_self_healed` event, which the self-healing scorecard counts as an engine fix.
 * An incident a person already closed whose case meets the same rule gets the event too
 * (`backfilled: true`, the ledger untouched), so the scorecard counts what the engine really fixed.
 */
import { nowIso, query } from './db';
import * as slack from './slack';
import * as bharag from './bharag';
import * as events from './events';
import * as engineEvents from './engineEvents';
import * as timers from './timers';

export const RULE = {
  window_minutes: 30,
  /** How far back each pass looks. Cheap: a handful of rows. */
  lookback_days: 30,
  /** The write behind a passing check lands within this many seconds of it. */
  landed_within_seconds: 120,
  landed: ['updated', 'inserted', 'archived', 'applied'],
  channel: process.env.SELF_HEALING_CHANNEL || 'C0C3AGDQWDS',
  every_minutes: 5,
} as const;

const TARGET = /\b(?:LOOP|DW|TASK|CAND|CARD|JOB|MTP)-\d{10,}-[A-Z0-9]{4}\b/;

/** The record an action names, or null. Pure. */
export function targetOf(action: string | null | undefined): string | null {
  return String(action ?? '').match(TARGET)?.[0] ?? null;
}

export interface CheckRow { check_id: string; tool: string; at: string; action: string }

/** The passing check that fixes this miss, or null. Pure. */
export function passFor(miss: CheckRow, passes: CheckRow[], windowMinutes: number = RULE.window_minutes): CheckRow | null {
  const target = targetOf(miss.action);
  if (!target) return null;
  const from = Date.parse(miss.at);
  const to = from + windowMinutes * 60_000;
  return [...passes]
    .sort((a, b) => a.at.localeCompare(b.at))
    .find((p) => p.tool === miss.tool && Date.parse(p.at) > from && Date.parse(p.at) <= to && targetOf(p.action) === target) ?? null;
}

interface MissRow extends CheckRow { agent: string; ask_key: string; incident_id: string; open_now: boolean | null; status: string | null; lane_id: string | null }

export interface HealResult { checked: number; closed: string[]; backfilled: string[]; left_open: Array<{ incident_id: string; why: string }>; failed: Array<{ incident_id: string; why: string }>; dry_run: boolean }

async function landedWrite(pass: CheckRow, target: string): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id::text FROM engine_mcp_writes
      WHERE tool = $1 AND outcome = ANY($2) AND at >= $3::timestamptz AND at <= $3::timestamptz + ($4 || ' seconds')::interval
        AND (natural_id = $5 OR target LIKE '%' || $5 || '%' OR arguments::text LIKE '%' || $5 || '%')
      ORDER BY at LIMIT 1`,
    [pass.tool, RULE.landed, pass.at, String(RULE.landed_within_seconds), target],
  );
  return r.rows[0]?.id ?? null;
}

async function alreadyRecorded(incidentId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM engine_events WHERE event_type = 'intent_check_self_healed' AND subject_id = $1 LIMIT 1`, [incidentId]);
  return r.rows.length > 0;
}

async function closeLedger(m: MissRow, resolvedBy: string): Promise<{ ok: boolean; why: string | null }> {
  const lane = m.lane_id ?? 'bays';
  const at = nowIso();
  let http: number | null = 200;
  try {
    if (m.status !== 'retrying') await bharag.markRetrying(lane, m.incident_id);
    await bharag.closeIncident(lane, m.incident_id, resolvedBy, at, 'self_healed');
  } catch (e) {
    http = e instanceof bharag.BharagError ? e.status || null : null;
    const why = e instanceof Error ? e.message : String(e);
    await logLedger(m.incident_id, 'failed', m.status ?? 'open', why, http, lane, resolvedBy);
    return { ok: false, why };
  }
  await query(`UPDATE engine_incidents SET fields = fields || $2::jsonb, open_now = false, updated_at = $3, resolved_at = $3, resolved_by = $4 WHERE natural_id = $1`, [
    m.incident_id, JSON.stringify({ resolution_status: 'self_healed' }), at, resolvedBy,
  ]);
  events.changed('incidents');
  await logLedger(m.incident_id, 'ok', 'self_healed', null, http, lane, resolvedBy);
  return { ok: true, why: null };
}

async function logLedger(id: string, state: 'ok' | 'failed', status: string, reason: string | null, http: number | null, lane: string, by: string): Promise<void> {
  await query(
    `INSERT INTO record_writes (kind, record_id, natural_id, state, status, reason, http, action, detail, actor, at)
     VALUES ('incidents', $1, $1, $2, $3, $4, $5, 'close', $6, 'intent-heal', $7)`,
    [id, state, status, reason, http, `POST ${bharag.BHARAG_URL}/incidents/${id}/status → retrying → self_healed (lane ${lane}, ${by})`, nowIso()],
  );
}

/** The #bha-self-healing line. Pure. */
export function line(incidentId: string, tool: string, target: string, passId: string, auditId: string, seconds: number): string {
  return `${incidentId} closed by the engine: Bays' second wrong try at ${tool} on ${target} was refused, and its next try on the same ask passed the intent check (${passId}) and landed (audit ${auditId}) ${seconds} seconds later. Nothing wrong was written.`;
}

let busy = false;

export async function sweep(opts: { dry_run?: boolean } = {}): Promise<HealResult> {
  const out: HealResult = { checked: 0, closed: [], backfilled: [], left_open: [], failed: [], dry_run: Boolean(opts.dry_run) };
  if (busy && !opts.dry_run) return out;
  if (!opts.dry_run) busy = true;
  try {
    const misses = await query<MissRow>(
      `SELECT m.check_id, m.tool, m.at::text AS at, m.action, m.agent, m.ask_key, m.incident_id,
              i.open_now, i.fields->>'resolution_status' AS status, i.lane_id
         FROM engine_intent_checks m JOIN engine_incidents i ON i.natural_id = m.incident_id
        WHERE m.incident_id IS NOT NULL AND m.at > now() - ($1 || ' days')::interval AND m.at < now() - interval '2 minutes'
        ORDER BY m.at`,
      [String(RULE.lookback_days)],
    );
    for (const m of misses.rows) {
      out.checked++;
      if (await alreadyRecorded(m.incident_id)) continue;
      const target = targetOf(m.action);
      const passes = await query<CheckRow>(
        `SELECT check_id, tool, at::text AS at, action FROM engine_intent_checks
          WHERE agent = $1 AND ask_key = $2 AND verdict = 'match' AND at > $3::timestamptz AND at <= $3::timestamptz + ($4 || ' minutes')::interval`,
        [m.agent, m.ask_key, m.at, String(RULE.window_minutes)],
      );
      const pass = passFor(m, passes.rows);
      const open = m.open_now !== false && !['self_healed', 'manually_resolved', 'wont_fix'].includes(String(m.status));
      if (!pass) {
        if (open) out.left_open.push({ incident_id: m.incident_id, why: target ? `no passing ${m.tool} on ${target} on the same ask within ${RULE.window_minutes} minutes` : 'the action names no record, so a later pass cannot be shown to be the fix' });
        continue;
      }
      const audit = await landedWrite(pass, target!);
      if (!audit) {
        if (open) out.left_open.push({ incident_id: m.incident_id, why: `${pass.check_id} passed but no landed ${pass.tool} on ${target} was found` });
        continue;
      }
      const seconds = Math.round((Date.parse(pass.at) - Date.parse(m.at)) / 1000);
      const detail = { tool: m.tool, target, miss_check: m.check_id, pass_check: pass.check_id, audit_id: audit, seconds, backfilled: !open } as Record<string, unknown>;
      if (opts.dry_run) { (open ? out.closed : out.backfilled).push(m.incident_id); continue; }

      if (!open) {
        detail.note = 'Closed earlier by a person; the same ask had already passed and landed, so the engine fixed it. The ledger is left as it is.';
        await engineEvents.record({ event_type: 'intent_check_self_healed', subject_id: m.incident_id, at: pass.at, lane: 'BAYS', actor: 'intent-heal', detail, dedupe_key: `intent_check_self_healed:${m.incident_id}` });
        out.backfilled.push(m.incident_id);
        continue;
      }
      const by = `intent-check (the same ask passed on ${pass.check_id} and landed, audit ${audit})`;
      const closed = await closeLedger(m, by);
      if (!closed.ok) { out.failed.push({ incident_id: m.incident_id, why: closed.why ?? 'unknown' }); continue; }
      const text = line(m.incident_id, m.tool, target!, pass.check_id, audit, seconds);
      const posted = await slack.botCall('chat.postMessage', { channel: RULE.channel, text, unfurl_links: false }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Record<string, unknown>);
      detail.slack = posted.ok ? { ok: true, ts: posted.ts } : { ok: false, error: posted.error ?? 'no reason' };
      if (!posted.ok) console.error(`[intent-heal] ${m.incident_id} closed but the #bha-self-healing line was refused: ${String(posted.error)}`);
      await engineEvents.record({ event_type: 'intent_check_self_healed', subject_id: m.incident_id, at: pass.at, lane: 'BAYS', actor: 'intent-heal', detail, dedupe_key: `intent_check_self_healed:${m.incident_id}` });
      out.closed.push(m.incident_id);
    }
    return out;
  } finally {
    if (!opts.dry_run) busy = false;
  }
}

/** A pass that may have fixed an open incident: look again once its write has had time to land. */
export function soon(): void {
  setTimeout(() => { void sweep().catch((e) => console.error(`[intent-heal] sweep failed: ${e instanceof Error ? e.message : String(e)}`)); }, 90_000).unref();
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('intent heal');
    sweep()
      .then((r) => { if (r.closed.length || r.backfilled.length || r.failed.length) console.log(`[intent-heal] closed ${r.closed.join(', ') || 'none'}; backfilled ${r.backfilled.join(', ') || 'none'}${r.failed.length ? `; ledger refused ${r.failed.map((f) => f.incident_id).join(', ')}` : ''}`); })
      .catch((e) => console.error(`[intent-heal] sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(tick, 45_000).unref();
  timer = setInterval(tick, RULE.every_minutes * 60_000);
  timer.unref();
}
