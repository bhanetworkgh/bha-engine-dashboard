/**
 * "Draft full pattern" on a pattern candidate (2026-09-24, Destiny).
 *
 * Registering a candidate used to seed problem, solution and context with the
 * same Summary and leave every richer field empty, so what reached the Build
 * patterns page was a stub. This drafts every field of a build pattern from
 * the two things a candidate actually has — its Summary and the Slack thread at
 * its Source Link — with **the same model and the same prompt** the Pattern
 * Extractor uses (`Bays — Commercial & Pattern Extractors`, `Pat Prep Build
 * Patterns`): `anthropic/claude-sonnet-4-5` through OpenRouter, JSON out.
 *
 * **It saves nothing.** The draft goes back to the page, the person acting
 * reads and edits every field, and only Register writes — through
 * `create_record`, like any other pattern.
 *
 * **Nothing is invented.** The extractor's prompt is kept section for section,
 * with its source-priority rule rewritten for these two sources and one rule
 * added: a field the Summary and the thread do not support is an empty string,
 * and where a field's description asks for a sentence the sources cannot back
 * (a metric, how Slack Genie will route on it) that part is left out rather
 * than written. The prompt is the only guard on grounding and the answer says
 * so; the person reviewing the draft is the other.
 *
 * **The thread is read as North Star**, through `slack.webApi` with
 * `SLACK_NORTH_STAR_BOT_TOKEN` — the one Slack read this server already has,
 * and the one bot with `channels:history`. A thread it cannot read (no token,
 * not in the channel, no Source Link) is named in the answer and the draft is
 * made from the Summary alone, never silently.
 *
 * `OPENROUTER_API_KEY`, no default. Unset, the button answers not_configured
 * and names the variable. `OPENROUTER_API_URL` is optional, for the local
 * stand-in.
 */
import * as slack from './slack';
import * as mirror from './mirror';
import { PEOPLE } from './mcp/northStarTools';

export const OPENROUTER_KEY_VAR = 'OPENROUTER_API_KEY';
const OPENROUTER_URL = (process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
/** `Pat Prep Build Patterns`' own model and token budget. */
export const DRAFT_MODEL = 'anthropic/claude-sonnet-4-5';
const MAX_TOKENS = 3000;
const MODEL_TIMEOUT_MS = 90_000;
const THREAD_LIMIT = 200;
const MESSAGE_CLIP = 2_000;
const THREAD_CHARS = 40_000;

export function draftConfigured(): boolean {
  return Boolean(process.env[OPENROUTER_KEY_VAR]?.trim());
}

/**
 * Every field a build pattern carries — exactly the ones `Pat Write Pattern to
 * Sheet` stores and the pattern panel shows. The extractor's card also draws
 * `implementation_shape`, `provider_shape` and `observability`, but nothing
 * stores them and no page reads them, so they are not drafted: a field no
 * screen shows is one nobody could review. `pattern_id` is not here either:
 * create_record mints it.
 */
export const PATTERN_TEXT_FIELDS = [
  'pattern_name',
  'problem',
  'solution',
  'context',
  'bha_system',
  'reusability',
  'implementation_checklist',
  'learnings_gotchas',
  'anti_pattern',
  'integration_points',
  'readiness_gates',
  'next_use_case',
  'commercial_impact',
  'research_production_impact',
  'routing_logic',
  'test_coverage',
  'naming_note',
  'roadmap_context',
] as const;

/* ------------------------------------------------------------ the thread */

export interface ThreadRead {
  read: boolean;
  messages: number;
  chars: number;
  text: string;
  channel: string | null;
  ts: string | null;
  note: string | null;
}

/**
 * A Slack permalink as the candidate carries it:
 * `https://<ws>.slack.com/archives/<C…>/p1790035072784359[?thread_ts=…]`.
 * The `p` digits are the message ts with its dot removed six from the end.
 * Where a `thread_ts` is present the message is a reply and the thread is that
 * one's, so the root is read.
 */
export function parsePermalink(raw: string | null): { channel: string; ts: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(u.hostname)) return null;
  const m = /^\/archives\/([CGD][A-Z0-9]+)\/p(\d{7,})$/.exec(u.pathname);
  if (!m) return null;
  const thread = u.searchParams.get('thread_ts');
  const ts = thread && /^\d+\.\d+$/.test(thread) ? thread : `${m[2].slice(0, -6)}.${m[2].slice(-6)}`;
  return { channel: m[1], ts };
}

const cleanText = (t: unknown) =>
  String(t || '')
    .replace(/<@(U[A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) => '@' + (PEOPLE[id] || id))
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<!(channel|here|everyone)>/g, '@$1');

export async function readThread(sourceLink: string | null): Promise<ThreadRead> {
  const none = (note: string, at?: { channel: string; ts: string } | null): ThreadRead => ({ read: false, messages: 0, chars: 0, text: '', channel: at?.channel ?? null, ts: at?.ts ?? null, note });
  if (!sourceLink) return none('The candidate has no Source Link, so there is no thread to read.');
  const at = parsePermalink(sourceLink);
  if (!at) return none(`The Source Link is not a Slack message link (${sourceLink.slice(0, 120)}), so no thread was read.`);
  const tok = slack.northStarToken();
  if (!tok) return none(`${slack.NS_TOKEN_VAR} is not set on this server, so the thread was not read.`, at);
  let body: Record<string, unknown>;
  try {
    body = await slack.webApi(tok, 'conversations.replies', { channel: at.channel, ts: at.ts, limit: THREAD_LIMIT });
  } catch (e) {
    return none(`Slack could not be read: ${e instanceof Error ? e.message : String(e)}`, at);
  }
  if (body.ok === false) {
    const hint = body.error === 'not_in_channel' || body.error === 'channel_not_found' ? ' — the North Star bot is not in that channel.' : body.error === 'thread_not_found' ? ' — the message has been deleted.' : '';
    return none(`Slack refused conversations.replies: ${String(body.error)}${hint}`, at);
  }
  type Msg = { user?: string; bot_id?: string; bot_profile?: { name?: string }; username?: string; text?: string; ts?: string; subtype?: string };
  const msgs = ((body.messages as Msg[]) || []).filter((m) => !m.subtype || m.subtype === 'bot_message' || m.subtype === 'thread_broadcast');
  const lines: string[] = [];
  let chars = 0;
  for (const m of msgs) {
    const who = m.bot_id ? `${m.bot_profile?.name || m.username || 'bot'} (bot)` : PEOPLE[m.user ?? ''] || m.user || 'unknown';
    const when = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    const line = `[${when}] ${who}: ${cleanText(m.text).slice(0, MESSAGE_CLIP)}`;
    if (chars + line.length > THREAD_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const cut = lines.length < msgs.length;
  return {
    read: true,
    messages: lines.length,
    chars,
    text: lines.join('\n'),
    channel: at.channel,
    ts: at.ts,
    note: cut ? `The thread has ${msgs.length} messages; the first ${lines.length} (${THREAD_CHARS.toLocaleString('en-GB')} characters) were read.` : null,
  };
}

/* ------------------------------------------------------------ the prompt */

/**
 * `Pat Prep Build Patterns`' system prompt, kept section for section. What
 * changed, and only this: section 1 and the source-priority block name the two
 * sources a candidate has instead of a Codex entry and its transcript; a
 * candidate has already been judged a pattern, so there is no no_pattern
 * answer; pattern_id and pattern_status are not asked for; and the
 * never-invent rule covers the parts of a field description the sources
 * cannot back.
 */
export const SYSTEM_PROMPT = `You are the Bays Horizon Build-Pattern Extractor.

Your job is to turn a pattern candidate an architect is registering into a complete build pattern for the #bha-build-patterns channel and the Build patterns page. A candidate is a pattern somebody flagged from real work; it has already been judged worth registering.

You must think like:
- an AI systems architect
- a senior reviewer for future builders
- a BHA Engine steward who cares about digital twins, the vertical farm and cabinet twin, Log Engine and Builder Ops, Genie, BHARAG, RAG, observability, infra, and any other system that should be reusable beyond a single sprint

SOURCE PRIORITY AND ANTI-HALLUCINATION:
You receive two sources and only two: the candidate itself (its name, lane, builder and Summary) and the Slack thread it was flagged from. The Summary is the claim; the thread is where it came from and is where exact details live (error text, field names, commands, numbers). Every field you write must be grounded in something one of these two sources states. Never introduce a fact, metric, system, identifier, command, error text or test result that neither source contains. If the thread appears to describe something materially different from the Summary, trust the Summary and ignore the discrepancy rather than fabricating a synthesis. A field the sources do not support is an empty string (an empty array for implementation_checklist) -- an empty field is correct and expected; a plausible invented one is a defect. Where a field description below asks for a sentence the sources cannot back (a metric, a named outcome, how Slack Genie and BHARAG will route on the field, a Bitwarden rule), leave that part out rather than writing it.

1. What a BHA-grade build pattern looks like
A good BHA build pattern usually:
- solves a problem in a generalizable way (not just for one hard-coded case)
- follows or extends known BHA principles (no blobs in DB, storage helpers and seams, presigned URLs for media, least-privilege keys and rotation, narrated logs with A-D-R-K structure, human-in-the-loop where safety is needed)
- names the context and solution clearly enough that a new builder could apply it in a different project
- includes a complete, specific one-sentence commercial_impact that names the business value this pattern creates or enables -- the sentence must be finished and self-contained, never trailing off mid-thought.
- uses canonical BHA field names when referencing extractor schemas: research_twin_role, missing_research, research_production_impact, learnings_gotchas, infra_readiness, data_readiness, media_readiness, impact. Never invent alternate names.
- includes an implementation_checklist of concrete, sequential steps a future builder follows to actually apply this pattern in a new context, so the pattern is plug-and-play rather than something the next builder has to reverse-engineer.
- where the pattern involves an identity flow, integration or test obligation, captures it in the relevant optional field below (integration_points, test_coverage) rather than burying it inside Learnings / Gotchas prose.

2. Output schema
Output exactly one JSON object with these fields:
- pattern_name: short, memorable name for the pattern. Keep the candidate's own name unless the sources show it is misleading.
- problem: what problem this pattern solves (1 to 3 sentences)
- solution: how it solves the problem, at the level of architecture or process, not raw code.
- context: where this pattern was used (e.g., vertical farm vision pipeline, Log Engine narration, Genie RAG integration)
- bha_system: which BHA system or initiative this most closely relates to. Prefer the candidate's lane where it fits.
- reusability: how broadly this pattern can be reused (Narrow, Moderate, or Broad)
- next_use_case: one concrete, specific suggestion for where this pattern should be applied next in BHA -- name the system, pipeline, or builder workflow it targets, not a generic description.
- commercial_impact: one complete, specific sentence on the business value this pattern creates or enables. Never trail off.
- research_production_impact: one sentence stating what standard this pattern establishes for any new build touching this domain, and what Research Twin should verify when applying it. Be prescriptive -- name the specific check or rule.
- learnings_gotchas: one to two sentences capturing a concrete, implementation-level lesson from the actual build -- not abstract advice. Name the specific thing that failed or surprised and the exact technical detail that mattered. Do not put production-readiness checklist language here -- that belongs in readiness_gates.
- routing_logic: a compact if/then block, 2-3 lines max, showing the decision paths this pattern governs. If no clear routing logic applies, set to empty string.
- anti_pattern: exactly one sentence in this exact format: "Anti-Pattern: [the wrong version of this pattern]." If no clear anti-pattern applies, set to empty string.
- readiness_gates: a bullet list (2-4 items) naming what must concretely be true before this pattern is marked production-ready -- checkable conditions, not vague aspirations. If readiness is not a meaningful concept for this pattern, set to empty string.
- implementation_checklist: an array of 3-6 short strings, each one concrete, single, sequential step a builder takes to apply this pattern. Every item must be grounded in a concrete action actually described or clearly implied in the sources. If there is no clear step-by-step application sequence, set to an empty array.
- integration_points: a bullet list (2-5 items) naming the specific systems, tables, APIs, or identity sources this pattern touches or depends on. If none are described, set to empty string.
- test_coverage: a bullet list (2-4 items) naming the concrete test scenarios that validate this pattern. Ground every item in something the sources describe or imply was tested. If none apply, set to empty string.
- roadmap_context: one to two sentences, populated only when the sources frame this pattern as a current best-practice or transitional workaround rather than the final architecture. Otherwise empty string.
- naming_note: one line flagging a field-name or naming variant future builders should not confuse. Only when evident in the sources; otherwise empty string.

Do not add extra fields. Do not return explanations outside the JSON.

3. Reusability guidance
- Broad: The pattern is widely applicable across systems and domains (e.g., storage architecture, error-handling templates, narration formats).
- Moderate: The pattern is clearly reusable, but mostly within a particular type of system (e.g., vision pipelines, RAG integrations, Slack to Codex workflows).
- Narrow: The pattern is helpful, but tied to a niche use case or external constraint; it may still be worth capturing as a reference.

When in doubt, lean toward Moderate unless the pattern is obviously universal.`;

export function userPrompt(c: { candidate: string; lane: string; builder: string; summary: string; why: string; thread: ThreadRead }): string {
  return `CANDIDATE: ${c.candidate}
LANE: ${c.lane || '(none)'}
BUILDER: ${c.builder || '(unknown)'}

SUMMARY:
${c.summary || '(no summary written)'}

WHY THIS ARCHITECT:
${c.why || '(not written)'}

SLACK THREAD (the conversation the candidate was flagged from):
${c.thread.read ? c.thread.text || '(the thread holds no text)' : `(not read: ${c.thread.note})`}`;
}

/* ------------------------------------------------------------ the call */

/** `Pat Parse Pattern Response`' fence stripping, Sept 15 order: trim first, then strip. */
export function stripFences(str: string): string {
  const s = String(str || '').trim();
  return s.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
}

function cleanField(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cleanField).filter(Boolean).join('\n');
  return String(v)
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .trim();
}

/** The model's JSON as the form's fields: every one a string, the checklist one step per line. */
export function toFields(parsed: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PATTERN_TEXT_FIELDS) {
    const v = parsed[k];
    out[k] = k === 'implementation_checklist' && Array.isArray(v) ? v.map(cleanField).filter(Boolean).join('\n') : cleanField(v);
  }
  if (out.reusability && !['Narrow', 'Moderate', 'Broad'].includes(out.reusability)) {
    const m = /^(narrow|moderate|broad)/i.exec(out.reusability);
    out.reusability = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : '';
  }
  return out;
}

export class DraftError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DraftResult {
  ok: true;
  fields: Record<string, string>;
  empty_fields: string[];
  model: string;
  sources: { summary: boolean; thread: Omit<ThreadRead, 'text'> };
  usage: Record<string, unknown> | null;
  note: string;
}

export async function draft(row: mirror.LookupRow): Promise<DraftResult> {
  const key = process.env[OPENROUTER_KEY_VAR]?.trim();
  if (!key) throw new DraftError(503, 'not_configured', `${OPENROUTER_KEY_VAR} is not set on this server, so no draft can be made. Fill the form by hand, or set the variable on the service.`);
  const f = row.fields;
  const s = (k: string) => (f[k] === null || f[k] === undefined ? '' : String(f[k]).trim());
  const thread = await readThread(s('Source Link') || null);
  const body = {
    model: DRAFT_MODEL,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt({ candidate: s('Candidate'), lane: s('Lane'), builder: s('Builder'), summary: s('Summary'), why: s('Why This Architect'), thread }) },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'BHA Engine Dashboard - Draft full pattern' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new DraftError(502, 'model_unreachable', timedOut ? `OpenRouter did not answer within ${MODEL_TIMEOUT_MS / 1000} seconds. Nothing was drafted.` : `Could not reach OpenRouter: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (!res.ok || !json) {
    const err = (json?.error as { message?: string } | undefined)?.message ?? text.slice(0, 300);
    throw new DraftError(502, res.status === 402 ? 'model_billing' : 'model_error', `OpenRouter answered ${res.status}: ${err}. Nothing was drafted.`);
  }
  const content = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFences(content)) as Record<string, unknown>;
  } catch (e) {
    throw new DraftError(502, 'parse_error', `The model's answer was not JSON (${e instanceof Error ? e.message : String(e)}): ${String(content).slice(0, 200)}. Nothing was drafted.`);
  }
  const fields = toFields(parsed);
  const empty = PATTERN_TEXT_FIELDS.filter((k) => !fields[k]);
  const { text: _t, ...threadMeta } = thread;
  return {
    ok: true,
    fields,
    empty_fields: empty,
    model: DRAFT_MODEL,
    sources: { summary: Boolean(s('Summary')), thread: threadMeta },
    usage: (json.usage as Record<string, unknown> | undefined) ?? null,
    note: `Drafted from the Summary${thread.read ? ` and ${thread.messages} message${thread.messages === 1 ? '' : 's'} of the Slack thread` : ' alone — the thread was not read'}. ${empty.length ? `${empty.length} field${empty.length === 1 ? '' : 's'} the sources did not support ${empty.length === 1 ? 'is' : 'are'} left empty. ` : ''}Nothing is saved until you press Register.`,
  };
}
