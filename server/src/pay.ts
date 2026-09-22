/**
 * Pay Tracker: who is owed money, for what work, and what has already been
 * paid.
 *
 * Three Airtable tables in the BHA Pay Ledger, mirrored into Postgres like
 * everything else and read from the mirror. This module owns their queries
 * directly rather than going through `store.ts`'s record machinery, the way
 * `executions.ts` and `health.ts` own their own: these are not record kinds
 * and have no monthly rollup or status ledger of their own.
 *
 * Four rules run through every figure below, and they are what the page is
 * actually for:
 *
 *   - **No amount, ever.** There are no rates in this system. The page counts
 *     work, and a figure with a currency sign on it would be invented.
 *   - **Monthly and daily are never summed into one rate.** They are different
 *     agreements — a monthly builder is *expected* to wait until the 1st — so a
 *     blended figure is meaningless and the split is carried everywhere.
 *   - **Working days and session count are different numbers.** Two sessions in
 *     one day is one working day and two sessions. Neither is derived from the
 *     other and neither is presented as the other.
 *   - **A month is the session's own month**, which comes from the session
 *     date. A session worked on 30 September and approved on 1 October counts
 *     to September, and nothing here groups by `Approved At`.
 *
 * And the one that decides how an empty page reads: **nothing owed and the
 * sync not having run look identical**. On a pay page that is the difference
 * between a quiet month and an unpaid builder, so the ledger's own age is
 * printed in the freshness line and every empty state says which it is.
 */
import { getMeta, nowIso, setMeta } from './db';
import { lastEngineWrite } from './store';
import { query, withTransaction } from './pg';
import * as airtable from './airtable';
import * as mirror from './mirror';
import {
  PAID_BY,
  PAY_BUILDERS,
  PAY_MODES,
  PAY_SESSIONS,
  PAY_STATEMENTS,
  STATEMENT_CHASE_DAYS,
  STATEMENT_STATUSES,
  UNPAID_ALARM_DAYS,
  mapPayBuilder,
  mapPaySession,
  mapPayStatement,
  type AtRecord,
} from './sources';
import type {
  Freshness,
  OwedBuilder,
  PayBuilder,
  PayData,
  PayMetrics,
  PaySession,
  PayStatement,
  Percentiles,
  Resync,
  ResyncTable,
  Slice,
} from '../../src/data/types';

/** When this dashboard last read the ledger. */
const SYNCED_AT = 'pay.resynced_at';

/* ------------------------------------------------------------------ dates */

const DAY_MS = 86_400_000;

function daysSince(day: string | null, now = Date.now()): number | null {
  if (!day) return null;
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
}
function weekStart(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastWeeks(n: number): string[] {
  const out: string[] = [];
  let w = weekStart(nowIso().slice(0, 10));
  for (let i = 0; i < n; i++) {
    out.unshift(w);
    w = addDays(w, -7);
  }
  return out;
}
function weekLabel(start: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(a);
  b.setUTCDate(a.getUTCDate() + 6);
  const mon = (d: Date) => d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${mon(a)}` : `${a.getUTCDate()} ${mon(a)}–${b.getUTCDate()} ${mon(b)}`;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * The full year, not a two-digit one.
 *
 * "Sep 26" is how every other page labels a month, and on those it is fine.
 * Here the page is wall to wall with session dates, and "Sep 26" reads as the
 * twenty-sixth rather than as 2026 — which on a page about which month somebody
 * is owed for is the one ambiguity worth spending four characters to remove.
 */
function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? month} ${y ?? ''}`.trim();
}
/** The last n months, oldest first, ending with the current one. */
function lastMonths(n: number): string[] {
  const now = new Date(nowIso());
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
function thisMonth(): string {
  return nowIso().slice(0, 7);
}

/* ----------------------------------------------------------- the shapes */

/** p50 and p95 by nearest rank. Never a mean: a mean hides the slow tail. */
function percentiles(values: number[], of: number, note: (n: number, of: number) => string): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(at(50)), p95: round(at(95)), n: s.length, of, note: note(s.length, of) };
}

function slices<T>(items: T[], of: (x: T) => string | null, vocab: readonly string[], blank: string): Slice[] {
  const counts = new Map<string, number>();
  for (const x of items) {
    const key = of(x) ?? blank;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = vocab.filter((v) => counts.has(v)).map((v) => ({ key: v, label: v, n: counts.get(v)! }));
  const rest = [...counts.entries()]
    .filter(([k]) => !vocab.includes(k))
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, label: key, n }));
  return [...known, ...rest];
}

/** Distinct session dates. Never the session count — they are different numbers. */
function workingDays(sessions: PaySession[]): number {
  return new Set(sessions.map((s) => s.session_date).filter(Boolean)).size;
}

/* -------------------------------------------------------------- the reads */

interface HeldRow {
  pk: string;
  airtable_record_id: string | null;
  natural_id: string | null;
  created_time: string | null;
  fields: Record<string, unknown> | null;
  first_seen_at: string;
  updated_at: string;
  source?: string;
}

function asRecord(r: HeldRow): AtRecord {
  return { id: r.airtable_record_id ?? r.natural_id ?? `row-${r.pk}`, createdTime: r.created_time ?? '', fields: r.fields ?? {} };
}

const SELECT = 'SELECT id::text AS pk, airtable_record_id, natural_id, created_time, fields, first_seen_at, updated_at, source FROM';

export async function builders(): Promise<PayBuilder[]> {
  const r = await query<HeldRow>(`${SELECT} engine_pay_builders`);
  // Active first, then by name: an inactive builder is kept rather than
  // filtered away, because their history is why the row was not deleted.
  return r.rows
    .map((row) => mapPayBuilder(asRecord(row)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.builder.localeCompare(b.builder));
}

/**
 * Every session, **once** (2026-09-22).
 *
 * 57 sessions were held twice: the Airtable resync of 20 Sep brought each in
 * under its Airtable record id, and from 21 Sep `Bays — Pay Tracking` posted the
 * same session again with no record id, so the two never matched and every
 * figure on this page counted both — 132 rows for 75 sessions. Keyed on the
 * Codex Entry ID, which is one per approved session; the engine's copy is kept
 * because it is the newer statement, and where two copies disagree about Paid
 * the pair is counted so the page can say so rather than pick silently.
 */
export async function sessionsHeld(): Promise<{ sessions: PaySession[]; duplicates: PayData['duplicates'] }> {
  const r = await query<HeldRow>(`${SELECT} engine_pay_sessions`);
  const all = r.rows.map((row) => ({ s: { ...mapPaySession(asRecord(row)), held_via: row.source === 'engine' ? ('engine' as const) : ('resync' as const) }, at: row.updated_at }));
  const byKey = new Map<string, { s: PaySession; at: string }[]>();
  for (const x of all) {
    const key = x.s.codex_entry_id && x.s.codex_entry_id !== '(no codex id)' ? x.s.codex_entry_id : `row:${x.s.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), x]);
  }
  let merged = 0;
  let disagree = 0;
  const out: PaySession[] = [];
  for (const copies of byKey.values()) {
    if (copies.length > 1) {
      merged += copies.length - 1;
      if (new Set(copies.map((c) => String(c.s.paid))).size > 1) disagree++;
    }
    const keep = [...copies].sort((a, b) => Number(b.s.held_via === 'engine') - Number(a.s.held_via === 'engine') || b.at.localeCompare(a.at))[0];
    out.push(keep.s);
  }
  // Newest session first, and an unpaid one above a paid one of the same date:
  // what is owed is what anybody opens this page for.
  out.sort((a, b) => (b.session_date ?? '').localeCompare(a.session_date ?? '') || Number(a.paid === true) - Number(b.paid === true));
  return { sessions: out, duplicates: { rows: all.length, sessions: out.length, merged, disagree } };
}

export async function sessions(): Promise<PaySession[]> {
  return (await sessionsHeld()).sessions;
}

export async function statements(): Promise<PayStatement[]> {
  const r = await query<HeldRow>(`${SELECT} engine_pay_statements`);
  return r.rows.map((row) => mapPayStatement(asRecord(row))).sort((a, b) => (b.month ?? '').localeCompare(a.month ?? '') || a.builder.localeCompare(b.builder));
}

async function freshnessOf(table: string, kind: string, label: string): Promise<Freshness> {
  const r = await query<{ n: string; changed_at: string | null; from_engine: string }>(
    `SELECT count(*)::text AS n, max(updated_at) AS changed_at, count(*) FILTER (WHERE source <> 'airtable')::text AS from_engine FROM ${table}`,
  );
  const row = r.rows[0];
  const n = Number(row?.n ?? 0);
  return {
    kind: kind as Freshness['kind'],
    source: n ? 'engine' : 'none',
    changed_at: row?.changed_at ?? null,
    rows: n,
    from_engine: Number(row?.from_engine ?? 0),
    tables: n ? [{ table, label, n }] : [],
    note: n ? null : `Nothing of this kind is held yet. ${label} reaches this dashboard through Resync from Airtable above, and through POST /api/engine/pay.`,
  };
}

export async function data(): Promise<PayData> {
  // The engine posts every thirty minutes now; the resync is retired. The
  // newer of the two is when this ledger was last written.
  const resyncAt = await getMeta(SYNCED_AT);
  const engineAt = await lastEngineWrite('pay_sessions');
  const at = [resyncAt, engineAt].filter((v): v is string => Boolean(v)).sort().reverse()[0] ?? null;
  const { sessions: held, duplicates } = await sessionsHeld();
  return {
    builders: await builders(),
    sessions: held,
    duplicates,
    statements_last_write: await lastEngineWrite('pay_statements'),
    statements: await statements(),
    freshness: await freshnessOf('engine_pay_sessions', 'pay_sessions', 'Sessions'),
    statements_freshness: await freshnessOf('engine_pay_statements', 'pay_statements', 'Monthly statements'),
    /**
     * Two hops, and both are stated.
     *
     * The ledger is kept in step with the approved logs by a sync that runs
     * every 30 minutes, and this dashboard reads the ledger when somebody
     * presses Resync. So a tick made in Slack a few minutes ago may be in
     * neither yet, and "nothing owed" and "nobody has looked" are different
     * facts that look the same.
     */
    synced: {
      at,
      note: at
        ? `The last time the ledger was written here — by the engine's pay sync, which posts every 30 minutes, or by a resync, whichever was later. A tick made in Slack in the last half hour may not be here yet.`
        : `Nothing has ever written the ledger here. Until it is, an empty page means nobody has looked, not that nothing is owed.`,
    },
  };
}

/* ------------------------------------------------------------- the resync */

const SWEEP_READ_TIMEOUT_MS = 20_000;

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Reads the three tables whole and makes this database match them. Airtable is
 * the source of truth: insert what it has and we do not, update what changed,
 * delete what is gone.
 *
 * **A table that could not be read is never treated as an emptied table** —
 * the same rule every other resync follows, and it matters more here than
 * anywhere: an emptied Sessions table would read as nothing owed.
 */
export async function resync(actor = 'dashboard'): Promise<Resync> {
  const started = Date.now();
  const at = nowIso();
  const tables: ResyncTable[] = [];

  if (!airtable.airtableConfigured()) {
    return {
      ran: false,
      at,
      ms: 0,
      tables: [],
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      refused: 0,
      overwritten: [],
      note: 'AIRTABLE_TOKEN is not set on this server, so the pay ledger was not read and nothing was changed. Nothing on this page is owed-or-not until it can be.',
    };
  }

  for (const src of [
    { ...PAY_BUILDERS, kind: 'pay_builders' as const },
    { ...PAY_SESSIONS, kind: 'pay_sessions' as const },
    { ...PAY_STATEMENTS, kind: 'pay_statements' as const },
  ]) {
    let records: AtRecord[];
    try {
      records = await airtable.listRecords(src.base, src.table, SWEEP_READ_TIMEOUT_MS);
    } catch (e) {
      const reason = why(e);
      console.error(`pay resync: ${src.label} could not be read — ${reason}`);
      tables.push({ table: src.table, label: src.label, read: false, reason, rows: null, inserted: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 });
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let refused = 0;
    for (const rec of records) {
      try {
        const result = await mirror.upsert(src.kind, { record_id: rec.id, created_time: rec.createdTime ?? null, fields: rec.fields ?? {} }, 'airtable');
        if (result.inserted) inserted++;
        else if (result.changed) updated++;
        else unchanged++;
      } catch (e) {
        refused++;
        console.error(`pay resync: ${src.label} ${rec.id} refused — ${why(e)}`);
      }
    }

    const table = mirror.KINDS[src.kind].table;
    const holdings = await query<{ id: string; airtable_record_id: string }>(`SELECT id, airtable_record_id FROM ${table} WHERE airtable_record_id IS NOT NULL`);
    const live = new Set(records.map((r) => r.id));
    const gone = holdings.rows.filter((row) => !live.has(row.airtable_record_id));
    if (gone.length) {
      await withTransaction(async (client) => {
        for (const row of gone) await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
      });
    }

    tables.push({ table: src.table, label: src.label, read: true, reason: null, rows: records.length, inserted, updated, unchanged, deleted: gone.length, refused });
  }

  const sum = (k: 'inserted' | 'updated' | 'unchanged' | 'deleted' | 'refused') => tables.reduce((n, t) => n + t[k], 0);
  const blocked = tables.filter((t) => !t.read);
  const ran = tables.some((t) => t.read);
  // Stamped only where something was actually read, so the freshness line can
  // never claim a read that did not happen.
  if (ran) await setMeta(SYNCED_AT, at);

  const note = [
    ran ? '' : 'Nothing was read, so nothing was changed.',
    ran ? `${sum('inserted')} inserted, ${sum('updated')} updated, ${sum('deleted')} deleted, ${sum('unchanged')} already matching.` : '',
    sum('refused') ? `${sum('refused')} row${sum('refused') === 1 ? ' was' : 's were'} read and refused by this database; the server log names each one and why.` : '',
    blocked.length
      ? `${blocked.length} table${blocked.length === 1 ? '' : 's'} could not be read (${blocked.map((b) => b.label).join(', ')}), so nothing under ${blocked.length === 1 ? 'it' : 'them'} was touched — an unread Sessions table would otherwise read as nothing owed. ${[...new Set(blocked.map((b) => b.reason ?? 'no reason given'))].join(' · ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  console.log(`pay resync by ${actor}: ${note} | ` + tables.map((t) => `${t.label} ${t.read ? `${t.rows} rows +${t.inserted}/~${t.updated}/-${t.deleted}` : `UNREAD (${t.reason})`}`).join(' · '));

  return { ran, at, ms: Date.now() - started, tables, inserted: sum('inserted'), updated: sum('updated'), unchanged: sum('unchanged'), deleted: sum('deleted'), refused: sum('refused'), overwritten: [], note };
}

/* ------------------------------------------------------------- the figures */

const NO_MODE = '(no pay mode)';

export async function metrics(): Promise<PayMetrics> {
  const roster = await builders();
  const all = await sessions();
  const stmts = await statements();
  const month = thisMonth();
  const year = month.slice(0, 4);

  const bySlack = new Map(roster.filter((b) => b.slack_user_id).map((b) => [b.slack_user_id!, b]));
  // Owed is an explicit `Paid = false`. A row with no Paid at all is not known
  // either way and is counted apart (2026-09-22) — never folded into owed.
  const unpaid = all.filter((s) => s.paid === false);
  const unconfirmed = all.filter((s) => s.paid === null);
  const paid = all.filter((s) => s.paid === true);
  const monthly = (rows: PaySession[]) => rows.filter((s) => s.pay_mode === 'Monthly');
  const daily = (rows: PaySession[]) => rows.filter((s) => s.pay_mode === 'Daily');
  /**
   * A session whose pay mode was never written. It is neither monthly nor
   * daily, and folding it into either would be guessing which agreement
   * somebody is on — so it is counted on its own and named wherever the split
   * is printed, because a split that does not add up to the figure above it is
   * exactly the quietly-wrong number this dashboard exists to remove.
   */
  const noMode = (rows: PaySession[]) => rows.filter((s) => s.pay_mode !== 'Monthly' && s.pay_mode !== 'Daily');

  /* ---- owed, one row per builder ---- */
  const owedKeys = [...new Set([...unpaid, ...unconfirmed].map((s) => s.builder_slack_id ?? s.builder))];
  const owed: OwedBuilder[] = owedKeys
    .map((key) => {
      const mine = unpaid.filter((s) => (s.builder_slack_id ?? s.builder) === key);
      const unknown = unconfirmed.filter((s) => (s.builder_slack_id ?? s.builder) === key);
      const any = mine[0] ?? unknown[0];
      const onRoster = any?.builder_slack_id ? bySlack.has(any.builder_slack_id) : false;
      const rosterRow = any?.builder_slack_id ? bySlack.get(any.builder_slack_id) : undefined;
      const oldest = [...mine].sort((a, b) => (a.session_date ?? '9999').localeCompare(b.session_date ?? '9999'))[0];
      /**
       * Which table the builder sits in is the roster's Pay Mode (2026-09-22,
       * Destiny) — a fact about the person. Each session keeps the mode frozen
       * on it at approval, and any that differ are counted on the row rather
       * than moving the builder: the old rule took the mode of whichever
       * unpaid session happened to come first.
       */
      const mode = rosterRow?.pay_mode ?? any?.pay_mode ?? null;
      return {
        builder: rosterRow?.builder ?? any?.builder ?? key,
        slack_user_id: any?.builder_slack_id ?? null,
        mode_from: (rosterRow?.pay_mode ? 'roster' : 'sessions') as OwedBuilder['mode_from'],
        mode_mismatch: [...mine, ...unknown].filter((s) => s.pay_mode && mode && s.pay_mode !== mode).length,
        sessions_unconfirmed: unknown.length,
        /**
         * Sessions are grouped on the Slack id where one is present, so two
         * spellings of a name are one person. A session carrying no id cannot
         * be matched to one that does, so it lands in its own row — which looks
         * like a duplicate unless the row says why.
         */
        has_slack_id: Boolean(any?.builder_slack_id),
        pay_mode: mode,
        on_roster: onRoster,
        active: rosterRow?.active ?? false,
        sessions_owed: mine.length,
        working_days_owed: workingDays(mine),
        oldest_unpaid: oldest?.session_date ?? null,
        oldest_unpaid_days: daysSince(oldest?.session_date ?? null),
        months: [...new Set([...mine, ...unknown].map((s) => s.month).filter((m): m is string => Boolean(m)))].sort(),
        sessions: [...mine, ...unknown].sort((a, b) => (b.session_date ?? '').localeCompare(a.session_date ?? '')),
      };
    })
    .sort((a, b) => (b.oldest_unpaid_days ?? -1) - (a.oldest_unpaid_days ?? -1) || b.sessions_owed - a.sessions_owed);

  const oldestSession = [...unpaid].sort((a, b) => (a.session_date ?? '9999').localeCompare(b.session_date ?? '9999'))[0] ?? null;
  const oldestDays = daysSince(oldestSession?.session_date ?? null);

  const thisMonthSessions = all.filter((s) => s.month === month);

  /* ---- statements ---- */
  const open = stmts.filter((s) => s.open);
  const chasing = open.filter((s) => (s.days_open ?? 0) > STATEMENT_CHASE_DAYS);
  const settled = stmts.filter((s) => s.status === 'Payment Sent' && (s.payment_sent_at ?? '').slice(0, 4) === year);
  const timed = stmts.filter((s) => s.days_to_pay !== null);
  const oldestOpen = [...open].sort((a, b) => (b.days_open ?? 0) - (a.days_open ?? 0))[0] ?? null;

  /* ---- statistics ---- */
  const months = lastMonths(12);
  const weeks = lastWeeks(12);

  const builderMonths = [...new Set(all.map((s) => s.builder_slack_id ?? s.builder))].map((key) => {
    const mine = all.filter((s) => (s.builder_slack_id ?? s.builder) === key);
    const rosterRow = mine[0]?.builder_slack_id ? bySlack.get(mine[0].builder_slack_id) : undefined;
    const ms = [...new Set(mine.map((s) => s.month).filter((m): m is string => Boolean(m)))].sort();
    return {
      builder: rosterRow?.builder ?? mine[0]?.builder ?? key,
      pay_mode: mine[0]?.pay_mode ?? null,
      months: ms.map((m) => {
        const inMonth = mine.filter((s) => s.month === m);
        return { month: m, working_days: workingDays(inMonth), sessions: inMonth.length };
      }),
      total_days: workingDays(mine),
      total_sessions: mine.length,
    };
  }).sort((a, b) => b.total_days - a.total_days);

  const ageBuckets: [string, (d: number) => boolean][] = [
    ['0–7 days', (d) => d <= 7],
    ['8–30 days', (d) => d > 7 && d <= 30],
    ['31–60 days', (d) => d > 30 && d <= 60],
    ['over 60 days', (d) => d > 60],
  ];
  const aged = unpaid.map((s) => daysSince(s.session_date)).filter((d): d is number => d !== null);

  const payGap = (rows: PaySession[]) =>
    rows
      .filter((s) => s.paid && s.paid_at && s.session_date)
      .map((s) => (Date.parse(s.paid_at!) - Date.parse(`${s.session_date}T00:00:00Z`)) / DAY_MS)
      .filter((d) => Number.isFinite(d) && d >= 0);

  const orphans = all.filter((s) => !s.builder_slack_id || !bySlack.has(s.builder_slack_id));

  return {
    kind: 'pay',
    computed_at: nowIso(),
    scope: { sessions: all.length, unpaid: unpaid.length, builders: roster.length, statements: stmts.length },
    month,

    sessions_owed: {
      n: unpaid.length,
      monthly: monthly(unpaid).length,
      daily: daily(unpaid).length,
      no_mode: noMode(unpaid).length,
      note: all.length
        ? `Approved sessions whose Paid is explicitly false, across every builder. A session whose row carries no Paid at all is not counted here — it is not known to be unpaid — and has its own figure beside this one. ${monthly(unpaid).length} monthly and ${daily(unpaid).length} daily, counted apart because they are different agreements — a monthly builder is expected to wait until the 1st.${noMode(unpaid).length ? ` ${noMode(unpaid).length} carr${noMode(unpaid).length === 1 ? 'ies' : 'y'} no pay mode at all and ${noMode(unpaid).length === 1 ? 'is' : 'are'} counted apart from both, because guessing which agreement they fall under is not this page's to do.` : ''} Paid status is set in Slack or by a statement closing; this page never sets it.`
        : `No session is held at all, which on this page most likely means the ledger has not been read rather than that nothing is owed. The freshness line above says when it last was.`,
    },
    sessions_unconfirmed: {
      n: unconfirmed.length,
      monthly: monthly(unconfirmed).length,
      daily: daily(unconfirmed).length,
      from_resync: unconfirmed.filter((s) => s.held_via === 'resync').length,
      note: unconfirmed.length
        ? `Sessions whose row carries no Paid at all, so this page does not know whether they are paid — and does not count them as owed. ${unconfirmed.filter((s) => s.held_via === 'resync').length} of the ${unconfirmed.length} came in on the Airtable resync, and Airtable leaves an unticked checkbox out of the record, so they were most likely unticked when copied; nothing has written them since. Bays — Pay Tracking's own readers treat a missing Paid as unpaid, so these will appear on the next monthly statement and in the Monday reminders.`
        : `Every session carries a Paid value, so nothing here is unknown.`,
    },
    builders_owed: {
      n: owed.filter((o) => o.sessions_owed > 0).length,
      monthly: owed.filter((o) => o.sessions_owed > 0 && o.pay_mode === 'Monthly').length,
      daily: owed.filter((o) => o.sessions_owed > 0 && o.pay_mode === 'Daily').length,
      no_mode: owed.filter((o) => o.sessions_owed > 0 && o.pay_mode !== 'Monthly' && o.pay_mode !== 'Daily').length,
      note: owed.length
        ? `Distinct people with at least one unpaid session. Counted on the Slack id where a session carries one, so two spellings of a name are one person. A builder whose id matches nobody on the roster is still counted here — they did the work — and named on the statistics tab.`
        : all.length
          ? `Every approved session held is paid, so nobody is waiting. This is a nought rather than an absence: ${all.length} session${all.length === 1 ? '' : 's'} ${all.length === 1 ? 'is' : 'are'} held and none is outstanding.`
          : `No session is held, so there is nobody to owe. Check the freshness line: an unread ledger looks exactly like a settled one.`,
    },
    oldest_unpaid: {
      days: oldestDays,
      builder: oldestSession?.builder ?? null,
      codex_entry_id: oldestSession?.codex_entry_id ?? null,
      pay_mode: oldestSession?.pay_mode ?? null,
      note: oldestSession
        ? `Age of the oldest unpaid session, counted from the session date rather than from approval. Monthly builders are expected to wait until the 1st; this only reads as a problem when it exceeds a full cycle, which is why it is coloured past ${UNPAID_ALARM_DAYS} days and not before.`
        : all.length
          ? `Nothing is unpaid, so there is no oldest.`
          : `No session is held, so there is nothing to age.`,
    },
    this_month: {
      n: thisMonthSessions.length,
      monthly: monthly(thisMonthSessions).length,
      daily: daily(thisMonthSessions).length,
      no_mode: noMode(thisMonthSessions).length,
      note: `Sessions counting toward ${monthLabel(month)}, by the session's own Month — which comes from the session date, so one worked on the 30th and approved on the 1st counts to the month it was worked. ${monthly(thisMonthSessions).length} monthly and ${daily(thisMonthSessions).length} daily${noMode(thisMonthSessions).length ? `, and ${noMode(thisMonthSessions).length} with no pay mode on the row` : ''}.`,
    },
    owed,

    open_statements: {
      n: open.length,
      chasing: chasing.length,
      note: open.length
        ? `Statements Jason has and has not yet paid. ${chasing.length ? `${chasing.length} of them ${chasing.length === 1 ? 'has' : 'have'} been open longer than ${STATEMENT_CHASE_DAYS} days.` : `None has been open longer than ${STATEMENT_CHASE_DAYS} days.`} Drafts are not counted — they have not reached him — and Disputed is its own state rather than an unanswered one.`
        : stmts.length
          ? `No statement is open. Every one held is a draft, paid, or disputed.`
          : `No statement is held. The first are written on the 1st, one per monthly builder.`,
    },
    settled_this_year: {
      n: settled.length,
      year,
      note: `Statements marked Payment Sent with a payment date in ${year}. A statement closes itself once every session behind it is ticked, so this counts months that actually completed — if a payment went out and the sessions were never ticked, the statement stays open and appears above rather than here.`,
    },
    statement_time_to_pay: percentiles(timed.map((s) => s.days_to_pay!), stmts.length, (n, of) =>
      n
        ? `Whole days from Sent to Payment Sent, over the ${n} of ${of} statement${of === 1 ? '' : 's'} that carry both stamps. p50 and p95, never a mean. Open and draft statements are excluded — they have not finished.`
        : of
          ? `None of the ${of} statement${of === 1 ? '' : 's'} held carries both a Sent At and a Payment Sent At, so there is nothing to time.`
          : `No statement is held.`,
    ),
    /**
     * In the base's own order, so the filter pills on the Statements tab keep
     * a stable order rather than reordering as counts change — and so a status
     * added to the select upstream appears rather than being silently dropped.
     */
    statement_status_mix: slices(stmts, (x) => x.status, STATEMENT_STATUSES, '(no status)'),
    oldest_open_statement: {
      statement_id: oldestOpen?.statement_id ?? null,
      days: oldestOpen?.days_open ?? null,
      note: oldestOpen
        ? `The statement that has been sent and unanswered longest, counted from Sent At. Past ${STATEMENT_CHASE_DAYS} days it reads amber on the list.`
        : `No statement is open.`,
    },

    per_month: months.map((m) => {
      const mine = all.filter((s) => s.month === m);
      return {
        month: m,
        label: monthLabel(m),
        total: mine.length,
        counts: Object.fromEntries([...PAY_MODES.map((mode) => [mode, mine.filter((s) => s.pay_mode === mode).length]), [NO_MODE, mine.filter((s) => !s.pay_mode).length]]),
      };
    }),
    per_month_note: `Sessions by the month they count toward, split by the pay mode frozen on the session. The last twelve months; a month with none is drawn as no column rather than a column of nought. The ledger was created on 17 Sep 2026, so months before it hold nothing — they were not quiet, they were not recorded.`,
    paid_per_week: weeks.map((w) => {
      const mine = all.filter((s) => s.session_date && weekStart(s.session_date) === w);
      return {
        week: w,
        label: weekLabel(w),
        total: mine.length,
        counts: { paid: mine.filter((s) => s.paid === true).length, unpaid: mine.filter((s) => s.paid === false).length, 'not recorded': mine.filter((s) => s.paid === null).length },
      };
    }),
    paid_week_note: `Every session by the week it was worked, split by whether it has been paid — and a third slice for sessions whose row carries no Paid at all, which are not known either way. The recent weeks lean unpaid by design: a monthly builder's work is not settled until the 1st, so the right-hand end of this chart is expected to be dark.`,
    working_days: builderMonths,
    working_days_note: `Distinct days each builder had at least one approved session, by month — the shape of who is actually building. Working days and session count are different numbers and both are shown: two sessions in one day is one working day and two sessions, and neither is derived from the other.`,
    paid_by: slices(paid, (s) => s.paid_by, PAID_BY, '(not recorded)'),
    paid_by_note: paid.length
      ? `Who marked each paid session paid. It answers who is keeping the record true: if Builder dominates, the payday reminder is doing the work Jason is not; a large share of Monthly Statement means the monthly loop is closing itself as designed. Over the ${paid.length} paid session${paid.length === 1 ? '' : 's'}; unpaid ones have nobody to attribute.`
      : `No session is marked paid yet, so there is nobody to attribute. This card counts who ticked each paid session — Jason, the builder confirming after payday, the monthly statement closing, or autopay.`,
    time_to_pay: PAY_MODES.map((mode) => {
      const rows = all.filter((s) => s.pay_mode === mode);
      const gaps = payGap(rows);
      return {
        mode,
        p: percentiles(gaps, rows.filter((s) => s.paid === true).length, (n, of) =>
          n
            ? `Whole days from the session date to Paid At, over the ${n} of ${of} paid ${mode.toLowerCase()} session${of === 1 ? '' : 's'} carrying both. p50 and p95, never a mean.`
            : of
              ? `${of} paid ${mode.toLowerCase()} session${of === 1 ? '' : 's'}, none carrying both a session date and a Paid At.`
              : `No ${mode.toLowerCase()} session has been paid yet.`,
        ),
      };
    }),
    time_to_pay_note: `Session date to Paid At, split by pay mode and never blended. The two populations are not comparable: a daily session is answered within days and a monthly one waits for the 1st by agreement, so one number over both would describe nobody.`,
    ageing: ageBuckets.map(([key, test]) => ({ key, label: key, n: aged.filter(test).length })),
    ageing_note: unpaid.length
      ? `Unpaid sessions by age, counted from the session date. Over the ${aged.length} of ${unpaid.length} unpaid session${unpaid.length === 1 ? '' : 's'} carrying one. The first two buckets are the agreement working — a monthly builder waits for the 1st — and only the last is coloured, because past sixty days no cycle explains it.`
      : `Nothing is unpaid, so there is nothing to age. This counts unpaid sessions by days since they were worked.`,
    no_roster_match: {
      n: orphans.length,
      of: all.length,
      sessions: orphans.slice(0, 20),
      note: orphans.length
        ? `Sessions whose Builder Slack ID matches nobody in the Builders table. This should be nought: somebody is building and the pay system has not been told who they are, so no statement will ever include them and no card will ever be sent. Add them to the Builders table.`
        : all.length
          ? `Every session held matches a builder on the roster. This is the check that catches somebody building without the pay system knowing who they are — nought is the right answer.`
          : `No session is held, so there is nothing to match against the roster.`,
    },
  };
}
