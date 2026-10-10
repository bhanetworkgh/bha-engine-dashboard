/**
 * The always-on quality alert (2026-10-03, Destiny — Agent Upgrade Plan,
 * observability, from the 1 Oct re-score: "an always-on quality alert (thin
 * rate, eval pass rate, injection pass rate)").
 *
 * Every 15 minutes it reads what the scorecard already reads and posts to the
 * quota alert channel (#bha-engine-alerts, QUOTA_ALERT_CHANNEL) when:
 *   - the newest **finished** eval run has a failing case (pass^k, the
 *     scorecard's rule), injection cases named apart — once per run, and once
 *     more ("back to clean") when a later finished run passes every case;
 *   - an agent delivered under 90% of its asks in the last 24 hours (at least
 *     3 asks) — once per agent per UTC day;
 *   - North Star or Research Twin answered Thin or Failed on over 40% of
 *     their asks in the last 24 hours (at least 5 asks) — once per agent per
 *     UTC day. Bays does not grade its answers, so it has no thin figure.
 *
 * No silent failures: a post Slack refuses (`ok:false`) is not marked sent,
 * keeps its reason in meta `quality_alert.last_error`, and is tried on the
 * next check. Nothing here is a judgement the scorecard does not already make.
 */
import { query } from './pg';
import { getMeta, nowIso, setMeta } from './db';
import * as slack from './slack';
import * as quota from './quota';
import * as timers from './timers';

const CHECK_MS = 15 * 60_000;
const DELIVERY_FLOOR = 0.9;
const DELIVERY_MIN_ASKS = 3;
const THIN_CEILING = 0.4;
const THIN_MIN_ASKS = 5;
const INJECTION = (id: string) => id.startsWith('INJ-') || ['NS-03', 'RT-03', 'BAYS-03'].includes(id);
const PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}/agent-maturity`;

export interface Signal {
  key: string;
  kind: 'eval_failing' | 'eval_clean' | 'delivery' | 'thin';
  text: string;
}

async function latestFinishedRun(): Promise<{ run: string; cases: { id: string; ok: boolean }[]; at: string | null } | null> {
  const r = await query<{ run: string; complete: boolean }>(
    `WITH runs AS (
       SELECT fields->>'Run ID' AS run, count(*) AS n, max((fields->>'Run Size')::int) AS size, max(created_time) AS last, max(id) AS last_id
         FROM engine_eval_runs GROUP BY 1
     )
     SELECT run, (CASE WHEN size IS NOT NULL THEN n >= size ELSE last::timestamptz < now() - interval '30 minutes' END) AS complete
       FROM runs ORDER BY last_id DESC LIMIT 5`,
  );
  const run = r.rows.find((x) => x.complete)?.run;
  if (!run) return null;
  const c = await query<{ id: string; ok: boolean; at: string | null }>(
    `SELECT fields->>'Case ID' AS id, bool_and((fields->>'Passed') = 'true') AS ok, max(fields->>'Run At') AS at
       FROM engine_eval_runs WHERE fields->>'Run ID' = $1 GROUP BY 1 ORDER BY 1`,
    [run],
  );
  return { run, cases: c.rows.map((x) => ({ id: x.id, ok: x.ok })), at: c.rows.reduce<string | null>((m, x) => (x.at && (!m || x.at > m) ? x.at : m), null) };
}

async function last24h(table: string): Promise<{ asks: number; delivered: number; weak: number }> {
  const r = await query<{ asks: string; delivered: string; weak: string }>(
    `SELECT count(*)::text AS asks,
            count(*) FILTER (WHERE fields->>'Delivered' = 'Delivered')::text AS delivered,
            count(*) FILTER (WHERE fields->>'Outcome' IN ('Thin', 'Failed'))::text AS weak
       FROM ${table}
      WHERE created_time >= to_char((now() - interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
  );
  const x = r.rows[0];
  return { asks: Number(x?.asks ?? 0), delivered: Number(x?.delivered ?? 0), weak: Number(x?.weak ?? 0) };
}

/** Every signal true right now, each with the key that says whether it was already announced. */
export async function signals(): Promise<Signal[]> {
  const out: Signal[] = [];
  const day = nowIso().slice(0, 10);
  const run = await latestFinishedRun();
  if (run) {
    const failing = run.cases.filter((c) => !c.ok);
    if (failing.length) {
      const inj = failing.filter((c) => INJECTION(c.id)).map((c) => c.id);
      out.push({
        key: `eval:${run.run}`,
        kind: 'eval_failing',
        text: `:warning: *Eval run ${run.run} did not pass clean* — ${run.cases.length - failing.length} of ${run.cases.length} cases passed (a case passes only if every repeat passed). Failing: ${failing.map((c) => c.id).join(', ')}.${inj.length ? ` *Injection cases failing: ${inj.join(', ')}.*` : ' All injection cases passed.'} Fix on the draft before the next publish.`,
      });
    } else {
      out.push({ key: `eval_clean:${run.run}`, kind: 'eval_clean', text: `:white_check_mark: *Eval run ${run.run} passed clean* — ${run.cases.length} of ${run.cases.length} cases, injection included. The last failing run is cleared.` });
    }
  }
  const agents: [string, string, boolean][] = [
    ['North Star', 'engine_ns_asks', true],
    ['Research Twin', 'engine_rt_asks', true],
    ['Bays', 'engine_bays_asks', false],
  ];
  for (const [name, table, graded] of agents) {
    const m = await last24h(table);
    if (m.asks >= DELIVERY_MIN_ASKS && m.delivered / m.asks < DELIVERY_FLOOR) {
      out.push({ key: `delivery:${name}:${day}`, kind: 'delivery', text: `:warning: *${name} delivered ${m.delivered} of ${m.asks} answers in the last 24 hours* (under ${DELIVERY_FLOOR * 100}%). An answer that did not reach the person is the failure that looks like silence.` });
    }
    if (graded && m.asks >= THIN_MIN_ASKS && m.weak / m.asks > THIN_CEILING) {
      out.push({ key: `thin:${name}:${day}`, kind: 'thin', text: `:warning: *${name} answered Thin or Failed on ${m.weak} of ${m.asks} asks in the last 24 hours* (over ${THIN_CEILING * 100}%). Its tools or its evidence may be degraded.` });
    }
  }
  return out;
}

const sentKey = (k: string) => `quality_alert.sent.${k}`;
const LAST_ERROR = 'quality_alert.last_error';
const LAST_CHECK = 'quality_alert.last_check';

/**
 * One check. `dry_run` posts nothing and reports what would go out. An eval
 * "clean" post goes out only when the previous announced eval signal was a
 * failing one, so a run of clean runs posts nothing.
 */
export async function check(dryRun = false): Promise<{ at: string; would_post: Signal[]; posted: string[]; failed: { key: string; error: string }[]; already_sent: string[]; channel: string | null }> {
  const at = nowIso();
  const all = await signals();
  const lastEval = await getMeta('quality_alert.last_eval_kind');
  const due: Signal[] = [];
  const already: string[] = [];
  for (const s of all) {
    if (s.kind === 'eval_clean' && lastEval !== 'eval_failing') continue;
    if (await getMeta(sentKey(s.key))) already.push(s.key);
    else due.push(s);
  }
  const channel = quota.channelId();
  const posted: string[] = [];
  const failed: { key: string; error: string }[] = [];
  if (!dryRun) {
    for (const s of due) {
      if (!channel || !slack.slackConfigured()) {
        failed.push({ key: s.key, error: `${!channel ? quota.CHANNEL_VAR : slack.SLACK_TOKEN_VAR} is not set on this server` });
        continue;
      }
      const r = await slack.botCall('chat.postMessage', { channel, text: `${s.text} ${PAGE}`, unfurl_links: false, unfurl_media: false });
      if (!r.ok) {
        failed.push({ key: s.key, error: `Slack refused the alert: ${String(r.error ?? 'unknown error')}` });
        continue;
      }
      await setMeta(sentKey(s.key), at);
      if (s.kind === 'eval_failing' || s.kind === 'eval_clean') await setMeta('quality_alert.last_eval_kind', s.kind);
      posted.push(s.key);
    }
    await setMeta(LAST_ERROR, failed.length ? `${at} — ${failed.map((f) => `${f.key}: ${f.error}`).join('; ')}` : '');
    await setMeta(LAST_CHECK, at);
    if (failed.length) console.error(`[quality-alert] not posted: ${failed.map((f) => `${f.key} (${f.error})`).join(', ')}`);
  }
  return { at, would_post: due, posted, failed, already_sent: already, channel };
}

/** Every 15 minutes, first look two minutes after boot. */
export function startWatching(): void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    check()
      .catch((e) => console.error(`[quality-alert] check failed: ${(e as Error).message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 120_000).unref();
  setInterval(() => (timers.beat('quality alert'), tick()), CHECK_MS).unref();
}
