/**
 * The log pre-check (10 Nov 2026, Destiny: his 10 Nov log was paid 75% with 25% held, and he wants to
 * know a log's pay before he submits it, from the exact review, not a copy of it). Two reads that write
 * nothing, for n8n's `Engine — Log Pre-Check`:
 *
 *   - `prompt()` hands back the Layer 1 review exactly as it stands in `Bays — Submit Actions` now: the
 *     system message, the prompt with the log put where the review puts it, and the output schema. Read
 *     from n8n on every call, so the pre-check can never drift from the review. The prompt carries two
 *     expressions (the transcript and its source); any other expression appearing there is refused,
 *     because filling it with a guess would no longer be the review.
 *   - `pay()` runs the engine's own earlier-work check and `paySuggest.suggest()` on the review's answer:
 *     the same function the Codex write runs, so the predicted pay is the pay Jason's card would show.
 *
 * The completeness check too (11 Nov 2026, Destiny: his log passed the pre-check at 100% and was then
 * parked by Layer 0 for a missing proof type, and the second review that followed held 5%). `prompt()`
 * also hands back `Layer 0 — Completeness Gate` as it stands, with its three expressions filled the way
 * the run fills them (the earlier approved logs from the engine's own `relogCheck`), and `pay()` takes
 * its answer and runs `layer0Missing`, a port of `Evaluate Layer 0 Gate`. That node's code is hashed on
 * every read and the pre-check refuses (409) the moment it changes, so the port cannot drift unseen.
 * `ready` is true only when the log would not be parked AND the pay reads a full day.
 */
import { createHash } from 'node:crypto';
import * as n8n from './n8n';
import * as paySuggest from './paySuggest';
import { query } from './pg';

export const SUBMIT_ACTIONS = 'YTpezWSOIN6TNYcX';
const REVIEW_NODE = 'Layer 1 — BHA Log Review';
const PARSER_NODE = 'Layer 1 Output Parser';
const L0_NODE = 'Layer 0 — Completeness Gate';
const L0_PARSER = 'Layer 0 Output Parser';
const L0_EVAL = 'Evaluate Layer 0 Gate';
/** sha256 of `Evaluate Layer 0 Gate`'s code when `layer0Missing` was ported from it (11 Nov 2026). */
export const L0_EVAL_SHA = '9b5be59b424ce98678fb033fe14ed7c58ac461f566a88e83fb5d5aa39665c022';
const SOURCES = ['Otter (voice-narrated build session)', 'Loom (UI/UX screen recording)', 'Manual (typed submission)'];

type Obj = Record<string, unknown>;
export class PrecheckError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The review's prompt with the log in place of its two expressions. Pure. */
export function resolvePrompt(template: string, transcript: string, source: string): string {
  let t = template.startsWith('=') ? template.slice(1) : template;
  const exprs = t.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  for (const e of exprs) {
    if (/fullTranscript/.test(e)) t = t.split(e).join(transcript);
    else if (/Loom Path|Otter Path|\.source/.test(e)) t = t.split(e).join(source);
    else throw new PrecheckError(409, `The review's prompt now carries an expression the pre-check does not know how to fill (${e.slice(0, 120)}). Update logPrecheck.resolvePrompt before trusting a pre-check.`);
  }
  return t;
}

type Earlier = { submission_id?: string | null; codex_entry_id?: string | null; session_description?: string | null; why?: string; strength?: string };

/** The earlier-work lines Layer 0's prompt carries, worded as its own expression words them. Pure. */
export function earlierLines(matches: Earlier[] | null): string {
  if (!matches) return 'The check could not run.';
  return matches.length ? matches.map((x) => '- ' + (x.codex_entry_id || x.submission_id) + ': ' + (x.session_description || '') + ' (' + x.why + ')').join('\n') : 'None found.';
}

/** Layer 0's prompt with its three expressions filled. Pure. */
export function resolveLayer0(template: string, transcript: string, source: string, earlier: string): string {
  let t = template.startsWith('=') ? template.slice(1) : template;
  for (const e of t.match(/\{\{[\s\S]*?\}\}/g) ?? []) {
    if (/Check For Earlier Work/.test(e)) t = t.split(e).join(earlier);
    else if (/fullTranscript/.test(e)) t = t.split(e).join(transcript);
    else if (/Loom Path|Otter Path/.test(e)) t = t.split(e).join(source);
    else throw new PrecheckError(409, `Layer 0's prompt now carries an expression the pre-check does not know how to fill (${e.slice(0, 120)}). Update logPrecheck.resolveLayer0 before trusting a pre-check.`);
  }
  return t;
}

const PROOF_TYPES = ['test_forced', 'live_natural'];

/** `Evaluate Layer 0 Gate`, ported (see L0_EVAL_SHA). What Layer 0 would park the log for. Pure. */
export function layer0Missing(answer: unknown, transcript: string, earlier: Earlier[]): { missing: string[]; bad_proof_tags: string[] } {
  const raw = ((answer && typeof answer === 'object' ? ((answer as Obj).output ?? answer) : {}) as Obj) || {};
  const missing: string[] = [];
  if (!raw.mission_fit_present) missing.push('mission_fit');
  if (!raw.error_fix_present_or_honest_none) missing.push('error_fix');
  if (!raw.next_step_present) missing.push('next_step');
  if (!(raw.commercial_present ?? raw.commercial_present_or_honest_none)) missing.push('commercial');
  const bad: string[] = [];
  const re = /proof[\s_-]*type\s*[:=]\s*([A-Za-z]+)(?:[\s_-]+([A-Za-z]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(transcript || '')))) {
    const one = m[1].toLowerCase();
    const two = m[2] ? one + '_' + m[2].toLowerCase() : one;
    if (!PROOF_TYPES.includes(one) && !PROOF_TYPES.includes(two)) bad.push(m[0].trim());
  }
  if (raw.proof_type_ok !== true || bad.length) missing.push('proof_type');
  const continues = raw.continues_earlier_work === true || earlier.some((x) => x.strength === 'strong');
  if (continues && raw.relog_declared !== true) missing.push('relog');
  return { missing, bad_proof_tags: bad };
}

export async function prompt(b: Obj): Promise<Obj> {
  let transcript = typeof b.transcript === 'string' ? b.transcript.trim() : '';
  let sessionUrl = typeof b.session_url === 'string' ? b.session_url : '';
  // A log already submitted can be re-checked by its Submission ID: the transcript the review read is on its row.
  const sid = typeof b.submission_id === 'string' ? b.submission_id.trim() : '';
  if (!transcript && sid) {
    const r = await query<{ t: string | null; u: string | null }>(`SELECT fields->>'Transcript' t, fields->>'Session Url' u FROM engine_codex_submissions WHERE fields->>'Submission ID' = $1 ORDER BY id DESC LIMIT 1`, [sid]);
    if (!r.rows[0]?.t) throw new PrecheckError(404, `No Codex row with Submission ID ${sid} carries a transcript.`);
    transcript = r.rows[0].t.trim();
    sessionUrl = sessionUrl || r.rows[0].u || '';
  }
  if (transcript.length < 200) throw new PrecheckError(422, 'transcript is required: the whole log as it will be submitted (at least 200 characters), or submission_id of a log already submitted.');
  const source = typeof b.source === 'string' && SOURCES.includes(b.source) ? b.source : 'Otter (voice-narrated build session)';
  const w = await n8n.workflow(SUBMIT_ACTIONS);
  const nodes = w.nodes as Obj[];
  const review = nodes.find((x) => x.name === REVIEW_NODE);
  const parser = nodes.find((x) => x.name === PARSER_NODE);
  if (!review || !parser) throw new PrecheckError(409, `${REVIEW_NODE} or ${PARSER_NODE} is no longer in Bays — Submit Actions, so there is no review to run.`);
  const params = (review.parameters ?? {}) as Obj;
  const system = String(((params.options ?? {}) as Obj).systemMessage ?? '');
  const template = String(params.text ?? '');
  const schema = String(((parser.parameters ?? {}) as Obj).inputSchema ?? '').replace(/^=/, '');
  if (!system || !template || !schema) throw new PrecheckError(409, 'The review node has no system message, prompt or output schema, so there is nothing to run.');
  JSON.parse(schema);
  // The completeness check, read from the same version of Submit Actions.
  const l0 = nodes.find((x) => x.name === L0_NODE);
  const l0p = nodes.find((x) => x.name === L0_PARSER);
  const l0e = nodes.find((x) => x.name === L0_EVAL);
  if (!l0 || !l0p || !l0e) throw new PrecheckError(409, `${L0_NODE}, ${L0_PARSER} or ${L0_EVAL} is no longer in Bays — Submit Actions, so the completeness check cannot be run.`);
  const evalCode = String(((l0e.parameters ?? {}) as Obj).jsCode ?? '');
  const evalSha = createHash('sha256').update(evalCode).digest('hex');
  if (evalSha !== L0_EVAL_SHA) throw new PrecheckError(409, `${L0_EVAL} has changed since logPrecheck.layer0Missing was ported from it (sha ${evalSha.slice(0, 12)}). Port the change and update L0_EVAL_SHA before trusting a pre-check.`);
  const l0params = (l0.parameters ?? {}) as Obj;
  const l0system = String(((l0params.options ?? {}) as Obj).systemMessage ?? '');
  const l0schema = String(((l0p.parameters ?? {}) as Obj).inputSchema ?? '').replace(/^=/, '');
  JSON.parse(l0schema);
  let earlier: Earlier[] | null = null;
  try {
    earlier = (await paySuggest.relogCheck({ builder_user_id: typeof b.builder_user_id === 'string' ? b.builder_user_id : '', session_url: sessionUrl, transcript })).matches as Earlier[];
  } catch {
    earlier = null;
  }
  const layer0 = { system_message: l0system, prompt: resolveLayer0(String(l0params.text ?? ''), transcript, source, earlierLines(earlier)), schema: l0schema };
  return { system_message: system, prompt: resolvePrompt(template, transcript, source), schema, layer0, source, transcript, session_url: sessionUrl, workflow_version: w.versionId, read_at: new Date().toISOString(), dry_run: true };
}

/** The review's answer as the Codex row would carry it. The agent wraps it in `output`. */
function reviewFields(r: unknown): Obj {
  const o = (r && typeof r === 'object' ? ((r as Obj).output ?? r) : {}) as Obj;
  return o && typeof o === 'object' ? o : {};
}

export async function pay(b: Obj): Promise<Obj> {
  const fields = reviewFields(b.review);
  if (!('Work Parts' in fields) && !('Log Class' in fields)) throw new PrecheckError(422, 'review is required: the Layer 1 answer, with Work Parts and Log Class.');
  const builder = typeof b.builder_user_id === 'string' ? b.builder_user_id : '';
  let relog: paySuggest.RelogCheck | null = null;
  try {
    relog = await paySuggest.relogCheck({ builder_user_id: builder, session_url: b.session_url, transcript: b.transcript });
  } catch (e) {
    relog = { matches: [], looks_like_relog: false, unread: e instanceof Error ? e.message : String(e) };
  }
  const s = paySuggest.suggest(fields, relog);
  // Earlier held pay this log would release on approval (11 Nov 2026), worked out as the Codex write does.
  let releases: paySuggest.Releases | null = null;
  let releases_unread: string | null = null;
  try {
    releases = await paySuggest.releasesFor({ ...fields, 'Builder User ID': builder, 'Submission ID': '' });
  } catch (e) {
    releases_unread = e instanceof Error ? e.message : String(e);
  }
  // The completeness check (11 Nov 2026): what Layer 0 would park this log for, as Evaluate Layer 0 Gate decides.
  let completeness: { checked: boolean; complete: boolean | null; missing: string[]; bad_proof_tags: string[]; answer: unknown } = { checked: false, complete: null, missing: [], bad_proof_tags: [], answer: null };
  if (b.layer0 != null) {
    const r = layer0Missing(b.layer0, typeof b.transcript === 'string' ? b.transcript : '', (relog?.matches ?? []) as Earlier[]);
    completeness = { checked: true, complete: r.missing.length === 0, missing: r.missing, bad_proof_tags: r.bad_proof_tags, answer: b.layer0 };
  }
  const short = s ? s.parts.filter((p) => p.score < 1).map((p) => ({ what: p.what, paid: paySuggest.pct(p.score), tag: p.tag, proof_level: p.proof_level, needs_live_event: p.needs_live_event, to_fix: p.missing })) : [];
  const fullDay = !!s && s.credited_share === 1;
  return {
    ready: fullDay && completeness.complete === true,
    complete: completeness.complete,
    parked_for: completeness.missing,
    completeness,
    full_day: fullDay,
    line: s ? s.line : 'No suggestion: the review listed no work parts, so the card shows none and Jason starts from full.',
    credited: s?.credited_share ?? null,
    held: s?.held_share ?? null,
    docked: s?.docked_share ?? null,
    short,
    flags: s?.flags ?? [],
    verdict: fields.Verdict ?? null,
    red_flags: fields['Red Flags'] ?? null,
    suggestion: s,
    earlier_work: relog,
    releases,
    releases_unread,
    dry_run: true,
  };
}
