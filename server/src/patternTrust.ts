/**
 * Genie learns which patterns to trust first (19 Nov 2026, Destiny — Genie rebuild 10.11; design note
 * "Architecture over labor", with the improvements Genie proposed on its own deep think, request 472eca7d).
 *
 * One append-only table, engine_pattern_trust: every time a build pattern is shown by the reuse check, voted up
 * or voted down, with who, where and why. No model is in the loop and nothing is retired by itself.
 *  - up:   the pattern was reused or extended (10.10), or a build that used it was rated useful (10.9);
 *  - down: overridden ("go ahead" while it matched), rated not useful, or the workflow a build that used it
 *          changed had an incident within 14 days. Every down carries a reason: wrong, outdated, misrouted
 *          (shown for the wrong ask), overridden or incident. A misrouted down is a routing fault, never a
 *          strike against the pattern: it is counted apart and never moves it toward retirement.
 * Trust score: ups minus pattern downs over the last 90 days. The reuse check orders matches by it.
 * Demotion (RULE, the numbers live here and nowhere else): in 30 days, at least 5 pattern downs from at least
 * 3 different voters or threads, shown at least 10 times with downs at least 20% of showings, and no up more
 * recent than the latest down. A demoted pattern comes off the trusted-first list and is put to Destiny or
 * Jason, who retire it (fields `Retired At`, `Retired By`, `Retired Reason`, new names) or keep it. A pattern
 * with no use stays unscored, never at nought.
 */
import { query } from './pg';
import * as mirror from './mirror';
import * as engineEvents from './engineEvents';
import * as timers from './timers';

type Row = Record<string, unknown>;
export const RULE = { window_days: 30, score_days: 90, min_downs: 5, min_voters: 3, min_shown: 10, min_down_share: 0.2, incident_days: 14 } as const;
export const DOWN_REASONS = ['wrong', 'outdated', 'misrouted', 'overridden', 'not_useful', 'incident'] as const;
const DECIDERS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const str = (v: unknown, n = 400) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export interface Score { pattern_id: string; shown: number; ups: number; downs: number; misrouted: number; score: number | null; last_up: string | null; last_down: string | null }

export async function recordShown(ids: string[], sourceRef: string, thread: string | null): Promise<void> {
  for (const id of [...new Set(ids)]) {
    await query(`INSERT INTO engine_pattern_trust (pattern_id, kind, source_ref, thread) VALUES ($1, 'shown', $2, $3)`, [id, sourceRef, thread]);
  }
}

/** One vote. `voter` is a Slack id (or 'engine' for an incident link); a vote twice for the same source is one vote. */
export async function vote(b: { pattern_id: string; kind: 'up' | 'down'; reason?: string; voter: string; thread?: string | null; source_ref: string }): Promise<boolean> {
  const reason = b.kind === 'down' ? (DOWN_REASONS as readonly string[]).includes(String(b.reason)) ? String(b.reason) : 'not_useful' : str(b.reason, 40) || null;
  const r = await query(
    `INSERT INTO engine_pattern_trust (pattern_id, kind, reason, voter, thread, source_ref) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (pattern_id, kind, source_ref, voter) WHERE kind <> 'shown' DO NOTHING`,
    [b.pattern_id, b.kind, reason, b.voter, b.thread ?? null, b.source_ref],
  );
  if (!r.rowCount) return false;
  await engineEvents.record({ event_type: `pattern_trust_${b.kind}`, subject_id: b.pattern_id, lane: 'GENIE', actor: b.voter, source_ref: b.source_ref, detail: { reason, thread: b.thread ?? null } });
  return true;
}

export async function scores(ids?: string[]): Promise<Map<string, Score>> {
  const r = await query<Row>(
    `SELECT pattern_id,
            count(*) FILTER (WHERE kind = 'shown')::int shown,
            count(*) FILTER (WHERE kind = 'up')::int ups,
            count(*) FILTER (WHERE kind = 'down' AND reason <> 'misrouted')::int downs,
            count(*) FILTER (WHERE kind = 'down' AND reason = 'misrouted')::int misrouted,
            max(at) FILTER (WHERE kind = 'up') last_up,
            max(at) FILTER (WHERE kind = 'down' AND reason <> 'misrouted') last_down
       FROM engine_pattern_trust
      WHERE at > now() - ($1 || ' days')::interval ${ids ? 'AND pattern_id = ANY($2)' : ''}
      GROUP BY pattern_id`,
    ids ? [String(RULE.score_days), ids] : [String(RULE.score_days)],
  );
  const m = new Map<string, Score>();
  for (const x of r.rows) {
    const ups = Number(x.ups), downs = Number(x.downs);
    m.set(String(x.pattern_id), {
      pattern_id: String(x.pattern_id), shown: Number(x.shown), ups, downs, misrouted: Number(x.misrouted),
      score: ups + downs ? ups - downs : null, last_up: x.last_up ? String(x.last_up) : null, last_down: x.last_down ? String(x.last_down) : null,
    });
  }
  return m;
}

/** Pure: does a pattern's last 30 days meet the demotion rule? */
export function demotes(w: { shown: number; downs: number; voters: number; last_up: string | null; last_down: string | null }): { demote: boolean; why: string } {
  if (w.downs < RULE.min_downs) return { demote: false, why: `${w.downs} of ${RULE.min_downs} downs` };
  if (w.voters < RULE.min_voters) return { demote: false, why: `downs from ${w.voters} of ${RULE.min_voters} voters or threads` };
  if (w.shown < RULE.min_shown) return { demote: false, why: `shown ${w.shown} of ${RULE.min_shown} times` };
  if (w.downs / w.shown < RULE.min_down_share) return { demote: false, why: `downs are ${Math.round((100 * w.downs) / w.shown)}% of showings, under ${RULE.min_down_share * 100}%` };
  if (w.last_up && w.last_down && w.last_up > w.last_down) return { demote: false, why: 'an up is more recent than the latest down' };
  return { demote: true, why: `${w.downs} downs from ${w.voters} voters or threads in ${RULE.window_days} days, ${Math.round((100 * w.downs) / w.shown)}% of ${w.shown} showings, no up since` };
}

export async function demoted(): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT t.pattern_id,
            count(*) FILTER (WHERE kind = 'shown')::int shown,
            count(*) FILTER (WHERE kind = 'down' AND reason <> 'misrouted')::int downs,
            count(DISTINCT COALESCE(thread, voter)) FILTER (WHERE kind = 'down' AND reason <> 'misrouted')::int voters,
            max(at) FILTER (WHERE kind = 'up')::text last_up,
            max(at) FILTER (WHERE kind = 'down' AND reason <> 'misrouted')::text last_down
       FROM engine_pattern_trust t
      WHERE at > now() - ($1 || ' days')::interval
      GROUP BY t.pattern_id`,
    [String(RULE.window_days)],
  );
  const out: Row[] = [];
  for (const x of r.rows) {
    const d = demotes({ shown: Number(x.shown), downs: Number(x.downs), voters: Number(x.voters), last_up: (x.last_up as string) || null, last_down: (x.last_down as string) || null });
    if (d.demote) out.push({ pattern_id: x.pattern_id, why: d.why });
  }
  return out;
}

/** The record for the Build patterns page and Genie: the trusted-first list, the demoted ones, every move. */
export async function read(): Promise<Row> {
  const s = await scores();
  const names = await query<Row>(`SELECT natural_id, fields->>'pattern_name' n, fields->>'Retired At' ra FROM engine_build_patterns`);
  const nameOf = new Map(names.rows.map((r) => [String(r.natural_id), { name: String(r.n || ''), retired: !!r.ra }]));
  const dem = await demoted();
  const demotedIds = new Set(dem.map((d) => String(d.pattern_id)));
  const list = [...s.values()]
    .filter((x) => !nameOf.get(x.pattern_id)?.retired)
    .map((x) => ({ ...x, name: nameOf.get(x.pattern_id)?.name ?? '', demoted: demotedIds.has(x.pattern_id) }))
    .sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9) || b.shown - a.shown);
  const moves = await query<Row>(`SELECT pattern_id, kind, reason, voter, thread, source_ref, at FROM engine_pattern_trust WHERE kind <> 'shown' ORDER BY at DESC LIMIT 100`);
  return { ok: true, rule: RULE, trusted_first: list.filter((x) => !x.demoted && (x.score ?? 0) > 0), all: list, demoted: dem.map((d) => ({ ...d, name: nameOf.get(String(d.pattern_id))?.name ?? '' })), moves: moves.rows, unscored_patterns: names.rows.length - s.size };
}

/** A person retires a demoted pattern, or keeps it (which records an up from them). Never automatic. */
export async function decide(b: Row): Promise<Row> {
  const id = str(b.pattern_id, 120);
  const who = str(b.decider, 40);
  const choice = str(b.choice, 10);
  if (!DECIDERS.has(who)) return { ok: false, reason: 'not_permitted', message: 'Only Destiny or Jason retire or keep a pattern.' };
  if (choice !== 'retire' && choice !== 'keep') return { ok: false, reason: 'bad_choice', message: 'choice is retire or keep.' };
  const reason = str(b.reason, 1000);
  if (choice === 'retire' && reason.length < 3) return { ok: false, reason: 'reason_required', message: 'Say why it is retired.' };
  let rowId: number;
  try { rowId = await mirror.resolveNatural('patterns', id); } catch { return { ok: false, reason: 'not_found', message: `No pattern ${id}.` }; }
  if (choice === 'retire') {
    await mirror.patchFields('patterns', String(rowId), { 'Retired At': new Date().toISOString(), 'Retired By': who, 'Retired Reason': reason }, 'ui');
  } else {
    await vote({ pattern_id: id, kind: 'up', reason: 'kept', voter: who, source_ref: `keep:${Date.now()}` });
  }
  await engineEvents.record({ event_type: `pattern_${choice === 'retire' ? 'retired' : 'kept'}`, subject_id: id, lane: 'GENIE', actor: who, source_ref: 'pattern-trust', detail: { reason } });
  return { ok: true, pattern_id: id, choice };
}

/**
 * The incident link: a finished Genie build on n8n names the workflow it changed (by id, matched to its name through
 * engine_execution_runs, because an incident names its workflow); an incident on that workflow
 * within 14 days is one `incident` down for each pattern the build's plan reused or extended. Run by a sweep.
 */
export async function incidentSweep(): Promise<Row> {
  const r = await query<Row>(
    `SELECT a.id, a.args->>'workflowId' wf, a.plan, a.finished_at, i.natural_id inc
       FROM engine_genie_approvals a
       JOIN LATERAL (SELECT workflow_name FROM engine_execution_runs WHERE workflow_id = a.args->>'workflowId' AND workflow_name IS NOT NULL ORDER BY started_at DESC LIMIT 1) w ON true
       JOIN engine_incidents i ON i.fields->'payload'->>'workflow_or_scenario' = w.workflow_name
      WHERE a.status = 'done' AND a.server = 'n8n' AND a.args->>'workflowId' IS NOT NULL
        AND (i.fields->>'occurred_at')::timestamptz > a.finished_at
        AND (i.fields->>'occurred_at')::timestamptz < a.finished_at + ($1 || ' days')::interval`,
    [String(RULE.incident_days)],
  );
  let votes = 0;
  for (const x of r.rows) {
    const used = ((x.plan as Row | null)?.patterns_used as string[] | undefined) || [];
    for (const p of used) if (await vote({ pattern_id: p, kind: 'down', reason: 'incident', voter: 'engine', thread: String(x.id), source_ref: `incident:${String(x.inc)}` })) votes++;
  }
  return { ok: true, checked: r.rows.length, votes };
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('pattern trust incident sweep');
    incidentSweep()
      .then((r) => { if (Number(r.votes)) console.log(`[pattern-trust] ${String(r.votes)} incident down(s) recorded`); })
      .catch((e) => console.error(`[pattern-trust] incident sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(tick, 150_000).unref();
  timer = setInterval(tick, 60 * 60_000);
  timer.unref();
}
