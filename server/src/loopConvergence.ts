/**
 * Loops and watches that keep changing without closing (19 Nov 2026, Destiny — Genie rebuild 10.12; design note
 * "Architecture over labor"). Every loop or Decision Watch change already posts in #bha-loop-updates
 * (changeAnnounce.ts) and leaves one `change_announced` event per record. Here those events are read the way
 * Logstream reads a repeating fault: a record with at least 3 progress posts in 7 days and no completion since
 * is not converging, and gets one `loop_not_converging` event per record per 7 days (the dedupe key holds it).
 * Logstream shows them (`not_converging` on its read and on read_logstream), so people audit the loop rather
 * than the engine guessing why. It posts nothing and changes no loop. The numbers live in RULE and nowhere else.
 */
import { query } from './pg';
import * as engineEvents from './engineEvents';
import * as timers from './timers';

type Row = Record<string, unknown>;
export const RULE = { window_days: 7, min_changes: 3, every_minutes: 30 } as const;

/** Pure: is this record's run of changes a flag? */
export function judge(r: { progress: number; closed_since: boolean }): boolean {
  return r.progress >= RULE.min_changes && !r.closed_since;
}

export async function candidates(): Promise<Row[]> {
  const r = await query<Row>(
    `WITH ev AS (
       SELECT subject_id, detail->>'kind' kind, detail->>'record' record, detail->>'ts' ts, at
         FROM engine_events
        WHERE event_type = 'change_announced' AND at > now() - ($1 || ' days')::interval AND subject_id IS NOT NULL
     )
     SELECT subject_id, max(record) record,
            count(DISTINCT COALESCE(ts, at::text)) FILTER (WHERE kind = 'progress')::int progress,
            max(at) FILTER (WHERE kind = 'progress') last_progress,
            max(at) FILTER (WHERE kind = 'completion') last_completion
       FROM ev GROUP BY subject_id`,
    [String(RULE.window_days)],
  );
  return r.rows
    .map((x): Row => ({ ...x, closed_since: !!x.last_completion && (!x.last_progress || String(x.last_completion) >= String(x.last_progress)) }))
    .filter((x) => judge({ progress: Number(x.progress), closed_since: x.closed_since === true }));
}

export async function sweep(): Promise<Row> {
  const found = await candidates();
  let flagged = 0;
  const windowKey = Math.floor(Date.now() / (RULE.window_days * 86_400_000));
  for (const x of found) {
    const r = await engineEvents.record({
      event_type: 'loop_not_converging',
      subject_id: String(x.subject_id),
      lane: null,
      actor: 'loop-convergence',
      source_ref: 'loopConvergence',
      dedupe_key: `not_converging:${String(x.subject_id)}:${windowKey}`,
      detail: { record: x.record, progress_posts: Number(x.progress), window_days: RULE.window_days, last_progress: x.last_progress },
    });
    if (r.recorded) flagged++;
  }
  return { ok: true, checked: found.length, flagged };
}

/** For Logstream's read: what is not converging now, with the record's title. */
export async function read(): Promise<Row> {
  const now = await candidates();
  const ids = now.map((x) => String(x.subject_id));
  const t = ids.length
    ? await query<Row>(`SELECT DISTINCT ON (natural_id) natural_id, fields->>'What' title, fields->>'Status' status FROM engine_loops WHERE natural_id = ANY($1) ORDER BY natural_id, updated_at DESC`, [ids])
    : { rows: [] as Row[] };
  const w = ids.length ? await query<Row>(`SELECT watch_id natural_id, decision title, status FROM engine_decision_watches WHERE watch_id = ANY($1)`, [ids]) : { rows: [] as Row[] };
  const meta = new Map([...t.rows, ...w.rows].map((r) => [String(r.natural_id), r]));
  return {
    rule: `${RULE.min_changes} or more progress posts in ${RULE.window_days} days with no completion since`,
    now: now.map((x) => ({ id: x.subject_id, record: x.record, progress_posts: Number(x.progress), last_progress: x.last_progress, title: meta.get(String(x.subject_id))?.title ?? null, status: meta.get(String(x.subject_id))?.status ?? null })),
  };
}

let timer: NodeJS.Timeout | null = null;
export function startSweeping(): void {
  if (timer) return;
  const tick = () => {
    timers.beat('loop convergence');
    sweep()
      .then((r) => { if (Number(r.flagged)) console.log(`[loop-convergence] ${String(r.flagged)} record(s) flagged as not converging`); })
      .catch((e) => console.error(`[loop-convergence] sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  setTimeout(tick, 120_000).unref();
  timer = setInterval(tick, RULE.every_minutes * 60_000);
  timer.unref();
}
