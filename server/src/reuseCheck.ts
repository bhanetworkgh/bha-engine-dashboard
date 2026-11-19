/**
 * The reuse check (19 Nov 2026, Destiny — Genie rebuild 10.10; design note "Architecture over labor", Jason's go).
 * Before work counts as net-new it is checked against what BHA already has, cheapest first:
 *   1. exact ids the work names (LOOP-, BP-, CAND-, TASK-, CODEX-);
 *   2. word overlap (writeGuards.compare, the loop duplicate check's own scoring) against build patterns, open
 *      pattern candidates, open loops and the lane backlog;
 *   3. only when 1 and 2 find nothing: word overlap against approved Codex logs of the last 90 days.
 * It answers matches and three choices (reuse, extend, go ahead with a reason); it never blocks, never holds pay
 * and never decides for anyone. A check that could not run says so (`ran: false` with the reason), never "no match".
 * Every pattern it shows is one `shown` line in the pattern trust record (patternTrust.ts), so a pattern's
 * downs are always read against how often it was offered. Matches are ordered by score, then trust.
 */
import { query } from './pg';
import { compare, tokens } from './writeGuards';
import * as trust from './patternTrust';

type Row = Record<string, unknown>;
export type MatchKind = 'pattern' | 'candidate' | 'loop' | 'backlog' | 'codex';
export interface Match { kind: MatchKind; id: string; title: string; score: number; shared: number; how: 'id' | 'words'; status?: string; trust?: number }
export interface Verdict {
  ok: true;
  ran: boolean;
  reason?: string;
  matches: Match[];
  steps: string[];
  choices: ['reuse', 'extend', 'go_ahead'];
  summary: string;
}

/** The bar a word match must clear, in either direction (the work inside an existing record, or the record inside the work). */
export const RULE = { min_score: 0.5, min_shared: 4, strong_score: 0.7, max_matches: 5, codex_days: 90 } as const;

const IDS = /\b(LOOP-\d{10,}-[A-Z0-9]{4}|BP-[A-Z0-9]+(?:-[A-Z0-9]+)*|CAND-\d{10,}-[A-Z0-9]{4}|TASK-[A-Z0-9-]{4,}|CODEX-\d{8}-[a-z0-9-]+)\b/g;
const s = (v: unknown, n = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Pure: does an existing record's text match the work? The higher of the two containments, with the shared-word floor. */
export function judge(work: string, existing: string): { score: number; shared: number; hit: boolean } {
  const a = compare(work, existing);
  const b = compare(existing, work);
  const best = a.score >= b.score ? a : b;
  const shared = Math.max(a.shared, b.shared);
  const hit = tokens(existing).size >= 3 && best.score >= RULE.min_score && (shared >= RULE.min_shared || best.score >= RULE.strong_score);
  return { score: best.score, shared, hit };
}

export function idsIn(text: string): string[] {
  return [...new Set(String(text || '').match(IDS) || [])].slice(0, 20);
}

async function byIds(ids: string[]): Promise<Match[]> {
  if (!ids.length) return [];
  const out: Match[] = [];
  const pick = (kind: MatchKind, id: string, title: unknown, status?: unknown) => out.push({ kind, id, title: s(title, 200) || id, score: 1, shared: 0, how: 'id', status: s(status, 40) || undefined });
  const p = await query<Row>(`SELECT natural_id, fields->>'pattern_name' t FROM engine_build_patterns WHERE natural_id = ANY($1)`, [ids]);
  p.rows.forEach((r) => pick('pattern', String(r.natural_id), r.t));
  const l = await query<Row>(`SELECT DISTINCT ON (natural_id) natural_id, fields->>'What' t, fields->>'Status' st FROM engine_loops WHERE natural_id = ANY($1) ORDER BY natural_id, updated_at DESC`, [ids]);
  l.rows.forEach((r) => pick('loop', String(r.natural_id), r.t, r.st));
  const c = await query<Row>(`SELECT natural_id, fields->>'Candidate' t, fields->>'Status' st FROM engine_pattern_candidates WHERE natural_id = ANY($1)`, [ids]);
  c.rows.forEach((r) => pick('candidate', String(r.natural_id), r.t, r.st));
  const b = await query<Row>(`SELECT natural_id, fields->>'task' t, fields->>'status' st FROM engine_lane_backlog WHERE natural_id = ANY($1)`, [ids]);
  b.rows.forEach((r) => pick('backlog', String(r.natural_id), r.t, r.st));
  const x = await query<Row>(`SELECT fields->>'Codex Entry ID' id, fields->>'Session Description' t FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = ANY($1)`, [ids]);
  x.rows.forEach((r) => pick('codex', String(r.id), r.t));
  return out;
}

async function byWords(work: string): Promise<Match[]> {
  const out: Match[] = [];
  const add = (kind: MatchKind, id: unknown, title: unknown, text: string, status?: unknown) => {
    const j = judge(work, text);
    if (j.hit && id) out.push({ kind, id: String(id), title: s(title, 200), score: j.score, shared: j.shared, how: 'words', status: s(status, 40) || undefined });
  };
  const p = await query<Row>(`SELECT natural_id, fields->>'pattern_name' n, fields->>'problem' pr FROM engine_build_patterns WHERE COALESCE(fields->>'Retired','') = ''`);
  for (const r of p.rows) add('pattern', r.natural_id, r.n, `${s(r.n)} ${s(r.pr, 600)}`);
  const c = await query<Row>(`SELECT natural_id, fields->>'Candidate' n, fields->>'Summary' sm, fields->>'Status' st FROM engine_pattern_candidates WHERE fields->>'Status' IN ('Proposed','Approved')`);
  for (const r of c.rows) add('candidate', r.natural_id, r.n, `${s(r.n)} ${s(r.sm, 600)}`, r.st);
  const l = await query<Row>(`SELECT DISTINCT ON (natural_id) natural_id, fields->>'What' w, fields->>'Status' st FROM engine_loops WHERE natural_id IS NOT NULL ORDER BY natural_id, updated_at DESC`);
  for (const r of l.rows) if (r.st === 'Open' || r.st === 'In Progress') add('loop', r.natural_id, r.w, s(r.w, 600), r.st);
  const b = await query<Row>(`SELECT natural_id, fields->>'task' t, fields->>'spec' sp, fields->>'status' st FROM engine_lane_backlog`);
  for (const r of b.rows) add('backlog', r.natural_id, r.t, `${s(r.t)} ${s(r.sp, 600)}`, r.st);
  return out;
}

async function byCodex(work: string, excludeSubmission: string): Promise<Match[]> {
  const r = await query<Row>(
    `SELECT fields->>'Codex Entry ID' id, fields->>'Submission ID' sid, fields->>'Session Description' d, fields->>'Summary' sm
       FROM engine_codex_submissions
      WHERE fields->>'Jason Status' IN ('Approved','Input Added') AND COALESCE(fields->>'Codex Entry ID','') <> ''
        AND updated_at > now() - ($1 || ' days')::interval`,
    [String(RULE.codex_days)],
  );
  const out: Match[] = [];
  for (const row of r.rows) {
    if (excludeSubmission && row.sid === excludeSubmission) continue;
    const j = judge(work, `${s(row.d)} ${s(row.sm, 800)}`);
    if (j.hit) out.push({ kind: 'codex', id: String(row.id), title: s(row.d, 200), score: j.score, shared: j.shared, how: 'words' });
  }
  return out;
}

export function summarise(matches: Match[], ran: boolean, reason?: string): string {
  if (!ran) return `Reuse check did not run: ${reason || 'no reason given'}.`;
  if (!matches.length) return 'Reuse check: nothing on record matches this work.';
  const top = matches.slice(0, 3).map((m) => `${m.id} (${m.kind}${m.how === 'id' ? ', named' : `, ${Math.round(m.score * 100)}%`}) ${m.title}`.trim());
  return `Reuse check: this work matches ${matches.length === 1 ? 'an existing record' : `${matches.length} existing records`}: ${top.join('; ')}. Reuse it, extend it, or go ahead with a reason.`;
}

/**
 * Runs the check on `text` (what the work is: a Genie plan's goal and change, or a log's description and summary).
 * `source_ref` names what was checked (a GAP- id, a Submission ID) and is put on each `shown` line.
 */
export async function check(b: Row): Promise<Verdict> {
  const text = s(b.text, 6000);
  const steps: string[] = [];
  const choices: Verdict['choices'] = ['reuse', 'extend', 'go_ahead'];
  if (tokens(text).size < 3) {
    return { ok: true, ran: false, reason: 'there is too little text to check', matches: [], steps, choices, summary: summarise([], false, 'there is too little text to check') };
  }
  try {
    const seen = new Map<string, Match>();
    const keep = (m: Match) => {
      const k = `${m.kind}:${m.id}`;
      const had = seen.get(k);
      if (!had || m.score > had.score) seen.set(k, m);
    };
    const ids = idsIn(text);
    (await byIds(ids)).forEach(keep);
    steps.push(`ids: ${ids.length} named, ${seen.size} found`);
    const before = seen.size;
    (await byWords(text)).forEach(keep);
    steps.push(`words: ${seen.size - before} matched over patterns, candidates, open loops and the backlog`);
    if (!seen.size) {
      (await byCodex(text, s(b.exclude_submission_id, 80))).forEach(keep);
      steps.push(`codex: ${seen.size} matched over approved logs of the last ${RULE.codex_days} days`);
    }
    const scores = await trust.scores([...seen.values()].filter((m) => m.kind === 'pattern').map((m) => m.id));
    const matches = [...seen.values()]
      .map((m) => (m.kind === 'pattern' ? { ...m, trust: scores.get(m.id)?.score ?? 0 } : m))
      .sort((x, y) => (x.how === 'id' ? -1 : 0) - (y.how === 'id' ? -1 : 0) || y.score - x.score || (y.trust ?? 0) - (x.trust ?? 0))
      .slice(0, RULE.max_matches);
    await trust.recordShown(matches.filter((m) => m.kind === 'pattern').map((m) => m.id), s(b.source_ref, 80) || 'reuse-check', s(b.thread, 80) || null);
    return { ok: true, ran: true, matches, steps, choices, summary: summarise(matches, true) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: true, ran: false, reason, matches: [], steps, choices, summary: summarise([], false, reason) };
  }
}
