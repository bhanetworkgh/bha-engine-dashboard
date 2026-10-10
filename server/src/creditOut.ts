/**
 * "The model credit is out", said the minute it happens (2026-10-10, Destiny).
 *
 * On 10 Oct the OpenRouter credit ran out between two of n8n's three-hourly
 * balance checks. The last check read $27.55, above every alert line, and the
 * next was three hours away, so 49 eval cases and a real ask to Bays failed on
 * credit with nobody told. The balance check answers "is it getting low". This
 * answers the other question: "has something already failed because of it".
 *
 * Every minute it looks at what this database was handed in the last 15
 * minutes and counts the failures that name credit:
 *   - an incident classed BILLING_QUOTA, or whose text is a credit refusal;
 *   - a Failed ask to Bays, North Star or Research Twin whose error is one;
 *   - an eval result whose checks carry one.
 * The first one found posts one alert in the engine alerts channel as Bays.
 *
 * One alert per episode. While credit failures keep arriving the alert stands
 * and nothing more is posted; once 60 minutes pass with none, the episode is
 * over and the next failure alerts again. An alert Slack refuses is kept as
 * failed with the reason and tried again on every tick. Nothing here retries,
 * closes or changes anything: it reads rows and posts one message.
 */
import { query } from './pg';
import { getMeta, setMeta } from './db';
import * as engineEvents from './engineEvents';
import * as slack from './slack';
import * as quota from './quota';
import * as timers from './timers';

export const RULE = { tick_seconds: 60, window_minutes: 15, quiet_minutes: 60 } as const;
export const STATE_KEY = 'credit_out.state';

/** What OpenRouter, and n8n speaking for it, say when the account cannot pay for a request. */
export const CREDIT_TEXT = '(exceed your available credits|insufficient credits|payment required|requires more credits)';

export interface Hit {
  source: 'incident' | 'bays ask' | 'north star ask' | 'research twin ask' | 'eval result';
  id: string;
  at: string;
  where: string | null;
}

export interface State {
  status: 'alerted' | 'failed';
  first_seen_at: string;
  last_seen_at: string;
  failures: number;
  first: Hit;
  channel: string | null;
  ts: string | null;
  error: string | null;
  alerted_at: string | null;
}

const ASKS: Array<[Hit['source'], string]> = [
  ['bays ask', 'engine_bays_asks'],
  ['north star ask', 'engine_ns_asks'],
  ['research twin ask', 'engine_rt_asks'],
];

/** Every credit failure this database was handed since `since`, oldest first. */
export async function hits(since: string): Promise<Hit[]> {
  const parts = [
    `SELECT 'incident' AS source, natural_id AS id, first_seen_at AS at, fields->'payload'->>'workflow_or_scenario' AS "where"
       FROM engine_incidents
      WHERE first_seen_at > $1 AND natural_id IS NOT NULL
        AND (fields->'payload'->>'error_class' = 'BILLING_QUOTA' OR fields::text ~* $2)`,
    ...ASKS.map(
      ([source, table]) =>
        `SELECT '${source}', coalesce(natural_id, id::text), first_seen_at, fields->>'Source'
           FROM ${table}
          WHERE first_seen_at > $1 AND fields->>'Outcome' = 'Failed' AND coalesce(fields->>'Error', '') ~* $2`,
    ),
    `SELECT 'eval result', coalesce(natural_id, id::text), first_seen_at, fields->>'Run ID'
       FROM engine_eval_runs
      WHERE first_seen_at > $1 AND coalesce(fields->>'Checks', '') ~* $2`,
  ];
  const r = await query<Hit>(`SELECT * FROM (${parts.join(' UNION ALL ')}) h ORDER BY at`, [since, CREDIT_TEXT]);
  return r.rows;
}

export function alertText(first: Hit, count: number): string {
  const tag = quota.mentions();
  const what = first.where ? `${first.source} ${first.id} (${first.where})` : `${first.source} ${first.id}`;
  return [
    `:rotating_light: *OpenRouter credit is out* ${tag}`.trim(),
    `A run has just failed because the model account could not pay for it. First seen: ${what}, at ${first.at.slice(0, 16).replace('T', ' ')} UTC.`,
    count > 1 ? `${count} failures on credit in the last ${RULE.window_minutes} minutes.` : null,
    'Until it is topped up, Bays, North Star and Research Twin can fail on any ask, and scheduled tasks can fail too. Top up at https://openrouter.ai/settings/credits',
    `This is posted once. It will post again only after ${RULE.quiet_minutes} minutes with no credit failure and then a new one.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function readState(): Promise<State | null> {
  const raw = await getMeta(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as State;
  } catch {
    return null;
  }
}

async function post(text: string): Promise<{ ok: true; channel: string; ts: string } | { ok: false; error: string }> {
  const channel = quota.channelId();
  if (!channel) return { ok: false, error: `${quota.CHANNEL_VAR} is not set, so there is nowhere to post the alert` };
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set, so nothing can be posted` };
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  if (r.ok && typeof r.ts === 'string') return { ok: true, channel: typeof r.channel === 'string' ? r.channel : channel, ts: r.ts };
  return { ok: false, error: `Slack refused the alert: ${String(r.error ?? 'unknown error')}` };
}

export type Outcome = 'quiet' | 'alerted' | 'standing' | 'failed' | 'episode_over';

/** One look. `now` is passed only by the test. */
export async function check(now = new Date()): Promise<{ outcome: Outcome; state: State | null }> {
  const since = new Date(now.getTime() - RULE.window_minutes * 60_000).toISOString();
  const found = await hits(since);
  let state = await readState();

  if (state && now.getTime() - new Date(state.last_seen_at).getTime() > RULE.quiet_minutes * 60_000 && state.status === 'alerted') {
    // Quiet for long enough: the episode is over, and anything found now starts a new one.
    state = null;
    if (!found.length) {
      await setMeta(STATE_KEY, '');
      return { outcome: 'episode_over', state: null };
    }
  }
  if (!found.length && state?.status !== 'failed') return { outcome: state ? 'standing' : 'quiet', state };

  // A failed alert is owed whether or not a new failure has arrived since.
  const last = found.length ? found[found.length - 1].at : state!.last_seen_at;
  if (state?.status === 'alerted') {
    const next: State = { ...state, last_seen_at: last > state.last_seen_at ? last : state.last_seen_at, failures: Math.max(state.failures, found.length) };
    await setMeta(STATE_KEY, JSON.stringify(next));
    return { outcome: 'standing', state: next };
  }

  const first = state?.first ?? found[0];
  const count = Math.max(found.length, state?.failures ?? 0);
  const sent = await post(alertText(first, count));
  const next: State = {
    status: sent.ok ? 'alerted' : 'failed',
    first_seen_at: state?.first_seen_at ?? first.at,
    last_seen_at: last,
    failures: count,
    first,
    channel: sent.ok ? sent.channel : null,
    ts: sent.ok ? sent.ts : null,
    error: sent.ok ? null : sent.error,
    alerted_at: sent.ok ? now.toISOString() : null,
  };
  await setMeta(STATE_KEY, JSON.stringify(next));
  if (sent.ok) {
    await engineEvents
      .record({
        event_type: 'openrouter_credit_out',
        subject_id: first.id,
        lane: 'ENGINE',
        actor: 'credit-out watcher',
        source_ref: `slack:${sent.channel}/${sent.ts}`,
        detail: { first, failures: count },
        dedupe_key: `credit_out:${next.first_seen_at}`,
      })
      .catch((e) => console.error(`[credit-out] the event was not recorded: ${e instanceof Error ? e.message : String(e)}`));
    console.log(`[credit-out] alerted: ${first.source} ${first.id}, ${count} failure(s)`);
  } else console.error(`[credit-out] ALERT NOT POSTED, will try again next tick: ${sent.error}`);
  return { outcome: sent.ok ? 'alerted' : 'failed', state: next };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startWatching(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('credit-out watch');
    if (busy) return;
    busy = true;
    check()
      .catch((e) => console.error(`[credit-out] check failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.tick_seconds * 1000);
  timer.unref();
}
