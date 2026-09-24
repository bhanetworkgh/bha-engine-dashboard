/**
 * Research Twin's six write tools (2026-09-24, Destiny), off its Tools Router
 * (`zikfpO0wvqzPCQuz`), the way Bays' and North Star's came off theirs. The
 * Research Twin Agent (`dDtsExaaXhlFd2dv`) called that workflow six ways; each
 * route is a tool here, **ported as written** from its Code nodes:
 *
 *   `write_research_finding`          WRF - Gate And Build Append, + the reach-back
 *                                      onto the card (WRF - Merge Onto Card)
 *   `write_commercial_card_fields`    WCF - Merge Fields
 *   `compute_lane_state`              CLS - Compute Transition
 *   `queue_followup_research`         QFR - Build Job Rows
 *   `update_watched_client_question`  UWC - Merge & Compute, UWC - Build BHARAG Doc
 *   `create_client_report_doc`        CCR - Resolve Questions Table,
 *                                      CCR - Build Report Content, the CCR upload
 *
 * The router read and wrote through `GET`/`PATCH`/`POST /api/engine/:kind`;
 * these call the same functions those routes call (`mirror.lookup`,
 * `engineWrite.patchRecord`, `engineWrite.postRecord`), so the status ledger and
 * the `engine_writes` line are identical whichever door a write came through.
 *
 * Four things differ from the router, on purpose, and each answer says so where
 * it matters:
 *   - **A business refusal is `ok:false` with a plain reason, never a throw** —
 *     QFR threw on zero usable items, and UWC's BHARAG node stopped the whole
 *     call when BHARAG failed. Here an ingest failure is `ingested_to_bharag:
 *     false` beside a question that was written: degrade, never roll back.
 *   - **One answer per call.** The router's parallel branches each returned an
 *     item; the card reach-back and the BHARAG ingest are folded into the one
 *     answer here.
 *   - **`dry_run: true`** runs every step up to the first write and returns
 *     what would be written.
 *   - **Every answer is held to 20,000 characters** — the budget the North
 *     Star tools use — and says so when cut.
 *
 * Write connection only. Every call — refused and dry-run ones included — is on
 * `engine_mcp_writes`, opened before the first read and closed after the last
 * write.
 */
import * as mirror from '../mirror';
import * as engineWrite from '../engineWrite';
import * as bharag from '../bharag';
import * as slack from '../slack';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

export const RESULT_CAP = 20_000;
/** #watched-clients. CCR - Complete Upload names it literally. */
export const REPORT_CHANNEL = 'C0B9LKU7DQV';

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const COMMON = {
  dry_run: { type: 'boolean', description: 'Run every check and say what would be written, without writing.' },
  requester_user_id: { type: 'string', description: 'Slack id of the person or agent asking, for the audit line.' },
};

type Args = Record<string, unknown>;
type Outcome = { outcome: string; detail: string | null; answer: Record<string, unknown>; kind?: string; record_id?: string | number | null; natural_id?: string | null; before?: unknown };

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/** The router's own `sel()`: a select value as Airtable returned it, or plain. */
function sel(v: unknown): string {
  return v && typeof v === 'object' ? str((v as { name?: unknown }).name) : str(v);
}

function ctxFor(tool: string, deps: ToolDeps): engineWrite.WriteCtx {
  return { endpoint: `mcp:${tool}`, method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', t0: Date.now(), note: `via MCP ${tool}` };
}

/**
 * Hold an answer to the cap: the longest string values are cut first, each cut
 * marked, until the JSON fits. A cut answer carries `truncated` and a note.
 */
export function capAnswer(answer: Record<string, unknown>, cap = RESULT_CAP): Record<string, unknown> {
  let json = JSON.stringify(answer);
  if (json.length <= cap) return answer;
  const out: Record<string, unknown> = { ...answer };
  const cut: string[] = [];
  for (let guard = 0; guard < 50 && JSON.stringify(out).length > cap - 200; guard++) {
    const longest = Object.entries(out)
      .filter(([, v]) => typeof v === 'string')
      .sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0];
    if (!longest || (longest[1] as string).length < 200) break;
    const over = JSON.stringify(out).length - (cap - 300);
    const keep = Math.max(100, (longest[1] as string).length - over);
    out[longest[0]] = `${(longest[1] as string).slice(0, keep)}… [cut: ${(longest[1] as string).length} characters in full]`;
    if (!cut.includes(longest[0])) cut.push(longest[0]);
  }
  json = JSON.stringify(out);
  return { ...out, truncated: true, result_chars: json.length, note: `Answer held to ${cap} characters; ${cut.join(', ')} cut. The record itself was written in full.` };
}

async function audited(tool: string, args: Args, deps: ToolDeps, kind: string, run: () => Promise<Outcome>): Promise<Record<string, unknown>> {
  const dry = args.dry_run === true || str(args.dry_run).toLowerCase() === 'true';
  const requester = str(args.requester_user_id).trim() || null;
  const audit = await auditOpen({ tool, args, access: deps.access, kind, requester, dry_run: dry });
  try {
    const r = await run();
    await auditClose(audit, { outcome: r.outcome, detail: r.detail, record_id: r.record_id ?? null, natural_id: r.natural_id ?? null, before: r.before, after: r.answer });
    return capAnswer({ ...r.answer, audit_id: audit });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, reason: 'store_error', error: message, audit_id: audit };
  }
}

function isDry(args: Args): boolean {
  return args.dry_run === true || str(args.dry_run).toLowerCase() === 'true';
}

async function find(kind: mirror.MirrorKind, filters: mirror.LookupFilter[], limit: number): Promise<mirror.LookupRow[]> {
  return (await mirror.lookup(kind, { filters, limit, order: 'created_desc' })).rows;
}

/** WRF - Find Row By Card Id: which column queue_row_id names, by its shape. */
function jobFilters(args: Args): mirror.LookupFilter[] {
  const q = str(args.queue_row_id).trim();
  if (!q) return [{ op: 'f', name: 'Card ID', value: str(args.card_id) }];
  if (/^\d+$/.test(q)) return [{ op: 'f', name: 'id', value: q }];
  if (q.startsWith('rec')) return [{ op: 'f', name: 'airtable_record_id', value: q }];
  return [{ op: 'f', name: 'natural_id', value: q }];
}

async function findCard(cardId: string): Promise<mirror.LookupRow | null> {
  return (await find('commercial', [{ op: 'f', name: 'card_id', value: cardId }], 1))[0] ?? null;
}

/* ------------------------------------------------ write_research_finding */

/** WRF - Gate And Build Append, as written. `job` is null where WRF - Unwrap Job found nothing. */
export function gateFinding(trig: Args, job: { id: number; fields: Record<string, unknown> } | null, nowIso: string): Record<string, unknown> {
  if (!job) {
    return { ok: false, error: 'No open Research Job found for that card_id or queue_row_id. Nothing was recorded. For a card that has no tracked job, write the finding onto the card with Write_Commercial_Card_Fields instead.', _gate: 'not_found' };
  }
  const sourcesRaw = trig.sources;
  let sourcesList: unknown[] = [];
  if (Array.isArray(sourcesRaw)) sourcesList = sourcesRaw.filter(Boolean);
  else if (typeof sourcesRaw === 'string') {
    try {
      const parsed = JSON.parse(sourcesRaw);
      if (Array.isArray(parsed)) sourcesList = parsed.filter(Boolean);
      else if (sourcesRaw.trim()) sourcesList = [sourcesRaw.trim()];
    } catch {
      if (sourcesRaw.trim()) sourcesList = [sourcesRaw.trim()];
    }
  }
  if (sourcesList.length === 0) {
    return { ok: false, error: 'sources are required -- at least one source with a link must be provided before a finding can be recorded', _gate: 'no_sources' };
  }

  const fields = job.fields || {};
  const priorAttempts = typeof fields['Attempts'] === 'number' ? (fields['Attempts'] as number) : 0;
  const attempts = priorAttempts + 1;

  const confidence = ['low', 'medium', 'high'].includes(str(trig.confidence)) ? str(trig.confidence) : 'medium';
  const confidenceLabel = confidence.charAt(0).toUpperCase() + confidence.slice(1);
  const isStuckAttempt = confidence === 'low';

  const priorHistory = str(fields['Answer History']);
  const historyLine = `[${nowIso}] (attempt ${attempts}, confidence: ${confidence}) ${str(trig.finding)}`;
  const answerHistory = priorHistory ? priorHistory + '\n\n' + historyLine : historyLine;

  const priorSources = str(fields['Sources']);
  const sourcesText = sourcesList.join(', ');
  const mergedSources = priorSources ? priorSources + '; ' + sourcesText : sourcesText;

  const cappedNow = isStuckAttempt && attempts >= 3;
  const status = !isStuckAttempt ? 'Resolved' : cappedNow ? 'Capped (needs human)' : 'In Progress';
  const isTerminal = status === 'Resolved' || status === 'Capped (needs human)';

  const gapTypeMap: Record<string, string> = { missing_sources: 'Missing sources', conflicting_sources: 'Conflicting sources', unclear_question: 'Unclear question', no_path_forward: 'No path forward', other: 'Other' };
  const gapType = isStuckAttempt ? gapTypeMap[str(trig.gap_classification)] || 'Other' : sel(fields['Gap Type']);

  const priorLinked = str(fields['Linked Asks']);
  const askId = str(trig.ask_id);
  const linkedAsks = askId ? (priorLinked ? priorLinked + '\n' + askId : askId) : priorLinked;

  return {
    ok: true,
    _gate: 'pass',
    recordId: job.id,
    cardId: str(trig.card_id) || str(fields['Card ID']),
    jobId: str(fields['Job ID']),
    status,
    isTerminal,
    finding: str(trig.finding),
    answer_history: answerHistory,
    sources: mergedSources,
    confidence: confidenceLabel,
    attempts,
    requires_human: cappedNow,
    gap_type: gapType,
    missing_elements: isStuckAttempt ? str(trig.missing_elements) : str(fields['Missing Elements']),
    target_source_types: isStuckAttempt ? str(trig.target_source_types) : str(fields['Target Source Types']),
    verdict: !isStuckAttempt && trig.verdict ? trig.verdict : str(fields['Verdict']),
    resolved_at: isTerminal ? nowIso : null,
    linked_asks: linkedAsks,
  };
}

/** WRF - Merge Onto Card, as written. */
export function reachBack(g: Record<string, unknown>, cardFields: Record<string, unknown>, nowIso: string): { researchGleanings: string; missingResearchCount: number } {
  const existing = str(cardFields.research_gleanings);
  const entry = '[' + nowIso + '] (from Research Jobs, resolved after ' + g.attempts + ' attempt(s)) ' + str(g.finding) + '\nSources: ' + str(g.sources);
  const researchGleanings = existing ? existing + '\n\n' + entry : entry;
  let missing = typeof cardFields.missing_research_count === 'number' ? (cardFields.missing_research_count as number) : 0;
  if (missing > 0) missing = missing - 1;
  return { researchGleanings, missingResearchCount: missing };
}

const writeResearchFinding: ToolDefinition = {
  name: 'write_research_finding',
  description:
    "Research Twin's Write_Research_Finding (the same tool, moved off its Tools Router). Record one research attempt on a Research Job (rt-jobs). Finds the job by queue_row_id (row id, rec… id or Job ID) or, without one, the newest OPEN job (Pending / In Progress) for card_id. Refused with no sources. Attempts +1; confidence low is a stuck attempt and the 3rd attempt stuck caps the job 'Capped (needs human)', otherwise medium/high Resolves it; appends Answer History and Sources. On a clean Resolve with a card_id, the finding is appended to that card's research_gleanings and its missing_research_count goes down by one. Returns {ok, card_id, job_id, status, attempts, requires_human, card_updated}.",
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string', description: "The job's card; empty if you have a queue_row_id." },
      queue_row_id: { type: 'string', description: 'The exact Job ID / row id from the context block, when given.' },
      finding: { type: 'string', description: "Full text with [S#] markers, Sources list and the 'What it does not yet support' section." },
      sources: { description: 'Sources, each with its real URL — an array, or a JSON-encoded array. REQUIRED.', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low counts as a stuck attempt; anything else is medium.' },
      verdict: { type: 'string', description: 'Only on a clean medium/high resolve.' },
      gap_classification: { type: 'string', enum: ['missing_sources', 'conflicting_sources', 'unclear_question', 'no_path_forward', 'other'], description: 'Only when low.' },
      missing_elements: { type: 'string', description: 'Only when low.' },
      target_source_types: { type: 'string', description: 'Only when low.' },
      ask_id: { type: 'string', description: 'Optional Ask ID, appended to the job’s Linked Asks.' },
      ...COMMON,
    },
    required: ['finding', 'sources'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Record a research attempt on a job' },
  handler: (args, deps) =>
    audited('write_research_finding', args, deps, 'rt-jobs', async () => {
      const ctx = ctxFor('write_research_finding', deps);
      let rows = await find('rt-jobs', jobFilters(args), 50);
      if (!str(args.queue_row_id).trim()) rows = rows.filter((r) => ['Pending', 'In Progress'].includes(sel(r.fields['Status'])));
      const job = rows[0] ?? null;
      const nowIso = new Date().toISOString();
      const g = gateFinding(args, job ? { id: job.id, fields: job.fields } : null, nowIso);
      if (!g.ok) {
        return { outcome: 'refused', detail: str(g._gate), answer: { ok: false, reason: str(g._gate), error: g.error, card_id: str(args.card_id) } };
      }
      const patch = {
        'Answer History': g.answer_history,
        Attempts: g.attempts,
        Confidence: g.confidence,
        Finding: g.finding,
        'Gap Type': g.gap_type,
        'Linked Asks': g.linked_asks,
        'Missing Elements': g.missing_elements,
        'Resolved At': g.resolved_at,
        Sources: g.sources,
        Status: g.status,
        'Target Source Types': g.target_source_types,
        Verdict: g.verdict,
      };
      const result: Record<string, unknown> = { ok: true, card_id: g.cardId, job_id: g.jobId, status: g.status, attempts: g.attempts, requires_human: g.requires_human };
      const reaches = g.status === 'Resolved' && Boolean(g.cardId);
      if (isDry(args)) {
        const card = reaches ? await findCard(str(g.cardId)) : null;
        return {
          outcome: 'dry_run',
          detail: `${g.jobId} → ${g.status}`,
          record_id: job!.id,
          natural_id: str(g.jobId) || null,
          answer: { ...result, dry_run: true, written: false, would_patch_job: patch, would_reach_back_to_card: reaches ? (card ? { card_id: g.cardId, missing_research_count: reachBack(g, card.fields, nowIso).missingResearchCount } : 'no matching card — nothing would be written onto it') : false },
        };
      }
      await engineWrite.patchRecord('rt-jobs', String(job!.id), patch, ctx);
      if (reaches) {
        const card = await findCard(str(g.cardId));
        if (!card) {
          result.card_updated = false;
          result.card_error = 'Resolved job referenced a card_id with no matching commercial card';
        } else {
          const m = reachBack(g, card.fields, new Date().toISOString());
          await engineWrite.patchRecord('commercial', String(card.id), { research_gleanings: m.researchGleanings, missing_research_count: m.missingResearchCount }, ctx);
          result.card_updated = true;
          result.missing_research_count = m.missingResearchCount;
        }
      } else {
        result.card_updated = false;
      }
      return { outcome: 'applied', detail: `${g.jobId} → ${g.status} (attempt ${g.attempts})${result.card_updated ? `; card ${g.cardId} updated` : ''}`, record_id: job!.id, natural_id: str(g.jobId) || null, before: job, answer: result };
    }),
};

/* ------------------------------------------ write_commercial_card_fields */

/** WCF - Merge Fields, as written. */
export function mergeCardFields(trig: Args, fields: Record<string, unknown>, nowIso: string): { researchGleanings: string; experimentResults: string; missingResearchCount: number; checklist: unknown } {
  function appendLog(existing: unknown, entry: unknown): string {
    if (!entry) return str(existing);
    const line = `[${nowIso}] ${str(entry)}`;
    return existing ? str(existing) + '\n\n' + line : line;
  }
  const researchGleanings = appendLog(fields.research_gleanings, trig.research_gleanings_entry);
  const experimentResults = appendLog(fields.experiment_results, trig.experiment_results_entry);
  let missingResearchCount = typeof fields.missing_research_count === 'number' ? (fields.missing_research_count as number) : 0;
  const resolved = trig.missing_research_resolved === true || str(trig.missing_research_resolved).toLowerCase() === 'true';
  if (resolved && missingResearchCount > 0) missingResearchCount = missingResearchCount - 1;
  const checklist = trig.commercial_ready_v1_checklist || fields.commercial_ready_v1_checklist || '';
  return { researchGleanings, experimentResults, missingResearchCount, checklist };
}

const writeCommercialCardFields: ToolDefinition = {
  name: 'write_commercial_card_fields',
  description:
    "Research Twin's Write_Commercial_Card_Fields (the same tool, moved off its Tools Router). Append research onto a commercial card's running logs — research_gleanings and experiment_results, each entry stamped with an ISO timestamp, never overwritten. missing_research_count goes down by one only when missing_research_resolved is true. An empty commercial_ready_v1_checklist keeps the card's own. A card_id that matches nothing is ok:false 'No card found' and nothing is written. Not for lane/pilot state — use compute_lane_state.",
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string' },
      research_gleanings_entry: { type: 'string', description: 'The finding, with [S#] markers, Sources and the gaps section; timestamped automatically.' },
      experiment_results_entry: { type: 'string', description: 'Optional experiment result; empty if none.' },
      missing_research_resolved: { description: 'true only if this genuinely resolves one of the card’s missing research items.', anyOf: [{ type: 'boolean' }, { type: 'string' }] },
      commercial_ready_v1_checklist: { type: 'string', description: 'Optional updated readiness checklist; empty keeps the existing value.' },
      ...COMMON,
    },
    required: ['card_id'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Append research onto a commercial card' },
  handler: (args, deps) =>
    audited('write_commercial_card_fields', args, deps, 'commercial', async () => {
      const cardId = str(args.card_id);
      const card = await findCard(cardId);
      if (!card) {
        return { outcome: 'refused', detail: 'no card', natural_id: cardId || null, answer: { ok: false, reason: 'card_not_found', error: 'No card found for card_id ' + (cardId || '(empty)') + ' -- nothing was written.' } };
      }
      const m = mergeCardFields(args, card.fields, new Date().toISOString());
      const patch = { commercial_ready_v1_checklist: m.checklist, experiment_results: m.experimentResults, missing_research_count: m.missingResearchCount, research_gleanings: m.researchGleanings };
      if (isDry(args)) {
        return { outcome: 'dry_run', detail: null, record_id: card.id, natural_id: cardId, answer: { ok: true, dry_run: true, written: false, card_id: cardId, missing_research_count: m.missingResearchCount, would_patch: patch } };
      }
      await engineWrite.patchRecord('commercial', String(card.id), patch, ctxFor('write_commercial_card_fields', deps));
      return { outcome: 'applied', detail: `missing_research_count ${String(card.fields.missing_research_count ?? 0)} → ${m.missingResearchCount}`, record_id: card.id, natural_id: cardId, before: card, answer: { ok: true, card_id: cardId, missing_research_count: m.missingResearchCount } };
    }),
};

/* ----------------------------------------------------- compute_lane_state */

export const PILOT_TRIGGERS = ['none', 'ssv_started', 'metrics_met', 'ended_no_threshold'] as const;

/** CLS - Compute Transition, as written. */
export function laneTransition(trigger: unknown, fields: Record<string, unknown>): { laneState: string; pilotState: string; pilotTrigger: string } {
  let laneState = str(fields.lane_state) || 'research_first';
  let pilotState = str(fields.pilot_state) || 'research_only';
  const pilotTrigger = (PILOT_TRIGGERS as readonly string[]).includes(str(trigger)) ? str(trigger) : 'none';
  if (pilotTrigger === 'ssv_started') {
    laneState = 'pilot_running';
    pilotState = 'pilot_live';
  } else if (pilotTrigger === 'metrics_met') {
    laneState = 'productized';
    pilotState = 'pilot_success';
  } else if (pilotTrigger === 'ended_no_threshold') {
    laneState = 'needs_revision';
    pilotState = 'pilot_failed';
  }
  return { laneState, pilotState, pilotTrigger };
}

const computeLaneState: ToolDefinition = {
  name: 'compute_lane_state',
  description:
    "Research Twin's Compute_Lane_State (the same tool, moved off its Tools Router). Deterministically transition a commercial card's lane_state and pilot_state from real pilot evidence — fixed logic, not reasoning: ssv_started → pilot_running / pilot_live; metrics_met → productized / pilot_success; ended_no_threshold → needs_revision / pilot_failed; none (or anything else) leaves both as they are. A card_id that matches nothing is ok:false 'No card found' and nothing is written. Only call with concrete, cited pilot evidence.",
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string' },
      pilot_trigger: { type: 'string', enum: [...PILOT_TRIGGERS] },
      ...COMMON,
    },
    required: ['card_id', 'pilot_trigger'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true, title: "Transition a card's lane and pilot state" },
  handler: (args, deps) =>
    audited('compute_lane_state', args, deps, 'commercial', async () => {
      const cardId = str(args.card_id);
      const card = await findCard(cardId);
      if (!card) {
        return { outcome: 'refused', detail: 'no card', natural_id: cardId || null, answer: { ok: false, reason: 'card_not_found', error: 'No card found for card_id ' + (cardId || '(empty)') + ' -- no state was changed.' } };
      }
      const t = laneTransition(args.pilot_trigger, card.fields);
      const answer = { ok: true, card_id: cardId, lane_state: t.laneState, pilot_state: t.pilotState, pilot_trigger: t.pilotTrigger };
      if (isDry(args)) return { outcome: 'dry_run', detail: t.pilotTrigger, record_id: card.id, natural_id: cardId, answer: { ...answer, dry_run: true, written: false } };
      const r = await engineWrite.patchRecord('commercial', String(card.id), { lane_state: t.laneState, pilot_state: t.pilotState }, ctxFor('compute_lane_state', deps));
      return { outcome: 'applied', detail: `${t.pilotTrigger}: ${t.laneState} / ${t.pilotState}${r.changed ? '' : ' (unchanged)'}`, record_id: card.id, natural_id: cardId, before: card, answer: { ...answer, changed: r.changed } };
    }),
};

/* ------------------------------------------------ queue_followup_research */

/** QFR - Build Job Rows, as written — except that no usable item is an answer rather than a throw. */
export function buildJobRows(trig: Args, nowIso: string, mint: () => string): Array<Record<string, unknown>> {
  let raw: unknown = trig.items;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = [raw];
  const items = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown> | null>;
  const cardId = str(trig.card_id);
  const laneId = str(trig.lane_id);
  return items
    .filter((i): i is Record<string, unknown> => Boolean(i && (i.hypothesis_to_validate || i.question)))
    .map((item) => ({
      job_id: mint(),
      question: str(item.hypothesis_to_validate) || str(item.question),
      context: str(item.context_snippet) || str(item.context),
      research_required: str(item.research_required),
      card_id: cardId,
      lane_id: laneId,
      status: 'Pending',
      attempts: 0,
      opened_by: 'Research Twin',
      opened_at: nowIso,
    }));
}

export function mintJobId(): string {
  return 'JOB-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

const queueFollowupResearch: ToolDefinition = {
  name: 'queue_followup_research',
  description:
    'Research Twin’s Queue_Followup_Research (the same tool, moved off its Tools Router). Create one Pending research job (rt-jobs) per genuinely distinct open question a card’s research surfaced, Job ID minted JOB-<ms>-<4>. items: an array — or a JSON-encoded array — of { research_required, hypothesis_to_validate, context_snippet }; an item with neither hypothesis_to_validate nor question is skipped, and none usable is ok:false with nothing written. Returns {ok, card_id, rows_created, job_ids}.',
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string' },
      lane_id: { type: 'string', description: 'Optional.' },
      items: { description: 'Array (or JSON-encoded array) of { research_required: missing_research_question | missing_proof | unclear_claim, hypothesis_to_validate, context_snippet }.', anyOf: [{ type: 'array', items: { type: 'object' } }, { type: 'string' }, { type: 'object' }] },
      ...COMMON,
    },
    required: ['items'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Queue follow-up research jobs' },
  handler: (args, deps) =>
    audited('queue_followup_research', args, deps, 'rt-jobs', async () => {
      const rows = buildJobRows(args, new Date().toISOString(), mintJobId);
      if (!rows.length) {
        return { outcome: 'refused', detail: 'no usable items', answer: { ok: false, reason: 'no_usable_items', error: 'queue_followup_research received no usable items. Pass items as an array of { research_required, hypothesis_to_validate, context_snippet }. Nothing was written.', card_id: str(args.card_id) } };
      }
      const body = (r: Record<string, unknown>) => ({
        created_time: str(r.opened_at),
        fields: { 'Job ID': r.job_id, Question: r.question, Context: r.context, 'Card ID': r.card_id, Lane: r.lane_id, Status: r.status, Attempts: r.attempts, 'Opened By': r.opened_by, 'Opened At': r.opened_at },
      });
      if (isDry(args)) {
        return { outcome: 'dry_run', detail: `${rows.length} job(s)`, answer: { ok: true, dry_run: true, written: false, card_id: str(args.card_id), rows_created: 0, would_create: rows.map((r) => body(r).fields) } };
      }
      const ctx = ctxFor('queue_followup_research', deps);
      const ids: string[] = [];
      for (const r of rows) {
        const res = await engineWrite.postRecord('rt-jobs', body(r), ctx);
        ids.push(res.natural_id ?? str(r.job_id));
      }
      return { outcome: 'applied', detail: `${ids.length} job(s): ${ids.join(', ')}`, natural_id: ids.join(','), answer: { ok: true, card_id: str(args.card_id), rows_created: ids.length, job_ids: ids } };
    }),
};

/* ----------------------------------------- update_watched_client_question */

/** UWC - Merge & Compute, as written. */
export function mergeQuestion(trig: Args, record: { id: number; fields: Record<string, unknown> }, nowIso: string): Record<string, unknown> {
  const fields = record.fields || {};
  const runCount = typeof fields['Run Count'] === 'number' ? (fields['Run Count'] as number) : 0;
  const researchStuck = runCount >= 3;
  const prevAnswer = str(fields['This Week Answer']);
  const prevConfidence = fields['Confidence'] || null;
  const movementTag = ['same', 'refined', 'contradicted', 'new'].includes(str(trig.movement_tag)) ? str(trig.movement_tag) : 'new';
  const contradictedFrom =
    movementTag === 'contradicted' ? 'Previously (' + (str(fields['Last Updated']) || 'unknown date') + ', confidence: ' + prevConfidence + '): ' + prevAnswer : str(fields['Contradicted From']);
  const history = str(fields['Answer History']) + '\n\n[' + nowIso + '] ' + str(trig.answer);
  const confidence = ['low', 'medium', 'high'].includes(str(trig.confidence)) ? str(trig.confidence) : 'low';
  const missingResearch = confidence === 'low';
  let nextExperiments = '';
  if (researchStuck) nextExperiments = 'Capped after ' + runCount + ' research attempts -- needs a person to review directly, no further auto-research this cycle.';
  else if (missingResearch) nextExperiments = 'Confidence came back low this cycle. Will retry next weekly cycle automatically -- no action needed unless this repeats.';
  let sourcesRaw: unknown = trig.sources;
  if (typeof sourcesRaw === 'string') {
    try {
      const parsed = JSON.parse(sourcesRaw);
      if (Array.isArray(parsed)) sourcesRaw = parsed;
    } catch {
      /* a plain string */
    }
  }
  const sourcesText = Array.isArray(sourcesRaw) ? sourcesRaw.join(' || ') : str(sourcesRaw) || str(fields['Sources']);
  const plainSummary = trig.plain_summary && str(trig.plain_summary).trim() ? str(trig.plain_summary).trim() : str(fields['Plain Summary']);
  return {
    ok: true,
    recordId: record.id,
    tableId: str(trig.table_id),
    question: str(trig.question) || str(fields['Question']),
    answer: str(trig.answer),
    plainSummary,
    confidence,
    movementTag,
    sources: sourcesText,
    history,
    contradictedFrom,
    missingResearch,
    researchStuck,
    nextExperiments,
    runCount,
  };
}

/** UWC - Build BHARAG Doc's lane names, inverted from the Weekly Clock's map. */
const LANE_BY_TABLE: Record<string, string> = {
  tblKfIlEaRNs8qygF: 'Client 9 — Veganism',
  tbllZcuoktLbLRWU9: 'Client 2 — Rare-Earth Recycling',
  tbl42Pl5mcYRNLYQV: 'Client 12 — Surgical Robotics',
  tblvs750H2Q2wcbu7: 'Digasphere — LinkedIn Intel',
  tblDe4GuFyZqrFLHo: 'HonestyGate — AI Trust',
  tblKcl3SRVeuHcClx: 'vFarm — Per-Device Monitoring',
};

/** UWC - Build BHARAG Doc, as written. Null where there is nothing worth remembering. */
export function questionDoc(d: Record<string, unknown>, now: Date): bharag.IngestDocument | null {
  const question = str(d.question).trim();
  const answer = str(d.answer).trim();
  if (!question || !answer) return null;
  const tableId = str(d.tableId);
  const lane = LANE_BY_TABLE[tableId] || 'Unmapped lane (' + tableId + ')';
  const laneSlug = lane.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const weekOf = now.toISOString().split('T')[0];
  const confidence = str(d.confidence) || 'unknown';
  const movement = str(d.movementTag) || 'new';
  const runCount = typeof d.runCount === 'number' ? d.runCount : 0;
  const lines: string[] = [];
  lines.push('WATCHED CLIENT WEEKLY FINDING');
  lines.push('Lane: ' + lane);
  lines.push('Week of: ' + weekOf);
  lines.push('');
  lines.push('Question:');
  lines.push(question);
  lines.push('');
  lines.push('Answer this cycle:');
  lines.push(answer);
  lines.push('');
  lines.push('Confidence: ' + confidence);
  lines.push('Movement: ' + movement);
  lines.push('Research passes so far: ' + runCount);
  if (movement === 'contradicted' && d.contradictedFrom) {
    lines.push('');
    lines.push('This CONTRADICTS a previous answer. Prior position:');
    lines.push(str(d.contradictedFrom));
  }
  if (d.researchStuck) {
    lines.push('');
    lines.push('STATUS: capped after ' + runCount + ' attempts without a usable answer. Flagged for human review -- do not treat the answer above as settled.');
  } else if (d.missingResearch) {
    lines.push('');
    lines.push('STATUS: confidence came back low this cycle. Evidence is thin; treat as provisional and expect it to be retried next cycle.');
  }
  if (d.sources) {
    lines.push('');
    lines.push('Sources: ' + str(d.sources));
  }
  lines.push('');
  lines.push(
    'HOW TO USE THIS: this is one weekly snapshot of one standing question on a watched client lane. Confidence and movement are reported as recorded, not smoothed. A low-confidence or capped entry is evidence of a gap, not an answer.',
  );
  const shortQ = question.length > 70 ? question.slice(0, 70) + '...' : question;
  return {
    title: 'Watched Client Weekly — ' + lane + ' — ' + shortQ + ' — ' + weekOf,
    content: lines.join('\n'),
    source_type: 'manual',
    content_type: 'doc',
    project_tags: ['watched-clients', laneSlug],
    metadata: {
      lane,
      table_id: tableId,
      record_id: d.recordId || '',
      question,
      confidence,
      movement_tag: movement,
      run_count: runCount,
      research_stuck: d.researchStuck === true,
      week_of: weekOf,
    },
  };
}

const updateWatchedClientQuestion: ToolDefinition = {
  name: 'update_watched_client_question',
  description:
    "Research Twin's Update_Watched_Client_Question (the same tool, moved off its Tools Router). Write a weekly researched answer onto one standing question in a Watched Clients lane (client_questions), matched by table_id and the question's exact text. Sets This Week Answer, Confidence, Movement Tag, Sources, Plain Summary (the prior one is kept when none is given), appends Answer History, records Contradicted From on a contradiction, and flags Research Stuck at Run Count 3. Then ingests one BHARAG doc for the answered question into the Research Twin workspace — a BHARAG failure leaves the row written and says ingested_to_bharag:false. Call once per question.",
  inputSchema: {
    type: 'object',
    properties: {
      table_id: { type: 'string', description: 'Exact, from the prompt (tbl…).' },
      question: { type: 'string', description: 'Exact text, verbatim from the prompt.' },
      answer: { type: 'string', description: 'Technical answer: What the evidence supports, Sources, What it does not yet support.' },
      plain_summary: { type: 'string', description: '2–4 sentence paste-ready client summary. Empty keeps the previous one.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      movement_tag: { type: 'string', enum: ['new', 'same', 'refined', 'contradicted'] },
      sources: { description: 'Array (or JSON-encoded array) with real URLs, e.g. ["[S1] MedTech Dive - https://..."].', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      ...COMMON,
    },
    required: ['table_id', 'question', 'answer'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Write a watched-client weekly answer' },
  handler: (args, deps) =>
    audited('update_watched_client_question', args, deps, 'client_questions', async () => {
      const tableId = str(args.table_id);
      const rows = await find('client_questions', [{ op: 'f', name: 'table_id', value: tableId }, { op: 'f', name: 'Question', value: str(args.question) }], 5);
      const row = rows[0];
      if (!row) {
        return { outcome: 'refused', detail: 'no question row', answer: { ok: false, reason: 'question_not_found', error: 'No question row found matching that exact text in table ' + tableId } };
      }
      const now = new Date();
      const d = mergeQuestion(args, { id: row.id, fields: row.fields }, now.toISOString());
      const patch = {
        'Answer History': d.history,
        Confidence: d.confidence,
        'Contradicted From': d.contradictedFrom,
        'Last Updated': now.toISOString(),
        'Missing Research': d.missingResearch,
        'Movement Tag': d.movementTag,
        'Next Experiments': d.nextExperiments,
        'Research Stuck': d.researchStuck,
        Sources: d.sources,
        'This Week Answer': d.answer,
        'Plain Summary': d.plainSummary,
      };
      const result: Record<string, unknown> = { ok: true, question: d.question, table_id: d.tableId, run_count: d.runCount, research_stuck: d.researchStuck, movement_tag: d.movementTag };
      const doc = questionDoc(d, now);
      if (isDry(args)) {
        return { outcome: 'dry_run', detail: null, record_id: row.id, answer: { ...result, dry_run: true, written: false, would_patch: { ...patch, 'Answer History': `(${str(patch['Answer History']).length} characters, one entry appended)` }, would_ingest: doc ? { title: doc.title, configured: bharag.ingestConfigured('research_twin') } : false } };
      }
      await engineWrite.patchRecord('client_questions', String(row.id), patch, ctxFor('update_watched_client_question', deps));
      // Degrade, never roll back: the row is the record, BHARAG is its memory.
      if (!doc) {
        result.ingested_to_bharag = false;
        result.bharag_detail = 'No question or answer text, so nothing was worth ingesting.';
      } else {
        const ing = await bharag.ingest('research_twin', doc);
        result.ingested_to_bharag = ing.ok;
        result.degraded = !ing.ok;
        result.bharag_title = doc.title;
        result.bharag_detail = ing.detail;
      }
      return { outcome: 'applied', detail: `${d.movementTag}, ${d.confidence}; BHARAG ${result.ingested_to_bharag ? 'ingested' : `not ingested — ${str(result.bharag_detail)}`}`, record_id: row.id, before: row, answer: result };
    }),
};

/* ----------------------------------------------- create_client_report_doc */

type Lane = Record<string, unknown>;

/** CCR - Resolve Questions Table, as written. */
export function resolveLane(clientName: unknown, laneRows: Array<{ fields: Record<string, unknown> }>): Lane {
  const wanted = str(clientName);
  const norm = (s: unknown) => str(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const needle = norm(wanted);
  const rows = laneRows.filter((r) => r && r.fields && r.fields['Questions Table']);
  let hit: { fields: Record<string, unknown> } | undefined;
  if (needle) {
    hit =
      rows.find((r) => norm(r.fields['Lane / Client']) === needle || norm(r.fields['Lane ID']) === needle) ||
      rows.find((r) => norm(r.fields['Lane / Client']).includes(needle) || norm(r.fields['Lane ID']).includes(needle)) ||
      rows.find((r) => needle.includes(norm(r.fields['Lane ID'])) && norm(r.fields['Lane ID']).length > 6);
  }
  const available = rows.map((r) => r.fields['Lane / Client']).filter(Boolean);
  if (!hit) return { found: false, client_name: wanted, available };
  const f = hit.fields;
  const TABLE_IDS: Record<string, string> = {
    Client9_Veganism_Questions: 'tblKfIlEaRNs8qygF',
    Client2_RareEarths_Questions: 'tbllZcuoktLbLRWU9',
    Client12_SurgicalRobotics_Questions: 'tbl42Pl5mcYRNLYQV',
  };
  const raw = str(f['Questions Table']).trim();
  const tableId = /^tbl[A-Za-z0-9]{14}$/.test(raw) ? raw : TABLE_IDS[raw];
  if (!tableId) return { found: false, client_name: str(f['Lane / Client']) || wanted, unresolved_table: raw, available };
  return {
    found: true,
    client_name: str(f['Lane / Client']) || wanted,
    lane_id: str(f['Lane ID']),
    questions_table: tableId,
    lane_status: str(f['Lane Status']),
    run_state: str(f['Run State']),
    quarantined: f['Quarantined'] === true,
    infra_fix_required: f['Infra Fix Required'] === true,
    trend_shape: str(f['Trend Shape Call']),
    commercial_hook: str(f['Commercial Hook']),
    last_run_at: str(f['Last Run At']),
  };
}

/** CCR - Build Report Content, as written. `today` is yyyy-mm-dd. */
export function buildReport(lane: Lane, trig: Args, questionRows: Array<{ fields: Record<string, unknown> }>, today: string): Record<string, unknown> {
  if (trig.report_content && str(trig.report_content).trim()) {
    return { client_name: lane.client_name, report_content: str(trig.report_content), generated: false };
  }
  const rows = questionRows.filter((r) => r && r.fields && r.fields['Question']);

  function splitAnswer(text: unknown) {
    const t = str(text).replace(/\r/g, '');
    const findAt = (re: RegExp) => {
      const m = t.match(re);
      return m ? (m.index as number) : -1;
    };
    const iSupports = findAt(/^[ \t]*\**[ \t]*what the evidence supports[ \t]*\**[ \t]*:?[ \t]*$/im);
    const iNot = findAt(/^[ \t]*\**[ \t]*what it does not yet support[ \t]*\**[ \t]*:?[ \t]*$/im);
    const iSrc = findAt(/^[ \t]*\**[ \t]*sources[ \t]*\**[ \t]*:?[ \t]*$/im);
    const marks = [iSupports, iNot, iSrc].filter((i) => i >= 0).sort((a, b) => a - b);
    const slice = (start: number) => {
      if (start < 0) return '';
      const after = marks.find((m) => m > start);
      const body = t.slice(start, after === undefined ? t.length : after);
      return body.replace(/^[^\n]*\n/, '').trim();
    };
    let supports = slice(iSupports);
    if (iSupports < 0) {
      const firstMark = marks.length ? marks[0] : t.length;
      supports = t.slice(0, firstMark).trim();
    }
    return { supports, notYet: slice(iNot), sourcesText: slice(iSrc), hasNotYet: iNot >= 0 };
  }

  type Q = { question: string; answer: string; parts: ReturnType<typeof splitAnswer>; plain: string; confidence: string; movement: string; sources: string; missing: boolean; stuck: boolean; next: string; contradicted_from: string; runs: number };
  const q: Q[] = rows.map((r) => {
    const f = r.fields;
    return {
      question: str(f['Question']),
      answer: str(f['This Week Answer']),
      parts: splitAnswer(f['This Week Answer'] || ''),
      plain: str(f['Plain Summary']),
      confidence: sel(f['Confidence']) || 'unknown',
      movement: sel(f['Movement Tag']) || 'new',
      sources: str(f['Sources']),
      missing: f['Missing Research'] === true,
      stuck: f['Research Stuck'] === true,
      next: str(f['Next Experiments']),
      contradicted_from: str(f['Contradicted From']),
      runs: typeof f['Run Count'] === 'number' ? (f['Run Count'] as number) : 0,
    };
  });

  const changed = q.filter((x) => x.movement === 'refined' || x.movement === 'contradicted' || x.movement === 'new');
  const steady = q.filter((x) => x.movement === 'same');
  const flagged = q.filter((x) => x.missing || x.stuck);
  const NO_GAP = /^\s*(no material gaps|none)[^\n]*$/i;
  const caveats = q.filter((x) => x.parts.notYet && !NO_GAP.test(x.parts.notYet));
  const maxRuns = q.reduce((m, x) => Math.max(m, x.runs), 0);
  const trendText = str(lane.trend_shape);
  const trendUnset = !trendText.trim() || /not yet established|never researched|seeded/i.test(trendText);
  const youngLane = q.length > 0 && (trendUnset || maxRuns <= 2);
  const MOVE_LABEL: Record<string, string> = { new: 'New this cycle', refined: 'Sharpened since last cycle', contradicted: 'Changed since last cycle', same: 'Unchanged since last cycle' };

  function sourceBundle(x: Q): string[] {
    const raw = x.sources ? String(x.sources) : '';
    let parts = raw ? raw.split(/\s*\|\|\s*/).map((s) => s.trim()).filter(Boolean) : [];
    if (!parts.length && x.parts.sourcesText) parts = x.parts.sourcesText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return ['_No sources recorded for this question._'];
    let n = 0;
    return parts.map((p) => {
      const lab = p.match(/^\[(S\d+(?:-S?\d+)?)\]\s*/i);
      let label: string;
      let rest: string;
      if (lab) {
        label = lab[1].toUpperCase();
        rest = p.slice(lab[0].length);
      } else {
        n += 1;
        label = 'S' + n;
        rest = p;
      }
      const m = rest.match(/https?:\/\/[^\s)]+/);
      if (!m) return '- **[' + label + ']** ' + rest;
      const url = m[0];
      const text = rest.replace(url, '').replace(/[-–—:]\s*$/, '').trim() || url;
      return '- **[' + label + ']** [' + text + '](' + url + ')';
    });
  }

  function summaryBlock(x: Q, i: number): string {
    const out: string[] = [];
    out.push('### ' + (i + 1) + '. ' + x.question);
    out.push('');
    out.push('_' + (MOVE_LABEL[x.movement] || x.movement) + ' · confidence: ' + x.confidence + '_');
    out.push('');
    out.push('**Client Summary**');
    out.push('');
    out.push(x.plain ? x.plain : '_No client summary was recorded for this question this cycle. See the technical appendix below._');
    out.push('');
    return out.join('\n');
  }

  function appendixBlock(x: Q, i: number): string {
    const out: string[] = [];
    out.push('### A' + (i + 1) + '. ' + x.question);
    out.push('');
    out.push('**Confidence:** ' + x.confidence + '  |  **Movement:** ' + x.movement + '  |  **Research passes:** ' + x.runs);
    out.push('');
    out.push('#### What the evidence supports');
    out.push('');
    out.push(x.parts.supports || '_No answer recorded this cycle._');
    out.push('');
    out.push('#### What it does not yet support');
    out.push('');
    out.push(x.parts.hasNotYet ? x.parts.notYet || '_Section present but empty._' : '_This answer did not include a "What it does not yet support" section. Treat its limits as unstated rather than absent._');
    if (x.movement === 'contradicted' && x.contradicted_from) {
      out.push('');
      out.push('#### What we said before');
      out.push('');
      out.push('> ' + String(x.contradicted_from).replace(/\n/g, '\n> '));
    }
    out.push('');
    out.push('#### Sources');
    out.push('');
    out.push(sourceBundle(x).join('\n'));
    out.push('');
    out.push('---');
    return out.join('\n');
  }

  const out: string[] = [];
  out.push('# Weekly Monitoring Report');
  out.push('## ' + str(lane.client_name) + (lane.lane_id ? ' — `' + str(lane.lane_id) + '`' : ''));
  out.push('_Prepared ' + today + '_');
  out.push('');
  out.push('---');
  out.push('');
  out.push('## At a glance');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push('| Questions tracked | ' + q.length + ' |');
  out.push('| Moved this cycle | ' + changed.length + ' |');
  out.push('| Holding steady | ' + steady.length + ' |');
  out.push('| Flagged as thin or stuck | ' + flagged.length + ' |');
  out.push('| Lane maturity | ' + (youngLane ? 'Young — trend not yet established' : 'Established') + ' |');
  if (lane.quarantined) {
    out.push('');
    out.push('> **Note:** this lane is quarantined — auto-research is paused pending human review.');
  }
  if (lane.infra_fix_required) {
    out.push('');
    out.push('> **Note:** an infrastructure fix is flagged as required on this lane.');
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push('## Client Summary');
  out.push('');
  out.push('_Each summary below can be pasted into a client update as written. The evidence behind it is in the technical appendix._');
  out.push('');
  if (q.length) {
    out.push(q.map(summaryBlock).join('\n'));
  } else {
    out.push('_No questions are tracked on this lane yet._');
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('## Where we are still digging');
  out.push('');
  const dig: string[] = [];
  if (youngLane) {
    dig.push('**Structural gaps — this lane is still young**');
    dig.push('');
    dig.push('- **Lane age:** at most ' + maxRuns + ' research pass' + (maxRuns === 1 ? '' : 'es') + ' per question so far, and the trend shape is not yet established. One or two cycles cannot show direction.');
    dig.push('- **No long-cycle history:** we have not yet observed how these companies and this market behave across a full cycle or under stress.');
    dig.push('- **No proven multi-quarter commercial track record:** sustained, commercial-scale throughput and revenue are not yet established in the evidence.');
    dig.push('- **Untested across regimes:** the story has not yet been checked against different market or policy conditions.');
    dig.push('');
  }
  if (flagged.length) {
    dig.push('**Questions flagged this cycle**');
    dig.push('');
    flagged.forEach((x) => {
      dig.push('- **' + x.question + '** — ' + (x.stuck ? 'stuck after repeated cycles, flagged for a person' : 'evidence still thin') + '. Next step: ' + (x.next || '_not yet defined_') + '.');
    });
    dig.push('');
  }
  if (caveats.length) {
    dig.push("**Caveats named in this cycle's answers**");
    dig.push('');
    caveats.forEach((x) => {
      const text = x.parts.notYet.replace(/\s+/g, ' ').trim();
      dig.push('- **' + x.question + '** — ' + (text.length > 600 ? text.slice(0, 597) + '…' : text));
    });
    dig.push('');
  }
  if (dig.length) {
    out.push(dig.join('\n'));
  } else {
    out.push('_No open evidence gaps on this lane: it is established, no question is flagged, and no answer names a caveat._');
    out.push('');
  }
  out.push('---');
  out.push('');
  if (lane.trend_shape) {
    out.push('## Trend shape');
    out.push('');
    out.push(str(lane.trend_shape));
    out.push('');
    out.push('---');
    out.push('');
  }
  out.push('## Technical appendix');
  out.push('');
  out.push('_Full detail for readers who want the evidence. Every question carries the same three blocks: what the evidence supports, what it does not yet support, and its sources._');
  out.push('');
  out.push(q.map(appendixBlock).join('\n\n'));
  out.push('');
  out.push('## How to read this');
  out.push('');
  out.push(
    'The Client Summary gives each answer in plain terms, naming the companies involved. The technical appendix gives the same answer in full, with its limits and sources stated. Where evidence is thin, a lane is young, or an answer carries a caveat, the report says so rather than smoothing it over. A gap named honestly is more useful than a confident guess.',
  );

  const openCount = flagged.length + caveats.length + (youngLane ? 1 : 0);
  return {
    client_name: lane.client_name,
    questions_table: lane.questions_table,
    question_count: q.length,
    changed_count: changed.length,
    digging_count: openCount,
    flagged_count: flagged.length,
    caveat_count: caveats.length,
    young_lane: youngLane,
    steady_count: steady.length,
    generated: true,
    report_content: out.join('\n'),
  };
}

/** CCR - Complete Upload's initial_comment, as written. */
export function reportComment(B: Record<string, unknown>): string {
  const cav = (B.caveat_count as number) || 0;
  return (
    '*Weekly Monitoring Report*\n*' +
    str(B.client_name) +
    '*\n\n───────────────────\n\n•  *' +
    B.question_count +
    '* questions tracked this week\n•  *' +
    B.changed_count +
    '* moved — the answer changed or sharpened since last cycle\n•  *' +
    B.steady_count +
    '* holding steady — same answer as last cycle\n•  *' +
    ((B.flagged_count as number) || 0) +
    '* flagged — evidence too thin to call, or stuck\n•  *' +
    cav +
    '* ' +
    (cav === 1 ? 'answer names' : 'answers name') +
    ' a caveat\n' +
    (B.young_lane ? '•  Young lane — its structural gaps are named in the report\n' : '') +
    '\nThe full report is attached below. It opens with a paste-ready Client Summary for each question, naming the companies involved, and closes with a technical appendix giving the full evidence, its limits and its sources.'
  );
}

const createClientReportDoc: ToolDefinition = {
  name: 'create_client_report_doc',
  description:
    "Research Twin's Create_Client_Report_Doc (the same tool, moved off its Tools Router). Build the weekly deep-detail Markdown report for one watched client from its live question rows and upload it to #watched-clients (C0B9LKU7DQV) as a file, as the Research Twin bot. Pass ONLY client_name (the lane/client name as given in the prompt); the tool generates the body. Call once per lane, after every update_watched_client_question in the batch. An unknown client is ok:false client_not_found, naming the lanes it knows. Returns {ok, client_name, question_count, changed_count, open_gaps, file_title, file_id, permalink}; a refused upload is ok:false slack_upload_failed naming the step — never claim a file was delivered then.",
  inputSchema: {
    type: 'object',
    properties: {
      client_name: { type: 'string', description: 'The lane/client name exactly as given in the prompt.' },
      report_content: { type: 'string', description: 'Optional. Overrides the generated body; for older callers only.' },
      ...COMMON,
    },
    required: ['client_name'],
    additionalProperties: false,
  },
  annotations: { ...WRITE_ANNOTATIONS, title: 'Build and post a watched-client weekly report' },
  handler: (args, deps) =>
    audited('create_client_report_doc', args, deps, 'slack', async () => {
      const lanes = (await mirror.lookup('client_lanes', { filters: [], limit: 100, order: 'created_desc' })).rows;
      const lane = resolveLane(args.client_name, lanes);
      if (!lane.found) {
        return {
          outcome: 'refused',
          detail: `client_not_found ${str(lane.client_name)}${lane.unresolved_table ? ` (Questions Table "${str(lane.unresolved_table)}" not resolvable)` : ''}`,
          answer: {
            ok: false,
            reason: 'client_not_found',
            client_name: lane.client_name,
            message: "No watched-client lane matches that name in the Index, so there is nothing to build a report from. Ask which client they mean rather than inventing a report.",
            available: lane.available,
            ...(lane.unresolved_table ? { unresolved_table: lane.unresolved_table } : {}),
          },
        };
      }
      const questions = (await mirror.lookup('client_questions', { filters: [{ op: 'f', name: 'table_id', value: str(lane.questions_table) }], limit: 500, order: 'created_desc' })).rows;
      const now = new Date();
      const B = buildReport(lane, args, questions, now.toISOString().split('T')[0]);
      const content = str(B.report_content);
      const bytes = Buffer.from(content, 'utf8');
      const fileTitle = 'Weekly Watched Client Report — ' + str(B.client_name) + ' — ' + now.toISOString().split('T')[0];
      const summary = { client_name: B.client_name, generated_from_live_data: B.generated === true, question_count: B.question_count || 0, changed_count: B.changed_count || 0, open_gaps: B.digging_count || 0, file_title: fileTitle };
      if (isDry(args)) {
        return {
          outcome: 'dry_run',
          detail: `${fileTitle} (${bytes.length} bytes)`,
          natural_id: str(lane.lane_id) || null,
          answer: { ok: true, dry_run: true, written: false, ...summary, channel_id: REPORT_CHANNEL, length: bytes.length, initial_comment: reportComment(B), slack_configured: slack.researchTwinToken() !== null, report_preview: content },
        };
      }
      const tok = slack.researchTwinToken();
      if (!tok) {
        return { outcome: 'refused', detail: 'not configured', answer: { ok: false, reason: 'not_configured', ...summary, message: `${slack.RT_TOKEN_VAR} is not set on this server, so the report was built and not uploaded. Report this honestly -- do not claim a file was delivered.` } };
      }
      const fail = (step: string, error: string) => ({
        outcome: 'failed',
        detail: `${step}: ${error}`,
        natural_id: str(lane.lane_id) || null,
        answer: { ok: false, reason: 'slack_upload_failed', step, error, client_name: B.client_name, note: 'The report was generated but Slack refused the file upload. Report this honestly -- do not claim a file was delivered.' },
      });
      const g = await slack.botCall('files.getUploadURLExternal', { filename: `${fileTitle}.md`, length: bytes.length }, 'form', tok);
      const uploadUrl = typeof g.upload_url === 'string' ? g.upload_url : '';
      const fileId = typeof g.file_id === 'string' ? g.file_id : '';
      if (!g.ok || !uploadUrl || !fileId) return fail('files.getUploadURLExternal', g.error || 'no upload_url or file_id in the answer');
      const up = await slack.uploadBytes(uploadUrl, bytes, 'text/markdown');
      if (!up.ok) return fail('upload', up.error || `http_${up.status}`);
      const c = await slack.botCall('files.completeUploadExternal', { files: [{ id: fileId, title: fileTitle }], channel_id: REPORT_CHANNEL, initial_comment: reportComment(B) }, 'json', tok);
      if (!c.ok) return fail('files.completeUploadExternal', c.error || 'no confirmation from Slack');
      const done = Array.isArray(c.files) ? (c.files[0] as { permalink?: string } | undefined) : undefined;
      let permalink = done?.permalink ?? '';
      if (!permalink) {
        const info = await slack.botCall('files.info', { file: fileId }, 'form', tok);
        permalink = info.ok ? ((info.file as { permalink?: string } | undefined)?.permalink ?? '') : '';
      }
      return {
        outcome: 'applied',
        detail: `${fileTitle}.md (${bytes.length} bytes) → ${REPORT_CHANNEL} as ${fileId}`,
        natural_id: str(lane.lane_id) || null,
        answer: {
          ok: true,
          ...summary,
          file_id: fileId,
          permalink,
          note: 'The deep-detail markdown report has been uploaded to the watched-clients channel as a file. In your Slack summary, keep it SHORT -- a header, a divider, a few lines -- and point at the file for the detail. Do not restate the whole report.',
        },
      };
    }),
};

export const RESEARCH_TWIN_WRITE_TOOLS: ToolDefinition[] = [
  writeResearchFinding,
  writeCommercialCardFields,
  computeLaneState,
  queueFollowupResearch,
  updateWatchedClientQuestion,
  createClientReportDoc,
];
