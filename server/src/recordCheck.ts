/**
 * The record check (21 Nov 2026, Destiny): what the dashboard really holds for a list of record ids.
 *
 * Ahad attached a 63 KB evidence report in Slack. It named a Decision Watch that does not exist
 * (DW-1789623401234-QJY3; the real one is DW-1793406530806-QJY3, about something else), gave a loop under the
 * wrong id, and asked Destiny for a sign-off nothing on record was waiting for. Genie read the file and
 * repeated what it said. A file is a claim; the record is the fact. So when Genie opens a file it pulls the
 * ids out of the text and asks here, and gets back, per id, what is on record: what it is about, its status
 * and who owns it, or that no such id is held, with the real record whose ending matches when there is one.
 *
 * Reads only. It answers for the kinds whose ids have a fixed shape: a loop, a Decision Watch, an incident,
 * a Codex entry, an evidence document, a pattern candidate, a backlog task and a build pattern. An id of any
 * other shape is returned as not checked, never as missing. Incidents are the dashboard's copy of BHARAG's
 * ledger, and the answer says so.
 */
import { query } from './pg';

type Row = Record<string, unknown>;
export type RecordKind = 'loop' | 'decision_watch' | 'incident' | 'codex' | 'evidence' | 'pattern_candidate' | 'backlog_task' | 'pattern' | 'short';

export interface RecordAnswer {
  id: string;
  kind: RecordKind | 'unknown';
  /** true: held. false: no record under this id. null: not a kind this check reads. */
  on_record: boolean | null;
  title?: string;
  status?: string;
  owner?: string;
  lane?: string;
  detail?: string;
  /** Held more than once under this id (a loop left behind by a move, a log held twice). */
  copies?: number;
  /** A short id (the last four characters, EXLZ for LOOP-1788044070649-EXLZ) resolved to the one full id it names. */
  resolved_id?: string;
  /** Not held, but a record of the same kind ends the same way: usually the id the writer meant. */
  closest?: { id: string; title: string; status?: string; owner?: string }[];
  note?: string;
}

export const MAX_IDS = 60;

const SHAPES: [RecordKind, RegExp][] = [
  ['loop', /^LOOP-\d{10,}-[A-Z0-9]{4}$/],
  ['decision_watch', /^DW-\d{10,}-[A-Z0-9]{4}$/],
  ['incident', /^INC-[A-Z0-9_]+\.[A-Z0-9_]+-\d+$/],
  ['codex', /^CODEX-\d{8}-[a-z0-9][a-z0-9-]*$/],
  ['evidence', /^EV-\d{10,}-[A-Z0-9]{4}$/],
  ['pattern_candidate', /^CAND-\d{10,}-[A-Z0-9]{4}$/],
  ['backlog_task', /^TASK-[A-Z0-9][A-Z0-9-]{3,}$/],
  ['pattern', /^BP-[A-Z0-9_]+-[A-Z0-9_-]+$/],
  // The last four characters of a loop, watch, evidence or candidate id, as people write them in Slack
  // (24 Nov 2026: Jason wrote EXLZ, SJCJ and YS6W and Genie said it could not match them).
  ['short', /^(?=.*[A-Z])[A-Z0-9]{4}$/],
];

/** Pure: which kind of record an id names, from its shape alone. */
export function kindOfId(id: string): RecordKind | null {
  for (const [kind, re] of SHAPES) if (re.test(id)) return kind;
  return null;
}

/** Pure: the ids asked about, trimmed, each once, in the order given, at most MAX_IDS. */
export function cleanIds(raw: unknown): { ids: string[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const v of list) {
    const id = typeof v === 'string' ? v.trim().replace(/[.,;:)\]]+$/, '') : '';
    if (id && id.length <= 120) seen.add(id);
  }
  const all = [...seen];
  return { ids: all.slice(0, MAX_IDS), dropped: Math.max(0, all.length - MAX_IDS) };
}

const s = (v: unknown, n = 240): string | undefined => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v == null ? '' : String(v);
  return t ? (t.length > n ? t.slice(0, n - 1) + '…' : t) : undefined;
};
const tail = (id: string) => id.slice(id.lastIndexOf('-') + 1);
const of = (ids: string[], kind: RecordKind) => ids.filter((id) => kindOfId(id) === kind);

async function loops(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(
    `SELECT DISTINCT ON (natural_id) natural_id, fields->>'What' AS what, fields->>'Status' AS status, fields->>'lane_tag' AS lane, builder_id,
            COALESCE(NULLIF(fields->>'Close Reason',''), NULLIF(fields->>'Resolution',''), NULLIF(fields->>'Closure Note',''), NULLIF(fields->>'Closure Evidence Note','')) AS closed_why,
            right(fields->>'Progress Note', 320) AS latest_note,
            count(*) OVER (PARTITION BY natural_id) AS copies
       FROM engine_loops WHERE natural_id = ANY($1) ORDER BY natural_id, updated_at DESC NULLS LAST, id DESC`,
    [ids],
  );
  for (const x of r.rows) {
    const id = String(x.natural_id);
    out.set(id, { id, kind: 'loop', on_record: true, title: s(x.what), status: s(x.status, 40), owner: s(x.builder_id, 60), lane: s(x.lane, 40), detail: [x.closed_why ? `Closed with: ${s(x.closed_why, 200)}` : '', x.latest_note ? `Latest note ends: ${s(x.latest_note, 320)}` : ''].filter(Boolean).join('. ') || undefined, ...(Number(x.copies) > 1 ? { copies: Number(x.copies) } : {}) });
  }
  const missing = ids.filter((id) => !out.has(id));
  if (!missing.length) return;
  const near = await query<Row>(
    `SELECT DISTINCT ON (natural_id) natural_id, fields->>'What' AS what, fields->>'Status' AS status, builder_id, right(natural_id, 4) AS tail
       FROM engine_loops WHERE right(natural_id, 4) = ANY($1) ORDER BY natural_id, updated_at DESC NULLS LAST, id DESC`,
    [missing.map(tail)],
  );
  for (const id of missing) {
    const closest = near.rows.filter((x) => x.tail === tail(id)).slice(0, 3).map((x) => ({ id: String(x.natural_id), title: s(x.what, 160) ?? '', status: s(x.status, 40), owner: s(x.builder_id, 60) }));
    out.set(id, { id, kind: 'loop', on_record: false, ...(closest.length ? { closest } : {}) });
  }
}

async function watches(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(`SELECT watch_id, decision, status, owner_name, owner_user_id, lane, close_reason, record_id, next_step FROM engine_decision_watches WHERE watch_id = ANY($1)`, [ids]);
  for (const x of r.rows) {
    const id = String(x.watch_id);
    const bits = [x.close_reason ? `Closed with: ${s(x.close_reason, 160)}` : '', x.record_id ? `Tracks ${x.record_id}` : '', x.next_step ? `Owed: ${s(String(x.next_step).split('\n').filter(Boolean).pop(), 200)}` : ''].filter(Boolean);
    out.set(id, { id, kind: 'decision_watch', on_record: true, title: s(x.decision), status: s(x.status, 40), owner: s(x.owner_name, 60) ?? s(x.owner_user_id, 20), lane: s(x.lane, 40), detail: bits.length ? bits.join('. ') : undefined });
  }
  const missing = ids.filter((id) => !out.has(id));
  if (!missing.length) return;
  const near = await query<Row>(`SELECT watch_id, decision, status, owner_name, right(watch_id, 4) AS tail FROM engine_decision_watches WHERE right(watch_id, 4) = ANY($1)`, [missing.map(tail)]);
  for (const id of missing) {
    const closest = near.rows.filter((x) => x.tail === tail(id)).slice(0, 3).map((x) => ({ id: String(x.watch_id), title: s(x.decision, 160) ?? '', status: s(x.status, 40), owner: s(x.owner_name, 60) }));
    out.set(id, { id, kind: 'decision_watch', on_record: false, ...(closest.length ? { closest } : {}) });
  }
}

async function incidents(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(
    `SELECT natural_id, fields->>'summary' AS summary, fields->>'resolution_status' AS ledger, fields->>'severity' AS severity, fields->>'subsystem' AS subsystem,
            first_seen_at::text AS first_seen, resolved_at::text AS resolved_at, resolved_by, test_reason
       FROM engine_incidents WHERE natural_id = ANY($1)`,
    [ids],
  );
  for (const x of r.rows) {
    const id = String(x.natural_id);
    const closed = Boolean(x.resolved_at) || (x.ledger && x.ledger !== 'open' && x.ledger !== 'retrying');
    const bits = [x.first_seen ? `First seen ${String(x.first_seen).slice(0, 16).replace('T', ' ')} UTC` : '', x.severity ? `severity ${x.severity}` : '', x.resolved_by ? `Closed by: ${s(x.resolved_by, 260)}` : '', x.test_reason ? `Marked a test: ${s(x.test_reason, 160)}` : ''].filter(Boolean);
    out.set(id, { id, kind: 'incident', on_record: true, title: s(x.summary), status: closed ? `closed${x.ledger && x.ledger !== 'open' ? ` (${x.ledger})` : ''}` : s(x.ledger, 40) ?? 'open', lane: s(x.subsystem, 40), detail: bits.join('. ') || undefined });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { id, kind: 'incident', on_record: false, note: "Not in the dashboard's copy of the incident ledger." });
}

async function codex(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(
    `SELECT fields->>'Codex Entry ID' AS id, fields->>'Builder Name' AS builder, fields->>'Jason Status' AS status, fields->>'Session Description' AS what, fields->>'Timestamp' AS at, id AS row_id
       FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = ANY($1) ORDER BY id`,
    [ids],
  );
  for (const x of r.rows) {
    const id = String(x.id);
    const prior = out.get(id);
    if (prior) { prior.copies = (prior.copies ?? 1) + 1; continue; }
    out.set(id, { id, kind: 'codex', on_record: true, title: s(x.what), status: s(x.status, 40) ?? 'Pending', owner: s(x.builder, 60), detail: `Codex row ${x.row_id}${x.at ? `, submitted ${String(x.at).slice(0, 10)}` : ''}` });
  }
  const missing = ids.filter((id) => !out.has(id));
  for (const id of missing) {
    // A report often cuts a long Codex id short, or adds to it: offer the entries that start the same way.
    const near = await query<Row>(
      `SELECT DISTINCT fields->>'Codex Entry ID' AS id, fields->>'Session Description' AS what, fields->>'Jason Status' AS status, fields->>'Builder Name' AS builder
         FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' <> '' AND (starts_with(fields->>'Codex Entry ID', $1) OR starts_with($1, fields->>'Codex Entry ID')) LIMIT 3`,
      [id],
    );
    const closest = near.rows.map((x) => ({ id: String(x.id), title: s(x.what, 160) ?? '', status: s(x.status, 40), owner: s(x.builder, 60) }));
    out.set(id, { id, kind: 'codex', on_record: false, ...(closest.length ? { closest } : {}) });
  }
}

async function evidence(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(`SELECT evidence_id, name, version, title, proves, author_name, test FROM engine_evidence WHERE evidence_id = ANY($1)`, [ids]);
  for (const x of r.rows) {
    const id = String(x.evidence_id);
    out.set(id, { id, kind: 'evidence', on_record: true, title: s(x.title), status: x.test ? 'test' : 'held', owner: s(x.author_name, 60), detail: `${x.name} v${x.version}. Proves: ${s(x.proves, 200)}` });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { id, kind: 'evidence', on_record: false });
}

/**
 * A short id resolved by its ending across the four kinds whose ids end in four characters. One match is on
 * record under its full id; several are named in closest and the full id is needed; none is not checked rather
 * than missing, because four capital letters are often just a word (JSON, HTTP).
 */
async function shorts(ids: string[], out: Map<string, RecordAnswer>): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(
    `SELECT * FROM (
       (SELECT DISTINCT ON (natural_id) 'loop' AS kind, natural_id AS id, fields->>'What' AS title, fields->>'Status' AS status, builder_id AS owner, fields->>'lane_tag' AS lane, right(natural_id, 4) AS tail
          FROM engine_loops WHERE natural_id LIKE 'LOOP-%' AND right(natural_id, 4) = ANY($1) ORDER BY natural_id, updated_at DESC NULLS LAST, id DESC)
       UNION ALL
       (SELECT 'decision_watch', watch_id, decision, status, owner_name, lane, right(watch_id, 4) FROM engine_decision_watches WHERE right(watch_id, 4) = ANY($1))
       UNION ALL
       (SELECT 'evidence', evidence_id, title, CASE WHEN test THEN 'test' ELSE 'held' END, author_name, NULL, right(evidence_id, 4) FROM engine_evidence WHERE right(evidence_id, 4) = ANY($1))
       UNION ALL
       (SELECT 'pattern_candidate', natural_id, fields->>'Candidate', fields->>'Status', fields->>'Builder', fields->>'Lane', right(natural_id, 4) FROM engine_pattern_candidates WHERE natural_id LIKE 'CAND-%' AND right(natural_id, 4) = ANY($1))
     ) x`,
    [ids],
  );
  for (const id of ids) {
    const hits = r.rows.filter((x) => x.tail === id);
    if (hits.length === 1) {
      const x = hits[0];
      out.set(id, { id, kind: x.kind as RecordKind, on_record: true, resolved_id: String(x.id), title: s(x.title), status: s(x.status, 40), owner: s(x.owner, 60), lane: s(x.lane, 40), note: `${id} is the short form of ${x.id}.` });
    } else if (hits.length > 1) {
      out.set(id, { id, kind: 'short', on_record: false, closest: hits.slice(0, 5).map((x) => ({ id: String(x.id), title: s(x.title, 160) ?? '', status: s(x.status, 40), owner: s(x.owner, 60) })), note: `${hits.length} records end in ${id}; name the one meant by its full id.` });
    } else {
      out.set(id, { id, kind: 'short', on_record: null, note: `No loop, Decision Watch, evidence document or pattern candidate ends in ${id}; it may not be an id.` });
    }
  }
}

async function simple(ids: string[], kind: RecordKind, table: string, titleField: string, statusField: string | null, out: Map<string, RecordAnswer>, missingNote?: string): Promise<void> {
  if (!ids.length) return;
  const r = await query<Row>(`SELECT natural_id, fields->>($2::text) AS title${statusField ? `, fields->>($3::text) AS status` : ''} FROM ${table} WHERE natural_id = ANY($1)`, statusField ? [ids, titleField, statusField] : [ids, titleField]);
  for (const x of r.rows) {
    const id = String(x.natural_id);
    out.set(id, { id, kind, on_record: true, title: s(x.title), status: s(x.status, 40) });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { id, kind, on_record: false, ...(missingNote ? { note: missingNote } : {}) });
}

export interface CheckResult {
  ok: true;
  checked: number;
  on_record: number;
  not_on_record: string[];
  not_checked: string[];
  dropped: number;
  records: RecordAnswer[];
  note: string;
}

/** What the dashboard holds for each id, in the order asked. Reads only. */
export async function check(rawIds: unknown): Promise<CheckResult> {
  const { ids, dropped } = cleanIds(rawIds);
  const out = new Map<string, RecordAnswer>();
  await loops(of(ids, 'loop'), out);
  await watches(of(ids, 'decision_watch'), out);
  await incidents(of(ids, 'incident'), out);
  await codex(of(ids, 'codex'), out);
  await evidence(of(ids, 'evidence'), out);
  await shorts(of(ids, 'short'), out);
  await simple(of(ids, 'pattern_candidate'), 'pattern_candidate', 'engine_pattern_candidates', 'Candidate', 'Status', out, 'A candidate registered as a pattern leaves the candidate list, so this may have been registered.');
  await simple(of(ids, 'backlog_task'), 'backlog_task', 'engine_lane_backlog', 'task', 'status', out);
  await simple(of(ids, 'pattern'), 'pattern', 'engine_build_patterns', 'pattern_name', null, out);
  // A pattern id is often written short (BP-INFRA-002 for BP-INFRA-002-SOME_SLUG) or long: offer the ones that start the same way.
  for (const id of of(ids, 'pattern')) {
    const held = out.get(id);
    if (!held || held.on_record !== false) continue;
    const near = await query<Row>(
      `SELECT natural_id, fields->>'pattern_name' AS title FROM engine_build_patterns WHERE starts_with(upper(natural_id), upper($1)) OR starts_with(upper($1), upper(natural_id)) ORDER BY natural_id LIMIT 3`,
      [id],
    );
    if (near.rows.length) held.closest = near.rows.map((x) => ({ id: String(x.natural_id), title: s(x.title, 160) ?? '' }));
  }
  const records = ids.map((id) => out.get(id) ?? ({ id, kind: 'unknown', on_record: null, note: 'Not a kind of id this check reads.' } as RecordAnswer));
  return {
    ok: true,
    checked: records.filter((x) => x.on_record !== null).length,
    on_record: records.filter((x) => x.on_record === true).length,
    not_on_record: records.filter((x) => x.on_record === false).map((x) => x.id),
    not_checked: records.filter((x) => x.on_record === null).map((x) => x.id),
    dropped,
    records,
    note: `What the dashboard held for each id when asked. on_record false means no record has that id${dropped ? `; ${dropped} more ids were not looked up (the limit is ${MAX_IDS} a call)` : ''}.`,
  };
}
