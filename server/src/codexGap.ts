/**
 * The missing Codex log check (2026-10-22, Destiny — DW-1792516757092-9EP8; Jason, 20 Oct:
 * "a standing, durable mechanism so builders don't miss logging Codex entries", after Kavin's
 * log for 20 Oct never arrived because the submission broke and nothing said so).
 *
 * Every hour: a builder who logs regularly (a submission on RULE.regular_days or more of the last
 * RULE.lookback_days days) and whose newest submission is older than RULE.gap_hours gets one DM
 * as Bays. A submission is anything that reached the engine: a row in a builder table or a
 * Layer 0 hold (a parked log is a log that was sent). The gap is measured in hours, not by
 * calendar day, because the builders are in four time zones and a "today" in Lagos is not theirs.
 *
 * One DM per gap: the claim is an engine event whose dedupe key is the builder and the time of
 * their newest log, written before the DM is sent. A second instance, or the next hour, finds the
 * key held and sends nothing. A DM Slack refuses gives the claim back (the event is deleted) and
 * is tried again on the next pass, and says so in the log. When the builder logs again, the key
 * changes and the next gap can be flagged.
 *
 * Destiny gets one line per flag, so a person sees it and nobody has to notice an absence.
 * It sends DMs and writes events; it changes no log, loop or pay row.
 */
import { query } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import * as timers from './timers';

export const RULE = {
  gap_hours: 18,
  lookback_days: 14,
  regular_days: 5,
  every_minutes: 60,
  never_flag: ['U0A9V97949F'], // Jason reviews logs; he does not submit them.
} as const;

export const DESTINY = 'U0AEW3TBYH1';

export interface Builder {
  user_id: string;
  name: string | null;
  days_logged: number;
  last_log_at: string;
}

export interface Gap extends Builder {
  hours_since: number;
  dedupe_key: string;
}

/** The pure rule: who is a regular logger with a gap now. */
export function findGaps(builders: Builder[], now: Date): Gap[] {
  return builders
    .filter((b) => !RULE.never_flag.includes(b.user_id as (typeof RULE.never_flag)[number]))
    .filter((b) => b.days_logged >= RULE.regular_days)
    .map((b) => ({ ...b, hours_since: (now.getTime() - new Date(b.last_log_at).getTime()) / 3_600_000, dedupe_key: `codex_gap:${b.user_id}:${new Date(b.last_log_at).toISOString()}` }))
    .filter((g) => g.hours_since >= RULE.gap_hours)
    .sort((a, b) => b.hours_since - a.hours_since);
}

const lagos = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function builderText(g: Gap): string {
  return [
    `Hi <@${g.user_id}>, no Codex log from you has reached the engine since ${lagos(g.last_log_at)} Lagos time (${Math.floor(g.hours_since)} hours ago).`,
    `If you worked since then, please submit it now. If you did submit one and no Bays card came back in your log channel, it did not land: reply here or tell <@${DESTINY}> so we can find it.`,
    `If you were off, ignore this. You will get one note per gap, not more.`,
  ].join('\n');
}

export function destinyText(g: Gap): string {
  return `Missing Codex log: <@${g.user_id}> has no log in the engine since ${lagos(g.last_log_at)} Lagos (${Math.floor(g.hours_since)} hours). Logs on ${g.days_logged} of the last ${RULE.lookback_days} days. Bays DM'd them.`;
}

/** Every builder who submitted in the lookback, with the days they logged and their newest submission. */
export async function builders(now = new Date()): Promise<Builder[]> {
  const r = await query<{ user_id: string; name: string | null; days_logged: string; last_log_at: string }>(
    `WITH subs AS (
       SELECT fields->>'Builder User ID' AS uid, NULLIF(fields->>'Builder Name', '') AS name, created_time::timestamptz AS at FROM engine_codex_submissions
       UNION ALL
       SELECT fields->>'Builder User ID', NULLIF(fields->>'Builder Username', ''), created_time::timestamptz FROM engine_layer0_holds
     )
     SELECT uid AS user_id, max(name) AS name,
            count(DISTINCT (at AT TIME ZONE 'UTC')::date) FILTER (WHERE at > $1::timestamptz - make_interval(days => $2)) AS days_logged,
            max(at) AS last_log_at
       FROM subs
      WHERE uid ~ '^U[A-Z0-9]+$'
      GROUP BY uid
     HAVING max(at) > $1::timestamptz - make_interval(days => $2)`,
    [now.toISOString(), RULE.lookback_days],
  );
  return r.rows.map((x) => ({ user_id: x.user_id, name: x.name, days_logged: Number(x.days_logged), last_log_at: new Date(x.last_log_at).toISOString() }));
}

export interface CheckResult {
  checked: number;
  gaps: Array<Gap & { outcome: 'flagged' | 'already_flagged' | 'would_flag' | 'dm_failed'; detail?: string }>;
}

export async function check(opts: { now?: Date; dry_run?: boolean; send?: typeof slack.dm } = {}): Promise<CheckResult> {
  const now = opts.now ?? new Date();
  const send = opts.send ?? slack.dm;
  const all = await builders(now);
  const out: CheckResult = { checked: all.length, gaps: [] };
  for (const g of findGaps(all, now)) {
    if (opts.dry_run) {
      const held = await query(`SELECT 1 FROM engine_events WHERE dedupe_key = $1`, [g.dedupe_key]);
      out.gaps.push({ ...g, outcome: held.rows.length ? 'already_flagged' : 'would_flag' });
      continue;
    }
    const claim = await record({
      event_type: 'codex_log_gap_flagged',
      subject_id: g.user_id,
      lane: 'BAYS',
      actor: 'codex-gap-check',
      detail: { last_log_at: g.last_log_at, hours_since: Math.floor(g.hours_since), days_logged: g.days_logged, rule: RULE },
      dedupe_key: g.dedupe_key,
    });
    if (!claim.recorded) {
      out.gaps.push({ ...g, outcome: 'already_flagged' });
      continue;
    }
    const sent = await send(g.user_id, builderText(g));
    if (!sent.ok) {
      // Give the claim back so the next pass tries again; never leave a flag that nobody received.
      await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
      console.error(`[codex-gap] DM to ${g.user_id} not sent, will retry: ${sent.detail}`);
      out.gaps.push({ ...g, outcome: 'dm_failed', detail: sent.detail });
      continue;
    }
    const told = await send(DESTINY, destinyText(g));
    if (!told.ok) console.error(`[codex-gap] the copy to Destiny about ${g.user_id} was not sent: ${told.detail}`);
    out.gaps.push({ ...g, outcome: 'flagged', detail: told.ok ? 'builder and Destiny told' : `builder told; Destiny copy failed: ${told.detail}` });
  }
  return out;
}

/* ----------------------------------------------------------------- timer */

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('codex log gap');
    if (busy) return;
    busy = true;
    check()
      .then((r) => {
        const flagged = r.gaps.filter((g) => g.outcome === 'flagged' || g.outcome === 'dm_failed');
        if (flagged.length) console.log(`[codex-gap] ${r.checked} builders looked at: ${flagged.map((g) => `${g.user_id} ${g.outcome}`).join(', ')}`);
      })
      .catch((e) => console.error(`[codex-gap] check failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.every_minutes * 60 * 1000);
  timer.unref();
}
