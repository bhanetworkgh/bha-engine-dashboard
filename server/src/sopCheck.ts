/**
 * SOP-aware LogStream, first pass (11 Nov 2026, Destiny; Jason in #bha-coordination C0ASMPYQLG3 1794358900.575569,
 * under DW-1794360920781-MZAJ). One SOP, one rule, checked on every Codex log from the day the SOP was logged:
 *
 *   SOP -- vFarm Hardware Modularity and Swapability (d796bc63-fc33-4315-8dd4-66f4ec173102)
 *   applies_when: the log touches the VFARM_HARDWARE lane, or names the arm loop LOOP-1790541544543-8E8D.
 *   must_have (the first one): every part swap the log reports has a service entry (old part, new part, reason).
 *   must_not_have: a part swap (servo, sensor, probe, bracket, board, valve, pump...) with no service entry.
 *
 * Jason's rulings: a conflict FLAGS the log and never blocks pay; the question goes to the log's author in their log
 * channel; their answer is stored on the log so audit and pay review read it. The check is plain text matching, written
 * here so anyone can read exactly what trips it; it is not a model's judgement.
 *
 * Fields written on the Codex row (new names, nothing renamed): `SOP Check` (what was checked and the result),
 * `SOP Conflict` = "SOP_CONFLICT", `SOP Conflict SOP ID`, `SOP Conflict Evidence`, `SOP Conflict Prompt` (where the
 * question was asked), and once answered `SOP Deviation Reason`, `SOP Deviation By`, `SOP Deviation At`,
 * `SOP Deviation Link`. Events: sop_conflict_flagged, sop_conflict_prompt_failed, sop_deviation_recorded.
 */
import { query } from './pg';
import * as slack from './slack';
import * as engineEvents from './engineEvents';
import * as engineWrite from './engineWrite';
import * as timers from './timers';

type Obj = Record<string, unknown>;

export const SOP = {
  id: 'd796bc63-fc33-4315-8dd4-66f4ec173102',
  title: 'SOP -- vFarm Hardware Modularity and Swapability',
  rule: 'every part swap has a service entry (old part, new part, reason)',
  /** The day the SOP was logged. A log before it is never judged by it. */
  since: '2026-11-11T00:00:00Z',
  arm_loop: 'LOOP-1790541544543-8E8D',
};

const SWAP = /\b(swap(?:ped|s|ping)?|replac(?:ed|ing|ement)|reprint(?:ed)?|changed out|switched out)\b/i;
const PART = /\b(servo|sensor|probe|bracket|motor|board|uno|arduino|relay|valve|pump|camera|cable|module|joint|gripper|nozzle|shell|mount|pi|wrist|elbow|end[- ]effector|actuator|coil|horn|bearing)s?\b/i;
// A swap that is planned, ordered or not done is not a swap that happened.
const NOT_DONE = /\b(will|ordered|order(?:ing)?|plan(?:ned)?|next step|to be|should|would|need(?:s)? to|not done|not yet|follows on|pending)\b/i;
const SERVICE = /\bservice (entry|log|note)\b|\bold (part|id|version)\b[\s\S]{0,240}\bnew (part|id|version)\b/i;

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export interface Verdict {
  sop_id: string;
  applies: boolean;
  why_applies: string | null;
  result: 'not_applicable' | 'ok' | 'conflict';
  rule: string;
  swaps: string[];
  service_entry: boolean;
  evidence: string | null;
}

/** The check on one log's fields. Pure. */
export function evaluate(f: Obj): Verdict {
  const lanes = str(f['Lanes Touched']).toUpperCase();
  const text = [f['Session Description'], f.Summary, f.Transcript].map(str).join('\n');
  const why = /\bVFARM_HARDWARE\b/.test(lanes) ? 'touches the VFARM_HARDWARE lane' : text.includes(SOP.arm_loop) ? `names the arm loop ${SOP.arm_loop}` : null;
  const base = { sop_id: SOP.id, rule: SOP.rule, why_applies: why };
  if (!why) return { ...base, applies: false, result: 'not_applicable', swaps: [], service_entry: false, evidence: null };
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const swaps = sentences.filter((s) => SWAP.test(s) && PART.test(s) && !NOT_DONE.test(s)).map((s) => (s.length > 300 ? s.slice(0, 299) + '…' : s));
  const service = SERVICE.test(text);
  const conflict = swaps.length > 0 && !service;
  return { ...base, applies: true, result: conflict ? 'conflict' : 'ok', swaps: swaps.slice(0, 5), service_entry: service, evidence: conflict ? swaps[0] : null };
}

/** The question to the log's author. Pure. */
export function promptText(f: Obj, v: Verdict, codexLink: string): string {
  const who = str(f['Builder User ID']);
  return [
    `${who ? `<@${who}> ` : ''}You are diverging from ${SOP.title} (${SOP.id}). Please state why, as a reply in this thread.`,
    `*Log:* ${str(f['Session Description']).slice(0, 200) || str(f['Submission ID'])}`,
    `*Rule:* ${SOP.rule}.`,
    `*What the log says:* "${v.evidence ?? ''}"`,
    'No service entry with the old part, the new part and the reason was found in the log.',
    `This flags the log for review; it does not block pay. ${codexLink}`,
  ].join('\n');
}

const PUBLIC = (process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org').replace(/\/$/, '');
const linkFor = (f: Obj) => `${PUBLIC}/codex/${encodeURIComponent(str(f['Codex Entry ID']) || str(f['Submission ID']))}`;
const permalink = (ch: string, ts: string) => `https://bayshorizonnetwork.slack.com/archives/${ch}/p${ts.replace('.', '')}`;
const CTX = { endpoint: 'sop-check', method: 'PATCH', key_label: 'server', note: 'SOP-aware LogStream' };

async function patch(id: string, fields: Obj): Promise<void> {
  await engineWrite.patchRecord('codex', id, fields, { ...CTX, t0: Date.now() });
}

async function event(type: string, subject: string, detail: Obj, dedupe?: string): Promise<void> {
  await engineEvents.record({ event_type: type, subject_id: subject, lane: 'VFARM_HARDWARE', actor: 'sop-check', source_ref: SOP.id, detail, dedupe_key: dedupe ?? null }).catch((e) => console.error(`[sop-check] event ${type} not written: ${e instanceof Error ? e.message : String(e)}`));
}

/** Ask the author. Returns what was stored. A refused post is raised and tried again on the next pass. */
async function ask(id: string, f: Obj, v: Verdict): Promise<Obj> {
  const channel = str(f['Builder Channel ID']);
  const sid = str(f['Submission ID']);
  if (!channel) {
    const why = 'the log carries no Builder Channel ID, so there is no log channel to ask in';
    await patch(id, { 'SOP Conflict Prompt': { ok: false, error: why, at: new Date().toISOString() } });
    await event('sop_conflict_prompt_failed', sid, { reason: why }, `sop_prompt_failed:${sid}:${new Date().toISOString().slice(0, 10)}`);
    console.error(`[sop-check] ${sid}: ${why}`);
    return { ok: false, error: why };
  }
  const r = await slack.botCall('chat.postMessage', { channel, text: promptText(f, v, linkFor(f)), unfurl_links: false, unfurl_media: false });
  if (!r.ok || !r.ts) {
    const why = `Slack refused the question: ${str(r.error) || 'no ts'}`;
    await patch(id, { 'SOP Conflict Prompt': { ok: false, channel, error: why, at: new Date().toISOString() } });
    await event('sop_conflict_prompt_failed', sid, { channel, reason: why }, `sop_prompt_failed:${sid}:${new Date().toISOString().slice(0, 10)}`);
    console.error(`[sop-check] ${sid}: ${why}`);
    return { ok: false, channel, error: why };
  }
  const prompt = { ok: true, channel, ts: String(r.ts), link: permalink(channel, String(r.ts)), at: new Date().toISOString() };
  await patch(id, { 'SOP Conflict Prompt': prompt });
  return prompt;
}

/** Check one log now and act on it. `dry_run` checks and writes nothing. */
export async function checkOne(id: string, f: Obj, opts: { dry_run?: boolean } = {}): Promise<Obj> {
  const sid = str(f['Submission ID']);
  const at = str(f.Timestamp) || str(f['Processed At']);
  if (at && new Date(at).getTime() < new Date(SOP.since).getTime()) return { ok: false, reason: 'before_sop', message: `${sid} was logged on ${at.slice(0, 10)}, before the SOP existed (${SOP.since.slice(0, 10)}); it is not judged by it.` };
  const v = evaluate(f);
  if (opts.dry_run) return { ok: true, dry_run: true, submission_id: sid, verdict: v, prompt: v.result === 'conflict' ? promptText(f, v, linkFor(f)) : null };
  const check = { ...v, checked_at: new Date().toISOString() };
  if (v.result !== 'conflict') {
    await patch(id, { 'SOP Check': check });
    return { ok: true, submission_id: sid, verdict: v };
  }
  // The flag is written before anything goes to Slack, so two passes cannot ask twice.
  await patch(id, { 'SOP Check': check, 'SOP Conflict': 'SOP_CONFLICT', 'SOP Conflict SOP ID': SOP.id, 'SOP Conflict Evidence': v.evidence });
  await event('sop_conflict_flagged', sid, { sop_id: SOP.id, rule: SOP.rule, evidence: v.evidence, builder: str(f['Builder User ID']) }, `sop_conflict:${sid}:${SOP.id}`);
  const prompt = await ask(id, f, v);
  return { ok: true, submission_id: sid, verdict: v, flagged: true, prompt };
}

/** The author's first reply in the question's thread becomes the deviation reason. */
async function collect(id: string, f: Obj): Promise<boolean> {
  const p = (f['SOP Conflict Prompt'] ?? {}) as Obj;
  const channel = str(p.channel);
  const ts = str(p.ts);
  const author = str(f['Builder User ID']);
  if (!channel || !ts || !author) return false;
  const r = await slack.botCall('conversations.replies', { channel, ts, limit: 50 }, 'form');
  if (!r.ok) {
    console.error(`[sop-check] ${str(f['Submission ID'])}: the question's thread could not be read: ${str(r.error)}`);
    return false;
  }
  const msg = ((r.messages as Obj[]) ?? []).find((m) => str(m.ts) !== ts && str(m.user) === author && str(m.text).trim().length >= 3);
  if (!msg) return false;
  const sid = str(f['Submission ID']);
  const reason = str(msg.text).trim().slice(0, 2000);
  const link = permalink(channel, str(msg.ts));
  const when = new Date(Number(str(msg.ts).split('.')[0]) * 1000).toISOString();
  await patch(id, { 'SOP Deviation Reason': reason, 'SOP Deviation By': author, 'SOP Deviation At': when, 'SOP Deviation Link': link });
  await event('sop_deviation_recorded', sid, { sop_id: SOP.id, reason, by: author, link }, `sop_deviation:${sid}:${SOP.id}`);
  const ack = await slack.botCall('chat.postMessage', { channel, thread_ts: ts, text: `Thank you. Your reason is saved on the log, where Jason and Destiny read it in review and pay: ${linkFor(f)}`, unfurl_links: false });
  if (!ack.ok) console.error(`[sop-check] ${sid}: the reason is saved, but the thank-you was refused: ${str(ack.error)}`);
  return true;
}

/** One pass: check every new log since the SOP, ask again where a question failed, collect answers. */
export async function sweep(): Promise<{ checked: number; flagged: number; asked_again: number; answered: number }> {
  const out = { checked: 0, flagged: 0, asked_again: 0, answered: 0 };
  const fresh = await query<{ id: string; fields: Obj }>(
    `SELECT id::text, fields FROM engine_codex_submissions
      WHERE coalesce(fields->>'Timestamp', fields->>'Processed At', created_time::text) >= $1
        AND NOT (fields ? 'SOP Check') AND coalesce(fields->>'Log Kind', '') <> 'Report'
        AND coalesce(fields->>'Jason Status', '') <> 'Rejected'
      ORDER BY id LIMIT 25`,
    [SOP.since],
  );
  for (const r of fresh.rows) {
    const x = await checkOne(r.id, r.fields).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Obj);
    if (x.ok) out.checked++;
    if (x.flagged) out.flagged++;
  }
  const open = await query<{ id: string; fields: Obj }>(
    `SELECT id::text, fields FROM engine_codex_submissions
      WHERE fields->>'SOP Conflict' = 'SOP_CONFLICT' AND NOT (fields ? 'SOP Deviation Reason') ORDER BY id LIMIT 25`,
  );
  for (const r of open.rows) {
    const p = (r.fields['SOP Conflict Prompt'] ?? {}) as Obj;
    if (p.ok !== true) {
      const again = await ask(r.id, r.fields, evaluate(r.fields)).catch(() => ({ ok: false }) as Obj);
      if (again.ok) out.asked_again++;
      continue;
    }
    if (await collect(r.id, r.fields).catch(() => false)) out.answered++;
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startSweeping(): void {
  if (timer) return;
  timer = setInterval(() => {
    timers.beat('sop check');
    if (busy) return;
    busy = true;
    sweep()
      .then((r) => { if (r.flagged || r.asked_again || r.answered) console.log(`[sop-check] checked ${r.checked}, flagged ${r.flagged}, asked again ${r.asked_again}, answered ${r.answered}`); })
      .catch((e) => console.error(`[sop-check] pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (busy = false));
  }, 120_000);
  timer.unref();
}

/** The engine door: check one log by Submission ID now. */
export async function checkBySubmission(b: Obj): Promise<Obj> {
  const sid = str(b.submission_id).trim();
  if (!sid) return { ok: false, reason: 'submission_id_required' };
  const r = await query<{ id: string; fields: Obj }>(`SELECT id::text, fields FROM engine_codex_submissions WHERE natural_id = $1 OR fields->>'Submission ID' = $1 LIMIT 2`, [sid]);
  if (r.rows.length !== 1) return { ok: false, reason: r.rows.length ? 'ambiguous' : 'not_found', message: `${sid} matches ${r.rows.length} Codex rows.` };
  return checkOne(r.rows[0].id, r.rows[0].fields, { dry_run: b.dry_run === true });
}
