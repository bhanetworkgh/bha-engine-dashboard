/**
 * The publish check (2026-10-11, Destiny — agent maturity: "nothing forces an
 * eval before a publish", "a rollback that leaves a record").
 *
 * n8n has no agents API, so this server cannot see a publish or undo one. What
 * it can do starts where it first learns of a new version: when the agent
 * inventory is recorded and `active_version_id` has changed.
 *
 *   1. One row per version change in `engine_agent_versions`, and one
 *      `agent_version_changed` event. A version this agent has run before is a
 *      rollback and is recorded as one (`agent_rolled_back`).
 *   2. Three minutes after the last change (so three agents recorded together
 *      are one run) the eval runner is asked to run, through its webhook. At
 *      most four runs a day are asked for from here.
 *   3. The first finished eval run that started after the change is the
 *      verdict. A case that passed in the run before the change and fails in
 *      this one is a regression: one alert in the engine alerts channel names
 *      the cases and the version to publish again. Cases that already failed
 *      before are named and are not a regression.
 *   4. No eval run within 90 minutes is said too: "published without an eval".
 *
 * It reads, asks for a run and posts. It never publishes, never rolls back
 * and never edits an agent: the rollback is a person's, with the id in hand.
 */
import * as draftEval from './draftEval';
import * as engineEvents from './engineEvents';
import * as n8n from './n8n';
import { query } from './pg';
import * as quota from './quota';
import * as slack from './slack';
import * as timers from './timers';

export const RULE = { settle_seconds: 180, no_eval_minutes: 90, max_runs_per_day: 4, tick_seconds: 120 } as const;
const RUN_PATH = process.env.AGENT_EVALS_RUN_PATH?.trim() || '/webhook/agent-evals-run';

export function evalKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('north star')) return 'north_star';
  if (n.includes('research twin')) return 'research_twin';
  if (n.includes('bays')) return 'bays';
  return null;
}

/** Called by the inventory when a recorded agent's active version differs from the one held. Never throws. */
export async function onVersionChange(input: { agent_id: string; name: string; from: string | null; to: string | null; config_hash: string | null }): Promise<void> {
  try {
    if (!input.to || input.to === input.from) return;
    const seen = await query(`SELECT 1 FROM engine_agent_versions WHERE agent_id = $1 AND (version_id = $2 OR previous_version_id = $2) LIMIT 1`, [input.agent_id, input.to]);
    const rollback = seen.rows.length > 0;
    await query(`UPDATE engine_agent_versions SET eval_state = 'superseded', eval_detail = 'a newer version was recorded before a verdict' WHERE agent_id = $1 AND eval_state IN ('pending', 'requested')`, [input.agent_id]);
    const r = await query<{ id: string }>(
      `INSERT INTO engine_agent_versions (agent_id, name, version_id, previous_version_id, config_hash, is_rollback) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [input.agent_id, input.name, input.to, input.from, input.config_hash, rollback],
    );
    await engineEvents.record({
      event_type: rollback ? 'agent_rolled_back' : 'agent_version_changed',
      subject_id: input.agent_id,
      lane: 'ENGINE',
      actor: 'agent inventory',
      detail: { name: input.name, from: input.from, to: input.to, config_hash: input.config_hash, rollback },
      dedupe_key: `agent_version:${r.rows[0].id}`,
    });
    await draftCheck(r.rows[0].id, input);
  } catch (e) {
    console.error(`[publish-check] ${input.name}: the version change was not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 13 Oct 2026: was this version tested as a draft before it went live?
 * The draft eval (draftEval.ts) ties a run to the draft config it tested; a
 * version whose config matches a finished passing run is "tested before
 * publish". No such run, or a failing one, is said in the engine alerts
 * channel at once. The eval after the publish still runs either way.
 */
async function draftCheck(versionRowId: string, input: { agent_id: string; name: string; to: string | null; from: string | null; config_hash: string | null }): Promise<void> {
  const v = await draftEval.verdictFor(input.agent_id, input.config_hash);
  const to = (input.to ?? '').slice(0, 8);
  let state: string;
  let detail: string;
  let alert: string | null = null;
  if (v && v.state === 'passed') {
    state = 'passed_before_publish';
    detail = `${v.run_id}: ${v.detail ?? 'passed'}`;
  } else if (v) {
    state = 'failed_before_publish';
    detail = `${v.run_id}: ${v.detail ?? 'failed'}`;
    alert = `:rotating_light: *${input.name} was published on version \`${to}\` although its draft eval failed.* ${quota.mentions()}\n${detail}\n${input.from ? `To roll back, publish version \`${input.from}\` again.` : 'No earlier version is on record to roll back to.'} Nothing has been changed for you.`;
  } else {
    state = 'none';
    detail = input.config_hash ? `no finished draft eval matches config ${input.config_hash.slice(0, 12)}` : 'the inventory carried no config hash, so no draft eval can be matched';
    alert = `:warning: *${input.name} went live on version \`${to}\` without a draft eval behind it.* ${quota.mentions()}\nNo finished draft eval tested this exact config before the publish (run_draft_eval). The eval after the publish still runs.`;
  }
  let alertState: string | null = null;
  let alertDetail: string | null = null;
  if (alert) {
    const sent = await post(alert);
    alertState = sent.ok ? 'posted' : 'failed';
    alertDetail = sent.ok ? sent.ts : sent.error;
  }
  await query(`UPDATE engine_agent_versions SET draft_run_id = $2, draft_state = $3, draft_detail = $4, draft_alert_state = $5, draft_alert_detail = $6, draft_alert_text = $7 WHERE id = $1`, [versionRowId, v?.run_id ?? null, state, detail, alertState, alertDetail, alert]);
  await engineEvents
    .record({ event_type: `agent_publish_draft_${state}`, subject_id: input.agent_id, lane: 'ENGINE', actor: 'publish check', detail: { name: input.name, version: input.to, run: v?.run_id ?? null, detail }, dedupe_key: `agent_publish_draft:${versionRowId}` })
    .catch((e) => console.error(`[publish-check] draft event not recorded: ${e instanceof Error ? e.message : String(e)}`));
}

async function post(text: string): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const channel = quota.channelId();
  if (!channel) return { ok: false, error: `${quota.CHANNEL_VAR} is not set` };
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set` };
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  return r.ok && typeof r.ts === 'string' ? { ok: true, ts: r.ts } : { ok: false, error: String(r.error ?? 'unknown error') };
}

async function askForRun(reason: string): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return { ok: false, error: 'DASHBOARD_INBOUND_KEY is not set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${n8n.n8nHost()}${RUN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-key': key }, body: JSON.stringify({ reason }), signal: controller.signal });
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `n8n answered ${res.status} at ${RUN_PATH}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e.name === 'AbortError' ? `n8n did not answer ${RUN_PATH} within 20 seconds` : e.message) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

interface VRow {
  id: string; agent_id: string; name: string; version_id: string; previous_version_id: string | null; is_rollback: boolean;
  seen_at: string; eval_state: string; requested_at: string | null; alert_state: string | null;
}

/** Per agent, the failed case ids of one run. */
async function failedCases(runId: string, agent: string): Promise<{ cases: number; failed: string[] }> {
  const r = await query<{ case_id: string; ok: boolean }>(
    `SELECT fields->>'Case ID' AS case_id, bool_and((fields->>'Passed') = 'true') AS ok FROM engine_eval_runs WHERE fields->>'Run ID' = $1 AND fields->>'Agent' = $2 GROUP BY 1`,
    [runId, agent],
  );
  return { cases: r.rows.length, failed: r.rows.filter((x) => !x.ok).map((x) => x.case_id).sort() };
}

const FINISHED = `WITH runs AS (
    SELECT fields->>'Run ID' AS run_id, min(fields->>'Run At')::timestamptz AS started, max(fields->>'Run At')::timestamptz AS ended,
           count(*) AS n, max((fields->>'Run Size')::int) AS size
      FROM engine_eval_runs GROUP BY 1)
  SELECT run_id, started, ended FROM runs WHERE size IS NOT NULL AND n >= size`;

export async function sweep(now = new Date()): Promise<{ asked: boolean; settled: number; alerts: number; failed: number }> {
  const out = { asked: false, settled: 0, alerts: 0, failed: 0 };
  const open = (await query<VRow>(`SELECT id::text, agent_id, name, version_id, previous_version_id, is_rollback, seen_at, eval_state, requested_at, alert_state FROM engine_agent_versions WHERE eval_state IN ('pending', 'requested') OR alert_state = 'failed' ORDER BY id`)).rows;
  if (!open.length) {
    const draftStuck = await query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_agent_versions WHERE draft_alert_state = 'failed'`);
    if (draftStuck.rows[0]?.n === '0') return out;
  }

  // 2. ask for one run for everything that has settled.
  const pending = open.filter((v) => v.eval_state === 'pending');
  if (pending.length && pending.every((v) => now.getTime() - new Date(v.seen_at).getTime() >= RULE.settle_seconds * 1000)) {
    const today = await query<{ n: string }>(`SELECT count(DISTINCT requested_at)::text AS n FROM engine_agent_versions WHERE requested_at > $1::timestamptz - interval '24 hours'`, [now.toISOString()]);
    const ids = pending.map((v) => v.id);
    if (Number(today.rows[0].n) >= RULE.max_runs_per_day) {
      await query(`UPDATE engine_agent_versions SET eval_state = 'requested', requested_at = $2, eval_detail = $3 WHERE id = ANY($1::bigint[])`, [ids, now.toISOString(), `no run was asked for: ${RULE.max_runs_per_day} have been asked for in 24 hours. A run started by hand still counts.`]);
    } else {
      const a = await askForRun(pending.map((v) => `${v.name} ${v.version_id.slice(0, 8)}`).join(', '));
      await query(`UPDATE engine_agent_versions SET eval_state = 'requested', requested_at = $2, eval_detail = $3 WHERE id = ANY($1::bigint[])`, [ids, now.toISOString(), a.ok ? 'an eval run was asked for' : `the eval run could not be asked for: ${a.error}. A run started by hand still counts.`]);
      out.asked = a.ok;
      if (!a.ok) console.error(`[publish-check] the eval run was not asked for: ${a.error}`);
    }
    for (const v of pending) v.eval_state = 'requested';
  }

  // 3 and 4. settle each requested row.
  for (const v of open.filter((x) => x.eval_state === 'requested')) {
    const agent = evalKey(v.name);
    const after = await query<{ run_id: string }>(`${FINISHED} AND started > $1::timestamptz ORDER BY started LIMIT 1`, [v.seen_at]);
    const run = after.rows[0]?.run_id ?? null;
    let state: string | null = null;
    let detail = '';
    let alert: string | null = null;
    if (run && agent) {
      const now_ = await failedCases(run, agent);
      const before = await query<{ run_id: string }>(`${FINISHED} AND ended <= $1::timestamptz ORDER BY ended DESC LIMIT 1`, [v.seen_at]);
      const prior = before.rows[0] ? await failedCases(before.rows[0].run_id, agent) : null;
      const regressed = prior ? now_.failed.filter((c) => !prior.failed.includes(c)) : now_.failed;
      const known = now_.failed.filter((c) => !regressed.includes(c));
      if (!now_.cases) {
        state = 'no_cases';
        detail = `${run} holds no case for this agent`;
      } else if (regressed.length) {
        state = 'failed';
        detail = `${run}: ${regressed.join(', ')} failed and passed in ${before.rows[0]?.run_id ?? 'no earlier run'}${known.length ? `; already failing before: ${known.join(', ')}` : ''}`;
        alert = `:rotating_light: *${v.name} went live on version \`${v.version_id.slice(0, 8)}\` and the eval run after it failed.* ${quota.mentions()}\n${run}: ${regressed.join(', ')} failed${prior ? ` and passed in ${before.rows[0].run_id}` : ''}.${known.length ? ` Already failing before the change: ${known.join(', ')}.` : ''}\n${v.previous_version_id ? `To roll back, publish version \`${v.previous_version_id}\` again.` : 'No earlier version is on record to roll back to.'} If the check is wrong and the agent is right, fix the check with a new row in agent_eval_set. Nothing has been changed for you.`;
      } else {
        state = 'passed';
        detail = `${run}: ${now_.cases - now_.failed.length} of ${now_.cases} cases passed${known.length ? `; ${known.join(', ')} failed and were already failing before the change` : ''}`;
      }
    } else if (now.getTime() - new Date(v.seen_at).getTime() > RULE.no_eval_minutes * 60_000) {
      state = 'no_eval';
      detail = `no eval run finished within ${RULE.no_eval_minutes} minutes of the change`;
      alert = `:warning: *${v.name} is live on version \`${v.version_id.slice(0, 8)}\` with no eval run behind it.* ${quota.mentions()}\nNo run of Agent Evals — Runner started and finished in the ${RULE.no_eval_minutes} minutes after the change was recorded. Run it by hand.`;
    }
    if (!state) continue;
    out.settled++;
    let alertState: string | null = null;
    let alertDetail: string | null = null;
    if (alert) {
      const sent = await post(alert);
      alertState = sent.ok ? 'posted' : 'failed';
      alertDetail = sent.ok ? sent.ts : sent.error;
      sent.ok ? out.alerts++ : out.failed++;
    }
    await query(`UPDATE engine_agent_versions SET eval_state = $2, eval_run_id = $3, eval_detail = $4, settled_at = $5, alert_state = $6, alert_detail = $7, alert_text = $8 WHERE id = $1`, [v.id, state, run, detail, now.toISOString(), alertState, alertDetail, alert]);
    await engineEvents
      .record({ event_type: `agent_publish_eval_${state}`, subject_id: v.agent_id, lane: 'ENGINE', actor: 'publish check', detail: { name: v.name, version: v.version_id, previous: v.previous_version_id, run, detail }, dedupe_key: `agent_publish_eval:${v.id}` })
      .catch((e) => console.error(`[publish-check] event not recorded: ${e instanceof Error ? e.message : String(e)}`));
  }

  // A draft alert Slack refused is tried again every pass too.
  const stuckDraft = await query<{ id: string; draft_alert_text: string }>(`SELECT id::text, draft_alert_text FROM engine_agent_versions WHERE draft_alert_state = 'failed' AND draft_alert_text IS NOT NULL`);
  for (const s of stuckDraft.rows) {
    const sent = await post(s.draft_alert_text);
    if (sent.ok) {
      await query(`UPDATE engine_agent_versions SET draft_alert_state = 'posted', draft_alert_detail = $2 WHERE id = $1`, [s.id, sent.ts]);
      out.alerts++;
    } else out.failed++;
  }

  // An alert Slack refused is tried again every pass.
  const stuck = await query<{ id: string; alert_text: string }>(`SELECT id::text, alert_text FROM engine_agent_versions WHERE alert_state = 'failed' AND alert_text IS NOT NULL AND settled_at < $1::timestamptz`, [now.toISOString()]);
  for (const s of stuck.rows) {
    const sent = await post(s.alert_text);
    if (sent.ok) {
      await query(`UPDATE engine_agent_versions SET alert_state = 'posted', alert_detail = $2 WHERE id = $1`, [s.id, sent.ts]);
      out.alerts++;
    } else out.failed++;
  }
  return out;
}

export interface VersionChange {
  id: string; agent_id: string; name: string; version_id: string; previous_version_id: string | null; is_rollback: boolean; seen_at: string;
  eval_state: string; eval_run_id: string | null; eval_detail: string | null; requested_at: string | null; settled_at: string | null; alert_state: string | null;
  draft_run_id: string | null; draft_state: string | null; draft_detail: string | null; draft_alert_state: string | null;
}
export async function recent(limit = 20): Promise<VersionChange[]> {
  return (await query<VersionChange>(`SELECT id::text, agent_id, name, version_id, previous_version_id, is_rollback, seen_at, eval_state, eval_run_id, eval_detail, requested_at, settled_at, alert_state, draft_run_id, draft_state, draft_detail, draft_alert_state FROM engine_agent_versions ORDER BY seen_at DESC, id DESC LIMIT $1`, [limit])).rows;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('publish check');
    if (busy) return;
    busy = true;
    sweep()
      .catch((e) => console.error(`[publish-check] sweep failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.tick_seconds * 1000);
  timer.unref();
}
