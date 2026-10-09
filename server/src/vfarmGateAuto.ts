/**
 * What keeps the vFarm gates current without anybody remembering to
 * (2026-10-09, Destiny — LOOP-1791479575963-7S0O, second pass). The first pass
 * made the records and the locks; every change still had to be told to Bays by
 * a person, which nobody in the middle of hardware work will do.
 *
 * One sweep, every two minutes, over the open Stage 1 and Stage 2 records:
 *
 *   1. **Sensor checks fill themselves.** A record that names its farm
 *      (`monitoring_farm_id`) takes canopy climate from the Monitoring Twin's
 *      own verdict on that farm's live temperature and humidity readings, and
 *      root-zone moisture from its soil-moisture verdict when the crop profile
 *      holds a range for it. No live reading, or a silent feed, changes
 *      nothing: an old verdict is never refreshed from stale data.
 *   2. **The growth stage fills itself** from the crop day the twin tracks.
 *   3. **Checks no sensor covers are asked for.** While a Stage 1 is in
 *      progress, its owner gets one card per pending check with Passed and
 *      Failed buttons. Asked again after 48 hours, three times at most, and
 *      the third ask is also said in the alerts channel.
 *   4. **A status is proposed, never set.** When all four checks have passed,
 *      Jason gets one card: mark Stage 1 passed? The click decides.
 *
 * Every write goes through vfarmGates.writeGate, so the locks, the events and
 * the alerts are the same as for any other change. The cards reuse the
 * approval card's two action ids, so n8n's Bays — Front Door forwards a click
 * to /api/engine/approvals/decide unchanged; a prompt id starts VFP- and that
 * route hands those here.
 *
 * `scoreboard()` is the Gates tab's read: the records, plus the numbers a
 * person wants at a glance.
 */
import { query } from './pg';
import * as gates from './vfarmGates';
import * as monitoringTwin from './monitoringTwin';
import * as slack from './slack';
import * as engineEvents from './engineEvents';
import * as events from './events';

const DESTINY = 'U0AEW3TBYH1';
const JASON = 'U0A9V97949F';
const USER_RE = /^[UW][A-Z0-9]{6,}$/;
export const ASK_TTL_HOURS = 24;
export const REASK_HOURS = 48;
export const MAX_ASKS = 3;
const SWEEP_MS = 2 * 60_000;
const ACTION_YES = 'engine_approval_approve';
const ACTION_NO = 'engine_approval_deny';
const BY_TWIN = 'Monitoring Twin';
const PAGE = 'https://dashboard.bhanetwork.org/vfarm?tab=gates';

const CHECK_LABEL: Record<gates.CheckName, string> = {
  canopy_climate_check: 'Canopy climate',
  root_zone_moisture_check: 'Root-zone moisture',
  airflow_velocity_check: 'Airflow velocity',
  early_disease_detection_check: 'Early disease detection',
};
/** The metrics behind each check a sensor can decide. */
const METRICS: Partial<Record<gates.CheckName, string[]>> = {
  canopy_climate_check: ['temperature', 'humidity'],
  root_zone_moisture_check: ['soil_moisture'],
};
/** Jason's own tag words (8 Oct): tomato_veg, tomato_flower, tomato_fruit. */
const STAGE_TAG: Record<string, string> = { vegetative: 'veg', flowering: 'flower', fruit_set: 'fruit', harvest: 'harvest' };

type Twin = Awaited<ReturnType<typeof monitoringTwin.monitoringData>>;
type Farm = Twin['farms'][number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const checkOf = (r: gates.Row, c: gates.CheckName) => (isObj(r.fields[c]) ? (r.fields[c] as Record<string, unknown>) : null);
const statusOf = (r: gates.Row, c: gates.CheckName) => String(checkOf(r, c)?.status ?? 'pending');
const farmIdOf = (r: gates.Row) => (typeof r.fields.monitoring_farm_id === 'string' ? r.fields.monitoring_farm_id : null);
const mention = (id: string) => (USER_RE.test(id) ? `<@${id}>` : id);

async function openRows(): Promise<gates.Row[]> {
  const all = await gates.rows();
  return all;
}

/* ------------------------------------------------------- sensor verdicts */

export interface SensorVerdict {
  check: gates.CheckName;
  status: 'passed' | 'failed';
  value: Record<string, number>;
  thresholds: Record<string, { min: number | null; max: number | null; unit: string | null }>;
  devices: string[];
}

/** What the twin's live readings say about one check on one farm, or null when they say nothing. */
export function sensorVerdict(farm: Farm, check: gates.CheckName): SensorVerdict | null {
  const metrics = METRICS[check];
  if (!metrics || farm.feed.silent) return null;
  const value: Record<string, number> = {};
  const thresholds: SensorVerdict['thresholds'] = {};
  const devices: string[] = [];
  let bad = false;
  for (const d of farm.devices) {
    if (d.state !== 'LIVE') continue;
    for (const c of d.checks) {
      if (!metrics.includes(c.metric)) continue;
      value[c.metric] = c.value;
      thresholds[c.metric] = { min: c.min, max: c.max, unit: c.unit };
      if (!devices.includes(d.device_id)) devices.push(d.device_id);
      if (!c.ok) bad = true;
    }
  }
  // Every metric the check stands on must have a live, judged reading.
  if (!metrics.every((m) => m in value)) return null;
  return { check, status: bad ? 'failed' : 'passed', value, thresholds, devices };
}

async function syncSensors(rows: gates.Row[], twin: Twin, out: SweepResult): Promise<void> {
  for (const r of rows) {
    if (r.kind === 'offer' || !['planned', 'in_progress'].includes(r.status)) continue;
    const farmId = farmIdOf(r);
    if (!farmId) continue;
    const farm = twin.farms.find((f) => f.farm_id === farmId);
    if (!farm) continue;
    const fields: Record<string, unknown> = {};
    const proof: gates.CheckName[] = [];

    const stage = farm.cycle?.stage?.stage;
    if (stage && farm.cycle && STAGE_TAG[stage]) {
      const tag = `${farm.cycle.crop}_${STAGE_TAG[stage]}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (r.fields.growth_stage !== tag) fields.growth_stage = tag;
    }
    if (r.kind === 'stage1') {
      for (const c of Object.keys(METRICS) as gates.CheckName[]) {
        const v = sensorVerdict(farm, c);
        if (!v) continue;
        const cur = checkOf(r, c);
        if (cur?.status === v.status && cur?.source === 'sensor') continue;
        fields[c] = {
          status: v.status,
          source: 'sensor',
          value: v.value,
          thresholds: v.thresholds,
          checked_by: BY_TWIN,
          checked_at: twin.as_of,
          evidence_ref: `monitoring-twin:${farm.farm_id}:${v.devices.join('+')}@${twin.as_of}`,
          notes: `Judged by the Monitoring Twin against the ${farm.cycle?.stage?.label ?? 'current'} stage targets${farm.synthetic ? ' on a SIMULATED farm' : ''}.`,
        };
        proof.push(c);
      }
    }
    if (!Object.keys(fields).length) continue;
    try {
      const w = await gates.writeGate({ kind: r.kind, object_id: r.object_id, fields, by: BY_TWIN, via: 'monitoring-twin', sensor_proof: proof });
      if (w.written) out.sensor_writes.push({ object_id: r.object_id, fields: Object.keys(fields) });
    } catch (e) {
      out.errors.push(`${r.object_id}: sensor sync refused: ${(e as Error).message}`);
    }
  }
}

/* ---------------------------------------------------------------- prompts */

interface Prompt {
  prompt_id: string;
  kind: 'check' | 'status';
  object_id: string;
  check_name: string | null;
  asked_user: string;
  may_answer: string[];
  channel: string | null;
  ts: string | null;
  status: 'pending' | 'answered' | 'expired' | 'card_failed' | 'superseded';
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  error: string | null;
  is_fixture: boolean;
  created_at: string;
  expires_at: string;
}
const PCOLS = `prompt_id, kind, object_id, check_name, asked_user, may_answer, channel, ts, status, answer, answered_by, error, is_fixture,
  to_char(answered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS answered_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at`;

const newPromptId = () => `VFP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;
export const isPromptId = (id: string) => /^VFP-\d+-[A-Z0-9]{4}$/.test(id);

function promptBlocks(p: Pick<Prompt, 'prompt_id' | 'kind' | 'object_id' | 'check_name' | 'is_fixture' | 'expires_at'>, ask: number): { text: string; blocks: unknown[] } {
  const mark = p.is_fixture ? ':test_tube: *TEST FIXTURE, not a real record.* ' : '';
  const body =
    p.kind === 'check'
      ? `${mark}*vFarm Stage 1 check: ${CHECK_LABEL[p.check_name as gates.CheckName]}* on \`${p.object_id}\`\nNo sensor covers this one yet, so it needs you. Has it passed or failed? One tap records it with your name and the time.${ask > 1 ? `\n_Ask ${ask} of ${MAX_ASKS}._` : ''}`
      : `${mark}*vFarm Stage 1* \`${p.object_id}\`: all four checks have passed.\nMark Stage 1 as *passed*? That is what lets Stage 2 start. Nothing changes until you choose.`;
  const yes = p.kind === 'check' ? 'Passed' : 'Mark passed';
  const no = p.kind === 'check' ? 'Failed' : 'Not yet';
  return {
    text: body.replace(/[*_`]/g, ''),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `\`${p.prompt_id}\` · <${PAGE}|gates page> · expires ${p.expires_at.slice(0, 16).replace('T', ' ')} UTC` }] },
      {
        type: 'actions',
        block_id: `vfarm_gate:${p.prompt_id}`,
        elements: [
          { type: 'button', action_id: ACTION_YES, style: 'primary', text: { type: 'plain_text', text: yes }, value: p.prompt_id },
          { type: 'button', action_id: ACTION_NO, ...(p.kind === 'check' ? { style: 'danger' } : {}), text: { type: 'plain_text', text: no }, value: p.prompt_id },
        ],
      },
    ],
  };
}

async function settleCard(p: Prompt, line: string): Promise<string | null> {
  if (!p.channel || !p.ts) return null;
  const what = p.kind === 'check' ? `vFarm Stage 1 check: ${CHECK_LABEL[p.check_name as gates.CheckName]}` : 'vFarm Stage 1: mark passed?';
  const text = `${p.is_fixture ? ':test_tube: *TEST FIXTURE.* ' : ''}*${what}* on \`${p.object_id}\`\n${line}`;
  const r = await slack.botCall('chat.update', {
    channel: p.channel,
    ts: p.ts,
    text: text.replace(/[*_`]/g, ''),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `\`${p.prompt_id}\` · <${PAGE}|gates page>` }] },
    ],
  });
  return r.ok ? null : `Slack refused the card update: ${String(r.error ?? 'unknown error')}`;
}

async function failed(about: string, objectId: string, fixture: boolean, error: string): Promise<void> {
  console.error(`[vfarm-gates] ${about} for ${objectId}: ${error}`);
  try {
    await engineEvents.record({ event_type: 'VFARM_GATE_ALERT_FAILED', subject_id: objectId, lane: 'VFARM_HARDWARE', actor: 'the dashboard (vFarm gate prompts)', source_ref: PAGE, detail: { about, error, fixture } });
  } catch (e) {
    console.error(`[vfarm-gates] could not record that: ${(e as Error).message}`);
  }
}

async function sendPrompt(input: { kind: 'check' | 'status'; row: gates.Row; check: gates.CheckName | null; to: string; ask: number }, out: SweepResult): Promise<void> {
  const { row, to } = input;
  const may = [...new Set([to, DESTINY, JASON])];
  const id = newPromptId();
  const ins = await query<Prompt>(
    `INSERT INTO engine_vfarm_gate_prompts (prompt_id, kind, object_id, check_name, asked_user, may_answer, is_fixture, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, now() + ($8 || ' hours')::interval) RETURNING ${PCOLS}`,
    [id, input.kind, row.object_id, input.check, to, may, row.is_fixture, String(ASK_TTL_HOURS)],
  );
  const p = ins.rows[0];
  const card = promptBlocks(p, input.ask);
  const r = slack.slackConfigured() ? await slack.botCall('chat.postMessage', { channel: to, text: card.text, blocks: card.blocks, unfurl_links: false, unfurl_media: false }) : { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set`, http_status: 0 };
  if (!r.ok || typeof r.ts !== 'string') {
    const why = String(r.error ?? 'no message timestamp came back');
    await query(`UPDATE engine_vfarm_gate_prompts SET status = 'card_failed', error = $2 WHERE prompt_id = $1`, [id, why]);
    await failed(`${input.kind} card to ${to}`, row.object_id, row.is_fixture, why);
    out.errors.push(`${row.object_id}: the ${input.kind} card to ${to} was not delivered: ${why}`);
    return;
  }
  await query(`UPDATE engine_vfarm_gate_prompts SET channel = $2, ts = $3 WHERE prompt_id = $1`, [id, typeof r.channel === 'string' ? r.channel : to, r.ts]);
  out.prompts_sent.push({ prompt_id: id, kind: input.kind, object_id: row.object_id, check: input.check, to, ask: input.ask });

  if (input.kind === 'check' && input.ask === MAX_ASKS) {
    const channel = gates.alertChannel();
    const text = `${row.is_fixture ? ':test_tube: *TEST FIXTURE.* ' : ''}:hourglass: *vFarm Stage 1 check still unanswered: ${CHECK_LABEL[input.check as gates.CheckName]}* on \`${row.object_id}\`. ${mention(to)} has now been asked ${MAX_ASKS} times and will not be asked again. <${PAGE}|Open the gates page>`;
    const a = channel ? await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false }) : { ok: false, error: 'no alert channel is set', http_status: 0 };
    if (!a.ok) await failed('last-ask notice', row.object_id, row.is_fixture, String(a.error));
  }
}

async function expirePrompts(out: SweepResult): Promise<void> {
  const r = await query<Prompt>(`UPDATE engine_vfarm_gate_prompts SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING ${PCOLS}`);
  for (const p of r.rows) {
    const err = await settleCard(p, `:hourglass: Nobody answered within ${ASK_TTL_HOURS} hours, so nothing was recorded.`);
    if (err) out.errors.push(`${p.prompt_id}: ${err}`);
    out.prompts_expired.push(p.prompt_id);
  }
}

/** Pending cards about something that is no longer a question (the check was answered another way, the record moved on). */
async function supersede(rows: gates.Row[], out: SweepResult): Promise<void> {
  const pending = (await query<Prompt>(`SELECT ${PCOLS} FROM engine_vfarm_gate_prompts WHERE status = 'pending'`)).rows;
  for (const p of pending) {
    const row = rows.find((x) => x.object_id === p.object_id);
    let why: string | null = null;
    if (!row) why = 'The record no longer exists.';
    else if (p.kind === 'check' && statusOf(row, p.check_name as gates.CheckName) !== 'pending') why = `Already recorded as ${statusOf(row, p.check_name as gates.CheckName)}, so this card is closed.`;
    else if (p.kind === 'check' && row.status !== 'in_progress') why = `Stage 1 is now ${row.status}, so this card is closed.`;
    else if (p.kind === 'status' && row.status !== 'in_progress' && row.status !== 'planned') why = `Stage 1 is already ${row.status}, so this card is closed.`;
    else if (p.kind === 'status' && !gates.CHECKS.every((c) => statusOf(row, c) === 'passed')) why = 'A check is no longer passed, so this card is closed.';
    if (!why) continue;
    await query(`UPDATE engine_vfarm_gate_prompts SET status = 'superseded' WHERE prompt_id = $1 AND status = 'pending'`, [p.prompt_id]);
    const err = await settleCard(p, why);
    if (err) out.errors.push(`${p.prompt_id}: ${err}`);
  }
}

async function askWhereNeeded(rows: gates.Row[], twin: Twin | null, out: SweepResult): Promise<void> {
  const history = (await query<Prompt & { age_h: number }>(`SELECT ${PCOLS}, extract(epoch FROM now() - created_at) / 3600 AS age_h FROM engine_vfarm_gate_prompts ORDER BY id`)).rows;
  for (const r of rows) {
    if (r.kind !== 'stage1') continue;
    const mine = history.filter((h) => h.object_id === r.object_id);

    // The manual checks, while the lab validation is running.
    if (r.status === 'in_progress') {
      const owner = typeof r.fields.owner_slack_id === 'string' && USER_RE.test(r.fields.owner_slack_id) ? r.fields.owner_slack_id : null;
      const farm = twin?.farms.find((f) => f.farm_id === farmIdOf(r)) ?? null;
      for (const c of gates.CHECKS) {
        if (statusOf(r, c) !== 'pending') continue;
        // A check a live sensor is about to decide is not asked of a person.
        if (farm && sensorVerdict(farm, c)) continue;
        if (!owner) continue;
        const asks = mine.filter((h) => h.kind === 'check' && h.check_name === c && h.status !== 'card_failed');
        if (asks.some((h) => h.status === 'pending')) continue;
        if (asks.length >= MAX_ASKS) continue;
        const last = asks[asks.length - 1];
        if (last && Number(last.age_h) < REASK_HOURS) continue;
        await sendPrompt({ kind: 'check', row: r, check: c, to: owner, ask: asks.length + 1 }, out);
      }
    }

    // All four in: propose the status. Jason decides a real gate; a fixture's card goes to whoever made it.
    if ((r.status === 'in_progress' || r.status === 'planned') && gates.CHECKS.every((c) => statusOf(r, c) === 'passed')) {
      const asks = mine.filter((h) => h.kind === 'status' && h.status !== 'card_failed');
      const last = asks[asks.length - 1];
      const changedSince = last ? Date.parse(r.updated_at) >= Date.parse(last.created_at) + 1000 : true;
      const due = !last || (last.status !== 'pending' && (changedSince || (last.status === 'expired' && Number(last.age_h) >= REASK_HOURS)));
      if (due && asks.length < MAX_ASKS * 3) {
        const to = r.is_fixture ? (r.created_by && USER_RE.test(r.created_by) ? r.created_by : DESTINY) : JASON;
        await sendPrompt({ kind: 'status', row: r, check: null, to, ask: 1 }, out);
      }
    }
  }
}

/* ------------------------------------------------------------------ click */

export interface DecideResult {
  status: number;
  body: Record<string, unknown>;
}

/** One click on a gate card. approve = Passed / Mark passed; deny = Failed / Not yet. */
export async function decide(input: { prompt_id: string; decision: 'approve' | 'deny'; user_id: string }): Promise<DecideResult> {
  const got = await query<Prompt>(`SELECT ${PCOLS} FROM engine_vfarm_gate_prompts WHERE prompt_id = $1`, [input.prompt_id]);
  const p = got.rows[0];
  if (!p) return { status: 404, body: { ok: false, reason: 'unknown_prompt', raise: false, message: `No gate card is held under ${input.prompt_id}.` } };
  const tell = async (text: string) => {
    if (!p.channel) return;
    const r = await slack.botCall('chat.postEphemeral', { channel: p.channel, user: input.user_id, text });
    if (!r.ok) console.error(`[vfarm-gates] could not tell ${input.user_id}: ${String(r.error)}`);
  };
  if (!p.may_answer.includes(input.user_id)) {
    await tell(`Only ${p.may_answer.map(mention).join(', ')} can answer this one. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: 'not_allowed_to_answer', raise: false, prompt_id: p.prompt_id, message: `${input.user_id} may not answer this card. Nothing was changed.` } };
  }
  const answer = p.kind === 'check' ? (input.decision === 'approve' ? 'passed' : 'failed') : input.decision === 'approve' ? 'mark_passed' : 'not_yet';
  const claim = await query<Prompt>(
    `UPDATE engine_vfarm_gate_prompts SET status = 'answered', answer = $2, answered_by = $3, answered_at = now() WHERE prompt_id = $1 AND status = 'pending' AND expires_at > now() RETURNING ${PCOLS}`,
    [p.prompt_id, answer, input.user_id],
  );
  const c = claim.rows[0];
  if (!c) {
    await tell(`This card was already ${p.status === 'pending' ? 'expired' : p.status}${p.answered_by ? ` by ${mention(p.answered_by)}` : ''}. Nothing was changed.`);
    return { status: 200, body: { ok: false, reason: `already_${p.status === 'pending' ? 'expired' : p.status}`, raise: false, prompt_id: p.prompt_id, message: 'This card is no longer open. Nothing was changed.' } };
  }

  const by = mention(input.user_id);
  if (answer === 'not_yet') {
    const err = await settleCard(c, `:pause_button: ${by} said not yet. Stage 1 stays as it is. You will be asked again if a check changes.`);
    events.changed('vfarm_gates', c.object_id);
    return { status: 200, body: { ok: true, done: false, answer, prompt_id: c.prompt_id, raise: !!err, ...(err ? { message: err } : {}) } };
  }

  let result: Record<string, unknown>;
  let ok = false;
  try {
    const fields: Record<string, unknown> = c.kind === 'check' ? { [c.check_name as string]: { status: answer, source: 'manual', checked_by: input.user_id, notes: `Answered on a Bays card (${c.prompt_id}).` } } : { status: 'passed' };
    const w = await gates.writeGate({ kind: 'stage1', object_id: c.object_id, fields, by: input.user_id, via: 'gate-card' });
    result = { ok: true, written: w.written, message: w.message, alerts: w.alerts, raise: w.raise === true };
    ok = true;
  } catch (e) {
    result = e instanceof gates.GateRefused ? { ok: false, reason: e.reason, message: e.message } : { ok: false, reason: 'error', message: (e as Error).message };
  }
  await query(`UPDATE engine_vfarm_gate_prompts SET result = $2::jsonb WHERE prompt_id = $1`, [c.prompt_id, JSON.stringify(result)]);
  const line = !ok
    ? `:x: ${by} answered, but it could not be recorded: ${String(result.message)}`
    : c.kind === 'check'
      ? `${answer === 'passed' ? ':white_check_mark:' : ':red_circle:'} Recorded as *${answer}* by ${by}.`
      : `:white_check_mark: Stage 1 marked *passed* by ${by}. Stage 2 can now start.`;
  const err = await settleCard(c, line);
  const problems = [ok ? null : `The answer could not be recorded: ${String(result.message)}`, err, ok && result.raise === true ? 'The Slack alert for this change did not go out.' : null].filter(Boolean);
  return { status: 200, body: { ok, done: ok, answer, prompt_id: c.prompt_id, object_id: c.object_id, result, raise: problems.length > 0, ...(problems.length ? { message: problems.join(' ') } : {}) } };
}

/* ------------------------------------------------------------------ sweep */

export interface SweepResult {
  sensor_writes: { object_id: string; fields: string[] }[];
  prompts_sent: { prompt_id: string; kind: string; object_id: string; check: string | null; to: string; ask: number }[];
  prompts_expired: string[];
  errors: string[];
}

let sweeping = false;
export async function sweep(): Promise<SweepResult> {
  const out: SweepResult = { sensor_writes: [], prompts_sent: [], prompts_expired: [], errors: [] };
  if (sweeping) return out;
  sweeping = true;
  try {
    let rows = await openRows();
    if (!rows.length) {
      await expirePrompts(out);
      await supersede(rows, out);
      return out;
    }
    let twin: Twin | null = null;
    if (rows.some((r) => farmIdOf(r))) {
      try {
        twin = await monitoringTwin.monitoringData();
      } catch (e) {
        out.errors.push(`The Monitoring Twin could not be read: ${(e as Error).message}`);
      }
    }
    if (twin) {
      await syncSensors(rows, twin, out);
      if (out.sensor_writes.length) rows = await openRows();
    }
    await expirePrompts(out);
    await supersede(rows, out);
    await askWhereNeeded(rows, twin, out);
    return out;
  } finally {
    sweeping = false;
  }
}

export function startSweeping(): void {
  const tick = () => {
    sweep()
      .then((r) => {
        if (r.sensor_writes.length || r.prompts_sent.length || r.errors.length) console.log(`[vfarm-gates] sweep: ${r.sensor_writes.length} sensor write(s), ${r.prompts_sent.length} card(s) sent, ${r.prompts_expired.length} expired${r.errors.length ? `, errors: ${r.errors.join(' | ')}` : ''}`);
      })
      .catch((e) => console.error(`[vfarm-gates] sweep failed: ${(e as Error).message}`));
  };
  setTimeout(tick, 75_000).unref();
  setInterval(tick, SWEEP_MS).unref();
}

/* ------------------------------------------------------------- scoreboard */

const DAY = 86_400_000;
const daysBetween = (fromIso: string | null | undefined, to = Date.now()) => (fromIso && !Number.isNaN(Date.parse(fromIso)) ? Math.floor((to - Date.parse(fromIso)) / DAY) : null);

/** The Gates tab's read: the records, and the numbers somebody wants at a glance. */
export async function scoreboard(opts: { events?: number } = {}) {
  const base = await gates.gates(opts);
  const rows = await gates.rows();
  const since = new Map(
    (
      await query<{ subject_id: string; at: string }>(
        `SELECT subject_id, to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM engine_events
          WHERE event_type IN ('VFARM_STAGE1_STATE_CHANGED', 'VFARM_STAGE2_STATE_CHANGED', 'VFARM_OFFER_STATE_CHANGED') GROUP BY subject_id`,
      )
    ).rows.map((r) => [r.subject_id, r.at]),
  );
  const prompts = (await query<Prompt>(`SELECT ${PCOLS} FROM engine_vfarm_gate_prompts WHERE status = 'pending' ORDER BY id`)).rows;
  let twin: Twin | null = null;
  let twinError: string | null = null;
  if (rows.some((r) => farmIdOf(r))) {
    try {
      twin = await monitoringTwin.monitoringData();
    } catch (e) {
      twinError = (e as Error).message;
    }
  }
  const now = Date.now();
  const boards: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    const farmId = farmIdOf(r);
    const farm = twin?.farms.find((f) => f.farm_id === farmId) ?? null;
    const target = typeof r.fields.target_date === 'string' ? r.fields.target_date : null;
    const b: Record<string, unknown> = {
      days_in_status: daysBetween(since.get(r.object_id) ?? r.created_at, now),
      // Whole calendar days (UTC) from today to the target date; negative once it has passed.
      days_to_target: target ? Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)) / DAY) : null,
      farm: farmId ? (farm ? { farm_id: farm.farm_id, name: farm.name, simulated: farm.synthetic, feed_silent: farm.feed.silent, last_snapshot_at: farm.feed.last_snapshot_at } : { farm_id: farmId, name: null, simulated: false, feed_silent: true, last_snapshot_at: null }) : null,
    };
    if (r.kind === 'stage1') {
      const st = gates.CHECKS.map((c) => statusOf(r, c));
      b.checks_total = gates.CHECKS.length;
      b.checks_passed = st.filter((s) => s === 'passed').length;
      b.checks_failed = st.filter((s) => s === 'failed').length;
      b.checks_pending = st.filter((s) => s === 'pending').length;
      b.checks = Object.fromEntries(
        gates.CHECKS.map((c) => {
          const ask = prompts.find((p) => p.object_id === r.object_id && p.kind === 'check' && p.check_name === c);
          const fed = !!(farm && sensorVerdict(farm, c));
          return [c, { fed_by: fed ? 'sensor' : 'person', asked_user: ask?.asked_user ?? null, asked_at: ask?.created_at ?? null }];
        }),
      );
      const proposal = prompts.find((p) => p.object_id === r.object_id && p.kind === 'status');
      b.status_proposed_to = proposal?.asked_user ?? null;
      b.status_proposed_at = proposal?.created_at ?? null;
    }
    if (r.kind === 'stage2') {
      const s1 = rows.find((x) => x.object_id === r.stage1_ref);
      b.locked = !s1 || s1.status !== 'passed';
      b.stage1_status = s1?.status ?? null;
      const incidents7d = farm ? [...farm.open_incidents, ...farm.recent_incidents].filter((i) => now - Date.parse(i.opened_at) < 7 * DAY).length : null;
      b.uptime_pct = farm && !farm.feed.silent ? farm.uptime.pct : null;
      b.uptime_target_pct = typeof r.fields.uptime_target_pct === 'number' ? r.fields.uptime_target_pct : null;
      b.incidents_7d = incidents7d;
      b.alert_budget_per_week = typeof r.fields.alert_volume_budget_per_week === 'number' ? r.fields.alert_volume_budget_per_week : null;
    }
    if (r.kind === 'offer') {
      b.locked = !r.stage2_ref;
      b.leads_tied = Array.isArray(r.fields.linked_lead_ids) ? r.fields.linked_lead_ids.length : 0;
    }
    boards[r.object_id] = b;
  }

  // The strip: the newest real record of each kind. Fixtures never stand in for real state.
  const newest = (kind: gates.GateKind) => [...rows].reverse().find((r) => r.kind === kind && !r.is_fixture) ?? null;
  const s1 = newest('stage1');
  const s2 = newest('stage2');
  const of = newest('offer');
  const pipeline = [
    { key: 'stage1', label: 'Stage 1 · lab validation', record_id: s1?.object_id ?? null, status: s1?.status ?? null, locked: false, locked_reason: null as string | null },
    { key: 'stage2', label: 'Stage 2 · pilot checklist', record_id: s2?.object_id ?? null, status: s2?.status ?? null, locked: s1?.status !== 'passed', locked_reason: s1?.status === 'passed' ? null : `Locked until Stage 1 is passed${s1 ? ` (now ${s1.status.replace('_', ' ')})` : ' (no Stage 1 record yet)'}.` },
    { key: 'offer', label: '5-rack pilot offer', record_id: of?.object_id ?? null, status: of?.status ?? null, locked: !(of?.stage2_ref ?? s2), locked_reason: (of?.stage2_ref ?? s2) ? null : 'Can be drafted, but cannot be offered or signed until a Stage 2 record is tied to it.' },
  ];
  return {
    ...base,
    pipeline,
    boards,
    prompts_waiting: prompts.map((p) => ({ prompt_id: p.prompt_id, kind: p.kind, object_id: p.object_id, check: p.check_name, asked_user: p.asked_user, asked_at: p.created_at, fixture: p.is_fixture })),
    automation: {
      sensor_checks: 'A record that names its farm takes canopy climate from the Monitoring Twin\'s live temperature and humidity verdict, and root-zone moisture once the crop profile holds a soil-moisture range. Airflow velocity and early disease detection have no sensor: their owner is sent a card with Passed and Failed buttons.',
      status: 'When all four checks have passed, Jason is sent a card proposing Stage 1 as passed. Nothing is marked passed without a click.',
      twin_error: twinError,
    },
  };
}
