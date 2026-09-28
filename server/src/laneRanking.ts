/**
 * North Star's weighted lane ranking (28 Sep 2026, Destiny and Jason,
 * #bha-north-star-twin 1790611246.825499). Fixed weights, code doing the maths,
 * so the same question always gives the same order.
 *
 * Six factors, each scored 0 to 5, weighted to a total of 100:
 *
 *   gates the Oct 31 launch       25   tag (no launch dependency graph exists yet)
 *   blocks other people's work    20   tag (nothing records which lane waits on which)
 *   engine leverage               20   tag (Jason: "tagged by us")
 *   commercial impact             15   commercial lanes: read from their cards;
 *                                      work lanes: tag
 *   days since it last moved      10   computed: newest loop / card / job touch
 *   effort to close               10   the owner's small / medium / large
 *
 * **The weights live here and nowhere else.** A tag nobody has set scores 0 and
 * is named in `missing` — never a guess — so an incomplete lane can be seen as
 * incomplete rather than as unimportant. Ties break on the lane id, so the
 * order is total and repeatable.
 *
 * Two kinds of lane, ranked separately by default because their factors come
 * from different places: the ten work lanes loops carry (plus any profile row
 * of kind work), and the commercial LANE-… ids cards and research jobs carry.
 */
import { query } from './pg';
import { LANES } from './writeGuards';

export const WEIGHTS = {
  gates_oct31: 25,
  blocks_others: 20,
  engine_leverage: 20,
  commercial_impact: 15,
  days_since_moved: 10,
  effort: 10,
} as const;
export type Factor = keyof typeof WEIGHTS;

export const DEFINITIONS: Record<Factor, string> = {
  gates_oct31: 'How directly finishing this lane gates the Oct 31 launch. 0 not at all, 5 the launch cannot happen without it. A tag, until a launch dependency graph exists.',
  blocks_others: 'How much other people’s work waits on this lane. 0 nobody, 5 several builders stalled. A tag, until lanes record what they wait on.',
  engine_leverage: 'How much closing this lane improves or unlocks automation, or stabilises infra everything depends on. 0 none, 5 core. A tag set by us.',
  commercial_impact: 'Commercial lanes: from their cards — confidence High 4, Medium 3, Low 2, plus 1 when readiness is Media-Ready or Outbound-Ready. Work lanes: a tag. A tag set on a commercial lane overrides the cards.',
  days_since_moved: 'Days since anything in the lane last changed (a loop for a work lane, a card or research job for a commercial lane), a third of a point per day, capped at 5 after 15 days. Stale ranks higher, so nothing stagnates. A work lane with no open loops scores 0.',
  effort: 'The owner’s estimate to close: small 5, medium 3, large 1 — less effort ranks higher.',
};

const EFFORT_SCORE: Record<string, number> = { small: 5, medium: 3, large: 1 };

export interface LaneInputs {
  lane_id: string;
  kind: 'work' | 'commercial';
  gates_oct31: number | null;
  blocks_others: number | null;
  engine_leverage: number | null;
  commercial_tag: number | null;
  commercial_from_cards: number | null;
  effort: string | null;
  last_moved: string | null;
  open_items: number;
  anchors: string[];
  note: string | null;
  has_profile: boolean;
}

export interface RankedLane {
  rank: number;
  lane_id: string;
  kind: 'work' | 'commercial';
  score: number;
  factors: Record<Factor, number | null>;
  contributions: Record<Factor, number>;
  missing: Factor[];
  sources: Partial<Record<Factor, string>>;
  days_since_moved: number | null;
  last_moved: string | null;
  open_items: number;
  anchors: string[];
  note: string | null;
}

/** Card confidence and readiness to a 0–5 commercial score, or null when neither says anything. */
export function commercialFromCard(confidence: string | null, readiness: string | null): number | null {
  const c = String(confidence ?? '').trim().toLowerCase();
  const base = c === 'high' ? 4 : c === 'medium' ? 3 : c === 'low' ? 2 : null;
  if (base === null) return null;
  const r = String(readiness ?? '').trim().toLowerCase();
  return Math.min(5, base + (r === 'media-ready' || r === 'outbound-ready' ? 1 : 0));
}

/** Pure: one lane's factor scores, weighted total and what was missing. */
export function scoreLane(l: LaneInputs, now: Date): Omit<RankedLane, 'rank'> {
  const missing: Factor[] = [];
  const sources: Partial<Record<Factor, string>> = {};
  const tag = (f: Factor, v: number | null) => {
    if (v === null || v === undefined) {
      missing.push(f);
      return null;
    }
    sources[f] = 'tag';
    return v;
  };

  const gates = tag('gates_oct31', l.gates_oct31);
  const blocks = tag('blocks_others', l.blocks_others);
  const leverage = tag('engine_leverage', l.engine_leverage);

  let commercial: number | null;
  if (l.commercial_tag !== null) {
    commercial = l.commercial_tag;
    sources.commercial_impact = 'tag';
  } else if (l.kind === 'commercial' && l.commercial_from_cards !== null) {
    commercial = l.commercial_from_cards;
    sources.commercial_impact = 'cards';
  } else {
    commercial = null;
    missing.push('commercial_impact');
  }

  let days: number | null = null;
  let stale: number | null;
  if (l.last_moved) {
    days = Math.max(0, (now.getTime() - Date.parse(l.last_moved)) / 86_400_000);
    days = Math.round(days * 10) / 10;
  }
  if (l.kind === 'work' && l.open_items === 0 && l.last_moved) {
    stale = 0;
    sources.days_since_moved = 'no open loops';
  } else if (days !== null) {
    stale = Math.min(5, Math.round((days / 3) * 10) / 10);
    sources.days_since_moved = 'computed';
  } else {
    stale = null;
    missing.push('days_since_moved');
  }

  let effort: number | null = null;
  if (l.effort && EFFORT_SCORE[l.effort] !== undefined) {
    effort = EFFORT_SCORE[l.effort];
    sources.effort = `tag (${l.effort})`;
  } else missing.push('effort');

  const factors: Record<Factor, number | null> = {
    gates_oct31: gates,
    blocks_others: blocks,
    engine_leverage: leverage,
    commercial_impact: commercial,
    days_since_moved: stale,
    effort,
  };
  const contributions = {} as Record<Factor, number>;
  let score = 0;
  for (const f of Object.keys(WEIGHTS) as Factor[]) {
    const c = ((factors[f] ?? 0) / 5) * WEIGHTS[f];
    contributions[f] = Math.round(c * 10) / 10;
    score += c;
  }
  return {
    lane_id: l.lane_id,
    kind: l.kind,
    score: Math.round(score * 10) / 10,
    factors,
    contributions,
    missing,
    sources,
    days_since_moved: days,
    last_moved: l.last_moved,
    open_items: l.open_items,
    anchors: l.anchors,
    note: l.note,
  };
}

/** Pure: score every lane and order them — score descending, then lane id. */
export function rank(lanes: LaneInputs[], now: Date): RankedLane[] {
  return lanes
    .map((l) => scoreLane(l, now))
    .sort((a, b) => b.score - a.score || (a.lane_id < b.lane_id ? -1 : a.lane_id > b.lane_id ? 1 : 0))
    .map((l, i) => ({ rank: i + 1, ...l }));
}

interface ProfileRow {
  lane_id: string;
  kind: 'work' | 'commercial';
  gates_oct31: number | null;
  blocks_others: number | null;
  engine_leverage: number | null;
  commercial_impact: number | null;
  effort: string | null;
  anchors: string[] | null;
  note: string | null;
}

/** Reads every lane's inputs from the database. */
export async function readInputs(): Promise<LaneInputs[]> {
  const profiles = (
    await query<ProfileRow>(
      `SELECT lane_id, kind, gates_oct31, blocks_others, engine_leverage, commercial_impact, effort, anchors, note FROM engine_lane_profiles`,
    )
  ).rows;
  const byId = new Map(profiles.map((p) => [p.lane_id, p]));

  const work = (
    await query<{ lane: string; open: string; last: string | null }>(
      `SELECT fields->>'lane_tag' AS lane,
              count(*) FILTER (WHERE fields->>'Status' IN ('Open', 'In Progress'))::text AS open,
              max(updated_at) AS last
         FROM engine_loops WHERE coalesce(fields->>'lane_tag', '') <> '' GROUP BY 1`,
    )
  ).rows;
  const workById = new Map(work.map((w) => [w.lane, w]));

  const cards = (
    await query<{ lane: string; n: string; last: string | null; best: number | null }>(
      `SELECT lane_id AS lane, count(*)::text AS n, max(updated_at) AS last,
              max(CASE lower(fields->>'confidence') WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 END
                  + CASE WHEN lower(fields->>'readiness_state') IN ('media-ready', 'outbound-ready') THEN 1 ELSE 0 END) AS best
         FROM engine_commercial_cards WHERE coalesce(lane_id, '') <> '' GROUP BY 1`,
    )
  ).rows;
  const jobs = (
    await query<{ lane: string; open: string; last: string | null }>(
      `SELECT lane_id AS lane,
              count(*) FILTER (WHERE fields->>'Status' IN ('Pending', 'In Progress'))::text AS open,
              max(updated_at) AS last
         FROM engine_rt_jobs WHERE coalesce(lane_id, '') <> '' GROUP BY 1`,
    )
  ).rows;
  const cardsById = new Map(cards.map((c) => [c.lane, c]));
  const jobsById = new Map(jobs.map((j) => [j.lane, j]));

  const workIds = new Set<string>([...LANES, ...workById.keys(), ...profiles.filter((p) => p.kind === 'work').map((p) => p.lane_id)]);
  const commercialIds = new Set<string>([...cardsById.keys(), ...jobsById.keys(), ...profiles.filter((p) => p.kind === 'commercial').map((p) => p.lane_id)]);

  const base = (id: string, kind: 'work' | 'commercial') => {
    const p = byId.get(id);
    return {
      lane_id: id,
      kind,
      gates_oct31: p?.gates_oct31 ?? null,
      blocks_others: p?.blocks_others ?? null,
      engine_leverage: p?.engine_leverage ?? null,
      commercial_tag: p?.commercial_impact ?? null,
      effort: p?.effort ?? null,
      anchors: p?.anchors ?? [],
      note: p?.note ?? null,
      has_profile: Boolean(p),
    };
  };

  const out: LaneInputs[] = [];
  for (const id of workIds) {
    const w = workById.get(id);
    out.push({ ...base(id, 'work'), commercial_from_cards: null, last_moved: w?.last ?? null, open_items: Number(w?.open ?? 0) });
  }
  for (const id of commercialIds) {
    const c = cardsById.get(id);
    const j = jobsById.get(id);
    const last = [c?.last, j?.last].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    out.push({
      ...base(id, 'commercial'),
      commercial_from_cards: c?.best === null || c?.best === undefined ? null : Math.min(5, Number(c.best)),
      last_moved: last,
      open_items: Number(c?.n ?? 0) + Number(j?.open ?? 0),
    });
  }
  return out;
}

export async function ranking(kind: 'work' | 'commercial' | 'all' = 'work', now = new Date()): Promise<{
  kind: string;
  weights: typeof WEIGHTS;
  scale: string;
  definitions: typeof DEFINITIONS;
  lanes: RankedLane[];
  incomplete: number;
}> {
  const inputs = (await readInputs()).filter((l) => kind === 'all' || l.kind === kind);
  const lanes = rank(inputs, now);
  return {
    kind,
    weights: WEIGHTS,
    scale: 'Each factor 0–5; score = Σ (factor ÷ 5 × weight), 0–100. Ties break on lane id. A factor nobody has set scores 0 and is listed in missing.',
    definitions: DEFINITIONS,
    lanes,
    incomplete: lanes.filter((l) => l.missing.length > 0).length,
  };
}
