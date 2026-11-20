/**
 * Shared memory and engine awareness (17 Nov 2026, Destiny — Genie rebuild steps 7 and 8).
 *
 * Shared memory: a note a person asked an agent to remember ("remember for everyone that Kavin is out until
 * Friday"), one row each, read by every agent. It is a person's word, kept with who said it and where, never a
 * record: a fact with a true home is read from that home (`read_true_home`), and a note never overrides one.
 * Written by Genie (genie-control op `shared_remember`), Bays and Research Twin (`write_shared_memory`) and the
 * connector; read by every agent (`read_shared_memory`). Removed only by the person who said it, Destiny or
 * Jason, and a removed note is kept with who removed it. At most 500 live notes, 600 characters each.
 *
 * Awareness: one read of what every part of the engine has been doing lately, from the records each part
 * already writes (Bays', North Star's and Research Twin's ask ledgers, Genie's asks, Media Twin's drafts, the
 * newest outside digest and the newest engine events), so any agent can see what the others are working on
 * without asking them. Questions are cut to 200 characters; nothing personal beyond who asked is returned.
 */
import { query } from './pg';
import * as engineEvents from './engineEvents';

type Row = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const ADMINS = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
export const LIMITS = { notes: 500, note_chars: 600, about_chars: 80 };
export const WRITERS = new Set(['genie', 'bays', 'research_twin', 'north_star', 'media_twin', 'dashboard', 'connector']);

export class SharedMemoryError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const STOP = new Set('the a an and or of to for in on at is are was were be been it this that with from by as what who when where how do does did i me my we our you your about please tell remember genie bays'.split(' '));

/** The words a search matches on. Pure. */
export function words(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/<@[a-z0-9]+(\|[^>]*)?>/g, ' ').split(/[^a-z0-9']+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

export async function remember(b: Row): Promise<Row> {
  const note = str(b.note, LIMITS.note_chars + 1);
  if (note.length < 3) throw new SharedMemoryError(422, 'note is required: what to remember, in the words it was said.');
  if (note.length > LIMITS.note_chars) throw new SharedMemoryError(422, `A note is at most ${LIMITS.note_chars} characters.`);
  const writer = str(b.written_by, 40) || 'connector';
  if (!WRITERS.has(writer)) throw new SharedMemoryError(422, `written_by is one of ${[...WRITERS].join(', ')}.`);
  const live = await query<{ n: number }>(`SELECT count(*)::int AS n FROM engine_shared_memory WHERE removed_at IS NULL`);
  if (Number(live.rows[0].n) >= LIMITS.notes) throw new SharedMemoryError(409, `Shared memory holds ${LIMITS.notes} notes. Remove an old one first.`);
  const same = await query<Row>(`SELECT id FROM engine_shared_memory WHERE removed_at IS NULL AND lower(note) = lower($1)`, [note]);
  if (same.rows[0]) return { ok: true, id: same.rows[0].id, already: true };
  const id = `MEM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const about = str(b.about, LIMITS.about_chars) || null;
  const saidBy = str(b.said_by, 40) || null;
  await query(`INSERT INTO engine_shared_memory (id, about, note, said_by, written_by, source_ref) VALUES ($1, $2, $3, $4, $5, $6)`, [id, about, note, saidBy, writer, str(b.source_ref, 400) || null]);
  await engineEvents.record({ event_type: 'shared_memory_added', subject_id: id, lane: 'GENIE', actor: saidBy ?? writer, source_ref: writer, detail: { about, note, written_by: writer } });
  return { ok: true, id };
}

export async function forget(b: Row): Promise<Row> {
  const id = str(b.id, 60);
  const who = str(b.requester, 40);
  const r = await query<Row>(`SELECT id, said_by, note, removed_at FROM engine_shared_memory WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found', message: `No note ${id}.` };
  if (row.removed_at) return { ok: false, reason: 'already_removed', message: `${id} was already removed.` };
  if (!who || (row.said_by !== who && !ADMINS.has(who))) throw new SharedMemoryError(403, 'Only the person who said it, Destiny or Jason can remove a shared note.');
  await query(`UPDATE engine_shared_memory SET removed_at = now(), removed_by = $2 WHERE id = $1`, [id, who]);
  await engineEvents.record({ event_type: 'shared_memory_removed', subject_id: id, lane: 'GENIE', actor: who, source_ref: 'shared-memory', detail: { note: row.note } });
  return { ok: true, removed: id };
}

/** Notes matching the words of a search, best first; no search, the newest. */
export async function recall(b: Row): Promise<Row> {
  const limit = Math.min(Math.max(Number(b.limit) || 15, 1), 50);
  const r = await query<Row>(`SELECT id, about, note, said_by, written_by, source_ref, created_at FROM engine_shared_memory WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT 500`);
  const want = words(str(b.search, 500));
  let notes = r.rows;
  if (want.length) {
    notes = notes
      .map((n) => {
        const have = new Set(words(`${String(n.about ?? '')} ${String(n.note)}`));
        return { n, score: want.filter((w) => have.has(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .map((x) => x.n);
  }
  return {
    ok: true,
    held: r.rows.length,
    notes: notes.slice(0, limit),
    rule: "A shared note is what a person asked an agent to remember, with who said it. It is not a record: anything with a true home is read there, and a note never overrides it.",
  };
}

/* ----------------------------------------------------------- awareness (8) */

const cut = (s: unknown, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What every part of the engine has done lately, newest first in each part. */
export async function activity(b: Row): Promise<Row> {
  const hours = Math.min(Math.max(Number(b.hours) || 24, 1), 168);
  const per = Math.min(Math.max(Number(b.per_part) || 5, 1), 20);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const asks = async (table: string, from: string) => {
    const r = await query<Row>(
      `SELECT natural_id, fields->>'Question' AS q, fields->>${from} AS asked_by, fields->>'Outcome' AS outcome, created_time
         FROM ${table} WHERE created_time >= $1 ORDER BY created_time DESC LIMIT $2`, [since, per]);
    const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE created_time >= $1`, [since]);
    return { count: Number(n.rows[0].n), latest: r.rows.map((x) => ({ id: x.natural_id, question: cut(x.q), asked_by: x.asked_by, outcome: x.outcome, at: x.created_time })) };
  };
  const [bays, northStar, researchTwin] = await Promise.all([
    asks('engine_bays_asks', "'Source'"),
    asks('engine_ns_asks', "'Asked By System'"),
    asks('engine_rt_asks', "'Asked By System'"),
  ]);
  const genie = await query<Row>(
    `SELECT DISTINCT ON (request_id) request_id, question, source, status, handoff, occurred_at FROM engine_genie_events
      WHERE occurred_at >= $1 AND event_type NOT LIKE 'genie.subagent.%' AND request_id IS NOT NULL ORDER BY request_id, occurred_at DESC`, [since]);
  // occurred_at comes back as a Date; compare times, never String(Date), which starts with the weekday name.
  const genieRows = genie.rows.sort((x, y) => new Date(y.occurred_at as string | Date).getTime() - new Date(x.occurred_at as string | Date).getTime());
  const media = await query<Row>(`SELECT post_id, occasion_label, angle, status, created_at FROM engine_media_posts WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`, [since, per]);
  const digest = await query<Row>(`SELECT digest_date, title, received_at FROM engine_outside_digests ORDER BY digest_date DESC LIMIT 1`).catch(() => ({ rows: [] as Row[] }));
  const events = await query<Row>(`SELECT event_type, count(*)::int AS n, max(at) AS last FROM engine_events WHERE at >= $1 GROUP BY 1 ORDER BY 3 DESC LIMIT 25`, [since]);
  return {
    ok: true,
    window_hours: hours,
    since,
    parts: {
      bays,
      north_star: northStar,
      research_twin: researchTwin,
      genie: { count: genieRows.length, latest: genieRows.slice(0, per).map((x) => ({ id: x.request_id, question: cut(x.question), source: x.source, status: x.status, handed_to: x.handoff, at: x.occurred_at })) },
      media_twin: { count: media.rows.length, latest: media.rows.map((x) => ({ id: x.post_id, occasion: x.occasion_label, angle: cut(x.angle), status: x.status, at: x.created_at })) },
      bha_rss: { newest_digest: digest.rows[0] ?? null },
    },
    engine_events: events.rows,
    rule: 'This is what each part recorded. A part with nothing in the window recorded nothing, which is not the same as being down: read get_health or read_engine_strain for that.',
  };
}
