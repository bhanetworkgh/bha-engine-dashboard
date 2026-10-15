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
 *   - an incident whose text is a credit refusal;
 *   - a Failed ask to Bays, North Star or Research Twin whose error is one;
 *   - an eval result whose checks carry one.
 * The first one found posts one alert in the engine alerts channel as Bays.
 *
 * 15 Oct 2026 (Destiny): OPENROUTER NOT RESPONDING IS A SECOND ALERT, NOT THIS ONE.
 * From 17:03 to 17:28 UTC every Bays ask failed with "OpenRouter could not verify
 * available credits for this request in time. Retry shortly." That is OpenRouter's
 * own pre-request check timing out on its side; the balance read $29.20 throughout
 * and nobody topped up. The error handler's model saw "credits" and classed it
 * BILLING_QUOTA, and this watcher trusted the label, so it told Jason and Destiny
 * to top up an account that had money. Two changes:
 *   - an incident counts as a credit failure on its TEXT only, never on the
 *     BILLING_QUOTA label alone (a label is the classifier's guess, the text is
 *     what the provider said), and never when the text is the provider hang;
 *   - the provider hang has its own watch, with the same window and episode rules,
 *     posting "OpenRouter is not responding" with the advice not to top up.
 *
 * One alert per episode, per watch. While failures keep arriving the alert stands
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
export const PROVIDER_STATE_KEY = 'provider_down.state';

/**
 * What OpenRouter, and n8n speaking for it, say when the account cannot pay for a request, and
 * what this engine's own credit guards say (15 Oct 2026: INC-BAYS.AGENT-052, the eval runner
 * refusing on $3.93, was counted only through its BILLING_QUOTA label, so its words are named here).
 */
export const CREDIT_TEXT =
  '(exceed your available credits|insufficient credits|payment required|requires more credits|openrouter credit is out|openrouter credit is \\$[0-9.]+, below)';

/**
 * What OpenRouter says when its own check before a request times out (15 Oct 2026).
 * A provider outage, never an empty account. Kept in step with PROVIDER_HANG_SIGNAL in
 * the three n8n error handlers' Parse Classification nodes.
 */
export const PROVIDER_HANG_TEXT = '(could not verify (your )?available credits|verify available credits[^.]{0,60}in time)';

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

/** Every row this database was handed since `since` whose text matches `match` and not `notMatch`, oldest first. */
async function find(since: string, match: string, notMatch: string | null): Promise<Hit[]> {
  const not = (col: string) => `($3::text IS NULL OR ${col} !~* $3)`;
  const parts = [
    `SELECT 'incident' AS source, natural_id AS id, first_seen_at AS at, fields->'payload'->>'workflow_or_scenario' AS "where"
       FROM engine_incidents
      WHERE first_seen_at > $1 AND natural_id IS NOT NULL
        AND fields::text ~* $2 AND ${not('fields::text')}`,
    ...ASKS.map(
      ([source, table]) =>
        `SELECT '${source}', coalesce(natural_id, id::text), first_seen_at, fields->>'Source'
           FROM ${table}
          WHERE first_seen_at > $1 AND fields->>'Outcome' = 'Failed'
            AND coalesce(fields->>'Error', '') ~* $2 AND ${not(`coalesce(fields->>'Error', '')`)}`,
    ),
    `SELECT 'eval result', coalesce(natural_id, id::text), first_seen_at, fields->>'Run ID'
       FROM engine_eval_runs
      WHERE first_seen_at > $1 AND coalesce(fields->>'Checks', '') ~* $2 AND ${not(`coalesce(fields->>'Checks', '')`)}`,
  ];
  const r = await query<Hit>(`SELECT * FROM (${parts.join(' UNION ALL ')}) h ORDER BY at`, [since, match, notMatch]);
  return r.rows;
}

/** Every credit failure this database was handed since `since`, oldest first. A provider hang is never one. */
export async function hits(since: string): Promise<Hit[]> {
  return find(since, CREDIT_TEXT, PROVIDER_HANG_TEXT);
}

/** Every failure since `since` that says OpenRouter did not answer in time, oldest first. */
export async function providerHits(since: string): Promise<Hit[]> {
  return find(since, PROVIDER_HANG_TEXT, null);
}

function described(first: Hit): string {
  return first.where ? `${first.source} ${first.id} (${first.where})` : `${first.source} ${first.id}`;
}

export function alertText(first: Hit, count: number): string {
  const tag = quota.mentions();
  return [
    `:rotating_light: *OpenRouter credit is out* ${tag}`.trim(),
    `A run has just failed because the model account could not pay for it. First seen: ${described(first)}, at ${first.at.slice(0, 16).replace('T', ' ')} UTC.`,
    count > 1 ? `${count} failures on credit in the last ${RULE.window_minutes} minutes.` : null,
    'Until it is topped up, Bays, North Star and Research Twin can fail on any ask, and scheduled tasks can fail too. Top up at https://openrouter.ai/settings/credits',
    `This is posted once. It will post again only after ${RULE.quiet_minutes} minutes with no credit failure and then a new one.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function providerAlertText(first: Hit, count: number): string {
  const tag = quota.mentions();
  return [
    `:warning: *OpenRouter is not responding* ${tag}`.trim(),
    `Runs are failing because OpenRouter's own check before each request is timing out on its side. This is not a credit problem: do not top up. First seen: ${described(first)}, at ${first.at.slice(0, 16).replace('T', ' ')} UTC.`,
    count > 1 ? `${count} failures like this in the last ${RULE.window_minutes} minutes.` : null,
    'Until OpenRouter recovers, Bays, North Star and Research Twin can fail on any ask, and scheduled tasks can fail too. Nothing on our side needs changing. OpenRouter status: https://status.openrouter.ai',
    `This is posted once. It will post again only after ${RULE.quiet_minutes} minutes with no such failure and then a new one.`,
  ]
    .filter(Boolean)
    .join('\n');
}

interface Watch {
  name: 'credit-out' | 'provider-down';
  stateKey: string;
  eventType: string;
  find: (since: string) => Promise<Hit[]>;
  text: (first: Hit, count: number) => string;
}

const CREDIT_WATCH: Watch = { name: 'credit-out', stateKey: STATE_KEY, eventType: 'openrouter_credit_out', find: hits, text: alertText };
const PROVIDER_WATCH: Watch = {
  name: 'provider-down',
  stateKey: PROVIDER_STATE_KEY,
  eventType: 'openrouter_not_responding',
  find: providerHits,
  text: providerAlertText,
};

async function readState(key: string): Promise<State | null> {
  const raw = await getMeta(key);
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

async function look(w: Watch, now: Date): Promise<{ outcome: Outcome; state: State | null }> {
  const since = new Date(now.getTime() - RULE.window_minutes * 60_000).toISOString();
  const found = await w.find(since);
  let state = await readState(w.stateKey);

  if (state && now.getTime() - new Date(state.last_seen_at).getTime() > RULE.quiet_minutes * 60_000 && state.status === 'alerted') {
    // Quiet for long enough: the episode is over, and anything found now starts a new one.
    state = null;
    if (!found.length) {
      await setMeta(w.stateKey, '');
      return { outcome: 'episode_over', state: null };
    }
  }
  if (!found.length && state?.status !== 'failed') return { outcome: state ? 'standing' : 'quiet', state };

  // A failed alert is owed whether or not a new failure has arrived since.
  const last = found.length ? found[found.length - 1].at : state!.last_seen_at;
  if (state?.status === 'alerted') {
    const next: State = { ...state, last_seen_at: last > state.last_seen_at ? last : state.last_seen_at, failures: Math.max(state.failures, found.length) };
    await setMeta(w.stateKey, JSON.stringify(next));
    return { outcome: 'standing', state: next };
  }

  const first = state?.first ?? found[0];
  const count = Math.max(found.length, state?.failures ?? 0);
  const sent = await post(w.text(first, count));
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
  await setMeta(w.stateKey, JSON.stringify(next));
  if (sent.ok) {
    await engineEvents
      .record({
        event_type: w.eventType,
        subject_id: first.id,
        lane: 'ENGINE',
        actor: `${w.name} watcher`,
        source_ref: `slack:${sent.channel}/${sent.ts}`,
        detail: { first, failures: count },
        dedupe_key: `${w.name === 'credit-out' ? 'credit_out' : 'provider_down'}:${next.first_seen_at}`,
      })
      .catch((e) => console.error(`[${w.name}] the event was not recorded: ${e instanceof Error ? e.message : String(e)}`));
    console.log(`[${w.name}] alerted: ${first.source} ${first.id}, ${count} failure(s)`);
  } else console.error(`[${w.name}] ALERT NOT POSTED, will try again next tick: ${sent.error}`);
  return { outcome: sent.ok ? 'alerted' : 'failed', state: next };
}

/** One look for credit failures. `now` is passed only by the test. */
export async function check(now = new Date()): Promise<{ outcome: Outcome; state: State | null }> {
  return look(CREDIT_WATCH, now);
}

/** One look for OpenRouter not responding. `now` is passed only by the test. */
export async function checkProvider(now = new Date()): Promise<{ outcome: Outcome; state: State | null }> {
  return look(PROVIDER_WATCH, now);
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startWatching(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('credit-out watch');
    if (busy) return;
    busy = true;
    // Two watches, one after the other: a failure in one never stops the other.
    check()
      .catch((e) => console.error(`[credit-out] check failed: ${e instanceof Error ? e.message : String(e)}`))
      .then(() => checkProvider())
      .catch((e) => console.error(`[provider-down] check failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, RULE.tick_seconds * 1000);
  timer.unref();
}
