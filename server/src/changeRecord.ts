/**
 * The change record (25 Nov 2026, Destiny — PT9J / LOOP-1791317275796-MPMD Part A; Jason, 3 Nov:
 * from_state, to_state, run_id, incident_id, lane_id, handler_id, plus approver_id and approved_at).
 *
 * One read of every state change the engine holds, in one shape, so "what changed since last week,
 * who did it and who signed it off" is one call. It writes nothing and holds no table of its own:
 * each row is read from the record that already keeps it.
 *
 *   status changes  `events`, the status ledger: from and to, and from 25 Nov who made it, which
 *                   run, through which door and what carried it out (migration 158).
 *   incidents       `engine_incidents`: opened (from the ledger's own date) and closed (resolved_at,
 *                   resolved_by), with the n8n execution as the run.
 *   approval cards  `engine_approvals`: a person's decision on an agent's action.
 *
 * The approver is only ever a named person who decided: Jason's or Destiny's pay decision on a
 * Codex log, or the person who answered an approval card. A machine is never an approver, and a
 * change whose approver is the person who made it reads "self", not approved. Everything else is
 * "not approved", said in words. Who made a change before 25 Nov was not recorded and reads null.
 */
import { query } from './pg';

export type Approval = 'approved' | 'not_approved' | 'self';

export interface ChangeRow {
  change_id: string;
  at: string;
  kind: string;
  record_id: string | null;
  from_state: string | null;
  to_state: string | null;
  run_id: string | null;
  incident_id: string | null;
  lane_id: string | null;
  handler_id: string | null;
  actor: string | null;
  via: string | null;
  approver_id: string | null;
  approved_at: string | null;
  approval: Approval;
}

/** Each status-ledger kind, the table its `record_id` (`row-<id>`) points into, and its lane. */
export const EVENT_KINDS: Record<string, { table: string; lane: string }> = {
  loops: { table: 'engine_loops', lane: `t.fields->>'lane_tag'` },
  codex: { table: 'engine_codex_submissions', lane: `NULLIF(t.fields->>'Lanes Touched', '')` },
  patterns: { table: 'engine_build_patterns', lane: `NULLIF(t.fields->>'bha_system', '')` },
  commercial: { table: 'engine_commercial_cards', lane: 't.lane_id' },
  ns: { table: 'engine_ns_asks', lane: 't.lane_id' },
  rt: { table: 'engine_rt_asks', lane: 't.lane_id' },
  rt_jobs: { table: 'engine_rt_jobs', lane: 't.lane_id' },
  client_questions: { table: 'engine_client_questions', lane: 't.lane_id' },
};

/** Who decided this change, by the rule above. Pure, so the rule is tested without a database. */
export function approvalOf(approver: string | null, actor: string | null): Approval {
  if (!approver) return 'not_approved';
  const a = (actor ?? '').toLowerCase();
  if (a && (a === approver.toLowerCase() || a.endsWith(`:${approver.toLowerCase()}`))) return 'self';
  return 'approved';
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/**
 * When an incident opened: the earlier of the ledger's own date and when this database first saw it,
 * because BHARAG moves occurred_at to each status change (Logstream's INCIDENT_AT, the same rule).
 */
const INCIDENT_OPENED = `LEAST(CASE WHEN i.fields->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (i.fields->>'occurred_at')::timestamptz END,
             CASE WHEN i.first_seen_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN i.first_seen_at::timestamptz END)`;

/** The union, as SQL. Every part yields the same columns; `ts` is a timestamptz for filtering. */
export function unionSql(): string {
  const events = Object.entries(EVENT_KINDS)
    .map(
      ([kind, k]) => `
    SELECT 'ev-' || e.seq AS change_id, e.at::timestamptz AS ts, e.kind, t.natural_id AS record_id, e.from_status AS from_state, e.to_status AS to_state,
           e.run_id, NULL::text AS incident_id, ${k.lane} AS lane_id, coalesce(e.handler_id, e.via) AS handler_id, e.actor, e.change_via AS via,
           coalesce(${kind === 'codex' ? 'pn.decided_by, ' : ''}ap.decided_by) AS approver_id,
           coalesce(${kind === 'codex' ? 'pn.decided_at::timestamptz, ' : ''}ap.decided_at) AS approved_ts
      FROM events e
      LEFT JOIN ${k.table} t ON 'row-' || t.id = e.record_id
      ${kind === 'codex' ? `LEFT JOIN engine_pay_notes pn ON pn.submission_id = t.natural_id AND e.to_status IN ('approved', 'input added')` : ''}
      LEFT JOIN engine_approvals ap ON e.run_id = 'approval:' || ap.approval_id AND ap.status = 'approved'
     WHERE e.kind = '${kind}'`,
    )
    .join('\n    UNION ALL');
  return `
    ${events}
    UNION ALL
    SELECT 'inc-open-' || i.id, ${INCIDENT_OPENED}, 'incidents', i.natural_id, NULL, 'open',
           NULLIF(i.fields->'payload'->>'execution_id', ''), i.natural_id, i.lane_id, coalesce(NULLIF(i.fields->>'source', ''), i.lane_id), NULL, 'incident ledger',
           NULL, NULL
      FROM engine_incidents i
    UNION ALL
    SELECT 'inc-close-' || i.id, CASE WHEN i.resolved_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN i.resolved_at::timestamptz END, 'incidents', i.natural_id, 'open', coalesce(NULLIF(i.fields->>'resolution_status', ''), 'closed'),
           NULLIF(i.fields->'payload'->>'execution_id', ''), i.natural_id, i.lane_id, i.resolved_by, i.resolved_by, 'incident ledger',
           NULL, NULL
      FROM engine_incidents i WHERE i.resolved_at IS NOT NULL
    UNION ALL
    SELECT 'apr-' || a.id, a.decided_at, 'approvals', a.approval_id, 'pending', a.status,
           'approval:' || a.approval_id, NULL, NULL, a.agent, coalesce(a.requester_user_id, a.agent), 'approval:' || a.tool,
           CASE WHEN a.status = 'approved' THEN a.decided_by END, CASE WHEN a.status = 'approved' THEN a.decided_at END
      FROM engine_approvals a WHERE a.decided_at IS NOT NULL`;
}

export interface ReadInput {
  since?: string | null;
  until?: string | null;
  lane?: string | null;
  kind?: string | null;
  record_id?: string | null;
  limit?: number;
  offset?: number;
}

export const DEFAULT_DAYS = 7;
export const MAX_LIMIT = 500;
/** The day who made a change began to be recorded (migration 158). */
export const WHO_SINCE = '2026-11-25';

export async function read(input: ReadInput = {}) {
  const until = input.until ? new Date(input.until) : new Date();
  const since = input.since ? new Date(input.since) : new Date(until.getTime() - DEFAULT_DAYS * 86_400_000);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error('since and until must be dates, e.g. 2026-11-18 or 2026-11-18T00:00:00Z.');
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(input.limit) || 100)));
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const lane = input.lane?.trim() || null;
  const kind = input.kind?.trim() || null;
  const record = input.record_id?.trim() || null;
  const where = `ts >= $1 AND ts < $2 AND ($3::text IS NULL OR lane_id ILIKE '%' || $3 || '%') AND ($4::text IS NULL OR kind = $4) AND ($5::text IS NULL OR record_id = $5)`;
  const params = [since.toISOString(), until.toISOString(), lane, kind, record];
  const [rows, counts] = await Promise.all([
    query<Record<string, unknown>>(
      `WITH c AS (${unionSql()})
       SELECT change_id, to_char(ts AT TIME ZONE 'UTC', ${ISO}) AS at, kind, record_id, from_state, to_state, run_id, incident_id, lane_id,
              handler_id, actor, via, approver_id, to_char(approved_ts AT TIME ZONE 'UTC', ${ISO}) AS approved_at
         FROM c WHERE ${where} ORDER BY ts DESC, change_id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query<{ kind: string; n: string; with_actor: string; with_approver: string }>(
      `WITH c AS (${unionSql()})
       SELECT kind, count(*) AS n, count(actor) AS with_actor, count(approver_id) AS with_approver FROM c WHERE ${where} GROUP BY kind ORDER BY 2 DESC`,
      params,
    ),
  ]);
  const changes: ChangeRow[] = rows.rows.map((r) => {
    const approver = (r.approver_id as string | null) ?? null;
    const actor = (r.actor as string | null) ?? null;
    const approval = approvalOf(approver, actor);
    return {
      change_id: String(r.change_id),
      at: String(r.at),
      kind: String(r.kind),
      record_id: (r.record_id as string | null) ?? null,
      from_state: (r.from_state as string | null) ?? null,
      to_state: (r.to_state as string | null) ?? null,
      run_id: (r.run_id as string | null) ?? null,
      incident_id: (r.incident_id as string | null) ?? null,
      lane_id: (r.lane_id as string | null) ?? null,
      handler_id: (r.handler_id as string | null) ?? null,
      actor,
      via: (r.via as string | null) ?? null,
      approver_id: approval === 'approved' ? approver : null,
      approved_at: approval === 'approved' ? ((r.approved_at as string | null) ?? null) : null,
      approval,
    };
  });
  const total = counts.rows.reduce((a, c) => a + Number(c.n), 0);
  return {
    ok: true,
    window: { since: since.toISOString(), until: until.toISOString(), lane, kind, record_id: record },
    total,
    by_kind: counts.rows.map((c) => ({ kind: c.kind, changes: Number(c.n), who_recorded: Number(c.with_actor), approver_named: Number(c.with_approver) })),
    changes,
    page: { limit, offset, returned: changes.length, more: offset + changes.length < total },
    rule: [
      'One row per state change: status changes on loops, Codex logs, patterns, commercial cards, North Star and Research Twin asks, research jobs and client questions; incidents opened and closed; approval cards decided.',
      'from_state, to_state, run_id, incident_id, lane_id and handler_id are read from the record that keeps each change. actor is who asked for it, via is the door it came through.',
      `Who made a change, which run and which door are recorded from ${WHO_SINCE}. Before that they are null: not recorded, not unknown to anybody, and never filled in by a guess.`,
      'approver_id is only a named person who decided: the pay decision on a Codex log or the person who answered an approval card. A machine is never an approver. A change approved by the person who made it reads self. Anything else reads not_approved.',
      'Loop closes by a lane owner have no approve step yet, so they read not_approved.',
    ],
  };
}
