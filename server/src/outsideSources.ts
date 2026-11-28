/**
 * BHA RSS tunes its own sources (19 Nov 2026, Destiny — Genie rebuild 8.8; Jason's DM of 17 Nov, 1794591186.043969).
 *
 * Each outside source gets a plain score from real use, no model in the loop:
 *   cited  = digest bullets in the last 30 days that link one of its items (BHA RSS counts these, it holds the items);
 *   used   = those links then found in a Media Twin draft, a Research Twin job or ask, a North Star ask or a Genie
 *            answer here, in the same 30 days (counted here, where those records live);
 *   score  = cited + 3 x used.
 * BHA RSS sends its sources once a day after the digest (`POST /api/engine/outside-sources/score`); this decides
 * each one's read interval from RULE and answers with the changes and any candidate a person approved. BHA RSS
 * applies them and confirms (`POST /api/engine/outside-sources/applied`). A change is stored when decided, and
 * marked applied only once BHA RSS says it is, so the page never shows a change that did not happen.
 *
 * Candidates: sites linked from at least RULE.candidate_min_items cited items that are not a source. They are
 * proposed only; a person approves (with the feed url and kind) or declines with `decide_rss_candidate`, and an
 * approved one joins BHA RSS's list on its next pass.
 */
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import { changed } from './events';

export class SourcesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The numbers live here and nowhere else. */
export const RULE = {
  window_days: 30,
  used_weight: 3,
  /** A source younger than this is left as it is: too new to judge (3 from 19 Nov 2026, Destiny; was 7). */
  new_days: 3,
  /** Read twice as often: score at least this and in the top quarter of scored sources. */
  top_min_score: 3,
  top_share: 0.25,
  faster_factor: 0.5,
  min_every_hours: 6,
  /** Read half as often: nothing cited or used once this many days of digests are held. */
  slower_after_days: 14,
  slower_factor: 2,
  max_every_hours: 72,
  /** Retired: nothing cited or used across a whole window of digests, for a source at least that old. */
  retire_after_days: 30,
  /** A site linked from this many cited items, not already a source, is proposed. */
  candidate_min_items: 3,
  candidates_per_pass: 10,
};

export interface SourceIn {
  id: string;
  kind: string;
  name?: string | null;
  url: string;
  active: boolean;
  every_hours: number;
  base_every_hours?: number | null;
  created_at: string;
  cited: number;
  cited_urls?: string[];
}

export type Action = 'faster' | 'slower' | 'base' | 'retire' | 'none';

export interface Decision {
  source_id: string;
  action: Action;
  from_hours: number;
  to_hours: number | null;
  reason: string;
}

const days = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 86_400_000;
/** Usage is matched on the link without its query string: Slack and the agents rewrite & and tracking tags. */
export const bare = (u: string) => String(u || '').split('#')[0].split('?')[0].replace(/\/+$/, '');

/** Pure: what each source's read interval should be. */
export function decide(sources: Array<SourceIn & { used: number }>, opts: { now: Date; history_days: number }): Decision[] {
  const scored = sources.filter((s) => s.active).map((s) => ({ s, score: s.cited + RULE.used_weight * s.used }));
  const positive = scored.map((x) => x.score).filter((n) => n > 0).sort((a, b) => b - a);
  const cut = positive.length ? positive[Math.max(0, Math.ceil(positive.length * RULE.top_share) - 1)] : Infinity;
  return scored.map(({ s, score }) => {
    const base = s.base_every_hours || s.every_hours;
    const age = days(opts.now, new Date(s.created_at));
    const at = (to: number, action: Action, reason: string): Decision =>
      to === s.every_hours ? { source_id: s.id, action: 'none', from_hours: s.every_hours, to_hours: null, reason } : { source_id: s.id, action, from_hours: s.every_hours, to_hours: to, reason };
    const tally = `cited ${s.cited}, used ${s.used}, score ${score} over ${Math.min(RULE.window_days, Math.floor(opts.history_days))} days of digests`;
    if (age < RULE.new_days) return { source_id: s.id, action: 'none', from_hours: s.every_hours, to_hours: null, reason: `new source (${Math.floor(age)} days): not judged yet; ${tally}` };
    if (score > 0 && score >= RULE.top_min_score && score >= cut) {
      return at(Math.max(RULE.min_every_hours, Math.round(base * RULE.faster_factor)), 'faster', `top quarter of sources by score: ${tally}`);
    }
    if (score === 0) {
      if (opts.history_days >= RULE.retire_after_days && age >= RULE.retire_after_days) {
        return { source_id: s.id, action: 'retire', from_hours: s.every_hours, to_hours: null, reason: `nothing cited or used in ${RULE.retire_after_days} days of digests: ${tally}` };
      }
      if (opts.history_days >= RULE.slower_after_days && age >= RULE.slower_after_days) {
        return at(Math.min(RULE.max_every_hours, Math.round(base * RULE.slower_factor)), 'slower', `nothing cited or used in ${Math.floor(opts.history_days)} days of digests: ${tally}`);
      }
      return at(base, 'base', `nothing cited or used yet, but only ${Math.floor(opts.history_days)} days of digests are held (read less after ${RULE.slower_after_days}): ${tally}`);
    }
    return at(base, 'base', `cited or used, not top quarter: ${tally}`);
  });
}

/** How many of the given links each table holds, in the window. One query per table, links matched bare. */
async function usage(urls: string[], since: string): Promise<Map<string, { n: number; where: Record<string, number> }>> {
  const out = new Map<string, { n: number; where: Record<string, number> }>();
  const list = [...new Set(urls.map(bare).filter((u) => u.length > 12))];
  if (!list.length) return out;
  const tables: Array<[string, string]> = [
    ['media_twin', `SELECT coalesce(sources::text,'') || coalesce(platforms::text,'') || coalesce(card::text,'') AS blob FROM engine_media_posts WHERE test IS NOT TRUE AND created_at >= $2`],
    ['research_twin_job', `SELECT fields::text AS blob FROM engine_rt_jobs WHERE first_seen_at >= $2`],
    ['research_twin_ask', `SELECT fields::text AS blob FROM engine_rt_asks WHERE first_seen_at >= $2`],
    ['north_star', `SELECT fields::text AS blob FROM engine_ns_asks WHERE first_seen_at >= $2`],
    ['genie', `SELECT payload::text AS blob FROM engine_genie_events WHERE occurred_at >= $2 AND event_type NOT LIKE 'genie.subagent.%'`],
  ];
  // Each record's links are pulled out once, made bare the way bare() does, and matched exactly.
  // Matching every link against every record's whole text took over two minutes by 28 Nov 2026
  // (1,650 links over 8.5 million characters), past BHA RSS's wait.
  for (const [where, sql] of tables) {
    const r = await query<{ u: string; n: string }>(
      `SELECT e.u, count(*)::text AS n FROM (
         SELECT DISTINCT t.rid, regexp_replace(split_part(split_part(m[1], '#', 1), '?', 1), '/+$', '') AS u
         FROM (SELECT row_number() OVER () AS rid, blob FROM (${sql}) x) t,
              regexp_matches(t.blob, '(https?://[^\\s"''<>\\\\)\\]]+)', 'g') m
       ) e WHERE e.u = ANY($1::text[]) GROUP BY e.u`,
      [list, since],
    );
    for (const row of r.rows) {
      const cur = out.get(row.u) ?? { n: 0, where: {} };
      cur.n += Number(row.n);
      cur.where[where] = (cur.where[where] ?? 0) + Number(row.n);
      out.set(row.u, cur);
    }
  }
  return out;
}

const str = (v: unknown, n = 500) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** POST /api/engine/outside-sources/score. */
export async function score(b: Record<string, unknown>, opts: { now?: Date } = {}): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const sources = Array.isArray(b.sources) ? (b.sources as SourceIn[]) : null;
  if (!sources || !sources.length) throw new SourcesError(422, 'Send sources: [{ id, kind, name, url, active, every_hours, base_every_hours, created_at, cited, cited_urls }].');
  for (const s of sources) if (!str(s.id, 80) || !str(s.url, 2000) || !Number.isFinite(Number(s.every_hours))) throw new SourcesError(422, `Every source needs id, url and every_hours (${JSON.stringify(s).slice(0, 120)}).`);
  const historyDays = Number(b.history_days);
  if (!Number.isFinite(historyDays) || historyDays < 0) throw new SourcesError(422, 'Send history_days: how many days of digests BHA RSS holds.');
  const tuneDate = str(b.tune_date, 10) || now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - RULE.window_days * 86_400_000).toISOString();

  const use = await usage(sources.flatMap((s) => s.cited_urls ?? []), since);
  const withUse = sources.map((s) => {
    const where: Record<string, number> = {};
    let used = 0;
    for (const u of new Set((s.cited_urls ?? []).map(bare))) {
      const hit = use.get(u);
      if (!hit) continue;
      used += hit.n;
      for (const [k, v] of Object.entries(hit.where)) where[k] = (where[k] ?? 0) + v;
    }
    return { ...s, cited: Number(s.cited) || 0, used, where };
  });
  const decisions = decide(withUse, { now, history_days: historyDays });
  const byId = new Map(decisions.map((d) => [d.source_id, d]));
  const candidates = Array.isArray(b.candidates) ? (b.candidates as Array<Record<string, unknown>>) : [];

  if (b.dry_run === true) return { ok: true, dry_run: true, tune_date: tuneDate, decisions: decisions.filter((d) => d.action !== 'none'), candidates: candidates.length };

  const changes: Array<Record<string, unknown>> = [];
  await withTransaction(async (c) => {
    for (const s of withUse) {
      const d = byId.get(s.id);
      await c.query(
        `INSERT INTO engine_rss_sources (source_id, kind, name, url, active, every_hours, base_every_hours, created_at, cited, used, score, used_where, decision, reason, tune_date, scored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
         ON CONFLICT (source_id) DO UPDATE SET kind=$2, name=$3, url=$4, active=$5, every_hours=$6, base_every_hours=$7, created_at=$8,
           cited=$9, used=$10, score=$11, used_where=$12, decision=$13, reason=$14, tune_date=$15, scored_at=now()`,
        [s.id, str(s.kind, 20), str(s.name ?? '', 300) || null, str(s.url, 2000), s.active === true, Number(s.every_hours), Number(s.base_every_hours) || Number(s.every_hours), s.created_at,
          s.cited, s.used, s.cited + RULE.used_weight * s.used, JSON.stringify(s.where), d?.action ?? 'none', d?.reason ?? 'inactive at BHA RSS', tuneDate],
      );
      if (d && d.action !== 'none') {
        const r = await c.query<{ change_id: string; applied_at: string | null }>(
          `INSERT INTO engine_rss_source_changes (change_id, source_id, tune_date, action, from_hours, to_hours, reason, score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (source_id, tune_date) DO UPDATE SET action = EXCLUDED.action, to_hours = EXCLUDED.to_hours, reason = EXCLUDED.reason, score = EXCLUDED.score
             WHERE engine_rss_source_changes.applied_at IS NULL
           RETURNING change_id, applied_at`,
          [`RSC-${tuneDate}-${s.id}`, s.id, tuneDate, d.action, d.from_hours, d.to_hours, d.reason, s.cited + RULE.used_weight * s.used],
        );
        if (r.rows[0] && !r.rows[0].applied_at) changes.push({ change_id: r.rows[0].change_id, source_id: s.id, action: d.action, every_hours: d.to_hours, reason: d.reason });
      }
    }
    for (const cand of candidates.slice(0, RULE.candidates_per_pass * 3)) {
      const host = str(cand.host, 200).toLowerCase();
      const evidence = Array.isArray(cand.evidence) ? (cand.evidence as unknown[]).map((u) => str(u, 2000)).filter(Boolean).slice(0, 10) : [];
      if (!host || evidence.length < RULE.candidate_min_items) continue;
      await c.query(
        `INSERT INTO engine_rss_candidates (candidate_id, host, evidence, status, proposed_at, seen_at)
         VALUES ($1,$2,$3,'proposed',now(),now())
         ON CONFLICT (host) DO UPDATE SET evidence = EXCLUDED.evidence, seen_at = now()`,
        [`RSCAND-${host.replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, host, JSON.stringify(evidence)],
      );
    }
  });
  const approved = await query<{ candidate_id: string; kind: string; feed_url: string; name: string | null }>(
    `SELECT candidate_id, kind, feed_url, name FROM engine_rss_candidates WHERE status = 'approved' AND added_source_id IS NULL ORDER BY decided_at`,
  );
  const counts = decisions.reduce<Record<string, number>>((m, d) => ((m[d.action] = (m[d.action] ?? 0) + 1), m), {});
  await record({ event_type: 'rss_sources_scored', subject_id: tuneDate, lane: 'GENIE', actor: 'bha-rss', source_ref: 'bha-rss', dedupe_key: `rss_sources_scored:${tuneDate}`, detail: { counts, changes: changes.length, history_days: historyDays, approved: approved.rows.length } });
  changed('outside_sources');
  return { ok: true, tune_date: tuneDate, scored: withUse.length, counts, changes, approved: approved.rows, inserted: withUse.length, updated: 0 };
}

/** POST /api/engine/outside-sources/applied: what BHA RSS really did. */
export async function applied(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ids = Array.isArray(b.applied) ? (b.applied as unknown[]).map((v) => str(v, 80)).filter(Boolean) : [];
  const failed = Array.isArray(b.failed) ? (b.failed as Array<Record<string, unknown>>) : [];
  const added = Array.isArray(b.added) ? (b.added as Array<Record<string, unknown>>) : [];
  let marked = 0;
  if (ids.length) marked = (await query(`UPDATE engine_rss_source_changes SET applied_at = now(), error = NULL WHERE change_id = ANY($1) AND applied_at IS NULL`, [ids])).rowCount ?? 0;
  for (const f of failed) await query(`UPDATE engine_rss_source_changes SET error = $2 WHERE change_id = $1 AND applied_at IS NULL`, [str(f.id, 80), str(f.error, 500) || 'not applied, no reason given']);
  let joined = 0;
  for (const a of added) {
    const r = await query(`UPDATE engine_rss_candidates SET added_source_id = $2, added_at = now() WHERE candidate_id = $1 AND status = 'approved' AND added_source_id IS NULL`, [str(a.candidate_id, 120), str(a.source_id, 80)]);
    joined += r.rowCount ?? 0;
  }
  if (marked || joined || failed.length) {
    await record({ event_type: 'rss_sources_tuned', subject_id: str(b.tune_date, 10) || new Date().toISOString().slice(0, 10), lane: 'GENIE', actor: 'bha-rss', source_ref: 'bha-rss', detail: { applied: marked, failed: failed.length, added: joined } });
    changed('outside_sources');
  }
  return { ok: true, applied: marked, failed: failed.length, added: joined, inserted: 0, updated: marked + joined };
}

const DECIDERS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const KINDS = new Set(['rss', 'youtube', 'linkedin', 'web']);

/** decide_rss_candidate: a person approves (with the feed url and kind) or declines a proposed source. */
export async function decideCandidate(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = str(b.candidate_id, 120);
  const by = str(b.decided_by, 20);
  const decision = str(b.decision, 10);
  if (!DECIDERS.has(by)) throw new SourcesError(403, 'Only Destiny or Jason decide a candidate source (decided_by, a Slack id).');
  if (decision !== 'approve' && decision !== 'decline') throw new SourcesError(422, 'decision is approve or decline.');
  const held = await query<{ status: string; host: string }>(`SELECT status, host FROM engine_rss_candidates WHERE candidate_id = $1`, [id]);
  if (!held.rows[0]) throw new SourcesError(404, `No candidate ${id}.`);
  if (held.rows[0].status !== 'proposed') throw new SourcesError(409, `${id} is already ${held.rows[0].status}.`);
  const reason = str(b.reason, 1000);
  if (decision === 'decline' && reason.length < 3) throw new SourcesError(422, 'A decline needs a reason.');
  let kind: string | null = null;
  let feed: string | null = null;
  if (decision === 'approve') {
    kind = str(b.kind, 20);
    feed = str(b.feed_url, 2000);
    if (!KINDS.has(kind)) throw new SourcesError(422, 'kind is rss, youtube, linkedin or web.');
    if (!/^https:\/\//.test(feed)) throw new SourcesError(422, 'feed_url: the https address BHA RSS should read (the feed, channel or profile).');
  }
  if (b.dry_run === true) return { ok: true, dry_run: true, candidate_id: id, host: held.rows[0].host, decision, kind, feed_url: feed };
  await query(
    `UPDATE engine_rss_candidates SET status = $2, kind = $3, feed_url = $4, name = $5, decided_by = $6, decided_at = now(), reason = $7 WHERE candidate_id = $1 AND status = 'proposed'`,
    [id, decision === 'approve' ? 'approved' : 'declined', kind, feed, str(b.name, 300) || null, by, reason || null],
  );
  await record({ event_type: 'rss_candidate_decided', subject_id: id, lane: 'GENIE', actor: by, source_ref: 'dashboard', detail: { decision, host: held.rows[0].host, kind, feed_url: feed, reason } });
  changed('outside_sources');
  return { ok: true, candidate_id: id, status: decision === 'approve' ? 'approved' : 'declined', note: decision === 'approve' ? 'BHA RSS adds it on its next daily tune pass.' : 'It will not be proposed again.' };
}

/** The Genie page's Sources tab. */
export async function page(): Promise<Record<string, unknown>> {
  const [sources, changes, candidates] = await Promise.all([
    query(`SELECT source_id, kind, name, url, active, every_hours, base_every_hours, cited, used, score, used_where, decision, reason, tune_date::text, scored_at FROM engine_rss_sources ORDER BY active DESC, score DESC, kind, name`),
    query(`SELECT change_id, source_id, tune_date::text, action, from_hours, to_hours, reason, score, created_at, applied_at, error FROM engine_rss_source_changes ORDER BY created_at DESC LIMIT 200`),
    query(`SELECT candidate_id, host, evidence, status, kind, feed_url, name, decided_by, decided_at, reason, added_source_id, added_at, proposed_at, seen_at FROM engine_rss_candidates ORDER BY (status = 'proposed') DESC, seen_at DESC LIMIT 100`),
  ]);
  return { rule: RULE, sources: sources.rows, changes: changes.rows, candidates: candidates.rows };
}
