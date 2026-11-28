/**
 * VFARM_CONFIDENCE_SCORING_V0 (28 Nov 2026, Destiny — LOOP-1795071778245-XHRR,
 * DW-1795072716093-1X6Y; Jason's SOP 8994d8d1: "no vFarm actuation, no 'pilot ready'
 * path wired to cards, until there is a server-side confidence contract with explicit
 * bands and gates, and it's backfilled across the backlog").
 *
 * A commercial card's confidence is counted from what is recorded on the card, never
 * from the model-written `confidence` label (High / Medium / Low), which is kept as
 * history and read by nothing here. Pure: no database, no network.
 *
 * The numbers live in RULE and nowhere else. They are v0, Destiny's proposal, and are
 * Jason's to tune: a change is an edit to RULE, a new `version`, and a BUILD_LOG line.
 */

export const RULE = {
  version: 'VFARM_CONFIDENCE_SCORING_V0',
  sop: '8994d8d1-6bb6-46cb-b6c2-f8255eb15ca6',
  /** Each distinct citation ([S1], [S2] …) in a research pass: 5 points, at most 40 in all. */
  citation_points: 5,
  citation_max: 40,
  /** Each separate research pass (a dated entry in research_gleanings): 10, at most 20. */
  pass_points: 10,
  pass_max: 20,
  /** A recorded experiment result (experiment_results not empty): 30. */
  experiment_points: 30,
  /** Each separate builder log the card came from (source_logs): 5, at most 10. */
  log_points: 5,
  log_max: 10,
  /** Each open research question: minus 10. */
  open_question_penalty: 10,
  /** Bands: Low under 40, Medium 40 to 69, High 70 and up. */
  medium_from: 40,
  high_from: 70,
} as const;

export type Band = 'Low' | 'Medium' | 'High';
export type Action = 'pilot' | 'actuation';

export interface Part {
  part: 'citations' | 'research_passes' | 'experiment_result' | 'builder_logs' | 'open_questions';
  count: number;
  points: number;
  why: string;
}

export interface Confidence {
  version: string;
  score: number;
  band: Band;
  parts: Part[];
  open_questions: number;
  has_experiment_result: boolean;
  model_label: string | null;
  note: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A research pass starts with an ISO timestamp in square brackets, as write_research_finding stamps it. */
const PASS_START = /\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/g;

/** The research passes in research_gleanings, each with its distinct [S#] citations. */
export function passes(gleanings: string): Array<{ at: string; citations: number }> {
  const text = str(gleanings);
  if (!text.trim()) return [];
  const starts = [...text.matchAll(PASS_START)].map((m) => ({ at: m[1], index: m.index ?? 0 }));
  const chunks = starts.length
    ? starts.map((s, i) => ({ at: s.at, text: text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length) }))
    : [{ at: '', text }]; // text with no stamp is one undated pass
  return chunks.map((c) => ({ at: c.at, citations: new Set([...c.text.matchAll(/\[S(\d+)\]/g)].map((m) => m[1])).size }));
}

/** Separate builder logs named in source_logs ("Name · Title", one per line or separated by ";"). */
export function builderLogs(sourceLogs: unknown): number {
  const text = str(sourceLogs);
  return new Set(text.split(/\n|;/).map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
}

/** The card's open research questions, the rule sources.ts uses for every figure that counts them. */
export function openQuestions(fields: Record<string, unknown>): number {
  const count = num(fields.missing_research_count);
  const listed = str(fields.missing_research_questions).split('|').map((q) => q.trim()).filter(Boolean).length;
  if (count !== null && count > 0) return count;
  return listed || 0;
}

export function score(fields: Record<string, unknown>): Confidence {
  const ps = passes(str(fields.research_gleanings));
  const citations = ps.reduce((a, p) => a + p.citations, 0);
  const logs = builderLogs(fields.source_logs);
  const experiment = str(fields.experiment_results).trim().length > 0;
  const open = openQuestions(fields);
  const parts: Part[] = [
    { part: 'citations', count: citations, points: Math.min(RULE.citation_max, citations * RULE.citation_points), why: `${citations} distinct citation(s) across ${ps.length} research pass(es), ${RULE.citation_points} each, at most ${RULE.citation_max}` },
    { part: 'research_passes', count: ps.length, points: Math.min(RULE.pass_max, ps.length * RULE.pass_points), why: `${ps.length} research pass(es), ${RULE.pass_points} each, at most ${RULE.pass_max}` },
    { part: 'experiment_result', count: experiment ? 1 : 0, points: experiment ? RULE.experiment_points : 0, why: experiment ? 'a recorded experiment result' : 'no experiment result recorded' },
    { part: 'builder_logs', count: logs, points: Math.min(RULE.log_max, logs * RULE.log_points), why: `${logs} builder log(s), ${RULE.log_points} each, at most ${RULE.log_max}` },
    { part: 'open_questions', count: open, points: -open * RULE.open_question_penalty, why: `${open} open research question(s), minus ${RULE.open_question_penalty} each` },
  ];
  const raw = parts.reduce((a, p) => a + p.points, 0);
  const s = Math.max(0, Math.min(100, raw));
  const band: Band = s >= RULE.high_from ? 'High' : s >= RULE.medium_from ? 'Medium' : 'Low';
  return {
    version: RULE.version,
    score: s,
    band,
    parts,
    open_questions: open,
    has_experiment_result: experiment,
    model_label: str(fields.confidence) || null,
    note: `Counted from what is recorded on the card (SOP ${RULE.sop}); the model-written confidence label is not an input.`,
  };
}

/** Whether a card may be used for an action, and if not, exactly what is missing. */
export function gate(fields: Record<string, unknown>, action: Action): { allowed: boolean; action: Action; band: Band; score: number; missing: string[] } {
  const c = score(fields);
  const missing: string[] = [];
  if (c.band !== 'High') missing.push(`band is ${c.band} (score ${c.score}); ${action === 'pilot' ? 'a pilot' : 'actuation'} needs High (${RULE.high_from} or more)`);
  if (action === 'pilot' && c.open_questions > 0) missing.push(`${c.open_questions} open research question(s); a pilot needs none`);
  if (action === 'actuation' && !c.has_experiment_result) missing.push('no recorded experiment result; actuation needs one');
  return { allowed: missing.length === 0, action, band: c.band, score: c.score, missing };
}

/** Pilot states a card can only enter through the gate. */
export const PILOT_LANE_STATES = ['pilot_running'];
export const PILOT_STATES = ['pilot_live'];

/** The gated action a commercial write would start, or null. */
export function gatedAction(fields: Record<string, unknown>): Action | null {
  if (PILOT_LANE_STATES.includes(str(fields.lane_state)) || PILOT_STATES.includes(str(fields.pilot_state))) return 'pilot';
  return null;
}

/** The field the score is stored under on the card (a new field name; nothing renamed). */
export const FIELD = 'Confidence Score';
export const BAND_FIELD = 'Confidence Band';

/** The card's fields with the score attached, for a write. */
export function annotate(fields: Record<string, unknown>): Record<string, unknown> {
  const c = score(fields);
  return { ...fields, [FIELD]: c, [BAND_FIELD]: c.band };
}

/**
 * Backfill: every card's stored score brought in line with RULE. Runs once at every
 * boot and on POST /api/engine/confidence/backfill. A card whose stored score already
 * matches is left alone, so a second run changes nothing. Never touches any other field.
 */
export async function backfill(deps: {
  rows: () => Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
  patch: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ checked: number; updated: number; unchanged: number; bands: Record<Band, number>; failed: Array<{ id: string; error: string }> }> {
  const rows = await deps.rows();
  const out = { checked: 0, updated: 0, unchanged: 0, bands: { Low: 0, Medium: 0, High: 0 } as Record<Band, number>, failed: [] as Array<{ id: string; error: string }> };
  for (const r of rows) {
    out.checked += 1;
    const c = score(r.fields);
    out.bands[c.band] += 1;
    if (JSON.stringify(r.fields[FIELD] ?? null) === JSON.stringify(c) && r.fields[BAND_FIELD] === c.band) {
      out.unchanged += 1;
      continue;
    }
    try {
      await deps.patch(r.id, { [FIELD]: c, [BAND_FIELD]: c.band });
      out.updated += 1;
    } catch (e) {
      out.failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
