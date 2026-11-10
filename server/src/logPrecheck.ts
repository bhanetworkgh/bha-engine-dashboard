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
 */
import * as n8n from './n8n';
import * as paySuggest from './paySuggest';
import { query } from './pg';

export const SUBMIT_ACTIONS = 'YTpezWSOIN6TNYcX';
const REVIEW_NODE = 'Layer 1 — BHA Log Review';
const PARSER_NODE = 'Layer 1 Output Parser';
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
  return { system_message: system, prompt: resolvePrompt(template, transcript, source), schema, source, transcript, session_url: sessionUrl, workflow_version: w.versionId, read_at: new Date().toISOString(), dry_run: true };
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
  const short = s ? s.parts.filter((p) => p.score < 1).map((p) => ({ what: p.what, paid: paySuggest.pct(p.score), tag: p.tag, proof_level: p.proof_level, needs_live_event: p.needs_live_event, to_fix: p.missing })) : [];
  return {
    full_day: !!s && s.credited_share === 1,
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
    dry_run: true,
  };
}
